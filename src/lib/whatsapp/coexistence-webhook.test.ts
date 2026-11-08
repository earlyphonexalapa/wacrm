import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  contentTypeFor,
  handleCoexistenceChange,
  historyRows,
  isCoexistenceWebhookField,
  messageStatusFromHistory,
  placeholderText,
} from './coexistence-webhook'

type Row = Record<string, unknown>

/**
 * A small in-memory stand-in for the slice of the Supabase query builder the
 * coexistence handlers use. Enough to check what gets written, not how.
 */
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {
    whatsapp_config: [],
    contacts: [],
    conversations: [],
    messages: [],
    flow_runs: [],
    ...seed,
  }
  let ids = 0

  function from(table: string) {
    let op: 'select' | 'insert' | 'upsert' | 'update' = 'select'
    let payload: Row | Row[] = []
    let opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let single: false | 'one' | 'maybe' = false
    let limitN: number | null = null
    const filters: ((r: Row) => boolean)[] = []

    const run = () => {
      const rows = (tables[table] ??= [])
      if (op === 'insert' || op === 'upsert') {
        const inserted: Row[] = []
        for (const p of Array.isArray(payload) ? payload : [payload]) {
          if (op === 'upsert' && opts.onConflict) {
            const keys = opts.onConflict.split(',')
            if (rows.some((r) => keys.every((k) => r[k] === p[k]))) continue
          }
          const row = { id: `${table}-${++ids}`, ...p }
          rows.push(row)
          inserted.push(row)
        }
        return { data: single ? (inserted[0] ?? null) : inserted, error: null }
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of matched) Object.assign(r, payload)
        return { data: null, error: null }
      }
      const limited = limitN === null ? matched : matched.slice(0, limitN)
      return { data: single ? (limited[0] ?? null) : limited, error: null }
    }

    const q = {
      select: () => q,
      insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
      upsert: (p: Row | Row[], o?: typeof opts) => ((op = 'upsert'), (payload = p), (opts = o ?? {}), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      like: (c: string, pattern: string) => {
        const tail = pattern.replaceAll('%', '')
        filters.push((r) => String(r[c] ?? '').endsWith(tail))
        return q
      },
      or: (expr: string) => {
        const parts = expr.split(',')
        filters.push((r) =>
          parts.some((part) => {
            const [col, operator, ...rest] = part.split('.')
            const value = rest.join('.')
            if (operator === 'is') return r[col] == null
            if (operator === 'lt') {
              if (r[col] == null) return false
              // numbers compare numerically (like Postgres), timestamps as text
              return Number.isFinite(Number(value)) ? Number(r[col]) < Number(value) : String(r[col]) < value
            }
            return false
          }),
        )
        return q
      },
      order: () => q,
      limit: (n: number) => ((limitN = n), q),
      single: () => ((single = 'one'), q),
      maybeSingle: () => ((single = 'maybe'), q),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    }
    return q
  }

  return { db: { from } as unknown as SupabaseClient, tables }
}

const CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  phone_number_id: 'pn-1',
  waba_id: 'waba-1',
  history_sync_status: 'requested',
  history_sync_progress: null,
  status: 'connected',
}
const BUSINESS = '5215500000000'
const CUSTOMER = '5215512345678'
const meta = { display_phone_number: BUSINESS, phone_number_id: 'pn-1' }
const ts = (iso: string) => String(Math.floor(Date.parse(iso) / 1000))

describe('helpers', () => {
  it('recognises the four coexistence webhook fields', () => {
    for (const f of ['smb_message_echoes', 'smb_app_state_sync', 'history', 'account_update']) {
      expect(isCoexistenceWebhookField(f)).toBe(true)
    }
    expect(isCoexistenceWebhookField('messages')).toBe(false)
    expect(isCoexistenceWebhookField(undefined)).toBe(false)
  })

  it('maps WhatsApp message types onto the allowed content types', () => {
    expect(contentTypeFor('text')).toBe('text')
    expect(contentTypeFor('sticker')).toBe('image')
    expect(contentTypeFor('media_placeholder')).toBe('text')
    expect(contentTypeFor('reaction')).toBe('text')
  })

  it('uses the text or caption, else a [type] placeholder', () => {
    expect(placeholderText({ id: '1', timestamp: '0', type: 'text', text: { body: 'hola' } })).toBe('hola')
    expect(placeholderText({ id: '1', timestamp: '0', type: 'image', image: { caption: 'foto' } })).toBe('foto')
    expect(placeholderText({ id: '1', timestamp: '0', type: 'audio' })).toBe('[audio]')
    expect(placeholderText({ id: '1', timestamp: '0', type: 'media_placeholder' })).toBe('[media]')
  })

  it('maps history statuses onto the allowed message statuses', () => {
    expect(messageStatusFromHistory('delivered')).toBe('delivered')
    expect(messageStatusFromHistory('played')).toBe('read')
    expect(messageStatusFromHistory('read')).toBe('read')
    expect(messageStatusFromHistory('error')).toBe('failed')
    expect(messageStatusFromHistory('pending')).toBe('sent')
    expect(messageStatusFromHistory(undefined)).toBe('sent')
  })

  it('tells the business apart from the customer in a thread', () => {
    const rows = historyRows('conv-1', CUSTOMER, [
      { id: 'a', from: CUSTOMER, timestamp: '10', type: 'text', text: { body: 'hola' } },
      {
        id: 'b',
        from: BUSINESS,
        timestamp: '20',
        type: 'text',
        text: { body: 'buenas' },
        history_context: { status: 'read' },
      },
    ])
    expect(rows.map((r) => [r.sender_type, r.status])).toEqual([
      ['customer', 'delivered'],
      ['agent', 'read'],
    ])
  })

  it('treats a customer number in another trunk format as the customer', () => {
    const rows = historyRows('conv-1', '5215512345678', [
      { id: 'a', from: '525512345678', timestamp: '10', type: 'text', text: { body: 'x' } },
    ])
    expect(rows[0].sender_type).toBe('customer')
  })
})

describe('smb_message_echoes', () => {
  const echo = (id: string, extra: Row = {}) => ({
    field: 'smb_message_echoes',
    value: {
      metadata: meta,
      message_echoes: [
        {
          id,
          from: BUSINESS,
          to: CUSTOMER,
          timestamp: ts('2026-11-01T15:00:00Z'),
          type: 'text',
          text: { body: 'Aquí tienes la info' },
          ...extra,
        },
      ],
    },
  })

  it('stores what the owner typed on the phone as an agent message', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })

    await handleCoexistenceChange(echo('wamid.1'), { db })

    expect(tables.contacts).toHaveLength(1)
    expect(tables.conversations).toHaveLength(1)
    expect(tables.messages).toHaveLength(1)
    expect(tables.messages[0]).toMatchObject({
      sender_type: 'agent',
      content_text: 'Aquí tienes la info',
      message_id: 'wamid.1',
      status: 'sent',
      created_at: '2026-11-01T15:00:00.000Z',
    })
    expect(tables.conversations[0]).toMatchObject({
      last_message_text: 'Aquí tienes la info',
      last_message_at: '2026-11-01T15:00:00.000Z',
    })
  })

  it('does not count it as unread and does not touch routing', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(echo('wamid.1'), { db })
    expect(tables.conversations[0]).not.toHaveProperty('unread_count')
    expect(tables.conversations[0]).not.toHaveProperty('owner_agent_id')
  })

  it('stops the bot talking over the owner', async () => {
    const { db, tables } = fakeDb({
      whatsapp_config: [{ ...CONFIG }],
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', contact_id: 'contacts-1', status: 'active' }],
    })
    await handleCoexistenceChange(echo('wamid.1'), { db })

    expect(tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(tables.flow_runs[0]).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' })
  })

  it('ignores a redelivered echo', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(echo('wamid.1'), { db })
    await handleCoexistenceChange(echo('wamid.1'), { db })
    expect(tables.messages).toHaveLength(1)
  })

  it('uses an existing contact instead of creating a second one', async () => {
    const { db, tables } = fakeDb({
      whatsapp_config: [{ ...CONFIG }],
      contacts: [{ id: 'c-1', account_id: 'acct-1', phone: `+${CUSTOMER}`, name: 'Ana' }],
    })
    await handleCoexistenceChange(echo('wamid.1'), { db })
    expect(tables.contacts).toHaveLength(1)
    expect(tables.conversations[0].contact_id).toBe('c-1')
  })

  it('skips an echo for a number nobody connected', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [] })
    await handleCoexistenceChange(echo('wamid.1'), { db })
    expect(tables.messages).toHaveLength(0)
    expect(tables.contacts).toHaveLength(0)
  })

  it('stores an attachment echo through the supplied media hook', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(
      echo('wamid.2', { type: 'image', text: undefined, image: { id: 'm1', mime_type: 'image/jpeg' } }),
      {
        db,
        parseEchoContent: async () => ({
          contentText: null,
          mediaUrl: 'https://cdn/x.jpg',
          mediaType: 'image/jpeg',
        }),
      },
    )
    expect(tables.messages[0]).toMatchObject({
      content_type: 'image',
      media_url: 'https://cdn/x.jpg',
      media_type: 'image/jpeg',
    })
    expect(tables.conversations[0].last_message_text).toBe('[image]')
  })

  it('falls back to a placeholder when the media hook fails', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(
      echo('wamid.3', { type: 'audio', text: undefined, audio: { id: 'a1' } }),
      {
        db,
        parseEchoContent: async () => {
          throw new Error('Meta down')
        },
      },
    )
    expect(tables.messages[0].content_text).toBe('[audio]')
  })
})

describe('history', () => {
  const history = (progress: number, messages: Row[], phase = 0) => ({
    field: 'history',
    value: {
      metadata: meta,
      history: [
        {
          metadata: { phase, chunk_order: 1, progress },
          threads: [{ id: CUSTOMER, messages }],
        },
      ],
    },
  })

  const msgs = [
    { id: 'h1', from: CUSTOMER, timestamp: ts('2026-09-01T10:00:00Z'), type: 'text', text: { body: 'hola' } },
    {
      id: 'h2',
      from: BUSINESS,
      timestamp: ts('2026-09-01T10:05:00Z'),
      type: 'text',
      text: { body: 'buenas tardes' },
      history_context: { status: 'delivered' },
    },
  ]

  it('imports the chat with its real dates and senders', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })

    await handleCoexistenceChange(history(50, msgs), { db })

    expect(tables.messages.map((m) => [m.message_id, m.sender_type])).toEqual([
      ['h1', 'customer'],
      ['h2', 'agent'],
    ])
    // The contact and chat carry the date of the first message, not "today".
    expect(tables.contacts[0].created_at).toBe('2026-09-01T10:00:00.000Z')
    expect(tables.conversations[0].created_at).toBe('2026-09-01T10:00:00.000Z')
    expect(tables.conversations[0]).toMatchObject({
      last_message_text: 'buenas tardes',
      last_message_at: '2026-09-01T10:05:00.000Z',
    })
    expect(tables.conversations[0]).not.toHaveProperty('unread_count')
  })

  it('records progress and marks the sync complete at 100', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })

    await handleCoexistenceChange(history(40, msgs), { db })
    expect(tables.whatsapp_config[0]).toMatchObject({ history_sync_progress: 40, history_sync_status: 'in_progress' })

    await handleCoexistenceChange(history(100, []), { db })
    expect(tables.whatsapp_config[0]).toMatchObject({ history_sync_progress: 100, history_sync_status: 'complete' })
  })

  it('never lets progress move backwards when chunks arrive out of order', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG, history_sync_progress: 80 }] })
    await handleCoexistenceChange(history(30, msgs), { db })
    expect(tables.whatsapp_config[0].history_sync_progress).toBe(80)
  })

  it('does not duplicate messages when a chunk is delivered twice', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(history(40, msgs), { db })
    await handleCoexistenceChange(history(40, msgs), { db })
    expect(tables.messages).toHaveLength(2)
    expect(tables.contacts).toHaveLength(1)
  })

  it('keeps a newer last message when an older chunk arrives later', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(history(40, msgs), { db })
    await handleCoexistenceChange(
      history(60, [
        { id: 'h0', from: CUSTOMER, timestamp: ts('2026-08-01T10:00:00Z'), type: 'text', text: { body: 'viejo' } },
      ]),
      { db },
    )
    expect(tables.conversations[0].last_message_text).toBe('buenas tardes')
  })

  it('records that the owner declined to share history', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(
      {
        field: 'history',
        value: { metadata: meta, history: [{ errors: [{ code: 2593109, title: 'History sync is turned off' }] }] },
      },
      { db },
    )
    expect(tables.whatsapp_config[0].history_sync_status).toBe('declined')
  })
})

describe('smb_app_state_sync', () => {
  const sync = (action: string, fullName: string, phone = CUSTOMER) => ({
    field: 'smb_app_state_sync',
    value: {
      metadata: meta,
      state_sync: [{ type: 'contact', action, contact: { full_name: fullName, phone_number: phone } }],
    },
  })

  it('names a known contact that only shows its number', async () => {
    const { db, tables } = fakeDb({
      whatsapp_config: [{ ...CONFIG }],
      contacts: [{ id: 'c-1', account_id: 'acct-1', phone: `+${CUSTOMER}`, name: `+${CUSTOMER}` }],
    })
    await handleCoexistenceChange(sync('add', 'Pablo Morales'), { db })
    expect(tables.contacts[0].name).toBe('Pablo Morales')
  })

  it('leaves a name someone already chose alone', async () => {
    const { db, tables } = fakeDb({
      whatsapp_config: [{ ...CONFIG }],
      contacts: [{ id: 'c-1', account_id: 'acct-1', phone: `+${CUSTOMER}`, name: 'Pablo (VIP)' }],
    })
    await handleCoexistenceChange(sync('add', 'Pablo Morales'), { db })
    expect(tables.contacts[0].name).toBe('Pablo (VIP)')
  })

  it('does not import the phone address book as new CRM contacts', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(sync('add', 'Pablo Morales'), { db })
    expect(tables.contacts).toHaveLength(0)
  })

  it('ignores removals', async () => {
    const { db, tables } = fakeDb({
      whatsapp_config: [{ ...CONFIG }],
      contacts: [{ id: 'c-1', account_id: 'acct-1', phone: `+${CUSTOMER}`, name: `+${CUSTOMER}` }],
    })
    await handleCoexistenceChange(sync('remove', ''), { db })
    expect(tables.contacts).toHaveLength(1)
    expect(tables.contacts[0].name).toBe(`+${CUSTOMER}`)
  })
})

describe('account_update', () => {
  const update = (event: string) => ({
    field: 'account_update',
    value: { event, waba_info: { waba_id: 'waba-1' } },
  })

  it('marks the number disconnected when it is removed or offboarded', async () => {
    for (const event of ['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED']) {
      const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
      await handleCoexistenceChange(update(event), { db })
      expect(tables.whatsapp_config[0].status).toBe('disconnected')
    }
  })

  it('marks it connected again when it is reconnected', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG, status: 'disconnected' }] })
    await handleCoexistenceChange(update('ACCOUNT_RECONNECTED'), { db })
    expect(tables.whatsapp_config[0].status).toBe('connected')
  })

  it('ignores other account events', async () => {
    const { db, tables } = fakeDb({ whatsapp_config: [{ ...CONFIG }] })
    await handleCoexistenceChange(update('PHONE_NUMBER_NAME_UPDATE'), { db })
    expect(tables.whatsapp_config[0].status).toBe('connected')
  })
})
