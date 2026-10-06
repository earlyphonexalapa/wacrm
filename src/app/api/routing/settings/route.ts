import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateAdsToken } from '@/lib/meta/ads'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isMissingRoutingTable } from '@/lib/routing/db-errors'
import { encrypt } from '@/lib/whatsapp/encryption'

const NEEDS_MIGRATION = {
  migrated: false,
  error: 'Lead routing needs the latest database update (migration 055).',
}

/**
 * GET /api/routing/settings  (admin)
 *
 * Everything the settings screen needs in one read. The Meta token is
 * never returned — only whether one is saved.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const [settings, closers, rules, members] = await Promise.all([
      supabase
        .from('lead_routing_settings')
        .select('enabled, ads_access_token, last_error, last_error_at')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('lead_routing_closers')
        .select('user_id, receives_organic')
        .eq('account_id', accountId),
      supabase
        .from('lead_routing_rules')
        .select('id, kind, match_value, match_label, closer_id, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true }),
      supabase
        .from('profiles')
        .select('user_id, full_name, email, account_role')
        .eq('account_id', accountId),
    ])

    const missing = [settings.error, closers.error, rules.error].find(isMissingRoutingTable)
    if (missing) return NextResponse.json(NEEDS_MIGRATION)

    const failed = [settings.error, closers.error, rules.error, members.error].find(Boolean)
    if (failed) {
      console.error('[routing/settings GET] error:', failed)
      return NextResponse.json({ error: 'Failed to load lead routing settings' }, { status: 500 })
    }

    return NextResponse.json({
      migrated: true,
      enabled: settings.data?.enabled === true,
      has_token: Boolean(settings.data?.ads_access_token),
      last_error: settings.data?.last_error ?? null,
      last_error_at: settings.data?.last_error_at ?? null,
      closers: closers.data ?? [],
      rules: rules.data ?? [],
      members: members.data ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CloserInput {
  user_id: string
  receives_organic: boolean
}

/**
 * POST /api/routing/settings  (admin)
 *
 * Partial update — every field is optional:
 *   enabled            master switch
 *   ads_access_token   a string saves it (after Meta confirms it can read
 *                      ads); null removes it
 *   closers            the FULL list of closers; anyone not listed is removed
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`routing-settings:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const bad = (message: string) => NextResponse.json({ error: message }, { status: 400 })

    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined

    // ---- closers (validated first: enabling needs at least one) ----
    let closersInput: CloserInput[] | undefined
    if (body.closers !== undefined) {
      if (!Array.isArray(body.closers)) return bad('closers must be a list')
      const seen = new Set<string>()
      closersInput = []
      for (const c of body.closers as Partial<CloserInput>[]) {
        if (typeof c?.user_id !== 'string' || !c.user_id) return bad('Each closer needs a user_id')
        if (seen.has(c.user_id)) continue
        seen.add(c.user_id)
        closersInput.push({ user_id: c.user_id, receives_organic: c.receives_organic !== false })
      }
      if (closersInput.length > 0) {
        const { data: found } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('account_id', accountId)
          .in('user_id', closersInput.map((c) => c.user_id))
        const ok = new Set((found ?? []).map((p: { user_id: string }) => p.user_id))
        const stranger = closersInput.find((c) => !ok.has(c.user_id))
        if (stranger) return bad('Every closer must be a member of this account')
      }
    }

    if (enabled === true) {
      const count =
        closersInput !== undefined
          ? closersInput.length
          : (
              await supabase
                .from('lead_routing_closers')
                .select('user_id', { count: 'exact', head: true })
                .eq('account_id', accountId)
            ).count ?? 0
      if (count === 0) return bad('Add at least one closer before switching lead routing on')
    }

    // ---- Meta token ----
    const settingsPatch: Record<string, unknown> = {}
    if (enabled !== undefined) settingsPatch.enabled = enabled
    let adAccounts: number | undefined
    if (body.ads_access_token === null) {
      settingsPatch.ads_access_token = null
      settingsPatch.last_error = null
      settingsPatch.last_error_at = null
    } else if (typeof body.ads_access_token === 'string' && body.ads_access_token.trim()) {
      const token = body.ads_access_token.trim()
      try {
        adAccounts = (await validateAdsToken(token)).adAccounts
      } catch (err) {
        return bad(`Meta rejected the token: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
      if (adAccounts === 0) {
        return bad('The token works but cannot see any ad account. Assign the ad account to its system user and generate it again.')
      }
      settingsPatch.ads_access_token = encrypt(token)
      settingsPatch.last_error = null
      settingsPatch.last_error_at = null
    }

    if (Object.keys(settingsPatch).length > 0) {
      const { error } = await supabase
        .from('lead_routing_settings')
        .upsert(
          { account_id: accountId, ...settingsPatch, updated_at: new Date().toISOString() },
          { onConflict: 'account_id' },
        )
      if (error) {
        if (isMissingRoutingTable(error)) return NextResponse.json(NEEDS_MIGRATION, { status: 503 })
        console.error('[routing/settings POST] settings error:', error)
        return NextResponse.json({ error: 'Failed to save lead routing settings' }, { status: 500 })
      }
    }

    // ---- closers ----
    if (closersInput !== undefined) {
      const { data: existing, error: existingError } = await supabase
        .from('lead_routing_closers')
        .select('user_id')
        .eq('account_id', accountId)
      if (existingError) {
        if (isMissingRoutingTable(existingError)) return NextResponse.json(NEEDS_MIGRATION, { status: 503 })
        console.error('[routing/settings POST] closers read error:', existingError)
        return NextResponse.json({ error: 'Failed to save closers' }, { status: 500 })
      }
      const keep = new Set(closersInput.map((c) => c.user_id))
      const removed = (existing ?? []).map((c: { user_id: string }) => c.user_id).filter((id) => !keep.has(id))

      if (removed.length > 0) {
        // Rules pointing at a removed closer would route nowhere.
        await supabase.from('lead_routing_rules').delete().eq('account_id', accountId).in('closer_id', removed)
        await supabase.from('lead_routing_closers').delete().eq('account_id', accountId).in('user_id', removed)
      }
      if (closersInput.length > 0) {
        const { error } = await supabase.from('lead_routing_closers').upsert(
          closersInput.map((c) => ({ account_id: accountId, user_id: c.user_id, receives_organic: c.receives_organic })),
          { onConflict: 'account_id,user_id' },
        )
        if (error) {
          console.error('[routing/settings POST] closers error:', error)
          return NextResponse.json({ error: 'Failed to save closers' }, { status: 500 })
        }
      }
    }

    return NextResponse.json({ success: true, ...(adAccounts !== undefined ? { ad_accounts: adAccounts } : {}) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
