import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildExportConversations, fetchAllMessages, MAX_EXPORT_BATCH, parseConversationIds } from './rows'

describe('parseConversationIds', () => {
  it('accepts a plain array of ids', () => {
    expect(parseConversationIds({ conversation_ids: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('dedupes', () => {
    expect(parseConversationIds({ conversation_ids: ['a', 'a', 'b'] })).toEqual(['a', 'b'])
  })

  it('drops non-string and blank entries', () => {
    expect(parseConversationIds({ conversation_ids: ['a', 42, '', '  ', null, 'b'] })).toEqual(['a', 'b'])
  })

  it('rejects missing, empty, non-array, or over-the-cap input', () => {
    expect(parseConversationIds(null)).toBeNull()
    expect(parseConversationIds({})).toBeNull()
    expect(parseConversationIds({ conversation_ids: [] })).toBeNull()
    expect(parseConversationIds({ conversation_ids: 'a' })).toBeNull()
    expect(parseConversationIds({ conversation_ids: Array.from({ length: MAX_EXPORT_BATCH + 1 }, (_, i) => `id${i}`) })).toBeNull()
  })

  it('accepts exactly the batch cap', () => {
    const ids = Array.from({ length: MAX_EXPORT_BATCH }, (_, i) => `id${i}`)
    expect(parseConversationIds({ conversation_ids: ids })).toEqual(ids)
  })
})

function fakeMessagesDb(totalRows: number): SupabaseClient {
  const rows = Array.from({ length: totalRows }, (_, i) => ({
    sender_type: i % 2 === 0 ? 'customer' : 'bot',
    content_type: 'text',
    content_text: `msg ${i}`,
    media_url: null,
    template_name: null,
    status: 'sent',
    created_at: new Date(2026, 0, 1, 0, i).toISOString(),
  }))
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('fetchAllMessages', () => {
  it('returns every message for a short conversation in one page', async () => {
    const msgs = await fetchAllMessages(fakeMessagesDb(5), 'conv')
    expect(msgs).toHaveLength(5)
    expect(msgs[0].content_text).toBe('msg 0')
    expect(msgs[4].content_text).toBe('msg 4')
  })

  it('pages past the 1000-row cap so a long chat exports in full', async () => {
    const msgs = await fetchAllMessages(fakeMessagesDb(1500), 'conv')
    expect(msgs).toHaveLength(1500)
    expect(msgs[999].content_text).toBe('msg 999')
    expect(msgs[1499].content_text).toBe('msg 1499')
  })

  it('stops exactly on a page-sized conversation without an extra empty request', async () => {
    const msgs = await fetchAllMessages(fakeMessagesDb(1000), 'conv')
    expect(msgs).toHaveLength(1000)
  })

  it('throws on a query error rather than returning a partial, silent result', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              range: () => Promise.resolve({ data: null, error: new Error('boom') }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
    await expect(fetchAllMessages(db, 'conv')).rejects.toThrow('boom')
  })
})

describe('buildExportConversations', () => {
  function fakeDb() {
    const convRows = [
      {
        id: 'c1',
        status: 'open',
        contact: { name: 'Ana', phone: '+521', company: 'Acme', contact_tags: [{ tags: { name: 'Calificado' } }, { tags: { name: 'Precio Dado' } }] },
      },
      {
        id: 'c2',
        status: 'closed',
        contact: { name: null, phone: '+522', company: null, contact_tags: [] },
      },
    ]
    const db = {
      from: (table: string) => {
        if (table === 'conversations') {
          return {
            select: () => ({
              eq: () => ({
                in: () => Promise.resolve({ data: convRows, error: null }),
              }),
            }),
          }
        }
        if (table === 'messages') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: () => Promise.resolve({ data: [{ sender_type: 'customer', content_type: 'text', content_text: 'hola', media_url: null, template_name: null, status: 'sent', created_at: '2026-01-01T00:00:00Z' }], error: null }),
                }),
              }),
            }),
          }
        }
        throw new Error('unexpected table ' + table)
      },
    }
    return db as unknown as SupabaseClient
  }

  it('assembles contact, tags and messages for each conversation', async () => {
    const result = await buildExportConversations(fakeDb(), 'acct', ['c1', 'c2'])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 'c1',
      status: 'open',
      contact: { name: 'Ana', phone: '+521', company: 'Acme' },
      tags: ['Calificado', 'Precio Dado'],
    })
    expect(result[0].messages).toHaveLength(1)
    expect(result[1].contact.name).toBeNull()
    expect(result[1].tags).toEqual([])
  })

  it('propagates a query error', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: new Error('x') }) }) }),
      }),
    } as unknown as SupabaseClient
    await expect(buildExportConversations(db, 'acct', ['c1'])).rejects.toThrow('x')
  })
})
