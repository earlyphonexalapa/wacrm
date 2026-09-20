"use client"

import { MessageSquare, Send, UserPlus, Users } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { MetricCard } from './metric-card'
import { SkeletonCard } from './skeleton'
import { percentChange, type PeriodTotals } from '@/lib/dashboard/period'

interface PeriodSummaryProps {
  loading: boolean
  totals: PeriodTotals | null
  /** Totals for the equal-length window before this one; null for Total. */
  previous: PeriodTotals | null
  /** Days covered by the selected period (for the per-day average). */
  days: number
}

export function PeriodSummary({ loading, totals, previous, days }: PeriodSummaryProps) {
  const t = useTranslations('Dashboard.period')

  if (loading || !totals) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  const avg = (n: number) => (days > 0 ? Math.round((n / days) * 10) / 10 : 0)

  const card = (
    title: string,
    icon: typeof Users,
    current: number,
    prev: number | null,
  ) => {
    const base = { title, icon, value: current.toLocaleString() }
    if (prev === null) {
      return <MetricCard {...base} subtitle={t('perDay', { avg: avg(current).toLocaleString() })} />
    }
    const pct = percentChange(current, prev)
    if (pct === null) {
      return (
        <MetricCard
          {...base}
          delta={{ sign: current > 0 ? 1 : 0, label: t('noBase', { previous: prev.toLocaleString() }) }}
        />
      )
    }
    return (
      <MetricCard
        {...base}
        delta={{
          sign: pct,
          label:
            pct === 0
              ? t('sameAsPrevious', { previous: prev.toLocaleString() })
              : t('vsPrevious', { percent: `${pct > 0 ? '+' : ''}${pct}`, previous: prev.toLocaleString() }),
        }}
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {card(t('newContacts'), UserPlus, totals.newContacts, previous ? previous.newContacts : null)}
      {card(t('newConversations'), Users, totals.newConversations, previous ? previous.newConversations : null)}
      {card(t('messagesIn'), MessageSquare, totals.incoming, previous ? previous.incoming : null)}
      {card(t('messagesOut'), Send, totals.outgoing, previous ? previous.outgoing : null)}
    </div>
  )
}
