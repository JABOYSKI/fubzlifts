// FubzLifts Service Worker â€” cache-first with auto-update notification
const CACHE = 'fubzlifts-2026-04-30T16:17:49Z';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/auth.js',
  './js/group.js',
  './js/session.js',
  './js/supabase.js',
  './js/utils.js',
  './js/version.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
];

const IS_DEV = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

self.addEventListener('install', event => {
  if (!IS_DEV) {
    event.waitUntil(
      caches.open(CACHE).then(cache => cache.addAll(STATIC_ASSETS))
    );
  }
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => {
      // Notify all clients that a new version is active
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
  self.clients.claim();
});

// In dev (localhost), deploy.bat never runs, so CACHE stays at the literal
// 'fubzlifts-2026-04-30T16:17:49Z' and the cache-first handler would pin a stale
// copy of any file forever â€” including a half-saved JS file with a syntax
// error, which produces a permanently blank page. Bypass the SW entirely
// on localhost (see IS_DEV check below) so dev edits show up on reload.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Let Supabase API calls bypass the SW entirely â€” browser handles them directly
  // This prevents the SW from interfering with POST/PATCH/DELETE after tab resume
  if (url.hostname.includes('supabase')) {
    return;
  }

  if (IS_DEV) return;

  // Network-first for esm.sh CDN imports
  if (url.hostname.includes('esm.sh')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
