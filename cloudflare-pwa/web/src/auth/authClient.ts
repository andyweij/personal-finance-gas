import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { AuthStatusResponse } from '../../../shared/types';

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

export async function setupMasterPassword(setupSecret: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/setup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupSecret, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || '初始化失敗');
}

export async function loginWithPassword(password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || '登入失敗');
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

export async function loginWithPasskey(): Promise<void> {
  const optRes = await fetch('/api/auth/passkey/login/options', {
    method: 'POST',
    credentials: 'same-origin',
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
  const verBody = (await verRes.json().catch(() => ({}))) as { error?: string };
  if (!verRes.ok) throw new Error(verBody.error || 'Passkey 登入失敗');
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
