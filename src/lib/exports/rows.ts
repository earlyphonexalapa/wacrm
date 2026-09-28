import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExportConversation, ExportMessage } from './types'

// ============================================================
// Server-side data assembly for one export request.
// ============================================================

/** Conversations per export request — the client fans a larger
 *  selection out into batches of this size, one request each, so the
 *  progress bar advances and no single request runs too long. */
export const MAX_EXPORT_BATCH = 15

/**
 * Validate the `conversation_ids` field of an export request body.
 * Returns a deduplicated, string-only, capped list, or null when the
 * input is missing, empty, not an array, or over the batch cap.
 */
export function parseConversationIds(body: unknown): string[] | null {
  const raw = (body as { conversation_ids?: unknown } | null)?.conversation_ids
  if (!Array.isArray(raw)) return null
  const ids = [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.trim() !== ''))]
  if (ids.length === 0 || ids.length > MAX_EXPORT_BATCH) return null
  return ids
}

const MESSAGE_COLUMNS = 'sender_type, content_type, content_text, media_url, template_name, status, created_at'
// PostgREST caps an unbounded result at its configured max-rows (1000 by
// default) regardless of an explicit .limit() past that — paging in
// chunks of exactly that size is what makes a chat with more messages
// than the cap export completely instead of silently truncating.
const MESSAGE_PAGE_SIZE = 1000

/**
 * Every message of one conversation, oldest first, paged past
 * PostgREST's row cap so a long-running chat exports in full.
 */
export async function fetchAllMessages(
  db: SupabaseClient,
  conversationId: string,
): Promise<ExportMessage[]> {
  const out: ExportMessage[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await db
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .range(offset, offset + MESSAGE_PAGE_SIZE - 1)
    if (error) throw error
    const page = (data ?? []) as ExportMessage[]
    out.push(...page)
    if (page.length < MESSAGE_PAGE_SIZE) break
    offset += MESSAGE_PAGE_SIZE
  }
  return out
}

interface ConversationRow {
  id: string
  status: string
  contact:
    | { name: string | null; phone: string; company: string | null; contact_tags?: { tags: { name: string } | null }[] | null }
    | { name: string | null; phone: string; company: string | null; contact_tags?: { tags: { name: string } | null }[] | null }[]
    | null
}

function tagNames(contact: ConversationRow['contact']): string[] {
  const c = Array.isArray(contact) ? contact[0] : contact
  const joins = c?.contact_tags ?? []
  return joins.map((j) => j.tags?.name).filter((n): n is string => Boolean(n))
}

/**
 * Fetch the requested conversations (scoped to `accountId` — RLS already
 * enforces this, the explicit filter just keeps a foreign id from
 * silently producing an empty result) with their contact, tags, and
 * every message. Ids that don't resolve (wrong account, deleted) are
 * dropped rather than erroring, since the export should still complete
 * for the ones that do.
 */
export async function buildExportConversations(
  db: SupabaseClient,
  accountId: string,
  conversationIds: string[],
): Promise<ExportConversation[]> {
  const { data, error } = await db
    .from('conversations')
    .select('id, status, contact:contacts(name, phone, company, contact_tags(tags(name)))')
    .eq('account_id', accountId)
    .in('id', conversationIds)
  if (error) throw error

  const rows = (data ?? []) as unknown as ConversationRow[]
  const out: ExportConversation[] = []
  for (const row of rows) {
    const c = Array.isArray(row.contact) ? row.contact[0] : row.contact
    if (!c) continue
    out.push({
      id: row.id,
      status: row.status,
      contact: { name: c.name, phone: c.phone, company: c.company },
      tags: tagNames(row.contact),
      messages: await fetchAllMessages(db, row.id),
    })
  }
  return out
}
