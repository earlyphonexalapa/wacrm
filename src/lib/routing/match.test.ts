import { describe, expect, it } from 'vitest'
import { matchCampaignRule, nameContains, normalizeText, type RoutingRule } from './match'

const rule = (over: Partial<RoutingRule> & Pick<RoutingRule, 'kind' | 'match_value' | 'closer_id'>): RoutingRule => ({
  id: `r-${over.match_value}`,
  ...over,
})

describe('normalizeText', () => {
  it('lowercases, strips accents and collapses punctuation', () => {
    expect(normalizeText('  CBO 1 Interacción - WhatsApp  PEDRO! ')).toBe('cbo 1 interaccion whatsapp pedro')
  })
})

describe('nameContains', () => {
  it('matches a whole word anywhere in the name, ignoring case and accents', () => {
    expect(nameContains('CBO 1 interacción - WhatsApp Pedro', 'pedro')).toBe(true)
    expect(nameContains('CBO 2 - WhatsApp LILIANA (copia)', 'Liliana')).toBe(true)
    expect(nameContains('Campaña Josué', 'josue')).toBe(true)
  })

  it('does not match inside a longer word', () => {
    expect(nameContains('CBO - WhatsApp Mariana', 'Ana')).toBe(false)
    expect(nameContains('CBO - WhatsApp Pedrito', 'Pedro')).toBe(false)
  })

  it('matches a multi-word phrase', () => {
    expect(nameContains('Ventas WhatsApp Ana Maria Q4', 'ana maria')).toBe(true)
    expect(nameContains('Ventas WhatsApp Ana', 'ana maria')).toBe(false)
  })

  it('ignores an empty needle', () => {
    expect(nameContains('Anything', '   ')).toBe(false)
  })
})

describe('matchCampaignRule', () => {
  const campaign = { id: '123', name: 'CBO 1 interacción - WhatsApp Pedro' }

  it('matches a name rule', () => {
    const rules = [rule({ kind: 'name_contains', match_value: 'Pedro', closer_id: 'pedro' })]
    expect(matchCampaignRule(rules, campaign)).toMatchObject({ kind: 'match', closerId: 'pedro' })
  })

  it('lets an exact campaign-id rule override a conflicting name rule', () => {
    const rules = [
      rule({ kind: 'name_contains', match_value: 'Pedro', closer_id: 'pedro' }),
      rule({ kind: 'campaign_id', match_value: '123', closer_id: 'liliana' }),
    ]
    expect(matchCampaignRule(rules, campaign)).toMatchObject({ kind: 'match', closerId: 'liliana' })
  })

  it('is ambiguous when name rules for different closers both hit', () => {
    const rules = [
      rule({ kind: 'name_contains', match_value: 'Pedro', closer_id: 'pedro' }),
      rule({ kind: 'name_contains', match_value: 'WhatsApp', closer_id: 'liliana' }),
    ]
    expect(matchCampaignRule(rules, campaign)).toEqual({ kind: 'ambiguous', closerIds: ['pedro', 'liliana'] })
  })

  it('is not ambiguous when two rules point at the same closer', () => {
    const rules = [
      rule({ kind: 'name_contains', match_value: 'Pedro', closer_id: 'pedro' }),
      rule({ kind: 'name_contains', match_value: 'WhatsApp', closer_id: 'pedro' }),
    ]
    expect(matchCampaignRule(rules, campaign)).toMatchObject({ kind: 'match', closerId: 'pedro' })
  })

  it('returns none when nothing matches or the campaign has no name', () => {
    const rules = [rule({ kind: 'name_contains', match_value: 'Liliana', closer_id: 'liliana' })]
    expect(matchCampaignRule(rules, campaign)).toEqual({ kind: 'none' })
    expect(matchCampaignRule(rules, { id: '9', name: null })).toEqual({ kind: 'none' })
  })
})
