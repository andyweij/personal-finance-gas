import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../worker/index';
import { cleanupExpiredAuthData } from '../worker/auth';
import type { WorkerEnv } from '../worker/types';
import { escapeHtml } from '../web/src/ui/helpers';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

type App = ReturnType<typeof createApp>;

function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') || '').split(';')[0] || '';
}

function req(
  app: App,
  env: WorkerEnv,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip || '10.0.0.1', ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  return app.request(
    path,
    {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    },
    env
  );
}

async function setup() {
  const app = createApp();
  const env = { DB: createTestD1(), SETUP_SECRET: 'secret-123' } as WorkerEnv;
  const setupRes = await req(app, env, '/api/auth/setup', {
    method: 'POST',
    body: { setupSecret: 'secret-123', username: 'admin', displayName: '管理員', password: 'AdminPassword123!' },
  });
  expect(setupRes.status).toBe(200);
  const adminCookie = cookieOf(setupRes);
  const invite = (await (
    await req(app, env, '/api/admin/invites', { method: 'POST', cookie: adminCookie, body: { expiresInDays: 7 } })
  ).json()) as { inviteCode: string };
  const reg = await req(app, env, '/api/auth/register-invite', {
    method: 'POST',
    ip: '10.0.0.2',
    body: { inviteCode: invite.inviteCode, username: 'mom', displayName: '媽媽', password: 'MomPassword123!' },
  });
  expect(reg.status).toBe(200);
  const momCookie = cookieOf(reg);
  const mom = ((await reg.json()) as { user: { id: string } }).user;
  return { app, env, adminCookie, momCookie, momId: mom.id };
}

describe('v1.8.11 security', () => {
  it('H4: escapeHtml neutralises markup, and no UI template inserts names / notes into HTML unescaped', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml("a&b'c")).toBe('a&amp;b&#39;c');

    // Regression guard: a template literal that builds HTML must not interpolate user-provided text fields raw
    const uiDir = resolve(root, 'web/src/ui');
    const offenders: string[] = [];
    for (const f of readdirSync(uiDir).filter((n) => n.endsWith('.ts'))) {
      const lines = readFileSync(resolve(uiDir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('<') || !line.includes('${')) return;
        const raw = /\$\{\s*[\w.?]*\.(itemName|name|note|displayName|username|category|ticker)\s*\}/.exec(line);
        if (raw) offenders.push(`${f}:${i + 1}: ${raw[0]}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('M10: the app shell is served with a strict CSP and anti-framing headers', () => {
    const headers = readFileSync(resolve(root, 'web/public/_headers'), 'utf8');
    expect(headers).toMatch(/Content-Security-Policy:.*script-src 'self'/);
    expect(headers).toMatch(/frame-ancestors 'none'/);
    expect(headers).toMatch(/object-src 'none'/);
    expect(headers).toMatch(/X-Content-Type-Options: nosniff/);
  });

  it('M10: cross-site and non-JSON state-changing API requests are refused', async () => {
    const { app, env } = await setup();
    const body = { username: 'admin', password: 'AdminPassword123!' };
    expect((await req(app, env, '/api/auth/login', { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await req(app, env, '/api/auth/login', { method: 'POST', body, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect(
      (
        await req(app, env, '/api/auth/login', {
          method: 'POST',
          body: 'username=admin',
          headers: { 'content-type': 'text/plain', 'content-length': '14' },
        })
      ).status
    ).toBe(415);
    expect((await req(app, env, '/api/auth/login', { method: 'POST', body, headers: { origin: 'http://localhost' } })).status).toBe(200);
  });

  it('H2: parallel wrong-password logins cannot all slip past the limiter', async () => {
    const { app, env } = await setup();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        req(app, env, '/api/auth/login', { method: 'POST', ip: '10.9.9.9', body: { username: 'mom', password: 'wrong-password' } })
      )
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(25);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
  });

  it('H2: a per-account budget applies across many IPs, and IPv6 addresses in one /64 share a counter', async () => {
    const { app, env } = await setup();
    let blocked = 0;
    for (let i = 0; i < 25; i++) {
      const r = await req(app, env, '/api/auth/login', {
        method: 'POST',
        ip: `10.1.${i}.1`,
        body: { username: 'mom', password: 'wrong-password' },
      });
      if (r.status === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);

    const { app: app2, env: env2 } = await setup();
    const v6 = await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        req(app2, env2, '/api/auth/login', {
          method: 'POST',
          ip: `2001:db8:1:2::${(i + 1).toString(16)}`,
          body: { username: 'mom', password: 'wrong-password' },
        })
      )
    );
    expect(v6.some((r) => r.status === 429)).toBe(true);
  });

  it('M2: guessing the current password through change-password is rate limited', async () => {
    const { app, env, momCookie } = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await req(app, env, '/api/auth/change-password', {
        method: 'POST',
        cookie: momCookie,
        body: { currentPassword: `guess-${i}`, newPassword: 'NewPassword123!' },
      });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });

  it('H1: a reset with an admin-issued code is audited, notified to the member, and clears passkeys and PIN', async () => {
    const { app, env, adminCookie, momId } = await setup();
    await env.DB.prepare(
      `INSERT INTO auth_passkeys (credential_id, user_id, public_key, counter, transports, device_name, created_at)
       VALUES ('cred-mom', ?, 'pk', 0, '[]', 'iPhone', '2026-11-01T00:00:00.000Z')`
    )
      .bind(momId)
      .run();
    await env.DB.prepare("UPDATE users SET pin_enabled = 1, pin_hash = 'h', pin_salt = 's' WHERE id = ?").bind(momId).run();

    const gen = await req(app, env, `/api/admin/users/${momId}/reset-code`, { method: 'POST', cookie: adminCookie, body: {} });
    const { resetCode } = (await gen.json()) as { resetCode: string };
    const done = await req(app, env, '/api/auth/reset-password', {
      method: 'POST',
      ip: '10.0.0.7',
      body: { username: 'mom', resetCode, newPassword: 'TakenOver123!' },
    });
    expect(done.status).toBe(200);

    const passkeys = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_passkeys WHERE user_id = ?').bind(momId).first<{ n: number }>();
    expect(Number(passkeys?.n)).toBe(0);
    const pin = await env.DB.prepare('SELECT pin_enabled, pin_hash FROM users WHERE id = ?').bind(momId).first<{ pin_enabled: number; pin_hash: string | null }>();
    expect(pin).toEqual({ pin_enabled: 0, pin_hash: null });

    const login = await req(app, env, '/api/auth/login', { method: 'POST', ip: '10.0.0.8', body: { username: 'mom', password: 'TakenOver123!' } });
    const status = (await (await req(app, env, '/api/auth/status', { cookie: cookieOf(login) })).json()) as {
      securityNotices?: Array<{ kind: string; actorDisplayName: string | null }>;
    };
    expect(status.securityNotices?.[0]?.kind).toBe('password_reset_with_admin_code');
    expect(status.securityNotices?.[0]?.actorDisplayName).toBe('管理員');
  });

  it('M1: a session expires 90 days after sign-in even if it keeps being used, and is not rewritten on every request', async () => {
    const { app, env, momCookie } = await setup();
    // Each request within a day must not write the session row
    const before = await env.DB.prepare('SELECT last_seen_at FROM auth_sessions').first<{ last_seen_at: string }>();
    await req(app, env, '/api/auth/status', { cookie: momCookie });
    await req(app, env, '/api/auth/status', { cookie: momCookie });
    const rows = await env.DB.prepare('SELECT last_seen_at FROM auth_sessions').all<{ last_seen_at: string }>();
    expect(rows.results.map((r) => r.last_seen_at)).toContain(before?.last_seen_at);

    // A session signed in 100 days ago is rejected although its sliding expiry is still in the future
    await env.DB.prepare('UPDATE auth_sessions SET created_at = ?, expires_at = ?').bind(
      new Date(Date.now() - 100 * 86_400_000).toISOString(),
      new Date(Date.now() + 10 * 86_400_000).toISOString()
    ).run();
    const st = (await (await req(app, env, '/api/auth/status', { cookie: momCookie })).json()) as { authenticated: boolean };
    expect(st.authenticated).toBe(false);
  });

  it('M1: daily cleanup removes expired sessions, stale rate limits and old idempotency rows', async () => {
    const db = createTestD1();
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await db.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, device_label, expires_at, created_at, last_seen_at)
       VALUES ('old', 'owner', '', ?, ?, ?), ('live', 'owner', '', ?, ?, ?)`
    ).bind(old, old, old, future, new Date().toISOString(), new Date().toISOString()).run();
    await db.prepare("INSERT INTO auth_rate_limits (ip_key, fail_count, locked_until, updated_at) VALUES ('k', 3, NULL, ?)").bind(old).run();
    await db.prepare("INSERT INTO sync_idempotency (user_id, mutation_id, applied_at) VALUES ('owner', 'm-old', ?)").bind(old).run();

    await cleanupExpiredAuthData(db);

    const sessions = await db.prepare('SELECT token_hash FROM auth_sessions').all<{ token_hash: string }>();
    expect(sessions.results.map((r) => r.token_hash)).toEqual(['live']);
    expect(await db.prepare("SELECT 1 FROM auth_rate_limits WHERE ip_key = 'k'").first()).toBeNull();
    expect(await db.prepare("SELECT 1 FROM sync_idempotency WHERE mutation_id = 'm-old'").first()).toBeNull();
  });

  it('H3: logging out wipes this account\'s local database', async () => {
    const name = `v1811-wipe-${crypto.randomUUID()}`;
    const localDb = new LocalFinanceDB(name);
    const engine = new SyncEngine(localDb, {
      fetchImpl: (async () => new Response('{}', { status: 503 })) as typeof fetch,
      isOnline: () => false,
      requestLock: async (_n, fn) => fn(),
    });
    await engine.init();
    await engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '機密', amount: 100, currency: 'TWD' });

    await engine.wipeLocalData();

    const reopened = new LocalFinanceDB(name);
    await reopened.open();
    expect((await reopened.getSnapshot()).cashflowLogs).toHaveLength(0);
    expect(await reopened.getOutbox()).toHaveLength(0);
    reopened.close();
  });

  it('M10 (blocker regression): a bodyless POST — as workerd delivers it, with Content-Length: 0 — is not refused', async () => {
    const { app, env, momCookie } = await setup();
    const logout = await app.request(
      '/api/auth/logout',
      {
        method: 'POST',
        headers: { cookie: momCookie, 'content-length': '0' },
        body: new ReadableStream({ start: (c) => c.close() }),
        duplex: 'half',
      } as RequestInit,
      env
    );
    expect(logout.status).toBe(200);
    const after = (await (await req(app, env, '/api/auth/status', { cookie: momCookie })).json()) as { authenticated: boolean };
    expect(after.authenticated).toBe(false);
  });

  it('H2: a blocked attacker IP cannot spend the per-account budget and lock the real user out', async () => {
    const { app, env } = await setup();
    for (let i = 0; i < 40; i++) {
      await req(app, env, '/api/auth/login', { method: 'POST', ip: '10.66.66.66', body: { username: 'mom', password: 'wrong' } });
    }
    const real = await req(app, env, '/api/auth/login', {
      method: 'POST',
      ip: '10.0.0.2',
      body: { username: 'mom', password: 'MomPassword123!' },
    });
    expect(real.status).toBe(200);
  });

  it('M1: when the server extends a session it also re-issues the cookie with the remaining lifetime', async () => {
    const { app, env, momCookie } = await setup();
    await env.DB.prepare('UPDATE auth_sessions SET last_seen_at = ?, created_at = ?').bind(
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
      new Date(Date.now() - 80 * 86_400_000).toISOString()
    ).run();
    const res = await req(app, env, '/api/auth/status', { cookie: momCookie });
    const setCookie = res.headers.get('set-cookie') || '';
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
    // 10 days left before the 90-day cap
    expect(maxAge).toBeGreaterThan(9 * 86_400);
    expect(maxAge).toBeLessThanOrEqual(10 * 86_400);
  });
});
