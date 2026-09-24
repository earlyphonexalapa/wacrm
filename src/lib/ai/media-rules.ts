// ============================================================
// Rules that decide WHETHER a knowledge-base attachment may be sent.
// Pure helpers (no I/O) so they can be unit-tested; findKnowledgeMedia
// and the auto-reply bot wire them in.
//
// Why they exist: the attachment used to be picked by full-text search on
// the customer's last message alone. A bare "Si" / "Ok" matches whatever
// document happens to contain those words in its own instructions, so the
// testimonial screenshots went out when nobody asked for them, and the
// same batch could be sent again a few messages later.
// ============================================================

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalizeForMedia(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()
}

// One-word answers that carry no topic on their own.
const CONFIRMATIONS = new Set([
  'si', 'sip', 'sii', 'siii', 'sis', 'yes', 'ok', 'okey', 'okay', 'oki', 'va', 'vale', 'dale',
  'claro', 'bueno', 'buenas', 'hola', 'gracias', 'grax', 'ya', 'aja', 'ajam', 'listo', 'perfecto',
  'por', 'favor', 'porfa', 'porfavor', 'asi', 'eso', 'este', 'mande', 'adelante', 'entiendo',
  'entendido', 'genial', 'excelente', 'super', 'chido', 'sale', 'simon', 'neta', 'a', 'de', 'que',
  'me', 'lo', 'la', 'el', 'y', 'o', 'e', 'un', 'una', 'no', 'mas',
])

/**
 * True when a customer message says nothing about a topic ("Si", "Ok
 * gracias", "..", "??"), so it must not be used to pick an attachment.
 * A real one-word question like "confiable?" is NOT trivial.
 */
export function isTrivialQuery(text: string): boolean {
  const norm = normalizeForMedia(text)
  if (norm === '') return true
  const tokens = norm.split(' ')
  return tokens.every((t) => CONFIRMATIONS.has(t))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Does the customer's message contain any trigger phrase? Whole words
 * only (so "real" does not fire on "realizar"), accent- and
 * case-insensitive, and a trailing plural ("confiable" → "confiables")
 * still counts.
 */
export function matchesTrigger(text: string, phrases: string[]): boolean {
  const haystack = ` ${normalizeForMedia(text)} `
  for (const raw of phrases) {
    const phrase = normalizeForMedia(raw)
    if (!phrase) continue
    const re = new RegExp(`(?:^| )${escapeRe(phrase)}(?:s|es)?(?: |$)`)
    if (re.test(haystack)) return true
  }
  return false
}

/** Items not yet sent in this conversation. */
export function unsentOnly<T extends { url: string }>(items: T[], sentUrls?: Set<string>): T[] {
  if (!sentUrls || sentUrls.size === 0) return items
  return items.filter((i) => !sentUrls.has(i.url))
}

// ---- in-process guard against two dispatches sending the same file ----

const GUARD_TTL_MS = 10 * 60 * 1000
const claims = new Map<string, number>()

/**
 * First caller for (conversation, url) within the TTL wins and gets
 * true; anyone else gets false. Closes the window where two concurrent
 * dispatches for the same conversation both see "not sent yet" in the
 * database and each send the batch.
 */
export function claimMediaSend(conversationId: string, url: string, now = Date.now()): boolean {
  for (const [k, at] of claims) if (now - at > GUARD_TTL_MS) claims.delete(k)
  const key = `${conversationId}|${url}`
  if (claims.has(key)) return false
  claims.set(key, now)
  return true
}

/** Test helper. */
export function resetMediaClaims(): void {
  claims.clear()
}
