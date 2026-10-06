-- ============================================================
-- 057_performance_indexes
--
-- Indexes for the queries the app runs most. All CREATE INDEX IF NOT EXISTS:
-- nothing is dropped or changed, existing indexes stay, and the app behaves
-- the same — these only let Postgres find rows without scanning and sorting.
--
--   conversations (account_id, last_message_at DESC)
--       The Inbox asks for the account's chats newest-first. With this index
--       Postgres reads the first ~1,000 in order and stops, instead of
--       fetching every chat of the account and sorting them.
--
--   messages (conversation_id, created_at)
--       Opening a chat reads its messages oldest-first; the per-closer
--       dashboard joins messages to a closer's chats and filters by day.
--
--   contacts (account_id, created_at)
--       "New contacts" per day on the dashboard.
--
--   contact_tags (tag_id, created_at)
--       Counting "Lead Calificado" / "Pagado" assignments per day.
--
-- Building an index briefly blocks writes to that table; on a table this size
-- it takes a few seconds. Idempotent — safe to re-run.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON conversations (account_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_contacts_account_created
  ON contacts (account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_created
  ON contact_tags (tag_id, created_at);
