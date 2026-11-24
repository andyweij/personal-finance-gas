import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  buildSessionCookie,
  checkRateLimit,
  clearRateLimit,
  configureOwnerPin,
  constantTimeEqual,
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  createSession,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  getAuthOwner,
  recordLoginFailure,
  revokeSession,
  setupOwnerPassword,
  verifyOwnerPassword,
  verifySessionCookie,
} from './auth';
import {
  ensureAppSettings,
  exportFullSnapshot,
  importFullSnapshot,
  processSyncRequest,
} from './sync';
import {
  getTaiwanDateParts,
  isTaiwanMonthEnd,
  runMonthEndSnapshotD1,
  runMonthlyRecurringD1,
} from './automation';
import { refreshMarketData } from './market';
import { parseCashFlowCsv } from '../shared/csv';
import type { SyncRequest } from '../shared/types';
import type { WorkerEnv } from './types';

function getClientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  );
}

function getOriginAndRpId(c: Context): { origin: string; rpID: string; isHttps: boolean } {
  const url = new URL(c.req.url);
  return {
    origin: url.origin,
    rpID: url.hostname,
    isHttps: url.protocol === 'https:',
  };
}

export function createApp() {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  // Security headers for all API responses
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
  });

  // Auth status (public, no financial data exposed)
  app.get('/api/auth/status', async (c) => {
    const owner = await getAuthOwner(c.env.DB);
    const session = await verifySessionCookie(c.env.DB, c.req.header('cookie'));
    const passkeyRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM auth_passkeys').first<{
      cnt: number;
    }>();

    return c.json({
      initialized: Boolean(owner),
      authenticated: session.valid,
      pinEnabled: Boolean(owner && owner.pin_enabled === 1 && owner.pin_hash),
      pinSalt: session.valid && owner?.pin_enabled === 1 ? owner.pin_salt : null,
      pinHash: session.valid && owner?.pin_enabled === 1 ? owner.pin_hash : null,
      passkeyCount: Number(passkeyRow?.cnt || 0),
    });
  });

  // First-time owner password setup (protected by SETUP_SECRET Worker Secret)
  app.post('/api/auth/setup', async (c) => {
    const existing = await getAuthOwner(c.env.DB);
    if (existing) {
      return c.json({ error: '系統已完成初始化，禁止重複設定。' }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      setupSecret?: string;
      password?: string;
    };

    const expectedSecret = c.env.SETUP_SECRET || '';
    if (!expectedSecret) {
      return c.json({ error: '伺服器尚未設定 SETUP_SECRET，請先透過 wrangler secret put SETUP_SECRET 設定。' }, 500);
    }
    if (!body.setupSecret || !constantTimeEqual(String(body.setupSecret), expectedSecret)) {
      return c.json({ error: '初始化密鑰錯誤。' }, 403);
    }

    try {
      await setupOwnerPassword(c.env.DB, String(body.password || ''));
      await ensureAppSettings(c.env.DB);
      const token = await createSession(c.env.DB, c.req.header('user-agent') || 'setup');
      const { isHttps } = getOriginAndRpId(c);
      c.header('Set-Cookie', buildSessionCookie(token, isHttps));
      return c.json({ ok: true, message: '初始化完成並已登入。' });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '初始化失敗' }, 400);
    }
  });

  // Master password login with D1 brute-force rate limit
  app.post('/api/auth/login', async (c) => {
    const ip = getClientIp(c);
    const limit = await checkRateLimit(c.env.DB, ip);
    if (limit.blocked) {
      return c.json(
        { error: `登入失敗次數過多，請於 ${Math.ceil((limit.retryAfterSec || 900) / 60)} 分鐘後再試。` },
        429
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    const ok = await verifyOwnerPassword(c.env.DB, String(body.password || ''));
    if (!ok) {
      await recordLoginFailure(c.env.DB, ip);
      return c.json({ error: '主密碼不正確。' }, 401);
    }

    await clearRateLimit(c.env.DB, ip);
    const token = await createSession(c.env.DB, c.req.header('user-agent') || 'browser');
    const { isHttps } = getOriginAndRpId(c);
    c.header('Set-Cookie', buildSessionCookie(token, isHttps));
    return c.json({ ok: true });
  });

  // Logout (current device or ?all=1)
  app.post('/api/auth/logout', async (c) => {
    const revokeAll = c.req.query('all') === '1';
    await revokeSession(c.env.DB, c.req.header('cookie'), revokeAll);
    const { isHttps } = getOriginAndRpId(c);
    c.header('Set-Cookie', buildSessionCookie('', isHttps, true));
    return c.json({ ok: true });
  });

  // Passkey login (public)
  app.post('/api/auth/passkey/login/options', async (c) => {
    try {
      const { rpID } = getOriginAndRpId(c);
      const options = await createPasskeyAuthenticationOptions(c.env.DB, rpID);
      return c.json(options);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '無法產生 Passkey 選項' }, 400);
    }
  });

  app.post('/api/auth/passkey/login/verify', async (c) => {
    const ip = getClientIp(c);
    const limit = await checkRateLimit(c.env.DB, ip);
    if (limit.blocked) {
      return c.json({ error: '嘗試次數過多，請稍後再試。' }, 429);
    }
    try {
      const { rpID, origin, isHttps } = getOriginAndRpId(c);
      const body = (await c.req.json()) as AuthenticationResponseJSON;
      await finishPasskeyAuthentication(c.env.DB, rpID, origin, body);
      await clearRateLimit(c.env.DB, ip);
      const token = await createSession(c.env.DB, c.req.header('user-agent') || 'passkey');
      c.header('Set-Cookie', buildSessionCookie(token, isHttps));
      return c.json({ ok: true });
    } catch (err) {
      await recordLoginFailure(c.env.DB, ip);
      return c.json({ error: err instanceof Error ? err.message : 'Passkey 登入失敗' }, 401);
    }
  });

  // Authentication middleware for all remaining protected API endpoints
  const requireAuth = async (c: Context<{ Bindings: WorkerEnv }>, next: () => Promise<void>) => {
    const session = await verifySessionCookie(c.env.DB, c.req.header('cookie'));
    if (!session.valid) {
      return c.json({ error: 'AUTH_REQUIRED' }, 401);
    }
    await next();
  };

  app.post('/api/auth/passkey/register/options', requireAuth, async (c) => {
    const { rpID } = getOriginAndRpId(c);
    const options = await createPasskeyRegistrationOptions(c.env.DB, rpID);
    return c.json(options);
  });

  app.post('/api/auth/passkey/register/verify', requireAuth, async (c) => {
    try {
      const { rpID, origin } = getOriginAndRpId(c);
      const body = (await c.req.json()) as {
        response: RegistrationResponseJSON;
        deviceName?: string;
      };
      const res = await finishPasskeyRegistration(
        c.env.DB,
        rpID,
        origin,
        body.response,
        body.deviceName || '我的裝置'
      );
      return c.json(res);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Passkey 綁定失敗' }, 400);
    }
  });

  app.post('/api/auth/pin', requireAuth, async (c) => {
    try {
      const body = (await c.req.json()) as {
        enable: boolean;
        currentPin?: string;
        newPin?: string;
      };
      const result = await configureOwnerPin(c.env.DB, body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'PIN 設定失敗' }, 400);
    }
  });

  // Core Offline-First Bidirectional Sync Endpoint
  app.post('/api/sync', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({ mutations: [] }))) as SyncRequest;
    const res = await processSyncRequest(c.env.DB, body);
    return c.json(res);
  });

  // Manual Automation Triggers
  app.post('/api/automation/recurring', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { year?: number; month?: number };
    const result = await runMonthlyRecurringD1(c.env.DB, body.year, body.month);
    return c.json({ ok: true, ...result });
  });

  app.post('/api/automation/snapshot', requireAuth, async (c) => {
    const result = await runMonthEndSnapshotD1(c.env.DB);
    return c.json({ ok: true, ...result });
  });

  app.post('/api/market/refresh', requireAuth, async (c) => {
    const result = await refreshMarketData(c.env.DB);
    return c.json({ ok: true, ...result });
  });

  // Data Portability: JSON Export/Import & GAS CSV Import
  app.get('/api/export/json', requireAuth, async (c) => {
    const data = await exportFullSnapshot(c.env.DB);
    return c.json({
      exportedAt: new Date().toISOString(),
      version: 1,
      data,
    });
  });

  app.post('/api/import/json', requireAuth, async (c) => {
    try {
      const body = (await c.req.json()) as { mode?: 'merge' | 'replace'; data?: Record<string, unknown> };
      const summary = await importFullSnapshot(
        c.env.DB,
        (body.data || body) as never,
        body.mode === 'replace' ? 'replace' : 'merge'
      );
      return c.json({ ok: true, ...summary });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'JSON 匯入失敗' }, 400);
    }
  });

  app.post('/api/import/csv', requireAuth, async (c) => {
    try {
      const body = (await c.req.json()) as { csvText?: string };
      const settings = await ensureAppSettings(c.env.DB);
      const rows = parseCashFlowCsv(String(body.csvText || ''), settings.usdTwdRate);
      const nowIso = new Date().toISOString();
      for (const v of rows) {
        await c.env.DB
          .prepare(
            `INSERT INTO cashflow_logs
              (id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
          )
          .bind(
            crypto.randomUUID(),
            v.date,
            v.yearMonth,
            v.type,
            v.category,
            v.itemName,
            v.amount,
            v.currency,
            v.fxRate,
            v.twdAmount,
            v.source,
            v.note,
            nowIso,
            nowIso
          )
          .run();
      }
      return c.json({ ok: true, importedCount: rows.length });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'CSV 解析或匯入失敗' }, 400);
    }
  });

  // Fallback to static PWA assets when running on Cloudflare Workers
  app.all('*', async (c) => {
    if (c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.text('Not Found', 404);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const now = new Date(controller.scheduledTime || Date.now());
    const tw = getTaiwanDateParts(now);

    if (controller.cron === '0 0 1 * *') {
      await refreshMarketData(env.DB);
      await runMonthlyRecurringD1(env.DB, tw.year, tw.month);
      return;
    }

    // Daily 23:00 Asia/Taipei (15:00 UTC): refresh prices & FX, snapshot on month-end
    await refreshMarketData(env.DB);
    if (isTaiwanMonthEnd(now)) {
      await runMonthEndSnapshotD1(env.DB, now);
    }
  },
};
