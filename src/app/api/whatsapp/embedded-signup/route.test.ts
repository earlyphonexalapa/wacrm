import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---- mocks -------------------------------------------------------------------------

// vi.mock factories are hoisted above the imports, so what they (and the tests)
// share has to be hoisted too.
const { saved, state, coex } = vi.hoisted(() => ({
  saved: {
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
  },
  state: {
    existingRow: null as Record<string, unknown> | null,
    claimedRow: null as Record<string, unknown> | null,
  },
  coex: {
    exchangeCodeForToken: vi.fn(),
    listWabaPhoneNumbers: vi.fn(),
    getPhoneNumberDetails: vi.fn(),
    subscribeAppToWaba: vi.fn(),
    requestSmbAppDataSync: vi.fn(),
  },
}))

const supabase = {
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: state.existingRow, error: null }),
      update: (row: Record<string, unknown>) => {
        saved.updates.push(row)
        return { eq: async () => ({ error: null }) }
      },
      insert: async (row: Record<string, unknown>) => {
        saved.inserts.push(row)
        return { error: null }
      },
    }
    return q
  },
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase, accountId: 'acct-1', userId: 'user-1' })),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('limited', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const q = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      maybeSingle: async () => ({ data: state.claimedRow, error: null }),
    }
    return { from: () => q }
  },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc(${v})` }))

vi.mock('@/lib/whatsapp/coexistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/coexistence')>()),
  ...coex,
}))

import { GET, POST } from './route'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/whatsapp/embedded-signup', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  saved.updates = []
  saved.inserts = []
  state.existingRow = null
  state.claimedRow = null
  vi.stubEnv('META_APP_ID', 'app-1')
  vi.stubEnv('META_APP_SECRET', 'secret-1')
  vi.stubEnv('META_ES_CONFIG_ID', 'cfg-1')
  Object.values(coex).forEach((fn) => fn.mockReset())
  coex.exchangeCodeForToken.mockResolvedValue({ accessToken: 'biz-token', expiresIn: null })
  coex.listWabaPhoneNumbers.mockResolvedValue([{ id: 'pn-1', is_on_biz_app: true }])
  coex.getPhoneNumberDetails.mockResolvedValue({
    id: 'pn-1',
    display_phone_number: '+52 55 0000 0000',
    verified_name: 'EarlyAcademy',
    is_on_biz_app: true,
  })
  coex.subscribeAppToWaba.mockResolvedValue(undefined)
  coex.requestSmbAppDataSync.mockResolvedValue('req-1')
})

describe('GET /api/whatsapp/embedded-signup', () => {
  it('hands the browser the ids it needs, never the secret', async () => {
    const body = await (await GET()).json()
    expect(body).toEqual({ configured: true, missing: [], appId: 'app-1', configId: 'cfg-1' })
    expect(JSON.stringify(body)).not.toContain('secret-1')
  })

  it('lists what is still missing from the environment', async () => {
    vi.stubEnv('META_ES_CONFIG_ID', '')
    const body = await (await GET()).json()
    expect(body.configured).toBe(false)
    expect(body.missing).toEqual(['META_ES_CONFIG_ID'])
  })
})

describe('POST /api/whatsapp/embedded-signup', () => {
  it('refuses until Meta is configured on the server', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    const res = await post({ code: 'c', waba_id: 'w1' })
    expect(res.status).toBe(503)
    expect(coex.exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('needs the code from the popup', async () => {
    const res = await post({ waba_id: 'w1' })
    expect(res.status).toBe(400)
  })

  it('connects the number, never calls /register, and requests both syncs', async () => {
    const res = await post({ code: 'c', waba_id: 'w1' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(coex.listWabaPhoneNumbers).toHaveBeenCalledWith({ wabaId: 'w1', accessToken: 'biz-token' })
    expect(coex.subscribeAppToWaba).toHaveBeenCalledWith({ wabaId: 'w1', accessToken: 'biz-token' })
    expect(coex.requestSmbAppDataSync.mock.calls.map((c) => c[0].syncType)).toEqual([
      'smb_app_state_sync',
      'history',
    ])
    expect(body.sync).toEqual({ contacts: 'requested', history: 'requested' })

    expect(saved.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      phone_number_id: 'pn-1',
      waba_id: 'w1',
      access_token: 'enc(biz-token)',
      status: 'connected',
      coexistence: true,
    })
    expect(saved.inserts[0].registered_at).toBeTruthy()
    // The sync timestamps are recorded afterwards.
    expect(saved.updates[0]).toMatchObject({ history_sync_status: 'requested' })
    expect(saved.updates[0].contacts_sync_requested_at).toBeTruthy()
  })

  it('uses the phone number the popup reported without listing the account', async () => {
    await post({ code: 'c', waba_id: 'w1', phone_number_id: 'pn-9' })
    expect(coex.listWabaPhoneNumbers).not.toHaveBeenCalled()
    expect(coex.getPhoneNumberDetails).toHaveBeenCalledWith({ phoneNumberId: 'pn-9', accessToken: 'biz-token' })
  })

  it('tells the admin when Meta rejects the code', async () => {
    coex.exchangeCodeForToken.mockRejectedValue(new Error('This authorization code has expired.'))
    const res = await post({ code: 'c', waba_id: 'w1' })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain('This authorization code has expired.')
    expect(saved.inserts).toHaveLength(0)
  })

  it('refuses a number another account already uses', async () => {
    state.claimedRow = { account_id: 'other' }
    const res = await post({ code: 'c', waba_id: 'w1' })
    expect(res.status).toBe(409)
    expect(saved.inserts).toHaveLength(0)
  })

  it('replaces an existing connection and starts a new number’s sync from scratch', async () => {
    state.existingRow = {
      id: 'row-1',
      phone_number_id: 'old-number',
      contacts_sync_requested_at: '2026-01-01T00:00:00Z',
      history_sync_requested_at: '2026-01-01T00:00:00Z',
    }
    await post({ code: 'c', waba_id: 'w1' })

    expect(saved.inserts).toHaveLength(0)
    expect(saved.updates[0]).toMatchObject({
      phone_number_id: 'pn-1',
      contacts_sync_requested_at: null,
      history_sync_requested_at: null,
      history_sync_status: 'none',
    })
    expect(coex.requestSmbAppDataSync).toHaveBeenCalledTimes(2)
  })

  it('does not ask Meta twice for the same number (each sync is allowed once)', async () => {
    state.existingRow = {
      id: 'row-1',
      phone_number_id: 'pn-1',
      contacts_sync_requested_at: '2026-11-01T00:00:00Z',
      history_sync_requested_at: '2026-11-01T00:00:00Z',
    }
    const body = await (await post({ code: 'c', waba_id: 'w1' })).json()

    expect(coex.requestSmbAppDataSync).not.toHaveBeenCalled()
    expect(body.sync).toEqual({ contacts: 'already', history: 'already' })
  })

  it('warns and skips the sync when the number is not in the phone app', async () => {
    coex.getPhoneNumberDetails.mockResolvedValue({ id: 'pn-1', is_on_biz_app: false })
    const body = await (await post({ code: 'c', waba_id: 'w1' })).json()

    expect(coex.requestSmbAppDataSync).not.toHaveBeenCalled()
    expect(saved.inserts[0].coexistence).toBe(false)
    expect(body.warnings.join(' ')).toContain('app WhatsApp Business')
  })

  it('still saves the connection when a sync request fails, and says so', async () => {
    coex.requestSmbAppDataSync.mockRejectedValue(new Error('window closed'))
    const res = await post({ code: 'c', waba_id: 'w1' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.sync).toEqual({ contacts: 'failed', history: 'failed' })
    expect(body.warnings.length).toBe(2)
    expect(saved.inserts).toHaveLength(1)
  })
})
