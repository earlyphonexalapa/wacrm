import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createSequence, loadSequences } from '@/lib/followups/store'
import { parseSequenceInput } from '@/lib/followups/validate'
import type { SequenceStats } from '@/lib/followups/types'

const STATS_WINDOW_DAYS = 30

/**
 * GET /api/followups/sequences — any member.
 * Sequences with their steps plus 30-day stats per sequence.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const sequences = await loadSequences(supabase, accountId)

    const since = new Date(Date.now() - STATS_WINDOW_DAYS * 24 * 3600 * 1000).toISOString()
    const [enrollRes, sendRes] = await Promise.all([
      supabase
        .from('followup_enrollments')
        .select('sequence_id, status, cancel_reason')
        .eq('account_id', accountId)
        .or(`status.eq.active,created_at.gte.${since}`)
        .limit(5000),
      supabase
        .from('followup_sends')
        .select('sequence_id')
        .eq('account_id', accountId)
        .eq('status', 'sent')
        .gte('created_at', since)
        .limit(10000),
    ])

    const stats: Record<string, SequenceStats> = {}
    const blank = (): SequenceStats => ({ active: 0, completed: 0, replied: 0, cancelled: 0, sent: 0 })
    for (const s of sequences) stats[s.id] = blank()
    for (const e of (enrollRes.data ?? []) as { sequence_id: string; status: string; cancel_reason: string | null }[]) {
      const st = stats[e.sequence_id]
      if (!st) continue
      if (e.status === 'active') st.active++
      else if (e.status === 'completed') st.completed++
      else if (e.status === 'cancelled') {
        st.cancelled++
        if (e.cancel_reason === 'replied') st.replied++
      }
    }
    for (const s of (sendRes.data ?? []) as { sequence_id: string }[]) {
      if (stats[s.sequence_id]) stats[s.sequence_id].sent++
    }

    return NextResponse.json({ sequences, stats, statsWindowDays: STATS_WINDOW_DAYS })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/followups/sequences — admin+. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`followups:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const parsed = parseSequenceInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const id = await createSequence(supabase, accountId, userId, parsed.value)
    return NextResponse.json({ success: true, id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
