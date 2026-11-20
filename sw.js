/* Den Collective: offline-ready app (PWA). Bump VERSION every time you upload a new index.html so installed apps update. */
const VERSION = 'den-v222';
const SHELL = ['/', '/index.html', '/manifest.json', '/favicon-32x32.png?v=6', '/favicon-48x48.png?v=6', '/favicon.ico', '/apple-touch-icon.png?v=6', '/icon-192.png?v=5', '/icon-512.png?v=5', '/icon-maskable-512.png?v=5', '/logo.png', '/icon-maskable-192.png', '/assets/den-art.js?v=202', '/assets/den-wav.js?v=202'];
const EXTRA = [   // third-party files cached on install so they also work offline (fonts are added the first time the app is opened online)
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,400;1,500&family=Caveat:wght@500;600&family=Special+Elite&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js' ];   // the booth's share link needs it, so it is ready before the first QR
const FOREIGN = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await Promise.all(SHELL.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => { if (!r.ok) throw new Error(u); return c.put(u, r); })));   // always the fresh copy from the network, never an old HTTP-cached one
    await Promise.all(EXTRA.map((u) => fetch(new Request(u, { mode: 'no-cors' })).then((r) => c.put(u, r)).catch(() => {})));   // never blocks the install
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (u.origin === location.origin && u.pathname.startsWith('/api/')) return;   // cloud sign-in + sync always go straight to the network (never cached, never intercepted)
  if (r.method !== 'GET') return;
  if (u.pathname.endsWith('.apk')) return;   // the Android installer is always downloaded straight from the network, never stored in the app cache
  if (r.mode === 'navigate' && u.origin === location.origin && u.pathname !== '/' && u.pathname !== '/index.html') return;   // /privacy and /terms are real pages: open them from the network, never the app shell
  if (r.mode === 'navigate') {                                   // opening the app: NETWORK FIRST, so a reload always shows the newest version; the saved copy is only the offline fallback (or if the network takes over 4 s)
    const net = fetch(r, { cache: 'no-cache' }).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then((c) => c.put('/index.html', cp)); } return res; });
    const slow = new Promise((ok) => setTimeout(ok, 4000, null));
    e.respondWith(Promise.race([net.catch(() => null), slow]).then((res) => res || caches.match('/index.html').then((hit) => hit || net.catch(() => caches.match('/')))));
    e.waitUntil(net.catch(() => null));
    return;
  }
  if (u.origin === location.origin) {                              // the app's own scripts, styles and images: network first too (never stuck behind an old copy), saved copy only when offline
    e.respondWith(fetch(r, { cache: 'no-cache' }).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then((c) => c.put(r, cp)); } return res; }).catch(() => caches.match(r)));
    return;
  }
  if (FOREIGN.test(u.hostname)) {   // third-party fonts / libraries: saved copy first, refreshed quietly in the background
    e.respondWith(caches.match(r).then((hit) => {
      const net = fetch(r).then((res) => { if (res.ok || res.type === 'opaque') { const cp = res.clone(); caches.open(VERSION).then((c) => c.put(r, cp)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* Event reminders: tapping a notification brings the app to the front (or opens it). Local only: no push server, no network, nothing from /api. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.url && new URL(c.url).origin === location.origin && 'focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  }));
});
