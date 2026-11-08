// ============================================================
// WhatsApp Business app "coexistence": the same number used from the phone
// app and from the Cloud API (this CRM) at once.
//
// The customer connects through Meta's Embedded Signup — a popup launched
// from the Settings screen. It hands the browser a short-lived `code` and,
// through a postMessage, the ids of what was connected. Everything below is
// the server half: turn that into a token, find the number, subscribe the
// app to its webhooks and ask Meta to sync the phone's contacts and chats.
//
// Reference: developers.facebook.com → WhatsApp → Embedded Signup →
// "Onboarding WhatsApp Business app users".
// ============================================================

/**
 * Graph API version for the coexistence calls. Overridable so a version
 * Meta retires doesn't need a code change.
 */
export function coexistenceGraphBase(): string {
  const version = process.env.META_COEXISTENCE_API_VERSION?.trim() || 'v27.0'
  return `https://graph.facebook.com/${version}`
}

async function graphError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as { error?: { message?: string } }
    if (data.error?.message) message = data.error.message
  } catch {
    // not JSON — keep the fallback
  }
  throw new Error(message)
}

// ---- what the Embedded Signup popup reports ------------------------------------

export interface SignupResult {
  /** The WhatsApp Business account the number lives in. */
  wabaId: string | null
  phoneNumberId: string | null
  businessId: string | null
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null

/**
 * Normalise the `data` of a WA_EMBEDDED_SIGNUP "finish" message. The shape
 * depends on the Embedded Signup version: older ones send `waba_id`; version
 * 5 sends `messaging_account_ids`. Coexistence completions may carry only the
 * account id, so the phone number can be missing — the caller looks it up.
 */
export function parseSignupData(data: unknown): SignupResult {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const messagingIds = Array.isArray(d.messaging_account_ids) ? d.messaging_account_ids : []
  const wabaIds = Array.isArray(d.waba_ids) ? d.waba_ids : []
  return {
    wabaId: str(d.waba_id) ?? str(messagingIds[0]) ?? str(wabaIds[0]),
    phoneNumberId: str(d.phone_number_id),
    businessId: str(d.business_id),
  }
}

// ---- Graph API calls -----------------------------------------------------------------------

/**
 * Trade the popup's `code` for a business token. The code lives 30 seconds
 * and works once, so this must run straight away.
 */
export async function exchangeCodeForToken(args: {
  code: string
  appId: string
  appSecret: string
}): Promise<{ accessToken: string; expiresIn: number | null }> {
  const url = new URL(`${coexistenceGraphBase()}/oauth/access_token`)
  url.searchParams.set('client_id', args.appId)
  url.searchParams.set('client_secret', args.appSecret)
  url.searchParams.set('code', args.code)

  const response = await fetch(url)
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
  const data = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Meta did not return an access token.')
  return {
    accessToken: data.access_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
  }
}

export interface WabaPhoneNumber {
  id: string
  display_phone_number?: string
  verified_name?: string
  is_on_biz_app?: boolean
  platform_type?: string
}

/** The numbers inside a WhatsApp Business account. */
export async function listWabaPhoneNumbers(args: {
  wabaId: string
  accessToken: string
}): Promise<WabaPhoneNumber[]> {
  const url =
    `${coexistenceGraphBase()}/${args.wabaId}/phone_numbers` +
    `?fields=id,display_phone_number,verified_name,is_on_biz_app,platform_type`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${args.accessToken}` } })
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
  const data = (await response.json()) as { data?: WabaPhoneNumber[] }
  return data.data ?? []
}

/**
 * Pick the number to connect when the popup didn't say which: the one that
 * is also in the phone app, else the only one in the account.
 */
export function pickCoexistenceNumber(numbers: WabaPhoneNumber[]): WabaPhoneNumber | null {
  if (numbers.length === 0) return null
  const onApp = numbers.filter((n) => n.is_on_biz_app)
  if (onApp.length === 1) return onApp[0]
  if (onApp.length === 0 && numbers.length === 1) return numbers[0]
  return onApp[0] ?? null
}

/** Public details of one number, including whether it is also in the phone app. */
export async function getPhoneNumberDetails(args: {
  phoneNumberId: string
  accessToken: string
}): Promise<WabaPhoneNumber & { quality_rating?: string }> {
  const url =
    `${coexistenceGraphBase()}/${args.phoneNumberId}` +
    `?fields=id,display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${args.accessToken}` } })
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
  return response.json()
}

/** Subscribe this app to the account's webhooks. Safe to repeat. */
export async function subscribeAppToWaba(args: {
  wabaId: string
  accessToken: string
}): Promise<void> {
  const response = await fetch(`${coexistenceGraphBase()}/${args.wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
}

export type SmbSyncType = 'smb_app_state_sync' | 'history'

/**
 * Ask Meta to push the phone's contacts (`smb_app_state_sync`) or its chat
 * history (`history`) to the webhook. Each can be requested once, within 24
 * hours of onboarding. Returns Meta's request id.
 */
export async function requestSmbAppDataSync(args: {
  phoneNumberId: string
  accessToken: string
  syncType: SmbSyncType
}): Promise<string | null> {
  const response = await fetch(`${coexistenceGraphBase()}/${args.phoneNumberId}/smb_app_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: args.syncType }),
  })
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
  const data = (await response.json()) as { request_id?: string }
  return data.request_id ?? null
}
