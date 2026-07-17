/* LT v0.1 service worker — offline app shell.
   Strategy: pre-cache the shell; cache-first for shell assets;
   video clips are NETWORK ONLY (too large to pre-cache; brief allows it). */

const CACHE_NAME = 'tacillon-shell-v24';

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/backend.js',
  './js/sync.js',
  './js/builder.js',
  './js/vendor/supabase.js',
  './js/vendor/qrcode.js',
  './js/manual.js',
  './js/publish.js',
  './js/ledger.js',
  './js/speech.js',
  './js/gates.js',
  './js/closure.js',
  './js/scan.js',
  './js/severity.js',
  './js/session.js',
  './js/review.js',
  './kc/pool-cleaning.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Supabase (auth, database, video storage): network only, never cached here.
  if (url.origin !== self.location.origin) return;

  // Videos: pass straight to network (supports range requests for seeking).
  if (url.pathname.includes('/clips/')) return;

  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        // Cache same-origin successful responses so updates self-heal.
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
