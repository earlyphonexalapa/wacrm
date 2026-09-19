import {
  FOLLOWUP_LIMITS,
  type FollowupMessageType,
  type FollowupSettings,
  type FollowupStep,
} from './types'
import { isValidTimeZone } from './timing'

// ============================================================
// Input validation shared by the API routes (and mirrored by the
// editor for instant feedback). Pure — returns error strings, never
// throws — so the routes can 400 with a readable message.
// ============================================================

export interface SequenceInput {
  name: string
  description: string | null
  trigger_tag_id: string
  stop_tag_ids: string[]
  is_active: boolean
  steps: FollowupStep[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asStringArray(v: unknown): string[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function parseStep(raw: unknown, index: number): FollowupStep | string {
  if (!raw || typeof raw !== 'object') return `Step ${index + 1} is invalid.`
  const r = raw as Record<string, unknown>
  const min = Number(r.delay_min_minutes)
  const max = Number(r.delay_max_minutes)
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    return `Step ${index + 1}: the wait must be at least 1 minute, and "to" can't be less than "from".`
  }
  if (max > FOLLOWUP_LIMITS.maxDelayMinutes) {
    return `Step ${index + 1}: the wait can't exceed 30 days.`
  }
  const type = r.message_type === 'template' ? 'template' : 'text'
  const text = asString(r.message_text).trim()
  if (text.length > FOLLOWUP_LIMITS.maxTextLength) {
    return `Step ${index + 1}: the message is longer than ${FOLLOWUP_LIMITS.maxTextLength} characters.`
  }
  const variables = asStringArray(r.template_variables)
  if (variables === null) return `Step ${index + 1}: template variables are invalid.`

  return {
    position: index,
    delay_min_minutes: min,
    delay_max_minutes: max,
    message_type: type as FollowupMessageType,
    message_text: text || null,
    template_name: asString(r.template_name).trim() || null,
    template_language: asString(r.template_language).trim() || null,
    template_variables: variables.map((v) => v.trim()),
  }
}

/**
 * Parse + validate a sequence payload. When `is_active` is true the
 * sequence is being ACTIVATED, so every step must also be sendable
 * (message written / template chosen) — a draft may be saved
 * half-finished.
 */
export function parseSequenceInput(
  body: unknown,
): { ok: true; value: SequenceInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body.' }
  const b = body as Record<string, unknown>

  const name = asString(b.name).trim()
  if (!name) return { ok: false, error: 'Give the sequence a name.' }
  if (name.length > 120) return { ok: false, error: 'The name is too long.' }

  const trigger = asString(b.trigger_tag_id)
  if (!UUID_RE.test(trigger)) return { ok: false, error: 'Choose the tag that starts this sequence.' }

  const stopTags = asStringArray(b.stop_tag_ids)
  if (stopTags === null || stopTags.some((id) => !UUID_RE.test(id))) {
    return { ok: false, error: 'Stop tags are invalid.' }
  }
  if (stopTags.includes(trigger)) {
    return { ok: false, error: 'The starting tag can\'t also be a stop tag.' }
  }

  if (!Array.isArray(b.steps) || b.steps.length === 0) {
    return { ok: false, error: 'Add at least one step.' }
  }
  if (b.steps.length > FOLLOWUP_LIMITS.maxStepsPerSequence) {
    return { ok: false, error: `A sequence can have at most ${FOLLOWUP_LIMITS.maxStepsPerSequence} steps.` }
  }

  const steps: FollowupStep[] = []
  for (let i = 0; i < b.steps.length; i++) {
    const parsed = parseStep(b.steps[i], i)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    steps.push(parsed)
  }

  // Waits are counted from enrollment, so later steps must come later.
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].delay_min_minutes <= steps[i - 1].delay_max_minutes) {
      return {
        ok: false,
        error: `Step ${i + 1} must wait longer than step ${i} (waits are counted from when the tag was added).`,
      }
    }
  }

  const isActive = b.is_active === true
  if (isActive) {
    for (const s of steps) {
      if (s.message_type === 'text' && !s.message_text) {
        return { ok: false, error: `Step ${s.position + 1} needs a message before the sequence can be activated.` }
      }
      if (s.message_type === 'template' && !s.template_name) {
        return { ok: false, error: `Step ${s.position + 1} needs an approved template before the sequence can be activated.` }
      }
    }
  }

  const description = asString(b.description).trim()
  return {
    ok: true,
    value: {
      name,
      description: description || null,
      trigger_tag_id: trigger,
      stop_tag_ids: stopTags,
      is_active: isActive,
      steps,
    },
  }
}

export function parseSettingsInput(
  body: unknown,
): { ok: true; value: FollowupSettings } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body.' }
  const b = body as Record<string, unknown>

  const timezone = asString(b.timezone).trim()
  if (!timezone || !isValidTimeZone(timezone)) return { ok: false, error: 'Unknown timezone.' }

  const start = Number(b.window_start_min)
  const end = Number(b.window_end_min)
  if (!Number.isInteger(start) || start < 0 || start > 1439) {
    return { ok: false, error: 'The start time is invalid.' }
  }
  if (!Number.isInteger(end) || end < 1 || end > 1440) {
    return { ok: false, error: 'The end time is invalid.' }
  }
  if (b.send_window_enabled !== false && start >= end) {
    return { ok: false, error: 'The sending window must end after it starts.' }
  }

  const stopTags = asStringArray(b.stop_tag_ids)
  if (stopTags === null || stopTags.some((id) => !UUID_RE.test(id))) {
    return { ok: false, error: 'Stop tags are invalid.' }
  }

  const fallback = asString(b.name_fallback).trim()
  if (!fallback || fallback.length > 40) {
    return { ok: false, error: 'Enter a short fallback name (used when a contact has no first name).' }
  }

  return {
    ok: true,
    value: {
      timezone,
      send_window_enabled: b.send_window_enabled !== false,
      window_start_min: start,
      window_end_min: end,
      stop_tag_ids: stopTags,
      name_fallback: fallback,
    },
  }
}
