import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { normalizePhrases } from '@/lib/ai/tagging'

/**
 * GET /api/ai/tag-rules
 *
 * List the account's AI auto-tagging rules (any member), joined with
 * the tag's current name/color so the UI doesn't need a second fetch.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    // reply_contains arrived with migration 048; fall back to the old
    // column set so the list still loads if it hasn't been applied yet.
    const list = (columns: string) =>
      supabase
        .from('ai_tag_rules')
        .select(columns)
        .eq('account_id', accountId)
        .order('updated_at', { ascending: false })
    let { data, error } = await list('id, tag_id, description, reply_contains, updated_at, tags(id, name, color)')
    if (error) {
      ;({ data, error } = await list('id, tag_id, description, updated_at, tags(id, name, color)'))
    }
    if (error) {
      console.error('[ai/tag-rules GET] error:', error)
      return NextResponse.json({ error: 'Failed to load tag rules' }, { status: 500 })
    }
    return NextResponse.json({ rules: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/tag-rules  (admin+)
 *
 * Body: { tag_id, description, reply_contains?: string[] }
 * Upserts on (account_id, tag_id) — picking an already-configured tag
 * again just replaces its description rather than erroring.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-tag-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const tagId = typeof body?.tag_id === 'string' ? body.tag_id.trim() : ''
    const description =
      typeof body?.description === 'string' ? body.description.trim() : ''
    const replyContains = normalizePhrases(body?.reply_contains)
    if (!tagId || !description) {
      return NextResponse.json(
        { error: 'tag_id and description are required' },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('ai_tag_rules')
      .upsert(
        { account_id: accountId, tag_id: tagId, description, reply_contains: replyContains },
        { onConflict: 'account_id,tag_id' },
      )
      .select('id')
      .single()
    if (error?.message?.includes('reply_contains')) {
      // Migration 048 not applied yet — save the rule without phrases
      // rather than failing; the rule still works (model-driven).
      const retry = await supabase
        .from('ai_tag_rules')
        .upsert({ account_id: accountId, tag_id: tagId, description }, { onConflict: 'account_id,tag_id' })
        .select('id')
        .single()
      if (retry.error || !retry.data) {
        console.error('[ai/tag-rules POST] error:', retry.error)
        return NextResponse.json({ error: 'Failed to save tag rule' }, { status: 500 })
      }
      return NextResponse.json({ success: true, id: retry.data.id, phrasesSaved: false })
    }
    if (error || !data) {
      console.error('[ai/tag-rules POST] error:', error)
      return NextResponse.json({ error: 'Failed to save tag rule' }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
