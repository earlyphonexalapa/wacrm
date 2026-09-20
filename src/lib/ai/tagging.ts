import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Lead-qualification auto-tagging.
//
// Reuses the same sentinel-in-the-reply trick as the handoff marker
// (see defaults.ts / HANDOFF_SENTINEL): the model appends one marker per
// tag at the end of its reply naming a tag from the account's own rule
// list, which is stripped before the customer ever sees it and used to
// apply the matching contact tags.
//
// Two ways a tag gets applied:
//   1. the model emits its marker (semantic conditions, e.g. "the lead
//      answered the qualification question");
//   2. deterministically, when the reply the bot actually SENT contains
//      one of the rule's `reply_contains` phrases (e.g. the price) — no
//      reliance on the model remembering to tag.
// ============================================================

export interface TagRule {
  tagId: string
  tagName: string
  description: string
  /** Apply the tag automatically when the bot's sent reply contains any of these. */
  replyContains: string[]
}

interface TagRuleRow {
  tag_id: string
  description: string
  reply_contains?: string[] | null
  tags: { name: string } | { name: string }[] | null
}

/** Trim, drop empties and duplicates (case-insensitive), cap the count. */
export function normalizePhrases(input: unknown, max = 10, maxLen = 80): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of input) {
    if (typeof v !== 'string') continue
    const phrase = v.trim().slice(0, maxLen)
    const key = phrase.toLowerCase()
    if (!phrase || seen.has(key)) continue
    seen.add(key)
    out.push(phrase)
    if (out.length >= max) break
  }
  return out
}

/**
 * Load the account's AI tagging rules, joined with the tag's current
 * name. Best-effort: any failure (no rules configured, RLS/table
 * issue) returns `[]` rather than throwing — a broken rule list must
 * never break the reply itself.
 *
 * `reply_contains` came with migration 048; if it isn't applied yet the
 * first query fails, so we retry without it — tagging keeps working
 * (model-driven only) instead of silently turning off on deploy.
 */
export async function loadTagRules(
  db: SupabaseClient,
  accountId: string,
): Promise<TagRule[]> {
  try {
    const fetchRows = (columns: string) =>
      db.from('ai_tag_rules').select(columns).eq('account_id', accountId)

    let { data, error } = await fetchRows('tag_id, description, reply_contains, tags!inner(name)')
    if (error) {
      ;({ data, error } = await fetchRows('tag_id, description, tags!inner(name)'))
    }
    if (error || !data) return []

    return (data as unknown as TagRuleRow[])
      .map((row) => {
        const tag = Array.isArray(row.tags) ? row.tags[0] : row.tags
        if (!tag?.name) return null
        return {
          tagId: row.tag_id,
          tagName: tag.name,
          description: row.description,
          replyContains: normalizePhrases(row.reply_contains),
        }
      })
      .filter((r): r is TagRule => r !== null)
  } catch (err) {
    console.error('[ai tagging] loadTagRules failed:', err)
    return []
  }
}

/** Tag ids the contact already has. Best-effort: [] on any failure. */
export async function loadContactTagIds(
  db: SupabaseClient,
  contactId: string,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from('contact_tags')
      .select('tag_id')
      .eq('contact_id', contactId)
    if (error || !data) return []
    return (data as { tag_id: string }[]).map((r) => r.tag_id)
  } catch (err) {
    console.error('[ai tagging] loadContactTagIds failed:', err)
    return []
  }
}

// Matches a `[[TAG: <name>]]` marker anchored at the very end of the
// reply (the prompt instructs the model to put it there), so it can
// never accidentally eat a customer-relevant "[[" the model quoted
// mid-message.
const TAG_SENTINEL_RE = /\s*\[\[TAG:\s*([^\]]+)\]\]\s*$/i

/**
 * Strip a trailing `[[TAG: <name>]]` marker from a generated reply.
 * Returns the cleaned text (what the customer actually sees) and the
 * raw tag name the model asked for, or null when there was no marker.
 */
export function extractTagSentinel(text: string): {
  text: string
  rawTag: string | null
} {
  const match = text.match(TAG_SENTINEL_RE)
  if (!match) return { text, rawTag: null }
  return { text: text.slice(0, match.index).trim(), rawTag: match[1].trim() }
}

// One or more markers in a row at the very end of the reply.
const TRAILING_MARKERS_RE = /(?:\s*\[\[TAG:\s*[^\]]+\]\])+\s*$/i
const ONE_MARKER_RE = /\[\[TAG:\s*([^\]]+)\]\]/gi

/**
 * Multi-tag version of `extractTagSentinel`: strips every marker in the
 * trailing group and returns all the tag names the model asked for.
 * Any stray marker elsewhere in the text is removed too (it can never be
 * legitimate customer-facing text) but is NOT treated as a tag request.
 */
export function extractTagSentinels(text: string): {
  text: string
  rawTags: string[]
} {
  const trailing = text.match(TRAILING_MARKERS_RE)
  const rawTags: string[] = []
  let body = text
  if (trailing && trailing.index !== undefined) {
    for (const m of trailing[0].matchAll(ONE_MARKER_RE)) rawTags.push(m[1].trim())
    body = text.slice(0, trailing.index)
  }
  body = body.replace(ONE_MARKER_RE, '').replace(/[ \t]+\n/g, '\n').trim()
  return { text: body, rawTags }
}

/** Case/whitespace-insensitive lookup of a rule by the tag name the
 *  model produced. Null when it doesn't exactly match a configured tag
 *  — the model is never allowed to invent a new tag. */
export function matchTagRule(rules: TagRule[], rawTag: string | null): TagRule | null {
  if (!rawTag) return null
  const needle = rawTag.trim().toLowerCase()
  return rules.find((r) => r.tagName.trim().toLowerCase() === needle) ?? null
}

/** All distinct rules named by the model's markers, in order. */
export function matchTagRules(rules: TagRule[], rawTags: string[]): TagRule[] {
  const out: TagRule[] = []
  for (const raw of rawTags) {
    const rule = matchTagRule(rules, raw)
    if (rule && !out.some((r) => r.tagId === rule.tagId)) out.push(rule)
  }
  return out
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ')
}

/** Rules whose `reply_contains` phrases appear in the text the bot sent. */
export function matchReplyPhrases(rules: TagRule[], sentText: string): TagRule[] {
  const haystack = normalizeForMatch(sentText)
  return rules.filter((r) =>
    (r.replyContains ?? []).some((p) => {
      const needle = normalizeForMatch(p.trim())
      return needle !== '' && haystack.includes(needle)
    }),
  )
}

/**
 * Prompt fragment describing the tags the bot keeps up to date, or ''
 * when none are configured. `appliedTagIds` are the tags the lead already
 * has — the model is told which are done and only shown what is still
 * open, so it doesn't have to guess the lead's state from the chat alone.
 */
export function buildTagRulesPrompt(
  rules: TagRule[],
  appliedTagIds: string[] = [],
): string {
  if (rules.length === 0) return ''
  const applied = new Set(appliedTagIds)
  const done = rules.filter((r) => applied.has(r.tagId))
  const pending = rules.filter((r) => !applied.has(r.tagId))

  const header =
    'LEAD STAGE TAGS — do this on EVERY reply. You keep this lead\'s CRM tags up to date. ' +
    'After writing your reply, check each open tag below: if its condition is now true — because of the customer\'s latest message or because of the reply you are writing — ' +
    'add its marker at the very end of your reply, after the message text. Markers are stripped automatically before the customer sees them, so never mention them.\n' +
    '- Tags accumulate: never repeat a tag the lead already has.\n' +
    '- Several tags can become true in the same turn: add one marker per tag, e.g. [[TAG: <exact tag name>]] [[TAG: <exact tag name>]].\n' +
    '- Apply a tag as soon as its condition is met — do not wait for extra confirmation, and do not skip one because a later stage also happened in this same turn. If no open tag is true yet, add no marker. Never invent a tag name outside this list.\n\n'

  const state =
    `Tags this lead already has: ${done.length > 0 ? done.map((r) => r.tagName).join(', ') : 'none'}.\n`

  if (pending.length === 0) {
    return `${header}${state}The lead already has every tag — add no marker.`
  }

  const example = pending[0].tagName
  return (
    `${header}${state}Open tags you can still apply (name: condition):\n` +
    pending.map((r) => `- ${r.tagName}: ${r.description}`).join('\n') +
    `\n\nFormat: end your reply with the marker(s), e.g. [[TAG: ${example}]].`
  )
}
