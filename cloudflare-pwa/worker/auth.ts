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
import type { AuthOwnerRow, PasskeyRow } from './types';

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

export async function getAuthOwner(db: D1Database): Promise<AuthOwnerRow | null> {
  return db.prepare('SELECT * FROM auth_owner WHERE id = 1').first<AuthOwnerRow>();
}

export async function createSession(db: D1Database, deviceLabel = ''): Promise<string> {
  const rawToken = generateRandomHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const nowIso = now.toISOString();

  await db
    .prepare(
      `INSERT INTO auth_sessions (token_hash, device_label, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(tokenHash, deviceLabel.slice(0, 80), expiresAt, nowIso, nowIso)
    .run();

  return rawToken;
}

export async function verifySessionCookie(
  db: D1Database,
  cookieHeader: string | null | undefined
): Promise<{ valid: boolean; tokenHash?: string }> {
  const token = parseSessionTokenFromCookie(cookieHeader);
  if (!token) return { valid: false };

  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare('SELECT token_hash, expires_at FROM auth_sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ token_hash: string; expires_at: string }>();

  if (!row || row.expires_at <= nowIso) {
    if (row) {
      await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
    }
    return { valid: false };
  }

  // Sliding refresh
  const nextExpires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .bind(nowIso, nextExpires, tokenHash)
    .run();

  return { valid: true, tokenHash };
}

export async function revokeSession(
  db: D1Database,
  cookieHeader: string | null | undefined,
  revokeAll = false
): Promise<void> {
  if (revokeAll) {
    await db.prepare('DELETE FROM auth_sessions').run();
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

export async function setupOwnerPassword(
  db: D1Database,
  password: string
): Promise<void> {
  const cleaned = String(password || '');
  if (cleaned.length < 8) {
    throw new Error('主密碼長度至少需 8 個字元。');
  }
  const salt = generateRandomHex(16);
  const hash = await hashSecretPbkdf2(cleaned, salt);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO auth_owner (id, password_hash, password_salt, pin_enabled, updated_at)
       VALUES (1, ?, ?, 0, ?)`
    )
    .bind(hash, salt, nowIso)
    .run();
}

export async function verifyOwnerPassword(db: D1Database, password: string): Promise<boolean> {
  const owner = await getAuthOwner(db);
  if (!owner) return false;
  const computed = await hashSecretPbkdf2(String(password || ''), owner.password_salt);
  return constantTimeEqual(computed, owner.password_hash);
}

export async function configureOwnerPin(
  db: D1Database,
  payload: { enable: boolean; currentPin?: string; newPin?: string }
): Promise<{ pinEnabled: boolean; pinSalt: string | null; pinHash: string | null }> {
  const owner = await getAuthOwner(db);
  if (!owner) throw new Error('尚未完成系統初始化。');

  const currentlyEnabled = owner.pin_enabled === 1 && Boolean(owner.pin_hash && owner.pin_salt);
  if (currentlyEnabled) {
    const cur = String(payload.currentPin || '').trim();
    const computed = await hashSecretPbkdf2(cur, owner.pin_salt!);
    if (!constantTimeEqual(computed, owner.pin_hash!)) {
      throw new Error('目前的 PIN 碼不正確。');
    }
  }

  const nowIso = new Date().toISOString();
  if (!payload.enable) {
    await db
      .prepare(
        'UPDATE auth_owner SET pin_enabled = 0, pin_hash = NULL, pin_salt = NULL, updated_at = ? WHERE id = 1'
      )
      .bind(nowIso)
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
      'UPDATE auth_owner SET pin_enabled = 1, pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = 1'
    )
    .bind(pinHash, pinSalt, nowIso)
    .run();

  return { pinEnabled: true, pinSalt, pinHash };
}

/* ==================== WebAuthn Passkey (Face ID / Touch ID) ==================== */

async function saveChallenge(db: D1Database, challenge: string, purpose: 'register' | 'authenticate') {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  await db
    .prepare('INSERT OR REPLACE INTO auth_challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)')
    .bind(challenge, purpose, expiresAt)
    .run();
}

async function consumeChallenge(db: D1Database, purpose: 'register' | 'authenticate'): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      'SELECT challenge FROM auth_challenges WHERE purpose = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1'
    )
    .bind(purpose, nowIso)
    .first<{ challenge: string }>();
  if (!row) return null;
  await db.prepare('DELETE FROM auth_challenges WHERE challenge = ?').bind(row.challenge).run();
  return row.challenge;
}

export async function createPasskeyRegistrationOptions(db: D1Database, rpID: string) {
  const existing = await db.prepare('SELECT credential_id, transports FROM auth_passkeys').all<PasskeyRow>();
  const options = await generateRegistrationOptions({
    rpName: '財務管家 PWA',
    rpID,
    userName: 'owner',
    userDisplayName: '個人帳本擁有者',
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({
      id: p.credential_id,
      transports: JSON.parse(p.transports || '[]') as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });
  await saveChallenge(db, options.challenge, 'register');
  return options;
}

export async function finishPasskeyRegistration(
  db: D1Database,
  rpID: string,
  origin: string,
  response: RegistrationResponseJSON,
  deviceName = '我的裝置'
) {
  const expectedChallenge = await consumeChallenge(db, 'register');
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
      `INSERT OR REPLACE INTO auth_passkeys (credential_id, public_key, counter, transports, device_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(credential.id, publicKeyB64, credential.counter, transports, deviceName.slice(0, 60), nowIso)
    .run();

  return { verified: true, credentialId: credential.id };
}

export async function createPasskeyAuthenticationOptions(db: D1Database, rpID: string) {
  const existing = await db.prepare('SELECT credential_id, transports FROM auth_passkeys').all<PasskeyRow>();
  if (existing.results.length === 0) {
    throw new Error('尚未綁定任何 Passkey。');
  }
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: existing.results.map((p) => ({
      id: p.credential_id,
      transports: JSON.parse(p.transports || '[]') as AuthenticatorTransportFuture[],
    })),
  });
  await saveChallenge(db, options.challenge, 'authenticate');
  return options;
}

export async function finishPasskeyAuthentication(
  db: D1Database,
  rpID: string,
  origin: string,
  response: AuthenticationResponseJSON
) {
  const expectedChallenge = await consumeChallenge(db, 'authenticate');
  if (!expectedChallenge) throw new Error('Passkey 驗證已過期，請重試。');

  const passkey = await db
    .prepare('SELECT * FROM auth_passkeys WHERE credential_id = ?')
    .bind(response.id)
    .first<PasskeyRow>();

  if (!passkey) {
    throw new Error('找不到對應的 Passkey 憑證。');
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

  await db
    .prepare('UPDATE auth_passkeys SET counter = ? WHERE credential_id = ?')
    .bind(verification.authenticationInfo.newCounter, passkey.credential_id)
    .run();

  return { verified: true };
}
