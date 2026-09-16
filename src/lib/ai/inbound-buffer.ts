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
// In-memory only: this assumes a single running instance (true for the
// standard Docker/Easypanel deployment — one `node server.js` process).
// Scaling to multiple replicas would need this coordination moved to
// the database (e.g. a `scheduled_at` column) instead of a process-local
// Map.
// ============================================================

const DEBOUNCE_MS = Number(process.env.AI_AUTO_REPLY_DEBOUNCE_MS) || 6000

interface PendingReply {
  timer: ReturnType<typeof setTimeout>
  args: Parameters<typeof dispatchInboundToAiReply>[0]
}

const pending = new Map<string, PendingReply>()

/**
 * Schedule (or reschedule) the AI auto-reply for a conversation. Each
 * call restarts the wait, so a burst of inbound messages collapses into
 * exactly one dispatch, fired `DEBOUNCE_MS` after the last one lands.
 */
export function scheduleAiAutoReply(
  args: Parameters<typeof dispatchInboundToAiReply>[0],
): void {
  const existing = pending.get(args.conversationId)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    pending.delete(args.conversationId)
    void dispatchInboundToAiReply(args)
  }, DEBOUNCE_MS)

  // Don't let a pending debounce keep the Node process alive on its own
  // (matters for graceful shutdown / test runs).
  timer.unref?.()

  pending.set(args.conversationId, { timer, args })
}

/** Test-only: clear all pending timers so suites don't leak across each other. */
export function _resetPendingForTests(): void {
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
}
