import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/** GET /api/followups/sends — the latest attempts (sent / skipped / failed). */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('followup_sends')
      .select('id, sequence_id, contact_id, step_position, status, detail, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      console.error('[followups/sends GET] error:', error)
      return NextResponse.json({ error: 'Failed to load the log' }, { status: 500 })
    }
    const rows = (data ?? []) as {
      id: string
      sequence_id: string
      contact_id: string
      step_position: number
      status: string
      detail: string | null
      created_at: string
    }[]

    const contactIds = [...new Set(rows.map((r) => r.contact_id))]
    const sequenceIds = [...new Set(rows.map((r) => r.sequence_id))]
    const [contactsRes, seqRes] = await Promise.all([
      contactIds.length
        ? supabase.from('contacts').select('id, name, phone').in('id', contactIds)
        : Promise.resolve({ data: [] }),
      sequenceIds.length
        ? supabase.from('followup_sequences').select('id, name').in('id', sequenceIds)
        : Promise.resolve({ data: [] }),
    ])
    const contacts = new Map(
      ((contactsRes.data ?? []) as { id: string; name: string | null; phone: string }[]).map((c) => [c.id, c]),
    )
    const sequences = new Map(
      ((seqRes.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]),
    )

    return NextResponse.json({
      sends: rows.map((r) => ({
        id: r.id,
        step_position: r.step_position,
        status: r.status,
        detail: r.detail,
        created_at: r.created_at,
        contact: contacts.get(r.contact_id) ?? null,
        sequence_name: sequences.get(r.sequence_id) ?? null,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
