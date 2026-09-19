import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { notifyCloserOnWhatsApp } from '@/lib/ai/handoff-whatsapp'

/**
 * POST /api/ai/handoff-alert/test — admin+.
 * Sends a sample alert to the saved closer number through the exact same
 * path a real handoff uses (free text if their 24h window is open,
 * template otherwise) and reports which one was used.
 */
export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-handoff-alert-test:${userId}`, { limit: 5, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const result = await notifyCloserOnWhatsApp(
      supabaseAdmin(),
      {
        accountId,
        conversationId: '00000000-0000-0000-0000-000000000000',
        contactId: '00000000-0000-0000-0000-000000000000',
        summary: '🤖 Prueba: así te llegará el aviso cuando el bot pase un chat a una persona. Último mensaje del cliente: “quiero inscribirme, ¿cómo pago?”',
      },
      { force: true },
    )
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
