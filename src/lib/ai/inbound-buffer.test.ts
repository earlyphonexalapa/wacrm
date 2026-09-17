import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  dispatchInboundToAiReply: vi.fn(),
  state: {
    upsertCalls: [] as Record<string, unknown>[],
    deleteCalls: [] as string[],
    selectResult: { data: [] as Record<string, unknown>[], error: null as { message: string } | null },
  },
}))
vi.mock('./auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'ai_pending_replies') throw new Error(`unexpected table: ${table}`)
      return {
        upsert: (row: Record<string, unknown>) => {
          h.state.upsertCalls.push(row)
          return Promise.resolve({ error: null })
        },
        delete: () => ({
          eq: (_col: string, val: string) => {
            h.state.deleteCalls.push(val)
            return Promise.resolve({ error: null })
          },
        }),
        select: () => Promise.resolve(h.state.selectResult),
      }
    },
  }),
}))

import { scheduleAiAutoReply, recoverPendingAiReplies, _resetPendingForTests } from './inbound-buffer'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

beforeEach(() => {
  vi.useFakeTimers()
  h.dispatchInboundToAiReply.mockReset()
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.state.upsertCalls = []
  h.state.deleteCalls = []
  h.state.selectResult = { data: [], error: null }
})

afterEach(() => {
  _resetPendingForTests()
  vi.useRealTimers()
})

describe('scheduleAiAutoReply', () => {
  it('dispatches once after the debounce window elapses', async () => {
    scheduleAiAutoReply(ARGS)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(ARGS)
  })

  it('collapses a burst of messages on the same conversation into one dispatch', async () => {
    scheduleAiAutoReply(ARGS)
    await vi.advanceTimersByTimeAsync(2000)
    scheduleAiAutoReply(ARGS) // "informacion del curso" arrives — resets the timer
    await vi.advanceTimersByTimeAsync(2000)
    scheduleAiAutoReply(ARGS) // "porfavor" arrives — resets it again
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled() // still within the window

    await vi.advanceTimersByTimeAsync(6000)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
  })

  it('keeps separate conversations independent', async () => {
    scheduleAiAutoReply(ARGS)
    scheduleAiAutoReply({ ...ARGS, conversationId: 'conv-2' })
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(2)
  })

  it('persists a durable marker so a restart mid-debounce can be recovered', async () => {
    scheduleAiAutoReply(ARGS)
    await vi.advanceTimersByTimeAsync(0) // let the fire-and-forget upsert's microtask run
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0]).toMatchObject({
      conversation_id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      config_owner_user_id: 'user-1',
    })
  })

  it('clears the durable marker once the debounced dispatch actually fires', async () => {
    scheduleAiAutoReply(ARGS)
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.state.deleteCalls).toContain('conv-1')
  })
})

describe('recoverPendingAiReplies', () => {
  it('dispatches and clears every row left over from a restart', async () => {
    h.state.selectResult = {
      data: [
        {
          conversation_id: 'conv-1',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          config_owner_user_id: 'user-1',
        },
        {
          conversation_id: 'conv-2',
          account_id: 'acct-1',
          contact_id: 'contact-2',
          config_owner_user_id: 'user-1',
        },
      ],
      error: null,
    }
    await recoverPendingAiReplies()
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(2)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(ARGS)
    expect(h.state.deleteCalls).toEqual(['conv-1', 'conv-2'])
  })

  it('does nothing when there is nothing to recover', async () => {
    await recoverPendingAiReplies()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('does not throw when the query itself fails', async () => {
    h.state.selectResult = { data: [], error: { message: 'connection refused' } }
    await expect(recoverPendingAiReplies()).resolves.toBeUndefined()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })
})
