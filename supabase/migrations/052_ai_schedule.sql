-- ============================================================
-- 052_ai_schedule
--
-- Daily on/off schedule for the auto-reply bot: outside the configured
-- hours, an inbound message is left for a human exactly as if
-- auto_reply_enabled were off — no reply, no handoff, no alert, the
-- chat just sits in the inbox. Checked live against the clock on every
-- inbound message (src/lib/ai/auto-reply.ts), no scheduler/cron needed.
--
-- Mirrors followup_settings' window columns (migration 045): minutes
-- since local midnight in an IANA timezone, so it correctly follows any
-- DST changes in that zone rather than a fixed UTC offset.
--
-- schedule_enabled defaults to false — existing accounts are unaffected
-- until they opt in. Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS schedule_enabled   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_start_min  INTEGER NOT NULL DEFAULT 540  CHECK (schedule_start_min BETWEEN 0 AND 1439),
  ADD COLUMN IF NOT EXISTS schedule_end_min    INTEGER NOT NULL DEFAULT 1260 CHECK (schedule_end_min BETWEEN 1 AND 1440),
  ADD COLUMN IF NOT EXISTS schedule_timezone   TEXT    NOT NULL DEFAULT 'America/Mexico_City';
