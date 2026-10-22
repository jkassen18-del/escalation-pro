/*
 * InfraTicket service worker: phone and desktop push notifications for pages.
 *
 * Deliberately no caching. A worker that caches can serve stale app code long
 * after a deploy; this one only shows notifications and answers taps, so the
 * app itself always comes straight from the server.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'InfraTicket', body: event.data ? event.data.text() : '' };
  }
  const isPage = Boolean(data.pageId);
  const options = {
    body: data.body || '',
    tag: data.tag || (isPage ? `page-${data.pageId}` : 'infraticket'),
    // A page stays on screen until someone deals with it.
    requireInteraction: isPage,
    renotify: true,
    vibrate: isPage ? [400, 200, 400, 200, 800] : [200],
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data,
    actions: isPage
      ? [
          { action: 'ack', title: 'Acknowledge' },
          { action: 'open', title: 'Open' },
        ]
      : [{ action: 'open', title: 'Open' }],
  };
  event.waitUntil(self.registration.showNotification(data.title || 'InfraTicket', options));
});

async function openUrl(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if ('focus' in client) {
      await client.focus();
      if ('navigate' in client) return client.navigate(url);
      return client;
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const target = data.ticketId ? `/tickets/${data.ticketId}` : data.url || '/operations';

  if (event.action === 'ack' && data.pageId) {
    event.waitUntil(
      fetch(`/api/ops/pages/${encodeURIComponent(data.pageId)}/ack`, { method: 'POST', credentials: 'include' })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          return self.registration.showNotification('Acknowledged', {
            body: 'Escalation stopped. Open the incident to work it.',
            tag: `page-${data.pageId}`,
            icon: '/icon-192.png',
            data: { ticketId: data.ticketId },
          });
        })
        // Signed out, or the phone cannot reach InfraTicket: open it so the
        // person can sign in and acknowledge there.
        .catch(() => openUrl(target)),
    );
    return;
  }
  event.waitUntil(openUrl(target));
});
