import { matchCampaignRule, type RoutingRule } from './match'

// ============================================================
// Shapes the lead_routing_stats RPC (migration 055) returns and the
// settings-page summary built from them. Pure, so it is unit tested.
// ============================================================

export interface RawRoutingStats {
  by_source?: { owner_source: string; count: number }[]
  by_owner?: { owner_id: string; owner_source: string; count: number }[]
  campaigns?: { campaign_id: string; campaign_name: string | null; leads: number }[]
}

export type CampaignCoverage = 'id' | 'name' | 'ambiguous' | 'none'

export interface RoutingSummary {
  /** Conversations opened in the window. */
  total: number
  bySource: Record<string, number>
  /** Leads that came from an ad (routed by campaign or not). */
  adLeads: number
  /** Ad leads given to their campaign's closer. */
  adLeadsRouted: number
  /** adLeadsRouted / adLeads as a whole percent; null with no ad leads. */
  adRoutedPct: number | null
  byOwner: { ownerId: string; fromCampaign: number; other: number; total: number }[]
  campaigns: {
    id: string
    name: string | null
    leads: number
    coverage: CampaignCoverage
    closerId: string | null
  }[]
}

const AD_SOURCES = ['campaign', 'unmatched_campaign', 'unresolved']

export function buildRoutingSummary(raw: RawRoutingStats, rules: RoutingRule[]): RoutingSummary {
  const bySource: Record<string, number> = {}
  for (const row of raw.by_source ?? []) {
    bySource[row.owner_source] = (bySource[row.owner_source] ?? 0) + Number(row.count)
  }
  const total = Object.values(bySource).reduce((a, b) => a + b, 0)
  const adLeads = AD_SOURCES.reduce((n, s) => n + (bySource[s] ?? 0), 0)
  const adLeadsRouted = bySource.campaign ?? 0

  const owners = new Map<string, { ownerId: string; fromCampaign: number; other: number; total: number }>()
  for (const row of raw.by_owner ?? []) {
    const cur = owners.get(row.owner_id) ?? { ownerId: row.owner_id, fromCampaign: 0, other: 0, total: 0 }
    const n = Number(row.count)
    if (row.owner_source === 'campaign') cur.fromCampaign += n
    else cur.other += n
    cur.total += n
    owners.set(row.owner_id, cur)
  }

  const campaigns = (raw.campaigns ?? [])
    .map((c) => {
      const match = matchCampaignRule(rules, { id: c.campaign_id, name: c.campaign_name })
      const rule = match.kind === 'match' ? rules.find((r) => r.id === match.ruleId) : undefined
      const coverage: CampaignCoverage =
        match.kind === 'match' ? (rule?.kind === 'campaign_id' ? 'id' : 'name') : match.kind === 'ambiguous' ? 'ambiguous' : 'none'
      return {
        id: c.campaign_id,
        name: c.campaign_name,
        leads: Number(c.leads),
        coverage,
        closerId: match.kind === 'match' ? match.closerId : null,
      }
    })
    .sort((a, b) => b.leads - a.leads)

  return {
    total,
    bySource,
    adLeads,
    adLeadsRouted,
    adRoutedPct: adLeads > 0 ? Math.round((adLeadsRouted / adLeads) * 100) : null,
    byOwner: [...owners.values()].sort((a, b) => b.total - a.total),
    campaigns,
  }
}
