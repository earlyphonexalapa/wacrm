import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  sendWhatsAppConversionEvent: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mocks.decrypt,
}))

vi.mock('@/lib/meta/capi', () => ({
  sendWhatsAppConversionEvent: mocks.sendWhatsAppConversionEvent,
}))

import { sendCapiAttributionForTag } from './capi-attribution'

type TableResponse = { data: unknown; error?: unknown }

function makeDb(responses: Record<string, TableResponse>): SupabaseClient {
  return {
    from(table: string) {
      const result = responses[table] ?? { data: null }
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => result }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

const CONFIGURED = {
  capi_access_token: 'enc(token)',
  capi_dataset_id: 'dataset-1',
  waba_id: 'waba-1',
}

beforeEach(() => {
  mocks.decrypt.mockReset().mockReturnValue('plain-token')
  mocks.sendWhatsAppConversionEvent.mockReset().mockResolvedValue(undefined)
})

describe('sendCapiAttributionForTag', () => {
  it('does nothing for a tag other than "Pagado"', async () => {
    const db = makeDb({ tags: { data: { name: 'Interesado' } } })

    const result = await sendCapiAttributionForTag({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    })

    expect(result).toEqual({ sent: false, reason: 'tag_not_configured' })
    expect(mocks.sendWhatsAppConversionEvent).not.toHaveBeenCalled()
  })

  it('matches the "Pagado" tag case-insensitively with stray whitespace', async () => {
    const db = makeDb({
      tags: { data: { name: '  pagado ' } },
      whatsapp_config: { data: CONFIGURED },
      contacts: { data: { ctwa_clid: 'clid-1' } },
    })

    const result = await sendCapiAttributionForTag({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    })

    expect(result).toEqual({ sent: true })
  })

  it('skips when the account has no CAPI dataset/token configured', async () => {
    const db = makeDb({
      tags: { data: { name: 'Pagado' } },
      whatsapp_config: { data: { capi_access_token: null, capi_dataset_id: null } },
    })

    const result = await sendCapiAttributionForTag({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    })

    expect(result).toEqual({ sent: false, reason: 'capi_not_configured' })
    expect(mocks.sendWhatsAppConversionEvent).not.toHaveBeenCalled()
  })

  it('skips when the contact never arrived via a click-to-WhatsApp ad', async () => {
    const db = makeDb({
      tags: { data: { name: 'Pagado' } },
      whatsapp_config: { data: CONFIGURED },
      contacts: { data: { ctwa_clid: null } },
    })

    const result = await sendCapiAttributionForTag({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    })

    expect(result).toEqual({ sent: false, reason: 'no_ctwa_clid' })
    expect(mocks.sendWhatsAppConversionEvent).not.toHaveBeenCalled()
  })

  it('decrypts the stored token and sends a Purchase event with the clid + waba id', async () => {
    const db = makeDb({
      tags: { data: { name: 'Pagado' } },
      whatsapp_config: { data: CONFIGURED },
      contacts: { data: { ctwa_clid: 'clid-1' } },
    })

    const result = await sendCapiAttributionForTag({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    })

    expect(result).toEqual({ sent: true })
    expect(mocks.decrypt).toHaveBeenCalledWith('enc(token)')
    expect(mocks.sendWhatsAppConversionEvent).toHaveBeenCalledWith({
      datasetId: 'dataset-1',
      accessToken: 'plain-token',
      eventName: 'Purchase',
      ctwaClid: 'clid-1',
      wabaId: 'waba-1',
    })
  })

  it('swallows a send failure and reports send_failed', async () => {
    mocks.sendWhatsAppConversionEvent.mockRejectedValue(new Error('Meta said no'))
    const db = makeDb({
      tags: { data: { name: 'Pagado' } },
      whatsapp_config: { data: CONFIGURED },
      contacts: { data: { ctwa_clid: 'clid-1' } },
    })

    await expect(
      sendCapiAttributionForTag({
        db,
        accountId: 'acct-1',
        contactId: 'contact-1',
        tagId: 'tag-1',
      }),
    ).resolves.toEqual({ sent: false, reason: 'send_failed' })
  })
})
