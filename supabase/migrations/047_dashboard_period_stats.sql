-- ============================================================
-- 047_dashboard_period_stats
--
-- Powers the dashboard's date filter. Returns one row per calendar day
-- in [p_from, p_to] (in the caller's timezone) with the account's new
-- contacts, new conversations, and incoming / outgoing messages.
--
-- Why SQL instead of the old client-side aggregation: PostgREST caps a
-- plain select at 1,000 rows, so on a busy account the "conversations
-- over time" chart only ever saw the oldest 1,000 messages of the range
-- and drew a flat line afterwards. Counting in the database has no cap.
--
-- SECURITY DEFINER (with an explicit account check) rather than RLS,
-- because the messages policy runs a subquery per row — far too slow for
-- a range scan. Every count is filtered by the caller's own account, and
-- a caller with no profile gets nothing. Read-only.
--
-- p_from NULL means "since the first contact" (the dashboard's Total).
-- The span is clamped to 3 years so a bad argument can't build a huge
-- series. Idempotent — safe to re-run.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

CREATE OR REPLACE FUNCTION public.dashboard_period_stats(
  p_from DATE,
  p_to DATE,
  p_tz TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day DATE,
  new_contacts INTEGER,
  new_conversations INTEGER,
  incoming_messages INTEGER,
  outgoing_messages INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_tz TEXT;
  v_from DATE;
  v_to DATE;
  v_t0 TIMESTAMPTZ;
  v_t1 TIMESTAMPTZ;
BEGIN
  SELECT p.account_id INTO v_account FROM profiles p WHERE p.user_id = auth.uid();
  IF v_account IS NULL THEN
    RETURN;
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
  ct AS (
    SELECT (c.created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n
    FROM contacts c
    WHERE c.account_id = v_account AND c.created_at >= v_t0 AND c.created_at < v_t1
    GROUP BY 1
  ),
  cv AS (
    SELECT (c.created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n
    FROM conversations c
    WHERE c.account_id = v_account AND c.created_at >= v_t0 AND c.created_at < v_t1
    GROUP BY 1
  ),
  mi AS (
    SELECT (m.created_at AT TIME ZONE v_tz)::date AS d,
           (count(*) FILTER (WHERE m.sender_type = 'customer'))::int AS i,
           (count(*) FILTER (WHERE m.sender_type <> 'customer'))::int AS o
    FROM messages m
    JOIN conversations cc ON cc.id = m.conversation_id
    WHERE cc.account_id = v_account AND m.created_at >= v_t0 AND m.created_at < v_t1
    GROUP BY 1
  )
  SELECT ds.d,
         COALESCE(ct.n, 0),
         COALESCE(cv.n, 0),
         COALESCE(mi.i, 0),
         COALESCE(mi.o, 0)
  FROM ds
  LEFT JOIN ct ON ct.d = ds.d
  LEFT JOIN cv ON cv.d = ds.d
  LEFT JOIN mi ON mi.d = ds.d
  ORDER BY ds.d;
END;
$$;

ALTER FUNCTION public.dashboard_period_stats(DATE, DATE, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_period_stats(DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_period_stats(DATE, DATE, TEXT) TO authenticated, service_role;
