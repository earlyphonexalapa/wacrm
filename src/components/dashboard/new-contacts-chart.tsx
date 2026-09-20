"use client"

import { useMemo, useState } from 'react'
import { UserPlus } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import type { Granularity } from '@/lib/dashboard/period'
import type { PeriodDayPoint } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface NewContactsChartProps {
  /** Already bucketed to `granularity`. */
  data: PeriodDayPoint[] | null
  loading: boolean
  granularity: Granularity
  /** Total days in the period, for the per-day average. */
  days: number
}

const VB_W = 760
const VB_H = 220
const PAD = { top: 12, right: 12, bottom: 26, left: 36 }

function niceCeil(max: number): number {
  if (max <= 4) return 4
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const n = max / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow
}

function toDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function NewContactsChart({ data, loading, granularity, days }: NewContactsChartProps) {
  const t = useTranslations('Dashboard.period')
  const locale = useLocale()
  const [hover, setHover] = useState<number | null>(null)

  const label = (key: string, long: boolean): string => {
    const d = toDate(key)
    if (granularity === 'month') {
      return d.toLocaleDateString(locale, long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' })
    }
    const base = d.toLocaleDateString(locale, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })
    return long && granularity === 'week' ? t('weekOf', { date: d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) }) : base
  }

  const stats = useMemo(() => {
    const arr = data ?? []
    const total = arr.reduce((s, p) => s + p.newContacts, 0)
    let best: PeriodDayPoint | null = null
    for (const p of arr) if (p.newContacts > (best?.newContacts ?? 0)) best = p
    const max = arr.reduce((m, p) => Math.max(m, p.newContacts), 0)
    return { total, best, ceil: niceCeil(max) }
  }, [data])

  const title =
    granularity === 'day' ? t('contactsPerDay') : granularity === 'week' ? t('contactsPerWeek') : t('contactsPerMonth')

  const chartW = VB_W - PAD.left - PAD.right
  const chartH = VB_H - PAD.top - PAD.bottom
  const n = data?.length ?? 0
  const slot = n > 0 ? chartW / n : 0
  const barW = Math.max(1, slot * 0.7)
  const y = (v: number) => PAD.top + chartH - (v / stats.ceil) * chartH
  const ticks = Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(stats.ceil * f))))
  const labelStride = Math.max(1, Math.ceil(n / 7))
  const shown = hover !== null && data ? data[hover] : null

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('contactsChartDesc')}</p>
        </div>
        {!loading && data && stats.total > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t('total', { count: stats.total.toLocaleString() })}</span>
            <span>{t('average', { avg: (days > 0 ? Math.round((stats.total / days) * 10) / 10 : 0).toLocaleString() })}</span>
            {stats.best && (
              <span>{t('best', { label: label(stats.best.day, false), count: stats.best.newContacts.toLocaleString() })}</span>
            )}
          </div>
        )}
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : stats.total === 0 ? (
          <EmptyState icon={UserPlus} title={t('noContacts')} hint={t('noContactsHint')} />
        ) : (
          <>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-[220px] w-full" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line x1={PAD.left} x2={VB_W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeDasharray="3 3" />
                  <text x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[10px]">
                    {tick}
                  </text>
                </g>
              ))}
              {data.map((p, i) => {
                const x = PAD.left + i * slot + (slot - barW) / 2
                const h = (p.newContacts / stats.ceil) * chartH
                return (
                  <g key={p.day} onMouseEnter={() => setHover(i)}>
                    {/* full-height hit target so thin bars are easy to hover */}
                    <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={chartH} fill="transparent" />
                    <rect
                      x={x}
                      y={y(p.newContacts)}
                      width={barW}
                      height={Math.max(h, p.newContacts > 0 ? 1 : 0)}
                      rx={Math.min(2, barW / 2)}
                      fill={hover === i ? '#a78bfa' : '#7c3aed'}
                    />
                    {i % labelStride === 0 && (
                      <text x={PAD.left + i * slot + slot / 2} y={VB_H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                        {label(p.day, false)}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
            <p className="mt-2 h-4 text-xs text-muted-foreground" aria-live="polite">
              {shown
                ? t('tooltip', { label: label(shown.day, true), count: shown.newContacts })
                : t('hoverHint')}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
