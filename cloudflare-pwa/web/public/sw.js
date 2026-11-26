const CACHE_VERSION = 'finance-pwa-v27';
const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // API 請求一律走網路（由前端 IndexedDB SyncEngine 掌控離線存取，不經 SW 快取）
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 同源靜態資源：Cache-First + 背景更新（Stale-While-Revalidate）
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const cloned = res.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, cloned));
            }
            return res;
          })
          .catch(() => cached || caches.match('/index.html'));

        return cached || networkFetch;
      })
    );
  }
});
