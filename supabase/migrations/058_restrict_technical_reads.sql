-- ============================================================
-- 058_restrict_technical_reads
--
-- API keys and outgoing-webhook endpoints (which hold the key hashes and the
-- encrypted signing secrets) were readable by every member of the account at
-- the database level. Only admins and the owner manage them — the settings
-- screen, the /api/account/api-keys routes and the public API all either
-- require admin or use the service role, which ignores row-level security —
-- so reading is now restricted to admins and the owner as well.
--
-- Deliberately NOT changed: whatsapp_config and ai_configs. The Inbox reads
-- them for closers (the "WhatsApp not connected" banner and the AI banner on
-- each chat), so locking those would break the closers' own screen.
--
-- Idempotent — safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS api_keys_select ON api_keys;
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS webhook_endpoints_select ON webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON webhook_endpoints FOR SELECT
  USING (is_account_member(account_id, 'admin'));
