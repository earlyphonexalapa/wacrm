import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  isRecipientNotAllowedError,
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils'
import { customerWindow } from '@/lib/followups/timing'

// ============================================================
// WhatsApp alert to the closer when the AI bot hands a chat off.
//
// The in-app notification (DB trigger / notifyHandoffNeedsHuman) is
// untouched — this is an extra channel. WhatsApp only lets a business
// send free text within 24h of the recipient's last message to it, so:
//   - closer wrote to the business number in the last 24h → free text
//   - otherwise                                          → utility template
// If the window looked open but Meta still refuses (clock skew, a
// message we never stored), the template is tried as a fallback.
// ============================================================

export interface HandoffAlertSettings {
  enabled: boolean
  phone: string | null
  templateName: string | null
  templateLanguage: string | null
  /** One entry per template body variable, using the tokens in
   *  HANDOFF_ALERT_VARIABLES (e.g. `{{nombre}}`). */
  templateVariables: string[]
}

export const HANDOFF_ALERT_VARIABLES = [
  { token: '{{nombre}}', key: 'nombre' },
  { token: '{{telefono}}', key: 'telefono' },
  { token: '{{resumen}}', key: 'resumen' },
  { token: '{{enlace}}', key: 'enlace' },
] as const

export type HandoffAlertResult =
  | { status: 'sent'; via: 'text' | 'template' }
  | { status: 'skipped'; reason: 'disabled' | 'no_phone' | 'window_closed_no_template' | 'no_whatsapp_config' }
  | { status: 'failed'; error: string }

export interface HandoffAlertContext {
  accountId: string
  conversationId: string
  contactId: string
  summary: string
}

const ROW_COLUMNS =
  'handoff_whatsapp_enabled, handoff_whatsapp_phone, handoff_whatsapp_template_name, handoff_whatsapp_template_language, handoff_whatsapp_template_variables'

interface Row {
  handoff_whatsapp_enabled: boolean
  handoff_whatsapp_phone: string | null
  handoff_whatsapp_template_name: string | null
  handoff_whatsapp_template_language: string | null
  handoff_whatsapp_template_variables: unknown
}

export function toHandoffAlertSettings(row: Partial<Row> | null): HandoffAlertSettings {
  const vars = row?.handoff_whatsapp_template_variables
  return {
    enabled: Boolean(row?.handoff_whatsapp_enabled),
    phone: row?.handoff_whatsapp_phone ?? null,
    templateName: row?.handoff_whatsapp_template_name ?? null,
    templateLanguage: row?.handoff_whatsapp_template_language ?? null,
    templateVariables: Array.isArray(vars) ? vars.filter((v): v is string => typeof v === 'string') : [],
  }
}

export async function loadHandoffAlertSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<HandoffAlertSettings> {
  const { data } = await db
    .from('ai_configs')
    .select(ROW_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  return toHandoffAlertSettings(data as Row | null)
}

/** Meta rejects template params containing newlines, tabs or 4+ spaces. */
export function cleanParam(value: string, max = 200): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`
}

function inboxLink(conversationId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}/inbox?c=${conversationId}` : ''
}

export function buildAlertText(args: {
  leadName: string
  leadPhone: string
  summary: string
  link: string
}): string {
  const lines = [
    '🚨 *Lead que necesita atención*',
    `👤 ${args.leadName}${args.leadPhone && args.leadPhone !== args.leadName ? ` · ${args.leadPhone}` : ''}`,
    `📝 ${cleanParam(args.summary, 400)}`,
  ]
  if (args.link) lines.push(`🔗 ${args.link}`)
  return lines.join('\n')
}

export function resolveTemplateParams(
  variables: string[],
  values: { nombre: string; telefono: string; resumen: string; enlace: string },
): string[] {
  return variables.map((v) => {
    const resolved = v.replace(/\{\{\s*(nombre|telefono|resumen|enlace)\s*\}\}/g, (_, key: keyof typeof values) => values[key])
    // Meta rejects empty parameters; never send a blank one.
    return cleanParam(resolved) || '-'
  })
}

/**
 * Last time the closer's number messaged the business, or null when it
 * never has (or isn't a known contact). Looks the closer up as a normal
 * contact by phone — the webhook creates one the first time they write in.
 */
async function closerLastInboundAt(
  db: SupabaseClient,
  accountId: string,
  phoneDigits: string,
): Promise<Date | null> {
  const variants = phoneVariants(phoneDigits)
  const candidates = [...new Set(variants.flatMap((v) => [v, `+${v}`]))]
  const { data: contacts } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('phone', candidates)
  const contactIds = ((contacts ?? []) as { id: string }[]).map((c) => c.id)
  if (contactIds.length === 0) return null

  const { data: convs } = await db.from('conversations').select('id').in('contact_id', contactIds)
  const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id)
  if (convIds.length === 0) return null

  const { data: last } = await db
    .from('messages')
    .select('created_at')
    .in('conversation_id', convIds)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const at = (last as { created_at: string } | null)?.created_at
  return at ? new Date(at) : null
}

/**
 * True when `phone` is the configured closer number — used to keep the
 * AI bot from auto-replying to the closer when they answer an alert.
 */
export async function isCloserPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string | null | undefined,
): Promise<boolean> {
  if (!phone) return false
  const settings = await loadHandoffAlertSettings(db, accountId)
  if (!settings.enabled || !settings.phone) return false
  const a = sanitizePhoneForMeta(settings.phone)
  const b = sanitizePhoneForMeta(phone)
  if (!a || !b) return false
  return a === b || (a.length >= 8 && b.length >= 8 && a.slice(-8) === b.slice(-8))
}

/**
 * Send the handoff alert to the closer. Never throws — returns what
 * happened so the settings "send a test" button can show it, while the
 * handoff itself ignores the result.
 */
export async function notifyCloserOnWhatsApp(
  db: SupabaseClient,
  ctx: HandoffAlertContext,
  opts: { now?: Date; force?: boolean } = {},
): Promise<HandoffAlertResult> {
  try {
    const now = opts.now ?? new Date()
    const settings = await loadHandoffAlertSettings(db, ctx.accountId)
    if (!opts.force && !settings.enabled) return { status: 'skipped', reason: 'disabled' }
    const digits = sanitizePhoneForMeta(settings.phone ?? '')
    if (!isValidE164(digits)) return { status: 'skipped', reason: 'no_phone' }

    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!config) return { status: 'skipped', reason: 'no_whatsapp_config' }
    const accessToken = decrypt((config as { access_token: string }).access_token)
    const phoneNumberId = (config as { phone_number_id: string }).phone_number_id

    const { data: lead } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const leadPhone = (lead as { phone?: string } | null)?.phone ?? ''
    const leadName = (lead as { name?: string | null } | null)?.name?.trim() || leadPhone || 'Lead'
    const link = inboxLink(ctx.conversationId)

    const lastInbound = await closerLastInboundAt(db, ctx.accountId, digits)
    const windowOpen = customerWindow(lastInbound, now).open

    // Try each phone variant (trunk-0 quirks) until one is accepted.
    const deliver = async (send: (to: string) => Promise<unknown>) => {
      let lastErr: unknown = null
      for (const to of phoneVariants(digits)) {
        try {
          await send(to)
          return
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(msg)) throw err
          lastErr = err
        }
      }
      if (lastErr) throw lastErr
    }

    const sendText = () =>
      deliver((to) =>
        sendTextMessage({
          phoneNumberId,
          accessToken,
          to,
          text: buildAlertText({ leadName, leadPhone, summary: ctx.summary, link }),
        }),
      )

    const sendTemplate = () =>
      deliver((to) =>
        sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to,
          templateName: settings.templateName!,
          language: settings.templateLanguage ?? undefined,
          params: resolveTemplateParams(settings.templateVariables, {
            nombre: leadName,
            telefono: leadPhone || leadName,
            resumen: ctx.summary,
            enlace: link || '-',
          }),
        }),
      )

    const hasTemplate = Boolean(settings.templateName)

    if (windowOpen) {
      try {
        await sendText()
        return { status: 'sent', via: 'text' }
      } catch (err) {
        // The window looked open but Meta disagreed — fall back if we can.
        if (!hasTemplate) throw err
        console.warn('[ai handoff] free-text alert refused, retrying as template:', err)
      }
    }

    if (!hasTemplate) return { status: 'skipped', reason: 'window_closed_no_template' }
    await sendTemplate()
    return { status: 'sent', via: 'template' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[ai handoff] WhatsApp alert to closer failed:', error)
    return { status: 'failed', error }
  }
}
