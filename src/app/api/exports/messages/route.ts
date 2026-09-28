import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { buildExportConversations, MAX_EXPORT_BATCH, parseConversationIds } from '@/lib/exports/rows'

/**
 * POST /api/exports/messages — admin+.
 *
 * Body: { conversation_ids: string[] } (up to MAX_EXPORT_BATCH). Returns
 * each conversation's contact, tags and every message, oldest first, for
 * the Exports page to assemble into a CSV/TXT file client-side.
 *
 * Bulk chat export is gated one level above ordinary inbox access
 * (which any account member already has via RLS) because it lets whole
 * conversation histories leave the CRM as a file — see the Exports page.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`export-messages:${userId}`, RATE_LIMITS.exportBatch)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const ids = parseConversationIds(body)
    if (!ids) {
      return NextResponse.json(
        { error: `conversation_ids must be a non-empty array of up to ${MAX_EXPORT_BATCH} ids` },
        { status: 400 },
      )
    }

    const conversations = await buildExportConversations(supabase, accountId, ids)
    return NextResponse.json({ conversations })
  } catch (err) {
    return toErrorResponse(err)
  }
}
