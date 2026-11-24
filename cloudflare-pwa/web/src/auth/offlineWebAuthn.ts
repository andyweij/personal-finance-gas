export interface CachedPasskey {
  id: string;
  publicKey: string; // base64url COSE public key
  transports: string[];
}

export interface OfflineAssertionInput {
  id: string;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Minimal CBOR reader for decoding COSE EC2 P-256 public keys (WebAuthn standard ES256)
 */
function decodeCborMap(bytes: Uint8Array): Map<number, unknown> | null {
  let offset = 0;

  const readUint = (additional: number): number => {
    if (additional < 24) return additional;
    if (additional === 24) return bytes[offset++];
    if (additional === 25) {
      const val = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
      return val;
    }
    throw new Error('Unsupported CBOR length');
  };

  const readItem = (): unknown => {
    const head = bytes[offset++];
    const major = head >> 5;
    const addl = head & 0x1f;
    if (major === 0) return readUint(addl);
    if (major === 1) return -1 - readUint(addl);
    if (major === 2) {
      const len = readUint(addl);
      const slice = bytes.slice(offset, offset + len);
      offset += len;
      return slice;
    }
    if (major === 3) {
      const len = readUint(addl);
      const str = new TextDecoder().decode(bytes.slice(offset, offset + len));
      offset += len;
      return str;
    }
    if (major === 4) {
      const len = readUint(addl);
      const arr = [];
      for (let i = 0; i < len; i++) arr.push(readItem());
      return arr;
    }
    if (major === 5) {
      const len = readUint(addl);
      const map = new Map<number, unknown>();
      for (let i = 0; i < len; i++) {
        const k = readItem();
        const v = readItem();
        if (typeof k === 'number') map.set(k, v);
      }
      return map;
    }
    throw new Error('Unsupported CBOR type');
  };

  try {
    const res = readItem();
    return res instanceof Map ? (res as Map<number, unknown>) : null;
  } catch {
    return null;
  }
}

function derSignatureToRawP256(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der.length < 8 || der[0] !== 0x30) return null;
  let offset = 2;
  if (der[1] & 0x80) {
    offset = 2 + (der[1] & 0x7f);
  }
  if (der[offset] !== 0x02) return null;
  const rLen = der[offset + 1];
  const rStart = offset + 2;
  const rBytes = der.slice(rStart, rStart + rLen);

  const sTagOffset = rStart + rLen;
  if (der[sTagOffset] !== 0x02) return null;
  const sLen = der[sTagOffset + 1];
  const sStart = sTagOffset + 2;
  const sBytes = der.slice(sStart, sStart + sLen);

  const pad32 = (src: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < src.length && src[i] === 0) i++;
    const trimmed = src.slice(i);
    if (trimmed.length > 32) throw new Error('Invalid scalar');
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return out;
  };

  try {
    const raw = new Uint8Array(new ArrayBuffer(64));
    raw.set(pad32(rBytes), 0);
    raw.set(pad32(sBytes), 32);
    return raw;
  } catch {
    return null;
  }
}

async function verifyEs256Signature(
  cosePublicKeyB64: string,
  authData: Uint8Array,
  clientDataHash: Uint8Array,
  derSig: Uint8Array
): Promise<boolean | null> {
  const coseBytes = base64UrlDecode(cosePublicKeyB64);
  const map = decodeCborMap(coseBytes);
  if (!map) return null;

  // COSE EC2 (kty=2), ES256 (alg=-7), P-256 (crv=1)
  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1) {
    return null; // Non-ES256 key (caller may fallback to flag/rpId checks)
  }

  const x = map.get(-2);
  const y = map.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return false;

  const rawSig = derSignatureToRawP256(derSig);
  if (!rawSig) return false;

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(x),
      y: base64UrlEncode(y),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  const signedData = new Uint8Array(new ArrayBuffer(authData.length + clientDataHash.length));
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);

  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSig, signedData);
}

/**
 * 驗證離線 WebAuthn (Face ID / Touch ID) 簽章與安全旗標：
 * 1. Credential ID 必須屬於已綁定清單
 * 2. clientDataJSON 的 type / challenge / origin 嚴格相符
 * 3. authenticatorData 的 rpIdHash 相符且同時具備 UP (0x01) + UV (0x04 生物辨識驗證) 旗標
 * 4. 若為標準 ES256 金鑰，透過 Web Crypto 驗證 ECDSA P-256 數位簽章
 */
export async function verifyOfflineWebAuthnAssertion(params: {
  assertion: OfflineAssertionInput;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
  cachedPasskeys: CachedPasskey[];
}): Promise<boolean> {
  const { assertion, expectedChallenge, expectedOrigin, expectedRpId, cachedPasskeys } = params;
  const matched = cachedPasskeys.find((p) => p.id === assertion.id);
  if (!matched) return false;

  // 1. Parse and verify clientDataJSON
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(assertion.clientDataJSON));
  } catch {
    return false;
  }

  if (
    clientData.type !== 'webauthn.get' ||
    clientData.challenge !== expectedChallenge ||
    clientData.origin !== expectedOrigin
  ) {
    return false;
  }

  // 2. Verify authenticatorData length, rpIdHash, and UP + UV flags
  const authData = assertion.authenticatorData;
  if (authData.length < 37) return false;

  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expectedRpId))
  );
  for (let i = 0; i < 32; i++) {
    if (authData[i] !== expectedRpIdHash[i]) return false;
  }

  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent || !userVerified) return false;

  // 3. Cryptographic ES256 signature verification
  if (matched.publicKey) {
    const clientDataBuf = new Uint8Array(new ArrayBuffer(assertion.clientDataJSON.length));
    clientDataBuf.set(assertion.clientDataJSON);
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBuf));
    const sigCheck = await verifyEs256Signature(
      matched.publicKey,
      authData,
      clientDataHash,
      assertion.signature
    );
    if (sigCheck === false) return false;
  }

  return true;
}

/**
 * 在瀏覽器端直接觸發 iOS Face ID / Touch ID 進行離線解鎖驗證
 */
export async function triggerOfflineFaceIdUnlock(cachedPasskeys: CachedPasskey[]): Promise<boolean> {
  if (!cachedPasskeys.length) {
    throw new Error('尚未在本機快取 Passkey，請先連網登入並綁定 Face ID。');
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('此瀏覽器不支援 Face ID / Passkey。');
  }

  const challengeBytes = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(challengeBytes);
  const expectedChallenge = base64UrlEncode(challengeBytes);

  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: challengeBytes,
      rpId: window.location.hostname,
      userVerification: 'required',
      timeout: 60000,
      allowCredentials: cachedPasskeys.map((p) => ({
        type: 'public-key' as const,
        id: base64UrlDecode(p.id),
        transports: p.transports as AuthenticatorTransport[],
      })),
    },
  })) as PublicKeyCredential | null;

  if (!cred) return false;
  const resp = cred.response as AuthenticatorAssertionResponse;

  return verifyOfflineWebAuthnAssertion({
    assertion: {
      id: cred.id,
      clientDataJSON: new Uint8Array(resp.clientDataJSON),
      authenticatorData: new Uint8Array(resp.authenticatorData),
      signature: new Uint8Array(resp.signature),
    },
    expectedChallenge,
    expectedOrigin: window.location.origin,
    expectedRpId: window.location.hostname,
    cachedPasskeys,
  });
}
