import { describe, expect, it } from 'vitest'
import { RESYNC_AFTER_AWAY_MS, shouldResyncAfterAway } from './resync'

describe('shouldResyncAfterAway', () => {
  it('skips a quick alt-tab', () => {
    expect(shouldResyncAfterAway(1_000, 1_000 + 5_000)).toBe(false)
    expect(shouldResyncAfterAway(1_000, 1_000 + RESYNC_AFTER_AWAY_MS - 1)).toBe(false)
  })

  it('refetches after a real absence', () => {
    expect(shouldResyncAfterAway(1_000, 1_000 + RESYNC_AFTER_AWAY_MS)).toBe(true)
    expect(shouldResyncAfterAway(0, 10 * 60_000)).toBe(true)
  })

  it('refetches when we never saw the tab hide (be safe)', () => {
    expect(shouldResyncAfterAway(null, 5)).toBe(true)
  })

  it('honours a custom threshold', () => {
    expect(shouldResyncAfterAway(0, 9_000, 10_000)).toBe(false)
    expect(shouldResyncAfterAway(0, 10_000, 10_000)).toBe(true)
  })
})
