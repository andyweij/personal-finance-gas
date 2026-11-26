/**
 * Cross-tab messaging. Uses BroadcastChannel when available; on browsers without it (e.g. Safari < 15.4)
 * falls back to localStorage `storage` events, which fire in every other tab of the same origin.
 */
export interface CrossTabChannel {
  postMessage(msg: unknown): void;
  onmessage: ((msg: unknown) => void) | null;
  close(): void;
}

const STORAGE_PREFIX = 'pf_bc:';

export function createCrossTabChannel(name: string): CrossTabChannel | null {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel(name);
      const ch: CrossTabChannel = {
        onmessage: null,
        postMessage: (msg) => bc.postMessage(msg),
        close: () => bc.close(),
      };
      bc.onmessage = (evt: MessageEvent) => ch.onmessage?.(evt.data);
      return ch;
    } catch {
      // fall through to the storage fallback
    }
  }

  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;

  const key = `${STORAGE_PREFIX}${name}`;
  const ch: CrossTabChannel = {
    onmessage: null,
    postMessage: (msg) => {
      try {
        // A unique nonce makes every post a change, so repeated identical messages still fire `storage`
        localStorage.setItem(key, JSON.stringify({ msg, nonce: `${Date.now()}-${Math.random()}` }));
      } catch {
        // storage unavailable — no cross-tab delivery
      }
    },
    close: () => window.removeEventListener('storage', listener),
  };
  const listener = (evt: StorageEvent) => {
    if (evt.key !== key || !evt.newValue) return;
    try {
      const parsed = JSON.parse(evt.newValue) as { msg?: unknown };
      ch.onmessage?.(parsed.msg);
    } catch {
      // ignore malformed payloads
    }
  };
  window.addEventListener('storage', listener);
  return ch;
}
