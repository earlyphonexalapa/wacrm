-- ============================================================
-- 046_handoff_whatsapp_alert
--
-- When the AI bot hands a conversation to a human, also alert the
-- closer on WhatsApp (on top of the in-app notification). The alert goes
-- as free text while the closer's own 24-hour customer-service window
-- with the business number is open, and as an approved UTILITY template
-- when it is closed.
--
-- Settings live on the account's single ai_configs row, so they inherit
-- its RLS (members read, admins write). Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handoff_whatsapp_phone TEXT,
  ADD COLUMN IF NOT EXISTS handoff_whatsapp_template_name TEXT,
  ADD COLUMN IF NOT EXISTS handoff_whatsapp_template_language TEXT,
  ADD COLUMN IF NOT EXISTS handoff_whatsapp_template_variables JSONB NOT NULL DEFAULT '[]'::jsonb;
