import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findUnreadableInbound } from './context'
import { retrievalQuery } from './query'
import type { ChatMessage } from './types'

/** Rows are given newest-first, as the query returns them. */
function dbWith(rows: { sender_type: string; content_type: string }[] | null, error: unknown = null) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order']) chain[m] = () => chain
  chain.limit = () => Promise.resolve({ data: rows, error })
  return { from: () => chain } as unknown as SupabaseClient
}

describe('findUnreadableInbound', () => {
  it('flags a voice note sent since the business last spoke', async () => {
    const db = dbWith([
      { sender_type: 'customer', content_type: 'text' }, // ".."
      { sender_type: 'customer', content_type: 'audio' }, // the voice note
      { sender_type: 'bot', content_type: 'text' },
      { sender_type: 'customer', content_type: 'image' }, // older than the bot reply → ignored
    ])
    expect(await findUnreadableInbound(db, 'c')).toBe('audio')
  })

  it('flags photos, videos, files and locations too', async () => {
    for (const t of ['image', 'video', 'document', 'location']) {
      expect(await findUnreadableInbound(dbWith([{ sender_type: 'customer', content_type: t }]), 'c')).toBe(t)
    }
  })

  it('is null when the customer only wrote text', async () => {
    const db = dbWith([
      { sender_type: 'customer', content_type: 'text' },
      { sender_type: 'customer', content_type: 'text' },
      { sender_type: 'bot', content_type: 'text' },
    ])
    expect(await findUnreadableInbound(db, 'c')).toBeNull()
  })

  it('ignores media that came BEFORE the last reply from the business', async () => {
    const db = dbWith([
      { sender_type: 'customer', content_type: 'text' },
      { sender_type: 'agent', content_type: 'text' },
      { sender_type: 'customer', content_type: 'audio' },
    ])
    expect(await findUnreadableInbound(db, 'c')).toBeNull()
  })

  it('is null on a query error or empty conversation', async () => {
    expect(await findUnreadableInbound(dbWith(null, new Error('x')), 'c')).toBeNull()
    expect(await findUnreadableInbound(dbWith([]), 'c')).toBeNull()
  })
})

describe('retrievalQuery', () => {
  const chat = (...pairs: [ChatMessage['role'], string][]): ChatMessage[] =>
    pairs.map(([role, content]) => ({ role, content }))

  it('uses the customer message when it has a topic', () => {
    expect(retrievalQuery(chat(['assistant', 'Te paso el precio?'], ['user', 'es confiable?']))).toBe('es confiable?')
  })

  it('falls back to what the business just said when the customer only confirms', () => {
    const q = retrievalQuery(chat(['assistant', '¿Quieres que te explique cómo queda el acceso completo?'], ['user', 'Si']))
    expect(q).toContain('acceso completo')
  })

  it('returns the confirmation itself when there is nothing else to go on', () => {
    expect(retrievalQuery(chat(['user', 'Ok']))).toBe('Ok')
  })
})
