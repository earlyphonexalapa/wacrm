import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAdCampaign, listCampaigns, MetaAdsError, validateAdsToken } from './ads'

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchAdCampaign', () => {
  it('asks Graph for the ad\'s campaign with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: 'ad-1', campaign_id: '777', campaign: { id: '777', name: 'CBO 1 - WhatsApp Pedro' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const campaign = await fetchAdCampaign('ad-1', 'tok')

    expect(campaign).toEqual({ id: '777', name: 'CBO 1 - WhatsApp Pedro' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('https://graph.facebook.com/v21.0/ad-1?')
    expect(decodeURIComponent(url as string)).toContain('fields=campaign_id,campaign{name}')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('returns null when Meta reports no campaign', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'ad-1' })))
    expect(await fetchAdCampaign('ad-1', 'tok')).toBeNull()
  })

  it('throws Meta\'s message on an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'Invalid OAuth access token.' } }, false, 400)),
    )
    await expect(fetchAdCampaign('ad-1', 'bad')).rejects.toThrow('Invalid OAuth access token.')
  })

  it('throws a MetaAdsError when the request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
      ),
    )
    const promise = fetchAdCampaign('ad-1', 'tok', 10)
    await expect(promise).rejects.toBeInstanceOf(MetaAdsError)
    await expect(promise).rejects.toThrow('timed out')
  })
})

describe('listCampaigns / validateAdsToken', () => {
  it('lists campaigns across the ad accounts the token can read', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/me/adaccounts')) {
        return jsonResponse({ data: [{ id: 'act_1', name: 'Cuenta 1' }] })
      }
      if (url.includes('/act_1/campaigns')) {
        return jsonResponse({ data: [{ id: 'c1', name: 'WhatsApp Pedro', effective_status: 'ACTIVE' }] })
      }
      return jsonResponse({}, false, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await listCampaigns('tok')).toEqual([
      { id: 'c1', name: 'WhatsApp Pedro', status: 'ACTIVE', adAccountId: 'act_1', adAccountName: 'Cuenta 1' },
    ])
    expect(await validateAdsToken('tok')).toEqual({ adAccounts: 1 })
  })

  it('asks for switched-on campaigns only unless paused ones are requested', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(decodeURIComponent(url));
        if (url.includes('/me/adaccounts')) return jsonResponse({ data: [{ id: 'act_1', name: 'Cuenta 1' }] });
        return jsonResponse({ data: [] });
      }),
    );

    await listCampaigns('tok');
    await listCampaigns('tok', { includePaused: true });

    const campaignCalls = urls.filter((u) => u.includes('/act_1/campaigns'));
    expect(campaignCalls[0]).toContain('effective_status=["ACTIVE"]');
    expect(campaignCalls[1]).toContain('effective_status=["ACTIVE","PAUSED"]');
  });

  it('falls back to the assigned-accounts edge for system-user tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/me/assigned_ad_accounts')
          ? jsonResponse({ data: [{ id: 'act_2', name: 'Cuenta 2' }] })
          : jsonResponse({ data: [] }),
      ),
    )
    expect(await validateAdsToken('tok')).toEqual({ adAccounts: 1 })
  })

  it('keeps going when one ad account\'s campaigns cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/me/adaccounts')) return jsonResponse({ data: [{ id: 'act_1' }, { id: 'act_2' }] })
        if (url.includes('/act_1/campaigns')) return jsonResponse({ error: { message: 'no access' } }, false, 403)
        return jsonResponse({ data: [{ id: 'c2', name: 'Otra', effective_status: 'PAUSED' }] })
      }),
    )
    const campaigns = await listCampaigns('tok')
    expect(campaigns.map((c) => c.id)).toEqual(['c2'])
  })
})
