-- ============================================================
-- 051_export_conversations
--
-- Backs the chat-export picker (Exports page): a paginated, filterable
-- list of conversations with their contact and tags, for choosing which
-- ones to export.
--
-- Why an RPC (mirrors 025_filter_contacts_by_tags.sql): filtering by tag
-- means joining through contact_tags, and combining that with a text
-- search on the embedded contact and an accurate total count isn't
-- expressible as a single PostgREST query. Doing the join, filter,
-- windowed total count and LIMIT/OFFSET in one SQL statement keeps the
-- result always complete and correctly counted, however many
-- conversations the account has.
--
-- Security: SECURITY INVOKER (the default) — runs as the caller, so the
-- existing RLS on conversations/contacts/contact_tags (account
-- membership, migration 017) scopes the result to the caller's account.
-- No privilege bypass, same posture as 025.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_export_conversations(
  p_tag_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  conversation_id UUID,
  status TEXT,
  last_message_at TIMESTAMPTZ,
  last_message_text TEXT,
  contact_id UUID,
  contact_name TEXT,
  contact_phone TEXT,
  contact_company TEXT,
  tag_ids UUID[],
  total_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE (p_status IS NULL OR p_status = '' OR c.status = p_status)
      AND (
        p_search IS NULL OR p_search = ''
        OR ct.name ILIKE '%' || p_search || '%'
        OR ct.phone ILIKE '%' || p_search || '%'
        OR ct.company ILIKE '%' || p_search || '%'
      )
      AND (
        p_tag_ids IS NULL OR array_length(p_tag_ids, 1) IS NULL
        OR EXISTS (
          SELECT 1 FROM contact_tags gt
          WHERE gt.contact_id = c.contact_id AND gt.tag_id = ANY(p_tag_ids)
        )
      )
  ),
  page AS (
    SELECT c.id, c.status, c.last_message_at, c.last_message_text, c.contact_id,
           count(*) OVER() AS total_count
    FROM matched m
    JOIN conversations c ON c.id = m.id
    ORDER BY c.last_message_at DESC NULLS LAST, c.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    p.id,
    p.status,
    p.last_message_at,
    p.last_message_text,
    ct.id,
    ct.name,
    ct.phone,
    ct.company,
    COALESCE(
      (SELECT array_agg(cta.tag_id) FROM contact_tags cta WHERE cta.contact_id = ct.id),
      '{}'
    ),
    p.total_count
  FROM page p
  JOIN contacts ct ON ct.id = p.contact_id
  ORDER BY p.last_message_at DESC NULLS LAST, p.id;
$$;

ALTER FUNCTION public.search_export_conversations(UUID[], TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_export_conversations(UUID[], TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_export_conversations(UUID[], TEXT, TEXT, INT, INT) TO authenticated;
