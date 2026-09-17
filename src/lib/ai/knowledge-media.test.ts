import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findKnowledgeMedia } from './knowledge'

interface FakeState {
  mediaCount: number
  ftsHits: { id: string; content: string }[]
  chunks: { id: string; document_id: string }[]
  mediaRows: { document_id: string; media_url: string; media_type: string }[]
  rpcCalls: string[]
}

function makeDb(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    mediaCount: 1,
    ftsHits: [],
    chunks: [],
    mediaRows: [],
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
      if (table === 'ai_knowledge_media') {
        return {
          select: (cols: string) => {
            // Cheap-early-out count: select('id', {count, head:true}).eq(...)
            if (cols === 'id') {
              return { eq: () => Promise.resolve({ count: state.mediaCount, error: null }) }
            }
            // Full lookup: select('document_id, media_url, media_type').in().order()
            return {
              in: () => ({
                order: () => Promise.resolve({ data: state.mediaRows, error: null }),
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
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await findKnowledgeMedia(db, 'acct', '   ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits when the account has no media-backed documents', async () => {
    const { db, state } = makeDb({ mediaCount: 0 })
    expect(await findKnowledgeMedia(db, 'acct', 'cuanto cuesta')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('returns [] when nothing matches the query', async () => {
    const { db } = makeDb({ ftsHits: [] })
    expect(await findKnowledgeMedia(db, 'acct', 'cuanto cuesta')).toEqual([])
  })

  it('returns every attachment of the best-ranked matching document, in position order', async () => {
    const { db } = makeDb({
      ftsHits: [{ id: 'chunk-1', content: 'Prueba social' }],
      chunks: [{ id: 'chunk-1', document_id: 'doc-1' }],
      mediaRows: [
        { document_id: 'doc-1', media_url: 'https://x/1.png', media_type: 'image/png' },
        { document_id: 'doc-1', media_url: 'https://x/2.png', media_type: 'image/png' },
        { document_id: 'doc-1', media_url: 'https://x/brochure.pdf', media_type: 'application/pdf' },
      ],
    })
    const result = await findKnowledgeMedia(db, 'acct', 'referencias de alumnos')
    expect(result).toEqual([
      { url: 'https://x/1.png', mimeType: 'image/png' },
      { url: 'https://x/2.png', mimeType: 'image/png' },
      { url: 'https://x/brochure.pdf', mimeType: 'application/pdf' },
    ])
  })

  it('skips a top match with no attachments and falls through to the next ranked one', async () => {
    const { db } = makeDb({
      ftsHits: [
        { id: 'chunk-1', content: 'Text-only FAQ' },
        { id: 'chunk-2', content: 'Prueba social' },
      ],
      chunks: [
        { id: 'chunk-1', document_id: 'doc-1' },
        { id: 'chunk-2', document_id: 'doc-2' },
      ],
      mediaRows: [
        { document_id: 'doc-2', media_url: 'https://x/1.png', media_type: 'image/png' },
      ],
    })
    const result = await findKnowledgeMedia(db, 'acct', 'referencias')
    expect(result).toEqual([{ url: 'https://x/1.png', mimeType: 'image/png' }])
  })

  it('returns [] when no ranked document has attachments', async () => {
    const { db } = makeDb({
      ftsHits: [{ id: 'chunk-1', content: 'Text-only FAQ' }],
      chunks: [{ id: 'chunk-1', document_id: 'doc-1' }],
      mediaRows: [],
    })
    expect(await findKnowledgeMedia(db, 'acct', 'q')).toEqual([])
  })
})
