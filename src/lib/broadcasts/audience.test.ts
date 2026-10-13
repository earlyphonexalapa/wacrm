import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  activeRecency,
  recencyCutoff,
  resolveAudienceContactIds,
  type AudienceFilter,
} from './audience';

type Row = Record<string, unknown>;

/**
 * Minimal in-memory stand-in for the slice of the Supabase query builder the
 * audience resolver uses: select / eq / neq / ilike / gte / in / order / range.
 * Rows are filtered, ordered by `id` and sliced like PostgREST would, so the
 * 1,000-row page walk is exercised for real.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const requests: string[] = [];
  const db = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
        neq: (col: string, v: unknown) => (filters.push((r) => r[col] !== v), q),
        ilike: (col: string, pattern: string) => {
          const needle = pattern.replaceAll('%', '').toLowerCase();
          filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle));
          return q;
        },
        gte: (col: string, v: string) => (filters.push((r) => String(r[col]) >= v), q),
        in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), q),
        order: () => q,
        range: async (from: number, to: number) => {
          requests.push(table);
          const rows = (tables[table] ?? [])
            .filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, requests };
}

const NOW = Date.parse('2026-10-20T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const pad = (n: number) => String(n).padStart(6, '0');

describe('recencyCutoff / activeRecency', () => {
  it('goes back whole days from now', () => {
    expect(recencyCutoff(14, NOW)).toBe('2026-10-06T12:00:00.000Z');
  });

  it('only accepts a positive whole number of days', () => {
    expect(activeRecency(null)).toBeNull();
    expect(activeRecency(undefined)).toBeNull();
    expect(activeRecency({ days: 0, basis: 'created' })).toBeNull();
    expect(activeRecency({ days: 1.5, basis: 'created' })).toBeNull();
    expect(activeRecency({ days: 7, basis: 'activity' })).toEqual({ days: 7, basis: 'activity' });
  });
});

describe('resolveAudienceContactIds', () => {
  const contacts = [
    { id: 'new-1', created_at: daysAgo(2) },
    { id: 'new-2', created_at: daysAgo(10) },
    { id: 'old-1', created_at: daysAgo(40) },
    { id: 'old-2', created_at: daysAgo(90) },
  ];

  it('returns every contact when there is no date window', async () => {
    const { db } = fakeDb({ contacts });
    const ids = await resolveAudienceContactIds(db, { type: 'all' }, NOW);
    expect([...(ids ?? [])].sort()).toEqual(['new-1', 'new-2', 'old-1', 'old-2']);
  });

  it('keeps only contacts created inside the window', async () => {
    const { db } = fakeDb({ contacts });
    const seven = await resolveAudienceContactIds(
      db,
      { type: 'all', recency: { days: 7, basis: 'created' } },
      NOW,
    );
    const fourteen = await resolveAudienceContactIds(
      db,
      { type: 'all', recency: { days: 14, basis: 'created' } },
      NOW,
    );
    expect([...(seven ?? [])]).toEqual(['new-1']);
    expect([...(fourteen ?? [])].sort()).toEqual(['new-1', 'new-2']);
  });

  it('on the activity basis keeps old contacts that wrote recently', async () => {
    const { db } = fakeDb({
      contacts,
      conversations: [
        { id: 'v1', contact_id: 'old-1', last_message_at: daysAgo(1) },
        { id: 'v2', contact_id: 'old-2', last_message_at: daysAgo(60) },
        { id: 'v3', contact_id: 'new-2', last_message_at: daysAgo(30) },
      ],
    });

    const ids = await resolveAudienceContactIds(
      db,
      { type: 'all', recency: { days: 14, basis: 'activity' } },
      NOW,
    );

    expect([...(ids ?? [])]).toEqual(['old-1']);
  });

  it('applies the window to a tag audience and then the excluded tags', async () => {
    const { db } = fakeDb({
      contacts,
      contact_tags: [
        { id: 't1', contact_id: 'new-1', tag_id: 'lead' },
        { id: 't2', contact_id: 'new-2', tag_id: 'lead' },
        { id: 't3', contact_id: 'old-1', tag_id: 'lead' },
        { id: 't4', contact_id: 'new-2', tag_id: 'paid' },
      ],
    });

    const audience: AudienceFilter = {
      type: 'tags',
      tagIds: ['lead'],
      excludeTagIds: ['paid'],
      recency: { days: 14, basis: 'created' },
    };
    const ids = await resolveAudienceContactIds(db, audience, NOW);

    // old-1 is outside the window, new-2 is excluded as paid.
    expect([...(ids ?? [])]).toEqual(['new-1']);
  });

  it('applies the window to a custom-field audience', async () => {
    const { db } = fakeDb({
      contacts,
      contact_custom_values: [
        { id: 'c1', contact_id: 'new-1', custom_field_id: 'city', value: 'Bogotá' },
        { id: 'c2', contact_id: 'old-1', custom_field_id: 'city', value: 'Bogotá' },
        { id: 'c3', contact_id: 'new-2', custom_field_id: 'city', value: 'Lima' },
      ],
    });

    const ids = await resolveAudienceContactIds(
      db,
      {
        type: 'custom_field',
        customField: { fieldId: 'city', operator: 'is', value: 'Bogotá' },
        recency: { days: 14, basis: 'created' },
      },
      NOW,
    );

    expect([...(ids ?? [])]).toEqual(['new-1']);
  });

  it('returns null for a CSV audience (no existing contacts to resolve)', async () => {
    const { db, requests } = fakeDb({ contacts });
    const ids = await resolveAudienceContactIds(
      db,
      { type: 'csv', csvContacts: [{ phone: '+57300' }], recency: { days: 7, basis: 'created' } },
      NOW,
    );
    expect(ids).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('returns an empty set for a tag audience with no tags chosen', async () => {
    const { db } = fakeDb({ contacts });
    const ids = await resolveAudienceContactIds(db, { type: 'tags', tagIds: [] }, NOW);
    expect(ids?.size).toBe(0);
  });

  it('walks past the 1,000-row cap instead of stopping at the first page', async () => {
    const total = 2300;
    const many = Array.from({ length: total }, (_, i) => ({
      id: `c${pad(i)}`,
      created_at: daysAgo(1),
    }));
    const { db, requests } = fakeDb({ contacts: many });

    const ids = await resolveAudienceContactIds(db, { type: 'all' }, NOW);

    expect(ids?.size).toBe(total);
    expect(requests).toHaveLength(3);
  });

  it('applies the window on top of the cap too', async () => {
    const recent = Array.from({ length: 1500 }, (_, i) => ({
      id: `r${pad(i)}`,
      created_at: daysAgo(3),
    }));
    const old = Array.from({ length: 1200 }, (_, i) => ({
      id: `o${pad(i)}`,
      created_at: daysAgo(100),
    }));
    const { db } = fakeDb({ contacts: [...recent, ...old] });

    const ids = await resolveAudienceContactIds(
      db,
      { type: 'all', recency: { days: 7, basis: 'created' } },
      NOW,
    );

    expect(ids?.size).toBe(1500);
  });
});
