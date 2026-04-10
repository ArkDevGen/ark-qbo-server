// ARK Financial — Service Worker
// 1. Push notifications for background/closed-tab delivery
// 2. Offline-resilient page cache — serves cached dashboard during deploys

const CACHE_NAME = 'ark-shell-v1';
const SHELL_URL = '/';

// ── Install: pre-cache nothing, just activate immediately ──
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Fetch: network-first for the main page, cache as fallback ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept navigation requests to our origin's root page
  if (event.request.mode !== 'navigate') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If server returned a good response, cache it for next time
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, clone));
        }
        // If server returned 502/503, serve from cache instead
        if (response.status === 502 || response.status === 503) {
          return caches.match(SHELL_URL).then((cached) => cached || response);
        }
        return response;
      })
      .catch(() => {
        // Network error (server completely unreachable) — serve from cache
        return caches.match(SHELL_URL).then((cached) => {
          if (cached) return cached;
          // No cache available — return a minimal offline page
          return new Response(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>ARK Dashboard</title>
            <style>
              body{margin:0;font-family:'DM Sans',system-ui,sans-serif;background:#f4f2ee;display:flex;align-items:center;justify-content:center;min-height:100vh;}
              .card{background:#fff;border-radius:16px;padding:48px 56px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12);max-width:400px;}
              .spinner{width:40px;height:40px;border:3px solid #ddd9d2;border-top-color:#b8922a;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px;}
              h2{font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:700;color:#1a2440;margin:0 0 8px;}
              p{font-size:13px;color:#6a6560;line-height:1.5;margin:0 0 16px;}
              a{color:#b8922a;font-weight:600;text-decoration:none;}
              .status{font-size:11px;color:#9e9890;margin-top:16px;}
              @keyframes spin{to{transform:rotate(360deg)}}
            </style>
            <script>
              let n=0;
              setInterval(async()=>{
                n++;
                const el=document.getElementById('s');
                if(el)el.textContent='Checking server... (attempt '+n+')';
                try{const r=await fetch('/health?t='+Date.now());if(r.ok){if(el)el.textContent='Server is back! Reloading...';setTimeout(()=>location.reload(),500);}}catch(_){}
                if(n>=60&&el)el.innerHTML='Taking longer than expected. <a href="javascript:location.reload()">Try refreshing</a>';
              },3000);
            <\/script>
            </head><body><div class="card">
              <div class="spinner"></div>
              <h2>Reconnecting</h2>
              <p>The server is updating. You'll be back in a moment.</p>
              <div class="status" id="s">Checking server...</div>
            </div></body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html' } }
          );
        });
      })
  );
});

// ── Push notifications ──
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
