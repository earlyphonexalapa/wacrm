import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))
vi.mock('@/lib/ai/handoff-whatsapp', () => ({ isCloserPhone: vi.fn() }))

import { routeLead, type RouteLeadDeps } from './assign'

type Row = Record<string, unknown>
interface State {
  tables: Record<string, Row[]>
  rpc: { pick_organic_closer: string | null }
}

/** Minimal in-memory stand-in for the query-builder calls routeLead makes. */
function makeDb(state: State) {
  class Query {
    private op: 'select' | 'update' | 'upsert' = 'select'
    private filters: ((r: Row) => boolean)[] = []
    private patch: Row = {}
    private upsertRow: Row = {}
    private wantRows = false
    constructor(private table: string) {}
    select() {
      if (this.op === 'update') this.wantRows = true
      return this
    }
    eq(col: string, val: unknown) {
      this.filters.push((r) => r[col] === val)
      return this
    }
    is(col: string, val: null) {
      this.filters.push((r) => (r[col] ?? null) === val)
      return this
    }
    update(patch: Row) {
      this.op = 'update'
      this.patch = patch
      return this
    }
    upsert(row: Row) {
      this.op = 'upsert'
      this.upsertRow = row
      return this
    }
    private matching() {
      return (state.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)))
    }
    private run(): { data: unknown; error: null } {
      if (this.op === 'upsert') {
        const rows = (state.tables[this.table] ??= [])
        const i = rows.findIndex((r) => r.account_id === this.upsertRow.account_id && r.ad_id === this.upsertRow.ad_id)
        if (i >= 0) rows[i] = { ...rows[i], ...this.upsertRow }
        else rows.push({ ...this.upsertRow })
        return { data: null, error: null }
      }
      if (this.op === 'update') {
        const hit = this.matching()
        hit.forEach((r) => Object.assign(r, this.patch))
        return { data: this.wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null }
      }
      return { data: this.matching(), error: null }
    }
    maybeSingle() {
      return Promise.resolve({ data: this.matching()[0] ?? null, error: null })
    }
    then<T>(res: (v: { data: unknown; error: null }) => T, rej?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(res, rej)
    }
  }
  return {
    from: (t: string) => new Query(t),
    rpc: vi.fn(async () => ({ data: state.rpc.pick_organic_closer, error: null })),
  } as unknown as SupabaseClient
}

const ACCOUNT = 'acct'
const NOW = new Date('2026-10-05T12:00:00Z')

function baseState(over: Partial<State['tables']> = {}, organic: string | null = 'liliana'): State {
  return {
    rpc: { pick_organic_closer: organic },
    tables: {
      lead_routing_settings: [{ account_id: ACCOUNT, enabled: true, ads_access_token: 'enc:tok', last_error: null }],
      lead_routing_closers: [{ account_id: ACCOUNT, user_id: 'pedro' }, { account_id: ACCOUNT, user_id: 'liliana' }],
      lead_routing_rules: [
        { id: 'r1', account_id: ACCOUNT, kind: 'name_contains', match_value: 'Pedro', closer_id: 'pedro' },
        { id: 'r2', account_id: ACCOUNT, kind: 'name_contains', match_value: 'Liliana', closer_id: 'liliana' },
      ],
      ad_campaign_cache: [],
      contacts: [{ id: 'ct1', phone: '5215512345678' }],
      conversations: [{ id: 'cv1', owner_agent_id: null }],
      ...over,
    },
  }
}

function run(state: State, referral: Parameters<typeof routeLead>[0]['referral'], deps: RouteLeadDeps = {}) {
  return routeLead(
    { db: makeDb(state), accountId: ACCOUNT, conversationId: 'cv1', contactId: 'ct1', referral },
    { now: () => NOW, isCloserPhone: async () => false, ...deps },
  )
}

const conv = (s: State) => s.tables.conversations[0]
const fetchPedro = () => vi.fn(async () => ({ id: 'camp-1', name: 'CBO 1 interacción - WhatsApp Pedro' }))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('routeLead', () => {
  it('does nothing when routing is switched off', async () => {
    const s = baseState({ lead_routing_settings: [{ account_id: ACCOUNT, enabled: false }] })
    expect(await run(s, { source_id: 'ad-1' })).toEqual({ routed: false, reason: 'disabled' })
    expect(conv(s).owner_agent_id).toBeNull()
  })

  it('does nothing when the account has no routing settings at all', async () => {
    const s = baseState({ lead_routing_settings: [] })
    expect(await run(s, null)).toEqual({ routed: false, reason: 'disabled' })
  })

  it('does not route a closer writing to the shared number', async () => {
    const s = baseState()
    const result = await run(s, null, { isCloserPhone: async () => true })
    expect(result).toEqual({ routed: false, reason: 'closer_phone' })
    expect(conv(s).owner_agent_id).toBeNull()
  })

  it('gives an ad lead to the closer whose campaign rule matches, and caches the campaign', async () => {
    const s = baseState()
    const fetchAdCampaign = fetchPedro()

    const result = await run(s, { source_id: 'ad-1', source_type: 'ad', ctwa_clid: 'clid' }, { fetchAdCampaign })

    expect(result).toEqual({ routed: true, ownerId: 'pedro', source: 'campaign' })
    expect(fetchAdCampaign).toHaveBeenCalledWith('ad-1', 'tok')
    expect(conv(s)).toMatchObject({ owner_agent_id: 'pedro', owner_source: 'campaign', owner_assigned_at: NOW.toISOString() })
    expect(s.tables.ad_campaign_cache[0]).toMatchObject({ ad_id: 'ad-1', campaign_id: 'camp-1' })
    expect(s.tables.contacts[0]).toMatchObject({ ctwa_campaign_id: 'camp-1', ctwa_campaign_name: 'CBO 1 interacción - WhatsApp Pedro' })
  })

  it('does not call Meta again for an ad seen within the last day', async () => {
    const s = baseState({
      ad_campaign_cache: [
        { account_id: ACCOUNT, ad_id: 'ad-1', campaign_id: 'camp-2', campaign_name: 'CBO 2 - WhatsApp Liliana', resolved_at: '2026-10-05T08:00:00Z' },
      ],
    })
    const fetchAdCampaign = fetchPedro()

    const result = await run(s, { source_id: 'ad-1' }, { fetchAdCampaign })

    expect(fetchAdCampaign).not.toHaveBeenCalled()
    expect(result).toEqual({ routed: true, ownerId: 'liliana', source: 'campaign' })
  })

  it('falls back to a stale cached campaign when Meta is unreachable, and records the error', async () => {
    const s = baseState({
      ad_campaign_cache: [
        { account_id: ACCOUNT, ad_id: 'ad-1', campaign_id: 'camp-1', campaign_name: 'WhatsApp Pedro', resolved_at: '2026-09-01T00:00:00Z' },
      ],
    })
    const fetchAdCampaign = vi.fn(async () => {
      throw new Error('token expired')
    })

    const result = await run(s, { source_id: 'ad-1' }, { fetchAdCampaign })

    expect(result).toEqual({ routed: true, ownerId: 'pedro', source: 'campaign' })
    expect(s.tables.lead_routing_settings[0]).toMatchObject({ last_error: 'token expired' })
  })

  it('clears a previous error after a successful lookup', async () => {
    const s = baseState()
    s.tables.lead_routing_settings[0].last_error = 'old error'
    await run(s, { source_id: 'ad-1' }, { fetchAdCampaign: fetchPedro() })
    expect(s.tables.lead_routing_settings[0]).toMatchObject({ last_error: null })
  })

  it('sends an ad lead whose campaign has no rule to the organic pool', async () => {
    const s = baseState()
    const fetchAdCampaign = vi.fn(async () => ({ id: 'camp-9', name: 'Campaña sin dueño' }))

    const result = await run(s, { source_id: 'ad-9' }, { fetchAdCampaign })

    expect(result).toEqual({ routed: true, ownerId: 'liliana', source: 'unmatched_campaign' })
  })

  it('ignores a campaign rule whose closer is no longer a closer', async () => {
    const s = baseState({
      lead_routing_closers: [{ account_id: ACCOUNT, user_id: 'liliana' }],
    })
    const result = await run(s, { source_id: 'ad-1' }, { fetchAdCampaign: fetchPedro() })
    expect(result).toEqual({ routed: true, ownerId: 'liliana', source: 'unmatched_campaign' })
  })

  it('marks an ad lead as unresolved when the campaign cannot be found', async () => {
    const s = baseState()
    const fetchAdCampaign = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await run(s, { source_id: 'ad-1' }, { fetchAdCampaign })
    expect(result).toEqual({ routed: true, ownerId: 'liliana', source: 'unresolved' })
  })

  it('marks an ad lead as unresolved when no Meta token is saved', async () => {
    const s = baseState({
      lead_routing_settings: [{ account_id: ACCOUNT, enabled: true, ads_access_token: null }],
    })
    const fetchAdCampaign = fetchPedro()
    const result = await run(s, { source_id: 'ad-1' }, { fetchAdCampaign })
    expect(fetchAdCampaign).not.toHaveBeenCalled()
    expect(result).toMatchObject({ routed: true, source: 'unresolved' })
  })

  it('does not look up a campaign for a post referral', async () => {
    const s = baseState()
    const fetchAdCampaign = fetchPedro()
    const result = await run(s, { source_id: 'post-1', source_type: 'post', ctwa_clid: 'c' }, { fetchAdCampaign })
    expect(fetchAdCampaign).not.toHaveBeenCalled()
    expect(result).toMatchObject({ routed: true, source: 'unresolved' })
  })

  it('treats a message with no referral as organic', async () => {
    const s = baseState()
    const result = await run(s, undefined)
    expect(result).toEqual({ routed: true, ownerId: 'liliana', source: 'organic' })
    expect(conv(s).owner_source).toBe('organic')
  })

  it('leaves the lead unowned when there are no closers to give it to', async () => {
    const s = baseState({}, null)
    const result = await run(s, undefined)
    expect(result).toEqual({ routed: false, reason: 'no_closers' })
    expect(conv(s).owner_agent_id).toBeNull()
  })

  it('keeps an owner that was set in the meantime', async () => {
    const s = baseState({ conversations: [{ id: 'cv1', owner_agent_id: 'pedro' }] })
    const result = await run(s, undefined)
    expect(result).toEqual({ routed: false, reason: 'already_owned' })
    expect(conv(s).owner_agent_id).toBe('pedro')
  })

  it('never throws, even when the database misbehaves', async () => {
    const db = {
      from: () => {
        throw new Error('db down')
      },
    } as unknown as SupabaseClient
    const result = await routeLead({ db, accountId: ACCOUNT, conversationId: 'cv1', contactId: 'ct1' })
    expect(result).toEqual({ routed: false, reason: 'error' })
  })
})
