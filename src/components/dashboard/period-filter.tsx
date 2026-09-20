"use client"

import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { localDayKey } from '@/lib/dashboard/date-utils'
import {
  addDays,
  PERIOD_PRESETS,
  validateCustomRange,
  type PeriodPreset,
  type PeriodSelection,
} from '@/lib/dashboard/period'

const PRESET_KEY: Record<PeriodPreset, string> = {
  today: 'presetToday',
  yesterday: 'presetYesterday',
  '3d': 'preset3d',
  '7d': 'preset7d',
  '30d': 'preset30d',
  '90d': 'preset90d',
  total: 'presetTotal',
  custom: 'presetCustom',
}

interface PeriodFilterProps {
  value: PeriodSelection
  onChange: (next: PeriodSelection) => void
}

export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  const t = useTranslations('Dashboard.period')
  const today = localDayKey(new Date())

  // The custom pickers keep their own draft so a half-typed date never
  // triggers a query; it's committed with "Apply".
  const [customOpen, setCustomOpen] = useState(value.preset === 'custom')
  const [from, setFrom] = useState(value.customFrom ?? addDays(today, -29))
  const [to, setTo] = useState(value.customTo ?? today)
  const problem = validateCustomRange(from, to)

  const pick = (preset: PeriodPreset) => {
    if (preset === 'custom') {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    onChange({ preset })
  }

  const apply = () => {
    if (problem) return
    onChange({ preset: 'custom', customFrom: from, customTo: to })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          {t('label')}
        </span>
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label={t('label')}>
          {PERIOD_PRESETS.map((preset) => {
            const active = customOpen ? preset === 'custom' : value.preset === preset
            return (
              <button
                key={preset}
                type="button"
                onClick={() => pick(preset)}
                aria-pressed={active}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  active ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(PRESET_KEY[preset] as never)}
              </button>
            )
          })}
        </div>
      </div>

      {customOpen && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
          <div className="space-y-1">
            <label htmlFor="period-from" className="text-xs text-muted-foreground">
              {t('from')}
            </label>
            <Input id="period-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <label htmlFor="period-to" className="text-xs text-muted-foreground">
              {t('to')}
            </label>
            <Input id="period-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" onClick={apply} disabled={problem !== null}>
            {t('apply')}
          </Button>
          {problem && <p className="text-xs text-amber-500">{t(`custom_${problem}` as never)}</p>}
        </div>
      )}
    </div>
  )
}
