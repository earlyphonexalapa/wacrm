import type { ExportConversation } from './types'

// ============================================================
// Pure, localizable file builders. No I/O, no DOM — takes the data
// already fetched and a set of column/value labels (the export page
// supplies these from `useTranslations` so the file matches whichever
// language the exporting user has the CRM in), and returns file text.
// ============================================================

export type ExportFormat = 'csv' | 'txt'

export interface ExportLabels {
  headers: readonly [
    conversationId: string,
    contact: string,
    phone: string,
    company: string,
    tags: string,
    chatStatus: string,
    direction: string,
    sender: string,
    contentType: string,
    message: string,
    mediaUrl: string,
    template: string,
    messageStatus: string,
    timestamp: string,
  ]
  direction: { received: string; sent: string }
  sender: { customer: string; agent: string; bot: string }
  unnamed: string
  noMessages: string
}

function senderLabel(labels: ExportLabels, sender: string): string {
  if (sender === 'customer') return labels.sender.customer
  if (sender === 'bot') return labels.sender.bot
  return labels.sender.agent
}

function directionLabel(labels: ExportLabels, sender: string): string {
  return sender === 'customer' ? labels.direction.received : labels.direction.sent
}

/** RFC 4180 quoting — every field is quoted so commas/newlines/quotes round-trip cleanly. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** One row per message, in every selected conversation, oldest message first. */
export function buildExportCsv(conversations: ExportConversation[], labels: ExportLabels): string {
  const lines = [labels.headers.map(csvField).join(',')]
  for (const conv of conversations) {
    const contactName = conv.contact.name?.trim() || labels.unnamed
    const tags = conv.tags.join('; ')
    for (const m of conv.messages) {
      lines.push(
        [
          conv.id,
          contactName,
          conv.contact.phone,
          conv.contact.company ?? '',
          tags,
          conv.status,
          directionLabel(labels, m.sender_type),
          senderLabel(labels, m.sender_type),
          m.content_type,
          m.content_text ?? '',
          m.media_url ?? '',
          m.template_name ?? '',
          m.status,
          m.created_at,
        ]
          .map(csvField)
          .join(','),
      )
    }
  }
  // Excel needs a UTF-8 BOM to render accents correctly instead of mojibake.
  return '﻿' + lines.join('\r\n')
}

function timestampLine(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** A readable transcript: one block per conversation, one line per message. */
export function buildExportTxt(conversations: ExportConversation[], labels: ExportLabels): string {
  const blocks = conversations.map((conv) => {
    const contactName = conv.contact.name?.trim() || labels.unnamed
    const header = [
      `${contactName} — ${conv.contact.phone}`,
      conv.contact.company ? conv.contact.company : null,
      conv.tags.length > 0 ? `${labels.headers[4]}: ${conv.tags.join(', ')}` : null,
      `${labels.headers[5]}: ${conv.status}`,
      '='.repeat(40),
    ]
      .filter((l): l is string => l !== null)
      .join('\n')

    const body =
      conv.messages.length === 0
        ? labels.noMessages
        : conv.messages
            .map((m) => {
              const who = `${directionLabel(labels, m.sender_type)} — ${senderLabel(labels, m.sender_type)}`
              const text = m.content_text?.trim() || `[${m.content_type}]${m.media_url ? ' ' + m.media_url : ''}`
              return `[${timestampLine(m.created_at)}] ${who}: ${text}`
            })
            .join('\n')

    return `${header}\n${body}`
  })
  return blocks.join('\n\n' + '-'.repeat(60) + '\n\n')
}

export function buildExportFile(
  format: ExportFormat,
  conversations: ExportConversation[],
  labels: ExportLabels,
): { content: string; mimeType: string } {
  if (format === 'csv') {
    return { content: buildExportCsv(conversations, labels), mimeType: 'text/csv;charset=utf-8;' }
  }
  return { content: buildExportTxt(conversations, labels), mimeType: 'text/plain;charset=utf-8;' }
}

/** e.g. "wacrm-chats-2026-09-28-1432.csv" */
export function exportFileName(format: ExportFormat, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `wacrm-chats-${stamp}.${format}`
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
