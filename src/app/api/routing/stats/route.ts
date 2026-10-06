import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isMissingRoutingTable } from '@/lib/routing/db-errors'
import type { RoutingRule } from '@/lib/routing/match'
import { buildRoutingSummary, type RawRoutingStats } from '@/lib/routing/summary'

/**
 * GET /api/routing/stats?days=7  (admin)
 *
 * How the leads opened in the last N days (1-30) were routed, plus the ad
 * campaigns seen and whether a rule covers each — the "is this working?"
 * panel on the settings screen.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const raw = Number(new URL(request.url).searchParams.get('days'))
    const days = Number.isFinite(raw) ? Math.min(30, Math.max(1, Math.floor(raw))) : 7

    const [stats, rules] = await Promise.all([
      supabase.rpc('lead_routing_stats', { p_days: days }),
      supabase.from('lead_routing_rules').select('id, kind, match_value, closer_id').eq('account_id', accountId),
    ])
    if (isMissingRoutingTable(stats.error) || isMissingRoutingTable(rules.error) || stats.error?.code === 'PGRST202') {
      return NextResponse.json({ migrated: false })
    }
    if (stats.error || rules.error) {
      console.error('[routing/stats] error:', stats.error ?? rules.error)
      return NextResponse.json({ error: 'Failed to load the routing summary' }, { status: 500 })
    }

    return NextResponse.json({
      migrated: true,
      days,
      summary: buildRoutingSummary((stats.data ?? {}) as RawRoutingStats, (rules.data ?? []) as RoutingRule[]),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
