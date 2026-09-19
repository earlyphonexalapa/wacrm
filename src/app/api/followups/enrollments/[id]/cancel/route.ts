import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

/** POST /api/followups/enrollments/[id]/cancel — agent+. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const { data, error } = await supabase
      .from('followup_enrollments')
      .update({
        status: 'cancelled',
        cancel_reason: 'manual',
        ended_at: new Date().toISOString(),
        locked_until: null,
      })
      .eq('account_id', accountId)
      .eq('id', id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[followups/enrollments cancel] error:', error)
      return NextResponse.json({ error: 'Failed to cancel' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Not found or already finished' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
