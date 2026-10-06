import { META_API_VERSION } from '@/lib/whatsapp/meta-api'

const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Marketing API reads used by lead routing. The WhatsApp webhook only
 * carries the AD id of a click-to-WhatsApp lead; these calls turn it into
 * a campaign. They need a token with `ads_read` on the ad account (a
 * system-user token assigned to that account works).
 */

export class MetaAdsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'MetaAdsError'
  }
}

async function graphGet<T>(
  path: string,
  params: Record<string, string>,
  accessToken: string,
  timeoutMs: number,
): Promise<T> {
  const url = `${GRAPH}${path}?${new URLSearchParams(params).toString()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
    if (!res.ok) {
      let message = `Meta API error: ${res.status}`
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        if (body.error?.message) message = body.error.message
      } catch {
        // body wasn't JSON — keep the generic message
      }
      throw new MetaAdsError(message, res.status)
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof MetaAdsError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MetaAdsError('Meta API timed out')
    }
    throw new MetaAdsError(err instanceof Error ? err.message : 'Meta API request failed')
  } finally {
    clearTimeout(timer)
  }
}

export interface AdCampaign {
  id: string
  name: string | null
}

/** The campaign an ad belongs to, or null when Meta doesn't report one. */
export async function fetchAdCampaign(
  adId: string,
  accessToken: string,
  timeoutMs = 4000,
): Promise<AdCampaign | null> {
  const data = await graphGet<{
    campaign_id?: string
    campaign?: { id?: string; name?: string }
  }>(`/${encodeURIComponent(adId)}`, { fields: 'campaign_id,campaign{name}' }, accessToken, timeoutMs)

  const id = data.campaign_id ?? data.campaign?.id
  if (!id) return null
  return { id, name: data.campaign?.name ?? null }
}

export interface ListedCampaign {
  id: string
  name: string
  status: string
  adAccountId: string
  adAccountName: string
}

interface AdAccountRow {
  id: string
  name?: string
}

async function listAdAccounts(accessToken: string, timeoutMs: number): Promise<AdAccountRow[]> {
  const fromEdge = async (edge: string) =>
    (
      await graphGet<{ data?: AdAccountRow[] }>(edge, { fields: 'id,name', limit: '50' }, accessToken, timeoutMs)
    ).data ?? []

  const direct = await fromEdge('/me/adaccounts')
  if (direct.length > 0) return direct
  // System-user tokens expose their accounts on a second edge.
  return fromEdge('/me/assigned_ad_accounts').catch(() => [])
}

/** Proves the token can read ads and says how many ad accounts it sees. */
export async function validateAdsToken(
  accessToken: string,
  timeoutMs = 8000,
): Promise<{ adAccounts: number }> {
  const accounts = await listAdAccounts(accessToken, timeoutMs)
  return { adAccounts: accounts.length }
}

/** Active and paused campaigns across the ad accounts the token can read. */
export async function listCampaigns(
  accessToken: string,
  timeoutMs = 10000,
): Promise<ListedCampaign[]> {
  const accounts = (await listAdAccounts(accessToken, timeoutMs)).slice(0, 10)

  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      try {
        const res = await graphGet<{
          data?: { id: string; name?: string; effective_status?: string }[]
        }>(
          `/${account.id}/campaigns`,
          {
            fields: 'id,name,effective_status',
            effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
            limit: '100',
          },
          accessToken,
          timeoutMs,
        )
        return (res.data ?? []).map<ListedCampaign>((c) => ({
          id: c.id,
          name: c.name ?? c.id,
          status: c.effective_status ?? 'UNKNOWN',
          adAccountId: account.id,
          adAccountName: account.name ?? account.id,
        }))
      } catch {
        return []
      }
    }),
  )
  return perAccount.flat()
}
