import { csvField } from '@/lib/exports/format'
import { sumPoints } from './period'
import type { PeriodDayPoint } from './types'

// ============================================================
// Dashboard metrics export. Pure and localizable: the dashboard page
// hands in the daily points it already loaded plus translated labels,
// and gets back CSV text that opens directly in Excel. One file holds
// the period summary, the period totals, and one row per day.
// ============================================================

export interface PeriodExportLabels {
  title: string
  period: string
  from: string
  to: string
  days: string
  timezone: string
  generated: string
  totalSection: string
  metric: string
  total: string
  avgPerDay: string
  dailySection: string
  date: string
  newContacts: string
  newConversations: string
  messagesIn: string
  messagesOut: string
  qualifiedLeads: string
}

export interface BuildPeriodCsvInput {
  /** One point per calendar day, oldest first (NOT week/month buckets). */
  points: PeriodDayPoint[]
  labels: PeriodExportLabels
  /** Human label of the chosen period, e.g. "Últimos 7 días". */
  periodLabel: string
  timeZone: string
  /** Already formatted for display. */
  generatedAt: string
}

function row(...cells: Array<string | number>): string {
  return cells.map((c) => (typeof c === 'number' ? String(c) : csvField(c))).join(',')
}

function perDay(total: number, days: number): number {
  return days > 0 ? Math.round((total / days) * 10) / 10 : 0
}

export function buildPeriodCsv(input: BuildPeriodCsvInput): string {
  const { points, labels, periodLabel, timeZone, generatedAt } = input
  const totals = sumPoints(points)
  const days = points.length

  const lines = [
    row(labels.title),
    row(labels.period, periodLabel),
    row(labels.from, points[0]?.day ?? ''),
    row(labels.to, points[days - 1]?.day ?? ''),
    row(labels.days, days),
    row(labels.timezone, timeZone),
    row(labels.generated, generatedAt),
    '',
    row(labels.totalSection),
    row(labels.metric, labels.total, labels.avgPerDay),
    row(labels.newContacts, totals.newContacts, perDay(totals.newContacts, days)),
    row(labels.newConversations, totals.newConversations, perDay(totals.newConversations, days)),
    row(labels.messagesIn, totals.incoming, perDay(totals.incoming, days)),
    row(labels.messagesOut, totals.outgoing, perDay(totals.outgoing, days)),
    row(labels.qualifiedLeads, totals.qualifiedLeads, perDay(totals.qualifiedLeads, days)),
    '',
    row(labels.dailySection),
    row(
      labels.date,
      labels.newContacts,
      labels.newConversations,
      labels.messagesIn,
      labels.messagesOut,
      labels.qualifiedLeads,
    ),
    ...points.map((p) =>
      row(p.day, p.newContacts, p.newConversations, p.incoming, p.outgoing, p.qualifiedLeads),
    ),
  ]

  // Excel needs a UTF-8 BOM to render accents correctly instead of mojibake.
  return '﻿' + lines.join('\r\n')
}

/** e.g. "wacrm-metrics-2026-09-28_2026-10-04.csv", or a single date for a one-day period. */
export function periodExportFileName(from: string | null, to: string | null): string {
  if (!from || !to) return 'wacrm-metrics.csv'
  return from === to ? `wacrm-metrics-${from}.csv` : `wacrm-metrics-${from}_${to}.csv`
}
