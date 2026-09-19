import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { loadHandoffAlertSettings } from '@/lib/ai/handoff-whatsapp'

const MAX_VARIABLES = 10

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** GET /api/ai/handoff-alert — any member. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data: row } = await supabase
      .from('ai_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()
    const settings = await loadHandoffAlertSettings(supabase, accountId)
    return NextResponse.json({ configured: Boolean(row), settings })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PUT /api/ai/handoff-alert — admin+. Needs the AI config row to exist. */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-handoff-alert:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const enabled = body.enabled === true
    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : ''
    const digits = sanitizePhoneForMeta(rawPhone)
    if (rawPhone && !isValidE164(digits)) {
      return bad('phone must include the country code, e.g. +5215512345678')
    }
    if (enabled && !digits) return bad('Enter the closer’s WhatsApp number first')

    const templateName =
      typeof body.template_name === 'string' && body.template_name.trim() ? body.template_name.trim() : null
    const templateLanguage =
      typeof body.template_language === 'string' && body.template_language.trim()
        ? body.template_language.trim()
        : null
    const variables = Array.isArray(body.template_variables)
      ? body.template_variables.filter((v: unknown): v is string => typeof v === 'string').slice(0, MAX_VARIABLES)
      : []
    if (templateName && variables.some((v: string) => !v.trim())) {
      return bad('Every template variable needs a value')
    }

    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing) return bad('Set up the AI agent first')

    const { error } = await supabase
      .from('ai_configs')
      .update({
        handoff_whatsapp_enabled: enabled,
        handoff_whatsapp_phone: digits ? `+${digits}` : null,
        handoff_whatsapp_template_name: templateName,
        handoff_whatsapp_template_language: templateName ? templateLanguage : null,
        handoff_whatsapp_template_variables: templateName ? variables : [],
      })
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/handoff-alert PUT] update error:', error)
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
