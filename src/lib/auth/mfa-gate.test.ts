import { describe, expect, it } from 'vitest'
import {
  decideMfaGate,
  isMfaExemptPath,
  MFA_MAX_AGE_MS,
  safeNextPath,
  sessionIdFromAccessToken,
  signGateCookie,
  userHasVerifiedTotp,
  verifyGateCookie,
} from './mfa-gate'

const SECRET = 'a'.repeat(64)
const base = { userId: 'user-1', sessionId: 'sess-1', secret: SECRET, now: 1_000_000 }

describe('gate cookie', () => {
  it('verifies for the same user and session', async () => {
    const cookie = await signGateCookie(base)
    expect(await verifyGateCookie(cookie, { ...base, now: base.now + 1000 })).toBe(true)
  })

  it('is rejected for another user', async () => {
    const cookie = await signGateCookie(base)
    expect(await verifyGateCookie(cookie, { ...base, userId: 'user-2' })).toBe(false)
  })

  it('is rejected after signing in again (a new session)', async () => {
    const cookie = await signGateCookie(base)
    expect(await verifyGateCookie(cookie, { ...base, sessionId: 'sess-2' })).toBe(false)
  })

  it('is rejected with a different secret', async () => {
    const cookie = await signGateCookie(base)
    expect(await verifyGateCookie(cookie, { ...base, secret: 'b'.repeat(64) })).toBe(false)
  })

  it('expires after the maximum age', async () => {
    const cookie = await signGateCookie(base)
    expect(await verifyGateCookie(cookie, { ...base, now: base.now + MFA_MAX_AGE_MS - 1 })).toBe(true)
    expect(await verifyGateCookie(cookie, { ...base, now: base.now + MFA_MAX_AGE_MS + 1 })).toBe(false)
  })

  it('rejects a cookie from the future', async () => {
    const cookie = await signGateCookie({ ...base, now: base.now + 10 * 60_000 })
    expect(await verifyGateCookie(cookie, base)).toBe(false)
  })

  it('rejects a tampered timestamp or signature', async () => {
    const cookie = await signGateCookie(base)
    const [, sig] = cookie.split('.')
    expect(await verifyGateCookie(`${base.now + 5}.${sig}`, { ...base, now: base.now + 10 })).toBe(false)
    expect(await verifyGateCookie(`${base.now}.${sig.slice(0, -1)}0`, base)).toBe(false)
  })

  it('rejects missing or malformed values', async () => {
    expect(await verifyGateCookie(undefined, base)).toBe(false)
    expect(await verifyGateCookie('', base)).toBe(false)
    expect(await verifyGateCookie('garbage', base)).toBe(false)
    expect(await verifyGateCookie('abc.def', base)).toBe(false)
  })

  it('works when the session id is unknown on both sides', async () => {
    const cookie = await signGateCookie({ ...base, sessionId: null })
    expect(await verifyGateCookie(cookie, { ...base, sessionId: null })).toBe(true)
  })
})

describe('sessionIdFromAccessToken', () => {
  const token = (claims: object) => {
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${enc({ alg: 'HS256' })}.${enc(claims)}.sig`
  }

  it('reads the session_id claim', () => {
    expect(sessionIdFromAccessToken(token({ session_id: 'abc-123', sub: 'u' }))).toBe('abc-123')
  })

  it('is null for a token without it, or for junk', () => {
    expect(sessionIdFromAccessToken(token({ sub: 'u' }))).toBeNull()
    expect(sessionIdFromAccessToken('nope')).toBeNull()
    expect(sessionIdFromAccessToken(null)).toBeNull()
  })
})

describe('userHasVerifiedTotp', () => {
  it('needs a verified totp factor', () => {
    expect(userHasVerifiedTotp({ factors: [{ factor_type: 'totp', status: 'verified' }] })).toBe(true)
    expect(userHasVerifiedTotp({ factors: [{ factor_type: 'totp', status: 'unverified' }] })).toBe(false)
    expect(userHasVerifiedTotp({ factors: [{ factor_type: 'phone', status: 'verified' }] })).toBe(false)
    expect(userHasVerifiedTotp({ factors: [] })).toBe(false)
    expect(userHasVerifiedTotp({})).toBe(false)
    expect(userHasVerifiedTotp(null)).toBe(false)
  })
})

describe('isMfaExemptPath', () => {
  it('never blocks the flow itself, sign-in, or machine-authenticated endpoints', () => {
    for (const p of [
      '/',
      '/2fa',
      '/login',
      '/signup',
      '/forgot-password',
      '/join/abc',
      '/api/auth/2fa/verify',
      '/api/whatsapp/webhook',
      '/api/v1/contacts',
      '/api/automations/cron',
      '/api/flows/cron',
      '/api/invitations/tok/peek',
    ]) {
      expect(isMfaExemptPath(p), p).toBe(true)
    }
  })

  it('blocks the app and the user-authenticated API', () => {
    for (const p of ['/dashboard', '/inbox', '/settings', '/api/whatsapp/send', '/api/ai/config', '/api/routing/settings']) {
      expect(isMfaExemptPath(p), p).toBe(false)
    }
  })
})

describe('decideMfaGate', () => {
  const input = { pathname: '/inbox', hasVerifiedFactor: true, cookieValid: false, requireEnrollment: false, bypass: false }

  it('sends a user with an authenticator but no cookie to verify', () => {
    expect(decideMfaGate(input)).toBe('verify')
  })

  it('answers API calls with a denial instead of a redirect', () => {
    expect(decideMfaGate({ ...input, pathname: '/api/whatsapp/send' })).toBe('deny-api')
  })

  it('lets a verified browser through', () => {
    expect(decideMfaGate({ ...input, cookieValid: true })).toBe('allow')
  })

  it('does nothing for a user without an authenticator, unless it is required', () => {
    expect(decideMfaGate({ ...input, hasVerifiedFactor: false })).toBe('allow')
    expect(decideMfaGate({ ...input, hasVerifiedFactor: false, requireEnrollment: true })).toBe('setup')
    expect(
      decideMfaGate({ ...input, hasVerifiedFactor: false, requireEnrollment: true, pathname: '/api/x' }),
    ).toBe('deny-api')
  })

  it('never blocks exempt paths, and the emergency switch lets everything through', () => {
    expect(decideMfaGate({ ...input, pathname: '/2fa' })).toBe('allow')
    expect(decideMfaGate({ ...input, bypass: true })).toBe('allow')
  })
})

describe('safeNextPath', () => {
  it('accepts same-site paths', () => {
    expect(safeNextPath('/inbox?c=1')).toBe('/inbox?c=1')
  })

  it('refuses anything that could leave the site, or loop back to /2fa', () => {
    expect(safeNextPath('https://evil.test')).toBe('/dashboard')
    expect(safeNextPath('//evil.test')).toBe('/dashboard')
    expect(safeNextPath('/\\evil.test')).toBe('/dashboard')
    expect(safeNextPath('/2fa?next=/inbox')).toBe('/dashboard')
    expect(safeNextPath(null)).toBe('/dashboard')
  })
})
