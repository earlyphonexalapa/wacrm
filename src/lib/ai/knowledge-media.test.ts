import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findKnowledgeMedia } from './knowledge'

interface FakeState {
  imageDocCount: number
  ftsHits: { id: string; content: string }[]
  chunks: { id: string; document_id: string }[]
  docs: { id: string; media_url: string; media_type: string | null }[]
  rpcCalls: string[]
}

function makeDb(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    imageDocCount: 1,
    ftsHits: [],
    chunks: [],
    docs: [],
    rpcCalls: [],
    ...overrides,
  }

  const db = {
    rpc: (name: string) => {
      state.rpcCalls.push(name)
      if (name === 'match_ai_knowledge_fts') {
        return Promise.resolve({ data: state.ftsHits, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => {
      if (table === 'ai_knowledge_documents') {
        return {
          select: (cols: string) => {
            // The count-only early-out uses select(..., { count, head: true })
            // followed by .eq().not(); the follow-up media lookup uses
            // select().in().not(). Distinguish by whether `docs` is queried.
            if (cols === 'id') {
              return {
                eq: () => ({
                  not: () =>
                    Promise.resolve({ count: state.imageDocCount, error: null }),
                }),
              }
            }
            return {
              in: () => ({
                not: () => Promise.resolve({ data: state.docs, error: null }),
              }),
            }
          },
        }
      }
      if (table === 'ai_knowledge_chunks') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: state.chunks, error: null }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
  return { db: db as unknown as SupabaseClient, state }
}

describe('findKnowledgeMedia', () => {
  it('returns null for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await findKnowledgeMedia(db, 'acct', '   ')).toBeNull()
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits when the account has no image-backed documents', async () => {
    const { db, state } = makeDb({ imageDocCount: 0 })
    expect(await findKnowledgeMedia(db, 'acct', 'cuanto cuesta')).toBeNull()
    expect(state.rpcCalls).toEqual([])
  })

  it('returns null when nothing matches the query', async () => {
    const { db } = makeDb({ ftsHits: [] })
    expect(await findKnowledgeMedia(db, 'acct', 'cuanto cuesta')).toBeNull()
  })

  it('returns the image for the best-ranked matching document', async () => {
    const { db } = makeDb({
      ftsHits: [
        { id: 'chunk-1', content: 'Price list text' },
        { id: 'chunk-2', content: 'Unrelated FAQ' },
      ],
      chunks: [
        { id: 'chunk-1', document_id: 'doc-1' },
        { id: 'chunk-2', document_id: 'doc-2' },
      ],
      docs: [{ id: 'doc-1', media_url: 'https://x/price.png', media_type: 'image/png' }],
    })
    const result = await findKnowledgeMedia(db, 'acct', 'cuanto cuesta')
    expect(result).toEqual({ url: 'https://x/price.png', mimeType: 'image/png' })
  })

  it('skips a top match with no image and falls through to the next ranked one', async () => {
    const { db } = makeDb({
      ftsHits: [
        { id: 'chunk-1', content: 'Text-only FAQ' },
        { id: 'chunk-2', content: 'Price list text' },
      ],
      chunks: [
        { id: 'chunk-1', document_id: 'doc-1' },
        { id: 'chunk-2', document_id: 'doc-2' },
      ],
      docs: [{ id: 'doc-2', media_url: 'https://x/price.png', media_type: 'image/png' }],
    })
    const result = await findKnowledgeMedia(db, 'acct', 'cuanto cuesta')
    expect(result).toEqual({ url: 'https://x/price.png', mimeType: 'image/png' })
  })

  it('returns null when no ranked document has an image', async () => {
    const { db } = makeDb({
      ftsHits: [{ id: 'chunk-1', content: 'Text-only FAQ' }],
      chunks: [{ id: 'chunk-1', document_id: 'doc-1' }],
      docs: [],
    })
    expect(await findKnowledgeMedia(db, 'acct', 'q')).toBeNull()
  })
})
