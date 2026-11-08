import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  coexistenceGraphBase,
  exchangeCodeForToken,
  parseSignupData,
  pickCoexistenceNumber,
  requestSmbAppDataSync,
} from './coexistence'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('parseSignupData', () => {
  it('reads the classic shape (waba_id + phone_number_id)', () => {
    expect(
      parseSignupData({ waba_id: 'w1', phone_number_id: 'p1', business_id: 'b1' }),
    ).toEqual({ wabaId: 'w1', phoneNumberId: 'p1', businessId: 'b1' })
  })

  it('reads the version-5 shape (messaging_account_ids)', () => {
    expect(
      parseSignupData({
        phone_number_id: 'p1',
        messaging_account_ids: ['m1'],
        is_on_biz_app: true,
        business_id: 'b1',
      }),
    ).toEqual({ wabaId: 'm1', phoneNumberId: 'p1', businessId: 'b1' })
  })

  it('accepts a coexistence completion that only names the account', () => {
    expect(parseSignupData({ waba_id: 'w1' })).toEqual({
      wabaId: 'w1',
      phoneNumberId: null,
      businessId: null,
    })
  })

  it('falls back to the first of waba_ids and tolerates junk', () => {
    expect(parseSignupData({ waba_ids: ['w9', 'w10'] }).wabaId).toBe('w9')
    expect(parseSignupData(null)).toEqual({ wabaId: null, phoneNumberId: null, businessId: null })
    expect(parseSignupData('nope')).toEqual({ wabaId: null, phoneNumberId: null, businessId: null })
  })
})

describe('pickCoexistenceNumber', () => {
  it('prefers the number that is also in the phone app', () => {
    const picked = pickCoexistenceNumber([
      { id: 'a', is_on_biz_app: false },
      { id: 'b', is_on_biz_app: true },
    ])
    expect(picked?.id).toBe('b')
  })

  it('takes the only number when none is flagged', () => {
    expect(pickCoexistenceNumber([{ id: 'a' }])?.id).toBe('a')
  })

  it('does not guess between several unflagged numbers', () => {
    expect(pickCoexistenceNumber([{ id: 'a' }, { id: 'b' }])).toBeNull()
  })

  it('returns null for an empty account', () => {
    expect(pickCoexistenceNumber([])).toBeNull()
  })
})

describe('Graph calls', () => {
  it('uses the configured API version', () => {
    expect(coexistenceGraphBase()).toBe('https://graph.facebook.com/v27.0')
    vi.stubEnv('META_COEXISTENCE_API_VERSION', 'v30.0')
    expect(coexistenceGraphBase()).toBe('https://graph.facebook.com/v30.0')
  })

  it('exchanges the code for a token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok', expires_in: 5000 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await exchangeCodeForToken({ code: 'c', appId: 'app', appSecret: 'sec' })

    expect(result).toEqual({ accessToken: 'tok', expiresIn: 5000 })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/oauth/access_token')
    expect(url).toContain('client_id=app')
    expect(url).toContain('code=c')
  })

  it('surfaces Meta’s message when the code is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'This authorization code has expired.' } }),
      }),
    )
    await expect(exchangeCodeForToken({ code: 'c', appId: 'a', appSecret: 's' })).rejects.toThrow(
      'This authorization code has expired.',
    )
  })

  it('asks Meta to sync the phone’s contacts or history', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ request_id: 'r1' }) })
    vi.stubGlobal('fetch', fetchMock)

    const id = await requestSmbAppDataSync({
      phoneNumberId: 'pn',
      accessToken: 'tok',
      syncType: 'history',
    })

    expect(id).toBe('r1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/pn/smb_app_data')
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' })
    expect(init.headers.Authorization).toBe('Bearer tok')
  })
})
