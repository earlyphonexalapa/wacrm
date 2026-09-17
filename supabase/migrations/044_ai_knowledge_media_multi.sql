-- ============================================================
-- 044_ai_knowledge_media_multi
--
-- Migration 040 gave a knowledge-base document a single optional image
-- (media_url/media_type columns on ai_knowledge_documents). This
-- replaces that with a proper child table so a document can carry up
-- to 5 attachments — any mix of images and PDFs — sent together as a
-- batch of separate WhatsApp messages alongside the bot's text reply
-- (see src/lib/ai/knowledge.ts findKnowledgeMedia and
-- src/lib/ai/auto-reply.ts). The 5-item cap and the image/PDF type
-- check are enforced in the API route, not here — same pattern as the
-- interactive-message limits in src/lib/whatsapp/meta-api.ts.
--
-- Any document that already had a single media_url (from 040) is
-- backfilled into this table as its one attachment before those
-- columns are dropped.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_knowledge_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  -- Denormalized off the document, same reasoning as ai_knowledge_chunks.account_id:
  -- lets findKnowledgeMedia's cheap early-out COUNT and RLS both skip a join.
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  media_url   text NOT NULL,
  media_type  text NOT NULL,
  -- Send order when a document has more than one attachment.
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_media_document_id_idx
  ON ai_knowledge_media (document_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_media_account_id_idx
  ON ai_knowledge_media (account_id);

ALTER TABLE ai_knowledge_media ENABLE ROW LEVEL SECURITY;

-- Mirrors ai_knowledge_documents (migration 030): any member reads,
-- only admin+ writes.
DROP POLICY IF EXISTS ai_knowledge_media_select ON ai_knowledge_media;
CREATE POLICY ai_knowledge_media_select ON ai_knowledge_media FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_knowledge_media_insert ON ai_knowledge_media;
CREATE POLICY ai_knowledge_media_insert ON ai_knowledge_media FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_media_update ON ai_knowledge_media;
CREATE POLICY ai_knowledge_media_update ON ai_knowledge_media FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_media_delete ON ai_knowledge_media;
CREATE POLICY ai_knowledge_media_delete ON ai_knowledge_media FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Backfill: carry forward any single image already attached under 040.
INSERT INTO ai_knowledge_media (document_id, account_id, media_url, media_type, position)
SELECT d.id, d.account_id, d.media_url, d.media_type, 0
FROM ai_knowledge_documents d
WHERE d.media_url IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE ai_knowledge_documents DROP COLUMN IF EXISTS media_url;
ALTER TABLE ai_knowledge_documents DROP COLUMN IF EXISTS media_type;
