// M12 (v1.8.14) end-to-end check: install → offline → reopen, query-string URLs not cached, update prompt.
// Usage: npm run build:web && node tests/e2e/pwa-offline.e2e.mjs   (uses the pre-installed Playwright Chromium)
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/web');
if (!existsSync(resolve(root, 'sw.js'))) throw new Error('run `npm run build:web` first');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
let swSuffix = '';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end('{"error":"offline test"}');
  }
  let file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = resolve(root, 'index.html');
  let body = readFileSync(file);
  if (url.pathname === '/sw.js' && swSuffix) body = Buffer.concat([body, Buffer.from(swSuffix)]);
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': url.pathname === '/sw.js' ? 'no-cache' : 'max-age=0' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const results = {};
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  });
  // visiting a URL with a secret query string while online
  await page.goto(base + '/?invite=SECRET-INVITE');
  results.cachedUrls = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  results.queryCached = results.cachedUrls.some((u) => u.includes('?'));

  // first offline launch after install
  await context.setOffline(true);
  await page.goto(base + '/');
  results.offlineTitle = await page.title();
  // evidence that the hashed bundle executed offline: the app fills today's date into the entry form
  results.offlineScriptRan = await page.evaluate(() => Boolean(document.getElementById('dateInput')?.value));
  const missing = await page.evaluate(async () => {
    try {
      const r = await fetch('/assets/does-not-exist.js');
      return r.headers.get('content-type');
    } catch {
      return 'network-error';
    }
  });
  results.missingAssetOffline = missing;
  await context.setOffline(false);

  // update flow: a new sw.js → banner → confirm → reload into the new worker
  swSuffix = '\n// new build ' + Date.now();
  await page.goto(base + '/');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector('#swUpdateBanner', { timeout: 15000 });
  results.updateBannerShown = true;
  const nav = page.waitForNavigation({ timeout: 15000 });
  await page.click('#swUpdateBanner .btn-tinted');
  await nav;
  results.reloadedAfterConfirm = true;

  // two tabs: B confirms the update; A (still on the old bundle) is asked to reload instead of being left stale
  const pageA = page;
  const pageB = await context.newPage();
  await pageB.goto(base + '/');
  swSuffix = '\n// newer build ' + Date.now();
  for (const p of [pageA, pageB]) {
    await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  }
  await pageB.waitForSelector('#swUpdateBanner', { timeout: 15000 });
  await pageA.waitForSelector('#swUpdateBanner', { timeout: 15000 });
  const navB = pageB.waitForNavigation({ timeout: 15000 });
  await pageB.click('#swUpdateBanner .btn-tinted');
  await navB;
  await pageA.waitForFunction(
    () => (document.getElementById('swUpdateBanner')?.textContent || '').includes('其他分頁'),
    null,
    { timeout: 15000 }
  );
  results.otherTabAskedToReload = true;
  await context.close();
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(results, null, 2));
const ok =
  !results.queryCached &&
  results.offlineScriptRan &&
  results.missingAssetOffline !== 'text/html' &&
  results.updateBannerShown &&
  results.reloadedAfterConfirm &&
  results.otherTabAskedToReload;
if (!ok) {
  console.error('PWA e2e FAILED');
  process.exit(1);
}
console.log('PWA e2e OK');
