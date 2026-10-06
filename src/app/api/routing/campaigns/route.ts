import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { listCampaigns } from '@/lib/meta/ads'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { matchCampaignRule, type RoutingRule } from '@/lib/routing/match'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/routing/campaigns  (admin)
 *
 * The active and paused campaigns Meta shows for the saved token, each
 * with the closer a rule already gives it (if any) — feeds the "pick a
 * campaign" box on the settings screen.
 */
export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`routing-campaigns:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const [{ data: settings }, { data: rules }] = await Promise.all([
      supabase.from('lead_routing_settings').select('ads_access_token').eq('account_id', accountId).maybeSingle(),
      supabase.from('lead_routing_rules').select('id, kind, match_value, closer_id').eq('account_id', accountId),
    ])
    if (!settings?.ads_access_token) {
      return NextResponse.json({ error: 'Save a Meta Ads token first' }, { status: 400 })
    }

    let token: string
    try {
      token = decrypt(settings.ads_access_token)
    } catch {
      return NextResponse.json({ error: 'The saved token could not be read — enter it again.' }, { status: 400 })
    }

    let campaigns
    try {
      campaigns = await listCampaigns(token)
    } catch (err) {
      return NextResponse.json(
        { error: `Meta did not return the campaigns: ${err instanceof Error ? err.message : 'unknown error'}` },
        { status: 502 },
      )
    }

    return NextResponse.json({
      campaigns: campaigns.map((c) => {
        const match = matchCampaignRule((rules ?? []) as RoutingRule[], { id: c.id, name: c.name })
        return {
          ...c,
          closer_id: match.kind === 'match' ? match.closerId : null,
          ambiguous: match.kind === 'ambiguous',
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
