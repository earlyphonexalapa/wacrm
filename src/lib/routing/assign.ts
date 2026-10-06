import type { SupabaseClient } from '@supabase/supabase-js'

import { isCloserPhone as defaultIsCloserPhone } from '@/lib/ai/handoff-whatsapp'
import { fetchAdCampaign as defaultFetchAdCampaign, type AdCampaign } from '@/lib/meta/ads'
import { decrypt } from '@/lib/whatsapp/encryption'
import { matchCampaignRule, type RoutingRule } from './match'

// ============================================================
// Decides which closer owns a new lead and records it on
// conversations.owner_agent_id (migration 055).
//
//   ad lead, campaign has a rule  -> that rule's closer      ('campaign')
//   ad lead, campaign has no rule -> organic pool            ('unmatched_campaign')
//   ad lead, campaign not found   -> organic pool            ('unresolved')
//   anything else                 -> organic pool            ('organic')
//
// The organic pool is an even spread over the closers that take organic
// leads (the pick_organic_closer RPC). Ownership is sticky: a conversation
// that already has an owner is never reassigned here.
//
// Never throws — a routing failure must not affect message handling; the
// lead simply stays unowned and shows up in the inbox as before.
// ============================================================

export type OwnerSource = 'campaign' | 'unmatched_campaign' | 'unresolved' | 'organic' | 'manual'

export interface AdReferral {
  source_id?: string
  source_type?: string
  ctwa_clid?: string
}

export interface RouteLeadInput {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  referral?: AdReferral | null
}

export type RouteLeadResult =
  | { routed: true; ownerId: string; source: OwnerSource }
  | {
      routed: false
      reason: 'disabled' | 'closer_phone' | 'no_closers' | 'already_owned' | 'error'
    }

export interface RouteLeadDeps {
  fetchAdCampaign?: (adId: string, token: string) => Promise<AdCampaign | null>
  isCloserPhone?: (db: SupabaseClient, accountId: string, phone: string | null | undefined) => Promise<boolean>
  now?: () => Date
}

/** A resolved ad -> campaign mapping is trusted this long before re-checking. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function routeLead(
  input: RouteLeadInput,
  deps: RouteLeadDeps = {},
): Promise<RouteLeadResult> {
  try {
    return await route(input, deps)
  } catch (err) {
    console.error('[lead-routing] failed:', err)
    return { routed: false, reason: 'error' }
  }
}

async function route(input: RouteLeadInput, deps: RouteLeadDeps): Promise<RouteLeadResult> {
  const { db, accountId, conversationId, contactId, referral } = input
  const fetchCampaign = deps.fetchAdCampaign ?? defaultFetchAdCampaign
  const isCloserPhone = deps.isCloserPhone ?? defaultIsCloserPhone
  const now = deps.now ?? (() => new Date())

  const { data: settings } = await db
    .from('lead_routing_settings')
    .select('enabled, ads_access_token, last_error')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!settings?.enabled) return { routed: false, reason: 'disabled' }

  // A closer writing to the shared number (answering a handoff alert) is
  // a teammate, not a lead.
  const { data: contact } = await db.from('contacts').select('phone').eq('id', contactId).maybeSingle()
  if (await isCloserPhone(db, accountId, (contact as { phone?: string } | null)?.phone)) {
    return { routed: false, reason: 'closer_phone' }
  }

  const cameFromAd = Boolean(referral?.source_id || referral?.ctwa_clid)
  const adId = referral?.source_type === 'post' ? null : (referral?.source_id ?? null)

  let campaign: AdCampaign | null = null
  if (adId) {
    campaign = await resolveCampaign({
      db,
      accountId,
      adId,
      encryptedToken: settings.ads_access_token as string | null,
      hadError: Boolean(settings.last_error),
      fetchCampaign,
      now,
    })
  }
  // Overwrites a previous click's campaign on a returning contact, so the
  // stats never show a campaign they no longer came from.
  if (cameFromAd) {
    await db
      .from('contacts')
      .update({ ctwa_campaign_id: campaign?.id ?? null, ctwa_campaign_name: campaign?.name ?? null })
      .eq('id', contactId)
  }

  const [{ data: rules }, { data: closers }] = await Promise.all([
    db.from('lead_routing_rules').select('id, kind, match_value, closer_id').eq('account_id', accountId),
    db.from('lead_routing_closers').select('user_id').eq('account_id', accountId),
  ])
  const closerIds = new Set(((closers ?? []) as { user_id: string }[]).map((c) => c.user_id))

  let ownerId: string | null = null
  let source: OwnerSource
  if (campaign) {
    const match = matchCampaignRule((rules ?? []) as RoutingRule[], campaign)
    if (match.kind === 'match' && closerIds.has(match.closerId)) {
      ownerId = match.closerId
      source = 'campaign'
    } else {
      source = 'unmatched_campaign'
    }
  } else {
    source = cameFromAd ? 'unresolved' : 'organic'
  }

  if (!ownerId) {
    const { data: picked, error } = await db.rpc('pick_organic_closer', { p_account: accountId })
    if (error) throw error
    ownerId = (picked as string | null) ?? null
    if (!ownerId) return { routed: false, reason: 'no_closers' }
  }

  // Conditional write: if a human (or a concurrent delivery) set an owner
  // in the meantime, theirs stands.
  const { data: updated, error: updateError } = await db
    .from('conversations')
    .update({
      owner_agent_id: ownerId,
      owner_source: source,
      owner_assigned_at: now().toISOString(),
    })
    .eq('id', conversationId)
    .is('owner_agent_id', null)
    .select('id')
  if (updateError) throw updateError
  if (!updated || updated.length === 0) return { routed: false, reason: 'already_owned' }

  return { routed: true, ownerId, source }
}

async function resolveCampaign(args: {
  db: SupabaseClient
  accountId: string
  adId: string
  encryptedToken: string | null
  hadError: boolean
  fetchCampaign: (adId: string, token: string) => Promise<AdCampaign | null>
  now: () => Date
}): Promise<AdCampaign | null> {
  const { db, accountId, adId, encryptedToken, hadError, fetchCampaign, now } = args

  const { data: cached } = await db
    .from('ad_campaign_cache')
    .select('campaign_id, campaign_name, resolved_at')
    .eq('account_id', accountId)
    .eq('ad_id', adId)
    .maybeSingle()
  const cachedCampaign: AdCampaign | null = cached
    ? { id: cached.campaign_id as string, name: (cached.campaign_name as string | null) ?? null }
    : null
  const fresh =
    cached && now().getTime() - new Date(cached.resolved_at as string).getTime() < CACHE_TTL_MS
  if (cachedCampaign && fresh) return cachedCampaign

  if (!encryptedToken) return cachedCampaign

  let token: string
  try {
    token = decrypt(encryptedToken)
  } catch {
    await recordError(db, accountId, 'The saved Meta Ads token could not be decrypted — enter it again.', now)
    return cachedCampaign
  }

  try {
    const campaign = await fetchCampaign(adId, token)
    if (campaign) {
      await db.from('ad_campaign_cache').upsert({
        account_id: accountId,
        ad_id: adId,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        resolved_at: now().toISOString(),
      })
    }
    if (hadError) {
      await db.from('lead_routing_settings').update({ last_error: null, last_error_at: null }).eq('account_id', accountId)
    }
    return campaign ?? cachedCampaign
  } catch (err) {
    await recordError(db, accountId, err instanceof Error ? err.message : String(err), now)
    return cachedCampaign
  }
}

async function recordError(db: SupabaseClient, accountId: string, message: string, now: () => Date): Promise<void> {
  console.warn('[lead-routing] campaign lookup failed:', message)
  await db
    .from('lead_routing_settings')
    .update({ last_error: message.slice(0, 500), last_error_at: now().toISOString() })
    .eq('account_id', accountId)
}
