import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadFollowupSettings } from './store'
import { pickDelayMs } from './timing'

// ============================================================
// Enrollment + cancellation — the two touchpoints the rest of the app
// has with follow-ups:
//
//   onContactTagAdded   called when a tag is newly applied to a contact
//                       (manual, API, flows, automations, the AI bot)
//   cancelFollowupsOnInbound   called when the contact writes to us
//
// Both are best-effort by contract: they swallow their own errors,
// because a follow-up problem must never affect tagging or the inbound
// webhook (or the AI bot that triggers them).
// ============================================================

interface SequenceForTag {
  id: string
  stop_tag_ids: string[] | null
  followup_steps: { position: number; delay_min_minutes: number; delay_max_minutes: number }[] | null
}

async function contactTagIds(db: SupabaseClient, contactId: string): Promise<string[]> {
  const { data } = await db.from('contact_tags').select('tag_id').eq('contact_id', contactId)
  return ((data ?? []) as { tag_id: string }[]).map((r) => r.tag_id)
}

/**
 * A tag was just added to a contact: (1) cancel any live follow-ups that
 * this tag is a stop signal for (the lead moved to a later phase), then
 * (2) enroll the contact in every active sequence triggered by it.
 */
export async function onContactTagAdded(input: {
  accountId: string
  contactId: string
  tagId: string
}): Promise<void> {
  try {
    const db = supabaseAdmin()
    const settings = await loadFollowupSettings(db, input.accountId)

    await cancelForStopTag(db, input, settings.stop_tag_ids)
    await enrollForTrigger(db, input, settings.stop_tag_ids)
  } catch (err) {
    console.error('[followups] onContactTagAdded failed:', err)
  }
}

async function cancelForStopTag(
  db: SupabaseClient,
  input: { accountId: string; contactId: string; tagId: string },
  globalStopTagIds: string[],
): Promise<void> {
  const { data } = await db
    .from('followup_enrollments')
    .select('id, followup_sequences(stop_tag_ids)')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('status', 'active')
  const rows = (data ?? []) as unknown as {
    id: string
    followup_sequences: { stop_tag_ids: string[] | null } | { stop_tag_ids: string[] | null }[] | null
  }[]
  if (rows.length === 0) return

  const globalHit = globalStopTagIds.includes(input.tagId)
  const ids = rows
    .filter((r) => {
      if (globalHit) return true
      const seq = Array.isArray(r.followup_sequences) ? r.followup_sequences[0] : r.followup_sequences
      return (seq?.stop_tag_ids ?? []).includes(input.tagId)
    })
    .map((r) => r.id)
  if (ids.length === 0) return

  await db
    .from('followup_enrollments')
    .update({
      status: 'cancelled',
      cancel_reason: 'stop_tag',
      ended_at: new Date().toISOString(),
      locked_until: null,
    })
    .in('id', ids)
    .eq('status', 'active')
}

async function enrollForTrigger(
  db: SupabaseClient,
  input: { accountId: string; contactId: string; tagId: string },
  globalStopTagIds: string[],
): Promise<void> {
  const { data: seqData } = await db
    .from('followup_sequences')
    .select('id, stop_tag_ids, followup_steps(position, delay_min_minutes, delay_max_minutes)')
    .eq('account_id', input.accountId)
    .eq('trigger_tag_id', input.tagId)
    .eq('is_active', true)
  const sequences = (seqData ?? []) as unknown as SequenceForTag[]
  if (sequences.length === 0) return

  // Resolved once: the contact's thread (a follow-up needs somewhere to
  // land) and their current tags (an already-excluded lead never enrolls).
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!conv) return
  const tags = await contactTagIds(db, input.contactId)

  const now = new Date()
  for (const seq of sequences) {
    const stops = new Set([...(seq.stop_tag_ids ?? []), ...globalStopTagIds])
    if (tags.some((t) => stops.has(t))) continue

    const first = [...(seq.followup_steps ?? [])].sort((a, b) => a.position - b.position)[0]
    if (!first) continue

    const { error } = await db.from('followup_enrollments').insert({
      account_id: input.accountId,
      sequence_id: seq.id,
      contact_id: input.contactId,
      conversation_id: conv.id,
      enrolled_at: now.toISOString(),
      next_step_position: first.position,
      next_run_at: new Date(
        now.getTime() + pickDelayMs(first.delay_min_minutes, first.delay_max_minutes),
      ).toISOString(),
    })
    // 23505 = already running this sequence for this contact — exactly
    // what the unique index is there to guarantee. Anything else is real.
    if (error && error.code !== '23505') {
      console.error('[followups] enroll insert failed:', error)
    }
  }
}

/**
 * The contact wrote to us: cancel whatever follow-ups are still pending.
 * The send-time check would catch this too — cancelling here just makes
 * the Activity view accurate immediately.
 */
export async function cancelFollowupsOnInbound(input: {
  accountId: string
  contactId: string
}): Promise<void> {
  try {
    const db = supabaseAdmin()
    await db
      .from('followup_enrollments')
      .update({
        status: 'cancelled',
        cancel_reason: 'replied',
        ended_at: new Date().toISOString(),
        locked_until: null,
      })
      .eq('account_id', input.accountId)
      .eq('contact_id', input.contactId)
      .eq('status', 'active')
  } catch (err) {
    console.error('[followups] cancelFollowupsOnInbound failed:', err)
  }
}
