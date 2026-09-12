/**
 * DENTSHUB RISET - Service Worker (PWA Offline Shell & Network-First Caching)
 * Version: 1.0.0
 */

const CACHE_NAME = 'dentshub-riset-cache-v1';
const PRECACHE_ASSETS = [
  '/',
  '/css/main.css',
  '/img/dentshubriset.png',
  '/img/og-thumbnail.png',
  '/img/favicon-192x192.png',
  '/img/favicon-32x32.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).catch((err) => {
      console.warn('[PWA SW] Precache assets warning:', err);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Hanya tangani GET request, abaikan POST, PUT, DELETE, dll.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Jangan sentuh request API internal, billing, webhook, atau SSE
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/billing/webhook') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/asisten/')
  ) {
    return;
  }

  // Network-First Strategy dengan Cache Fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Simpan salinan respon sukses untuk aset statis lokal
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          url.origin === self.location.origin &&
          (url.pathname.startsWith('/css/') || url.pathname.startsWith('/img/') || url.pathname === '/manifest.json')
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
            return caches.match('/');
          }
        });
      })
  );
});
