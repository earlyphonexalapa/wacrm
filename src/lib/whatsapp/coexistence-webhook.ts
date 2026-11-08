// ============================================================
// Webhook events that only exist for a number used from the WhatsApp
// Business app AND the Cloud API (coexistence):
//
//   smb_message_echoes   a message the business typed on its phone
//   smb_app_state_sync   the phone's contact list (and later edits to it)
//   history              the phone's past chats, delivered in chunks
//   account_update       the number was disconnected / reconnected
//
// Everything here only fills the CRM in. None of it triggers the live
// reactions an inbound message does — no lead routing, automations, flows,
// AI replies or push notifications — because these are the business's own
// messages and old chats, not a customer writing right now.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

export const COEXISTENCE_WEBHOOK_FIELDS = [
  'smb_message_echoes',
  'smb_app_state_sync',
  'history',
  'account_update',
] as const

export function isCoexistenceWebhookField(field: string | undefined): boolean {
  return (COEXISTENCE_WEBHOOK_FIELDS as readonly string[]).includes(field ?? '')
}

// ---- payload shapes (only what we read) -------------------------------------------------------

interface BaseMessage {
  id: string
  timestamp: string
  type: string
  text?: { body?: string }
  image?: { id?: string; caption?: string; mime_type?: string }
  video?: { id?: string; caption?: string; mime_type?: string }
  document?: { id?: string; caption?: string; filename?: string; mime_type?: string }
  audio?: { id?: string; mime_type?: string }
  sticker?: { id?: string; mime_type?: string }
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
}

export interface EchoMessage extends BaseMessage {
  from?: string
  to?: string
}

export interface HistoryMessage extends BaseMessage {
  from?: string
  to?: string
  history_context?: { status?: string }
}

interface HistoryThread {
  id?: string
  context?: { wa_id?: string }
  messages?: HistoryMessage[]
}

interface HistoryEntry {
  metadata?: { phase?: number; chunk_order?: number; progress?: number }
  threads?: HistoryThread[]
  errors?: { code?: number; title?: string; message?: string }[]
}

interface CoexistenceValue {
  messaging_product?: string
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: { wa_id?: string; profile?: { name?: string } }[]
  message_echoes?: EchoMessage[]
  state_sync?: {
    type?: string
    action?: string
    contact?: { full_name?: string; first_name?: string; phone_number?: string }
  }[]
  history?: HistoryEntry[]
  // account_update
  event?: string
  waba_info?: { waba_id?: string; owner_business_id?: string }
}

/** The whatsapp_config columns these handlers need. */
export interface CoexistenceConfig {
  account_id: string
  user_id: string
  phone_number_id: string
  waba_id?: string | null
}

/**
 * Optional hook so the webhook route can turn an echoed attachment into a
 * durable URL with its existing media pipeline. Without it, media echoes are
 * stored as a text placeholder.
 */
export interface EchoContent {
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
}

export interface CoexistenceDeps {
  db: SupabaseClient
  parseEchoContent?: (message: EchoMessage, config: CoexistenceConfig) => Promise<EchoContent>
}

// ---- pure mapping helpers ----------------------------------------------------------------------------

const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
])

/** The messages.content_type to store for a WhatsApp message type. */
export function contentTypeFor(type: string): string {
  if (ALLOWED_CONTENT_TYPES.has(type)) return type
  return type === 'sticker' ? 'image' : 'text'
}

/**
 * Text for a message we can't (or won't) download: its text or caption when
 * it has one, otherwise a `[type]` placeholder like the Inbox already shows.
 */
export function placeholderText(message: BaseMessage): string {
  const body =
    message.text?.body ??
    message.image?.caption ??
    message.video?.caption ??
    message.document?.caption ??
    message.document?.filename
  if (body) return body
  if (message.type === 'location' && message.location) {
    const loc = message.location
    return [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean).join(' - ')
  }
  return `[${message.type === 'media_placeholder' ? 'media' : message.type}]`
}

/** Meta's history status → the messages.status values the table allows. */
export function messageStatusFromHistory(status: string | undefined): string {
  switch (status) {
    case 'delivered':
      return 'delivered'
    case 'read':
    case 'played':
      return 'read'
    case 'error':
      return 'failed'
    default:
      return 'sent'
  }
}

const toIso = (seconds: string | number): string => {
  const n = Number(seconds)
  return new Date((Number.isFinite(n) ? n : Date.now() / 1000) * 1000).toISOString()
}

export interface HistoryRow {
  conversation_id: string
  sender_type: 'agent' | 'customer'
  content_type: string
  content_text: string
  message_id: string
  status: string
  created_at: string
}

/** Same number, tolerating trunk-prefix differences (last 8 digits). */
function sameNumber(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || (a.length >= 8 && b.length >= 8 && a.slice(-8) === b.slice(-8))
}

/**
 * The message rows for one chat's worth of history. In a thread, `from` is
 * the customer's number when they wrote and the business's number when the
 * business did — so anything not from the customer was sent by the business.
 */
export function historyRows(
  conversationId: string,
  threadPhoneDigits: string,
  messages: HistoryMessage[],
): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (const m of messages) {
    if (!m.id) continue
    const fromDigits = normalizePhone(m.from ?? '')
    const fromBusiness = fromDigits !== '' && !sameNumber(fromDigits, threadPhoneDigits)
    rows.push({
      conversation_id: conversationId,
      sender_type: fromBusiness ? 'agent' : 'customer',
      content_type: m.type === 'media_placeholder' ? 'text' : contentTypeFor(m.type),
      content_text: placeholderText(m),
      message_id: m.id,
      status: fromBusiness ? messageStatusFromHistory(m.history_context?.status) : 'delivered',
      created_at: toIso(m.timestamp),
    })
  }
  return rows
}

// ---- tenancy: find the account a number belongs to ------------------------------------------------

async function configByPhoneNumberId(
  db: SupabaseClient,
  phoneNumberId: string | undefined,
): Promise<CoexistenceConfig | null> {
  if (!phoneNumberId) return null
  const { data, error } = await db
    .from('whatsapp_config')
    .select('account_id, user_id, phone_number_id, waba_id')
    .eq('phone_number_id', phoneNumberId)
  if (error || !data || data.length !== 1) {
    console.error('[coexistence] no unique config for phone_number_id', phoneNumberId, error ?? '')
    return null
  }
  return data[0] as CoexistenceConfig
}

// ---- contacts and conversations ----------------------------------------------------------------------

async function findOrCreateContact(
  db: SupabaseClient,
  config: CoexistenceConfig,
  phone: string,
  createdAt?: string,
): Promise<{ id: string } | null> {
  const existing = await findExistingContact(db, config.account_id, phone)
  if (existing) return { id: existing.id }

  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      phone,
      name: phone,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select('id')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, config.account_id, phone)
      if (raced) return { id: raced.id }
    }
    console.error('[coexistence] creating contact failed:', error)
    return null
  }
  return { id: (data as { id: string }).id }
}

async function findOrCreateConversation(
  db: SupabaseClient,
  config: CoexistenceConfig,
  contactId: string,
  createdAt?: string,
): Promise<{ id: string; created: boolean } | null> {
  const find = () =>
    db
      .from('conversations')
      .select('id')
      .eq('account_id', config.account_id)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)

  const { data: found, error: findError } = await find()
  if (findError) {
    console.error('[coexistence] finding conversation failed:', findError)
    return null
  }
  if (found && found.length > 0) return { id: (found[0] as { id: string }).id, created: false }

  const { data, error } = await db
    .from('conversations')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      contact_id: contactId,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select('id')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await find()
      if (raced && raced.length > 0) return { id: (raced[0] as { id: string }).id, created: false }
    }
    console.error('[coexistence] creating conversation failed:', error)
    return null
  }
  return { id: (data as { id: string }).id, created: true }
}

/** Move the chat's "last message" forward, never backward. */
async function advanceLastMessage(
  db: SupabaseClient,
  conversationId: string,
  at: string,
  text: string,
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({ last_message_at: at, last_message_text: text, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .or(`last_message_at.is.null,last_message_at.lt.${at}`)
  if (error) console.error('[coexistence] updating last message failed:', error)
}

// ---- smb_message_echoes ---------------------------------------------------------------------------------

async function handleEchoes(
  value: CoexistenceValue,
  config: CoexistenceConfig,
  deps: CoexistenceDeps,
): Promise<void> {
  const { db } = deps
  for (const echo of value.message_echoes ?? []) {
    if (!echo.id) continue
    const phone = normalizePhone(echo.to ?? value.contacts?.[0]?.wa_id ?? '')
    if (!phone) {
      // Meta may identify the customer only by a username-style id.
      console.warn('[coexistence] echo without a phone number, skipped:', echo.id)
      continue
    }

    const contact = await findOrCreateContact(db, config, phone)
    if (!contact) continue
    const conversation = await findOrCreateConversation(db, config, contact.id)
    if (!conversation) continue

    const parsed: EchoContent = deps.parseEchoContent
      ? await deps.parseEchoContent(echo, config).catch(() => ({
          contentText: placeholderText(echo),
          mediaUrl: null,
          mediaType: null,
        }))
      : { contentText: placeholderText(echo), mediaUrl: null, mediaType: null }

    const createdAt = toIso(echo.timestamp)
    const text = parsed.contentText ?? placeholderText(echo)

    // Idempotent on (conversation_id, message_id): Meta retries deliveries.
    const { data: inserted, error } = await db
      .from('messages')
      .upsert(
        {
          conversation_id: conversation.id,
          sender_type: 'agent',
          content_type: contentTypeFor(echo.type),
          content_text: parsed.contentText,
          media_url: parsed.mediaUrl,
          media_type: parsed.mediaType,
          message_id: echo.id,
          status: 'sent',
          created_at: createdAt,
        },
        { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
      )
      .select('id')

    if (error) {
      console.error('[coexistence] saving echoed message failed:', error)
      continue
    }
    if (!inserted || inserted.length === 0) continue // a replay

    await advanceLastMessage(db, conversation.id, createdAt, text)

    // A person is answering from the phone: stop any bot talking over them.
    // Best-effort — the columns/tables may not exist on an older database.
    await db
      .from('conversations')
      .update({ ai_autoreply_disabled: true })
      .eq('id', conversation.id)
    await db
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', config.account_id)
      .eq('contact_id', contact.id)
      .eq('status', 'active')
  }
}

// ---- smb_app_state_sync ----------------------------------------------------------------------------------

/**
 * The phone's contact list. Only the NAMES of contacts the CRM already has
 * are filled in (and only where the CRM still shows the bare number): the
 * phone's whole address book would otherwise flood the CRM with people who
 * never wrote, and inflate the "new contacts" numbers.
 */
async function handleStateSync(
  value: CoexistenceValue,
  config: CoexistenceConfig,
  deps: CoexistenceDeps,
): Promise<void> {
  const { db } = deps
  for (const item of value.state_sync ?? []) {
    if (item.type !== 'contact' || item.action === 'remove') continue
    const c = item.contact
    const phone = normalizePhone(c?.phone_number ?? '')
    const name = (c?.full_name ?? c?.first_name ?? '').trim()
    if (!phone || !name) continue

    const existing = await findExistingContact(db, config.account_id, phone)
    if (!existing) continue
    const current = String(existing.name ?? '').trim()
    if (current && normalizePhone(current) !== phone) continue // already has a real name

    await db
      .from('contacts')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
  }
}

// ---- history ---------------------------------------------------------------------------------------------------

const INSERT_CHUNK = 200

async function handleHistory(
  value: CoexistenceValue,
  config: CoexistenceConfig,
  deps: CoexistenceDeps,
): Promise<void> {
  const { db } = deps

  for (const entry of value.history ?? []) {
    // The business chose not to share history from the phone app.
    const declined = entry.errors?.some((e) => e.code === 2593109)
    if (declined) {
      await db
        .from('whatsapp_config')
        .update({ history_sync_status: 'declined' })
        .eq('account_id', config.account_id)
      continue
    }
    if (entry.errors?.length) {
      console.error('[coexistence] history sync error:', entry.errors)
      await db
        .from('whatsapp_config')
        .update({ history_sync_status: 'failed' })
        .eq('account_id', config.account_id)
      continue
    }

    for (const thread of entry.threads ?? []) {
      const messages = thread.messages ?? []
      const phone = normalizePhone(thread.id ?? thread.context?.wa_id ?? '')
      if (!phone || messages.length === 0) continue

      const stamps = messages.map((m) => Number(m.timestamp)).filter(Number.isFinite)
      const earliest = stamps.length ? toIso(Math.min(...stamps)) : undefined

      // Old chats keep their real dates, so they don't show up as "new
      // contacts today" on the dashboard.
      const contact = await findOrCreateContact(db, config, phone, earliest)
      if (!contact) continue
      const conversation = await findOrCreateConversation(db, config, contact.id, earliest)
      if (!conversation) continue

      const rows = historyRows(conversation.id, phone, messages)
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const { error } = await db
          .from('messages')
          .upsert(rows.slice(i, i + INSERT_CHUNK), {
            onConflict: 'conversation_id,message_id',
            ignoreDuplicates: true,
          })
        if (error) console.error('[coexistence] saving history chunk failed:', error)
      }

      const latest = rows.reduce((a, b) => (a.created_at > b.created_at ? a : b))
      await advanceLastMessage(db, conversation.id, latest.created_at, latest.content_text)
    }

    const progress = entry.metadata?.progress
    if (typeof progress === 'number') {
      // Chunks can arrive out of order: progress only ever moves forward.
      await db
        .from('whatsapp_config')
        .update({
          history_sync_progress: progress,
          history_sync_status: progress >= 100 ? 'complete' : 'in_progress',
        })
        .eq('account_id', config.account_id)
        .or(`history_sync_progress.is.null,history_sync_progress.lt.${progress}`)
    }
  }
}

// ---- account_update ---------------------------------------------------------------------------------------------

/**
 * The number was disconnected from the Cloud API (the owner tapped
 * "Disconnect" in the phone app, or Meta did it after long inactivity) or
 * came back. Reflect it so Settings doesn't claim a dead connection is live.
 */
async function handleAccountUpdate(value: CoexistenceValue, deps: CoexistenceDeps): Promise<void> {
  const wabaId = value.waba_info?.waba_id
  if (!wabaId) return
  const event = value.event
  const patch =
    event === 'PARTNER_REMOVED' || event === 'ACCOUNT_OFFBOARDED'
      ? { status: 'disconnected' }
      : event === 'ACCOUNT_RECONNECTED'
        ? { status: 'connected', connected_at: new Date().toISOString() }
        : null
  if (!patch) return

  const { error } = await deps.db.from('whatsapp_config').update(patch).eq('waba_id', wabaId)
  if (error) console.error('[coexistence] account_update failed:', error)
}

// ---- entry point -----------------------------------------------------------------------------------------------------

/** Handle one `changes[]` item of a coexistence webhook field. */
export async function handleCoexistenceChange(
  change: { field: string; value: unknown },
  deps: CoexistenceDeps,
): Promise<void> {
  const value = (change.value ?? {}) as CoexistenceValue

  if (change.field === 'account_update') {
    await handleAccountUpdate(value, deps)
    return
  }

  const config = await configByPhoneNumberId(deps.db, value.metadata?.phone_number_id)
  if (!config) return

  switch (change.field) {
    case 'smb_message_echoes':
      await handleEchoes(value, config, deps)
      break
    case 'smb_app_state_sync':
      await handleStateSync(value, config, deps)
      break
    case 'history':
      await handleHistory(value, config, deps)
      break
  }
}
