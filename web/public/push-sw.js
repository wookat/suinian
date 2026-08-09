// Web Push handlers, imported into the generated Workbox service worker via
// workbox.importScripts. Payload: { title, body, url, tag } (see backend push.ts).
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || '碎念'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const client of list) {
        if ('focus' in client) {
          const focused = await client.focus()
          // navigate() rejects for uncontrolled clients; ask the page to route itself,
          // and fall back to a fresh window if that fails too.
          try {
            if ('navigate' in client) {
              await client.navigate(url)
              return focused
            }
          } catch {
            /* fall through */
          }
          try {
            client.postMessage({ type: 'push-navigate', url })
            return focused
          } catch {
            return self.clients.openWindow(url)
          }
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
