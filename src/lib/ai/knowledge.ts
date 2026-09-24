import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import { isTrivialQuery, matchesTrigger, unsentOnly } from './media-rules'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
}

export interface KnowledgeMediaMatch {
  /** `chat-media` bucket URL (or any public URL Meta can fetch). */
  url: string
  mimeType: string
}

/** Hard cap on attachments per knowledge-base document — enforced here
 *  (`.limit()` below) and in the write path (the API route). */
export const MAX_KNOWLEDGE_MEDIA_ITEMS = 5

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

export interface KnowledgeMediaInput {
  url: string
  type: string
}

/**
 * Validate a knowledge-document media payload from a request body: an
 * array of `{ url, type }`, each an image or a PDF, capped at
 * `MAX_KNOWLEDGE_MEDIA_ITEMS`. Returns `null` on anything invalid
 * (wrong shape, too many items, an unsupported type) so the route can
 * 400 rather than silently drop or truncate what the admin sent.
 */
export function parseKnowledgeMediaInput(raw: unknown): KnowledgeMediaInput[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_KNOWLEDGE_MEDIA_ITEMS) return null

  const items: KnowledgeMediaInput[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null
    const rawUrl = (entry as Record<string, unknown>).url
    const rawType = (entry as Record<string, unknown>).type
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    const type = typeof rawType === 'string' ? rawType.trim() : ''
    if (!url || !type) return null
    if (!type.startsWith('image/') && type !== 'application/pdf') return null
    items.push({ url, type })
  }
  return items
}

/**
 * Replace a document's attachments wholesale (delete-then-insert, same
 * idempotent-on-retry shape as `ingestDocument`'s chunk rebuild).
 * `items` order is preserved as `position`, which is what determines
 * the order the bot sends them in.
 */
export async function replaceKnowledgeMedia(
  db: SupabaseClient,
  accountId: string,
  documentId: string,
  items: KnowledgeMediaInput[],
): Promise<void> {
  const { error: delErr } = await db
    .from('ai_knowledge_media')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (items.length === 0) return

  const rows = items.map((item, i) => ({
    document_id: documentId,
    account_id: accountId,
    media_url: item.url,
    media_type: item.type,
    position: i,
  }))
  const { error: insErr } = await db.from('ai_knowledge_media').insert(rows)
  if (insErr) throw insErr
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}

/**
 * URLs of every file the business has already sent in this conversation
 * (bot or agent). Best-effort: empty set on any failure.
 */
export async function loadSentMediaUrls(
  db: SupabaseClient,
  conversationId: string,
): Promise<Set<string>> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('media_url')
      .eq('conversation_id', conversationId)
      .neq('sender_type', 'customer')
      .not('media_url', 'is', null)
      .limit(200)
    if (error || !data) return new Set()
    return new Set(
      (data as { media_url: string | null }[])
        .map((r) => r.media_url)
        .filter((u): u is string => typeof u === 'string' && u !== ''),
    )
  } catch {
    return new Set()
  }
}

export interface FindMediaOptions {
  /** Files already sent in this conversation; never sent again. */
  sentUrls?: Set<string>
}

/**
 * Find the attachments (images and/or PDFs, up to MAX_KNOWLEDGE_MEDIA_ITEMS)
 * the auto-reply bot may send alongside its text reply.
 *
 * Rules, in order:
 *  1. A message that says nothing about a topic ("Si", "Ok", "..") never
 *     picks a file — it used to match whichever document happened to
 *     contain those words and send it unasked.
 *  2. A document with media_triggers (migration 049) is gated: its files
 *     go out ONLY when the customer's message contains one of its trigger
 *     phrases, and never through the fuzzy search below.
 *  3. Otherwise the best full-text match among the un-gated documents
 *     wins (lexical, not semantic: this is a bonus attachment, and
 *     skipping the embeddings call keeps it free and instant).
 *  4. Files already sent in this conversation are never sent again.
 *
 * Best-effort: any failure returns [] rather than throwing — missing
 * attachments must never break the text reply.
 */
export async function findKnowledgeMedia(
  db: SupabaseClient,
  accountId: string,
  queryText: string,
  opts: FindMediaOptions = {},
): Promise<KnowledgeMediaMatch[]> {
  const query = queryText.trim()
  if (!query) return []
  if (isTrivialQuery(query)) return []

  try {
    // Cheap early-out: most accounts have zero media-backed documents,
    // and this skips the RPC + follow-up lookups below entirely.
    const { count, error: countErr } = await db
      .from('ai_knowledge_media')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (countErr || !count) return []

    // Documents that gate their files behind trigger phrases. Isolated
    // in its own try: if migration 049 isn't applied the column doesn't
    // exist, and everything below keeps working as before.
    let triggerDocs: { id: string; triggers: string[] }[] = []
    try {
      const { data: docRows, error: docErr } = await db
        .from('ai_knowledge_documents')
        .select('id, media_triggers')
        .eq('account_id', accountId)
      if (!docErr && Array.isArray(docRows)) {
        triggerDocs = (docRows as { id: string; media_triggers: string[] | null }[])
          .filter((d) => Array.isArray(d.media_triggers) && d.media_triggers.length > 0)
          .map((d) => ({ id: d.id, triggers: d.media_triggers as string[] }))
      }
    } catch {
      triggerDocs = []
    }
    const gatedIds = new Set(triggerDocs.map((d) => d.id))

    // (2) A gated document whose trigger the customer just wrote.
    const triggered = triggerDocs.filter((d) => matchesTrigger(query, d.triggers))
    if (triggered.length > 0) {
      const { data: rows, error } = await db
        .from('ai_knowledge_media')
        .select('document_id, media_url, media_type')
        .in('document_id', triggered.map((d) => d.id))
        .order('position', { ascending: true })
      if (error || !rows) return []
      for (const doc of triggered) {
        const items = (rows as { document_id: string; media_url: string; media_type: string }[])
          .filter((r) => r.document_id === doc.id)
          .map((r) => ({ url: r.media_url, mimeType: r.media_type }))
        if (items.length > 0) {
          return unsentOnly(items.slice(0, MAX_KNOWLEDGE_MEDIA_ITEMS), opts.sentUrls)
        }
      }
      return []
    }

    // (3) Best full-text match among the documents that aren't gated.
    const { data: hits, error: rpcErr } = await db.rpc('match_ai_knowledge_fts', {
      p_account_id: accountId,
      p_query: query,
      p_match_count: 5,
    })
    if (rpcErr || !Array.isArray(hits) || hits.length === 0) return []

    const chunkIds = (hits as MatchRow[]).map((h) => h.id)
    const { data: chunks, error: chunksErr } = await db
      .from('ai_knowledge_chunks')
      .select('id, document_id')
      .in('id', chunkIds)
    if (chunksErr || !chunks || chunks.length === 0) return []
    const docIdByChunk = new Map<string, string>(
      (chunks as { id: string; document_id: string }[]).map((c) => [c.id, c.document_id]),
    )

    const docIds = Array.from(new Set(docIdByChunk.values()))
    const { data: mediaRows, error: mediaErr } = await db
      .from('ai_knowledge_media')
      .select('document_id, media_url, media_type')
      .in('document_id', docIds)
      .order('position', { ascending: true })
    if (mediaErr || !mediaRows || mediaRows.length === 0) return []

    const mediaByDoc = new Map<string, KnowledgeMediaMatch[]>()
    for (const row of mediaRows as {
      document_id: string
      media_url: string
      media_type: string
    }[]) {
      const list = mediaByDoc.get(row.document_id) ?? []
      list.push({ url: row.media_url, mimeType: row.media_type })
      mediaByDoc.set(row.document_id, list)
    }

    // Walk the ranked chunk ids in order — the first un-gated document
    // that carries attachments is the best-ranked media match. If all of
    // its files were already sent we return nothing rather than falling
    // through to an unrelated document.
    for (const chunkId of chunkIds) {
      const docId = docIdByChunk.get(chunkId)
      if (!docId || gatedIds.has(docId)) continue
      const items = mediaByDoc.get(docId)
      if (items && items.length > 0) {
        return unsentOnly(items.slice(0, MAX_KNOWLEDGE_MEDIA_ITEMS), opts.sentUrls)
      }
    }
    return []
  } catch (err) {
    console.error('[ai knowledge] media match failed:', err)
    return []
  }
}
