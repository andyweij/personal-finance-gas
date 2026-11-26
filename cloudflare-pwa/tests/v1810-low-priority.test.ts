import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncMutation, SyncRequest } from '../shared/types';
import { createApp } from '../worker/index';
import { fetchStockQuote, type FetchLike } from '../worker/market';
import { importFullSnapshot, processSyncRequest } from '../worker/sync';
import type { WorkerEnv } from '../worker/types';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

const cfPayload = (name: string) => ({
  date: '2026-11-26',
  type: '日常花費',
  category: '餐飲',
  itemName: name,
  amount: 100,
  currency: 'TWD',
});

const manualAsset = (note: string, quantity = 1000) => ({
  updateMode: '手動快照',
  majorType: '資產',
  subCategory: '其他資產',
  liquidity: '中流動',
  itemName: '測試資產',
  quantityOrAmount: quantity,
  currency: 'TWD',
  unitPrice: 1,
  note,
});

function d1Fetch(db: D1Database): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
    const res = await processSyncRequest(db, UID, body);
    return new Response(JSON.stringify(res), { status: 200 });
  }) as typeof fetch;
}

function newEngine(localDb: LocalFinanceDB, fetchImpl: typeof fetch) {
  return new SyncEngine(localDb, {
    fetchImpl,
    isOnline: () => true,
    retryBaseDelayMs: 60_000,
    requestLock: async (_name, fn) => fn(),
  });
}

/* ============================== server ============================== */

describe('v1.8.10 server', () => {
  async function setupAdmin() {
    const app = createApp();
    const env: WorkerEnv = { DB: createTestD1(), SETUP_SECRET: 'secret-123' } as WorkerEnv;
    const res = await app.request(
      '/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.9' },
        body: JSON.stringify({
          setupSecret: 'secret-123',
          username: 'admin',
          displayName: 'Admin',
          password: 'AdminPassword123!',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const status = await app.request('/api/auth/status', { headers: { cookie } }, env);
    const statusBody = (await status.json()) as { user?: { id: string } };
    return { app, env, cookie, userId: String(statusBody.user?.id) };
  }

  it('P2-S11: every authenticated write rejects a mismatching X-Expected-User with 409', async () => {
    const { app, env, cookie, userId } = await setupAdmin();
    const send = (expected: string) =>
      app.request(
        '/api/auth/profile',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie, 'x-expected-user': expected },
          body: JSON.stringify({ displayName: 'Admin 2' }),
        },
        env
      );
    expect((await send('someone-else')).status).toBe(409);
    expect((await send(userId)).status).toBe(200);
  });

  it('P2-S11: a chunked sync body without Content-Length is cut off at the byte limit (413)', async () => {
    const { app, env, cookie } = await setupAdmin();
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 12) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request(
      '/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: stream,
        duplex: 'half',
      } as RequestInit,
      env
    );
    expect(res.status).toBe(413);
    // Stopped reading well before the whole 3 MB body was produced
    expect(sent).toBeLessThan(12);
  });

  it('R5: a malformed JSON body is a 400 client error, not a 500', async () => {
    const { app, env, cookie } = await setupAdmin();
    const res = await app.request(
      '/api/import/json',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{not json' },
      env
    );
    expect(res.status).toBe(400);
  });

  it('P2-S12: the lazily created rent utility settings row gets a change_seq', async () => {
    const db = createTestD1();
    const newUser = 'brand-new-user'; // 'owner' is seeded by migrations, so use a user without a row
    const before = await db
      .prepare('SELECT 1 AS x FROM rent_utility_settings WHERE user_id = ?')
      .bind(newUser)
      .first();
    expect(before).toBeNull();
    await processSyncRequest(db, newUser, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    const row = await db
      .prepare('SELECT change_seq FROM rent_utility_settings WHERE user_id = ?')
      .bind(newUser)
      .first<{ change_seq: number }>();
    expect(Number(row?.change_seq)).toBeGreaterThan(0);
  });

  it('merge import does not count rows skipped because they are soft-deleted on the server', async () => {
    const db = createTestD1();
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'c1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-del',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: cfPayload('會被刪除'),
        },
      ],
    });
    const backup = await processSyncRequest(db, UID, { since: null, mutations: [] });
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'd1',
          entity: 'cashflow',
          op: 'delete',
          recordId: 'cf-del',
          clientTimestamp: '2026-11-26T00:01:00.000Z',
          baseVersion: 1,
        },
      ],
    });
    const result = await importFullSnapshot(db, UID, { cashflowLogs: backup.delta.cashflowLogs }, 'merge');
    expect(result.importedLogs).toBe(0);
  });

  it('F11: the range=1d previous close is only used when it describes the same trading day as the 5d price', async () => {
    const day = (y: number, m: number, d: number, h = 16) => Math.floor(Date.UTC(y, m - 1, d, h + 5, 0, 0) / 1000);
    const makeFetch = (oneDayMarketTime: number): FetchLike => async (url) => {
      if (url.includes('range=5d')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { regularMarketPrice: 150, regularMarketTime: day(2026, 11, 25), gmtoffset: -18000 },
                  timestamp: [day(2026, 11, 25, 9)],
                  indicators: { quote: [{ close: [150] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('range=1d')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [{ meta: { previousClose: 140, regularMarketTime: oneDayMarketTime, gmtoffset: -18000 } }],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('nf', { status: 404 });
    };
    const hint = { currency: 'USD', subCategory: '美股/ETF' };
    const sameDay = await fetchStockQuote('NVDA', makeFetch(day(2026, 11, 25)), hint);
    expect(sameDay?.previousClose).toBe(140);
    const nextDay = await fetchStockQuote('NVDA', makeFetch(day(2026, 11, 26)), hint);
    expect(nextDay?.price).toBe(150);
    expect(nextDay?.previousClose).toBeNull();
  });
});

/* ============================== client ============================== */

describe('v1.8.10 client', () => {
  it('R6: when an edit is rejected for server-state reasons, a queued edit of the same record is held, not sent', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v1810-r6-${crypto.randomUUID()}`);
    let engineRef: SyncEngine | null = null;
    let assetId = '';
    let rejectMutationId: string | null = null;
    let armed = false;
    const sentIds: string[] = [];

    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      sentIds.push(...body.mutations.map((m) => m.mutationId));
      // The first edit after the create is rejected because of (simulated) server state, not its fields
      const target = armed ? body.mutations.find((m) => m.entity === 'asset') : undefined;
      if (target && !rejectMutationId) {
        rejectMutationId = target.mutationId;
        // While E1 is in flight the user edits another field of the same record (E2)
        await engineRef!.saveAsset({ ...manualAsset('E2-note', 999), id: assetId });
      }
      const forServer = body.mutations.filter((m) => m.mutationId !== rejectMutationId);
      const res = await processSyncRequest(db, UID, { ...body, mutations: forServer });
      if (rejectMutationId && body.mutations.some((m) => m.mutationId === rejectMutationId)) {
        res.rejected = [...res.rejected, { mutationId: rejectMutationId, reason: '目前狀態不允許此變更' }];
      }
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;

    const engine = newEngine(localDb, fetchImpl);
    engineRef = engine;
    await engine.init();
    const created = await engine.saveAsset(manualAsset('original', 1000));
    assetId = created.id;
    await engine.syncNow();

    armed = true;
    await engine.saveAsset({ ...manualAsset('original', 999), id: assetId }); // E1: quantity 999
    for (let i = 0; i < 4; i++) await engine.syncNow();

    const server = await db
      .prepare('SELECT quantity_or_amount, note FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(UID, assetId)
      .first<{ quantity_or_amount: number; note: string }>();
    expect(Number(server?.quantity_or_amount)).toBe(1000);
    expect(server?.note).toBe('original');
    const held = engine.getRejections().find((r) => r.resolutionStatus === 'held_after_reject');
    expect(held?.clientPayload?.note).toBe('E2-note');
    expect(await localDb.getOutbox()).toHaveLength(0);
    const local = engine.getSnapshot().assetItems.find((a) => a.id === assetId);
    expect(local?.quantityOrAmount).toBe(1000);

    engine.destroy();
    localDb.close();
  });

  it('P2-C6: a tab with a stale snapshot does not overwrite another tab\'s committed edit', async () => {
    const dbName = `v1810-tabs-${crypto.randomUUID()}`;
    const noFetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const dbA = new LocalFinanceDB(dbName);
    const dbB = new LocalFinanceDB(dbName);
    const tabA = new SyncEngine(dbA, { fetchImpl: noFetch, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    const tabB = new SyncEngine(dbB, { fetchImpl: noFetch, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    await tabA.init();
    await tabB.init();

    await tabA.addCashFlow(cfPayload('分頁A'));
    await tabB.addCashFlow(cfPayload('分頁B')); // tab B has not reloaded yet

    const fresh = new LocalFinanceDB(dbName);
    await fresh.open();
    const names = (await fresh.getSnapshot()).cashflowLogs.map((c) => c.itemName).sort();
    expect(names).toEqual(['分頁A', '分頁B']);
    expect((await fresh.getOutbox()).length).toBe(2);

    tabA.destroy();
    tabB.destroy();
    dbA.close();
    dbB.close();
    fresh.close();
  });

  it('P2-C6: a sync in a tab with stale meta does not revert a PIN change made in another tab', async () => {
    const db = createTestD1();
    const dbName = `v1810-pin-${crypto.randomUUID()}`;
    const dbA = new LocalFinanceDB(dbName);
    const dbB = new LocalFinanceDB(dbName);
    const realFetch = d1Fetch(db);
    let tabA: SyncEngine | null = null;
    let changePinDuringSync = false;
    // The PIN is changed in tab A while tab B's sync request is in flight, so B holds a stale meta copy
    const fetchB: typeof fetch = async (input, init) => {
      if (changePinDuringSync && tabA) {
        changePinDuringSync = false;
        await tabA.updateLocalPinCache(true, 'salt', 'hash');
      }
      return realFetch(input, init);
    };
    tabA = newEngine(dbA, realFetch);
    const tabB = newEngine(dbB, fetchB);
    await tabA.init();
    await tabB.init();
    await tabB.syncNow(); // writes meta once so both tabs start from the same stored meta

    await tabB.addCashFlow(cfPayload('同步一筆'));
    changePinDuringSync = true;
    await tabB.syncNow(); // tab B writes meta (cursor) after the PIN change

    const fresh = new LocalFinanceDB(dbName);
    await fresh.open();
    const meta = await fresh.getMeta();
    expect(meta.pinEnabled).toBe(true);
    expect(meta.pinHash).toBe('hash');
    expect(meta.syncCursor ?? 0).toBeGreaterThan(0);

    tabA.destroy();
    tabB.destroy();
    dbA.close();
    dbB.close();
    fresh.close();
  });

  it('P2-C10: destroy() aborts an in-flight sync instead of leaving it running', async () => {
    const localDb = new LocalFinanceDB(`v1810-destroy-${crypto.randomUUID()}`);
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const engine = newEngine(localDb, hangingFetch);
    await engine.init();
    await engine.addCashFlow(cfPayload('等待中'));

    const pending = engine.syncNow();
    await new Promise((r) => setTimeout(r, 20));
    engine.destroy();
    const outcome = await Promise.race([
      pending.then((r) => (r.ok ? 'ok' : 'stopped')),
      new Promise<string>((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(outcome).toBe('stopped');
    localDb.close();
  });
});

// keep the type import used even if a test above is trimmed
export type _Unused = SyncMutation;
