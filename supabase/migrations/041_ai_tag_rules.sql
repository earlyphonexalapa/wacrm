-- ============================================================
-- 041_ai_tag_rules
--
-- Lets the AI auto-reply bot classify a lead by applying one of the
-- account's own tags (e.g. "Calificado" / "No calificado") once it has
-- enough conversation context, instead of only ever replying in text.
--
-- Each row is an admin-authored rule: "when the conversation looks like
-- <description>, apply <tag_id>." The bot picks at most one rule per
-- turn (see src/lib/ai/tagging.ts) and applies it through the same
-- `contact_tags` write path a human uses from the inbox, so anything
-- already wired to a tag being added (the `tag_added` automation
-- trigger — src/lib/contacts/tag-events.ts) fires exactly the same way
-- for an AI-applied tag as for a manual one.
--
-- One rule per (account, tag): re-adding a description overwrites, it
-- doesn't duplicate.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_tag_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, tag_id)
);

CREATE INDEX IF NOT EXISTS ai_tag_rules_account_id_idx
  ON ai_tag_rules (account_id);

ALTER TABLE ai_tag_rules ENABLE ROW LEVEL SECURITY;

-- Mirrors ai_knowledge_documents (migration 030): any member reads,
-- only admin+ writes. The auto-reply bot reads via the service role,
-- which bypasses RLS entirely.
DROP POLICY IF EXISTS ai_tag_rules_select ON ai_tag_rules;
CREATE POLICY ai_tag_rules_select ON ai_tag_rules FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_tag_rules_insert ON ai_tag_rules;
CREATE POLICY ai_tag_rules_insert ON ai_tag_rules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_tag_rules_update ON ai_tag_rules;
CREATE POLICY ai_tag_rules_update ON ai_tag_rules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_tag_rules_delete ON ai_tag_rules;
CREATE POLICY ai_tag_rules_delete ON ai_tag_rules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_tag_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_tag_rules_updated_at ON ai_tag_rules;
CREATE TRIGGER ai_tag_rules_updated_at
  BEFORE UPDATE ON ai_tag_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_tag_rules_updated_at();
