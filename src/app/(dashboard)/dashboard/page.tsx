"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useCloserIsolation } from '@/hooks/use-closer-isolation'
import { formatCurrency } from '@/lib/currency'
import {
  Download,
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import {
  loadActivity,
  loadMetrics,
  loadPeriodStats,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import {
  bucketPoints,
  DEFAULT_PERIOD,
  parseStoredSelection,
  pickGranularity,
  resolvePeriod,
  sumPoints,
  type PeriodSelection,
  type PeriodTotals,
} from '@/lib/dashboard/period'
import type {
  ActivityItem,
  MetricsBundle,
  PeriodDayPoint,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'
import { buildPeriodCsv, periodExportFileName } from '@/lib/dashboard/export'
import { downloadTextFile } from '@/lib/exports/format'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PeriodFilter, PRESET_KEY } from '@/components/dashboard/period-filter'
import { PeriodSummary } from '@/components/dashboard/period-summary'
import { NewContactsChart } from '@/components/dashboard/new-contacts-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'

const PERIOD_STORAGE_KEY = 'wacrm.dashboard.period'

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const tp = useTranslations('Dashboard.period')
  const locale = useLocale()
  const { defaultCurrency, canEditSettings, accountId } = useAuth()
  const isolation = useCloserIsolation()

  // Whose numbers the period section shows. Admins can pick any closer;
  // a closer is pinned to their own by the database (and sees no picker).
  const [scope, setScope] = useState<string>('all')
  const [closerList, setCloserList] = useState<{ id: string; name: string }[]>([])
  const scopeOwner = canEditSettings && scope !== 'all' ? scope : null
  const showGeneral = !isolation.restricted && scopeOwner === null
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)

  // Date filter. Restored from localStorage after mount (not during
  // render) so the server and client render the same first paint.
  const [selection, setSelection] = useState<PeriodSelection>(DEFAULT_PERIOD)
  const [selectionRestored, setSelectionRestored] = useState(false)
  const [periodPoints, setPeriodPoints] = useState<PeriodDayPoint[] | null>(null)
  const [previousTotals, setPreviousTotals] = useState<PeriodTotals | null>(null)
  const [periodLoading, setPeriodLoading] = useState(true)
  const periodRequest = useRef(0)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)

  const loadAll = useCallback((general: boolean) => {
    const db = createClient()

    // Kick everything off in parallel. Each block has its own
    // setState + finally so a slow query doesn't hold up faster
    // sections — each widget shows its own skeleton independently.
    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => console.error('[dashboard] metrics failed:', err))
      .finally(() => setMetricsLoading(false))

    // Pipeline, response time and the activity feed are account-wide, so a
    // closer whose chats are isolated never loads them.
    if (!general) return

    void loadPipelineDonut(db)
      .then((p) => setPipeline(p))
      .catch((err) => console.error('[dashboard] pipeline failed:', err))
      .finally(() => setPipelineLoading(false))

    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => console.error('[dashboard] response time failed:', err))
      .finally(() => setResponseTimeLoading(false))

    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))
  }, [])

  useEffect(() => {
    // Wait until we know whether this user is isolated, so a closer never
    // fires the account-wide queries at all.
    if (isolation.loading) return
    loadAll(!isolation.restricted)
  }, [loadAll, isolation.loading, isolation.restricted])

  // Admins' scope picker: the closers of this account, by name.
  useEffect(() => {
    if (!canEditSettings || !accountId) return
    let cancelled = false
    const db = createClient()
    void (async () => {
      const [closers, profiles] = await Promise.all([
        db.from('lead_routing_closers').select('user_id').eq('account_id', accountId),
        db.from('profiles').select('user_id, full_name, email').eq('account_id', accountId),
      ])
      if (cancelled || closers.error || profiles.error) return
      const names = new Map(
        (profiles.data ?? []).map((p: { user_id: string; full_name: string | null; email: string | null }) => [
          p.user_id,
          p.full_name?.trim() || p.email || '',
        ]),
      )
      setCloserList(
        (closers.data ?? [])
          .map((c: { user_id: string }) => ({ id: c.user_id, name: names.get(c.user_id) ?? '' }))
          .filter((c) => c.name)
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [canEditSettings, accountId])

  useEffect(() => {
    const restored = parseStoredSelection(safeStorage()?.getItem(PERIOD_STORAGE_KEY) ?? null)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelection(restored)
    setSelectionRestored(true)
  }, [])

  // (Re)load the date-filtered numbers whenever the selection changes.
  // A request counter drops stale answers when the user clicks quickly.
  useEffect(() => {
    if (!selectionRestored) return
    // The first answer decides whether a closer is pinned; don't query with a
    // scope that is about to change.
    if (isolation.loading) return
    const id = ++periodRequest.current
    const period = resolvePeriod(selection)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const db = createClient()

    Promise.all([
      loadPeriodStats(db, period.from, period.to, tz, scopeOwner),
      period.previous
        ? loadPeriodStats(db, period.previous.from, period.previous.to, tz, scopeOwner)
        : Promise.resolve(null),
    ])
      .then(([current, previous]) => {
        if (id !== periodRequest.current) return
        setPeriodPoints(current)
        setPreviousTotals(previous ? sumPoints(previous) : null)
      })
      .catch((err) => {
        if (id !== periodRequest.current) return
        console.error('[dashboard] period stats failed:', err)
        toast.error(tp('loadFailed'))
      })
      .finally(() => {
        if (id === periodRequest.current) setPeriodLoading(false)
      })
  }, [selection, selectionRestored, tp, scopeOwner, isolation.loading])

  const handleScopeChange = useCallback((next: string) => {
    setPeriodLoading(true)
    setScope(next)
  }, [])

  const handleSelectionChange = useCallback((next: PeriodSelection) => {
    setPeriodLoading(true)
    setSelection(next)
    try {
      safeStorage()?.setItem(PERIOD_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Private mode / blocked storage — the filter still works, it just isn't remembered.
    }
  }, [])

  const periodView = useMemo(() => {
    const points = periodPoints ?? []
    const granularity = pickGranularity(points.length)
    return {
      totals: periodPoints ? sumPoints(points) : null,
      days: points.length,
      granularity,
      bucketed: periodPoints ? bucketPoints(points, granularity) : null,
      from: points[0]?.day ?? null,
      to: points[points.length - 1]?.day ?? null,
    }
  }, [periodPoints])

  const rangeText = useMemo(() => {
    if (!periodView.from || !periodView.to) return ''
    const fmt = (key: string) => {
      const [y, m, d] = key.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
    }
    return periodView.from === periodView.to ? fmt(periodView.from) : fmt(periodView.from) + ' – ' + fmt(periodView.to)
  }, [periodView.from, periodView.to, locale])

  // Exports the daily points (never the week/month buckets the charts
  // switch to on long ranges), so the file always has one row per day.
  const handleExport = useCallback(() => {
    if (!periodPoints || periodPoints.length === 0) return
    const csv = buildPeriodCsv({
      points: periodPoints,
      periodLabel: tp(PRESET_KEY[selection.preset] as never),
      scopeLabel:
        scopeOwner === null
          ? isolation.restricted
            ? tp('scopeMine')
            : tp('scopeAll')
          : (closerList.find((c) => c.id === scopeOwner)?.name ?? tp('scopeAll')),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      generatedAt: new Date().toLocaleString(locale),
      labels: {
        title: tp('exportTitle'),
        period: tp('label'),
        from: tp('from'),
        to: tp('to'),
        days: tp('exportDays'),
        timezone: tp('exportTimezone'),
        generated: tp('exportGenerated'),
        totalSection: tp('exportTotalSection'),
        metric: tp('exportMetric'),
        total: tp('exportTotal'),
        avgPerDay: tp('exportAvgPerDay'),
        dailySection: tp('exportDailySection'),
        date: tp('exportDate'),
        newContacts: tp('newContacts'),
        messagesIn: tp('messagesIn'),
        messagesOut: tp('messagesOut'),
        qualifiedLeads: tp('qualifiedLeads'),
        sales: tp('sales'),
        conversion: tp('conversion'),
        scope: tp('exportScope'),
      },
    })
    downloadTextFile(
      periodExportFileName(periodPoints[0].day, periodPoints[periodPoints.length - 1].day),
      csv,
      'text/csv;charset=utf-8;',
    )
    toast.success(tp('exportDone'))
  }, [periodPoints, selection.preset, tp, locale, scopeOwner, closerList, isolation.restricted])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      {/* Date filter + period summary */}
      <div className="space-y-4">
        <PeriodFilter key={selectionRestored ? 'restored' : 'initial'} value={selection} onChange={handleSelectionChange} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {rangeText && tp('showing', { range: rangeText, days: periodView.days })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
          {isolation.restricted ? (
            <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {tp('scopeMine')}
            </span>
          ) : canEditSettings && closerList.length > 0 ? (
            <Select value={scope} onValueChange={(v) => v && handleScopeChange(v)}>
              <SelectTrigger className="h-8 w-52" aria-label={tp('scopeLabel')}>
                <SelectValue>
                  {scope === 'all'
                    ? tp('scopeAll')
                    : (closerList.find((c) => c.id === scope)?.name ?? tp('scopeAll'))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tp('scopeAll')}</SelectItem>
                {closerList.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={periodLoading || !periodPoints || periodPoints.length === 0}
          >
            <Download className="size-4" />
            {tp('exportButton')}
          </Button>
          </div>
        </div>
        <PeriodSummary
          loading={periodLoading}
          totals={periodView.totals}
          previous={previousTotals}
          days={periodView.days}
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <NewContactsChart
            data={periodView.bucketed}
            loading={periodLoading}
            granularity={periodView.granularity}
            days={periodView.days}
          />
          <NewContactsChart
            metric="qualifiedLeads"
            data={periodView.bucketed}
            loading={periodLoading}
            granularity={periodView.granularity}
            days={periodView.days}
          />
          <NewContactsChart
            metric="sales"
            data={periodView.bucketed}
            loading={periodLoading}
            granularity={periodView.granularity}
            days={periodView.days}
          />
        </div>
      </div>

      {/* Metric cards — account-wide, general view only */}
      {showGeneral && (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('activeConversations')}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(
                  metrics.activeConversations.previous, 
                  t('newTodayVsYesterday'), 
                  t('noChange', { suffix: t('newTodayVsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                label: deltaLabel(
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('openDeals', { count: metrics.openDealsCount })}
            />
            <MetricCard
              title={t('messagesSentToday')}
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
          </>
        )}
      </div>
      )}

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className={showGeneral ? 'h-full lg:col-span-3' : 'h-full lg:col-span-5'}>
          <ConversationsChart
            data={periodView.bucketed}
            loading={periodLoading}
            granularity={periodView.granularity}
          />
        </div>
        {showGeneral && (
          <div className="h-full lg:col-span-2">
            <PipelineDonut
              data={pipeline}
              loading={pipelineLoading}
              currency={defaultCurrency}
            />
          </div>
        )}
      </div>

      {showGeneral && (
        <>
          {/* Response time */}
          <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />

          {/* Activity feed */}
          <ActivityFeed items={activity} loading={activityLoading} />
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------

function deltaLabel(delta: number, suffix: string, noChangeLabel: string): string {
  if (delta === 0) return noChangeLabel
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
