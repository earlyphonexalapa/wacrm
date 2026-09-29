-- ============================================================
-- 053_meta_capi_attribution
--
-- Meta Conversions API attribution for click-to-WhatsApp ads. The
-- WhatsApp Business *app* has a "share data with Meta Ads" toggle that
-- attributes in-chat purchases back to the ad that started the
-- conversation; the Cloud API (which wacrm uses exclusively) has no
-- equivalent, so accounts lose that attribution when they migrate off
-- the app.
--
-- This restores it without any native Meta feature: the webhook
-- already captures `ctwa_clid` from a click-to-WhatsApp ad's referral
-- object on first contact (added ahead of a tracked migration in
-- commit cd7e8e1 — formalized here as an idempotent column add). When
-- the "Pagado" tag is added to that contact, src/lib/contacts/
-- capi-attribution.ts sends a Purchase event to Meta's Conversions API
-- using the dataset/token below, mirroring what the native app does
-- automatically.
--
-- Idempotent — safe to re-run, including on databases where the ctwa_*
-- columns already exist from the untracked manual change.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid          TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_ad_source_id  TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_captured_at   TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS capi_access_token TEXT,
  ADD COLUMN IF NOT EXISTS capi_dataset_id   TEXT;
