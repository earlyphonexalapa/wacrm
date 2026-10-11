// wacrm service worker — powers the installable phone app (docs/ios-app.md).
//
// Deliberately does NOT cache pages or API responses: the inbox is live,
// per-user data behind auth, and a stale cached copy is worse than a spinner.
// Its jobs are push notifications, the home-screen badge, and opening the
// right chat when a notification is tapped.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// A pass-through fetch handler keeps the app installable on browsers that
// still look for one. It never touches the request.
self.addEventListener('fetch', () => {})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_e) {
    data = { title: 'wacrm', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'wacrm'
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.tag,
    renotify: !!data.tag,
    data: { url: data.url || '/inbox' },
  }

  const tasks = [self.registration.showNotification(title, options)]
  if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
    tasks.push(
      (data.badge > 0
        ? self.navigator.setAppBadge(data.badge)
        : self.navigator.clearAppBadge()
      ).catch(() => {}),
    )
  }
  event.waitUntil(Promise.all(tasks))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/inbox',
    self.location.origin,
  ).href

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        // Tell the open app which chat to show; it switches without a reload.
        client.postMessage({ type: 'open-url', url: target })
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(target)
    })(),
  )
})
