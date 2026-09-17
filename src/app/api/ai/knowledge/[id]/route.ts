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

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/knowledge/[id] — full document (any member).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, content, updated_at, ai_knowledge_media(media_url, media_type, position)')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[ai/knowledge/[id] GET] error:', error)
      return NextResponse.json({ error: 'Failed to load document' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { ai_knowledge_media, ...rest } = data as typeof data & {
      ai_knowledge_media: { media_url: string; media_type: string; position: number }[] | null
    }
    const media = (ai_knowledge_media ?? [])
      .sort((a, b) => a.position - b.position)
      .map((m) => ({ url: m.media_url, type: m.media_type }))
    return NextResponse.json({ ...rest, media })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/knowledge/[id]  (admin+) — update title/content and
 * re-index when the content changed.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    // Undefined = "leave attachments as-is"; an array (even []) replaces
    // the whole set — that's what the editor always sends.
    const mediaProvided = body?.media !== undefined
    const mediaItems = mediaProvided ? parseKnowledgeMediaInput(body.media) : []
    if (mediaProvided && mediaItems === null) {
      return NextResponse.json(
        { error: `media must be an array of up to ${MAX_KNOWLEDGE_MEDIA_ITEMS} images/PDFs` },
        { status: 400 },
      )
    }
    if (title === undefined && content === undefined && !mediaProvided) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })
    }

    const update: Record<string, string> = {}
    if (title !== undefined) update.title = title
    if (content !== undefined) update.content = content

    // An empty update (media-only PATCH) would otherwise send PostgREST
    // a SET with no columns — look the row up instead of updating it.
    const { data: updated, error } =
      Object.keys(update).length > 0
        ? await supabase
            .from('ai_knowledge_documents')
            .update(update)
            .eq('account_id', accountId)
            .eq('id', id)
            .select('id')
            .maybeSingle()
        : await supabase
            .from('ai_knowledge_documents')
            .select('id')
            .eq('account_id', accountId)
            .eq('id', id)
            .maybeSingle()
    if (error) {
      console.error('[ai/knowledge/[id] PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update document' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (mediaProvided) {
      try {
        await replaceKnowledgeMedia(supabase, accountId, id, mediaItems ?? [])
      } catch (err) {
        console.error('[ai/knowledge/[id] PATCH] media replace error:', err)
        return NextResponse.json(
          { success: true, warning: 'Updated, but attachments failed to save.' },
          { status: 200 },
        )
      }
    }

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
        supabase,
        accountId,
      )
      try {
        await ingestDocument(supabase, accountId, { embeddingsApiKey }, id, content)
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'indexing failed'
        console.error('[ai/knowledge/[id] PATCH] ingest error:', err)
        return NextResponse.json(
          {
            success: true,
            warning: `Updated, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
          },
          { status: 200 },
        )
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Updated with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge/[id]  (admin+) — chunks cascade.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/knowledge/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
