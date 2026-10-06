import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isMissingRoutingTable } from '@/lib/routing/db-errors'
import { normalizeText } from '@/lib/routing/match'

const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status })

/**
 * POST /api/routing/rules  (admin)
 *
 * Adds a campaign -> closer rule:
 *   { kind: 'name_contains', match_value: 'Pedro', closer_id }
 *   { kind: 'campaign_id',   match_value: '1202…', match_label?: name, closer_id }
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`routing-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const kind = body.kind
    if (kind !== 'name_contains' && kind !== 'campaign_id') {
      return bad('kind must be "name_contains" or "campaign_id"')
    }
    const matchValue = typeof body.match_value === 'string' ? body.match_value.trim() : ''
    if (!matchValue || matchValue.length > 120) return bad('Enter the text or campaign to match')
    if (kind === 'campaign_id' && !/^\d{5,25}$/.test(matchValue)) return bad('That is not a valid campaign id')
    if (kind === 'name_contains' && !normalizeText(matchValue)) return bad('Use letters or numbers in the name to match')

    const closerId = typeof body.closer_id === 'string' ? body.closer_id : ''
    if (!closerId) return bad('Choose a closer')
    const { data: closer, error: closerError } = await supabase
      .from('lead_routing_closers')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('user_id', closerId)
      .maybeSingle()
    if (closerError && isMissingRoutingTable(closerError)) {
      return bad('Lead routing needs the latest database update (migration 055).', 503)
    }
    if (!closer) return bad('That person is not set up as a closer')

    const matchLabel =
      kind === 'campaign_id' && typeof body.match_label === 'string' && body.match_label.trim()
        ? body.match_label.trim().slice(0, 200)
        : null

    const { data, error } = await supabase
      .from('lead_routing_rules')
      .insert({
        account_id: accountId,
        kind,
        match_value: matchValue,
        match_label: matchLabel,
        closer_id: closerId,
      })
      .select('id, kind, match_value, match_label, closer_id, created_at')
      .single()
    if (error) {
      if (error.code === '23505') return bad('There is already a rule for that', 409)
      console.error('[routing/rules POST] error:', error)
      return bad('Failed to save the rule', 500)
    }

    return NextResponse.json({ success: true, rule: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/routing/rules  (admin) — body: { id } */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`routing-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return bad('id is required')

    const { error } = await supabase.from('lead_routing_rules').delete().eq('id', id).eq('account_id', accountId)
    if (error) {
      console.error('[routing/rules DELETE] error:', error)
      return bad('Failed to delete the rule', 500)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
