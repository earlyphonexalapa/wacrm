import { describe, expect, it } from 'vitest'
import { buildPeriodCsv, periodExportFileName, type PeriodExportLabels } from './export'
import type { PeriodDayPoint } from './types'

const labels: PeriodExportLabels = {
  title: 'Métricas del Panel',
  period: 'Período',
  from: 'Desde',
  to: 'Hasta',
  days: 'Días',
  timezone: 'Zona horaria',
  generated: 'Generado',
  totalSection: 'Total del período',
  metric: 'Métrica',
  total: 'Total',
  avgPerDay: 'Promedio por día',
  dailySection: 'Detalle por día',
  date: 'Fecha',
  newContacts: 'Contactos nuevos',
  newConversations: 'Conversaciones nuevas',
  messagesIn: 'Mensajes recibidos',
  messagesOut: 'Mensajes enviados (bot + equipo)',
}

const points: PeriodDayPoint[] = [
  { day: '2026-10-02', newContacts: 10, newConversations: 8, incoming: 100, outgoing: 150 },
  { day: '2026-10-03', newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0 },
  { day: '2026-10-04', newContacts: 5, newConversations: 4, incoming: 20, outgoing: 30 },
]

function build(overrides: Partial<Parameters<typeof buildPeriodCsv>[0]> = {}) {
  return buildPeriodCsv({
    points,
    labels,
    periodLabel: 'Últimos 3 días',
    timeZone: 'America/Mexico_City',
    generatedAt: '2026-10-04 14:32',
    ...overrides,
  })
}

describe('buildPeriodCsv', () => {
  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = build()
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('\r\n')
  })

  it('writes the period summary header', () => {
    const lines = build().slice(1).split('\r\n')
    expect(lines.slice(0, 7)).toEqual([
      '"Métricas del Panel"',
      '"Período","Últimos 3 días"',
      '"Desde","2026-10-02"',
      '"Hasta","2026-10-04"',
      '"Días",3',
      '"Zona horaria","America/Mexico_City"',
      '"Generado","2026-10-04 14:32"',
    ])
  })

  it('writes period totals with a per-day average rounded to one decimal', () => {
    const lines = build().slice(1).split('\r\n')
    const start = lines.indexOf('"Total del período"')
    expect(lines.slice(start, start + 6)).toEqual([
      '"Total del período"',
      '"Métrica","Total","Promedio por día"',
      '"Contactos nuevos",15,5',
      '"Conversaciones nuevas",12,4',
      '"Mensajes recibidos",120,40',
      '"Mensajes enviados (bot + equipo)",180,60',
    ])
  })

  it('rounds the average to one decimal', () => {
    const csv = build({
      points: [
        { day: '2026-10-01', newContacts: 1, newConversations: 0, incoming: 0, outgoing: 0 },
        { day: '2026-10-02', newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0 },
        { day: '2026-10-03', newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0 },
      ],
    })
    expect(csv).toContain('"Contactos nuevos",1,0.3')
  })

  it('lists every day individually, including zero days, in order', () => {
    const lines = build().slice(1).split('\r\n')
    const start = lines.indexOf('"Detalle por día"')
    expect(lines.slice(start)).toEqual([
      '"Detalle por día"',
      '"Fecha","Contactos nuevos","Conversaciones nuevas","Mensajes recibidos","Mensajes enviados (bot + equipo)"',
      '"2026-10-02",10,8,100,150',
      '"2026-10-03",0,0,0,0',
      '"2026-10-04",5,4,20,30',
    ])
  })

  it('has one daily row per point', () => {
    const lines = build().slice(1).split('\r\n')
    const start = lines.indexOf('"Detalle por día"')
    expect(lines.slice(start + 2)).toHaveLength(points.length)
  })

  it('escapes quotes inside labels', () => {
    const csv = build({ periodLabel: 'Rango "especial"' })
    expect(csv).toContain('"Período","Rango ""especial"""')
  })

  it('handles an empty period without throwing', () => {
    const csv = build({ points: [] })
    expect(csv).toContain('"Días",0')
    expect(csv).toContain('"Contactos nuevos",0,0')
    expect(csv).toContain('"Desde",""')
  })
})

describe('periodExportFileName', () => {
  it('names a multi-day range with both dates', () => {
    expect(periodExportFileName('2026-09-28', '2026-10-04')).toBe('wacrm-metrics-2026-09-28_2026-10-04.csv')
  })

  it('uses a single date for a one-day period', () => {
    expect(periodExportFileName('2026-10-04', '2026-10-04')).toBe('wacrm-metrics-2026-10-04.csv')
  })

  it('falls back when the range is unknown', () => {
    expect(periodExportFileName(null, null)).toBe('wacrm-metrics.csv')
  })
})
