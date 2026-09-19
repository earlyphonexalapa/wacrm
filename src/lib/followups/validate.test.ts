import { describe, it, expect } from 'vitest'
import { parseSequenceInput, parseSettingsInput } from './validate'

const TAG = '11111111-1111-4111-8111-111111111111'
const TAG2 = '22222222-2222-4222-8222-222222222222'

function seq(overrides: Record<string, unknown> = {}) {
  return {
    name: 'NI',
    trigger_tag_id: TAG,
    stop_tag_ids: [TAG2],
    is_active: false,
    steps: [
      { delay_min_minutes: 120, delay_max_minutes: 180, message_type: 'text', message_text: 'hola' },
      { delay_min_minutes: 840, delay_max_minutes: 960, message_type: 'text', message_text: 'otra vez' },
    ],
    ...overrides,
  }
}

describe('parseSequenceInput', () => {
  it('accepts a valid sequence and numbers the steps', () => {
    const r = parseSequenceInput(seq())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.steps.map((s) => s.position)).toEqual([0, 1])
      expect(r.value.stop_tag_ids).toEqual([TAG2])
    }
  })

  it('requires a name, a valid trigger tag and at least one step', () => {
    expect(parseSequenceInput(seq({ name: '  ' })).ok).toBe(false)
    expect(parseSequenceInput(seq({ trigger_tag_id: 'nope' })).ok).toBe(false)
    expect(parseSequenceInput(seq({ steps: [] })).ok).toBe(false)
  })

  it('rejects the trigger tag doubling as a stop tag', () => {
    expect(parseSequenceInput(seq({ stop_tag_ids: [TAG] })).ok).toBe(false)
  })

  it('rejects a "to" wait shorter than "from"', () => {
    const r = parseSequenceInput(
      seq({ steps: [{ delay_min_minutes: 180, delay_max_minutes: 120, message_text: 'x' }] }),
    )
    expect(r.ok).toBe(false)
  })

  it('requires later steps to wait longer than earlier ones', () => {
    const r = parseSequenceInput(
      seq({
        steps: [
          { delay_min_minutes: 120, delay_max_minutes: 180, message_text: 'a' },
          { delay_min_minutes: 150, delay_max_minutes: 200, message_text: 'b' },
        ],
      }),
    )
    expect(r.ok).toBe(false)
  })

  it('lets a DRAFT keep empty messages but blocks activating them', () => {
    const blank = { steps: [{ delay_min_minutes: 60, delay_max_minutes: 60, message_text: '' }] }
    expect(parseSequenceInput(seq({ ...blank, is_active: false })).ok).toBe(true)
    expect(parseSequenceInput(seq({ ...blank, is_active: true })).ok).toBe(false)
  })

  it('requires a chosen template to activate a template step', () => {
    const tpl = {
      steps: [{ delay_min_minutes: 2880, delay_max_minutes: 4320, message_type: 'template' }],
    }
    expect(parseSequenceInput(seq({ ...tpl, is_active: true })).ok).toBe(false)
    expect(
      parseSequenceInput(
        seq({
          steps: [
            {
              delay_min_minutes: 2880,
              delay_max_minutes: 4320,
              message_type: 'template',
              template_name: 'retomar_950',
              template_language: 'es_MX',
              template_variables: ['{{nombre}}'],
            },
          ],
          is_active: true,
        }),
      ).ok,
    ).toBe(true)
  })

  it('caps step count and message length', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      delay_min_minutes: 60 * (i + 1),
      delay_max_minutes: 60 * (i + 1),
      message_text: 'x',
    }))
    expect(parseSequenceInput(seq({ steps: many })).ok).toBe(false)
    expect(
      parseSequenceInput(
        seq({ steps: [{ delay_min_minutes: 60, delay_max_minutes: 60, message_text: 'x'.repeat(1025) }] }),
      ).ok,
    ).toBe(false)
  })
})

describe('parseSettingsInput', () => {
  const base = {
    timezone: 'America/Mexico_City',
    send_window_enabled: true,
    window_start_min: 540,
    window_end_min: 1260,
    stop_tag_ids: [TAG],
    name_fallback: 'amigo',
  }

  it('accepts valid settings', () => {
    expect(parseSettingsInput(base).ok).toBe(true)
  })

  it('rejects an unknown timezone and an inverted window', () => {
    expect(parseSettingsInput({ ...base, timezone: 'Mars/Base' }).ok).toBe(false)
    expect(parseSettingsInput({ ...base, window_start_min: 1300, window_end_min: 600 }).ok).toBe(false)
  })

  it('does not care about window order when the restriction is off', () => {
    expect(
      parseSettingsInput({ ...base, send_window_enabled: false, window_start_min: 1300, window_end_min: 600 }).ok,
    ).toBe(true)
  })

  it('requires a fallback name', () => {
    expect(parseSettingsInput({ ...base, name_fallback: '  ' }).ok).toBe(false)
  })
})
