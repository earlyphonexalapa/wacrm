import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Lead-qualification auto-tagging.
//
// Reuses the same sentinel-in-the-reply trick as the handoff marker
// (see defaults.ts / HANDOFF_SENTINEL): the model appends a marker at
// the end of its reply naming a tag from the account's own rule list,
// which is stripped before the customer ever sees it and used to apply
// the matching contact tag.
// ============================================================

export interface TagRule {
  tagId: string
  tagName: string
  description: string
}

interface TagRuleRow {
  tag_id: string
  description: string
  tags: { name: string } | { name: string }[] | null
}

/**
 * Load the account's AI tagging rules, joined with the tag's current
 * name. Best-effort: any failure (no rules configured, RLS/table
 * issue) returns `[]` rather than throwing — a broken rule list must
 * never break the reply itself.
 */
export async function loadTagRules(
  db: SupabaseClient,
  accountId: string,
): Promise<TagRule[]> {
  try {
    const { data, error } = await db
      .from('ai_tag_rules')
      .select('tag_id, description, tags!inner(name)')
      .eq('account_id', accountId)
    if (error || !data) return []

    return (data as TagRuleRow[])
      .map((row) => {
        const tag = Array.isArray(row.tags) ? row.tags[0] : row.tags
        if (!tag?.name) return null
        return { tagId: row.tag_id, tagName: tag.name, description: row.description }
      })
      .filter((r): r is TagRule => r !== null)
  } catch (err) {
    console.error('[ai tagging] loadTagRules failed:', err)
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

/** Case/whitespace-insensitive lookup of a rule by the tag name the
 *  model produced. Null when it doesn't exactly match a configured tag
 *  — the model is never allowed to invent a new tag. */
export function matchTagRule(rules: TagRule[], rawTag: string | null): TagRule | null {
  if (!rawTag) return null
  const needle = rawTag.trim().toLowerCase()
  return rules.find((r) => r.tagName.trim().toLowerCase() === needle) ?? null
}

/** Prompt fragment listing the available tags, or '' when none are configured. */
export function buildTagRulesPrompt(rules: TagRule[]): string {
  if (rules.length === 0) return ''
  const example = rules[0].tagName
  return (
    'You may optionally classify this customer once you have enough information, by appending one tag marker at the very end of your reply — it is stripped automatically before the customer sees it, so never mention it to them. ' +
    'Only include it when you are reasonably confident; it is fine to answer many messages before tagging, or never at all. Never invent a tag name outside this list, and pick at most one:\n' +
    rules.map((r) => `- ${r.tagName}: ${r.description}`).join('\n') +
    `\n\nFormat: end your reply with [[TAG: <exact tag name>]], e.g. [[TAG: ${example}]].`
  )
}
