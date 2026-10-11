import webpush from 'web-push'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { pushRecipients, type PushMember } from './recipients'

// Web Push delivery for the installable app (see docs/ios-app.md).
//
// Needs VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in the environment. Without them
// every function here is a silent no-op, so a deploy that doesn't use the
// phone app behaves exactly as before.

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null
}

let configured: boolean | null = null
function ensureConfigured(): boolean {
  if (configured !== null) return configured
  const publicKey = vapidPublicKey()
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    configured = false
    return false
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    publicKey,
    privateKey,
  )
  configured = true
  return true
}

export interface PushPayload {
  title: string
  body: string
  /** Where tapping the notification opens, e.g. /inbox?c=<id>. */
  url: string
  /** Notifications with the same tag replace each other (one per chat). */
  tag?: string
  /** Number shown on the home-screen icon (chats with unread messages). */
  badge?: number
}

interface SubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Send to every device the given users registered. `payload` may be a
 * function to tailor it per user (e.g. their own unread badge). Never throws.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload | ((userId: string) => PushPayload),
): Promise<void> {
  if (userIds.length === 0 || !ensureConfigured()) return
  try {
    const db = supabaseAdmin()
    const { data: subs, error } = await db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', userIds)
    if (error || !subs || subs.length === 0) return

    const dead: string[] = []
    await Promise.all(
      (subs as SubscriptionRow[]).map(async (sub) => {
        const body = JSON.stringify(typeof payload === 'function' ? payload(sub.user_id) : payload)
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 60 * 60 * 24, urgency: 'high' },
          )
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          // 404/410: the device unsubscribed or the app was removed.
          if (status === 404 || status === 410) dead.push(sub.id)
          else console.error('[push] send failed:', status, (err as Error).message)
        }
      }),
    )
    if (dead.length > 0) {
      await db.from('push_subscriptions').delete().in('id', dead)
    }
  } catch (err) {
    console.error('[push] sendPushToUsers failed:', err)
  }
}

/**
 * Push a new inbound WhatsApp message to the phones of the people who should
 * see it (see pushRecipients). Best-effort: never throws, and costs one cheap
 * query when nobody on the account has turned notifications on.
 */
export async function notifyInboundMessage(args: {
  accountId: string
  conversationId: string
  contactName: string
  text: string
}): Promise<void> {
  if (!ensureConfigured()) return
  try {
    const db = supabaseAdmin()

    const { count } = await db
      .from('push_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', args.accountId)
    if (!count) return

    const [{ data: conv }, { data: members }, { data: settings }, { data: unread }] =
      await Promise.all([
        db
          .from('conversations')
          .select('owner_agent_id, assigned_agent_id')
          .eq('id', args.conversationId)
          .maybeSingle(),
        db.from('profiles').select('user_id, account_role').eq('account_id', args.accountId),
        db
          .from('lead_routing_settings')
          .select('restrict_closers')
          .eq('account_id', args.accountId)
          .maybeSingle(),
        db
          .from('conversations')
          .select('owner_agent_id, assigned_agent_id')
          .eq('account_id', args.accountId)
          .gt('unread_count', 0),
      ])

    const memberList = (members ?? []) as PushMember[]
    const isolationOn = !!settings?.restrict_closers
    const recipients = pushRecipients(conv ?? {}, memberList, isolationOn)

    // Home-screen badge = chats with unread messages this person can see.
    const unreadRows = (unread ?? []) as { owner_agent_id: string | null; assigned_agent_id: string | null }[]
    const roleOf = new Map(memberList.map((m) => [m.user_id, m.account_role]))
    const badgeFor = (userId: string) => {
      const role = roleOf.get(userId)
      if (!isolationOn || role === 'owner' || role === 'admin') return unreadRows.length
      return unreadRows.filter((r) => r.owner_agent_id === userId || r.assigned_agent_id === userId)
        .length
    }

    const body = args.text.length > 180 ? `${args.text.slice(0, 177)}…` : args.text
    await sendPushToUsers(recipients, (userId) => ({
      title: args.contactName,
      body,
      url: `/inbox?c=${args.conversationId}`,
      tag: `conv-${args.conversationId}`,
      badge: badgeFor(userId),
    }))
  } catch (err) {
    console.error('[push] notifyInboundMessage failed:', err)
  }
}
