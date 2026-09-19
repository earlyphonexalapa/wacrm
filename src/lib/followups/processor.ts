import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { evaluateFollowup } from './evaluate'
import { loadFollowupSettings, SEQUENCE_SELECT, toSequence } from './store'
import { sendFollowupStep } from './send'
import { buildVars, MINUTE_MS, pickDelayMs } from './timing'
import type { FollowupSequence, FollowupSettings, SendStatus } from './types'

// ============================================================
// The worker: finds enrollments whose next step is due, re-checks every
// rule against CURRENT data (see evaluate.ts), and sends / defers /
// skips / cancels. Safe to run from several workers at once — each due
// row is claimed with an atomic lease, and an expired lease (a worker
// that died mid-send) just makes the row claimable again.
// ============================================================

const BATCH_SIZE = 25
const LEASE_MS = 3 * MINUTE_MS
const MAX_SEND_ATTEMPTS = 3
/** Retry backoff: attempt n waits n × this. */
const RETRY_STEP_MS = 5 * MINUTE_MS
/** Never fire two follow-ups for one lead closer together than this,
 *  even if a deferral overnight made several come due at once. */
const MIN_GAP_MS = 30 * MINUTE_MS
/** Spread deferred sends after the window opens so they don't all
 *  land on 09:00:00. */
const DEFER_JITTER_MINUTES = 15

interface EnrollmentRow {
  id: string
  account_id: string
  sequence_id: string
  contact_id: string
  conversation_id: string
  enrolled_at: string
  next_step_position: number
  attempts: number
}

export interface ProcessResult {
  claimed: number
  sent: number
  skipped: number
  deferred: number
  cancelled: number
  failed: number
}

export async function processDueFollowups(opts?: {
  db?: SupabaseClient
  now?: Date
  batchSize?: number
}): Promise<ProcessResult> {
  const db = opts?.db ?? supabaseAdmin()
  const now = opts?.now ?? new Date()
  const nowIso = now.toISOString()
  const result: ProcessResult = { claimed: 0, sent: 0, skipped: 0, deferred: 0, cancelled: 0, failed: 0 }

  const { data: due, error } = await db
    .from('followup_enrollments')
    .select('id')
    .eq('status', 'active')
    .lte('next_run_at', nowIso)
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .order('next_run_at', { ascending: true })
    .limit(opts?.batchSize ?? BATCH_SIZE)
  if (error) {
    console.error('[followups] due query failed:', error)
    return result
  }

  const sequenceCache = new Map<string, FollowupSequence | null>()
  const settingsCache = new Map<string, FollowupSettings>()

  for (const { id } of (due ?? []) as { id: string }[]) {
    // Atomic claim: only one worker wins the UPDATE.
    const { data: row } = await db
      .from('followup_enrollments')
      .update({ locked_until: new Date(now.getTime() + LEASE_MS).toISOString() })
      .eq('id', id)
      .eq('status', 'active')
      .lte('next_run_at', nowIso)
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .select('id, account_id, sequence_id, contact_id, conversation_id, enrolled_at, next_step_position, attempts')
      .maybeSingle()
    if (!row) continue
    result.claimed++

    try {
      await processOne(db, row as EnrollmentRow, now, sequenceCache, settingsCache, result)
    } catch (err) {
      // Unexpected: keep the enrollment alive and try again shortly
      // rather than losing it or hot-looping on it.
      console.error('[followups] processing failed for enrollment', id, err)
      result.failed++
      await db
        .from('followup_enrollments')
        .update({
          locked_until: null,
          next_run_at: new Date(now.getTime() + RETRY_STEP_MS).toISOString(),
        })
        .eq('id', id)
    }
  }

  return result
}

async function logSend(
  db: SupabaseClient,
  row: EnrollmentRow,
  position: number,
  status: SendStatus,
  detail: string | null,
  whatsappMessageId?: string,
): Promise<void> {
  const { error } = await db.from('followup_sends').insert({
    account_id: row.account_id,
    enrollment_id: row.id,
    sequence_id: row.sequence_id,
    contact_id: row.contact_id,
    step_position: position,
    status,
    detail,
    whatsapp_message_id: whatsappMessageId ?? null,
  })
  if (error) console.error('[followups] log insert failed:', error)
}

async function processOne(
  db: SupabaseClient,
  row: EnrollmentRow,
  now: Date,
  sequenceCache: Map<string, FollowupSequence | null>,
  settingsCache: Map<string, FollowupSettings>,
  result: ProcessResult,
): Promise<void> {
  const cancel = async (reason: string) => {
    await db
      .from('followup_enrollments')
      .update({ status: 'cancelled', cancel_reason: reason, ended_at: now.toISOString(), locked_until: null })
      .eq('id', row.id)
    result.cancelled++
  }

  // ---- load facts ---------------------------------------------------
  let sequence = sequenceCache.get(row.sequence_id)
  if (sequence === undefined) {
    const { data } = await db.from('followup_sequences').select(SEQUENCE_SELECT).eq('id', row.sequence_id).maybeSingle()
    sequence = data ? toSequence(data as unknown as Parameters<typeof toSequence>[0]) : null
    sequenceCache.set(row.sequence_id, sequence)
  }
  if (!sequence) return cancel('sequence_disabled')

  let settings = settingsCache.get(row.account_id)
  if (!settings) {
    settings = await loadFollowupSettings(db, row.account_id)
    settingsCache.set(row.account_id, settings)
  }

  const step = sequence.steps.find((s) => s.position === row.next_step_position)
  if (!step) {
    // Steps were edited away underneath a live run — nothing left to send.
    await db
      .from('followup_enrollments')
      .update({ status: 'completed', ended_at: now.toISOString(), locked_until: null })
      .eq('id', row.id)
    return
  }

  const [contactRes, convRes, tagsRes, lastInboundRes] = await Promise.all([
    db.from('contacts').select('name').eq('id', row.contact_id).maybeSingle(),
    db.from('conversations').select('assigned_agent_id, ai_autoreply_disabled').eq('id', row.conversation_id).maybeSingle(),
    db.from('contact_tags').select('tag_id').eq('contact_id', row.contact_id),
    db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', row.conversation_id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const tagIds = new Set(((tagsRes.data ?? []) as { tag_id: string }[]).map((t) => t.tag_id))
  const stopIds = new Set([...sequence.stop_tag_ids, ...settings.stop_tag_ids])
  const conv = convRes.data as { assigned_agent_id: string | null; ai_autoreply_disabled: boolean } | null
  const lastInbound = (lastInboundRes.data as { created_at: string } | null)?.created_at

  // ---- decide -------------------------------------------------------
  const decision = evaluateFollowup({
    now,
    sequenceActive: sequence.is_active,
    hasTriggerTag: tagIds.has(sequence.trigger_tag_id),
    presentStopTagIds: [...stopIds].filter((id) => tagIds.has(id)),
    lastCustomerAt: lastInbound ? new Date(lastInbound) : null,
    enrolledAt: new Date(row.enrolled_at),
    humanOwned: Boolean(conv?.assigned_agent_id) || Boolean(conv?.ai_autoreply_disabled),
    stepType: step.message_type,
    settings,
  })

  // ---- act ----------------------------------------------------------
  if (decision.action === 'cancel') return cancel(decision.reason)

  if (decision.action === 'defer') {
    const jitter = Math.floor(Math.random() * (DEFER_JITTER_MINUTES + 1)) * MINUTE_MS
    await db
      .from('followup_enrollments')
      .update({ next_run_at: new Date(decision.until.getTime() + jitter).toISOString(), locked_until: null })
      .eq('id', row.id)
    result.deferred++
    return
  }

  if (decision.action === 'skip') {
    await logSend(db, row, step.position, 'skipped', 'The 24h customer window had closed — free-form messages can no longer be sent. Use a template for late follow-ups.')
    result.skipped++
    return advance(db, row, sequence, step.position, now, false)
  }

  // send
  try {
    const { whatsapp_message_id } = await sendFollowupStep({
      accountId: row.account_id,
      userId: sequence.created_by ?? '',
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      step,
      vars: buildVars((contactRes.data as { name: string | null } | null)?.name, settings.name_fallback),
    })
    await logSend(db, row, step.position, 'sent', null, whatsapp_message_id)
    result.sent++
    return advance(db, row, sequence, step.position, now, true)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const attempt = row.attempts + 1
    await logSend(db, row, step.position, 'failed', `Attempt ${attempt}/${MAX_SEND_ATTEMPTS}: ${message}`)
    result.failed++
    if (attempt < MAX_SEND_ATTEMPTS) {
      await db
        .from('followup_enrollments')
        .update({
          attempts: attempt,
          next_run_at: new Date(now.getTime() + attempt * RETRY_STEP_MS).toISOString(),
          locked_until: null,
        })
        .eq('id', row.id)
      return
    }
    // Out of attempts: give up on THIS step, keep the rest of the sequence.
    return advance(db, row, sequence, step.position, now, false)
  }
}

/** Move to the next step (or finish the sequence). */
async function advance(
  db: SupabaseClient,
  row: EnrollmentRow,
  sequence: FollowupSequence,
  handledPosition: number,
  now: Date,
  sent: boolean,
): Promise<void> {
  const next = sequence.steps.find((s) => s.position > handledPosition)
  const sentPatch = sent ? { last_sent_at: now.toISOString() } : {}

  if (!next) {
    await db
      .from('followup_enrollments')
      .update({ status: 'completed', ended_at: now.toISOString(), locked_until: null, attempts: 0, ...sentPatch })
      .eq('id', row.id)
    return
  }

  // Waits are counted from enrollment; the floor keeps a backlog (e.g.
  // after an overnight deferral) from bunching messages together.
  const target = new Date(row.enrolled_at).getTime() + pickDelayMs(next.delay_min_minutes, next.delay_max_minutes)
  const runAt = Math.max(target, now.getTime() + MIN_GAP_MS)
  await db
    .from('followup_enrollments')
    .update({
      next_step_position: next.position,
      next_run_at: new Date(runAt).toISOString(),
      attempts: 0,
      locked_until: null,
      ...sentPatch,
    })
    .eq('id', row.id)
}
