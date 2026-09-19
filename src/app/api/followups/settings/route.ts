import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadFollowupSettings, saveFollowupSettings } from '@/lib/followups/store'
import { parseSettingsInput } from '@/lib/followups/validate'

/** GET /api/followups/settings — any member. Defaults when never saved. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    return NextResponse.json({ settings: await loadFollowupSettings(supabase, accountId) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PUT /api/followups/settings — admin+. */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`followups:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const parsed = parseSettingsInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    await saveFollowupSettings(supabase, accountId, parsed.value)
    return NextResponse.json({ success: true, settings: parsed.value })
  } catch (err) {
    return toErrorResponse(err)
  }
}
