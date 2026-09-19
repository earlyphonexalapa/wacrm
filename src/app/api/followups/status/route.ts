import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getSchedulerStatus } from '@/lib/followups/scheduler'

/**
 * GET /api/followups/status — is the in-app scheduler alive, and is
 * anything overdue? Lets the UI show a trustworthy "running" indicator
 * (or warn if the scheduler never started or work is piling up).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const nowIso = new Date().toISOString()
    const [activeRes, overdueRes] = await Promise.all([
      supabase
        .from('followup_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('status', 'active'),
      // Comfortably past due (the scheduler polls every ~30s).
      supabase
        .from('followup_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('status', 'active')
        .lt('next_run_at', new Date(Date.now() - 10 * 60 * 1000).toISOString()),
    ])
    return NextResponse.json({
      scheduler: getSchedulerStatus(),
      activeEnrollments: activeRes.count ?? 0,
      overdue: overdueRes.count ?? 0,
      now: nowIso,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
