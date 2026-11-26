import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  adminUpdateUser,
  buildSessionCookie,
  changeUserPassword,
  checkAndRecordFixedWindowRateLimit,
  checkRateLimit,
  clearRateLimit,
  configureUserPin,
  constantTimeEqual,
  createInviteCode,
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  createPasswordResetCode,
  createSession,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  hasAnyUser,
  listAdminUsers,
  listInvites,
  recordLoginFailure,
  registerWithInviteCode,
  resetPasswordWithCode,
  revokeInviteCode,
  revokeSession,
  setupInitialAdmin,
  toAuthUser,
  updateUserProfile,
  verifySessionCookie,
  verifyUserPassword,
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
  runMonthEndSnapshotAllUsersD1,
  runMonthEndSnapshotD1,
  runMonthlyRecurringAllUsersD1,
  runMonthlyRecurringD1,
} from './automation';
import { refreshMarketData } from './market';
import {
  detectGoogleSheetCsvKind,
  parseAssetsCsv,
  parseCashFlowCsv,
  parseNetWorthHistoryCsv,
  parseRecurringCsv,
  parseSinkingFundCsv,
  type GoogleSheetCsvKind,
} from '../shared/csv';
import type { SyncRequest } from '../shared/types';
import type { UserRow, WorkerEnv } from './types';

type AppVariables = {
  authUser: UserRow;
  tokenHash: string;
};

type AppContext = Context<{ Bindings: WorkerEnv; Variables: AppVariables }>;

function getClientIp(c: AppContext): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  );
}

function getOriginAndRpId(c: AppContext): { origin: string; rpID: string; isHttps: boolean } {
  const url = new URL(c.req.url);
  return {
    origin: url.origin,
    rpID: url.hostname,
    isHttps: url.protocol === 'https:',
  };
}

export function createApp() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // Security headers for all API responses
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
  });

  // Auth status (public when unauthenticated — NEVER leaks tenant/user/passkey info)
  app.get('/api/auth/status', async (c) => {
    const initialized = await hasAnyUser(c.env.DB);
    const session = await verifySessionCookie(c.env.DB, c.req.header('cookie'));

    if (!session.valid || !session.user) {
      return c.json({
        initialized,
        authenticated: false,
      });
    }

    const user = session.user;
    const passkeyRows = await c.env.DB.prepare(
      'SELECT credential_id, public_key, transports FROM auth_passkeys WHERE user_id = ?'
    )
      .bind(user.id)
      .all<{ credential_id: string; public_key: string; transports: string }>();

    return c.json({
      initialized,
      authenticated: true,
      user: toAuthUser(user),
      pinEnabled: Boolean(user.pin_enabled === 1 && user.pin_hash),
      pinSalt: user.pin_enabled === 1 ? user.pin_salt : null,
      pinHash: user.pin_enabled === 1 ? user.pin_hash : null,
      passkeyCount: passkeyRows.results.length,
      passkeys: passkeyRows.results.map((p) => ({
        id: p.credential_id,
        publicKey: p.public_key,
        transports: JSON.parse(p.transports || '[]'),
      })),
    });
  });

  // First-time admin setup (protected by SETUP_SECRET Worker Secret)
  app.post('/api/auth/setup', async (c) => {
    const alreadyInit = await hasAnyUser(c.env.DB);
    if (alreadyInit) {
      return c.json({ error: '系統已完成初始化，禁止重複設定。' }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      setupSecret?: string;
      username?: string;
      displayName?: string;
      password?: string;
    };

    const expectedSecret = c.env.SETUP_SECRET || '';
    if (!expectedSecret) {
      return c.json(
        { error: '伺服器尚未設定 SETUP_SECRET，請先透過 wrangler secret put SETUP_SECRET 設定。' },
        500
      );
    }
    if (!body.setupSecret || !constantTimeEqual(String(body.setupSecret), expectedSecret)) {
      return c.json({ error: '初始化密鑰錯誤。' }, 403);
    }

    try {
      const admin = await setupInitialAdmin(c.env.DB, {
        username: body.username,
        displayName: body.displayName,
        password: String(body.password || ''),
      });
      await ensureAppSettings(c.env.DB, admin.id);
      const token = await createSession(c.env.DB, admin.id, c.req.header('user-agent') || 'setup');
      const { isHttps } = getOriginAndRpId(c);
      c.header('Set-Cookie', buildSessionCookie(token, isHttps));
      return c.json({ ok: true, user: toAuthUser(admin), message: '初始化完成並已登入。' });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '初始化失敗' }, 400);
    }
  });

  // One-time invite code registration
  app.post('/api/auth/register-invite', async (c) => {
    const ip = getClientIp(c);
    const rateKey = `reg:${ip}`;
    const limit = await checkRateLimit(c.env.DB, rateKey);
    if (limit.blocked) {
      return c.json(
        { error: `註冊失敗次數過多，請於 ${Math.ceil((limit.retryAfterSec || 900) / 60)} 分鐘後再試。` },
        429
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      inviteCode?: string;
      username?: string;
      displayName?: string;
      password?: string;
    };

    try {
      const created = await registerWithInviteCode(c.env.DB, {
        inviteCode: String(body.inviteCode || ''),
        username: String(body.username || ''),
        displayName: body.displayName,
        password: String(body.password || ''),
      });
      await clearRateLimit(c.env.DB, rateKey);
      await ensureAppSettings(c.env.DB, created.id);
      const token = await createSession(c.env.DB, created.id, c.req.header('user-agent') || 'register');
      const { isHttps } = getOriginAndRpId(c);
      c.header('Set-Cookie', buildSessionCookie(token, isHttps));
      return c.json({ ok: true, user: toAuthUser(created) });
    } catch (err) {
      await recordLoginFailure(c.env.DB, rateKey);
      return c.json({ error: err instanceof Error ? err.message : '註冊失敗' }, 400);
    }
  });

  // Zero-knowledge one-time password reset (user chooses new password; admin never sees it)
  app.post('/api/auth/reset-password', async (c) => {
    const ip = getClientIp(c);
    const rateKey = `rst:${ip}`;
    const limit = await checkRateLimit(c.env.DB, rateKey);
    if (limit.blocked) {
      return c.json({ error: '嘗試次數過多，請稍後再試。' }, 429);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      resetCode?: string;
      newPassword?: string;
    };

    try {
      await resetPasswordWithCode(c.env.DB, {
        username: String(body.username || ''),
        resetCode: String(body.resetCode || ''),
        newPassword: String(body.newPassword || ''),
      });
      await clearRateLimit(c.env.DB, rateKey);
      return c.json({ ok: true, message: '密碼已重設完成，請以新密碼登入。' });
    } catch (err) {
      await recordLoginFailure(c.env.DB, rateKey);
      return c.json({ error: err instanceof Error ? err.message : '重設密碼失敗' }, 400);
    }
  });

  // Master password login with D1 brute-force rate limit
  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const ip = getClientIp(c);
    const rateKey = body.username ? `${ip}:${String(body.username).trim().toLowerCase()}` : ip;
    const limit = await checkRateLimit(c.env.DB, rateKey);
    if (limit.blocked) {
      return c.json(
        { error: `登入失敗次數過多，請於 ${Math.ceil((limit.retryAfterSec || 900) / 60)} 分鐘後再試。` },
        429
      );
    }

    const user = await verifyUserPassword(c.env.DB, body.username, String(body.password || ''));
    if (!user) {
      await recordLoginFailure(c.env.DB, rateKey);
      return c.json({ error: '帳號或主密碼不正確。' }, 401);
    }

    await clearRateLimit(c.env.DB, rateKey);
    const token = await createSession(c.env.DB, user.id, c.req.header('user-agent') || 'browser');
    const { isHttps } = getOriginAndRpId(c);
    c.header('Set-Cookie', buildSessionCookie(token, isHttps));
    return c.json({ ok: true, user: toAuthUser(user) });
  });

  // Logout (current device or ?all=1 for current user only)
  app.post('/api/auth/logout', async (c) => {
    const revokeAll = c.req.query('all') === '1';
    const session = await verifySessionCookie(c.env.DB, c.req.header('cookie'));
    await revokeSession(c.env.DB, c.req.header('cookie'), session.user?.id, revokeAll);
    const { isHttps } = getOriginAndRpId(c);
    c.header('Set-Cookie', buildSessionCookie('', isHttps, true));
    return c.json({ ok: true });
  });

  // Discoverable Passkey login (username-less 1-tap Face ID / Touch ID)
  app.post('/api/auth/passkey/login/options', async (c) => {
    const ip = getClientIp(c);
    const limit = await checkAndRecordFixedWindowRateLimit(c.env.DB, `pk_opt:${ip}`, 20, 60_000);
    if (limit.blocked) {
      return c.json({ error: '請求過於頻繁，請稍後再試。' }, 429);
    }
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
    const limit = await checkRateLimit(c.env.DB, `pk:${ip}`);
    if (limit.blocked) {
      return c.json({ error: '嘗試次數過多，請稍後再試。' }, 429);
    }
    try {
      const { rpID, origin, isHttps } = getOriginAndRpId(c);
      const body = (await c.req.json()) as AuthenticationResponseJSON;
      const { user } = await finishPasskeyAuthentication(c.env.DB, rpID, origin, body);
      await clearRateLimit(c.env.DB, `pk:${ip}`);
      const token = await createSession(c.env.DB, user.id, c.req.header('user-agent') || 'passkey');
      c.header('Set-Cookie', buildSessionCookie(token, isHttps));
      return c.json({ ok: true, user: toAuthUser(user) });
    } catch (err) {
      await recordLoginFailure(c.env.DB, `pk:${ip}`);
      return c.json({ error: err instanceof Error ? err.message : 'Passkey 登入失敗' }, 401);
    }
  });

  // Authentication middleware: binds authenticated UserRow into Hono Context
  const requireAuth = async (c: AppContext, next: () => Promise<void>) => {
    const session = await verifySessionCookie(c.env.DB, c.req.header('cookie'));
    if (!session.valid || !session.user) {
      return c.json({ error: 'AUTH_REQUIRED' }, 401);
    }
    c.set('authUser', session.user);
    c.set('tokenHash', session.tokenHash || '');
    await next();
  };

  // Admin middleware: strictly requires role === 'admin' (and admin routes NEVER query financial tables)
  const requireAdmin = async (c: AppContext, next: () => Promise<void>) => {
    const user = c.get('authUser');
    if (!user || user.role !== 'admin') {
      return c.json({ error: '僅管理員可執行此操作。' }, 403);
    }
    await next();
  };

  // Authenticated User Profile & Security Settings
  app.patch('/api/auth/profile', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      const body = (await c.req.json().catch(() => ({}))) as {
        username?: string;
        displayName?: string;
        showUtilityTab?: boolean;
      };
      const updated = await updateUserProfile(c.env.DB, user.id, body);
      return c.json({ ok: true, user: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '更新個人資料失敗' }, 400);
    }
  });

  app.post('/api/auth/change-password', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      const body = (await c.req.json().catch(() => ({}))) as {
        currentPassword?: string;
        newPassword?: string;
      };
      await changeUserPassword(
        c.env.DB,
        user.id,
        String(body.currentPassword || ''),
        String(body.newPassword || ''),
        c.get('tokenHash')
      );
      return c.json({ ok: true, message: '主密碼已更新。' });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '變更密碼失敗' }, 400);
    }
  });

  app.post('/api/auth/passkey/register/options', requireAuth, async (c) => {
    const user = c.get('authUser');
    const { rpID } = getOriginAndRpId(c);
    const options = await createPasskeyRegistrationOptions(c.env.DB, user, rpID);
    return c.json(options);
  });

  app.post('/api/auth/passkey/register/verify', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      const { rpID, origin } = getOriginAndRpId(c);
      const body = (await c.req.json()) as {
        response: RegistrationResponseJSON;
        deviceName?: string;
      };
      const res = await finishPasskeyRegistration(
        c.env.DB,
        user,
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
      const user = c.get('authUser');
      const body = (await c.req.json()) as {
        enable: boolean;
        currentPin?: string;
        newPin?: string;
      };
      const result = await configureUserPin(c.env.DB, user.id, body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'PIN 設定失敗' }, 400);
    }
  });

  // Admin Family Member Management API (metadata only — ZERO financial data access)
  app.get('/api/admin/users', requireAuth, requireAdmin, async (c) => {
    const [users, invites] = await Promise.all([listAdminUsers(c.env.DB), listInvites(c.env.DB)]);
    return c.json({ ok: true, users, invites });
  });

  app.post('/api/admin/invites', requireAuth, requireAdmin, async (c) => {
    try {
      const admin = c.get('authUser');
      const body = (await c.req.json().catch(() => ({}))) as {
        note?: string;
        expiresInDays?: number;
      };
      const created = await createInviteCode(c.env.DB, admin.id, body);
      return c.json({ ok: true, ...created });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '產生邀請碼失敗' }, 400);
    }
  });

  app.delete('/api/admin/invites/:id', requireAuth, requireAdmin, async (c) => {
    const ok = await revokeInviteCode(c.env.DB, c.req.param('id') || '');
    if (!ok) {
      return c.json({ error: '找不到可作廢的邀請碼。' }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/api/admin/users/:id/reset-code', requireAuth, requireAdmin, async (c) => {
    try {
      const admin = c.get('authUser');
      const body = (await c.req.json().catch(() => ({}))) as { expiresInMinutes?: number };
      const created = await createPasswordResetCode(
        c.env.DB,
        admin.id,
        c.req.param('id') || '',
        body.expiresInMinutes
      );
      return c.json({ ok: true, ...created });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '產生密碼重置碼失敗' }, 400);
    }
  });

  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (c) => {
    try {
      const admin = c.get('authUser');
      const body = (await c.req.json().catch(() => ({}))) as {
        isActive?: boolean;
        showUtilityTab?: boolean;
      };
      const updated = await adminUpdateUser(c.env.DB, admin.id, c.req.param('id') || '', body);
      return c.json({ ok: true, user: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '更新成員狀態失敗' }, 400);
    }
  });

  // Core Offline-First Bidirectional Sync Endpoint (strictly scoped to authUser.id)
  const MAX_SYNC_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
  const MAX_SYNC_MUTATIONS = 200;

  app.post('/api/sync', requireAuth, async (c) => {
    const user = c.get('authUser');
    const expectedUser = (c.req.header('x-expected-user') || '').trim();
    if (expectedUser && expectedUser !== user.id) {
      return c.json(
        {
          error: '目前瀏覽器登入帳號已變更，已停止同步以避免跨帳號寫入。請重新整理或切換帳號。',
          code: 'ACCOUNT_MISMATCH',
          expectedUserId: expectedUser,
          actualUserId: user.id,
        },
        409
      );
    }

    const rawText = await c.req.text();
    if (rawText.length > MAX_SYNC_BODY_BYTES) {
      return c.json({ error: '單次同步請求體積過大，請分批同步。' }, 413);
    }
    let body: SyncRequest = { mutations: [] };
    try {
      body = (rawText ? JSON.parse(rawText) : { mutations: [] }) as SyncRequest;
    } catch {
      return c.json({ error: '同步請求格式錯誤（無效 JSON）。' }, 400);
    }

    if (Array.isArray(body.mutations) && body.mutations.length > MAX_SYNC_MUTATIONS) {
      return c.json({ error: `單次同步上限為 ${MAX_SYNC_MUTATIONS} 筆異動，請分批同步。` }, 400);
    }

    const res = await processSyncRequest(c.env.DB, user.id, body);
    return c.json(res);
  });

  // Manual Automation Triggers (strictly scoped to authUser.id)
  app.post('/api/automation/recurring', requireAuth, async (c) => {
    const user = c.get('authUser');
    const body = (await c.req.json().catch(() => ({}))) as { year?: number; month?: number };
    const result = await runMonthlyRecurringD1(c.env.DB, user.id, body.year, body.month);
    return c.json({ ok: true, ...result });
  });

  app.post('/api/automation/snapshot', requireAuth, async (c) => {
    const user = c.get('authUser');
    const result = await runMonthEndSnapshotD1(c.env.DB, user.id);
    return c.json({ ok: true, ...result });
  });

  app.post('/api/market/refresh', requireAuth, async (c) => {
    const user = c.get('authUser');
    const result = await refreshMarketData(c.env.DB, fetch, user.id, { forceFx: true });
    return c.json({ ok: true, ...result });
  });

  // Data Portability: JSON Export/Import & GAS CSV Import (strictly scoped to authUser.id)
  app.get('/api/export/json', requireAuth, async (c) => {
    const user = c.get('authUser');
    const data = await exportFullSnapshot(c.env.DB, user.id);
    return c.json({
      exportedAt: new Date().toISOString(),
      version: 1,
      data,
    });
  });

  app.post('/api/import/json', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      const body = (await c.req.json()) as { mode?: 'merge' | 'replace'; data?: Record<string, unknown> };
      const summary = await importFullSnapshot(
        c.env.DB,
        user.id,
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
      const user = c.get('authUser');
      const body = (await c.req.json()) as { csvText?: string; kind?: GoogleSheetCsvKind };
      const csvText = String(body.csvText || '');
      const kind = body.kind || detectGoogleSheetCsvKind(csvText);
      if (!kind) {
        return c.json(
          {
            error:
              '無法辨識此 CSV 分頁格式。請直接由 Google Sheets 的 CashFlow_Log、Recurring_Config、Annual_Sinking_Fund、Assets_Liabilities 或 NetWorth_History 分頁匯出 CSV。',
          },
          400
        );
      }

      const nowIso = new Date().toISOString();
      const labels: Record<GoogleSheetCsvKind, string> = {
        cashflow: '收支流水帳 (CashFlow_Log)',
        recurring: '固定收支與訂閱 (Recurring_Config)',
        sinking: '不定期稅金分攤 (Annual_Sinking_Fund)',
        asset: '資產負債明細 (Assets_Liabilities)',
        networth: '淨資產歷史快照 (NetWorth_History)',
      };

      const currSeqExpr = 'COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0)';
      const bumpSeqForCsv = async () => {
        await c.env.DB.batch([
          c.env.DB
            .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
            .bind(user.id, nowIso),
          c.env.DB
            .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ?')
            .bind(nowIso, user.id),
        ]);
      };

      if (kind === 'cashflow') {
        const settings = await ensureAppSettings(c.env.DB, user.id);
        const rows = parseCashFlowCsv(csvText, settings.usdTwdRate);
        if (rows.length > 0) await bumpSeqForCsv();
        for (const v of rows) {
          await c.env.DB
            .prepare(
              `INSERT INTO cashflow_logs
                (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, created_at, updated_at, deleted_at, version, change_seq)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ${currSeqExpr})`
            )
            .bind(
              user.id,
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
              nowIso,
              user.id
            )
            .run();
        }
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      if (kind === 'recurring') {
        const rows = parseRecurringCsv(csvText);
        if (rows.length > 0) await bumpSeqForCsv();
        for (const v of rows) {
          await c.env.DB
            .prepare(
              `INSERT INTO recurring_items
                (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, created_at, updated_at, deleted_at, version, change_seq)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ${currSeqExpr})`
            )
            .bind(
              user.id,
              crypto.randomUUID(),
              v.itemName,
              v.category,
              v.type,
              v.amount,
              v.currency,
              v.cycle,
              v.billingSpec,
              v.status,
              v.note,
              nowIso,
              nowIso,
              user.id
            )
            .run();
        }
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      if (kind === 'sinking') {
        const rows = parseSinkingFundCsv(csvText);
        if (rows.length > 0) await bumpSeqForCsv();
        for (const v of rows) {
          await c.env.DB
            .prepare(
              `INSERT INTO sinking_fund_items
                (user_id, id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version, change_seq)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ${currSeqExpr})`
            )
            .bind(
              user.id,
              crypto.randomUUID(),
              v.itemName,
              v.category,
              v.totalAmount,
              v.months,
              v.dueNote,
              v.status,
              v.note,
              nowIso,
              nowIso,
              user.id
            )
            .run();
        }
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      if (kind === 'asset') {
        const rows = parseAssetsCsv(csvText);
        if (rows.length > 0) await bumpSeqForCsv();
        for (const v of rows) {
          await c.env.DB
            .prepare(
              `INSERT INTO asset_items
                (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, note, created_at, updated_at, deleted_at, version, change_seq)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ${currSeqExpr})`
            )
            .bind(
              user.id,
              crypto.randomUUID(),
              v.updateMode,
              v.majorType,
              v.subCategory,
              v.liquidity,
              v.itemName,
              v.ticker,
              v.quantityOrAmount,
              v.currency,
              v.unitPrice,
              v.note,
              nowIso,
              nowIso,
              user.id
            )
            .run();
        }
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      const rows = parseNetWorthHistoryCsv(csvText);
      if (rows.length > 0) await bumpSeqForCsv();
      for (const h of rows) {
        await c.env.DB
          .prepare(
            `INSERT OR REPLACE INTO networth_history
              (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${currSeqExpr})`
          )
          .bind(
            user.id,
            h.yearMonth,
            h.snapshotDate,
            h.totalAssets,
            h.totalLiabilities,
            h.netWorth,
            h.highLiquidityAssets,
            h.investmentAssets,
            h.insuranceAssets,
            h.monthlyIncome,
            h.monthlyConsumption,
            h.savingsRate,
            h.note,
            nowIso,
            user.id
          )
          .run();
      }
      return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
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
      // Monthly 1st 08:00 Asia/Taipei (before TW open): refresh US & FX only, then post monthly recurring
      await refreshMarketData(env.DB, fetch, undefined, { marketScope: 'us' });
      await runMonthlyRecurringAllUsersD1(env.DB, tw.year, tw.month);
      return;
    }

    if (controller.cron === '0 22 * * *') {
      // Daily 06:00 Asia/Taipei (22:00 UTC): refresh ONLY US closing prices & FX after US market close
      // (avoid touching TW stocks while TWSE MIS may have rolled over pre-market)
      await refreshMarketData(env.DB, fetch, undefined, { marketScope: 'us' });
      return;
    }

    // Daily 23:00 Asia/Taipei (15:00 UTC): refresh TW/US prices & FX for all active users, snapshot on month-end
    await refreshMarketData(env.DB, fetch, undefined, { marketScope: 'all' });
    if (isTaiwanMonthEnd(now)) {
      await runMonthEndSnapshotAllUsersD1(env.DB, now);
    }
  },
};
