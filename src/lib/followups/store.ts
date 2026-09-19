import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_FOLLOWUP_SETTINGS,
  type FollowupSequence,
  type FollowupSettings,
  type FollowupStep,
} from './types'
import type { SequenceInput } from './validate'

// ============================================================
// Config persistence (settings, sequences, steps). Works with either
// the RLS-scoped client (API routes) or the service role (engine) —
// the caller decides; every query is scoped by account_id regardless.
// ============================================================

interface SequenceRow {
  id: string
  account_id: string
  name: string
  description: string | null
  trigger_tag_id: string
  stop_tag_ids: string[] | null
  is_active: boolean
  position: number
  created_by: string | null
  followup_steps?: StepRow[] | null
}

interface StepRow {
  id: string
  position: number
  delay_min_minutes: number
  delay_max_minutes: number
  message_type: 'text' | 'template'
  message_text: string | null
  template_name: string | null
  template_language: string | null
  template_variables: unknown
}

function toStep(row: StepRow): FollowupStep {
  return {
    id: row.id,
    position: row.position,
    delay_min_minutes: row.delay_min_minutes,
    delay_max_minutes: row.delay_max_minutes,
    message_type: row.message_type,
    message_text: row.message_text,
    template_name: row.template_name,
    template_language: row.template_language,
    template_variables: Array.isArray(row.template_variables)
      ? (row.template_variables as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
  }
}

export function toSequence(row: SequenceRow): FollowupSequence {
  return {
    id: row.id,
    account_id: row.account_id,
    name: row.name,
    description: row.description,
    trigger_tag_id: row.trigger_tag_id,
    stop_tag_ids: row.stop_tag_ids ?? [],
    is_active: row.is_active,
    position: row.position,
    created_by: row.created_by,
    steps: (row.followup_steps ?? []).map(toStep).sort((a, b) => a.position - b.position),
  }
}

export const SEQUENCE_SELECT =
  'id, account_id, name, description, trigger_tag_id, stop_tag_ids, is_active, position, created_by, followup_steps(id, position, delay_min_minutes, delay_max_minutes, message_type, message_text, template_name, template_language, template_variables)'

export async function loadFollowupSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<FollowupSettings> {
  const { data } = await db
    .from('followup_settings')
    .select('timezone, send_window_enabled, window_start_min, window_end_min, stop_tag_ids, name_fallback')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) return { ...DEFAULT_FOLLOWUP_SETTINGS }
  return {
    timezone: data.timezone,
    send_window_enabled: data.send_window_enabled,
    window_start_min: data.window_start_min,
    window_end_min: data.window_end_min,
    stop_tag_ids: data.stop_tag_ids ?? [],
    name_fallback: data.name_fallback,
  }
}

export async function saveFollowupSettings(
  db: SupabaseClient,
  accountId: string,
  settings: FollowupSettings,
): Promise<void> {
  const { error } = await db
    .from('followup_settings')
    .upsert({ account_id: accountId, ...settings }, { onConflict: 'account_id' })
  if (error) throw error
}

export async function loadSequences(
  db: SupabaseClient,
  accountId: string,
): Promise<FollowupSequence[]> {
  const { data, error } = await db
    .from('followup_sequences')
    .select(SEQUENCE_SELECT)
    .eq('account_id', accountId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as unknown as SequenceRow[]).map(toSequence)
}

export async function loadSequence(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<FollowupSequence | null> {
  const { data, error } = await db
    .from('followup_sequences')
    .select(SEQUENCE_SELECT)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data ? toSequence(data as unknown as SequenceRow) : null
}

async function replaceSteps(
  db: SupabaseClient,
  accountId: string,
  sequenceId: string,
  steps: FollowupStep[],
): Promise<void> {
  const { error: delErr } = await db.from('followup_steps').delete().eq('sequence_id', sequenceId)
  if (delErr) throw delErr
  const rows = steps.map((s) => ({
    sequence_id: sequenceId,
    account_id: accountId,
    position: s.position,
    delay_min_minutes: s.delay_min_minutes,
    delay_max_minutes: s.delay_max_minutes,
    message_type: s.message_type,
    message_text: s.message_text,
    template_name: s.template_name,
    template_language: s.template_language,
    template_variables: s.template_variables,
  }))
  const { error } = await db.from('followup_steps').insert(rows)
  if (error) throw error
}

export async function createSequence(
  db: SupabaseClient,
  accountId: string,
  userId: string | null,
  input: SequenceInput,
): Promise<string> {
  const { data: last } = await db
    .from('followup_sequences')
    .select('position')
    .eq('account_id', accountId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data, error } = await db
    .from('followup_sequences')
    .insert({
      account_id: accountId,
      created_by: userId,
      name: input.name,
      description: input.description,
      trigger_tag_id: input.trigger_tag_id,
      stop_tag_ids: input.stop_tag_ids,
      is_active: input.is_active,
      position: (last?.position ?? -1) + 1,
    })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('insert returned no row')

  try {
    await replaceSteps(db, accountId, data.id, input.steps)
  } catch (err) {
    // Don't leave a step-less sequence behind.
    await db.from('followup_sequences').delete().eq('id', data.id)
    throw err
  }
  return data.id
}

export async function updateSequence(
  db: SupabaseClient,
  accountId: string,
  id: string,
  input: SequenceInput,
): Promise<boolean> {
  const { data, error } = await db
    .from('followup_sequences')
    .update({
      name: input.name,
      description: input.description,
      trigger_tag_id: input.trigger_tag_id,
      stop_tag_ids: input.stop_tag_ids,
      is_active: input.is_active,
    })
    .eq('account_id', accountId)
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) throw error
  if (!data) return false
  await replaceSteps(db, accountId, id, input.steps)
  return true
}
