import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type {
  AdminUserSummary,
  AuthStatusResponse,
  AuthUser,
  InviteSummary,
} from '../../../shared/types';

const LAST_ACCOUNT_KEY = 'finance_last_account_v1';

export interface RememberedAccount {
  id: string;
  username: string;
  displayName: string;
  showUtilityTab?: boolean;
}

export function getRememberedAccount(): RememberedAccount | null {
  try {
    const raw = localStorage.getItem(LAST_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAccount>;
    if (!parsed.username) return null;
    return {
      id: parsed.id || 'owner',
      username: parsed.username,
      displayName: parsed.displayName || parsed.username,
      showUtilityTab: parsed.showUtilityTab,
    };
  } catch {
    return null;
  }
}

export function saveRememberedAccount(user: AuthUser): void {
  try {
    const data: RememberedAccount = {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      showUtilityTab: user.showUtilityTab,
    };
    localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors
  }
}

export function clearRememberedAccount(): void {
  try {
    localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // Ignore
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 離線驗證本機快取的 App PIN 雜湊（與伺服器相同 PBKDF2-SHA256 參數）
 */
export async function verifyOfflinePin(
  pin: string,
  saltHex: string,
  expectedHashHex: string
): Promise<boolean> {
  if (!saltHex || !expectedHashHex) return false;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin.trim()),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromHex(saltHex),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const computed = toHex(new Uint8Array(bits));
  if (computed.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  }
  return diff === 0;
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('無法取得驗證狀態');
  return (await res.json()) as AuthStatusResponse;
}

export async function setupMasterPassword(
  setupSecret: string,
  password: string,
  username = 'admin',
  displayName = '管理員'
): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/setup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupSecret, username, displayName, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; user?: AuthUser };
  if (!res.ok) throw new Error(body.error || '初始化失敗');
  if (body.user) saveRememberedAccount(body.user);
  return body.user || null;
}

export async function loginWithPassword(
  password: string,
  username?: string
): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: username?.trim() || undefined, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; user?: AuthUser };
  if (!res.ok) throw new Error(body.error || '登入失敗');
  if (body.user) saveRememberedAccount(body.user);
  return body.user || null;
}

export async function registerWithInvite(payload: {
  inviteCode: string;
  username: string;
  displayName: string;
  password: string;
}): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/register-invite', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; user?: AuthUser };
  if (!res.ok) throw new Error(body.error || '邀請碼註冊失敗');
  if (body.user) saveRememberedAccount(body.user);
  return body.user || null;
}

export async function resetPasswordWithResetCode(payload: {
  username: string;
  resetCode: string;
  newPassword: string;
}): Promise<void> {
  const res = await fetch('/api/auth/reset-password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || '重設密碼失敗');
}

export async function updateMyProfile(patch: {
  username?: string;
  displayName?: string;
  showUtilityTab?: boolean;
}): Promise<AuthUser> {
  const res = await fetch('/api/auth/profile', {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; user?: AuthUser };
  if (!res.ok || !body.user) throw new Error(body.error || '更新個人資料失敗');
  saveRememberedAccount(body.user);
  return body.user;
}

export async function changeMyPassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || '變更密碼失敗');
}

export async function logoutSession(allDevices = false): Promise<void> {
  await fetch(`/api/auth/logout${allDevices ? '?all=1' : ''}`, {
    method: 'POST',
    credentials: 'same-origin',
  });
}

export async function registerPasskey(deviceName = '我的裝置'): Promise<void> {
  const optRes = await fetch('/api/auth/passkey/register/options', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!optRes.ok) throw new Error('無法啟動 Passkey 註冊');
  const optionsJSON = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON;
  const attResp = await startRegistration({ optionsJSON });

  const verRes = await fetch('/api/auth/passkey/register/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: attResp, deviceName }),
  });
  const verBody = (await verRes.json().catch(() => ({}))) as { error?: string };
  if (!verRes.ok) throw new Error(verBody.error || 'Passkey 綁定失敗');
}

export async function loginWithPasskey(username?: string): Promise<AuthUser | null> {
  const optRes = await fetch('/api/auth/passkey/login/options', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(username ? { username } : {}),
  });
  const optBody = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON & { error?: string };
  if (!optRes.ok) throw new Error(optBody.error || '尚未綁定 Passkey');

  const asseResp = await startAuthentication({ optionsJSON: optBody });
  const verRes = await fetch('/api/auth/passkey/login/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(asseResp),
  });
  const verBody = (await verRes.json().catch(() => ({}))) as { error?: string; user?: AuthUser };
  if (!verRes.ok) throw new Error(verBody.error || 'Passkey 登入失敗');
  if (verBody.user) saveRememberedAccount(verBody.user);
  return verBody.user || null;
}

export async function savePinConfig(payload: {
  enable: boolean;
  currentPin?: string;
  newPin?: string;
}): Promise<{ pinEnabled: boolean; pinSalt: string | null; pinHash: string | null }> {
  const res = await fetch('/api/auth/pin', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    pinEnabled?: boolean;
    pinSalt?: string | null;
    pinHash?: string | null;
  };
  if (!res.ok) throw new Error(body.error || 'PIN 設定失敗');
  return {
    pinEnabled: Boolean(body.pinEnabled),
    pinSalt: body.pinSalt || null,
    pinHash: body.pinHash || null,
  };
}

/* ==================== Admin Family Management API ==================== */

export async function fetchAdminDashboard(): Promise<{
  users: AdminUserSummary[];
  invites: InviteSummary[];
}> {
  const res = await fetch('/api/admin/users', { credentials: 'same-origin' });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    users?: AdminUserSummary[];
    invites?: InviteSummary[];
  };
  if (!res.ok) throw new Error(body.error || '無法取得成員清單');
  return { users: body.users || [], invites: body.invites || [] };
}

export async function adminCreateInvite(note: string, expiresInDays = 7): Promise<{
  id: string;
  inviteCode: string;
  note: string;
  expiresAt: string;
}> {
  const res = await fetch('/api/admin/invites', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note, expiresInDays }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    id?: string;
    inviteCode?: string;
    note?: string;
    expiresAt?: string;
  };
  if (!res.ok || !body.inviteCode) throw new Error(body.error || '產生邀請碼失敗');
  return {
    id: body.id || '',
    inviteCode: body.inviteCode,
    note: body.note || '',
    expiresAt: body.expiresAt || '',
  };
}

export async function adminRevokeInvite(inviteId: string): Promise<void> {
  const res = await fetch(`/api/admin/invites/${encodeURIComponent(inviteId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || '作廢邀請碼失敗');
}

export async function adminCreateResetCode(
  userId: string,
  expiresInMinutes = 30
): Promise<{ resetCode: string; username: string; expiresAt: string }> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/reset-code`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresInMinutes }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    resetCode?: string;
    username?: string;
    expiresAt?: string;
  };
  if (!res.ok || !body.resetCode) throw new Error(body.error || '產生重置碼失敗');
  return {
    resetCode: body.resetCode,
    username: body.username || '',
    expiresAt: body.expiresAt || '',
  };
}

export async function adminUpdateMember(
  userId: string,
  patch: { isActive?: boolean; showUtilityTab?: boolean }
): Promise<AdminUserSummary> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; user?: AdminUserSummary };
  if (!res.ok || !body.user) throw new Error(body.error || '更新成員失敗');
  return body.user;
}
