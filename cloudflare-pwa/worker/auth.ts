import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AdminUserSummary, AuthUser, InviteSummary } from '../shared/types';
import type { InviteRow, PasskeyRow, UserRow } from './types';

export const DEFAULT_OWNER_ID = 'owner';
export const SESSION_COOKIE_NAME = 'pf_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERATIONS = 100_000;
const MAX_LOGIN_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function generateRandomHex(byteLength = 16): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

function generateReadableCode(prefix: 'INV' | 'RST'): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let chars = '';
  for (let i = 0; i < buf.length; i++) {
    chars += alphabet[buf[i] % alphabet.length];
  }
  return `${prefix}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function normalizeCode(raw: string): string {
  return String(raw || '').trim().toUpperCase();
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export async function hashSecretPbkdf2(secret: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromHex(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return toHex(new Uint8Array(bits));
}

export function validateUsername(raw: string): string {
  const cleaned = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(cleaned)) {
    throw new Error('帳號需為 2～32 碼英數字（可含 . _ -，且需以英數開頭）。');
  }
  return cleaned;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    showUtilityTab: row.show_utility_tab === 1,
  };
}

export function parseSessionTokenFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function buildSessionCookie(token: string, isHttps: boolean, clear = false): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isHttps) {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export async function hasAnyUser(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM users LIMIT 1').first<{ id: string }>();
  return Boolean(row);
}

export async function getUserById(db: D1Database, userId: string): Promise<UserRow | null> {
  if (!userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
}

export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  const cleaned = String(username || '').trim().toLowerCase();
  if (!cleaned) return null;
  return db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').bind(cleaned).first<UserRow>();
}

export async function createSession(
  db: D1Database,
  userId: string,
  deviceLabel = ''
): Promise<string> {
  const rawToken = generateRandomHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const nowIso = now.toISOString();

  await db
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, device_label, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(tokenHash, userId, deviceLabel.slice(0, 80), expiresAt, nowIso, nowIso)
    .run();

  return rawToken;
}

export async function verifySessionCookie(
  db: D1Database,
  cookieHeader: string | null | undefined
): Promise<{ valid: boolean; tokenHash?: string; user?: UserRow }> {
  const token = parseSessionTokenFromCookie(cookieHeader);
  if (!token) return { valid: false };

  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare('SELECT token_hash, user_id, expires_at FROM auth_sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ token_hash: string; user_id: string; expires_at: string }>();

  if (!row || row.expires_at <= nowIso) {
    if (row) {
      await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
    }
    return { valid: false };
  }

  const user = await getUserById(db, row.user_id);
  if (!user || user.is_active !== 1) {
    await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return { valid: false };
  }

  // Sliding refresh
  const nextExpires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .bind(nowIso, nextExpires, tokenHash)
    .run();

  return { valid: true, tokenHash, user };
}

export async function revokeAllUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId).run();
}

export async function revokeSession(
  db: D1Database,
  cookieHeader: string | null | undefined,
  userId?: string,
  revokeAll = false
): Promise<void> {
  if (revokeAll && userId) {
    await revokeAllUserSessions(db, userId);
    return;
  }
  const token = parseSessionTokenFromCookie(cookieHeader);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function checkRateLimit(
  db: D1Database,
  ipKey: string
): Promise<{ blocked: boolean; retryAfterSec?: number }> {
  const row = await db
    .prepare('SELECT fail_count, locked_until FROM auth_rate_limits WHERE ip_key = ?')
    .bind(ipKey)
    .first<{ fail_count: number; locked_until: string | null }>();

  if (!row || !row.locked_until) {
    return { blocked: false };
  }
  const lockedMs = Date.parse(row.locked_until);
  if (lockedMs > Date.now()) {
    return { blocked: true, retryAfterSec: Math.ceil((lockedMs - Date.now()) / 1000) };
  }
  return { blocked: false };
}

export async function recordLoginFailure(db: D1Database, ipKey: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare('SELECT fail_count, locked_until FROM auth_rate_limits WHERE ip_key = ?')
    .bind(ipKey)
    .first<{ fail_count: number; locked_until: string | null }>();

  let nextFails = 1;
  if (row) {
    const expired = row.locked_until && Date.parse(row.locked_until) <= Date.now();
    nextFails = expired ? 1 : row.fail_count + 1;
  }
  const lockedUntil =
    nextFails >= MAX_LOGIN_FAILS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;

  await db
    .prepare(
      `INSERT INTO auth_rate_limits (ip_key, fail_count, locked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ip_key) DO UPDATE SET
         fail_count = excluded.fail_count,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`
    )
    .bind(ipKey, nextFails, lockedUntil, nowIso)
    .run();
}

export async function clearRateLimit(db: D1Database, ipKey: string): Promise<void> {
  await db.prepare('DELETE FROM auth_rate_limits WHERE ip_key = ?').bind(ipKey).run();
}

export async function setupInitialAdmin(
  db: D1Database,
  input: { username?: string; displayName?: string; password: string }
): Promise<UserRow> {
  const cleanedPwd = String(input.password || '');
  if (cleanedPwd.length < 8) {
    throw new Error('主密碼長度至少需 8 個字元。');
  }
  const username = validateUsername(input.username || 'admin');
  const displayName = String(input.displayName || '').trim().slice(0, 40) || '管理員';
  const salt = generateRandomHex(16);
  const hash = await hashSecretPbkdf2(cleanedPwd, salt);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO users
        (id, username, display_name, role, password_hash, password_salt, pin_enabled, show_utility_tab, is_active, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, 'admin', ?, ?, 0, 1, 1, ?, ?, ?)`
    )
    .bind(DEFAULT_OWNER_ID, username, displayName, hash, salt, nowIso, nowIso, nowIso)
    .run();

  const created = await getUserById(db, DEFAULT_OWNER_ID);
  if (!created) throw new Error('建立管理員帳號失敗。');
  return created;
}

export async function verifyUserPassword(
  db: D1Database,
  username: string | undefined,
  password: string
): Promise<UserRow | null> {
  let user: UserRow | null = null;
  const cleanedUsername = String(username || '').trim();
  if (cleanedUsername) {
    user = await getUserByUsername(db, cleanedUsername);
  } else {
    // Backward compatibility only when the system has a single user
    const all = await db.prepare('SELECT * FROM users WHERE is_active = 1 LIMIT 2').all<UserRow>();
    if (all.results.length === 1) {
      user = all.results[0];
    }
  }

  if (!user || user.is_active !== 1) return null;
  const computed = await hashSecretPbkdf2(String(password || ''), user.password_salt);
  if (!constantTimeEqual(computed, user.password_hash)) return null;

  const nowIso = new Date().toISOString();
  await db
    .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(nowIso, user.id)
    .run();

  return { ...user, last_login_at: nowIso };
}

export async function configureUserPin(
  db: D1Database,
  userId: string,
  payload: { enable: boolean; currentPin?: string; newPin?: string }
): Promise<{ pinEnabled: boolean; pinSalt: string | null; pinHash: string | null }> {
  const user = await getUserById(db, userId);
  if (!user) throw new Error('找不到使用者帳號。');

  const currentlyEnabled = user.pin_enabled === 1 && Boolean(user.pin_hash && user.pin_salt);
  if (currentlyEnabled) {
    const cur = String(payload.currentPin || '').trim();
    const computed = await hashSecretPbkdf2(cur, user.pin_salt!);
    if (!constantTimeEqual(computed, user.pin_hash!)) {
      throw new Error('目前的 PIN 碼不正確。');
    }
  }

  const nowIso = new Date().toISOString();
  if (!payload.enable) {
    await db
      .prepare(
        'UPDATE users SET pin_enabled = 0, pin_hash = NULL, pin_salt = NULL, updated_at = ? WHERE id = ?'
      )
      .bind(nowIso, userId)
      .run();
    return { pinEnabled: false, pinSalt: null, pinHash: null };
  }

  const nextPin = String(payload.newPin || '').trim();
  if (!/^\d{4,6}$/.test(nextPin)) {
    throw new Error('PIN 碼需為 4～6 位純數字。');
  }
  const pinSalt = generateRandomHex(16);
  const pinHash = await hashSecretPbkdf2(nextPin, pinSalt);
  await db
    .prepare(
      'UPDATE users SET pin_enabled = 1, pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?'
    )
    .bind(pinHash, pinSalt, nowIso, userId)
    .run();

  return { pinEnabled: true, pinSalt, pinHash };
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  patch: { username?: string; displayName?: string; showUtilityTab?: boolean }
): Promise<AuthUser> {
  const user = await getUserById(db, userId);
  if (!user) throw new Error('找不到使用者帳號。');

  let nextUsername = user.username;
  if (patch.username !== undefined) {
    const validated = validateUsername(patch.username);
    if (validated !== user.username.toLowerCase()) {
      const conflict = await getUserByUsername(db, validated);
      if (conflict && conflict.id !== userId) {
        throw new Error('此帳號名稱已被使用，請換一個。');
      }
      nextUsername = validated;
    }
  }

  const nextDisplayName =
    patch.displayName !== undefined
      ? String(patch.displayName).trim().slice(0, 40) || nextUsername
      : user.display_name;
  const nextShowUtility =
    patch.showUtilityTab !== undefined ? (patch.showUtilityTab ? 1 : 0) : user.show_utility_tab;
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      'UPDATE users SET username = ?, display_name = ?, show_utility_tab = ?, updated_at = ? WHERE id = ?'
    )
    .bind(nextUsername, nextDisplayName, nextShowUtility, nowIso, userId)
    .run();

  return {
    id: user.id,
    username: nextUsername,
    displayName: nextDisplayName,
    role: user.role,
    showUtilityTab: nextShowUtility === 1,
  };
}

export async function changeUserPassword(
  db: D1Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentTokenHash?: string
): Promise<void> {
  const user = await getUserById(db, userId);
  if (!user) throw new Error('找不到使用者帳號。');

  const computed = await hashSecretPbkdf2(String(currentPassword || ''), user.password_salt);
  if (!constantTimeEqual(computed, user.password_hash)) {
    throw new Error('目前的主密碼不正確。');
  }
  const cleanedNew = String(newPassword || '');
  if (cleanedNew.length < 8) {
    throw new Error('新密碼長度至少需 8 個字元。');
  }

  const salt = generateRandomHex(16);
  const hash = await hashSecretPbkdf2(cleanedNew, salt);
  const nowIso = new Date().toISOString();

  await db
    .prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
    .bind(hash, salt, nowIso, userId)
    .run();

  // Revoke other devices' sessions while keeping current session alive
  if (currentTokenHash) {
    await db
      .prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?')
      .bind(userId, currentTokenHash)
      .run();
  } else {
    await revokeAllUserSessions(db, userId);
  }
}

/* ==================== One-Time Invite Codes ==================== */

export async function createInviteCode(
  db: D1Database,
  adminUserId: string,
  options: { note?: string; expiresInDays?: number } = {}
): Promise<{ id: string; inviteCode: string; note: string; expiresAt: string }> {
  const id = crypto.randomUUID();
  const inviteCode = generateReadableCode('INV');
  const codeHash = await sha256Hex(normalizeCode(inviteCode));
  const days = Math.min(30, Math.max(1, Math.round(Number(options.expiresInDays) || 7)));
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const note = String(options.note || '').trim().slice(0, 60);

  await db
    .prepare(
      `INSERT INTO auth_invites (id, code_hash, note, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, codeHash, note, adminUserId, expiresAt, nowIso)
    .run();

  return { id, inviteCode, note, expiresAt };
}

export async function listInvites(db: D1Database): Promise<InviteSummary[]> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT i.*, u.username AS used_by_username
       FROM auth_invites i
       LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC
       LIMIT 50`
    )
    .all<InviteRow & { used_by_username?: string | null }>();

  return rows.results.map((r) => {
    let status: InviteSummary['status'] = 'active';
    if (r.used_at) status = 'used';
    else if (r.revoked_at) status = 'revoked';
    else if (r.expires_at <= nowIso) status = 'expired';
    return {
      id: r.id,
      note: r.note,
      expiresAt: r.expires_at,
      usedBy: r.used_by,
      usedByUsername: r.used_by_username ?? null,
      usedAt: r.used_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      status,
    };
  });
}

export async function revokeInviteCode(db: D1Database, inviteId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const res = await db
    .prepare('UPDATE auth_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
    .bind(nowIso, inviteId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function registerWithInviteCode(
  db: D1Database,
  input: { inviteCode: string; username: string; displayName?: string; password: string }
): Promise<UserRow> {
  const normalizedInvite = normalizeCode(input.inviteCode);
  if (!normalizedInvite) {
    throw new Error('請輸入邀請碼。');
  }
  const username = validateUsername(input.username);
  const cleanedPwd = String(input.password || '');
  if (cleanedPwd.length < 8) {
    throw new Error('主密碼長度至少需 8 個字元。');
  }
  const existingUser = await getUserByUsername(db, username);
  if (existingUser) {
    throw new Error('此帳號名稱已被使用，請換一個。');
  }

  const codeHash = await sha256Hex(normalizedInvite);
  const newUserId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  // Atomically consume invite code first to prevent double registration race
  const claimRes = await db
    .prepare(
      `UPDATE auth_invites
       SET used_by = ?, used_at = ?
       WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(newUserId, nowIso, codeHash, nowIso)
    .run();

  if ((claimRes.meta?.changes ?? 0) !== 1) {
    throw new Error('邀請碼無效、已過期或已被使用。');
  }

  const displayName = String(input.displayName || '').trim().slice(0, 40) || username;
  const salt = generateRandomHex(16);
  const hash = await hashSecretPbkdf2(cleanedPwd, salt);

  try {
    await db
      .prepare(
        `INSERT INTO users
          (id, username, display_name, role, password_hash, password_salt, pin_enabled, show_utility_tab, is_active, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, 'member', ?, ?, 0, 0, 1, ?, ?, ?)`
      )
      .bind(newUserId, username, displayName, hash, salt, nowIso, nowIso, nowIso)
      .run();
  } catch (err) {
    // Roll back invite consumption if username raced
    await db
      .prepare('UPDATE auth_invites SET used_by = NULL, used_at = NULL WHERE code_hash = ? AND used_by = ?')
      .bind(codeHash, newUserId)
      .run();
    throw new Error(err instanceof Error && /UNIQUE/i.test(err.message) ? '此帳號名稱已被使用，請換一個。' : '註冊失敗，請稍後再試。');
  }

  const created = await getUserById(db, newUserId);
  if (!created) throw new Error('註冊失敗。');
  return created;
}

/* ==================== Zero-Knowledge Password Reset ==================== */

export async function createPasswordResetCode(
  db: D1Database,
  adminUserId: string,
  targetUserId: string,
  expiresInMinutes = 30
): Promise<{ id: string; resetCode: string; username: string; expiresAt: string }> {
  const target = await getUserById(db, targetUserId);
  if (!target) {
    throw new Error('找不到指定成員帳號。');
  }

  const id = crypto.randomUUID();
  const resetCode = generateReadableCode('RST');
  const tokenHash = await sha256Hex(normalizeCode(resetCode));
  const mins = Math.min(24 * 60, Math.max(5, Math.round(Number(expiresInMinutes) || 30)));
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + mins * 60 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO auth_password_resets (id, target_user_id, token_hash, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, targetUserId, tokenHash, adminUserId, expiresAt, nowIso)
    .run();

  return { id, resetCode, username: target.username, expiresAt };
}

export async function resetPasswordWithCode(
  db: D1Database,
  input: { username: string; resetCode: string; newPassword: string }
): Promise<{ userId: string; username: string }> {
  const user = await getUserByUsername(db, input.username);
  const cleanedPwd = String(input.newPassword || '');
  if (cleanedPwd.length < 8) {
    throw new Error('新密碼長度至少需 8 個字元。');
  }
  const normalizedReset = normalizeCode(input.resetCode);
  if (!user || user.is_active !== 1 || !normalizedReset) {
    throw new Error('帳號或重置碼無效、已過期或已被使用。');
  }

  const tokenHash = await sha256Hex(normalizedReset);
  const nowIso = new Date().toISOString();

  const claimRes = await db
    .prepare(
      `UPDATE auth_password_resets
       SET used_at = ?
       WHERE target_user_id = ? AND token_hash = ? AND used_at IS NULL AND expires_at > ?`
    )
    .bind(nowIso, user.id, tokenHash, nowIso)
    .run();

  if ((claimRes.meta?.changes ?? 0) !== 1) {
    throw new Error('帳號或重置碼無效、已過期或已被使用。');
  }

  const salt = generateRandomHex(16);
  const hash = await hashSecretPbkdf2(cleanedPwd, salt);

  await db
    .prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
    .bind(hash, salt, nowIso, user.id)
    .run();

  // Immediately revoke all existing sessions for security
  await revokeAllUserSessions(db, user.id);

  return { userId: user.id, username: user.username };
}

/* ==================== Admin User Management (Metadata Only) ==================== */

export async function listAdminUsers(db: D1Database): Promise<AdminUserSummary[]> {
  const rows = await db
    .prepare(
      `SELECT id, username, display_name, role, show_utility_tab, is_active, created_at, last_login_at
       FROM users
       ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC`
    )
    .all<Pick<UserRow, 'id' | 'username' | 'display_name' | 'role' | 'show_utility_tab' | 'is_active' | 'created_at' | 'last_login_at'>>();

  return rows.results.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    role: r.role,
    showUtilityTab: r.show_utility_tab === 1,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }));
}

export async function adminUpdateUser(
  db: D1Database,
  adminUserId: string,
  targetUserId: string,
  patch: { isActive?: boolean; showUtilityTab?: boolean }
): Promise<AdminUserSummary> {
  const target = await getUserById(db, targetUserId);
  if (!target) throw new Error('找不到指定成員帳號。');
  if (patch.isActive === false && targetUserId === adminUserId) {
    throw new Error('不可停用目前登入的管理員帳號。');
  }

  const nextActive = patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : target.is_active;
  const nextUtility =
    patch.showUtilityTab !== undefined ? (patch.showUtilityTab ? 1 : 0) : target.show_utility_tab;
  const nowIso = new Date().toISOString();

  await db
    .prepare('UPDATE users SET is_active = ?, show_utility_tab = ?, updated_at = ? WHERE id = ?')
    .bind(nextActive, nextUtility, nowIso, targetUserId)
    .run();

  if (nextActive === 0) {
    await revokeAllUserSessions(db, targetUserId);
  }

  return {
    id: target.id,
    username: target.username,
    displayName: target.display_name || target.username,
    role: target.role,
    showUtilityTab: nextUtility === 1,
    isActive: nextActive === 1,
    createdAt: target.created_at,
    lastLoginAt: target.last_login_at,
  };
}

/* ==================== WebAuthn Passkey (Discoverable Multi-Tenant) ==================== */

async function saveChallenge(
  db: D1Database,
  challenge: string,
  purpose: 'register' | 'authenticate',
  userId: string | null = null
) {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  await db
    .prepare(
      'INSERT OR REPLACE INTO auth_challenges (challenge, purpose, expires_at, user_id) VALUES (?, ?, ?, ?)'
    )
    .bind(challenge, purpose, expiresAt, userId)
    .run();
}

async function consumeChallenge(
  db: D1Database,
  purpose: 'register' | 'authenticate',
  userId?: string | null
): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const row =
    userId !== undefined && userId !== null
      ? await db
          .prepare(
            'SELECT challenge FROM auth_challenges WHERE purpose = ? AND user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1'
          )
          .bind(purpose, userId, nowIso)
          .first<{ challenge: string }>()
      : await db
          .prepare(
            'SELECT challenge FROM auth_challenges WHERE purpose = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1'
          )
          .bind(purpose, nowIso)
          .first<{ challenge: string }>();
  if (!row) return null;
  await db.prepare('DELETE FROM auth_challenges WHERE challenge = ?').bind(row.challenge).run();
  return row.challenge;
}

export async function createPasskeyRegistrationOptions(
  db: D1Database,
  user: UserRow,
  rpID: string
) {
  const existing = await db
    .prepare('SELECT credential_id, transports FROM auth_passkeys WHERE user_id = ?')
    .bind(user.id)
    .all<PasskeyRow>();

  const options = await generateRegistrationOptions({
    rpName: '財務管家 PWA',
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({
      id: p.credential_id,
      transports: JSON.parse(p.transports || '[]') as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
  });
  await saveChallenge(db, options.challenge, 'register', user.id);
  return options;
}

export async function finishPasskeyRegistration(
  db: D1Database,
  user: UserRow,
  rpID: string,
  origin: string,
  response: RegistrationResponseJSON,
  deviceName = '我的裝置'
) {
  const expectedChallenge = await consumeChallenge(db, 'register', user.id);
  if (!expectedChallenge) throw new Error('Passkey 驗證已過期，請重試。');

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey 註冊驗證失敗。');
  }

  const { credential } = verification.registrationInfo;
  const publicKeyB64 = isoBase64URL.fromBuffer(credential.publicKey);
  const transports = JSON.stringify(response.response.transports || []);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT OR REPLACE INTO auth_passkeys (credential_id, user_id, public_key, counter, transports, device_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(credential.id, user.id, publicKeyB64, credential.counter, transports, deviceName.slice(0, 60), nowIso)
    .run();

  return { verified: true, credentialId: credential.id };
}

export async function createPasskeyAuthenticationOptions(
  db: D1Database,
  rpID: string,
  username?: string
) {
  let allowCredentials: Array<{ id: string; transports: AuthenticatorTransportFuture[] }> | undefined;
  const cleanedUsername = String(username || '').trim();
  if (cleanedUsername) {
    const user = await getUserByUsername(db, cleanedUsername);
    if (user && user.is_active === 1) {
      const rows = await db
        .prepare('SELECT credential_id, transports FROM auth_passkeys WHERE user_id = ?')
        .bind(user.id)
        .all<PasskeyRow>();
      if (rows.results.length > 0) {
        allowCredentials = rows.results.map((p) => ({
          id: p.credential_id,
          transports: JSON.parse(p.transports || '[]') as AuthenticatorTransportFuture[],
        }));
      }
    }
  } else {
    const anyPk = await db.prepare('SELECT credential_id FROM auth_passkeys LIMIT 1').first<{ credential_id: string }>();
    if (!anyPk) {
      throw new Error('尚未綁定任何 Passkey。');
    }
  }

  // Omit allowCredentials for Discoverable Credential (username-less 1-tap Face ID login)
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    ...(allowCredentials ? { allowCredentials } : {}),
  });
  await saveChallenge(db, options.challenge, 'authenticate', null);
  return options;
}

export async function finishPasskeyAuthentication(
  db: D1Database,
  rpID: string,
  origin: string,
  response: AuthenticationResponseJSON
): Promise<{ verified: true; user: UserRow }> {
  const expectedChallenge = await consumeChallenge(db, 'authenticate', null);
  if (!expectedChallenge) throw new Error('Passkey 驗證已過期，請重試。');

  const passkey = await db
    .prepare('SELECT * FROM auth_passkeys WHERE credential_id = ?')
    .bind(response.id)
    .first<PasskeyRow>();

  if (!passkey) {
    throw new Error('找不到對應的 Passkey 憑證。');
  }

  const user = await getUserById(db, passkey.user_id);
  if (!user || user.is_active !== 1) {
    throw new Error('此帳號已停用或不存在。');
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.credential_id,
      publicKey: isoBase64URL.toBuffer(passkey.public_key),
      counter: passkey.counter,
      transports: JSON.parse(passkey.transports || '[]') as AuthenticatorTransportFuture[],
    },
  });

  if (!verification.verified) {
    throw new Error('Passkey 驗證失敗。');
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare('UPDATE auth_passkeys SET counter = ? WHERE credential_id = ? AND user_id = ?')
    .bind(verification.authenticationInfo.newCounter, passkey.credential_id, user.id)
    .run();
  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso, user.id).run();

  return { verified: true, user: { ...user, last_login_at: nowIso } };
}
