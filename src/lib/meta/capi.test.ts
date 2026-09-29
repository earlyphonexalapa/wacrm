import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCapiEventPayload, sendWhatsAppConversionEvent } from './capi'

describe('buildCapiEventPayload', () => {
  it('builds a business_messaging/whatsapp event with the given clid', () => {
    const payload = buildCapiEventPayload({
      eventName: 'Purchase',
      ctwaClid: 'clid-123',
      eventTime: 1700000000,
    })

    expect(payload).toEqual({
      data: [
        {
          event_name: 'Purchase',
          event_time: 1700000000,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: { ctwa_clid: 'clid-123' },
        },
      ],
    })
  })

  it('includes the WABA id in user_data when provided', () => {
    const payload = buildCapiEventPayload({
      eventName: 'Purchase',
      ctwaClid: 'clid-123',
      wabaId: 'waba-456',
      eventTime: 1700000000,
    })

    expect(payload.data[0].user_data).toEqual({
      ctwa_clid: 'clid-123',
      whatsapp_business_account_id: 'waba-456',
    })
  })

  it('omits whatsapp_business_account_id when wabaId is null or absent', () => {
    const payload = buildCapiEventPayload({
      eventName: 'Purchase',
      ctwaClid: 'clid-123',
      wabaId: null,
      eventTime: 1700000000,
    })

    expect(payload.data[0].user_data).toEqual({ ctwa_clid: 'clid-123' })
  })

  it('defaults event_time to now when not given', () => {
    const before = Math.floor(Date.now() / 1000)
    const payload = buildCapiEventPayload({
      eventName: 'Purchase',
      ctwaClid: 'clid-123',
    })
    const after = Math.floor(Date.now() / 1000)

    expect(payload.data[0].event_time).toBeGreaterThanOrEqual(before)
    expect(payload.data[0].event_time).toBeLessThanOrEqual(after)
  })
})

describe('sendWhatsAppConversionEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to /{datasetId}/events with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    await sendWhatsAppConversionEvent({
      datasetId: 'dataset-1',
      accessToken: 'token-1',
      eventName: 'Purchase',
      ctwaClid: 'clid-123',
      eventTime: 1700000000,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/dataset-1/events')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer token-1')
    expect(JSON.parse(init.body)).toEqual({
      data: [
        {
          event_name: 'Purchase',
          event_time: 1700000000,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: { ctwa_clid: 'clid-123' },
        },
      ],
    })
  })

  it('throws Meta\'s error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'Invalid dataset id' } }),
      }),
    )

    await expect(
      sendWhatsAppConversionEvent({
        datasetId: 'bad-dataset',
        accessToken: 'token-1',
        eventName: 'Purchase',
        ctwaClid: 'clid-123',
      }),
    ).rejects.toThrow('Invalid dataset id')
  })

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json')
        },
      }),
    )

    await expect(
      sendWhatsAppConversionEvent({
        datasetId: 'dataset-1',
        accessToken: 'token-1',
        eventName: 'Purchase',
        ctwaClid: 'clid-123',
      }),
    ).rejects.toThrow('Meta Conversions API error: 500')
  })
})
