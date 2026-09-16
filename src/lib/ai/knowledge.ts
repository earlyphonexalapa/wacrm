import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

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
 * Find the single best knowledge-base image match for `queryText`, so
 * the auto-reply bot can attach it alongside its text reply (e.g. the
 * customer asks "cuánto cuesta" and a "Price list" document has a photo
 * attached).
 *
 * Lexical-only (full-text search), not semantic: this is a bonus
 * attachment, not the primary grounding, and skipping the embeddings
 * call keeps it free and instant even on accounts with an embeddings
 * key configured. Business owners write the document's text as the
 * trigger description ("Price list for the course"), so FTS matching
 * against the customer's own words is enough.
 *
 * Best-effort: any failure (no image-backed documents, RPC error)
 * returns null rather than throwing — a missing image must never break
 * the text reply.
 */
export async function findKnowledgeMedia(
  db: SupabaseClient,
  accountId: string,
  queryText: string,
): Promise<KnowledgeMediaMatch | null> {
  const query = queryText.trim()
  if (!query) return null

  try {
    // Cheap early-out: most accounts have zero image-backed documents,
    // and this skips the RPC + two follow-up lookups below entirely.
    const { count, error: countErr } = await db
      .from('ai_knowledge_documents')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .not('media_url', 'is', null)
    if (countErr || !count) return null

    const { data: hits, error: rpcErr } = await db.rpc('match_ai_knowledge_fts', {
      p_account_id: accountId,
      p_query: query,
      p_match_count: 5,
    })
    if (rpcErr || !Array.isArray(hits) || hits.length === 0) return null

    const chunkIds = (hits as MatchRow[]).map((h) => h.id)
    const { data: chunks, error: chunksErr } = await db
      .from('ai_knowledge_chunks')
      .select('id, document_id')
      .in('id', chunkIds)
    if (chunksErr || !chunks || chunks.length === 0) return null
    const docIdByChunk = new Map<string, string>(
      (chunks as { id: string; document_id: string }[]).map((c) => [c.id, c.document_id]),
    )

    const docIds = Array.from(new Set(docIdByChunk.values()))
    const { data: docs, error: docsErr } = await db
      .from('ai_knowledge_documents')
      .select('id, media_url, media_type')
      .in('id', docIds)
      .not('media_url', 'is', null)
    if (docsErr || !docs || docs.length === 0) return null
    const mediaByDoc = new Map(
      (docs as { id: string; media_url: string; media_type: string | null }[]).map(
        (d) => [d.id, d],
      ),
    )

    // Walk the ranked chunk ids in order — the first one whose document
    // carries an image is the best-ranked image match.
    for (const chunkId of chunkIds) {
      const docId = docIdByChunk.get(chunkId)
      const doc = docId ? mediaByDoc.get(docId) : undefined
      if (doc) return { url: doc.media_url, mimeType: doc.media_type ?? '' }
    }
    return null
  } catch (err) {
    console.error('[ai knowledge] media match failed:', err)
    return null
  }
}
