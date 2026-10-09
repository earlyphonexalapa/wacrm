import { describe, it, expect } from "vitest";
import {
  matchesContactFilters,
  normalizeConversation,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

// ---- always-loaded ("Pagado") conversations --------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAlwaysLoadedTag,
  loadAlwaysLoadedConversations,
  mergeConversations,
  timedTagDays,
} from "./conversations";

describe("isAlwaysLoadedTag", () => {
  it("matches Pagado ignoring case and surrounding spaces", () => {
    expect(isAlwaysLoadedTag("Pagado")).toBe(true);
    expect(isAlwaysLoadedTag("  pagado ")).toBe(true);
    expect(isAlwaysLoadedTag("PAGADO")).toBe(true);
  });

  it("rejects other tags and empty values", () => {
    expect(isAlwaysLoadedTag("Pagado parcial")).toBe(false);
    expect(isAlwaysLoadedTag("Lead Calificado")).toBe(false);
    expect(isAlwaysLoadedTag(null)).toBe(false);
    expect(isAlwaysLoadedTag(undefined)).toBe(false);
  });
});

describe("timedTagDays", () => {
  it("gives Lead Calificado and Abono 14 days, ignoring case and spaces", () => {
    expect(timedTagDays("Lead Calificado")).toBe(14);
    expect(timedTagDays("  abono ")).toBe(14);
    expect(timedTagDays("ABONO")).toBe(14);
  });

  it("has no window for Pagado (it is permanent) or other tags", () => {
    expect(timedTagDays("Pagado")).toBeUndefined();
    expect(timedTagDays("Abono parcial")).toBeUndefined();
    expect(timedTagDays(null)).toBeUndefined();
  });
});

describe("mergeConversations", () => {
  const conv = (id: string, last: string | undefined, text = "x"): Conversation => ({
    ...makeConversation({ id: `ct-${id}` }),
    id,
    last_message_at: last,
    last_message_text: text,
  });

  it("unions both lists without duplicates and prefers the recent copy", () => {
    const recent = [conv("a", "2026-10-05T10:00:00Z", "fresh")];
    const extra = [conv("a", "2026-10-01T10:00:00Z", "stale"), conv("b", "2026-09-01T10:00:00Z")];

    const merged = mergeConversations(recent, extra);

    expect(merged.map((c) => c.id)).toEqual(["a", "b"]);
    expect(merged[0].last_message_text).toBe("fresh");
  });

  it("orders by latest activity, newest first, missing dates last", () => {
    const merged = mergeConversations(
      [conv("old", "2026-09-01T00:00:00Z"), conv("none", undefined)],
      [conv("new", "2026-10-05T00:00:00Z")],
    );
    expect(merged.map((c) => c.id)).toEqual(["new", "old", "none"]);
  });
});

describe("loadAlwaysLoadedConversations", () => {
  type Row = Record<string, unknown>;

  function fakeDb(opts: {
    tags: Row[];
    contactTags: Row[];
    conversations: Row[];
  }) {
    const calls = { contactTagPages: 0, conversationRequests: 0 };
    const db = {
      from(table: string) {
        if (table === "tags") {
          return { select: async () => ({ data: opts.tags, error: null }) };
        }
        if (table === "contact_tags") {
          let tagIds: string[] | null = null;
          let since: string | null = null;
          const q = {
            select: () => q,
            in: (_col: string, ids: string[]) => {
              tagIds = ids;
              return q;
            },
            gte: (_col: string, value: string) => {
              since = value;
              return q;
            },
            order: () => q,
            range: async (a: number, b: number) => {
              calls.contactTagPages++;
              const rows = opts.contactTags.filter(
                (r) =>
                  (r.tag_id === undefined || tagIds === null || tagIds.includes(r.tag_id as string)) &&
                  (r.created_at === undefined || since === null || (r.created_at as string) >= since),
              );
              return { data: rows.slice(a, b + 1), error: null };
            },
          };
          return q;
        }
        const q = {
          select: () => q,
          in: async (_col: string, ids: string[]) => {
            calls.conversationRequests++;
            return {
              data: opts.conversations.filter((c) => ids.includes(c.contact_id as string)),
              error: null,
            };
          },
        };
        return q;
      },
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  const convRow = (id: string, contactId: string) => ({
    id,
    contact_id: contactId,
    status: "open",
    contact: { id: contactId, contact_tags: [{ tags: tag("t-paid", "Pagado") }] },
  });

  it("returns nothing without querying contacts when no kept tag exists", async () => {
    const { db, calls } = fakeDb({
      tags: [{ id: "t1", name: "Otro" }],
      contactTags: [],
      conversations: [],
    });

    await expect(loadAlwaysLoadedConversations(db)).resolves.toEqual([]);
    expect(calls.contactTagPages).toBe(0);
    expect(calls.conversationRequests).toBe(0);
  });

  it("loads the conversations of contacts tagged Pagado and flattens their tags", async () => {
    const { db } = fakeDb({
      tags: [
        { id: "t-paid", name: " pagado " },
        { id: "t-other", name: "Otro" },
      ],
      contactTags: [{ contact_id: "c1" }, { contact_id: "c2" }],
      conversations: [convRow("v1", "c1"), convRow("v2", "c2"), convRow("v3", "c-untagged")],
    });

    const result = await loadAlwaysLoadedConversations(db);

    expect(result.map((c) => c.id).sort()).toEqual(["v1", "v2"]);
    expect(result[0].contact?.tags?.[0].name).toBe("Pagado");
  });

  it("walks past PostgREST's 1,000-row cap and chunks the conversation lookups", async () => {
    const total = 2500;
    const contactTags = Array.from({ length: total }, (_, i) => ({ contact_id: `c${i}` }));
    const conversations = Array.from({ length: total }, (_, i) => convRow(`v${i}`, `c${i}`));
    const { db, calls } = fakeDb({
      tags: [{ id: "t-paid", name: "Pagado" }],
      contactTags,
      conversations,
    });

    const result = await loadAlwaysLoadedConversations(db);

    expect(result).toHaveLength(total);
    expect(calls.contactTagPages).toBe(3);
    expect(calls.conversationRequests).toBe(Math.ceil(total / 80));
  });

  describe("Lead Calificado and Abono (kept 14 days after tagging)", () => {
    const NOW = Date.parse("2026-10-20T12:00:00Z");
    const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

    it("keeps recently tagged chats, drops old ones, and keeps Pagado forever", async () => {
      const { db } = fakeDb({
        tags: [
          { id: "t-paid", name: "Pagado" },
          { id: "t-lead", name: "Lead Calificado" },
          { id: "t-abono", name: " ABONO " },
        ],
        contactTags: [
          { tag_id: "t-paid", contact_id: "paid-old", created_at: daysAgo(90) },
          { tag_id: "t-lead", contact_id: "lead-new", created_at: daysAgo(3) },
          { tag_id: "t-lead", contact_id: "lead-old", created_at: daysAgo(20) },
          { tag_id: "t-abono", contact_id: "abono-new", created_at: daysAgo(13) },
          { tag_id: "t-abono", contact_id: "abono-old", created_at: daysAgo(15) },
        ],
        conversations: [
          convRow("v-paid", "paid-old"),
          convRow("v-lead-new", "lead-new"),
          convRow("v-lead-old", "lead-old"),
          convRow("v-abono-new", "abono-new"),
          convRow("v-abono-old", "abono-old"),
        ],
      });

      const result = await loadAlwaysLoadedConversations(db, NOW);

      expect(result.map((c) => c.id).sort()).toEqual(["v-abono-new", "v-lead-new", "v-paid"]);
    });

    it("does not duplicate a contact that is both Pagado and recently Lead Calificado", async () => {
      const { db } = fakeDb({
        tags: [
          { id: "t-paid", name: "Pagado" },
          { id: "t-lead", name: "Lead Calificado" },
        ],
        contactTags: [
          { tag_id: "t-paid", contact_id: "c1", created_at: daysAgo(1) },
          { tag_id: "t-lead", contact_id: "c1", created_at: daysAgo(2) },
        ],
        conversations: [convRow("v1", "c1")],
      });

      expect(await loadAlwaysLoadedConversations(db, NOW)).toHaveLength(1);
    });
  });

  it("de-duplicates contacts that carry the tag twice (two Pagado tags)", async () => {
    const { db } = fakeDb({
      tags: [
        { id: "t1", name: "Pagado" },
        { id: "t2", name: "PAGADO" },
      ],
      contactTags: [{ contact_id: "c1" }, { contact_id: "c1" }],
      conversations: [convRow("v1", "c1")],
    });

    const result = await loadAlwaysLoadedConversations(db);
    expect(result).toHaveLength(1);
  });
});
