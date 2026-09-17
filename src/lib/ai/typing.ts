import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { markMessageAsRead } from '@/lib/whatsapp/meta-api'

/**
 * Show the "typing…" indicator to the customer while the bot generates
 * its reply — marks the customer's latest message as read (a
 * prerequisite for the indicator) and asks Meta to show it. Meta clears
 * it automatically once the actual reply is sent, or after ~25s.
 *
 * Best-effort and silent: a missing config, a message with no Meta id,
 * or a failed API call must never block or delay the reply itself —
 * this is a cosmetic touch, not a step in the eligibility chain.
 */
export async function showTypingIndicator(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string },
): Promise<void> {
  try {
    const [{ data: lastMessage }, { data: config }] = await Promise.all([
      db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', args.conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', args.accountId)
        .maybeSingle(),
    ])
    if (!lastMessage?.message_id || !config?.phone_number_id || !config?.access_token) {
      return
    }

    await markMessageAsRead({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      messageId: lastMessage.message_id,
      showTypingIndicator: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] showTypingIndicator failed:', err)
  }
}
