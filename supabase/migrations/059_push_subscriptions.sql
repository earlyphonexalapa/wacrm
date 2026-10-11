-- ============================================================
-- 059_push_subscriptions
--
-- Web Push for the installable app (PWA). Every phone / browser that turns
-- on notifications stores its push subscription here, one row per device
-- (the endpoint is unique per device + browser). The WhatsApp webhook reads
-- these with the service role and sends a push for every new inbound
-- message, so an agent with the app on their iPhone home screen gets a
-- WhatsApp-style banner even with the app closed.
--
-- A user only ever sees and manages their own devices. The server prunes a
-- row when the push service answers 404/410 (the device unsubscribed or the
-- app was removed from the home screen).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx
  ON push_subscriptions (account_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (user_id = (SELECT auth.uid()));

-- Inserts and updates go through /api/push/subscribe with the service role,
-- which stamps user_id / account_id from the session — no client write policy.
