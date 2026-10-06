// ============================================================
// Two-step verification gate.
//
// Supabase keeps the browser logged in for up to 400 days, and its own
// MFA level (aal2) would also persist that long — so on its own it can't
// ask for the authenticator code each time the CRM is opened. This gate
// does: after the code is verified, the server hands the browser a signed
// cookie that is
//
//   - a session cookie (gone when the browser closes),
//   - good for at most MFA_MAX_AGE_MS even if the browser stays open, and
//   - tied to ONE user AND ONE login session, so signing out and back in,
//     or another account on the same browser, has to enter a code again.
//
// The middleware lets a request through only with a valid cookie. The
// code itself is always checked by Supabase (mfa.challenge + mfa.verify);
// this module only signs and checks the "already verified" cookie. It uses
// Web Crypto so it runs in the middleware as well as in route handlers.
//
// Everything here is pure (no I/O), so it is unit tested.
// ============================================================

export const MFA_COOKIE = 'wacrm_2fa'
/** Longest a verified browser stays trusted without asking again. */
export const MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000

const encoder = new TextEncoder()

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

interface CookieBinding {
  userId: string
  sessionId: string | null
  secret: string
  now?: number
}

export async function signGateCookie({ userId, sessionId, secret, now }: CookieBinding): Promise<string> {
  const issuedAt = now ?? Date.now()
  const signature = await hmacHex(secret, `${userId}|${sessionId ?? ''}|${issuedAt}`)
  return `${issuedAt}.${signature}`
}

export async function verifyGateCookie(
  value: string | null | undefined,
  { userId, sessionId, secret, now }: CookieBinding,
): Promise<boolean> {
  if (!value) return false
  const [issuedRaw, signature] = value.split('.')
  const issuedAt = Number(issuedRaw)
  if (!signature || !Number.isFinite(issuedAt)) return false

  const age = (now ?? Date.now()) - issuedAt
  if (age < -60_000 || age > MFA_MAX_AGE_MS) return false

  const expected = await hmacHex(secret, `${userId}|${sessionId ?? ''}|${issuedAt}`)
  return safeEqual(signature, expected)
}

/** The `session_id` claim of a Supabase access token, or null. */
export function sessionIdFromAccessToken(token: string | null | undefined): string | null {
  if (!token) return null
  try {
    const payload = token.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { session_id?: unknown }
    return typeof claims.session_id === 'string' ? claims.session_id : null
  } catch {
    return null
  }
}

/** True when the user has finished setting up an authenticator app. */
export function userHasVerifiedTotp(
  user: { factors?: { factor_type?: string; status?: string }[] | null } | null | undefined,
): boolean {
  return (user?.factors ?? []).some((f) => f.factor_type === 'totp' && f.status === 'verified')
}

/**
 * Paths the gate never blocks: the verification flow itself, the sign-in
 * pages, and everything that authenticates some other way (Meta's webhook,
 * the public API's keys, cron pings, invitation links).
 */
export function isMfaExemptPath(pathname: string): boolean {
  if (pathname === '/') return true
  if (pathname === '/2fa' || pathname.startsWith('/2fa/')) return true
  if (['/login', '/signup', '/forgot-password'].includes(pathname)) return true
  if (pathname === '/icon' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true
  if (pathname.startsWith('/join/')) return true
  if (pathname.startsWith('/api/auth/2fa/')) return true
  if (pathname.startsWith('/api/whatsapp/webhook')) return true
  if (pathname.startsWith('/api/v1/')) return true
  if (pathname.startsWith('/api/invitations/')) return true
  if (/^\/api\/[^/]+\/cron(\/|$)/.test(pathname)) return true
  return false
}

export type MfaDecision = 'allow' | 'verify' | 'setup' | 'deny-api'

export interface MfaDecisionInput {
  pathname: string
  /** The user has a verified authenticator. */
  hasVerifiedFactor: boolean
  /** The request carries a valid, unexpired gate cookie. */
  cookieValid: boolean
  /** REQUIRE_2FA: people without an authenticator must set one up. */
  requireEnrollment: boolean
  /** DISABLE_2FA_GATE: emergency switch. */
  bypass: boolean
}

export function decideMfaGate(input: MfaDecisionInput): MfaDecision {
  if (input.bypass) return 'allow'
  if (isMfaExemptPath(input.pathname)) return 'allow'

  const isApi = input.pathname.startsWith('/api/')
  if (input.hasVerifiedFactor) {
    if (input.cookieValid) return 'allow'
    return isApi ? 'deny-api' : 'verify'
  }
  if (input.requireEnrollment) return isApi ? 'deny-api' : 'setup'
  return 'allow'
}

/** Only same-site paths are accepted as a post-verification destination. */
export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  if (raw.startsWith('/2fa')) return fallback
  return raw
}
