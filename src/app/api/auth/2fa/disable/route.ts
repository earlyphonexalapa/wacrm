import { NextResponse } from 'next/server'

import { MFA_COOKIE } from '@/lib/auth/mfa-gate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/auth/2fa/disable   { code: "123456" }
 *
 * Turns two-step verification off for the signed-in user. Asks for a current
 * code first, so a browser someone left open can't quietly remove it.
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

  const { data: factors } = await supabase.auth.mfa.listFactors()
  const factor = factors?.totp[0]
  if (!factor) return NextResponse.json({ success: true })

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

  // The code check above upgraded the session, which unenroll requires.
  const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
  if (unenrollError) {
    console.error('[2fa disable] unenroll error:', unenrollError)
    return NextResponse.json({ error: 'Could not turn it off. Try again.' }, { status: 500 })
  }

  const response = NextResponse.json({ success: true })
  response.cookies.set(MFA_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}
