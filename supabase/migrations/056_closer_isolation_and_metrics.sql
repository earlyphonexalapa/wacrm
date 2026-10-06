-- ============================================================
-- 056_closer_isolation_and_metrics
--
-- 1. Closer isolation (opt-in): when lead_routing_settings.restrict_closers
--    is on, members below admin only see the conversations they OWN
--    (owner_agent_id) or that were assigned to them (assigned_agent_id),
--    and only the contacts of those chats (plus contacts they created).
--    Admins and the owner always see everything. Off by default, so
--    nothing changes until an admin switches it on in Settings.
--
--    Only conversations and contacts (and their notes) get new rules.
--    messages, message_reactions and contact_tags already filter through
--    EXISTS subqueries on conversations / contacts, which Postgres runs
--    under those tables' own policies, so they inherit the isolation.
--
-- 2. dashboard_period_metrics(): the dashboard's per-day numbers, optionally
--    for ONE closer, plus the new "sales" count (the "Pagado" tag).
--    A closer is pinned to their own numbers; only admins choose the scope.
--
-- 3. lead_routing_bulk_assign(): hand old (unowned) chats to a closer, spread
--    them evenly, or move one closer's chats to another — one admin click.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE lead_routing_settings
  ADD COLUMN IF NOT EXISTS restrict_closers BOOLEAN NOT NULL DEFAULT false;

-- ---- isolation helpers ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.closer_isolation_on(p_account UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT s.restrict_closers FROM lead_routing_settings s WHERE s.account_id = p_account),
    false
  );
$$;

ALTER FUNCTION public.closer_isolation_on(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.closer_isolation_on(UUID) TO authenticated, service_role;

-- The two facts every row-level check below needs, as functions that take no
-- row: the caller's account, and whether the caller may see every chat in it
-- (an admin/owner, or isolation is off). The policies call them as
-- "(SELECT my_account_id())", which Postgres evaluates ONCE per statement as
-- an InitPlan instead of once per row — with thousands of chats the
-- difference is the whole cost of opening the Inbox.

CREATE OR REPLACE FUNCTION public.my_account_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.account_id FROM profiles p WHERE p.user_id = auth.uid() LIMIT 1;
$$;

ALTER FUNCTION public.my_account_id() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.my_account_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sees_all_chats()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.account_role IN ('owner', 'admin') OR NOT closer_isolation_on(p.account_id)
       FROM profiles p WHERE p.user_id = auth.uid() LIMIT 1),
    false
  );
$$;

ALTER FUNCTION public.sees_all_chats() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.sees_all_chats() TO authenticated, service_role;

-- ---- conversations ---------------------------------------------------------

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    account_id = (SELECT my_account_id())
    AND (
      (SELECT sees_all_chats())
      OR owner_agent_id = (SELECT auth.uid())
      OR assigned_agent_id = (SELECT auth.uid())
    )
  );

-- Changing a chat's owner goes through lead_routing_set_owner() below: a plain
-- UPDATE that hands a chat away fails, because Postgres also checks the new
-- row against the SELECT policy.
DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      (SELECT sees_all_chats())
      OR owner_agent_id = (SELECT auth.uid())
      OR assigned_agent_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      (SELECT sees_all_chats())
      OR owner_agent_id = (SELECT auth.uid())
      OR assigned_agent_id = (SELECT auth.uid())
    )
  );

-- ---- contacts and their notes -------------------------------------------------
-- A closer sees the contacts they created and the contacts of the chats they
-- own or are assigned to.

DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (
    account_id = (SELECT my_account_id())
    AND (
      (SELECT sees_all_chats())
      OR user_id = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1
        FROM conversations cv
        WHERE cv.contact_id = contacts.id
          AND (cv.owner_agent_id = (SELECT auth.uid()) OR cv.assigned_agent_id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS contacts_update ON contacts;
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      (SELECT sees_all_chats())
      OR user_id = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1
        FROM conversations cv
        WHERE cv.contact_id = contacts.id
          AND (cv.owner_agent_id = (SELECT auth.uid()) OR cv.assigned_agent_id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      (SELECT sees_all_chats())
      OR user_id = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1
        FROM conversations cv
        WHERE cv.contact_id = contacts.id
          AND (cv.owner_agent_id = (SELECT auth.uid()) OR cv.assigned_agent_id = (SELECT auth.uid()))
      )
    )
  );

-- The contacts subquery runs under contacts_select, so notes follow it.
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (
    is_account_member(account_id)
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );

-- ---- per-day dashboard numbers, optionally for one closer -----------------------

CREATE OR REPLACE FUNCTION public.dashboard_period_metrics(
  p_from DATE,
  p_to DATE,
  p_tz TEXT DEFAULT 'UTC',
  p_owner UUID DEFAULT NULL
)
RETURNS TABLE (
  day DATE,
  new_contacts INTEGER,
  new_conversations INTEGER,
  incoming_messages INTEGER,
  outgoing_messages INTEGER,
  qualified_leads INTEGER,
  sales_count INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_role account_role_enum;
  v_owner UUID;
  v_tz TEXT;
  v_from DATE;
  v_to DATE;
  v_t0 TIMESTAMPTZ;
  v_t1 TIMESTAMPTZ;
BEGIN
  SELECT p.account_id, p.account_role INTO v_account, v_role
  FROM profiles p WHERE p.user_id = auth.uid();
  IF v_account IS NULL THEN
    RETURN;
  END IF;

  -- Admins and the owner pick the scope (NULL = the whole account). With
  -- closer isolation on, everyone else is pinned to their own numbers no
  -- matter what they pass.
  IF v_role IN ('owner', 'admin') THEN
    v_owner := p_owner;
  ELSIF closer_isolation_on(v_account) THEN
    v_owner := auth.uid();
  ELSE
    v_owner := NULL;
  END IF;

  v_tz := CASE
    WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_tz) THEN p_tz
    ELSE 'UTC'
  END;

  v_to := COALESCE(p_to, (now() AT TIME ZONE v_tz)::date);

  v_from := p_from;
  IF v_from IS NULL THEN
    SELECT (min(c.created_at) AT TIME ZONE v_tz)::date INTO v_from
    FROM contacts c WHERE c.account_id = v_account;
    v_from := COALESCE(v_from, v_to);
  END IF;
  IF v_from > v_to THEN
    v_from := v_to;
  END IF;
  IF v_from < v_to - 1095 THEN
    v_from := v_to - 1095;
  END IF;

  v_t0 := v_from::timestamp AT TIME ZONE v_tz;
  v_t1 := (v_to + 1)::timestamp AT TIME ZONE v_tz;

  RETURN QUERY
  WITH ds AS (
    SELECT g::date AS d
    FROM generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') g
  ),
  scope AS (
    SELECT cv.id, cv.contact_id, cv.created_at
    FROM conversations cv
    WHERE cv.account_id = v_account
      AND (v_owner IS NULL OR cv.owner_agent_id = v_owner OR cv.assigned_agent_id = v_owner)
  ),
  c_new AS (
    SELECT (c.created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n
    FROM contacts c
    WHERE c.account_id = v_account AND c.created_at >= v_t0 AND c.created_at < v_t1
      AND (v_owner IS NULL OR EXISTS (SELECT 1 FROM scope s WHERE s.contact_id = c.id))
    GROUP BY 1
  ),
  c_conv AS (
    SELECT (s.created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n
    FROM scope s
    WHERE s.created_at >= v_t0 AND s.created_at < v_t1
    GROUP BY 1
  ),
  c_msg AS (
    SELECT (m.created_at AT TIME ZONE v_tz)::date AS d,
           (count(*) FILTER (WHERE m.sender_type = 'customer'))::int AS i,
           (count(*) FILTER (WHERE m.sender_type <> 'customer'))::int AS o
    FROM messages m
    JOIN scope s ON s.id = m.conversation_id
    WHERE m.created_at >= v_t0 AND m.created_at < v_t1
    GROUP BY 1
  ),
  c_tag AS (
    SELECT (ctg.created_at AT TIME ZONE v_tz)::date AS d,
           (count(*) FILTER (WHERE lower(btrim(tgs.name)) = 'lead calificado'))::int AS ql,
           (count(*) FILTER (WHERE lower(btrim(tgs.name)) = 'pagado'))::int AS sl
    FROM contact_tags ctg
    JOIN tags tgs ON tgs.id = ctg.tag_id
    JOIN contacts c ON c.id = ctg.contact_id
    WHERE tgs.account_id = v_account
      AND c.account_id = v_account
      AND lower(btrim(tgs.name)) IN ('lead calificado', 'pagado')
      AND ctg.created_at >= v_t0 AND ctg.created_at < v_t1
      AND (v_owner IS NULL OR EXISTS (SELECT 1 FROM scope s WHERE s.contact_id = c.id))
    GROUP BY 1
  )
  SELECT ds.d,
         COALESCE(c_new.n, 0),
         COALESCE(c_conv.n, 0),
         COALESCE(c_msg.i, 0),
         COALESCE(c_msg.o, 0),
         COALESCE(c_tag.ql, 0),
         COALESCE(c_tag.sl, 0)
  FROM ds
  LEFT JOIN c_new  ON c_new.d  = ds.d
  LEFT JOIN c_conv ON c_conv.d = ds.d
  LEFT JOIN c_msg  ON c_msg.d  = ds.d
  LEFT JOIN c_tag  ON c_tag.d  = ds.d
  ORDER BY ds.d;
END;
$$;

ALTER FUNCTION public.dashboard_period_metrics(DATE, DATE, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_period_metrics(DATE, DATE, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_period_metrics(DATE, DATE, TEXT, UUID) TO authenticated, service_role;

-- ---- reassign chats in bulk (admin only) --------------------------------------------
--   unowned_to_one   every chat with no owner  -> p_to
--   unowned_spread   every chat with no owner  -> spread evenly across ALL closers
--   move             every chat owned by p_from -> p_to
-- Returns how many chats changed. Marked 'manual' so the routing summary
-- doesn't count them as campaign leads.

CREATE OR REPLACE FUNCTION public.lead_routing_bulk_assign(
  p_mode TEXT,
  p_to UUID DEFAULT NULL,
  p_from UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_count INTEGER := 0;
  v_closers UUID[];
BEGIN
  SELECT p.account_id INTO v_account
  FROM profiles p
  WHERE p.user_id = auth.uid() AND is_account_member(p.account_id, 'admin');
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Only admins can reassign chats' USING ERRCODE = '42501';
  END IF;

  IF p_mode NOT IN ('unowned_to_one', 'unowned_spread', 'move') THEN
    RAISE EXCEPTION 'Unknown mode %', p_mode USING ERRCODE = '22023';
  END IF;

  IF p_mode IN ('unowned_to_one', 'move') THEN
    IF p_to IS NULL OR NOT EXISTS (
      SELECT 1 FROM lead_routing_closers c WHERE c.account_id = v_account AND c.user_id = p_to
    ) THEN
      RAISE EXCEPTION 'Choose a closer to receive the chats' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_mode = 'move' AND (p_from IS NULL OR p_from = p_to) THEN
    RAISE EXCEPTION 'Choose a different closer to move the chats from' USING ERRCODE = '22023';
  END IF;

  IF p_mode = 'unowned_to_one' THEN
    UPDATE conversations cv
       SET owner_agent_id = p_to, owner_source = 'manual', owner_assigned_at = now()
     WHERE cv.account_id = v_account AND cv.owner_agent_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;

  ELSIF p_mode = 'move' THEN
    UPDATE conversations cv
       SET owner_agent_id = p_to, owner_source = 'manual', owner_assigned_at = now()
     WHERE cv.account_id = v_account AND cv.owner_agent_id = p_from;
    GET DIAGNOSTICS v_count = ROW_COUNT;

  ELSE
    SELECT array_agg(c.user_id ORDER BY c.created_at, c.user_id) INTO v_closers
    FROM lead_routing_closers c WHERE c.account_id = v_account;
    IF v_closers IS NULL THEN
      RAISE EXCEPTION 'Add at least one closer first' USING ERRCODE = '22023';
    END IF;

    WITH numbered AS (
      SELECT cv.id,
             row_number() OVER (ORDER BY cv.last_message_at DESC NULLS LAST, cv.id) AS rn
      FROM conversations cv
      WHERE cv.account_id = v_account AND cv.owner_agent_id IS NULL
    )
    UPDATE conversations cv
       SET owner_agent_id = v_closers[1 + ((n.rn - 1) % array_length(v_closers, 1))::int],
           owner_source = 'manual',
           owner_assigned_at = now()
      FROM numbered n
     WHERE cv.id = n.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RETURN v_count;
END;
$$;

ALTER FUNCTION public.lead_routing_bulk_assign(TEXT, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lead_routing_bulk_assign(TEXT, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lead_routing_bulk_assign(TEXT, UUID, UUID) TO authenticated, service_role;

-- ---- change a chat's owner ------------------------------------------------------
-- A plain UPDATE can't do this for a closer: Postgres also checks the NEW row
-- against the SELECT policy, and a chat handed to someone else is no longer
-- visible to the person handing it over. So owner changes go through here.
-- With closer isolation on, only admins can move a chat; otherwise any agent.

CREATE OR REPLACE FUNCTION public.lead_routing_set_owner(p_conversation UUID, p_owner UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT cv.account_id INTO v_account FROM conversations cv WHERE cv.id = p_conversation;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'agent') THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;

  IF closer_isolation_on(v_account) AND NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Only admins can change the closer' USING ERRCODE = '42501';
  END IF;

  IF p_owner IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.user_id = p_owner AND p.account_id = v_account
  ) THEN
    RAISE EXCEPTION 'That person is not a member of this account' USING ERRCODE = '22023';
  END IF;

  UPDATE conversations
     SET owner_agent_id = p_owner,
         owner_source = CASE WHEN p_owner IS NULL THEN NULL ELSE 'manual' END,
         owner_assigned_at = CASE WHEN p_owner IS NULL THEN NULL ELSE now() END
   WHERE id = p_conversation;
END;
$$;

ALTER FUNCTION public.lead_routing_set_owner(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lead_routing_set_owner(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lead_routing_set_owner(UUID, UUID) TO authenticated, service_role;
