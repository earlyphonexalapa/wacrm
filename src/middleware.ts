import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import {
  decideMfaGate,
  MFA_COOKIE,
  sessionIdFromAccessToken,
  userHasVerifiedTotp,
  verifyGateCookie,
} from '@/lib/auth/mfa-gate'

/**
 * Two-step verification gate (see src/lib/auth/mfa-gate.ts). Returns a
 * response when the request must be stopped — a redirect to /2fa for pages,
 * a 401 for API calls — or null to carry on. Does nothing at all for a user
 * without an authenticator unless REQUIRE_2FA=1, so it can't lock anyone out
 * before they have set one up. DISABLE_2FA_GATE=1 is the emergency off switch.
 */
async function applyMfaGate(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
  user: { id: string; factors?: { factor_type?: string; status?: string }[] | null },
): Promise<NextResponse | null> {
  const secret = process.env.ENCRYPTION_KEY
  const hasVerifiedFactor = userHasVerifiedTotp(user)
  const requireEnrollment = process.env.REQUIRE_2FA === '1'
  if (!secret || process.env.DISABLE_2FA_GATE === '1') return null
  if (!hasVerifiedFactor && !requireEnrollment) return null

  let cookieValid = false
  if (hasVerifiedFactor) {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    cookieValid = await verifyGateCookie(request.cookies.get(MFA_COOKIE)?.value, {
      userId: user.id,
      sessionId: sessionIdFromAccessToken(session?.access_token),
      secret,
    })
  }

  const { pathname, search } = request.nextUrl
  const decision = decideMfaGate({
    pathname,
    hasVerifiedFactor,
    cookieValid,
    requireEnrollment,
    bypass: false,
  })
  if (decision === 'allow') return null
  if (decision === 'deny-api') {
    return NextResponse.json(
      { error: 'Two-step verification required', code: 'mfa_required' },
      { status: 401 },
    )
  }

  const url = request.nextUrl.clone()
  url.pathname = '/2fa'
  url.search = ''
  url.searchParams.set('next', pathname + search)
  if (decision === 'setup') url.searchParams.set('setup', '1')
  return NextResponse.redirect(url)
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Two-step verification: a signed-in user must have entered their
  // authenticator code in this browser session (see mfa-gate.ts).
  if (user) {
    const gate = await applyMfaGate(request, supabase, user)
    if (gate) return withRefreshedCookies(gate)
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
