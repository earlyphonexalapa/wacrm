import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/mfa-gate'

// Landing point for Supabase email links (password reset today). Turns the
// link's one-time credential into a session cookie, then sends the user on
// to `next` — /reset-password for a recovery link.
//
// Two link shapes are supported:
//   ?code=…                      PKCE (the default resetPasswordForEmail link).
//                                Only works in the browser that requested it,
//                                since the verifier lives in that browser.
//   ?token_hash=…&type=recovery  Works on any device. Used when the Supabase
//                                email template is set up as in docs/ios-app.md.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const next = safeNextPath(url.searchParams.get('next'), '/dashboard')
  const code = url.searchParams.get('code')
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') as EmailOtpType | null

  const supabase = await createClient()
  let ok = false

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) console.error('[auth/callback] code exchange failed:', error.message)
    ok = !error
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (error) console.error('[auth/callback] verifyOtp failed:', error.message)
    ok = !error
  }

  if (!ok) {
    return NextResponse.redirect(new URL('/forgot-password?error=link', url.origin))
  }
  return NextResponse.redirect(new URL(next, url.origin))
}
