-- ============================================================
-- 060_whatsapp_coexistence
--
-- WhatsApp Business app + Cloud API on the same number ("coexistence"),
-- connected through Meta's Embedded Signup instead of a hand-typed token.
--
-- whatsapp_config gets the state the Settings screen and the webhook need:
--   coexistence                 the number is still used from the phone app
--   coexistence_onboarded_at    when Meta finished onboarding it
--   contacts_sync_requested_at  we asked Meta for the phone's contacts
--   history_sync_requested_at   we asked Meta for the last 180 days of chats
--   history_sync_status         none | requested | in_progress | complete |
--                               declined | failed
--   history_sync_progress       0-100, as Meta reports it chunk by chunk
--
-- Meta lets each sync be requested ONCE, within 24 hours of onboarding, so
-- the timestamps double as the record that it was already done.
--
-- Idempotent — safe to re-run. Nothing changes for numbers connected by hand.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS coexistence BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coexistence_onboarded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contacts_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_sync_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS history_sync_progress INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_history_sync_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_history_sync_status_check
      CHECK (history_sync_status IN ('none', 'requested', 'in_progress', 'complete', 'declined', 'failed'));
  END IF;
END $$;
