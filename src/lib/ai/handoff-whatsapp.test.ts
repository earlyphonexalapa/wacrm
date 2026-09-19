import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const sendText = vi.fn()
const sendTemplate = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: (a: unknown) => sendText(a),
  sendTemplateMessage: (a: unknown) => sendTemplate(a),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))

import {
  buildAlertText,
  cleanParam,
  isCloserPhone,
  notifyCloserOnWhatsApp,
  resolveTemplateParams,
} from './handoff-whatsapp'

const NOW = new Date('2026-09-19T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

interface World {
  settings: Record<string, unknown> | null
  closerInbound: string | null // last time the closer wrote to the business
}

/** Tiny table-aware fake: every chain call returns itself; the terminal
 *  awaits/maybeSingle resolve from the table being queried. */
function fakeDb(world: World): SupabaseClient {
  const from = (table: string) => {
    const q: Record<string, unknown> = {}
    const chain = () => q
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) q[m] = chain
    const rows = (): unknown => {
      switch (table) {
        case 'contacts':
          return [{ id: 'closer-contact', name: 'Lead Name', phone: '5215500000000' }]
        case 'conversations':
          return [{ id: 'closer-conv' }]
        default:
          return []
      }
    }
    q.maybeSingle = async () => {
      switch (table) {
        case 'ai_configs':
          return { data: world.settings }
        case 'whatsapp_config':
          return { data: { phone_number_id: 'pn1', access_token: 'tok' } }
        case 'contacts':
          return { data: { name: 'Lead Name', phone: '5215500000000' } }
        case 'messages':
          return { data: world.closerInbound ? { created_at: world.closerInbound } : null }
        default:
          return { data: null }
      }
    }
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows() })
    return q
  }
  return { from } as unknown as SupabaseClient
}

const settings = (over: Record<string, unknown> = {}) => ({
  handoff_whatsapp_enabled: true,
  handoff_whatsapp_phone: '+5215512345678',
  handoff_whatsapp_template_name: 'alerta_closer',
  handoff_whatsapp_template_language: 'es_MX',
  handoff_whatsapp_template_variables: ['{{nombre}}', '{{telefono}}', '{{resumen}}'],
  ...over,
})

const ctx = {
  accountId: 'acc',
  conversationId: 'conv',
  contactId: 'lead',
  summary: '🤖 handed off\nLast: “quiero pagar”',
}

beforeEach(() => {
  sendText.mockReset().mockResolvedValue({ messageId: 'wamid.1' })
  sendTemplate.mockReset().mockResolvedValue({ messageId: 'wamid.2' })
})

describe('notifyCloserOnWhatsApp', () => {
  it('skips when the alert is switched off', async () => {
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings({ handoff_whatsapp_enabled: false }), closerInbound: hoursAgo(1) }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'skipped', reason: 'disabled' })
    expect(sendText).not.toHaveBeenCalled()
    expect(sendTemplate).not.toHaveBeenCalled()
  })

  it('skips without a valid number', async () => {
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings({ handoff_whatsapp_phone: 'abc' }), closerInbound: null }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'skipped', reason: 'no_phone' })
  })

  it('sends free text while the closer window is open', async () => {
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings(), closerInbound: hoursAgo(3) }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'sent', via: 'text' })
    expect(sendTemplate).not.toHaveBeenCalled()
    const arg = sendText.mock.calls[0][0] as { to: string; text: string }
    expect(arg.to).toBe('5215512345678')
    expect(arg.text).toContain('Lead Name')
    expect(arg.text).toContain('quiero pagar')
  })

  it('uses the template once the 24h window has closed', async () => {
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings(), closerInbound: hoursAgo(30) }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'sent', via: 'template' })
    expect(sendText).not.toHaveBeenCalled()
    const arg = sendTemplate.mock.calls[0][0] as { templateName: string; language: string; params: string[] }
    expect(arg.templateName).toBe('alerta_closer')
    expect(arg.language).toBe('es_MX')
    expect(arg.params[0]).toBe('Lead Name')
    expect(arg.params[2]).not.toMatch(/\n/)
  })

  it('uses the template when the closer never wrote in', async () => {
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings(), closerInbound: null }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'sent', via: 'template' })
  })

  it('skips (instead of failing) when the window is closed and there is no template', async () => {
    const r = await notifyCloserOnWhatsApp(
      fakeDb({ settings: settings({ handoff_whatsapp_template_name: null }), closerInbound: hoursAgo(48) }),
      ctx,
      { now: NOW },
    )
    expect(r).toEqual({ status: 'skipped', reason: 'window_closed_no_template' })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('falls back to the template when Meta refuses free text inside a window that looked open', async () => {
    sendText.mockRejectedValueOnce(new Error('(#131047) Re-engagement message'))
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings(), closerInbound: hoursAgo(2) }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'sent', via: 'template' })
    expect(sendTemplate).toHaveBeenCalledTimes(1)
  })

  it('never throws — reports a failure instead', async () => {
    sendTemplate.mockRejectedValueOnce(new Error('boom'))
    const r = await notifyCloserOnWhatsApp(fakeDb({ settings: settings(), closerInbound: null }), ctx, { now: NOW })
    expect(r).toEqual({ status: 'failed', error: 'boom' })
  })

  it('force sends a test even when the alert is switched off', async () => {
    const r = await notifyCloserOnWhatsApp(
      fakeDb({ settings: settings({ handoff_whatsapp_enabled: false }), closerInbound: hoursAgo(1) }),
      ctx,
      { now: NOW, force: true },
    )
    expect(r).toEqual({ status: 'sent', via: 'text' })
  })
})

describe('helpers', () => {
  it('cleanParam strips newlines / long runs of spaces and truncates', () => {
    expect(cleanParam('a\n\nb    c')).toBe('a b c')
    expect(cleanParam('x'.repeat(300), 50)).toHaveLength(50)
  })

  it('resolveTemplateParams substitutes tokens and never returns an empty value', () => {
    const vals = { nombre: 'Ana', telefono: '+52 1', resumen: 'r', enlace: '' }
    expect(resolveTemplateParams(['{{nombre}}', '{{telefono}} / {{resumen}}', '{{enlace}}'], vals)).toEqual(['Ana', '+52 1 / r', '-'])
  })

  it('buildAlertText leaves out the link line when there is none', () => {
    const t = buildAlertText({ leadName: 'Ana', leadPhone: '+52 1', summary: 's', link: '' })
    expect(t).not.toContain('🔗')
    expect(t.split('\n')).toHaveLength(3)
  })
})

describe('isCloserPhone', () => {
  it('matches the configured closer number regardless of formatting', async () => {
    const db = fakeDb({ settings: settings(), closerInbound: null })
    expect(await isCloserPhone(db, 'acc', '5215512345678')).toBe(true)
    expect(await isCloserPhone(db, 'acc', '+52 1 55 1234 5678')).toBe(true)
    expect(await isCloserPhone(db, 'acc', '5219999999999')).toBe(false)
    expect(await isCloserPhone(db, 'acc', null)).toBe(false)
  })

  it('is false when the alert is off, so lead numbers are never affected', async () => {
    const db = fakeDb({ settings: settings({ handoff_whatsapp_enabled: false }), closerInbound: null })
    expect(await isCloserPhone(db, 'acc', '5215512345678')).toBe(false)
  })
})
