import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Fallback alert for an AI handoff that has nobody to land on.
//
// When the account has a handoff agent configured, assigning the
// conversation to them is enough — the `on_conversation_assigned`
// trigger (migration 027, updated in 042) detects the AI handoff via
// `ai_handoff_summary` changing and creates a distinct, urgent
// notification for that one agent.
//
// When there's no handoff agent configured (the "Hand off to" setting
// is left on the shared queue), that trigger never fires — the
// conversation's `assigned_agent_id` doesn't change, so nobody is ever
// told the bot bailed and a human is needed. This fills that gap by
// notifying every admin/owner directly.
// ============================================================

/**
 * Notify every admin/owner on the account that a conversation needs
 * human attention, for the case where no handoff agent is configured
 * (so nothing lands on the shared queue notification-free). Best-effort
 * — a failure here must never affect the handoff itself, which has
 * already happened by the time this runs.
 */
export async function notifyHandoffNeedsHuman(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    summary: string
  },
): Promise<void> {
  try {
    const { data: admins, error } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', args.accountId)
      .in('account_role', ['owner', 'admin'])
    if (error || !admins || admins.length === 0) return

    const rows = admins.map((a: { user_id: string }) => ({
      account_id: args.accountId,
      user_id: a.user_id,
      type: 'ai_handoff',
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      actor_user_id: null,
      title: '🤖 Needs human attention',
      body: args.summary,
    }))
    const { error: insErr } = await db.from('notifications').insert(rows)
    if (insErr) {
      console.error('[ai handoff] notifyHandoffNeedsHuman insert failed:', insErr)
    }
  } catch (err) {
    console.error('[ai handoff] notifyHandoffNeedsHuman failed:', err)
  }
}
