-- ============================================================
-- 054_dashboard_qualified_leads
--
-- "Leads calificados" on the dashboard: how many contacts were given the
-- "Lead Calificado" tag, per calendar day. Counted by the moment the tag
-- was assigned (contact_tags.created_at), so a closer tagging a contact
-- today counts for today whatever day that contact first wrote in. If a
-- tag is removed and later re-added it counts again on the new date.
--
-- A separate function rather than a new column on dashboard_period_stats
-- (047): changing a function's return shape means dropping it, and the
-- dashboard must keep working untouched if this migration hasn't run yet
-- — the client treats a failure here as "0 leads" and moves on.
--
-- Same shape and safety as 047: one row per day in [p_from, p_to] in the
-- caller's timezone (zero days included), p_from NULL = since the first
-- contact, span clamped to 3 years, SECURITY DEFINER with an explicit
-- account check. The tag is matched by name, case- and space-insensitive.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard_qualified_leads(
  p_from DATE,
  p_to DATE,
  p_tz TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day DATE,
  qualified_leads INTEGER
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
  ql AS (
    SELECT (ct.created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n
    FROM contact_tags ct
    JOIN tags tg ON tg.id = ct.tag_id
    JOIN contacts c ON c.id = ct.contact_id
    WHERE tg.account_id = v_account
      AND c.account_id = v_account
      AND lower(btrim(tg.name)) = 'lead calificado'
      AND ct.created_at >= v_t0 AND ct.created_at < v_t1
    GROUP BY 1
  )
  SELECT ds.d, COALESCE(ql.n, 0)
  FROM ds
  LEFT JOIN ql ON ql.d = ds.d
  ORDER BY ds.d;
END;
$$;

ALTER FUNCTION public.dashboard_qualified_leads(DATE, DATE, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_qualified_leads(DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_qualified_leads(DATE, DATE, TEXT) TO authenticated, service_role;
