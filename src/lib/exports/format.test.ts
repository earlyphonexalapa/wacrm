import { describe, expect, it } from 'vitest'
import { buildExportCsv, buildExportTxt, exportFileName, type ExportLabels } from './format'
import type { ExportConversation } from './types'

const labels: ExportLabels = {
  headers: [
    'ID de conversación',
    'Contacto',
    'Teléfono',
    'Empresa',
    'Etiquetas',
    'Estado del chat',
    'Dirección',
    'Remitente',
    'Tipo',
    'Mensaje',
    'Archivo',
    'Plantilla',
    'Estado del mensaje',
    'Fecha y hora',
  ],
  direction: { received: 'Recibido', sent: 'Enviado' },
  sender: { customer: 'Cliente', agent: 'Agente', bot: 'Bot' },
  unnamed: 'Sin nombre',
  noMessages: 'Sin mensajes.',
}

const conv = (over: Partial<ExportConversation> = {}): ExportConversation => ({
  id: 'c1',
  status: 'open',
  contact: { name: 'Ana "Gómez"', phone: '+521', company: 'Acme' },
  tags: ['Calificado'],
  messages: [
    { sender_type: 'customer', content_type: 'text', content_text: 'Hola, cuánto cuesta?', media_url: null, template_name: null, status: 'sent', created_at: '2026-01-01T10:00:00Z' },
    { sender_type: 'bot', content_type: 'text', content_text: 'Está en promo por $1197', media_url: null, template_name: null, status: 'sent', created_at: '2026-01-01T10:01:00Z' },
  ],
  ...over,
})

describe('buildExportCsv', () => {
  it('starts with a UTF-8 BOM and the header row', () => {
    const csv = buildExportCsv([conv()], labels)
    expect(csv.startsWith('﻿"ID de conversación"')).toBe(true)
    expect(csv).toContain('"Fecha y hora"')
  })

  it('emits one row per message, with direction and sender resolved', () => {
    const csv = buildExportCsv([conv()], labels)
    const lines = csv.replace('﻿', '').split('\r\n')
    expect(lines).toHaveLength(3) // header + 2 messages
    expect(lines[1]).toContain('"Recibido"')
    expect(lines[1]).toContain('"Cliente"')
    expect(lines[2]).toContain('"Enviado"')
    expect(lines[2]).toContain('"Bot"')
  })

  it('quotes embedded quotes and commas so the file round-trips', () => {
    const csv = buildExportCsv([conv()], labels)
    expect(csv).toContain('"Ana ""Gómez"""')
  })

  it('falls back to the unnamed label and blank company/tags', () => {
    const csv = buildExportCsv([conv({ contact: { name: null, phone: '+522', company: null }, tags: [] })], labels)
    expect(csv).toContain('"Sin nombre"')
  })

  it('handles several conversations in one file', () => {
    const csv = buildExportCsv([conv({ id: 'c1' }), conv({ id: 'c2', messages: [] })], labels)
    const lines = csv.replace('﻿', '').split('\r\n')
    expect(lines).toHaveLength(3) // header + c1's 2 messages; c2 has none
  })
})

describe('buildExportTxt', () => {
  it('includes contact info, tags, status and every message with a timestamp', () => {
    const txt = buildExportTxt([conv()], labels)
    expect(txt).toContain('Ana "Gómez" — +521')
    expect(txt).toContain('Acme')
    expect(txt).toContain('Etiquetas: Calificado')
    expect(txt).toContain('Estado del chat: open')
    expect(txt).toContain('Hola, cuánto cuesta?')
    expect(txt).toContain('Recibido — Cliente')
    expect(txt).toContain('Enviado — Bot')
  })

  it('separates multiple conversations with a divider', () => {
    const txt = buildExportTxt([conv({ id: 'c1' }), conv({ id: 'c2' })], labels)
    expect(txt.split('-'.repeat(60))).toHaveLength(2)
  })

  it('shows the no-messages label for an empty conversation', () => {
    const txt = buildExportTxt([conv({ messages: [] })], labels)
    expect(txt).toContain('Sin mensajes.')
  })

  it('falls back to a bracketed content-type when there is no text (e.g. an image)', () => {
    const txt = buildExportTxt(
      [conv({ messages: [{ sender_type: 'customer', content_type: 'image', content_text: null, media_url: 'https://x/img.jpg', template_name: null, status: 'sent', created_at: '2026-01-01T00:00:00Z' }] })],
      labels,
    )
    expect(txt).toContain('[image] https://x/img.jpg')
  })
})

describe('exportFileName', () => {
  it('builds a sortable, extension-correct name', () => {
    const now = new Date(2026, 8, 28, 14, 5)
    expect(exportFileName('csv', now)).toBe('wacrm-chats-2026-09-28-1405.csv')
    expect(exportFileName('txt', now)).toBe('wacrm-chats-2026-09-28-1405.txt')
  })
})
