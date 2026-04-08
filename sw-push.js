// ARK Financial — Push Notification Service Worker
// Handles Web Push notifications for background/closed-tab delivery

self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const title = payload.title || 'ARK Financial';
    const options = {
      body: payload.body || '',
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: payload.id || 'ark-notif',
      data: { taskId: payload.taskId, url: '/' },
      requireInteraction: false,
      silent: false,
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // Fallback for plain text payloads
    event.waitUntil(
      self.registration.showNotification('ARK Financial', { body: event.data.text() })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const taskId = event.notification.data?.taskId;
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          if (taskId) {
            client.postMessage({ type: 'notif-click', taskId });
          }
          return;
        }
      }
      // Otherwise open a new tab
      return clients.openWindow(url);
    })
  );
});
