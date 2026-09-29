import { META_API_VERSION } from '@/lib/whatsapp/meta-api'

const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Meta Conversions API for WhatsApp business messaging.
 *
 * When someone starts a chat by tapping a click-to-WhatsApp ad, the
 * first inbound webhook message carries a `referral.ctwa_clid` (see
 * the webhook route and migration 053). Sending that clid back to
 * Meta as a conversion event is what lets Ads Manager attribute a
 * later sale to the campaign — the same attribution the WhatsApp
 * Business app does natively via its "share data with Meta Ads"
 * setting, which has no equivalent on the Cloud API.
 *
 * Docs: https://developers.facebook.com/docs/marketing-api/conversions-api/guides/whatsapp
 */

export interface CapiEventPayload {
  data: Array<{
    event_name: string
    event_time: number
    action_source: 'business_messaging'
    messaging_channel: 'whatsapp'
    user_data: {
      ctwa_clid: string
      whatsapp_business_account_id?: string
    }
  }>
}

export interface BuildCapiEventPayloadArgs {
  eventName: string
  ctwaClid: string
  wabaId?: string | null
  /** Unix seconds. Defaults to now — exposed for deterministic tests. */
  eventTime?: number
}

export function buildCapiEventPayload(
  args: BuildCapiEventPayloadArgs,
): CapiEventPayload {
  const userData: CapiEventPayload['data'][number]['user_data'] = {
    ctwa_clid: args.ctwaClid,
  }
  if (args.wabaId) userData.whatsapp_business_account_id = args.wabaId

  return {
    data: [
      {
        event_name: args.eventName,
        event_time: args.eventTime ?? Math.floor(Date.now() / 1000),
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: userData,
      },
    ],
  }
}

export interface SendWhatsAppConversionEventArgs
  extends BuildCapiEventPayloadArgs {
  datasetId: string
  accessToken: string
}

/**
 * POSTs a single conversion event to `/{datasetId}/events`. Throws on
 * any non-2xx response — callers that must not fail on a bad or
 * missing CAPI config (i.e. every current caller) are expected to
 * catch this themselves.
 */
export async function sendWhatsAppConversionEvent(
  args: SendWhatsAppConversionEventArgs,
): Promise<void> {
  const { datasetId, accessToken, ...eventArgs } = args
  const payload = buildCapiEventPayload(eventArgs)

  const response = await fetch(`${META_GRAPH_BASE}/${datasetId}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    let message = `Meta Conversions API error: ${response.status}`
    try {
      const data = (await response.json()) as {
        error?: { message?: string }
      }
      if (data.error?.message) message = data.error.message
    } catch {
      // response body wasn't JSON — keep the fallback
    }
    throw new Error(message)
  }
}
