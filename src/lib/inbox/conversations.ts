import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

// ============================================================
// Conversations that must always be in the Inbox.
//
// PostgREST caps a plain select at 1,000 rows, so the Inbox only ever
// receives the 1,000 most recently active conversations — on a busy
// account that is roughly the last week, and older chats silently drop
// out of the list (they are still in the database). Chats whose contact
// carries the "Pagado" tag are the ones worth keeping reachable
// forever, so they are fetched separately and merged into the list.
// ============================================================

const ALWAYS_LOADED_TAG = "pagado";

/** Page size for the contact_tags walk — equal to PostgREST's row cap. */
const TAG_PAGE_SIZE = 1000;
/** Contact ids per conversations request, to keep the URL short. */
const CONTACT_CHUNK = 80;

export function isAlwaysLoadedTag(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === ALWAYS_LOADED_TAG;
}

/**
 * Every conversation whose contact has the "Pagado" tag, however old.
 * Throws on a failed query; callers decide whether the Inbox can carry on
 * without it.
 */
export async function loadAlwaysLoadedConversations(
  db: SupabaseClient,
): Promise<Conversation[]> {
  const { data: tags, error: tagsError } = await db
    .from("tags")
    .select("id, name");
  if (tagsError) throw tagsError;

  const tagIds = (tags ?? [])
    .filter((t) => isAlwaysLoadedTag(t.name))
    .map((t) => t.id as string);
  if (tagIds.length === 0) return [];

  const contactIds = new Set<string>();
  for (let from = 0; ; from += TAG_PAGE_SIZE) {
    const { data, error } = await db
      .from("contact_tags")
      .select("contact_id")
      .in("tag_id", tagIds)
      .order("id")
      .range(from, from + TAG_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) contactIds.add(row.contact_id as string);
    if (!data || data.length < TAG_PAGE_SIZE) break;
  }

  const ids = [...contactIds];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CONTACT_CHUNK) {
    chunks.push(ids.slice(i, i + CONTACT_CHUNK));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      db.from("conversations").select(CONVERSATION_SELECT).in("contact_id", chunk),
    ),
  );

  const rows: RawConversation[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as RawConversation[]));
  }
  return normalizeConversations(rows);
}

/**
 * Union of the recent window and the always-loaded set, deduplicated by id
 * (the recent copy wins) and ordered newest activity first, like the Inbox
 * query itself.
 */
export function mergeConversations(
  recent: Conversation[],
  extra: Conversation[],
): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const c of extra) byId.set(c.id, c);
  for (const c of recent) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
  );
}
