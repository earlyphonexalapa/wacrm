import { describe, expect, it } from 'vitest'
import { buildRoutingSummary } from './summary'
import type { RoutingRule } from './match'

const rules: RoutingRule[] = [
  { id: 'r1', kind: 'name_contains', match_value: 'Pedro', closer_id: 'pedro' },
  { id: 'r2', kind: 'campaign_id', match_value: '222', closer_id: 'liliana' },
]

describe('buildRoutingSummary', () => {
  it('counts leads by how they were routed and works out the ad-routing percentage', () => {
    const s = buildRoutingSummary(
      {
        by_source: [
          { owner_source: 'campaign', count: 80 },
          { owner_source: 'unmatched_campaign', count: 10 },
          { owner_source: 'unresolved', count: 10 },
          { owner_source: 'organic', count: 30 },
        ],
      },
      rules,
    )
    expect(s.total).toBe(130)
    expect(s.adLeads).toBe(100)
    expect(s.adLeadsRouted).toBe(80)
    expect(s.adRoutedPct).toBe(80)
  })

  it('has no percentage when there were no ad leads', () => {
    const s = buildRoutingSummary({ by_source: [{ owner_source: 'organic', count: 5 }] }, rules)
    expect(s.adRoutedPct).toBeNull()
  })

  it('splits each closer\'s leads into campaign and other, largest first', () => {
    const s = buildRoutingSummary(
      {
        by_owner: [
          { owner_id: 'pedro', owner_source: 'campaign', count: 40 },
          { owner_id: 'pedro', owner_source: 'organic', count: 5 },
          { owner_id: 'liliana', owner_source: 'campaign', count: 50 },
          { owner_id: 'liliana', owner_source: 'unmatched_campaign', count: 3 },
        ],
      },
      rules,
    )
    expect(s.byOwner).toEqual([
      { ownerId: 'liliana', fromCampaign: 50, other: 3, total: 53 },
      { ownerId: 'pedro', fromCampaign: 40, other: 5, total: 45 },
    ])
  })

  it('flags which seen campaigns a rule covers, and which it does not', () => {
    const s = buildRoutingSummary(
      {
        campaigns: [
          { campaign_id: '111', campaign_name: 'CBO 1 - WhatsApp Pedro', leads: 40 },
          { campaign_id: '222', campaign_name: 'Otra campaña', leads: 60 },
          { campaign_id: '333', campaign_name: 'Campaña sin dueño', leads: 7 },
        ],
      },
      rules,
    )
    expect(s.campaigns.map((c) => [c.id, c.coverage, c.closerId])).toEqual([
      ['222', 'id', 'liliana'],
      ['111', 'name', 'pedro'],
      ['333', 'none', null],
    ])
  })

  it('flags a campaign two closers\' name rules both claim', () => {
    const s = buildRoutingSummary(
      { campaigns: [{ campaign_id: '9', campaign_name: 'Pedro y Liliana juntos', leads: 2 }] },
      [...rules, { id: 'r3', kind: 'name_contains', match_value: 'Liliana', closer_id: 'liliana' }],
    )
    expect(s.campaigns[0]).toMatchObject({ coverage: 'ambiguous', closerId: null })
  })

  it('copes with an empty document', () => {
    expect(buildRoutingSummary({}, rules)).toMatchObject({ total: 0, adRoutedPct: null, byOwner: [], campaigns: [] })
  })
})
