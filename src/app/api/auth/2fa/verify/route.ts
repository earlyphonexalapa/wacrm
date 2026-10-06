import { NextResponse } from 'next/server'

import { MFA_COOKIE, sessionIdFromAccessToken, signGateCookie } from '@/lib/auth/mfa-gate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/auth/2fa/verify   { code: "123456", factor_id?: string }
 *
 * Checks an authenticator code with Supabase (challenge + verify) and, when
 * it is right, hands this browser the signed "verified" cookie the
 * middleware looks for. Also used to finish setting up a new authenticator:
 * pass the `factor_id` of the factor that was just enrolled.
 *
 * The cookie has no expiry (it ends with the browser session) and is tied to
 * this user and this login session — see src/lib/auth/mfa-gate.ts.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = checkRateLimit(`mfa-verify:${user.id}`, RATE_LIMITS.mfaVerify)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  const code = typeof body?.code === 'string' ? body.code.replace(/\s/g, '') : ''
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: 'Enter the 6-digit code from your app.' }, { status: 400 })
  }

  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors()
  if (listError || !factors) {
    return NextResponse.json({ error: 'Could not check your authenticator.' }, { status: 500 })
  }

  const requested = typeof body?.factor_id === 'string' ? body.factor_id : null
  const factor = requested
    ? factors.all.find((f) => f.id === requested && f.factor_type === 'totp')
    : factors.totp[0]
  if (!factor) {
    return NextResponse.json({ error: 'No authenticator is set up for this account.' }, { status: 400 })
  }

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.id })
  if (challengeError || !challenge) {
    return NextResponse.json({ error: 'Could not start the check. Try again.' }, { status: 400 })
  }
  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: factor.id,
    challengeId: challenge.id,
    code,
  })
  if (verifyError) {
    return NextResponse.json({ error: 'That code is not valid. Check your app and try again.' }, { status: 400 })
  }

  const secret = process.env.ENCRYPTION_KEY
  if (!secret) {
    // Without a secret the middleware doesn't enforce the gate either, so
    // there is nothing to hand out; the code itself was still checked.
    return NextResponse.json({ success: true })
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  const value = await signGateCookie({
    userId: user.id,
    sessionId: sessionIdFromAccessToken(session?.access_token),
    secret,
  })

  // Marked Secure only when the browser really is on HTTPS (directly or
  // behind a proxy that says so): a Secure cookie set over plain HTTP is
  // dropped, which would trap the user in the verification loop.
  const https =
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'

  const response = NextResponse.json({ success: true })
  // No maxAge/expires: a session cookie, gone when the browser closes.
  response.cookies.set(MFA_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: https,
    path: '/',
  })
  return response
}
