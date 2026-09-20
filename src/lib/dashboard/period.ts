import { localDayKey } from './date-utils'
import type { PeriodDayPoint } from './types'

// ============================================================
// Date-filter logic for the dashboard. Pure (no React, no I/O) so it
// can be unit-tested. All dates are local calendar days as
// `YYYY-MM-DD` keys, matching how the rest of the dashboard buckets.
// ============================================================

export type PeriodPreset =
  | 'today'
  | 'yesterday'
  | '3d'
  | '7d'
  | '30d'
  | '90d'
  | 'total'
  | 'custom'

export const PERIOD_PRESETS: PeriodPreset[] = [
  'today',
  'yesterday',
  '3d',
  '7d',
  '30d',
  '90d',
  'total',
  'custom',
]

export interface PeriodSelection {
  preset: PeriodPreset
  /** Only for `custom`. */
  customFrom?: string
  customTo?: string
}

export const DEFAULT_PERIOD: PeriodSelection = { preset: '30d' }

/** Longest custom range we accept (the SQL function clamps at 3 years). */
export const MAX_CUSTOM_DAYS = 366 * 2

export interface ResolvedPeriod {
  /** null = "since the first contact" (Total). */
  from: string | null
  to: string
  /** null while it isn't known yet (Total). */
  days: number | null
  /** The equal-length window right before this one, for comparisons. */
  previous: { from: string; to: string } | null
}

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !KEY_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Inclusive number of days between two keys. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1
}

export type CustomRangeProblem = 'invalid' | 'order' | 'future' | 'too_long'

export function validateCustomRange(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): CustomRangeProblem | null {
  if (!isDateKey(from) || !isDateKey(to)) return 'invalid'
  if (from > to) return 'order'
  if (to > localDayKey(now)) return 'future'
  if (daysBetween(from, to) > MAX_CUSTOM_DAYS) return 'too_long'
  return null
}

function withPrevious(from: string, to: string): ResolvedPeriod {
  const days = daysBetween(from, to)
  const prevTo = addDays(from, -1)
  return { from, to, days, previous: { from: addDays(prevTo, -(days - 1)), to: prevTo } }
}

export function resolvePeriod(selection: PeriodSelection, now: Date = new Date()): ResolvedPeriod {
  const today = localDayKey(now)

  switch (selection.preset) {
    case 'today':
      return withPrevious(today, today)
    case 'yesterday': {
      const y = addDays(today, -1)
      return withPrevious(y, y)
    }
    case '3d':
      return withPrevious(addDays(today, -2), today)
    case '7d':
      return withPrevious(addDays(today, -6), today)
    case '30d':
      return withPrevious(addDays(today, -29), today)
    case '90d':
      return withPrevious(addDays(today, -89), today)
    case 'total':
      return { from: null, to: today, days: null, previous: null }
    case 'custom': {
      if (validateCustomRange(selection.customFrom, selection.customTo, now) === null) {
        return withPrevious(selection.customFrom as string, selection.customTo as string)
      }
      // A half-typed / invalid custom range falls back to the default
      // rather than querying nonsense.
      return withPrevious(addDays(today, -29), today)
    }
  }
}

/** Restore a saved selection, tolerating anything that isn't valid. */
export function parseStoredSelection(raw: string | null, now: Date = new Date()): PeriodSelection {
  if (!raw) return DEFAULT_PERIOD
  try {
    const v = JSON.parse(raw) as Partial<PeriodSelection> | null
    if (!v || typeof v !== 'object' || !PERIOD_PRESETS.includes(v.preset as PeriodPreset)) return DEFAULT_PERIOD
    if (v.preset === 'custom') {
      return validateCustomRange(v.customFrom, v.customTo, now) === null
        ? { preset: 'custom', customFrom: v.customFrom, customTo: v.customTo }
        : DEFAULT_PERIOD
    }
    return { preset: v.preset as PeriodPreset }
  } catch {
    return DEFAULT_PERIOD
  }
}

// ---- totals & bucketing ------------------------------------------------

export interface PeriodTotals {
  newContacts: number
  newConversations: number
  incoming: number
  outgoing: number
}

export function sumPoints(points: PeriodDayPoint[]): PeriodTotals {
  return points.reduce<PeriodTotals>(
    (acc, p) => ({
      newContacts: acc.newContacts + p.newContacts,
      newConversations: acc.newConversations + p.newConversations,
      incoming: acc.incoming + p.incoming,
      outgoing: acc.outgoing + p.outgoing,
    }),
    { newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0 },
  )
}

export type Granularity = 'day' | 'week' | 'month'

/** Keep charts readable: daily up to ~3 months, weekly up to ~13, then monthly. */
export function pickGranularity(dayCount: number): Granularity {
  if (dayCount <= 92) return 'day'
  if (dayCount <= 400) return 'week'
  return 'month'
}

function bucketStart(key: string, g: Granularity): string {
  if (g === 'day') return key
  if (g === 'month') return `${key.slice(0, 7)}-01`
  const [y, m, d] = key.split('-').map(Number)
  const mondayIndex = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
  return addDays(key, -mondayIndex)
}

/** Sum daily points into week / month buckets keyed by the bucket's first day. */
export function bucketPoints(points: PeriodDayPoint[], g: Granularity): PeriodDayPoint[] {
  if (g === 'day') return points
  const out = new Map<string, PeriodDayPoint>()
  for (const p of points) {
    const key = bucketStart(p.day, g)
    const cur = out.get(key) ?? { day: key, newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0 }
    cur.newContacts += p.newContacts
    cur.newConversations += p.newConversations
    cur.incoming += p.incoming
    cur.outgoing += p.outgoing
    out.set(key, cur)
  }
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

/** Percent change of `current` vs `previous`; null when there's no base to compare to. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return Math.round(((current - previous) / previous) * 100)
}
