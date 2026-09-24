import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findKnowledgeMedia, loadSentMediaUrls } from './knowledge'

interface World {
  /** documents: id → trigger phrases (empty = un-gated) */
  docs: Record<string, string[]>
  /** media per document, in position order */
  media: Record<string, string[]>
  /** ranked FTS chunk → document */
  fts: { id: string; document_id: string }[]
  rpcCalls: number
  /** urls of files already sent in the conversation (loadSentMediaUrls) */
  sent: string[]
}

function fakeDb(w: World, opts: { docsThrow?: boolean } = {}): SupabaseClient {
  const from = (table: string) => {
    if (table === 'ai_knowledge_media') {
      return {
        select: (cols: string) => {
          if (cols === 'id') {
            return { eq: () => Promise.resolve({ count: Object.values(w.media).flat().length, error: null }) }
          }
          return {
            in: (_c: string, ids: string[]) => ({
              order: () =>
                Promise.resolve({
                  data: ids.flatMap((id) =>
                    (w.media[id] ?? []).map((url) => ({ document_id: id, media_url: url, media_type: 'image/png' })),
                  ),
                  error: null,
                }),
            }),
          }
        },
      }
    }
    if (table === 'ai_knowledge_documents') {
      if (opts.docsThrow) throw new Error('column media_triggers does not exist')
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: Object.entries(w.docs).map(([id, media_triggers]) => ({ id, media_triggers })),
              error: null,
            }),
        }),
      }
    }
    if (table === 'ai_knowledge_chunks') {
      return { select: () => ({ in: () => Promise.resolve({ data: w.fts, error: null }) }) }
    }
    if (table === 'messages') {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'neq', 'not']) chain[m] = () => chain
      chain.limit = () => Promise.resolve({ data: w.sent.map((u) => ({ media_url: u })), error: null })
      return chain
    }
    throw new Error('unexpected table ' + table)
  }
  return {
    from,
    rpc: () => {
      w.rpcCalls++
      return Promise.resolve({ data: w.fts.map((c) => ({ id: c.id, content: 'x' })), error: null })
    },
  } as unknown as SupabaseClient
}

const base = (): World => ({
  docs: { temario: [], testimonios: ['confiable', 'estafa', 'reseña'] },
  media: { temario: ['t1.png'], testimonios: ['r1.png', 'r2.png', 'r3.png'] },
  // Full-text search ranks the testimonials document first for a bare "Si"
  // (its own instructions contain the word) — the bug being fixed.
  fts: [
    { id: 'c-test', document_id: 'testimonios' },
    { id: 'c-tema', document_id: 'temario' },
  ],
  rpcCalls: 0,
  sent: [],
})

const urls = (r: { url: string }[]) => r.map((x) => x.url)

describe('findKnowledgeMedia — only when asked, never twice', () => {
  it('a bare confirmation never picks a file and does not even query', async () => {
    const w = base()
    expect(await findKnowledgeMedia(fakeDb(w), 'a', 'Si')).toEqual([])
    expect(await findKnowledgeMedia(fakeDb(w), 'a', 'Ok gracias')).toEqual([])
    expect(w.rpcCalls).toBe(0)
  })

  it('sends the gated testimonials when the customer writes a trigger word', async () => {
    const r = await findKnowledgeMedia(fakeDb(base()), 'a', '¿es confiable?')
    expect(urls(r)).toEqual(['r1.png', 'r2.png', 'r3.png'])
  })

  it('does not send gated files through the fuzzy search, even when they rank first', async () => {
    const w = base()
    // Not trivial, no trigger, but FTS still ranks the testimonials first.
    const r = await findKnowledgeMedia(fakeDb(w), 'a', 'que incluye el curso')
    expect(urls(r)).toEqual(['t1.png']) // falls to the un-gated temario doc
  })

  it('never resends a file that was already sent in the conversation', async () => {
    const r = await findKnowledgeMedia(fakeDb(base()), 'a', '¿es confiable?', {
      sentUrls: new Set(['r1.png', 'r2.png', 'r3.png']),
    })
    expect(r).toEqual([])
  })

  it('sends only the files not yet sent', async () => {
    const r = await findKnowledgeMedia(fakeDb(base()), 'a', 'tienen reseñas?', { sentUrls: new Set(['r1.png']) })
    expect(urls(r)).toEqual(['r2.png', 'r3.png'])
  })

  it('does not fall through to an unrelated document when the best match was already sent', async () => {
    const w = base()
    w.fts = [{ id: 'c-tema', document_id: 'temario' }, { id: 'c-test', document_id: 'testimonios' }]
    const r = await findKnowledgeMedia(fakeDb(w), 'a', 'que incluye el curso', { sentUrls: new Set(['t1.png']) })
    expect(r).toEqual([])
  })

  it('keeps working (as before) when the trigger column does not exist yet', async () => {
    const r = await findKnowledgeMedia(fakeDb(base(), { docsThrow: true }), 'a', 'que incluye el curso')
    expect(urls(r)).toEqual(['r1.png', 'r2.png', 'r3.png']) // first-ranked doc, un-gated
  })
})

describe('loadSentMediaUrls', () => {
  it('collects the urls of files already sent', async () => {
    const w = base()
    w.sent = ['r1.png', 'r2.png', 'r1.png']
    expect([...(await loadSentMediaUrls(fakeDb(w), 'conv'))].sort()).toEqual(['r1.png', 'r2.png'])
  })
})
