import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendWhatsAppConversionEvent } from '@/lib/meta/capi'

// The only tag that signals a completed sale worth attributing back to
// the ad that started the conversation. Matched case-insensitively
// since tag names are free text an admin typed once.
const ATTRIBUTION_TAG_NAME = 'pagado'
const ATTRIBUTION_EVENT_NAME = 'Purchase'

interface SendCapiAttributionInput {
  db: SupabaseClient
  accountId: string
  contactId: string
  tagId: string
}

export type CapiAttributionResult =
  | { sent: true }
  | {
      sent: false
      reason:
        | 'tag_not_configured'
        | 'capi_not_configured'
        | 'no_ctwa_clid'
        | 'send_failed'
    }

/**
 * Fires a Meta Conversions API "Purchase" event when the "Pagado" tag
 * is added to a contact that arrived via a click-to-WhatsApp ad —
 * replicating the attribution the WhatsApp Business app does natively
 * via its "share data with Meta Ads" setting, which the Cloud API has
 * no equivalent for (see migration 053).
 *
 * Best-effort like the follow-up enrollment call next to it in
 * tag-events.ts: every failure is swallowed here so a missing
 * ctwa_clid or an unconfigured/broken CAPI setup never blocks tagging
 * itself.
 */
export async function sendCapiAttributionForTag(
  input: SendCapiAttributionInput,
): Promise<CapiAttributionResult> {
  try {
    const { data: tag } = await input.db
      .from('tags')
      .select('name')
      .eq('id', input.tagId)
      .maybeSingle()
    if (!tag?.name || tag.name.trim().toLowerCase() !== ATTRIBUTION_TAG_NAME) {
      return { sent: false, reason: 'tag_not_configured' }
    }

    const { data: config } = await input.db
      .from('whatsapp_config')
      .select('capi_access_token, capi_dataset_id, waba_id')
      .eq('account_id', input.accountId)
      .maybeSingle()
    if (!config?.capi_access_token || !config?.capi_dataset_id) {
      return { sent: false, reason: 'capi_not_configured' }
    }

    const { data: contact } = await input.db
      .from('contacts')
      .select('ctwa_clid')
      .eq('id', input.contactId)
      .maybeSingle()
    if (!contact?.ctwa_clid) {
      return { sent: false, reason: 'no_ctwa_clid' }
    }

    const accessToken = decrypt(config.capi_access_token)
    await sendWhatsAppConversionEvent({
      datasetId: config.capi_dataset_id,
      accessToken,
      eventName: ATTRIBUTION_EVENT_NAME,
      ctwaClid: contact.ctwa_clid,
      wabaId: config.waba_id ?? null,
    })
    return { sent: true }
  } catch (err) {
    console.error('[capi-attribution] failed to send conversion event:', err)
    return { sent: false, reason: 'send_failed' }
  }
}
