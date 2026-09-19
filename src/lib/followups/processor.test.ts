import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from './fake-db.testutil'
import { HOUR_MS, MINUTE_MS } from './timing'

const h = vi.hoisted(() => ({ sendFollowupStep: vi.fn() }))
vi.mock('./send', () => ({ sendFollowupStep: h.sendFollowupStep }))

import { processDueFollowups } from './processor'

// 18 Sep 2026 18:00Z = 12:00 Mexico City (inside the 09:00–21:00 window)
const NOW = new Date('2026-09-18T18:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const TRIGGER = 'tag-calificado'
const STOP = 'tag-precio-dado'
const GLOBAL_STOP = 'tag-requiere-humano'

function step(position: number, minMin: number, maxMin: number, type: 'text' | 'template' = 'text') {
  return {
    id: `step-${position}`,
    position,
    delay_min_minutes: minMin,
    delay_max_minutes: maxMin,
    message_type: type,
    message_text: type === 'text' ? `msg ${position}` : null,
    template_name: type === 'template' ? 'retomar' : null,
    template_language: type === 'template' ? 'es_MX' : null,
    template_variables: [],
  }
}

interface Setup {
  steps?: ReturnType<typeof step>[]
  enrolledAgoMs?: number
  lastInboundAgoMs?: number | null
  contactTags?: string[]
  assigned?: string | null
  aiDisabled?: boolean
  sequenceActive?: boolean
  nextStepPosition?: number
  attempts?: number
  nextRunAt?: string
  lockedUntil?: string | null
  now?: Date
}

function world(s: Setup = {}) {
  const now = s.now ?? NOW
  const enrolledAgo = s.enrolledAgoMs ?? 3 * HOUR_MS
  const lastInboundAgo = s.lastInboundAgoMs === undefined ? enrolledAgo + MINUTE_MS : s.lastInboundAgoMs
  return {
    now,
    ...makeFakeDb({
      followup_enrollments: [
        {
          id: 'enr-1',
          account_id: 'acct',
          sequence_id: 'seq-1',
          contact_id: 'contact-1',
          conversation_id: 'conv-1',
          status: 'active',
          enrolled_at: iso(now.getTime() - enrolledAgo),
          next_step_position: s.nextStepPosition ?? 0,
          next_run_at: s.nextRunAt ?? iso(now.getTime() - MINUTE_MS),
          attempts: s.attempts ?? 0,
          locked_until: s.lockedUntil ?? null,
          last_sent_at: null,
        },
      ],
      followup_sequences: [
        {
          id: 'seq-1',
          account_id: 'acct',
          name: 'I',
          description: null,
          trigger_tag_id: TRIGGER,
          stop_tag_ids: [STOP],
          is_active: s.sequenceActive ?? true,
          position: 0,
          created_by: 'user-1',
          followup_steps: s.steps ?? [step(0, 180, 240), step(1, 840, 960)],
        },
      ],
      followup_settings: [],
      followup_sends: [],
      contacts: [{ id: 'contact-1', name: 'Antonio' }],
      conversations: [
        {
          id: 'conv-1',
          assigned_agent_id: s.assigned ?? null,
          ai_autoreply_disabled: s.aiDisabled ?? false,
        },
      ],
      contact_tags: (s.contactTags ?? [TRIGGER]).map((t) => ({ contact_id: 'contact-1', tag_id: t })),
      messages:
        lastInboundAgo === null
          ? []
          : [
              {
                conversation_id: 'conv-1',
                sender_type: 'customer',
                created_at: iso(now.getTime() - lastInboundAgo),
              },
            ],
    }),
  }
}

const enrollment = (w: ReturnType<typeof world>) => w.tables.followup_enrollments[0] as Record<string, unknown>

beforeEach(() => {
  h.sendFollowupStep.mockReset()
  h.sendFollowupStep.mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
})

describe('processDueFollowups', () => {
  it('sends the due step, logs it, and schedules the next one from the enrollment time', async () => {
    const w = world()
    const r = await processDueFollowups({ db: w.db, now: w.now })

    expect(r.sent).toBe(1)
    expect(h.sendFollowupStep).toHaveBeenCalledTimes(1)
    expect(h.sendFollowupStep.mock.calls[0][0]).toMatchObject({
      accountId: 'acct',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      vars: { nombre: 'Antonio' },
    })
    expect(w.tables.followup_sends[0]).toMatchObject({ status: 'sent', step_position: 0 })

    const e = enrollment(w)
    expect(e.status).toBe('active')
    expect(e.next_step_position).toBe(1)
    expect(e.locked_until).toBeNull()
    // Step 2 waits 14–16h from ENROLLMENT (3h ago) → 11–13h from now.
    const runAt = new Date(e.next_run_at as string).getTime()
    expect(runAt).toBeGreaterThanOrEqual(w.now.getTime() + 11 * HOUR_MS)
    expect(runAt).toBeLessThanOrEqual(w.now.getTime() + 13 * HOUR_MS)
  })

  it('completes the sequence after the last step', async () => {
    const w = world({ nextStepPosition: 1 })
    await processDueFollowups({ db: w.db, now: w.now })
    expect(enrollment(w).status).toBe('completed')
  })

  it('does not touch an enrollment that is not due yet', async () => {
    const w = world({ nextRunAt: iso(NOW.getTime() + HOUR_MS) })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.claimed).toBe(0)
    expect(h.sendFollowupStep).not.toHaveBeenCalled()
  })

  it('skips an enrollment another worker holds a live lease on', async () => {
    const w = world({ lockedUntil: iso(NOW.getTime() + 2 * MINUTE_MS) })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.claimed).toBe(0)
    expect(h.sendFollowupStep).not.toHaveBeenCalled()
  })

  it('reclaims an enrollment whose worker died (expired lease)', async () => {
    const w = world({ lockedUntil: iso(NOW.getTime() - MINUTE_MS) })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.sent).toBe(1)
  })

  it('never double-sends when two workers race for the same row', async () => {
    const w = world()
    await Promise.all([
      processDueFollowups({ db: w.db, now: w.now }),
      processDueFollowups({ db: w.db, now: w.now }),
    ])
    expect(h.sendFollowupStep).toHaveBeenCalledTimes(1)
  })

  it('cancels when the lead replied after enrolling', async () => {
    const w = world({ lastInboundAgoMs: 20 * MINUTE_MS })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.cancelled).toBe(1)
    expect(enrollment(w)).toMatchObject({ status: 'cancelled', cancel_reason: 'replied' })
    expect(h.sendFollowupStep).not.toHaveBeenCalled()
  })

  it('cancels when the contact moved to the sequence stop tag', async () => {
    const w = world({ contactTags: [TRIGGER, STOP] })
    await processDueFollowups({ db: w.db, now: w.now })
    expect(enrollment(w)).toMatchObject({ status: 'cancelled', cancel_reason: 'stop_tag' })
  })

  it('cancels when the contact carries a GLOBAL stop tag', async () => {
    const w = world({ contactTags: [TRIGGER, GLOBAL_STOP] })
    ;(w.tables.followup_settings as Record<string, unknown>[]).push({
      account_id: 'acct',
      timezone: 'America/Mexico_City',
      send_window_enabled: true,
      window_start_min: 540,
      window_end_min: 1260,
      stop_tag_ids: [GLOBAL_STOP],
      name_fallback: 'amigo',
    })
    await processDueFollowups({ db: w.db, now: w.now })
    expect(enrollment(w)).toMatchObject({ status: 'cancelled', cancel_reason: 'stop_tag' })
  })

  it('cancels when the trigger tag was removed', async () => {
    const w = world({ contactTags: [] })
    await processDueFollowups({ db: w.db, now: w.now })
    expect(enrollment(w)).toMatchObject({ status: 'cancelled', cancel_reason: 'tag_removed' })
  })

  it('cancels when a human is assigned, or the AI handed the chat off', async () => {
    const a = world({ assigned: 'agent-1' })
    await processDueFollowups({ db: a.db, now: a.now })
    expect(enrollment(a)).toMatchObject({ status: 'cancelled', cancel_reason: 'human_took_over' })

    const b = world({ aiDisabled: true })
    await processDueFollowups({ db: b.db, now: b.now })
    expect(enrollment(b)).toMatchObject({ status: 'cancelled', cancel_reason: 'human_took_over' })
  })

  it('cancels when the sequence was switched off', async () => {
    const w = world({ sequenceActive: false })
    await processDueFollowups({ db: w.db, now: w.now })
    expect(enrollment(w)).toMatchObject({ status: 'cancelled', cancel_reason: 'sequence_disabled' })
  })

  it('defers to the next window opening when due at night, without sending', async () => {
    const night = new Date('2026-09-19T05:00:00Z') // 23:00 Mexico City
    const w = world({ now: night })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.deferred).toBe(1)
    expect(h.sendFollowupStep).not.toHaveBeenCalled()
    const next = new Date(enrollment(w).next_run_at as string).getTime()
    const nineLocal = new Date('2026-09-19T15:00:00Z').getTime()
    expect(next).toBeGreaterThanOrEqual(nineLocal)
    expect(next).toBeLessThanOrEqual(nineLocal + 15 * MINUTE_MS)
    expect(enrollment(w).status).toBe('active')
  })

  it('skips a text step whose 24h window has closed, logs why, and moves on', async () => {
    const w = world({ enrolledAgoMs: 30 * HOUR_MS })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.skipped).toBe(1)
    expect(h.sendFollowupStep).not.toHaveBeenCalled()
    expect(w.tables.followup_sends[0]).toMatchObject({ status: 'skipped' })
    expect(enrollment(w).next_step_position).toBe(1)
  })

  it('still sends a TEMPLATE step after the 24h window has closed', async () => {
    const w = world({ enrolledAgoMs: 60 * HOUR_MS, steps: [step(0, 2880, 4320, 'template')] })
    const r = await processDueFollowups({ db: w.db, now: w.now })
    expect(r.sent).toBe(1)
    expect(enrollment(w).status).toBe('completed')
  })

  it('retries a failed send with backoff, then gives up on that step after 3 attempts', async () => {
    h.sendFollowupStep.mockRejectedValue(new Error('meta 500'))
    const w = world({ steps: [step(0, 180, 240), step(1, 840, 960)] })

    await processDueFollowups({ db: w.db, now: w.now })
    let e = enrollment(w)
    expect(e.attempts).toBe(1)
    expect(e.next_step_position).toBe(0) // same step, retried later
    expect(new Date(e.next_run_at as string).getTime()).toBe(w.now.getTime() + 5 * MINUTE_MS)

    // attempts 2 and 3
    e.next_run_at = iso(w.now.getTime() - MINUTE_MS)
    await processDueFollowups({ db: w.db, now: w.now })
    expect((enrollment(w).attempts)).toBe(2)
    enrollment(w).next_run_at = iso(w.now.getTime() - MINUTE_MS)
    await processDueFollowups({ db: w.db, now: w.now })

    e = enrollment(w)
    expect(e.next_step_position).toBe(1) // gave up on step 0, moved on
    expect(e.attempts).toBe(0)
    expect(e.status).toBe('active')
    const failed = w.tables.followup_sends.filter((s) => s.status === 'failed')
    expect(failed).toHaveLength(3)
  })

  it('personalises with the fallback name when the contact has no usable first name', async () => {
    const w = world()
    ;(w.tables.contacts[0] as Record<string, unknown>).name = '5215618893400'
    await processDueFollowups({ db: w.db, now: w.now })
    expect(h.sendFollowupStep.mock.calls[0][0].vars.nombre).toBe('amigo')
  })
})
