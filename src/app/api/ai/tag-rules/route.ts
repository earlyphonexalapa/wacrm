import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/ai/tag-rules
 *
 * List the account's AI auto-tagging rules (any member), joined with
 * the tag's current name/color so the UI doesn't need a second fetch.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_tag_rules')
      .select('id, tag_id, description, updated_at, tags(id, name, color)')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
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
 * Body: { tag_id, description }
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
    if (!tagId || !description) {
      return NextResponse.json(
        { error: 'tag_id and description are required' },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('ai_tag_rules')
      .upsert(
        { account_id: accountId, tag_id: tagId, description },
        { onConflict: 'account_id,tag_id' },
      )
      .select('id')
      .single()
    if (error || !data) {
      console.error('[ai/tag-rules POST] error:', error)
      return NextResponse.json({ error: 'Failed to save tag rule' }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
