import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MODES = ['unowned_to_one', 'unowned_spread', 'move'] as const
type Mode = (typeof MODES)[number]

/**
 * GET /api/routing/bulk-assign  (admin)
 * How many chats have no owner yet — the number the "reassign" card shows.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { count, error } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('owner_agent_id', null)
    if (error) {
      // Column missing -> migration 055 hasn't run.
      return NextResponse.json({ unowned: null })
    }
    return NextResponse.json({ unowned: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/routing/bulk-assign  (admin)
 *
 *   { mode: 'unowned_to_one', to }     chats with no owner  -> one closer
 *   { mode: 'unowned_spread' }         chats with no owner  -> spread evenly over all closers
 *   { mode: 'move', from, to }         one closer's chats   -> another closer
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
