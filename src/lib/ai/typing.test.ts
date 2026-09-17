import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  markMessageAsRead: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: h.decrypt }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ markMessageAsRead: h.markMessageAsRead }))

import { showTypingIndicator } from './typing'

interface FakeState {
  lastMessage: { message_id: string } | null
  config: { phone_number_id: string; access_token: string } | null
}

function makeDb(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    lastMessage: { message_id: 'wamid.ABC' },
    config: { phone_number_id: 'pn-1', access_token: 'enc-token' },
    ...overrides,
  }
  const db = {
    from: (table: string) => {
      if (table === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () => Promise.resolve({ data: state.lastMessage, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: state.config, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
  return db as unknown as SupabaseClient
}

const ARGS = { accountId: 'acct-1', conversationId: 'conv-1' }

beforeEach(() => {
  h.decrypt.mockClear()
  h.markMessageAsRead.mockReset()
  h.markMessageAsRead.mockResolvedValue(undefined)
})

describe('showTypingIndicator', () => {
  it('marks the latest customer message as read with the typing indicator on', async () => {
    await showTypingIndicator(makeDb(), ARGS)
    expect(h.markMessageAsRead).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'decrypted:enc-token',
      messageId: 'wamid.ABC',
      showTypingIndicator: true,
    })
  })

  it('does nothing when there is no customer message yet', async () => {
    await showTypingIndicator(makeDb({ lastMessage: null }), ARGS)
    expect(h.markMessageAsRead).not.toHaveBeenCalled()
  })

  it('does nothing when WhatsApp is not configured for the account', async () => {
    await showTypingIndicator(makeDb({ config: null }), ARGS)
    expect(h.markMessageAsRead).not.toHaveBeenCalled()
  })

  it('swallows a Meta API failure rather than throwing', async () => {
    h.markMessageAsRead.mockRejectedValue(new Error('meta rejected it'))
    await expect(showTypingIndicator(makeDb(), ARGS)).resolves.toBeUndefined()
  })
})
