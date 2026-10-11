import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendPushToUsers, vapidPublicKey } from '@/lib/push/send'

// Phone notifications for the installable app (docs/ios-app.md).
//
//   GET    → the VAPID public key the browser subscribes with (served at
//            runtime so the Docker image doesn't need it as a build arg).
//   POST   → save this device's subscription for the signed-in user.
//            `{ test: true }` instead sends a test notification.
//   DELETE → forget this device (`{ endpoint }`).

export async function GET() {
  return NextResponse.json({ publicKey: vapidPublicKey() })
}

interface SubscriptionBody {
  endpoint?: unknown
  keys?: { p256dh?: unknown; auth?: unknown }
  test?: unknown
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as SubscriptionBody | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  if (body.test === true) {
    await sendPushToUsers([ctx.userId], {
      title: 'wacrm',
      body: '¡Las notificaciones funcionan! 🎉',
      url: '/inbox',
      tag: 'test',
    })
    return NextResponse.json({ ok: true })
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : ''
  const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : ''
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }

  const { error } = await supabaseAdmin()
    .from('push_subscriptions')
    .upsert(
      {
        endpoint,
        p256dh,
        auth,
        user_id: ctx.userId,
        account_id: ctx.accountId,
        user_agent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )
  if (error) {
    console.error('[push] subscribe failed:', error)
    return NextResponse.json({ error: 'Could not save subscription' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  if (!endpoint) return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })

  // RLS (push_subscriptions_delete) limits this to the caller's own devices.
  await ctx.supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  return NextResponse.json({ ok: true })
}
