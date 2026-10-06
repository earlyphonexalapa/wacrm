-- ============================================================
-- 055_lead_routing
--
-- Automatic lead ownership for teams with several closers sharing ONE
-- WhatsApp number. A lead that arrives from a click-to-WhatsApp ad is
-- given to the closer who owns that ad's CAMPAIGN; anything else
-- (organic, direct messages) is spread evenly across the closers that
-- take organic leads.
--
-- Ownership lives in its own column, conversations.owner_agent_id, and
-- deliberately NOT in assigned_agent_id: the AI bot, the follow-up
-- sequences and the idle-reactivation job all treat "assigned" as "a
-- human has taken this thread" and go quiet. Owning a lead must not
-- silence the bot on the days the closer is off.
--
-- How the campaign is found: the webhook only carries the AD id; the
-- campaign is looked up through the Marketing API (needs an ads_read
-- token) and cached per ad in ad_campaign_cache.
--
-- Everything is off by default (lead_routing_settings.enabled = false).
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- ownership + campaign info on existing tables ---------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS owner_agent_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS owner_source      TEXT
    CHECK (owner_source IN ('campaign', 'unmatched_campaign', 'unresolved', 'organic', 'manual')),
  ADD COLUMN IF NOT EXISTS owner_assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_owner
  ON conversations (account_id, owner_agent_id)
  WHERE owner_agent_id IS NOT NULL;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_campaign_id   TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_campaign_name TEXT;

-- ---- settings ----------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_routing_settings (
  account_id       UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  -- AES-256-GCM, same scheme as whatsapp_config.access_token.
  ads_access_token TEXT,
  -- Last failed campaign lookup, shown in settings so an expired token
  -- is noticed instead of silently sending every lead to the organic pool.
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- the closers that receive leads ------------------------------

CREATE TABLE IF NOT EXISTS lead_routing_closers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- false = only gets the leads of the campaigns mapped to them.
  receives_organic BOOLEAN NOT NULL DEFAULT true,
  -- Drives the even spread of organic leads (least recently served first).
  last_assigned_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

-- ---- campaign -> closer rules -------------------------------------

CREATE TABLE IF NOT EXISTS lead_routing_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- campaign_id: exact campaign.  name_contains: whole-word match on the
  -- campaign name, so new / duplicated campaigns need no setup.
  kind        TEXT NOT NULL CHECK (kind IN ('campaign_id', 'name_contains')),
  match_value TEXT NOT NULL,
  -- Campaign name to show next to an id rule.
  match_label TEXT,
  closer_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_routing_rules_value
  ON lead_routing_rules (account_id, kind, lower(btrim(match_value)));

-- ---- ad -> campaign cache -----------------------------------------

CREATE TABLE IF NOT EXISTS ad_campaign_cache (
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_id         TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  campaign_name TEXT,
  resolved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, ad_id)
);

-- ---- RLS ------------------------------------------------------------
-- Settings hold a token: admins only. Closers and rules are readable by
-- every member (the inbox shows who owns what), writable by admins. The
-- cache is written only by the webhook (service role bypasses RLS).

ALTER TABLE lead_routing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_routing_closers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_routing_rules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_campaign_cache     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_routing_settings_select ON lead_routing_settings;
DROP POLICY IF EXISTS lead_routing_settings_write  ON lead_routing_settings;
CREATE POLICY lead_routing_settings_select ON lead_routing_settings
  FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY lead_routing_settings_write ON lead_routing_settings
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_routing_closers_select ON lead_routing_closers;
DROP POLICY IF EXISTS lead_routing_closers_write  ON lead_routing_closers;
CREATE POLICY lead_routing_closers_select ON lead_routing_closers
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY lead_routing_closers_write ON lead_routing_closers
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_routing_rules_select ON lead_routing_rules;
DROP POLICY IF EXISTS lead_routing_rules_write  ON lead_routing_rules;
CREATE POLICY lead_routing_rules_select ON lead_routing_rules
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY lead_routing_rules_write ON lead_routing_rules
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ad_campaign_cache_select ON ad_campaign_cache;
CREATE POLICY ad_campaign_cache_select ON ad_campaign_cache
  FOR SELECT USING (is_account_member(account_id));

-- ---- even spread of organic leads --------------------------------------
-- Picks the organic-eligible closer served least recently and stamps them,
-- atomically: two leads arriving at the same instant can't both get the
-- same closer (SKIP LOCKED moves the second one to the next closer).
-- Called only by the webhook (service role).

CREATE OR REPLACE FUNCTION public.pick_organic_closer(p_account UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID;
BEGIN
  SELECT c.user_id INTO v_user
  FROM lead_routing_closers c
  WHERE c.account_id = p_account
    AND c.receives_organic
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = c.user_id AND p.account_id = p_account
    )
  ORDER BY c.last_assigned_at NULLS FIRST, c.created_at, c.user_id
  LIMIT 1
  FOR UPDATE OF c SKIP LOCKED;

  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE lead_routing_closers
     SET last_assigned_at = now()
   WHERE account_id = p_account AND user_id = v_user;

  RETURN v_user;
END;
$$;

ALTER FUNCTION public.pick_organic_closer(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pick_organic_closer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_organic_closer(UUID) TO service_role;

-- ---- settings-page summary -----------------------------------------------
-- One jsonb document so PostgREST's 1,000-row cap can't truncate it:
--   by_source  conversations opened in the window, by how they were routed
--   by_owner   ... per closer
--   campaigns  ad campaigns seen on new leads (the app flags the ones no
--              rule covers)
-- SECURITY INVOKER: RLS limits it to the caller's own account.

CREATE OR REPLACE FUNCTION public.lead_routing_stats(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH recent AS (
    SELECT cv.owner_agent_id, cv.owner_source, ct.ctwa_campaign_id, ct.ctwa_campaign_name
    FROM conversations cv
    JOIN contacts ct ON ct.id = cv.contact_id
    WHERE cv.created_at >= now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 90)))
  )
  SELECT jsonb_build_object(
    'by_source', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('owner_source', s, 'count', n))
      FROM (SELECT COALESCE(owner_source, 'none') AS s, count(*) AS n FROM recent GROUP BY 1) q
    ), '[]'::jsonb),
    'by_owner', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('owner_id', o, 'owner_source', s, 'count', n))
      FROM (SELECT owner_agent_id AS o, COALESCE(owner_source, 'none') AS s, count(*) AS n
            FROM recent WHERE owner_agent_id IS NOT NULL GROUP BY 1, 2) q
    ), '[]'::jsonb),
    'campaigns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('campaign_id', cid, 'campaign_name', cname, 'leads', n))
      FROM (SELECT ctwa_campaign_id AS cid, max(ctwa_campaign_name) AS cname, count(*) AS n
            FROM recent WHERE ctwa_campaign_id IS NOT NULL GROUP BY 1) q
    ), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.lead_routing_stats(INTEGER) TO authenticated, service_role;
