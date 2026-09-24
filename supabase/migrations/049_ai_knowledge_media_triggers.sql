-- ============================================================
-- 049_ai_knowledge_media_triggers
--
-- Lets a knowledge-base document keep its attachments (images / PDFs)
-- behind trigger words: the bot sends them ONLY when the customer's own
-- message contains one of these words (whole word, case- and
-- accent-insensitive, plural allowed) — never through the fuzzy
-- full-text match that used to attach e.g. the testimonial screenshots
-- to a bare "Si".
--
-- Empty array (the default) = the document behaves as before.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS media_triggers TEXT[] NOT NULL DEFAULT '{}';
