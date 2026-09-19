import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { seedStarterFollowups } from '@/lib/followups/seed'

/**
 * POST /api/followups/seed — admin+.
 * Loads the starter follow-up plan (tags + inactive sequences + global
 * stop tags). Idempotent.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`followups:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const result = await seedStarterFollowups(supabase, accountId, userId)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
