import { describe, expect, it } from 'vitest'
import {
  addDays,
  bucketPoints,
  daysBetween,
  parseStoredSelection,
  percentChange,
  pickGranularity,
  resolvePeriod,
  sumPoints,
  validateCustomRange,
} from './period'
import type { PeriodDayPoint } from './types'

// Local noon avoids any DST edge on the test machine.
const NOW = new Date(2026, 8, 20, 12, 0, 0) // 2026-09-20 local

const pt = (day: string, over: Partial<PeriodDayPoint> = {}): PeriodDayPoint => ({
  day,
  newContacts: 0,
  newConversations: 0,
  incoming: 0,
  outgoing: 0,
  ...over,
})

describe('date helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-09-20', -29)).toBe('2026-08-22')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('counts days inclusively', () => {
    expect(daysBetween('2026-09-20', '2026-09-20')).toBe(1)
    expect(daysBetween('2026-09-14', '2026-09-20')).toBe(7)
  })
})

describe('resolvePeriod', () => {
  it('today is a single day, previous is yesterday', () => {
    const r = resolvePeriod({ preset: 'today' }, NOW)
    expect(r).toMatchObject({ from: '2026-09-20', to: '2026-09-20', days: 1 })
    expect(r.previous).toEqual({ from: '2026-09-19', to: '2026-09-19' })
  })

  it('yesterday', () => {
    expect(resolvePeriod({ preset: 'yesterday' }, NOW)).toMatchObject({ from: '2026-09-19', to: '2026-09-19' })
  })

  it.each([
    ['3d', '2026-09-18', 3],
    ['7d', '2026-09-14', 7],
    ['30d', '2026-08-22', 30],
    ['90d', '2026-06-23', 90],
  ] as const)('%s ends today and is inclusive', (preset, from, days) => {
    const r = resolvePeriod({ preset }, NOW)
    expect(r.from).toBe(from)
    expect(r.to).toBe('2026-09-20')
    expect(r.days).toBe(days)
  })

  it('the comparison window is equal-length and immediately before', () => {
    const r = resolvePeriod({ preset: '7d' }, NOW)
    expect(r.previous).toEqual({ from: '2026-09-07', to: '2026-09-13' })
    expect(daysBetween(r.previous!.from, r.previous!.to)).toBe(7)
  })

  it('total has no start and nothing to compare with', () => {
    expect(resolvePeriod({ preset: 'total' }, NOW)).toEqual({ from: null, to: '2026-09-20', days: null, previous: null })
  })

  it('custom uses the chosen dates', () => {
    const r = resolvePeriod({ preset: 'custom', customFrom: '2026-09-01', customTo: '2026-09-10' }, NOW)
    expect(r).toMatchObject({ from: '2026-09-01', to: '2026-09-10', days: 10 })
  })

  it('an invalid custom range falls back to the last 30 days', () => {
    const r = resolvePeriod({ preset: 'custom', customFrom: '2026-09-10', customTo: '2026-09-01' }, NOW)
    expect(r).toMatchObject({ from: '2026-08-22', to: '2026-09-20', days: 30 })
  })
})

describe('validateCustomRange', () => {
  it('accepts a normal range', () => {
    expect(validateCustomRange('2026-09-01', '2026-09-20', NOW)).toBeNull()
  })
  it('rejects bad input, reversed dates, the future and huge spans', () => {
    expect(validateCustomRange('', '2026-09-20', NOW)).toBe('invalid')
    expect(validateCustomRange('2026-02-31', '2026-09-20', NOW)).toBe('invalid')
    expect(validateCustomRange('2026-09-20', '2026-09-01', NOW)).toBe('order')
    expect(validateCustomRange('2026-09-01', '2026-09-21', NOW)).toBe('future')
    expect(validateCustomRange('2020-01-01', '2026-09-20', NOW)).toBe('too_long')
  })
})

describe('parseStoredSelection', () => {
  it('restores a valid preset', () => {
    expect(parseStoredSelection('{"preset":"7d"}', NOW)).toEqual({ preset: '7d' })
  })
  it('falls back to the default on garbage', () => {
    expect(parseStoredSelection('nope', NOW)).toEqual({ preset: '30d' })
    expect(parseStoredSelection('{"preset":"hacked"}', NOW)).toEqual({ preset: '30d' })
    expect(parseStoredSelection(null, NOW)).toEqual({ preset: '30d' })
  })
  it('drops an out-of-range saved custom selection', () => {
    expect(parseStoredSelection('{"preset":"custom","customFrom":"2026-09-10","customTo":"2026-09-01"}', NOW)).toEqual({ preset: '30d' })
    expect(parseStoredSelection('{"preset":"custom","customFrom":"2026-09-01","customTo":"2026-09-10"}', NOW)).toEqual({
      preset: 'custom',
      customFrom: '2026-09-01',
      customTo: '2026-09-10',
    })
  })
})

describe('totals and bucketing', () => {
  const days = [
    pt('2026-09-14', { newContacts: 2, incoming: 5, outgoing: 4 }), // Monday
    pt('2026-09-15', { newContacts: 3, newConversations: 1 }),
    pt('2026-09-20', { newContacts: 1, outgoing: 2 }), // Sunday, same ISO week
    pt('2026-09-21', { newContacts: 4 }), // next Monday
  ]

  it('sums every metric', () => {
    expect(sumPoints(days)).toEqual({ newContacts: 10, newConversations: 1, incoming: 5, outgoing: 6 })
  })

  it('day granularity leaves points untouched', () => {
    expect(bucketPoints(days, 'day')).toBe(days)
  })

  it('groups into Monday-start weeks', () => {
    const w = bucketPoints(days, 'week')
    expect(w.map((p) => p.day)).toEqual(['2026-09-14', '2026-09-21'])
    expect(w[0]).toMatchObject({ newContacts: 6, newConversations: 1, incoming: 5, outgoing: 6 })
    expect(w[1].newContacts).toBe(4)
  })

  it('groups into months', () => {
    const m = bucketPoints([pt('2026-08-30', { newContacts: 1 }), pt('2026-09-02', { newContacts: 2 }), pt('2026-09-28', { newContacts: 3 })], 'month')
    expect(m.map((p) => [p.day, p.newContacts])).toEqual([
      ['2026-08-01', 1],
      ['2026-09-01', 5],
    ])
  })

  it('picks a granularity that keeps charts readable', () => {
    expect(pickGranularity(30)).toBe('day')
    expect(pickGranularity(92)).toBe('day')
    expect(pickGranularity(200)).toBe('week')
    expect(pickGranularity(700)).toBe('month')
  })
})

describe('percentChange', () => {
  it('computes a rounded percentage', () => {
    expect(percentChange(150, 100)).toBe(50)
    expect(percentChange(50, 100)).toBe(-50)
  })
  it('has no answer without a base', () => {
    expect(percentChange(5, 0)).toBeNull()
  })
})
