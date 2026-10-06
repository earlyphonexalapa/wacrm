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
  messagesIn: 'Mensajes recibidos',
  messagesOut: 'Mensajes enviados (bot + equipo)',
  qualifiedLeads: 'Leads calificados',
  sales: 'Ventas',
  conversion: 'Conversión de WhatsApp',
  scope: 'Métricas de',
}

const points: PeriodDayPoint[] = [
  { day: '2026-10-02', newContacts: 10, newConversations: 8, incoming: 100, outgoing: 150, qualifiedLeads: 3, sales: 1 },
  { day: '2026-10-03', newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0, qualifiedLeads: 0, sales: 0 },
  { day: '2026-10-04', newContacts: 5, newConversations: 4, incoming: 20, outgoing: 30, qualifiedLeads: 6, sales: 2 },
]

function build(overrides: Partial<Parameters<typeof buildPeriodCsv>[0]> = {}) {
  return buildPeriodCsv({
    points,
    labels,
    periodLabel: 'Últimos 3 días',
    scopeLabel: 'Todo el CRM',
    timeZone: 'America/Mexico_City',
    generatedAt: '2026-10-04 14:32',
    ...overrides,
  })
}

const lines = (csv: string) => csv.slice(1).split('\r\n')

describe('buildPeriodCsv', () => {
  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = build()
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('\r\n')
  })

  it('writes the period summary header, including whose numbers these are', () => {
    expect(lines(build()).slice(0, 8)).toEqual([
      '"Métricas del Panel"',
      '"Período","Últimos 3 días"',
      '"Métricas de","Todo el CRM"',
      '"Desde","2026-10-02"',
      '"Hasta","2026-10-04"',
      '"Días",3',
      '"Zona horaria","America/Mexico_City"',
      '"Generado","2026-10-04 14:32"',
    ])
  })

  it('labels a single closer\'s export with their name', () => {
    expect(lines(build({ scopeLabel: 'Pedro' }))).toContain('"Métricas de","Pedro"')
  })

  it('writes period totals with a per-day average, sales and conversion', () => {
    const l = lines(build())
    const start = l.indexOf('"Total del período"')
    expect(l.slice(start, start + 8)).toEqual([
      '"Total del período"',
      '"Métrica","Total","Promedio por día"',
      '"Contactos nuevos",15,5',
      '"Mensajes recibidos",120,40',
      '"Mensajes enviados (bot + equipo)",180,60',
      '"Leads calificados",9,3',
      '"Ventas",3,1',
      '"Conversión de WhatsApp","20%",""',
    ])
  })

  it('rounds the average to one decimal', () => {
    const csv = build({
      points: [
        { day: '2026-10-01', newContacts: 1, newConversations: 0, incoming: 0, outgoing: 0, qualifiedLeads: 0, sales: 0 },
        { day: '2026-10-02', newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0, qualifiedLeads: 0, sales: 0 },
        { day: '2026-10-03', newContacts: 0, newConversations: 0, incoming: 0, outgoing: 0, qualifiedLeads: 0, sales: 0 },
      ],
    })
    expect(csv).toContain('"Contactos nuevos",1,0.3')
  })

  it('leaves conversion empty when there were no new contacts', () => {
    const csv = build({
      points: [
        { day: '2026-10-01', newContacts: 0, newConversations: 0, incoming: 4, outgoing: 2, qualifiedLeads: 0, sales: 1 },
      ],
    })
    expect(csv).toContain('"Conversión de WhatsApp","",""')
  })

  it('lists every day individually, including zero days, in order', () => {
    const l = lines(build())
    const start = l.indexOf('"Detalle por día"')
    expect(l.slice(start)).toEqual([
      '"Detalle por día"',
      '"Fecha","Contactos nuevos","Mensajes recibidos","Mensajes enviados (bot + equipo)","Leads calificados","Ventas"',
      '"2026-10-02",10,100,150,3,1',
      '"2026-10-03",0,0,0,0,0',
      '"2026-10-04",5,20,30,6,2',
    ])
  })

  it('has one daily row per point', () => {
    const l = lines(build())
    const start = l.indexOf('"Detalle por día"')
    expect(l.slice(start + 2)).toHaveLength(points.length)
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
