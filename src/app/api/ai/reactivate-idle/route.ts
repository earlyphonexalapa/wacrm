import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MIN_IDLE_DAYS = 1
const MAX_IDLE_DAYS = 90
const DEFAULT_IDLE_DAYS = 3

/**
 * POST /api/ai/reactivate-idle  (admin+)
 *
 * Bulk-clears the two flags that keep the auto-reply bot off a
 * conversation — a human assignment and a prior handoff — plus resets
 * the reply counter, on every conversation that's gone quiet for
 * `idle_days`. Lets an account that turned AI on after already using
 * the inbox manually cover its existing contacts (commonly left
 * assigned to whoever answered them last) without unassigning each one
 * by hand.
 *
 * Body: { idle_days?: number, dry_run?: boolean }
 * `dry_run` (default true) only counts matches so the UI can confirm
 * before applying; the client calls again with `dry_run: false` to
 * actually update the rows.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `ai-reactivate-idle:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const idleDaysRaw = Number(body?.idle_days)
    const idleDays = Number.isFinite(idleDaysRaw)
      ? Math.min(MAX_IDLE_DAYS, Math.max(MIN_IDLE_DAYS, Math.floor(idleDaysRaw)))
      : DEFAULT_IDLE_DAYS
    const dryRun = body?.dry_run !== false

    const cutoffIso = new Date(
      Date.now() - idleDays * 24 * 60 * 60 * 1000,
    ).toISOString()

    if (dryRun) {
      const { count, error } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .or('assigned_agent_id.not.is.null,ai_autoreply_disabled.eq.true')
        .or(`last_message_at.is.null,last_message_at.lt.${cutoffIso}`)
      if (error) {
        console.error('[ai/reactivate-idle] count error:', error)
        return NextResponse.json({ error: 'Failed to count conversations' }, { status: 500 })
      }
      return NextResponse.json({ dry_run: true, count: count ?? 0 })
    }

    const { data, error } = await supabase
      .from('conversations')
      .update({
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
      })
      .eq('account_id', accountId)
      .or('assigned_agent_id.not.is.null,ai_autoreply_disabled.eq.true')
      .or(`last_message_at.is.null,last_message_at.lt.${cutoffIso}`)
      .select('id')
    if (error) {
      console.error('[ai/reactivate-idle] update error:', error)
      return NextResponse.json({ error: 'Failed to reactivate conversations' }, { status: 500 })
    }

    return NextResponse.json({ dry_run: false, count: data?.length ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
