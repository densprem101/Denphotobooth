/* Den Collective: offline-ready app (PWA). Bump VERSION every time you upload a new index.html so installed apps update. */
const VERSION = 'den-v209';
const SHELL = ['/', '/index.html', '/manifest.json', '/favicon-32x32.png?v=6', '/favicon-48x48.png?v=6', '/favicon.ico', '/apple-touch-icon.png?v=6', '/icon-192.png?v=5', '/icon-512.png?v=5', '/icon-maskable-512.png?v=5', '/logo.png', '/icon-maskable-192.png', '/assets/den-art.js?v=202', '/assets/den-wav.js?v=202'];
const EXTRA = [   // third-party files cached on install so they also work offline (fonts are added the first time the app is opened online)
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,400;1,500&family=Caveat:wght@500;600&family=Special+Elite&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js' ];   // the booth's share link needs it, so it is ready before the first QR
const FOREIGN = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(SHELL);
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
  if (r.mode === 'navigate') {                                   // opening the app: the saved page opens at once; a fresh copy is fetched quietly for next time
    const upd = fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then((c) => c.put('/index.html', cp)); } return res; }).catch(() => null);
    e.waitUntil(upd);
    e.respondWith(caches.match('/index.html').then((hit) => hit || upd.then((res) => res || caches.match('/'))));
    return;
  }
  if (u.origin === location.origin || FOREIGN.test(u.hostname)) {   // everything else: saved copy first, refreshed quietly in the background
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
