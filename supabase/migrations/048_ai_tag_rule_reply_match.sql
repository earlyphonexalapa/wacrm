-- ============================================================
-- 048_ai_tag_rule_reply_match
--
-- Lets an AI tagging rule apply its tag deterministically: when the
-- reply the bot actually sent contains any of `reply_contains`
-- (case-insensitive substring), the tag is applied — no reliance on the
-- model remembering to append a marker. Meant for conditions that are a
-- plain fact about the reply, e.g. "the bot quoted the price" →
-- reply_contains = {'1197', '1,197'}.
--
-- Empty array (the default) = model-driven only, exactly as before.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_tag_rules
  ADD COLUMN IF NOT EXISTS reply_contains TEXT[] NOT NULL DEFAULT '{}';
