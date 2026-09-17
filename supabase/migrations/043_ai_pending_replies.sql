-- ============================================================
-- 043_ai_pending_replies
--
-- The AI auto-reply debounce (src/lib/ai/inbound-buffer.ts) schedules
-- a reply with an in-process `setTimeout`, purely in memory. If the
-- Node process restarts for ANY reason — a crash, a redeploy, the host
-- rebooting — before that timer fires, the scheduled reply is gone
-- with no trace: the customer's message just never gets answered, and
-- nothing ever retries it since a fresh inbound message is the only
-- thing that re-triggers the bot.
--
-- This table is a durable shadow of "there is a reply due soon for
-- this conversation." `scheduleAiAutoReply` upserts a row when it
-- arms the in-memory timer and deletes it once the timer actually
-- fires; `recoverPendingAiReplies` (called once at process boot, see
-- src/instrumentation.ts) picks up anything left over from a restart
-- that happened mid-debounce and dispatches it immediately.
--
-- Service-role only — the webhook path has no signed-in user, and no
-- client ever needs to read or write this directly. RLS is enabled
-- with zero policies, so it's fully locked down for `authenticated`/
-- `anon` and only reachable via the service role, which bypasses RLS.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_pending_replies (
  conversation_id      uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  config_owner_user_id uuid NOT NULL,
  due_at               timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_pending_replies_due_at_idx
  ON ai_pending_replies (due_at);

ALTER TABLE ai_pending_replies ENABLE ROW LEVEL SECURITY;
-- No policies — every role except service_role is denied entirely.
