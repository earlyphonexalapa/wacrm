import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { customerWindow } from '@/lib/followups/timing'

const DEFAULT_LIMIT = 100

/**
 * GET /api/followups/enrollments?status=active|completed|cancelled|all
 *
 * The Activity view: who is inside a sequence, what happens next, and —
 * for live ones — how much of their 24h WhatsApp window is left (the same
 * "21h remaining" the inbox shows, computed from their last inbound message).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? 'active'
    const limit = Math.min(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 300)

    let query = supabase
      .from('followup_enrollments')
      .select(
        'id, sequence_id, contact_id, conversation_id, status, cancel_reason, enrolled_at, next_step_position, next_run_at, last_sent_at, ended_at',
      )
      .eq('account_id', accountId)
      .limit(limit)
    if (status !== 'all') query = query.eq('status', status)
    query =
      status === 'active'
        ? query.order('next_run_at', { ascending: true })
        : query.order('created_at', { ascending: false })

    const { data, error } = await query
    if (error) {
      console.error('[followups/enrollments GET] error:', error)
      return NextResponse.json({ error: 'Failed to load activity' }, { status: 500 })
    }
    const rows = (data ?? []) as {
      id: string
      sequence_id: string
      contact_id: string
      conversation_id: string
      status: string
      cancel_reason: string | null
      enrolled_at: string
      next_step_position: number
      next_run_at: string
      last_sent_at: string | null
      ended_at: string | null
    }[]

    const contactIds = [...new Set(rows.map((r) => r.contact_id))]
    const sequenceIds = [...new Set(rows.map((r) => r.sequence_id))]
    const [contactsRes, seqRes] = await Promise.all([
      contactIds.length
        ? supabase.from('contacts').select('id, name, phone').in('id', contactIds)
        : Promise.resolve({ data: [] }),
      sequenceIds.length
        ? supabase.from('followup_sequences').select('id, name, followup_steps(position)').in('id', sequenceIds)
        : Promise.resolve({ data: [] }),
    ])
    const contacts = new Map(
      ((contactsRes.data ?? []) as { id: string; name: string | null; phone: string }[]).map((c) => [c.id, c]),
    )
    const sequences = new Map(
      ((seqRes.data ?? []) as { id: string; name: string; followup_steps: { position: number }[] | null }[]).map((s) => [s.id, s]),
    )

    // 24h window for the live ones.
    const now = new Date()
    const windows = new Map<string, { open: boolean; remaining_ms: number }>()
    await Promise.all(
      rows
        .filter((r) => r.status === 'active')
        .map(async (r) => {
          const { data: last } = await supabase
            .from('messages')
            .select('created_at')
            .eq('conversation_id', r.conversation_id)
            .eq('sender_type', 'customer')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          const w = customerWindow(last?.created_at ? new Date(last.created_at) : null, now)
          windows.set(r.id, { open: w.open, remaining_ms: w.remainingMs })
        }),
    )

    return NextResponse.json({
      enrollments: rows.map((r) => {
        const seq = sequences.get(r.sequence_id)
        return {
          id: r.id,
          status: r.status,
          cancel_reason: r.cancel_reason,
          enrolled_at: r.enrolled_at,
          next_step_position: r.next_step_position,
          next_run_at: r.next_run_at,
          last_sent_at: r.last_sent_at,
          ended_at: r.ended_at,
          step_count: seq?.followup_steps?.length ?? 0,
          contact: contacts.get(r.contact_id) ?? null,
          conversation_id: r.conversation_id,
          sequence: seq ? { id: seq.id, name: seq.name } : null,
          window: windows.get(r.id) ?? null,
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
