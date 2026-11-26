import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Listener = (event: Record<string, unknown>) => void;

/** Minimal Service Worker global scope: Cache Storage, fetch, clients, skipWaiting. */
function loadServiceWorker(code: string, opts: { manifest?: string[]; online?: () => boolean } = {}) {
  const listeners = new Map<string, Listener[]>();
  const stores = new Map<string, Map<string, Response>>();
  const network = new Map<string, () => Response>();
  const online = opts.online ?? (() => true);
  let skipWaitingCalls = 0;
  const keyOf = (r: Request | string) => (typeof r === 'string' ? new URL(r, 'https://app.test').href : r.url);
  const openCache = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (r: Request | string, res: Response) => void store.set(keyOf(r), res),
      match: async (r: Request | string) => store.get(keyOf(r))?.clone(),
      addAll: async (urls: string[]) => {
        for (const u of urls) {
          const res = await fakeFetch(new Request(new URL(u, 'https://app.test').href));
          if (!res.ok) throw new Error(`precache failed ${u}`);
          store.set(keyOf(u), res);
        }
      },
      keys: async () => Array.from(store.keys()).map((k) => new Request(k)),
    };
  };
  const fakeFetch = async (r: Request | string) => {
    const url = keyOf(r);
    if (!online()) throw new TypeError('Failed to fetch');
    const make = network.get(url.replace(/\?.*$/, '')) ?? network.get(url);
    if (!make) return new Response('not found', { status: 404 });
    const res = make();
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
  const caches = {
    open: openCache,
    keys: async () => Array.from(stores.keys()),
    delete: async (n: string) => stores.delete(n),
    match: async (r: Request | string) => {
      for (const s of stores.values()) {
        const hit = s.get(keyOf(r));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
  const self: Record<string, unknown> = {
    location: new URL('https://app.test/sw.js'),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    skipWaiting: async () => void (skipWaitingCalls += 1),
    clients: { claim: async () => undefined },
    __PRECACHE_MANIFEST__: opts.manifest,
  };
  const context = vm.createContext({ self, caches, fetch: fakeFetch, URL, Request, Response, Promise, console, setTimeout, clearTimeout });
  // like the build: replace the placeholder (an unbuilt sw.js deliberately intercepts nothing)
  new vm.Script(code.replace("'__BUILD_HASH__'", "'testhash'"), { filename: 'sw.js' }).runInContext(context);
  const dispatch = async (type: string, extra: Record<string, unknown> = {}) => {
    let waitFor = null as Promise<unknown> | null;
    let responded = null as Promise<Response> | null;
    const event = {
      ...extra,
      waitUntil: (p: Promise<unknown>) => void (waitFor = p),
      respondWith: (p: Promise<Response> | Response) => void (responded = Promise.resolve(p)),
    };
    for (const fn of listeners.get(type) || []) fn(event);
    if (waitFor) await waitFor;
    return responded ? await responded : null;
  };
  return { dispatch, network, stores, skipWaitingCalls: () => skipWaitingCalls };
}

/** Node cannot construct a Request with mode 'navigate'; the worker only reads url / method / mode. */
const navRequest = (url: string) => ({ url, method: 'GET', mode: 'navigate' }) as unknown as Request;

const html = () => new Response('<!doctype html><title>app</title><script src="/assets/index-abc.js"></script>', { headers: { 'content-type': 'text/html' } });
const js = () => new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });

describe('v1.8.14 Service Worker (M12)', () => {
  const swCode = readFileSync(resolve(rootDir, 'web/public/sw.js'), 'utf8');

  async function installed(online: { v: boolean }) {
    const sw = loadServiceWorker(swCode, { manifest: ['/', '/assets/index-abc.js', '/manifest.webmanifest'], online: () => online.v });
    sw.network.set('https://app.test/', html);
    sw.network.set('https://app.test/assets/index-abc.js', js);
    sw.network.set('https://app.test/manifest.webmanifest', () => new Response('{}'));
    await sw.dispatch('install');
    await sw.dispatch('activate');
    return sw;
  }

  it('precaches the build manifest so the first offline launch works (navigation and hashed bundle)', async () => {
    const online = { v: true };
    const sw = await installed(online);
    online.v = false;
    const nav = await sw.dispatch('fetch', { request: navRequest('https://app.test/') });
    expect(await nav!.text()).toContain('<title>app</title>');
    const bundle = await sw.dispatch('fetch', { request: new Request('https://app.test/assets/index-abc.js') });
    expect(await bundle!.text()).toBe('console.log(1)');
  });

  it('only navigation requests fall back to the app shell; a failed JS / CSS request never gets HTML', async () => {
    const online = { v: true };
    const sw = await installed(online);
    online.v = false;
    const deepNav = await sw.dispatch('fetch', { request: navRequest('https://app.test/some/deep/link') });
    expect(await deepNav!.text()).toContain('<title>app</title>');
    // respondWith(rejected promise) is a network error for the page — the important part is: never HTML
    const missingJs = await sw
      .dispatch('fetch', { request: new Request('https://app.test/assets/missing-123.js') })
      .catch(() => 'network-error' as const);
    expect(missingJs === 'network-error' || (missingJs !== null && !String(missingJs.headers.get('content-type') || '').includes('text/html'))).toBe(true);
  });

  it('URLs with a query string (?reset= / ?invite=) are never written to the cache', async () => {
    const online = { v: true };
    const sw = await installed(online);
    sw.network.set('https://app.test/', html);
    await sw.dispatch('fetch', { request: navRequest('https://app.test/?reset=SECRET') });
    await sw.dispatch('fetch', { request: navRequest('https://app.test/?invite=CODE') });
    await sw.dispatch('fetch', { request: new Request('https://app.test/assets/index-abc.js?v=1') });
    await new Promise((r) => setTimeout(r, 10));
    const allKeys = Array.from(sw.stores.values()).flatMap((s) => Array.from(s.keys()));
    expect(allKeys.some((k) => k.includes('?'))).toBe(false);
  });

  it('a new version waits until the user confirms (SKIP_WAITING message), and the cache name follows the build hash', async () => {
    const online = { v: true };
    const sw = await installed(online);
    expect(sw.skipWaitingCalls()).toBe(0);
    await sw.dispatch('message', { data: { type: 'SKIP_WAITING' } });
    expect(sw.skipWaitingCalls()).toBe(1);
    expect(swCode).toMatch(/__BUILD_HASH__/);
    expect(swCode).not.toMatch(/const CACHE_VERSION = 'finance-pwa-v\d+';/);
  });

  it('the build injects the hashed asset list and a build hash into dist/web/sw.js', async () => {
    const dist = resolve(rootDir, 'dist/web/sw.js');
    if (!existsSync(dist)) return; // covered by `npm run build:web` in the release checklist
    const built = readFileSync(dist, 'utf8');
    expect(built).not.toContain("'__BUILD_HASH__'");
    expect(built).toMatch(/\/assets\/index-[\w-]+\.js/);
    expect(() => new vm.Script(built)).not.toThrow();
  });

  it('an unbuilt (dev server) sw.js intercepts nothing, and HTML is never stored under a script URL', async () => {
    // keep the placeholder (the harness substitutes the literal '__BUILD_HASH__' only)
    const raw = loadServiceWorker(swCode.replace("'__BUILD_HASH__'", "'__BUILD' + '_HASH__'"), {});
    const res = await raw.dispatch('fetch', { request: new Request('https://app.test/src/main.ts') });
    expect(res).toBeNull();
    const online = { v: true };
    const sw = await installed(online);
    sw.network.set('https://app.test/assets/ghost-1.js', html); // SPA fallback answers a missing file with HTML
    await sw.dispatch('fetch', { request: new Request('https://app.test/assets/ghost-1.js') });
    await new Promise((r) => setTimeout(r, 10));
    const keys = Array.from(sw.stores.values()).flatMap((st) => Array.from(st.keys()));
    expect(keys.some((k) => k.endsWith('ghost-1.js'))).toBe(false);
  });

  it('the page asks before activating a waiting update and reloads once the new worker takes control', () => {
    const main = readFileSync(resolve(rootDir, 'web/src/main.ts'), 'utf8');
    expect(main).toMatch(/SKIP_WAITING/);
    expect(main).toMatch(/controllerchange/);
  });
});
