import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadSequence, updateSequence } from '@/lib/followups/store'
import { parseSequenceInput } from '@/lib/followups/validate'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/followups/sequences/[id] — admin+.
 *
 * Two shapes: `{ is_active }` alone is the card's on/off switch (the
 * stored sequence is re-validated before it can be switched ON); anything
 * else is a full save from the editor, replacing the steps.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`followups:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const toggleOnly =
      body && typeof body === 'object' && Object.keys(body).length === 1 && 'is_active' in body

    let input
    if (toggleOnly) {
      const existing = await loadSequence(supabase, accountId, id)
      if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const parsed = parseSequenceInput({ ...existing, is_active: (body as { is_active: unknown }).is_active === true })
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      input = parsed.value
    } else {
      const parsed = parseSequenceInput(body)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      input = parsed.value
    }

    const updated = await updateSequence(supabase, accountId, id, input)
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Switching a sequence off stops everyone already inside it now,
    // rather than waiting for each pending step to notice.
    if (!input.is_active) {
      await supabase
        .from('followup_enrollments')
        .update({ status: 'cancelled', cancel_reason: 'sequence_disabled', ended_at: new Date().toISOString(), locked_until: null })
        .eq('account_id', accountId)
        .eq('sequence_id', id)
        .eq('status', 'active')
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/followups/sequences/[id] — admin+. Steps/enrollments cascade. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('followup_sequences')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[followups/sequences DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete the sequence' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
