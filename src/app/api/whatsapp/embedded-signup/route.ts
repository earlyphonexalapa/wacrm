import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeCodeForToken,
  getPhoneNumberDetails,
  listWabaPhoneNumbers,
  pickCoexistenceNumber,
  requestSmbAppDataSync,
  subscribeAppToWaba,
  type SmbSyncType,
} from '@/lib/whatsapp/coexistence'

/**
 * Connect a WhatsApp Business app number to the CRM through Meta's Embedded
 * Signup ("coexistence"): the number keeps working on the phone and its
 * messages also flow through the Cloud API.
 *
 * Admins and the owner only — it replaces the account's WhatsApp connection.
 */

const SETUP_ENV = ['META_APP_ID', 'META_APP_SECRET', 'META_ES_CONFIG_ID'] as const

function missingEnv(): string[] {
  return SETUP_ENV.filter((name) => !process.env[name]?.trim())
}

/**
 * GET — what the browser needs to open the Embedded Signup popup. Served by
 * the server so the ids come from the deployment's environment (no rebuild
 * to change them). The app secret never leaves the server.
 */
export async function GET() {
  try {
    await requireRole('admin')
    const missing = missingEnv()
    return NextResponse.json({
      configured: missing.length === 0,
      missing,
      appId: process.env.META_APP_ID?.trim() ?? null,
      configId: process.env.META_ES_CONFIG_ID?.trim() ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST { code, waba_id?, phone_number_id? } — finish the signup.
 *
 *   1. trade the popup's code for a business token
 *   2. find the number (the popup may only report the account)
 *   3. subscribe the app to the account's webhooks
 *   4. save it as the account's WhatsApp connection (replacing any other)
 *   5. ask Meta for the phone's contacts and chat history
 *
 * There is no /register step: the number is already registered through the
 * phone app, and registering it again would break coexistence.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-embedded-signup:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const missing = missingEnv()
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Falta configurar en el servidor: ${missing.join(', ')}.` },
        { status: 503 },
      )
    }

    const body = await request.json().catch(() => null)
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    if (!code) {
      return NextResponse.json({ error: 'Falta el código de Meta (code).' }, { status: 400 })
    }
    const wabaId: string | null = typeof body?.waba_id === 'string' ? body.waba_id.trim() || null : null
    let phoneNumberId: string | null =
      typeof body?.phone_number_id === 'string' ? body.phone_number_id.trim() || null : null

    // 1. token
    let accessToken: string
    try {
      ;({ accessToken } = await exchangeCodeForToken({
        code,
        appId: process.env.META_APP_ID!.trim(),
        appSecret: process.env.META_APP_SECRET!.trim(),
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[embedded-signup] code exchange failed:', message)
      return NextResponse.json(
        { error: `Meta rechazó el código (caduca a los 30 segundos, intenta de nuevo): ${message}` },
        { status: 400 },
      )
    }

    // 2. the number
    try {
      if (!phoneNumberId) {
        if (!wabaId) {
          return NextResponse.json(
            { error: 'Meta no indicó qué cuenta de WhatsApp se conectó.' },
            { status: 400 },
          )
        }
        const picked = pickCoexistenceNumber(await listWabaPhoneNumbers({ wabaId, accessToken }))
        if (!picked) {
          return NextResponse.json(
            { error: 'No se encontró ningún número en esa cuenta de WhatsApp Business.' },
            { status: 400 },
          )
        }
        phoneNumberId = picked.id
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    let details
    try {
      details = await getPhoneNumberDetails({ phoneNumberId, accessToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    // One number belongs to one account on this instance.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimedError) {
      console.error('[embedded-signup] ownership check failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        { error: 'Este número de WhatsApp ya está conectado a otra cuenta de esta instalación.' },
        { status: 409 },
      )
    }

    // 3. webhooks
    let subscribedAt: string | null = null
    const warnings: string[] = []
    if (wabaId) {
      try {
        await subscribeAppToWaba({ wabaId, accessToken })
        subscribedAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[embedded-signup] subscribed_apps failed:', message)
        warnings.push(`No se pudo suscribir los webhooks: ${message}`)
      }
    }

    // 4. save
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, phone_number_id, contacts_sync_requested_at, history_sync_requested_at')
      .eq('account_id', accountId)
      .maybeSingle()

    const now = new Date().toISOString()
    const sameNumber = existing?.phone_number_id === phoneNumberId
    const onPhoneApp = details.is_on_biz_app === true

    const row: Record<string, unknown> = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: encrypt(accessToken),
      status: 'connected',
      connected_at: now,
      // Meta registered the number during onboarding; /register is not used.
      registered_at: now,
      last_registration_error: null,
      subscribed_apps_at: subscribedAt,
      coexistence: onPhoneApp,
      coexistence_onboarded_at: now,
      updated_at: now,
      // A different number starts its sync history over.
      ...(sameNumber
        ? {}
        : {
            contacts_sync_requested_at: null,
            history_sync_requested_at: null,
            history_sync_status: 'none',
            history_sync_progress: null,
          }),
    }

    const { error: saveError } = existing
      ? await supabase.from('whatsapp_config').update(row).eq('account_id', accountId)
      : await supabase
          .from('whatsapp_config')
          .insert({ account_id: accountId, user_id: userId, ...row })

    if (saveError) {
      console.error('[embedded-signup] saving whatsapp_config failed:', saveError)
      const columnMissing = saveError.code === '42703' || saveError.code === 'PGRST204'
      return NextResponse.json(
        {
          error: columnMissing
            ? 'Falta la última actualización de la base de datos (migración 060).'
            : 'No se pudo guardar la conexión.',
        },
        { status: columnMissing ? 503 : 500 },
      )
    }

    // 5. contacts and history — each can be requested once, within 24 hours.
    const alreadyContacts = sameNumber && existing?.contacts_sync_requested_at
    const alreadyHistory = sameNumber && existing?.history_sync_requested_at
    const sync: Record<'contacts' | 'history', 'requested' | 'already' | 'skipped' | 'failed'> = {
      contacts: 'skipped',
      history: 'skipped',
    }

    if (onPhoneApp) {
      const ask = async (type: SmbSyncType, already: unknown): Promise<'requested' | 'already' | 'failed'> => {
        if (already) return 'already'
        try {
          await requestSmbAppDataSync({ phoneNumberId: phoneNumberId!, accessToken, syncType: type })
          return 'requested'
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[embedded-signup] ${type} sync request failed:`, message)
          warnings.push(`No se pudo pedir la sincronización (${type}): ${message}`)
          return 'failed'
        }
      }

      sync.contacts = await ask('smb_app_state_sync', alreadyContacts)
      sync.history = await ask('history', alreadyHistory)

      const patch: Record<string, unknown> = {}
      if (sync.contacts === 'requested') patch.contacts_sync_requested_at = new Date().toISOString()
      if (sync.history === 'requested') {
        patch.history_sync_requested_at = new Date().toISOString()
        patch.history_sync_status = 'requested'
      }
      if (Object.keys(patch).length > 0) {
        await supabase.from('whatsapp_config').update(patch).eq('account_id', accountId)
      }
    } else {
      warnings.push(
        'Este número no aparece como activo en la app WhatsApp Business del celular, así que no se sincronizaron contactos ni historial.',
      )
    }

    return NextResponse.json({
      success: true,
      phone: {
        id: phoneNumberId,
        display_phone_number: details.display_phone_number ?? null,
        verified_name: details.verified_name ?? null,
        is_on_biz_app: onPhoneApp,
      },
      sync,
      warnings,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
