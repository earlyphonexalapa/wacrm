import { describe, it, expect } from 'vitest'
import { evaluateFollowup, type EvaluateInput } from './evaluate'
import { HOUR_MS } from './timing'

// 18 Sep 2026 — 18:00Z is 12:00 in Mexico City (inside 09:00–21:00).
const NOW = new Date('2026-09-18T18:00:00Z')

function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    now: NOW,
    sequenceActive: true,
    hasTriggerTag: true,
    presentStopTagIds: [],
    enrolledAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    // Customer's last message is what the bot was answering, BEFORE enrollment.
    lastCustomerAt: new Date(NOW.getTime() - 3 * HOUR_MS - 60_000),
    humanOwned: false,
    stepType: 'text',
    settings: {
      send_window_enabled: true,
      timezone: 'America/Mexico_City',
      window_start_min: 540,
      window_end_min: 1260,
    },
    ...overrides,
  }
}

describe('evaluateFollowup', () => {
  it('sends when everything checks out', () => {
    expect(evaluateFollowup(input())).toEqual({ action: 'send' })
  })

  it('cancels when the sequence was switched off', () => {
    expect(evaluateFollowup(input({ sequenceActive: false }))).toEqual({
      action: 'cancel',
      reason: 'sequence_disabled',
    })
  })

  it('cancels when the trigger tag was removed', () => {
    expect(evaluateFollowup(input({ hasTriggerTag: false }))).toEqual({
      action: 'cancel',
      reason: 'tag_removed',
    })
  })

  it('cancels when the lead moved to a later phase / stop tag', () => {
    expect(evaluateFollowup(input({ presentStopTagIds: ['tag-precio-dado'] }))).toEqual({
      action: 'cancel',
      reason: 'stop_tag',
    })
  })

  it('cancels when the lead replied after enrolling', () => {
    const replied = input({
      lastCustomerAt: new Date(NOW.getTime() - 30 * 60_000),
    })
    expect(evaluateFollowup(replied)).toEqual({ action: 'cancel', reason: 'replied' })
  })

  it('does NOT treat the message the bot answered (before enrollment) as a reply', () => {
    expect(evaluateFollowup(input()).action).toBe('send')
  })

  it('cancels when a human took over the chat', () => {
    expect(evaluateFollowup(input({ humanOwned: true }))).toEqual({
      action: 'cancel',
      reason: 'human_took_over',
    })
  })

  it('checks cancellation rules before anything else (a stop tag beats an out-of-hours defer)', () => {
    const night = input({
      now: new Date('2026-09-19T05:00:00Z'), // 23:00 local
      presentStopTagIds: ['x'],
    })
    expect(evaluateFollowup(night)).toEqual({ action: 'cancel', reason: 'stop_tag' })
  })

  it('defers to the next window opening when due outside sending hours', () => {
    const now = new Date('2026-09-19T05:00:00Z') // 23:00 local
    const d = evaluateFollowup(
      input({
        now,
        enrolledAt: new Date(now.getTime() - 4 * HOUR_MS),
        // customer wrote 4h05 ago → still well inside 24h at 09:00 next day? 10h05+... yes
        lastCustomerAt: new Date(now.getTime() - 4 * HOUR_MS - 5 * 60_000),
      }),
    )
    expect(d.action).toBe('defer')
    if (d.action === 'defer') {
      expect(d.until.toISOString()).toBe('2026-09-19T15:00:00.000Z') // 09:00 local
    }
  })

  it('skips a text step instead of deferring it past the 24h window', () => {
    const now = new Date('2026-09-19T05:00:00Z') // 23:00 local
    const d = evaluateFollowup(
      input({
        now,
        enrolledAt: new Date(now.getTime() - 20 * HOUR_MS),
        // wrote 20h ago → window closes in 4h, but the next opening is in 10h
        lastCustomerAt: new Date(now.getTime() - 20 * HOUR_MS - 60_000),
      }),
    )
    expect(d).toEqual({ action: 'skip', reason: 'outside_24h' })
  })

  it('still defers a TEMPLATE step even when the 24h window will be closed', () => {
    const now = new Date('2026-09-19T05:00:00Z')
    const d = evaluateFollowup(
      input({
        now,
        stepType: 'template',
        enrolledAt: new Date(now.getTime() - 20 * HOUR_MS),
        lastCustomerAt: new Date(now.getTime() - 20 * HOUR_MS - 60_000),
      }),
    )
    expect(d.action).toBe('defer')
  })

  it('skips a text step when the 24h window is already closed', () => {
    const d = evaluateFollowup(
      input({
        enrolledAt: new Date(NOW.getTime() - 60 * HOUR_MS),
        lastCustomerAt: new Date(NOW.getTime() - 60 * HOUR_MS - 60_000),
      }),
    )
    expect(d).toEqual({ action: 'skip', reason: 'outside_24h' })
  })

  it('sends a template step even when the 24h window is closed (marketing template)', () => {
    const d = evaluateFollowup(
      input({
        stepType: 'template',
        enrolledAt: new Date(NOW.getTime() - 60 * HOUR_MS),
        lastCustomerAt: new Date(NOW.getTime() - 60 * HOUR_MS - 60_000),
      }),
    )
    expect(d).toEqual({ action: 'send' })
  })

  it('ignores sending hours when the window restriction is turned off', () => {
    const now = new Date('2026-09-19T05:00:00Z') // 23:00 local
    const d = evaluateFollowup(
      input({
        now,
        enrolledAt: new Date(now.getTime() - 3 * HOUR_MS),
        lastCustomerAt: new Date(now.getTime() - 3 * HOUR_MS - 60_000),
        settings: {
          send_window_enabled: false,
          timezone: 'America/Mexico_City',
          window_start_min: 540,
          window_end_min: 1260,
        },
      }),
    )
    expect(d).toEqual({ action: 'send' })
  })
})
