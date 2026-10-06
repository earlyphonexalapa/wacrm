import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MODES = ['unowned_to_one', 'unowned_spread', 'move'] as const
type Mode = (typeof MODES)[number]

/** 1..3650 whole days, or null when absent / not a usable number. */
function parseDays(raw: unknown): number | null {
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null
}

/**
 * GET /api/routing/bulk-assign?days=14  (admin)
 * How many chats have no owner yet — in total, and (with `days`) how many of
 * those had a message within that many days. The numbers the "reassign" card
 * shows.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const days = parseDays(new URL(request.url).searchParams.get('days'))

    const unowned = () =>
      supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .is('owner_agent_id', null)

    const cutoff = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString()
    const [total, recent] = await Promise.all([
      unowned(),
      cutoff === null ? Promise.resolve(null) : unowned().gte('last_message_at', cutoff),
    ])
    if (total.error) {
      // Column missing -> migration 055 hasn't run.
      return NextResponse.json({ unowned: null, in_window: null })
    }
    return NextResponse.json({
      unowned: total.count ?? 0,
      in_window: recent === null ? (total.count ?? 0) : (recent.count ?? 0),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/routing/bulk-assign  (admin)
 *
 *   { mode: 'unowned_to_one', to, days? }   chats with no owner  -> one closer
 *   { mode: 'unowned_spread', days? }       chats with no owner  -> spread evenly over all closers
 *   { mode: 'move', from, to }              one closer's chats   -> another closer
 *
 * `days` limits the two "unowned" modes to chats with a message in that many
 * days; leave it out for every unowned chat.
 *
 * The work (and the admin check) lives in the lead_routing_bulk_assign SQL
 * function, which updates every matching chat in one statement.
 */
export async function POST(request: Request) {
  try {
    const { supabase, userId } = await requireRole('admin')

    const limit = checkRateLimit(`routing-bulk:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const mode = body?.mode as Mode
    if (!MODES.includes(mode)) {
      return NextResponse.json({ error: 'Unknown mode' }, { status: 400 })
    }
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

    const { data, error } = await supabase.rpc('lead_routing_bulk_assign', {
      p_mode: mode,
      p_to: str(body?.to),
      p_from: str(body?.from),
      p_days: parseDays(body?.days),
    })
    if (error) {
      if (error.code === 'PGRST202') {
        return NextResponse.json(
          { error: 'Reassigning chats needs the latest database update (migration 056).' },
          { status: 503 },
        )
      }
      if (error.code === '22023' || error.code === '42501') {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      console.error('[routing/bulk-assign] error:', error)
      return NextResponse.json({ error: 'Failed to reassign the chats' }, { status: 500 })
    }
    return NextResponse.json({ success: true, updated: Number(data ?? 0) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
