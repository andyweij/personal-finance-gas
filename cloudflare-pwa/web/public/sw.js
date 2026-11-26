/*
 * M12 (v1.8.14) Service Worker.
 *
 * - The precache list and the build hash are injected at build time by the `sw-precache` plugin in
 *   vite.config.ts (dist/web/sw.js). The cache name follows the build hash, so it never has to be bumped by hand.
 *   This source file (served as-is by the dev server) falls back to the minimal app shell.
 * - A new version is installed in the background but only activated after the user confirms the in-app
 *   "有更新" prompt (the page posts { type: 'SKIP_WAITING' }).
 * - Only navigation requests fall back to the cached app shell; a failed script / style / image request is a
 *   network error, never an HTML page.
 * - URLs with a query string (e.g. /?reset=CODE, /?invite=CODE) are never written to the cache.
 */
const CACHE_PREFIX = 'finance-pwa';
const BUILD_HASH = '__BUILD_HASH__';
const CACHE_VERSION = `${CACHE_PREFIX}-${BUILD_HASH === '__BUILD' + '_HASH__' ? 'dev' : BUILD_HASH}`;
const SHELL_URL = '/';
const FALLBACK_PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon.svg',
];
const PRECACHE_URLS =
  Array.isArray(self.__PRECACHE_MANIFEST__) && self.__PRECACHE_MANIFEST__.length > 0
    ? self.__PRECACHE_MANIFEST__
    : FALLBACK_PRECACHE;

self.addEventListener('install', (event) => {
  // No skipWaiting() here: the page decides when the new version takes over.
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      for (const path of PRECACHE_URLS) {
        const url = new URL(path, self.location.origin);
        const res = await fetch(new Request(url.href, { cache: 'reload' }));
        if (!res.ok || looksLikeWrongType(url, res)) {
          throw new Error(`precache failed: ${path}`); // install fails → the current version keeps running
        }
        await cache.put(path, res);
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

const IS_DEV_BUILD = BUILD_HASH === '__BUILD' + '_HASH__';

/**
 * Review (M12): Workers Static Assets with single-page-application fallback answer a missing file with
 * index.html (200). Never store HTML under a script / style URL — that would turn a gradual deployment race
 * into a white screen for the whole version.
 */
function looksLikeWrongType(url, res) {
  const type = String((res.headers && res.headers.get('content-type')) || '');
  return /\.(js|mjs|css)$/.test(url.pathname) && type.includes('text/html');
}

function isCacheable(url, res) {
  return Boolean(res && res.status === 200 && res.type === 'basic' && !url.search && !looksLikeWrongType(url, res));
}

async function fromCache(request) {
  const cache = await caches.open(CACHE_VERSION);
  return cache.match(request);
}

async function handleNavigation(request) {
  // App shell first (offline-first, and consistent with the precached bundle of this version)
  const shell = await fromCache(SHELL_URL);
  if (shell) return shell;
  try {
    const res = await fetch(request);
    const url = new URL(request.url);
    if (url.pathname === SHELL_URL && isCacheable(url, res)) {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(SHELL_URL, copy));
    }
    return res;
  } catch (err) {
    const anyShell = await caches.match(SHELL_URL);
    if (anyShell) return anyShell;
    throw err;
  }
}

async function handleAsset(request) {
  const url = new URL(request.url);
  const cached = url.search ? null : await fromCache(request);
  if (cached) return cached;
  const res = await fetch(request); // a failure stays a failure — never an HTML fallback
  if (isCacheable(url, res)) {
    const copy = res.clone();
    caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (IS_DEV_BUILD) return; // unbuilt sw.js (dev server): never intercept
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API 請求一律走網路（由前端 IndexedDB SyncEngine 掌控離線存取，不經 SW 快取）
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }
  event.respondWith(handleAsset(req));
});
