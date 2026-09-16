-- ============================================================
-- 040_ai_knowledge_media
--
-- The AI auto-reply bot could only ever answer in text — even a
-- knowledge base entry that IS a picture (a price list, a course
-- flyer, a map) had nowhere to put the image, so the bot could
-- describe it in words at best.
--
-- This lets a knowledge base document optionally carry an image
-- alongside its text: `media_url` is a `chat-media` bucket URL (same
-- bucket + upload path the inbox composer already uses, migration 023),
-- `media_type` is its MIME type. Both NULL for a plain text document —
-- the existing FAQ/policy documents are unaffected.
--
-- The document's `content` stays the retrieval target (still chunked +
-- searched exactly as before): when the customer's message matches an
-- image-backed document, the auto-reply bot sends that image alongside
-- its text reply. See `findKnowledgeMedia` in src/lib/ai/knowledge.ts.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_type text;

COMMENT ON COLUMN ai_knowledge_documents.media_url IS
  'Optional chat-media bucket URL. When set, the auto-reply bot sends '
  'this image alongside its text reply whenever this document is the '
  'best knowledge-base match for the customer''s message.';

COMMENT ON COLUMN ai_knowledge_documents.media_type IS
  'MIME type of media_url''s content. NULL when the document has no '
  'attached image.';
