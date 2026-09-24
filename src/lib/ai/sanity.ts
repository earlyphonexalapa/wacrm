// ============================================================
// Last line of defence against a model that "goes off the rails".
//
// Seen in production: after an ambiguous turn the model produced a long
// stream of nonsense that looped on one phrase ("...no me digas nada de
// eso y no me digas nada de eso...") and it was sent to a customer. A
// real sales reply is short and does not repeat itself, so these two
// cheap checks catch that failure without touching normal replies.
// ============================================================

/** A WhatsApp sales reply is a few hundred characters; this is generous. */
export const MAX_REPLY_CHARS = 2000

export type UnusableReason = 'too_long' | 'repetitive'

/**
 * Returns why a generated reply must not be sent, or null when it looks
 * fine. Only the visible text is checked (call it after the tag / handoff
 * markers have been stripped).
 */
export function detectUnusableReply(text: string): UnusableReason | null {
  if (text.length > MAX_REPLY_CHARS) return 'too_long'

  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length < 24) return null

  // Any 4-word sequence repeated 4+ times is a loop, not a sentence.
  const counts = new Map<string, number>()
  for (let i = 0; i + 4 <= words.length; i++) {
    const gram = words.slice(i, i + 4).join(' ')
    const n = (counts.get(gram) ?? 0) + 1
    if (n >= 4) return 'repetitive'
    counts.set(gram, n)
  }
  return null
}
