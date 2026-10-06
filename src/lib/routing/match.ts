// ============================================================
// Campaign -> closer rule matching. Pure (no I/O) so it can be unit
// tested; the orchestrator in assign.ts feeds it rules from the DB.
// ============================================================

export type RuleKind = 'campaign_id' | 'name_contains'

export interface RoutingRule {
  id: string
  kind: RuleKind
  match_value: string
  closer_id: string
}

export interface CampaignRef {
  id: string
  name: string | null
}

export type RuleMatch =
  | { kind: 'match'; closerId: string; ruleId: string }
  /** Several name rules for different closers hit the same campaign. */
  | { kind: 'ambiguous'; closerIds: string[] }
  | { kind: 'none' }

/** Lowercase, accent-free, punctuation collapsed to single spaces. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Whole-word (or whole-phrase) containment on normalized text, so a rule
 * for "Ana" matches "WhatsApp Ana" but not "WhatsApp Mariana".
 */
export function nameContains(campaignName: string, needle: string): boolean {
  const n = normalizeText(needle)
  if (!n) return false
  return ` ${normalizeText(campaignName)} `.includes(` ${n} `)
}

/**
 * An explicit campaign-id rule always wins. Otherwise the name rules
 * decide: one closer hit = match; hits for different closers = ambiguous
 * (the lead falls back to the organic pool and the settings page flags
 * the campaign instead of guessing).
 */
export function matchCampaignRule(rules: RoutingRule[], campaign: CampaignRef): RuleMatch {
  const byId = rules.find(
    (r) => r.kind === 'campaign_id' && r.match_value.trim() === campaign.id,
  )
  if (byId) return { kind: 'match', closerId: byId.closer_id, ruleId: byId.id }

  if (!campaign.name) return { kind: 'none' }
  const hits = rules.filter(
    (r) => r.kind === 'name_contains' && nameContains(campaign.name as string, r.match_value),
  )
  const closerIds = [...new Set(hits.map((r) => r.closer_id))]
  if (closerIds.length === 0) return { kind: 'none' }
  if (closerIds.length > 1) return { kind: 'ambiguous', closerIds }
  return { kind: 'match', closerId: closerIds[0], ruleId: hits[0].id }
}
