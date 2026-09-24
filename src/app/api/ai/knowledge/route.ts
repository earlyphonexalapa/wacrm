import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import {
  ingestDocument,
  parseKnowledgeMediaInput,
  replaceKnowledgeMedia,
  MAX_KNOWLEDGE_MEDIA_ITEMS,
} from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { normalizePhrases } from '@/lib/ai/tagging'

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, updated_at, ai_knowledge_media(media_url)')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (error) {
      console.error('[ai/knowledge GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load knowledge base' },
        { status: 500 },
      )
    }
    // Flatten the joined rows into a plain count so the list view can
    // show a "has attachments" badge without shipping every URL.
    const documents = (data ?? []).map((doc) => {
      const { ai_knowledge_media, ...rest } = doc as typeof doc & {
        ai_knowledge_media: { media_url: string }[] | null
      }
      return { ...rest, media_count: ai_knowledge_media?.length ?? 0 }
    })
    return NextResponse.json({ documents })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Create a document, then chunk + (optionally) embed it. If indexing
 * fails the document is still saved so the admin can retry via reindex.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json(
        { error: 'title and content are required' },
        { status: 400 },
      )
    }

    // Optional attachments (images and/or PDFs) — each uploaded
    // client-side to the `chat-media` bucket first; this just records
    // the resulting URLs. Omitted `media` = no attachments.
    const mediaItems = parseKnowledgeMediaInput(body?.media ?? [])
    if (mediaItems === null) {
      return NextResponse.json(
        { error: `media must be an array of up to ${MAX_KNOWLEDGE_MEDIA_ITEMS} images/PDFs` },
        { status: 400 },
      )
    }

    const mediaTriggers = normalizePhrases(body?.media_triggers, 15, 60)
    const insertDoc = (extra: Record<string, unknown>) =>
      supabase
        .from('ai_knowledge_documents')
        .insert({ account_id: accountId, created_by: userId, title, content, ...extra })
        .select('id')
        .single()
    let triggersSkipped = false
    let { data: doc, error } = await insertDoc(mediaTriggers.length > 0 ? { media_triggers: mediaTriggers } : {})
    if (error && mediaTriggers.length > 0 && error.message?.includes('media_triggers')) {
      // Migration 049 not applied yet — save the document without them.
      ;({ data: doc, error } = await insertDoc({}))
      triggersSkipped = true
    }
    if (error || !doc) {
      console.error('[ai/knowledge POST] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to save document' },
        { status: 500 },
      )
    }

    if (mediaItems.length > 0) {
      try {
        await replaceKnowledgeMedia(supabase, accountId, doc.id, mediaItems)
      } catch (err) {
        console.error('[ai/knowledge POST] media insert error:', err)
        return NextResponse.json(
          { success: true, id: doc.id, warning: 'Saved, but attachments failed to save.' },
          { status: 200 },
        )
      }
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content,
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({
      success: true,
      id: doc.id,
      ...(triggersSkipped
        ? { warning: 'Saved, but the trigger words need the latest database update (migration 049).' }
        : {}),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
