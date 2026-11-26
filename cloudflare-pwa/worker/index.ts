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
  peekRateLimit,
  cleanupExpiredAuthData,
  listRecentSecurityEvents,
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
  PasskeyClientError,
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
  validateRecurringPeriod,
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

/**
 * H2: Key for IP-based rate limits. An IPv6 client controls a whole /64, so group by that prefix — otherwise
 * every address in it gets its own counter and the limit is trivial to sidestep.
 */
function getRateLimitIp(c: AppContext): string {
  const ip = getClientIp(c);
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? Math.max(0, 8 - headParts.length - tailParts.length) : 0;
  const groups = [...headParts, ...Array(fill).fill('0'), ...tailParts];
  return `${groups.slice(0, 4).map((g) => g || '0').join(':')}::/64`;
}

function getOriginAndRpId(c: AppContext): { origin: string; rpID: string; isHttps: boolean } {
  const url = new URL(c.req.url);
  return {
    origin: url.origin,
    rpID: url.hostname,
    isHttps: url.protocol === 'https:',
  };
}

/** Reads a request body as UTF-8 text, or returns null as soon as it exceeds maxBytes. */
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    buf.set(ch, offset);
    offset += ch.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * R5: Route-level error response. Validation / business errors (plain messages written for users) are returned
 * as 400. Database, driver and programming errors must never leak SQL or internal text and must not look
 * permanent to the client, so they become a generic 500.
 */
const INTERNAL_ERROR_RE = /D1_|SQLITE|SQL\b|no such (table|column)|constraint failed|database|network connection|internal error|is not a function|Cannot read prop|undefined|null is not/i;

function routeErrorResponse(c: AppContext, err: unknown, fallback: string) {
  // Malformed request body (c.req.json() on invalid JSON) is the client's fault → 400
  if (err instanceof SyntaxError) {
    return c.json({ error: `${fallback}（請求內容格式錯誤）` }, 400);
  }
  // Bad data that trips a DB constraint (e.g. an imported value) is permanent → sanitized 400, never raw SQL
  if (err instanceof Error && /constraint failed|SQLITE_CONSTRAINT|D1_TYPE_ERROR/i.test(err.message)) {
    console.warn('[api] constraint error:', c.req.path, err.message);
    return c.json({ error: `${fallback}（資料格式或欄位約束不符合規範）` }, 400);
  }
  const isInternal =
    !(err instanceof Error) ||
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof SyntaxError ||
    err instanceof ReferenceError ||
    INTERNAL_ERROR_RE.test(err.message);
  if (isInternal) {
    console.error('[api] internal error:', c.req.path, err);
    return c.json({ error: `${fallback}（伺服器暫時無法處理，請稍後再試）` }, 500);
  }
  return c.json({ error: err.message || fallback }, 400);
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

  // M10: CSRF guard for every state-changing API call. Browsers always send Origin / Sec-Fetch-Site on
  // cross-site POSTs; reject those, and require a JSON body so a plain HTML form cannot reach the API.
  app.use('/api/*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const fetchSite = (c.req.header('sec-fetch-site') || '').toLowerCase();
    if (fetchSite === 'cross-site') {
      return c.json({ error: '拒絕跨站請求。' }, 403);
    }
    const origin = c.req.header('origin');
    if (origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).origin === new URL(c.req.url).origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        return c.json({ error: '拒絕跨站請求。' }, 403);
      }
    }
    // Decide from headers only: in workerd a bodyless POST (Content-Length: 0) still has a non-null req.body
    const contentLength = Number(c.req.header('content-length') || '0');
    const hasBody = contentLength > 0 || Boolean(c.req.header('transfer-encoding'));
    const contentType = (c.req.header('content-type') || '').toLowerCase();
    if (hasBody && !contentType.startsWith('application/json')) {
      return c.json({ error: '請求內容必須為 JSON。' }, 415);
    }
    return next();
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
    if (session.refreshedCookie) {
      const { isHttps } = getOriginAndRpId(c);
      c.header('Set-Cookie', buildSessionCookie(session.refreshedCookie.token, isHttps, false, session.refreshedCookie.maxAgeSec));
    }
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
      securityNotices: await listRecentSecurityEvents(c.env.DB, user.id),
    });
  });

  // First-time admin setup (protected by SETUP_SECRET Worker Secret)
  app.post('/api/auth/setup', async (c) => {
    const alreadyInit = await hasAnyUser(c.env.DB);
    if (alreadyInit) {
      return c.json({ error: '系統已完成初始化，禁止重複設定。' }, 403);
    }
    // H2: SETUP_SECRET must not be guessable online before the first admin exists
    const setupLimit = await checkRateLimit(c.env.DB, `setup:${getRateLimitIp(c)}`, 10);
    if (setupLimit.blocked) {
      return c.json({ error: '嘗試次數過多，請稍後再試。' }, 429);
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
      return routeErrorResponse(c, err, '初始化失敗');
    }
  });

  // One-time invite code registration
  app.post('/api/auth/register-invite', async (c) => {
    const ip = getRateLimitIp(c);
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
      return routeErrorResponse(c, err, '註冊失敗');
    }
  });

  // Zero-knowledge one-time password reset (user chooses new password; admin never sees it)
  app.post('/api/auth/reset-password', async (c) => {
    const ip = getRateLimitIp(c);
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
      return routeErrorResponse(c, err, '重設密碼失敗');
    }
  });

  // Master password login with D1 brute-force rate limit
  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const ip = getRateLimitIp(c);
    const uname = String(body.username || '').trim().toLowerCase();
    const rateKey = uname ? `${ip}:${uname}` : ip;
    // H2: per IP+account, plus a per-account budget across all IPs (bounds distributed guessing)
    // The per-account budget only counts VERIFIED failures (peek first, count after a wrong password), so a
    // single blocked IP cannot keep spending it to lock the real user out.
    const limit = await checkRateLimit(c.env.DB, rateKey);
    const userLimit = uname && !limit.blocked ? await peekRateLimit(c.env.DB, `user:${uname}`, 20) : { blocked: false };
    if (limit.blocked || userLimit.blocked) {
      const retry = Math.max(limit.retryAfterSec || 0, userLimit.retryAfterSec || 0) || 900;
      return c.json({ error: `登入嘗試次數過多，請於 ${Math.ceil(retry / 60)} 分鐘後再試。` }, 429);
    }

    const user = await verifyUserPassword(c.env.DB, body.username, String(body.password || ''));
    if (!user) {
      if (uname) await checkRateLimit(c.env.DB, `user:${uname}`, 20);
      return c.json({ error: '帳號或主密碼不正確。' }, 401);
    }

    await clearRateLimit(c.env.DB, rateKey);
    if (uname) await clearRateLimit(c.env.DB, `user:${uname}`);
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
    const ip = getRateLimitIp(c);
    const limit = await checkAndRecordFixedWindowRateLimit(c.env.DB, `pk_opt:${ip}`, 20, 60_000);
    if (limit.blocked) {
      return c.json({ error: '請求過於頻繁，請稍後再試。' }, 429);
    }
    try {
      const { rpID } = getOriginAndRpId(c);
      const options = await createPasskeyAuthenticationOptions(c.env.DB, rpID);
      return c.json(options);
    } catch (err) {
      return routeErrorResponse(c, err, '無法產生 Passkey 選項');
    }
  });

  app.post('/api/auth/passkey/login/verify', async (c) => {
    const ip = getRateLimitIp(c);
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
      if (err instanceof PasskeyClientError) {
        return c.json({ error: err.message || 'Passkey 登入失敗' }, 401);
      }
      console.error('[auth] passkey login verify unexpected error:', err);
      return c.json({ error: 'Passkey 登入時發生暫時性系統錯誤，請稍後重試。' }, 500);
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
    if (session.refreshedCookie) {
      const { isHttps } = getOriginAndRpId(c);
      c.header('Set-Cookie', buildSessionCookie(session.refreshedCookie.token, isHttps, false, session.refreshedCookie.maxAgeSec));
    }
    // P2-S11: every authenticated write refuses a request made by a tab that believes it is another account
    // (the session cookie is shared by all tabs, so another tab may have switched accounts).
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const expected = (c.req.header('x-expected-user') || '').trim();
      if (expected && expected !== session.user.id) {
        return c.json(
          {
            error: '目前瀏覽器登入帳號已變更，已停止寫入以避免跨帳號污染。請重新整理或切換帳號。',
            code: 'ACCOUNT_MISMATCH',
            expectedUserId: expected,
            actualUserId: session.user.id,
          },
          409
        );
      }
    }
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
      return routeErrorResponse(c, err, '更新個人資料失敗');
    }
  });

  app.post('/api/auth/change-password', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      // M2: a stolen session must not be able to guess the current password online
      const limit = await checkRateLimit(c.env.DB, `pwchg:${user.id}`);
      if (limit.blocked) {
        return c.json({ error: '嘗試次數過多，請稍後再試。' }, 429);
      }
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
      await clearRateLimit(c.env.DB, `pwchg:${user.id}`);
      return c.json({ ok: true, message: '主密碼已更新。' });
    } catch (err) {
      return routeErrorResponse(c, err, '變更密碼失敗');
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
      let body: { response: RegistrationResponseJSON; deviceName?: string };
      try {
        body = (await c.req.json()) as {
          response: RegistrationResponseJSON;
          deviceName?: string;
        };
      } catch {
        throw new PasskeyClientError('Passkey 請求資料格式無效。');
      }
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
      if (err instanceof PasskeyClientError) {
        return c.json({ error: err.message || 'Passkey 綁定失敗' }, 400);
      }
      console.error('[auth] passkey register verify unexpected error:', err);
      return c.json({ error: 'Passkey 註冊時發生暫時性系統錯誤，請稍後重試。' }, 500);
    }
  });

  app.post('/api/auth/pin', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      // M2: changing / disabling the PIN checks the current PIN — limit guesses
      const limit = await checkRateLimit(c.env.DB, `pin:${user.id}`);
      if (limit.blocked) {
        return c.json({ error: '嘗試次數過多，請稍後再試。' }, 429);
      }
      const body = (await c.req.json()) as {
        enable: boolean;
        currentPin?: string;
        newPin?: string;
      };
      const result = await configureUserPin(c.env.DB, user.id, body);
      await clearRateLimit(c.env.DB, `pin:${user.id}`);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return routeErrorResponse(c, err, 'PIN 設定失敗');
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
      return routeErrorResponse(c, err, '產生邀請碼失敗');
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
      return routeErrorResponse(c, err, '產生密碼重置碼失敗');
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
      return routeErrorResponse(c, err, '更新成員狀態失敗');
    }
  });

  // Core Offline-First Bidirectional Sync Endpoint (strictly scoped to authUser.id)
  const MAX_SYNC_BODY_BYTES = 2 * 1024 * 1024; // 2 MB UTF-8 bytes
  const MAX_SYNC_MUTATIONS = 200;

  const checkExpectedUserMismatch = (
    expectedHeader: string | undefined,
    actualUserId: string
  ): { error: string; code: string; expectedUserId: string; actualUserId: string } | null => {
    const expectedUser = (expectedHeader || '').trim();
    if (expectedUser && expectedUser !== actualUserId) {
      return {
        error: '目前瀏覽器登入帳號已變更，已停止寫入以避免跨帳號污染。請重新整理或切換帳號。',
        code: 'ACCOUNT_MISMATCH',
        expectedUserId: expectedUser,
        actualUserId,
      };
    }
    return null;
  };

  app.post('/api/sync', requireAuth, async (c) => {
    const user = c.get('authUser');
    const mismatch = checkExpectedUserMismatch(c.req.header('x-expected-user'), user.id);
    if (mismatch) {
      return c.json(mismatch, 409);
    }

    const contentLength = Number(c.req.header('content-length') || '');
    if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_BODY_BYTES) {
      return c.json({ error: '單次同步請求體積過大，請分批同步。' }, 413);
    }

    // P2-S11: read the body as a stream with a byte cap, so a chunked request without Content-Length
    // is never buffered beyond the limit.
    const rawText = await readBodyWithLimit(c.req.raw, MAX_SYNC_BODY_BYTES);
    if (rawText === null) {
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
    const mismatch = checkExpectedUserMismatch(c.req.header('x-expected-user'), user.id);
    if (mismatch) return c.json(mismatch, 409);
    const body = (await c.req.json().catch(() => ({}))) as { year?: unknown; month?: unknown };
    const period = validateRecurringPeriod(body?.year, body?.month);
    if (!period.ok) return c.json({ error: period.error }, 400);
    const result = await runMonthlyRecurringD1(c.env.DB, user.id, period.year, period.month);
    return c.json({ ok: true, ...result });
  });

  app.post('/api/automation/snapshot', requireAuth, async (c) => {
    const user = c.get('authUser');
    const mismatch = checkExpectedUserMismatch(c.req.header('x-expected-user'), user.id);
    if (mismatch) return c.json(mismatch, 409);
    const result = await runMonthEndSnapshotD1(c.env.DB, user.id);
    return c.json({ ok: true, ...result });
  });

  app.post('/api/market/refresh', requireAuth, async (c) => {
    const user = c.get('authUser');
    const mismatch = checkExpectedUserMismatch(c.req.header('x-expected-user'), user.id);
    if (mismatch) return c.json(mismatch, 409);
    // Q8: optional `{ assetIds: string[] }` body limits the refresh to specific holdings (e.g. right after a
    // ticker replacement) so the new ticker gets a quote without waiting for the next scheduled run.
    const body = (await c.req.json().catch(() => null)) as { assetIds?: unknown } | null;
    const assetIds =
      body && Array.isArray(body.assetIds)
        ? body.assetIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 50)
        : undefined;
    // Respect user's autoFxEnabled setting instead of forcing FX overwrite
    const result = await refreshMarketData(
      c.env.DB,
      fetch,
      user.id,
      assetIds && assetIds.length > 0 ? { assetIds } : undefined
    );
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
      const mismatch = checkExpectedUserMismatch(c.req.header('x-expected-user'), user.id);
      if (mismatch) return c.json(mismatch, 409);
      const body = (await c.req.json()) as { mode?: 'merge' | 'replace'; data?: Record<string, unknown> };
      const summary = await importFullSnapshot(
        c.env.DB,
        user.id,
        (body.data || body) as never,
        body.mode === 'replace' ? 'replace' : 'merge'
      );
      return c.json({ ok: true, ...summary });
    } catch (err) {
      return routeErrorResponse(c, err, 'JSON 匯入失敗');
    }
  });

  app.post('/api/import/csv', requireAuth, async (c) => {
    try {
      const user = c.get('authUser');
      const mismatch = checkExpectedUserMismatch(c.req.header('x-expected-user'), user.id);
      if (mismatch) return c.json(mismatch, 409);
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

      // P2-S1: Bump change_seq and insert all CSV rows atomically inside a single D1 batch
      const currSeqExpr = 'COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0)';
      const commitCsvBatch = async (rowStmts: D1PreparedStatement[]) => {
        if (rowStmts.length === 0) return;
        await c.env.DB.batch([
          c.env.DB
            .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
            .bind(user.id, nowIso),
          c.env.DB
            .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ?')
            .bind(nowIso, user.id),
          ...rowStmts,
        ]);
      };

      if (kind === 'cashflow') {
        const settings = await ensureAppSettings(c.env.DB, user.id);
        const rows = parseCashFlowCsv(csvText, settings.usdTwdRate);
        const stmts = rows.map((v) =>
          c.env.DB
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
        );
        await commitCsvBatch(stmts);
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      if (kind === 'recurring') {
        const rows = parseRecurringCsv(csvText);
        const stmts = rows.map((v) =>
          c.env.DB
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
        );
        await commitCsvBatch(stmts);
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      if (kind === 'sinking') {
        const rows = parseSinkingFundCsv(csvText);
        const stmts = rows.map((v) =>
          c.env.DB
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
        );
        await commitCsvBatch(stmts);
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      if (kind === 'asset') {
        const rows = parseAssetsCsv(csvText);
        const stmts = rows.map((v) =>
          c.env.DB
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
        );
        await commitCsvBatch(stmts);
        return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
      }

      const rows = parseNetWorthHistoryCsv(csvText);
      const stmts = rows.map((h) =>
        c.env.DB
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
      );
      await commitCsvBatch(stmts);
      return c.json({ ok: true, kind, label: labels[kind], importedCount: rows.length });
    } catch (err) {
      return routeErrorResponse(c, err, 'CSV 解析或匯入失敗');
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

    // Daily 23:00 Asia/Taipei (15:00 UTC): refresh TW closing prices & FX for all active users, snapshot on month-end.
    // Q6 / F8: 23:00 Taipei falls inside US regular trading hours (22:30/21:30 – 05:00/04:00 Taipei), so US quotes
    // would be intraday prices. US closes are owned exclusively by the 06:00 run; keep them untouched here so the
    // month-end net-worth snapshot records the last US CLOSE rather than a mid-session price.
    // M1: daily housekeeping of expired sessions, challenges, rate limits, used codes and old idempotency rows.
    // Isolated so a failure here never blocks quote refresh or the month-end snapshot.
    try {
      await cleanupExpiredAuthData(env.DB);
    } catch (err) {
      console.error('[cron] auth data cleanup failed:', err);
    }
    await refreshMarketData(env.DB, fetch, undefined, { marketScope: 'tw' });
    if (isTaiwanMonthEnd(now)) {
      await runMonthEndSnapshotAllUsersD1(env.DB, now);
    }
  },
};
