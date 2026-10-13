import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Who a broadcast goes to.
//
// One place resolves the audience so the wizard's estimates and the actual
// send agree. Every list is walked page by page: PostgREST returns at most
// 1,000 rows per request, and a plain select silently stops there — which on
// an account with thousands of contacts meant a "send to everyone" reached
// only the first thousand.
// ============================================================

export type RecencyBasis = 'created' | 'activity';

/**
 * Keep only contacts from the last `days` days.
 *   created   the contact first reached the account in that window
 *   activity  the contact has a conversation with a message in that window
 */
export interface AudienceRecency {
  days: number;
  basis: RecencyBasis;
}

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface AudienceFilter {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: { fieldId: string; operator: CustomFieldOperator; value: string };
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
  recency?: AudienceRecency | null;
}

/** Window choices offered in the wizard, in days. */
export const RECENCY_PRESET_DAYS = [1, 7, 14, 30, 60, 90] as const;

/** ISO timestamp `days` days before `now` (epoch ms). */
export function recencyCutoff(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** Page size for every walk — equal to PostgREST's row cap. */
const PAGE_SIZE = 1000;

type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

async function walk<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function idsCreatedSince(db: SupabaseClient, since: string | null): Promise<string[]> {
  const rows = await walk<{ id: string }>((from, to) => {
    let q = db.from('contacts').select('id');
    if (since) q = q.gte('created_at', since);
    return q.order('id').range(from, to);
  });
  return rows.map((r) => r.id);
}

async function idsActiveSince(db: SupabaseClient, since: string): Promise<string[]> {
  const rows = await walk<{ contact_id: string | null }>((from, to) =>
    db
      .from('conversations')
      .select('contact_id')
      .gte('last_message_at', since)
      .order('id')
      .range(from, to),
  );
  return rows.map((r) => r.contact_id).filter((id): id is string => Boolean(id));
}

async function idsWithTags(db: SupabaseClient, tagIds: string[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const rows = await walk<{ contact_id: string }>((from, to) =>
    db.from('contact_tags').select('contact_id').in('tag_id', tagIds).order('id').range(from, to),
  );
  return rows.map((r) => r.contact_id);
}

async function idsForCustomField(
  db: SupabaseClient,
  filter: NonNullable<AudienceFilter['customField']>,
): Promise<string[]> {
  const { fieldId, operator, value } = filter;
  const rows = await walk<{ contact_id: string }>((from, to) => {
    let q = db.from('contact_custom_values').select('contact_id').eq('custom_field_id', fieldId);
    if (operator === 'is') q = q.eq('value', value);
    else if (operator === 'is_not') q = q.neq('value', value);
    else q = q.ilike('value', `%${value}%`);
    return q.order('id').range(from, to);
  });
  return rows.map((r) => r.contact_id);
}

async function idsInRecencyWindow(
  db: SupabaseClient,
  recency: AudienceRecency,
  now: number,
): Promise<string[]> {
  const since = recencyCutoff(recency.days, now);
  return recency.basis === 'activity' ? idsActiveSince(db, since) : idsCreatedSince(db, since);
}

/** A recency window is only meaningful with a positive whole number of days. */
export function activeRecency(
  recency: AudienceRecency | null | undefined,
): AudienceRecency | null {
  if (!recency) return null;
  return Number.isInteger(recency.days) && recency.days > 0 ? recency : null;
}

/**
 * The contact ids a broadcast with this audience would reach, after the date
 * window and the excluded tags. Returns null for a CSV audience — those are
 * raw phone numbers that only become contacts at send time.
 * Throws on a failed query.
 */
export async function resolveAudienceContactIds(
  db: SupabaseClient,
  audience: AudienceFilter,
  now: number = Date.now(),
): Promise<Set<string> | null> {
  if (audience.type === 'csv') return null;

  const recency = activeRecency(audience.recency);
  let ids: Set<string>;

  if (audience.type === 'all') {
    ids = new Set(
      recency ? await idsInRecencyWindow(db, recency, now) : await idsCreatedSince(db, null),
    );
  } else {
    const base =
      audience.type === 'tags'
        ? await idsWithTags(db, audience.tagIds ?? [])
        : audience.customField
          ? await idsForCustomField(db, audience.customField)
          : [];
    ids = new Set(base);
    if (recency && ids.size > 0) {
      const inWindow = new Set(await idsInRecencyWindow(db, recency, now));
      ids = new Set([...ids].filter((id) => inWindow.has(id)));
    }
  }

  if (audience.excludeTagIds && audience.excludeTagIds.length > 0 && ids.size > 0) {
    const excluded = new Set(await idsWithTags(db, audience.excludeTagIds));
    ids = new Set([...ids].filter((id) => !excluded.has(id)));
  }

  return ids;
}
