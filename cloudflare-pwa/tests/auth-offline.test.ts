import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  verifyOfflineWebAuthnAssertion,
  type CachedPasskey,
} from '../web/src/auth/offlineWebAuthn';

function buildMinimalCoseEs256Key(xBytes: Uint8Array, yBytes: Uint8Array): Uint8Array {
  // Minimal CBOR map { 1: 2, 3: -7, -1: 1, -2: bstr(32), -3: bstr(32) }
  const out: number[] = [
    0xa5, // map(5)
    0x01, 0x02, // 1: 2 (EC2)
    0x03, 0x26, // 3: -7 (ES256)
    0x20, 0x01, // -1: 1 (P-256)
    0x21, 0x58, 0x20, // -2: bstr(32)
    ...xBytes,
    0x22, 0x58, 0x20, // -3: bstr(32)
    ...yBytes,
  ];
  return new Uint8Array(out);
}

function rawP256SigToDer(raw: Uint8Array): Uint8Array {
  const encodeInt = (bytes: Uint8Array): number[] => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const slice = Array.from(bytes.slice(i));
    if (slice[0] & 0x80) slice.unshift(0x00);
    return [0x02, slice.length, ...slice];
  };
  const r = encodeInt(raw.slice(0, 32));
  const s = encodeInt(raw.slice(32, 64));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function createSignedAssertion(opts: {
  rpId: string;
  origin: string;
  challenge: string;
  flags: number;
  credentialId: string;
}) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const b64uToBytes = (s: string) => {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  };
  const coseKey = buildMinimalCoseEs256Key(b64uToBytes(jwk.x!), b64uToBytes(jwk.y!));

  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: opts.challenge,
    origin: opts.origin,
  });
  const clientDataBytes = new TextEncoder().encode(clientData);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.rpId))
  );
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = opts.flags;

  const signedPayload = new Uint8Array(authData.length + clientDataHash.length);
  signedPayload.set(authData, 0);
  signedPayload.set(clientDataHash, authData.length);

  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedPayload)
  );
  const derSig = rawP256SigToDer(rawSig);

  const cachedPasskey: CachedPasskey = {
    id: opts.credentialId,
    publicKey: base64UrlEncode(coseKey),
    transports: ['internal'],
  };

  return {
    cachedPasskey,
    assertion: {
      id: opts.credentialId,
      clientDataJSON: clientDataBytes,
      authenticatorData: authData,
      signature: derSig,
    },
  };
}

describe('Offline WebAuthn Face ID / Passkey assertion verification', () => {
  const rpId = 'personal-finance-pwa.example.workers.dev';
  const origin = `https://${rpId}`;

  it('verifies a valid ES256 Face ID assertion cryptographically offline', async () => {
    const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const { cachedPasskey, assertion } = await createSignedAssertion({
      rpId,
      origin,
      challenge,
      flags: 0x05, // UP (0x01) + UV (0x04)
      credentialId: 'cred-ios-faceid-1',
    });

    const ok = await verifyOfflineWebAuthnAssertion({
      assertion,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRpId: rpId,
      cachedPasskeys: [cachedPasskey],
    });
    expect(ok).toBe(true);
  });

  it('M11: fails closed when the cached passkey has no public key or a key type that cannot be verified', async () => {
    const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const { cachedPasskey, assertion } = await createSignedAssertion({
      rpId,
      origin,
      challenge,
      flags: 0x05,
      credentialId: 'cred-ios-faceid-1',
    });
    const verify = (pk: CachedPasskey) =>
      verifyOfflineWebAuthnAssertion({
        assertion,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRpId: rpId,
        cachedPasskeys: [pk],
      });

    // Missing public key: flags and rpId alone must not unlock
    expect(await verify({ ...cachedPasskey, publicKey: '' })).toBe(false);
    // RS256 COSE key (kty=3, alg=-257): not verifiable offline → rejected instead of skipped
    const rsaCose = new Uint8Array([0xa2, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00]);
    expect(await verify({ ...cachedPasskey, publicKey: base64UrlEncode(rsaCose) })).toBe(false);
    // The genuine ES256 key still works
    expect(await verify(cachedPasskey)).toBe(true);
  });

  it('rejects assertion if User Verified (Face ID / UV bit) flag is missing', async () => {
    const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const { cachedPasskey, assertion } = await createSignedAssertion({
      rpId,
      origin,
      challenge,
      flags: 0x01, // UP only, missing UV (0x04)
      credentialId: 'cred-ios-faceid-1',
    });

    const ok = await verifyOfflineWebAuthnAssertion({
      assertion,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRpId: rpId,
      cachedPasskeys: [cachedPasskey],
    });
    expect(ok).toBe(false);
  });

  it('rejects assertion with mismatched challenge, wrong origin, or tampered signature', async () => {
    const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const { cachedPasskey, assertion } = await createSignedAssertion({
      rpId,
      origin,
      challenge,
      flags: 0x05,
      credentialId: 'cred-ios-faceid-1',
    });

    // Wrong challenge
    expect(
      await verifyOfflineWebAuthnAssertion({
        assertion,
        expectedChallenge: 'different-challenge',
        expectedOrigin: origin,
        expectedRpId: rpId,
        cachedPasskeys: [cachedPasskey],
      })
    ).toBe(false);

    // Wrong origin
    expect(
      await verifyOfflineWebAuthnAssertion({
        assertion,
        expectedChallenge: challenge,
        expectedOrigin: 'https://evil.example.com',
        expectedRpId: rpId,
        cachedPasskeys: [cachedPasskey],
      })
    ).toBe(false);

    // Tampered signature byte
    const tamperedSig = new Uint8Array(assertion.signature);
    tamperedSig[tamperedSig.length - 1] ^= 0xff;
    expect(
      await verifyOfflineWebAuthnAssertion({
        assertion: { ...assertion, signature: tamperedSig },
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRpId: rpId,
        cachedPasskeys: [cachedPasskey],
      })
    ).toBe(false);
  });
});

describe('Offline PIN Auto-Unlock (4 to 6 digits)', () => {
  function setupMockLockDom() {
    const elements: Record<string, Record<string, unknown>> = {};
    const makeEl = (id: string) => {
      const classes = new Set<string>();
      const node: Record<string, unknown> = {
        id,
        textContent: '',
        innerHTML: '',
        style: {} as Record<string, string>,
        children: [] as unknown[],
        className: '',
        appendChild(child: unknown) {
          (node.children as unknown[]).push(child);
          return child;
        },
        classList: {
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
          contains: (c: string) => classes.has(c),
          toggle: (c: string, force?: boolean) => {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) classes.add(c);
            else classes.delete(c);
          },
        },
      };
      elements[id] = node;
      return node;
    };

    for (const id of ['lockScreen', 'pinDots', 'pinError', 'lockFaceIdBtn', 'pinPad', 'lockUsePasswordBtn', 'lockSub']) {
      makeEl(id);
    }

    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      getElementById: (id: string) => elements[id] || null,
      createElement: () => ({ className: '' }),
    };

    return {
      elements,
      restore: () => {
        (globalThis as Record<string, unknown>).document = prevDoc;
      },
    };
  }

  it('auto-unlocks immediately on 4th digit for 4-digit PIN and on 6th digit for 6-digit PIN without pressing OK', async () => {
    const { hashSecretPbkdf2 } = await import('../worker/auth');
    const { openLockScreen, triggerPinKey } = await import('../web/src/ui/securityUi');

    const dom = setupMockLockDom();
    try {
      const salt = '0123456789abcdef0123456789abcdef';
      let syncCalls = 0;

      // 1. Test 4-digit PIN (2580)
      const hash4 = await hashSecretPbkdf2('2580', salt);
      const ctx4 = {
        state: {
          pinEnabled: true,
          pinSalt: salt,
          pinHash: hash4,
          passkeys: [],
          lastActivityAt: 0,
        },
        scheduleSync: () => {
          syncCalls += 1;
        },
      } as never;

      openLockScreen(ctx4);
      expect((dom.elements.lockScreen.classList as { contains: (c: string) => boolean }).contains('open')).toBe(true);
      for (const d of ['2', '5', '8', '0']) {
        await triggerPinKey(ctx4, d);
      }
      expect((dom.elements.lockScreen.classList as { contains: (c: string) => boolean }).contains('open')).toBe(false);
      expect(syncCalls).toBe(1);

      // 2. Test 6-digit PIN (135790) — must NOT error or clear at digits 4 & 5, and auto-unlock at digit 6
      const hash6 = await hashSecretPbkdf2('135790', salt);
      const ctx6 = {
        state: {
          pinEnabled: true,
          pinSalt: salt,
          pinHash: hash6,
          passkeys: [],
          lastActivityAt: 0,
        },
        scheduleSync: () => {
          syncCalls += 1;
        },
      } as never;

      openLockScreen(ctx6);
      for (const d of ['1', '3', '5', '7']) {
        await triggerPinKey(ctx6, d);
      }
      expect((dom.elements.lockScreen.classList as { contains: (c: string) => boolean }).contains('open')).toBe(true);
      expect(dom.elements.pinError.textContent).toBe('');

      await triggerPinKey(ctx6, '9');
      expect((dom.elements.lockScreen.classList as { contains: (c: string) => boolean }).contains('open')).toBe(true);
      expect(dom.elements.pinError.textContent).toBe('');

      await triggerPinKey(ctx6, '0');
      expect((dom.elements.lockScreen.classList as { contains: (c: string) => boolean }).contains('open')).toBe(false);
      expect(syncCalls).toBe(2);

      // 3. Wrong 6-digit PIN auto-clears and displays error
      openLockScreen(ctx6);
      for (const d of ['9', '9', '9', '9', '9', '9']) {
        await triggerPinKey(ctx6, d);
      }
      expect((dom.elements.lockScreen.classList as { contains: (c: string) => boolean }).contains('open')).toBe(true);
      expect(dom.elements.pinError.textContent).toContain('PIN 碼不正確');
    } finally {
      dom.restore();
    }
  });
});

