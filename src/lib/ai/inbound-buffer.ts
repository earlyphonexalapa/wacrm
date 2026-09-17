import { supabaseAdmin } from './admin-client'
import { dispatchInboundToAiReply } from './auto-reply'

// ============================================================
// Debounce the AI auto-reply trigger per conversation.
//
// The webhook used to call `dispatchInboundToAiReply` once per inbound
// message, immediately. A customer typing "hola" / "informacion del
// curso" / "porfavor" as three separate bubbles fired three separate
// LLM calls — each one racing to reply before the next bubble arrived,
// producing 2-3 disjointed bot messages instead of one reply to the
// whole thought.
//
// Fix: wait for a short quiet period after the LAST inbound message on
// a conversation before dispatching. `dispatchInboundToAiReply` re-reads
// everything (conversation state, message history) from the DB when it
// actually runs, so delaying it is safe — by the time the timer fires,
// `buildConversationContext` naturally picks up every message that
// arrived during the wait as consecutive customer turns (which the
// provider adapters already merge into one), and the eligibility gates
// (assigned agent, handoff, reply cap) are re-checked against current
// state rather than a stale snapshot.
//
// In-memory only for the fast path: this assumes a single running
// instance (true for the standard Docker/Easypanel deployment — one
// `node server.js` process). Scaling to multiple replicas would need
// this coordination moved fully to the database.
//
// A restart mid-debounce would otherwise lose the scheduled reply
// silently (the timer just disappears with the process, and nothing
// else ever re-triggers it since only a fresh inbound message does).
// To survive that, every scheduled reply is also shadowed in the
// `ai_pending_replies` table; `recoverPendingAiReplies` (called once
// at process boot — see src/instrumentation.ts) picks up anything left
// over from a restart that happened before its timer fired.
// ============================================================

const DEBOUNCE_MS = Number(process.env.AI_AUTO_REPLY_DEBOUNCE_MS) || 6000

type DispatchArgs = Parameters<typeof dispatchInboundToAiReply>[0]

interface PendingReply {
  timer: ReturnType<typeof setTimeout>
  args: DispatchArgs
}

const pending = new Map<string, PendingReply>()

/**
 * Schedule (or reschedule) the AI auto-reply for a conversation. Each
 * call restarts the wait, so a burst of inbound messages collapses into
 * exactly one dispatch, fired `DEBOUNCE_MS` after the last one lands.
 */
export function scheduleAiAutoReply(args: DispatchArgs): void {
  const existing = pending.get(args.conversationId)
  if (existing) clearTimeout(existing.timer)

  // Persist the "due soon" marker before arming the timer, so a crash
  // in the gap between this call and the timer firing still leaves a
  // recoverable row. Fire-and-forget — a failure here degrades back to
  // today's in-memory-only behavior, not a lost reply on the happy path.
  void supabaseAdmin()
    .from('ai_pending_replies')
    .upsert(
      {
        conversation_id: args.conversationId,
        account_id: args.accountId,
        contact_id: args.contactId,
        config_owner_user_id: args.configOwnerUserId,
        due_at: new Date(Date.now() + DEBOUNCE_MS).toISOString(),
      },
      { onConflict: 'conversation_id' },
    )
    .then(({ error }) => {
      if (error) {
        console.error('[ai auto-reply] failed to persist pending reply:', error)
      }
    })

  const timer = setTimeout(() => {
    pending.delete(args.conversationId)
    void clearPendingRow(args.conversationId)
    void dispatchInboundToAiReply(args)
  }, DEBOUNCE_MS)

  // Don't let a pending debounce keep the Node process alive on its
  // own (matters for graceful shutdown / test runs).
  timer.unref?.()

  pending.set(args.conversationId, { timer, args })
}

async function clearPendingRow(conversationId: string): Promise<void> {
  try {
    await supabaseAdmin()
      .from('ai_pending_replies')
      .delete()
      .eq('conversation_id', conversationId)
  } catch (err) {
    console.error('[ai auto-reply] failed to clear pending reply row:', err)
  }
}

/**
 * Recover replies that were scheduled but never fired because the
 * process restarted before their debounce window elapsed. Meant to be
 * called exactly once, at server boot (src/instrumentation.ts).
 *
 * Fires every recovered row immediately rather than waiting out its
 * remaining debounce — restarts are rare, and `dispatchInboundToAiReply`
 * re-checks every eligibility gate fresh from the DB, so dispatching a
 * few seconds early is harmless even if a human already took over in
 * the meantime.
 */
export async function recoverPendingAiReplies(): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: rows, error } = await db.from('ai_pending_replies').select('*')
    if (error) {
      console.error('[ai auto-reply] recoverPendingAiReplies query failed:', error)
      return
    }
    if (!rows || rows.length === 0) return

    console.warn(
      `[ai auto-reply] recovering ${rows.length} pending repl${rows.length === 1 ? 'y' : 'ies'} left over from a restart`,
    )
    for (const row of rows as Array<{
      conversation_id: string
      account_id: string
      contact_id: string
      config_owner_user_id: string
    }>) {
      // Clear first — dispatch has its own try/catch and never throws,
      // but clearing up front means a hard crash mid-dispatch can't
      // loop this same row forever on the next boot.
      await db.from('ai_pending_replies').delete().eq('conversation_id', row.conversation_id)
      void dispatchInboundToAiReply({
        accountId: row.account_id,
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        configOwnerUserId: row.config_owner_user_id,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] recoverPendingAiReplies failed:', err)
  }
}

/** Test-only: clear all pending timers so suites don't leak across each other. */
export function _resetPendingForTests(): void {
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
}
