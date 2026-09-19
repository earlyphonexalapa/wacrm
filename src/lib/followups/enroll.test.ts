import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from './fake-db.testutil'
import { HOUR_MS } from './timing'

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))

import { onContactTagAdded, cancelFollowupsOnInbound } from './enroll'

const CALIFICADO = 'tag-calificado'
const PRECIO = 'tag-precio-dado'
const HUMANO = 'tag-requiere-humano'

type Row = Record<string, unknown>

function setup(over: { tables?: Record<string, Row[]> } = {}) {
  const w = makeFakeDb({
    followup_settings: [
      { account_id: 'acct', stop_tag_ids: [HUMANO], timezone: 'America/Mexico_City',
        send_window_enabled: true, window_start_min: 540, window_end_min: 1260, name_fallback: 'amigo' },
    ],
    followup_sequences: [
      {
        id: 'seq-i', account_id: 'acct', trigger_tag_id: CALIFICADO, stop_tag_ids: [PRECIO], is_active: true,
        followup_steps: [
          { position: 0, delay_min_minutes: 180, delay_max_minutes: 240 },
          { position: 1, delay_min_minutes: 840, delay_max_minutes: 960 },
        ],
      },
      {
        id: 'seq-off', account_id: 'acct', trigger_tag_id: CALIFICADO, stop_tag_ids: [], is_active: false,
        followup_steps: [{ position: 0, delay_min_minutes: 60, delay_max_minutes: 60 }],
      },
    ],
    followup_enrollments: [],
    conversations: [{ id: 'conv-1', account_id: 'acct', contact_id: 'contact-1', created_at: '2026-01-01' }],
    contact_tags: [{ contact_id: 'contact-1', tag_id: CALIFICADO }],
    ...over.tables,
  })
  h.db = w.db
  return w
}

const input = { accountId: 'acct', contactId: 'contact-1', tagId: CALIFICADO }

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('onContactTagAdded — enrollment', () => {
  it('enrolls the contact in each ACTIVE sequence triggered by the tag, first step delay applied', async () => {
    const w = setup()
    const before = Date.now()
    await onContactTagAdded(input)

    const rows = w.tables.followup_enrollments
    expect(rows).toHaveLength(1) // the inactive sequence is ignored
    expect(rows[0]).toMatchObject({
      account_id: 'acct',
      sequence_id: 'seq-i',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      next_step_position: 0,
    })
    const due = new Date(rows[0].next_run_at as string).getTime()
    expect(due).toBeGreaterThanOrEqual(before + 180 * 60_000 - 1000)
    expect(due).toBeLessThanOrEqual(Date.now() + 240 * 60_000 + 1000)
  })

  it('does not enroll a contact who already carries a sequence stop tag', async () => {
    const w = setup({
      tables: { contact_tags: [
        { contact_id: 'contact-1', tag_id: CALIFICADO },
        { contact_id: 'contact-1', tag_id: PRECIO },
      ] },
    })
    await onContactTagAdded(input)
    expect(w.tables.followup_enrollments).toHaveLength(0)
  })

  it('does not enroll a contact who carries a GLOBAL stop tag', async () => {
    const w = setup({
      tables: { contact_tags: [
        { contact_id: 'contact-1', tag_id: CALIFICADO },
        { contact_id: 'contact-1', tag_id: HUMANO },
      ] },
    })
    await onContactTagAdded(input)
    expect(w.tables.followup_enrollments).toHaveLength(0)
  })

  it('does nothing when the contact has no conversation to message in', async () => {
    const w = setup({ tables: { conversations: [] } })
    await onContactTagAdded(input)
    expect(w.tables.followup_enrollments).toHaveLength(0)
  })

  it('ignores a tag no sequence is triggered by', async () => {
    const w = setup()
    await onContactTagAdded({ ...input, tagId: 'tag-random' })
    expect(w.tables.followup_enrollments).toHaveLength(0)
  })

  it('never throws, even when the database blows up', async () => {
    h.db = { from: () => { throw new Error('db down') } }
    await expect(onContactTagAdded(input)).resolves.toBeUndefined()
  })
})

describe('onContactTagAdded — moving to a later phase', () => {
  const live = (over: Row = {}): Row => ({
    id: 'enr-1', account_id: 'acct', contact_id: 'contact-1', sequence_id: 'seq-i', status: 'active',
    next_run_at: new Date(Date.now() + HOUR_MS).toISOString(),
    followup_sequences: { stop_tag_ids: [PRECIO] },
    ...over,
  })

  it("cancels a live run when the contact gets that sequence's stop tag", async () => {
    const w = setup({ tables: { followup_enrollments: [live()] } })
    await onContactTagAdded({ ...input, tagId: PRECIO })
    expect(w.tables.followup_enrollments[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'stop_tag' })
  })

  it('cancels every live run when the contact gets a GLOBAL stop tag', async () => {
    const w = setup({ tables: { followup_enrollments: [live()] } })
    await onContactTagAdded({ ...input, tagId: HUMANO })
    expect(w.tables.followup_enrollments[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'stop_tag' })
  })

  it('leaves a live run alone for an unrelated tag', async () => {
    const w = setup({ tables: { followup_enrollments: [live()] } })
    await onContactTagAdded({ ...input, tagId: 'tag-unrelated' })
    expect(w.tables.followup_enrollments[0].status).toBe('active')
  })
})

describe('cancelFollowupsOnInbound', () => {
  it("cancels the contact's live runs as 'replied' and leaves other contacts alone", async () => {
    const w = setup({
      tables: {
        followup_enrollments: [
          { id: 'a', account_id: 'acct', contact_id: 'contact-1', status: 'active' },
          { id: 'b', account_id: 'acct', contact_id: 'contact-2', status: 'active' },
          { id: 'c', account_id: 'acct', contact_id: 'contact-1', status: 'completed' },
        ],
      },
    })
    await cancelFollowupsOnInbound({ accountId: 'acct', contactId: 'contact-1' })
    const byId = Object.fromEntries(w.tables.followup_enrollments.map((r) => [r.id, r]))
    expect(byId.a).toMatchObject({ status: 'cancelled', cancel_reason: 'replied' })
    expect(byId.b.status).toBe('active')
    expect(byId.c.status).toBe('completed')
  })

  it('never throws', async () => {
    h.db = { from: () => { throw new Error('db down') } }
    await expect(cancelFollowupsOnInbound({ accountId: 'a', contactId: 'c' })).resolves.toBeUndefined()
  })
})
