import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('./auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }))

import { scheduleAiAutoReply, _resetPendingForTests } from './inbound-buffer'

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
})
