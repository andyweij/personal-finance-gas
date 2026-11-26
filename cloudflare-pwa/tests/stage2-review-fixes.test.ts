import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncRequest, SyncResponse } from '../shared/types';
import { createApp } from '../worker/index';
import { refreshMarketData, type FetchLike } from '../worker/market';
import {
  ensureAppSettings,
  ensureDefaultLedger,
  importFullSnapshot,
  processSyncRequest,
} from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

function createD1FetchAdapter(db: D1Database, userId = 'owner'): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
    const res = await processSyncRequest(db, userId, body);
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('Phase 2 Review Remediation (P2-C1..C10 & P2-S1..S12)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('P2-C1: rebase ONLY happens for records whose own in-flight mutation was acked, never bypassing conflicts from another device', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`p2-c1-${crypto.randomUUID()}`);

    // Seed record as-1 at v1 on server
    await processSyncRequest(db, 'owner', {
      since: null,
      mutations: [
        {
          mutationId: 'm-seed-1',
          entity: 'asset',
          op: 'upsert',
          recordId: 'as-1',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {
            updateMode: '手動快照',
            majorType: '資產',
            subCategory: '定存/現金',
            liquidity: '高流動',
            itemName: '原始v1',
            ticker: '',
            quantityOrAmount: 10000,
            currency: 'TWD',
            unitPrice: 1,
          },
        },
      ],
    });

    // Use maxBatchSize: 1 so we can queue 2 offline edits (cf-other in batch 1, as-1 in batch 2)
    let callCount = 0;
    const baseFetch = createD1FetchAdapter(db, 'owner');
    const interceptedFetch: typeof fetch = async (input, init) => {
      callCount += 1;
      // Call 1 is initial syncNow(true); Call 2 is batch 1 of the offline sync!
      if (callCount === 2) {
        // Another device updates as-1 from v1 -> v2 BEFORE batch 1 sync response comes back!
        await processSyncRequest(db, 'owner', {
          since: null,
          mutations: [
            {
              mutationId: 'm-other-device-v2',
              entity: 'asset',
              op: 'upsert',
              recordId: 'as-1',
              clientTimestamp: '2026-11-26T00:05:00.000Z',
              baseVersion: 1,
              payload: {
                updateMode: '手動快照',
                majorType: '資產',
                subCategory: '定存/現金',
                liquidity: '高流動',
                itemName: '他機修改v2',
                ticker: '',
                quantityOrAmount: 99999,
                currency: 'TWD',
                unitPrice: 1,
              },
            },
          ],
        });
      }
      return baseFetch(input, init);
    };

    const engine = new SyncEngine(localDb, {
      fetchImpl: interceptedFetch,
      isOnline: () => true,
      maxBatchSize: 1,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();
    await engine.syncNow(true);
    expect(engine.getSnapshot().assetItems.find((a) => a.id === 'as-1')?.version).toBe(1);

    // Offline edits: first cashflow (goes in batch 1), second as-1 edit (goes in batch 2, baseVersion = 1)
    await engine.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '交通',
      itemName: '公車',
      amount: 15,
      currency: 'TWD',
    });
    await engine.saveAsset({
      id: 'as-1',
      updateMode: '手動快照',
      majorType: '資產',
      subCategory: '定存/現金',
      liquidity: '高流動',
      itemName: '本機離線修改',
      ticker: '',
      quantityOrAmount: 25000,
      currency: 'TWD',
      unitPrice: 1,
    });

    // Now sync: batch 1 pulls as-1@v2 in delta; batch 2 MUST NOT rebase as-1 onto v2!
    // Server MUST detect conflict between baseVersion 1 and serverVersion 2!
    await engine.syncNow();
    expect(engine.getConflicts().some((c) => c.recordId === 'as-1')).toBe(true);
    const serverRow = await db
      .prepare('SELECT quantity_or_amount, item_name, version FROM asset_items WHERE user_id = ? AND id = ?')
      .bind('owner', 'as-1')
      .first<{ quantity_or_amount: number; item_name: string; version: number }>();
    // Other device's v2 MUST NOT have been silently overwritten!
    expect(serverRow).toEqual({ quantity_or_amount: 99999, item_name: '他機修改v2', version: 2 });

    engine.destroy();
    localDb.close();
  });

  it('P2-C3: concurrent addCashFlow calls are serialized and NEVER overwrite each other in snapshot or IndexedDB', async () => {
    const localDb = new LocalFinanceDB(`p2-c3-${crypto.randomUUID()}`);
    const engine = new SyncEngine(localDb, {
      isOnline: () => false,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    // Fire 4 local writes concurrently without awaiting between them
    const [a, b, c, d] = await Promise.all([
      engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '早餐', amount: 80, currency: 'TWD' }),
      engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '午餐', amount: 150, currency: 'TWD' }),
      engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '晚餐', amount: 220, currency: 'TWD' }),
      engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '交通', itemName: '捷運', amount: 35, currency: 'TWD' }),
    ]);

    const memIds = new Set(engine.getSnapshot().cashflowLogs.map((l) => l.id));
    expect(memIds.has(a.id)).toBe(true);
    expect(memIds.has(b.id)).toBe(true);
    expect(memIds.has(c.id)).toBe(true);
    expect(memIds.has(d.id)).toBe(true);
    expect(memIds.size).toBe(4);

    const persistedSnap = await localDb.getSnapshot();
    expect(persistedSnap.cashflowLogs).toHaveLength(4);
    const outbox = await localDb.getOutbox();
    expect(outbox).toHaveLength(4);

    localDb.close();
  });

  it('P2-C2: persisted sentAt prevents coalescing/cancelling an already-sent mutation after timeout or page reload', async () => {
    const dbName = `p2-c2-${crypto.randomUUID()}`;
    const localDb1 = new LocalFinanceDB(dbName);

    // Fetch that aborts/times out after request is sent
    const timeoutFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const engine1 = new SyncEngine(localDb1, {
      fetchImpl: timeoutFetch,
      isOnline: () => true,
      requestTimeoutMs: 40,
      retryBaseDelayMs: 60_000,
      requestLock: async (_name, fn) => fn(),
    });
    await engine1.init();

    const created = await engine1.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '餐飲',
      itemName: '新建已送出',
      amount: 100,
      currency: 'TWD',
    });
    const originalMutId = (await localDb1.getOutbox())[0].mutationId;

    // Trigger sync -> marks batch as sent in IDB, then times out
    const res = await engine1.syncNow();
    expect(res.ok).toBe(false);
    engine1.destroy();
    localDb1.close();

    // Simulate page reload: fresh LocalFinanceDB + SyncEngine (in-memory inFlightMutationIds is empty!)
    const localDb2 = new LocalFinanceDB(dbName);
    const engine2 = new SyncEngine(localDb2, {
      isOnline: () => false,
      requestLock: async (_name, fn) => fn(),
    });
    await engine2.init();

    // Deleting the newly created record after it was already sent MUST NOT cancel originalMutId!
    await engine2.deleteCashFlow(created.id);
    const outboxAfterDel = await localDb2.getOutbox();
    expect(outboxAfterDel.some((m) => m.mutationId === originalMutId && m.op === 'upsert')).toBe(true);
    expect(outboxAfterDel.some((m) => m.op === 'delete' && m.recordId === created.id)).toBe(true);
    expect(outboxAfterDel).toHaveLength(2);

    engine2.destroy();
    localDb2.close();
  });

  it('P2-C4 & P2-S2 & P2-S9: epochMismatch freezes ALL outbox mutations instead of discarding 50, detects mid-request epoch bump, and forces full resync for legacy since after replace', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`p2-c4-${crypto.randomUUID()}`);

    const engine = new SyncEngine(localDb, {
      fetchImpl: createD1FetchAdapter(db, 'owner'),
      isOnline: () => true,
      maxBatchSize: 2,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();
    await engine.syncNow(true);

    // Queue 3 offline mutations (> maxBatchSize of 2) while at epoch 1
    await engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '離線1', amount: 10, currency: 'TWD' });
    await engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '離線2', amount: 20, currency: 'TWD' });
    await engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '離線3', amount: 30, currency: 'TWD' });

    // Another device runs a replace import -> epoch becomes 2
    await importFullSnapshot(
      db,
      'owner',
      {
        cashflowLogs: [
          {
            id: 'cf-restored-1',
            date: '2026-11-20',
            yearMonth: '2026-11',
            type: '日常花費',
            category: '生活',
            itemName: '備份還原紀錄',
            amount: 500,
            currency: 'TWD',
            fxRate: 1,
            twdAmount: 500,
            source: '手動',
            note: '',
            createdAt: '2026-11-20T00:00:00.000Z',
            updatedAt: '2026-11-20T00:00:00.000Z',
          },
        ],
      },
      'replace'
    );

    // Sync on Device B: MUST freeze ALL 3 pending outbox mutations (NOT discard 2 and apply 1!)
    const syncRes = await engine.syncNow();
    expect(syncRes.ok).toBe(true);
    expect(engine.getRejections()).toHaveLength(0);
    expect(engine.getFrozenOutbox()).toHaveLength(3);
    expect(await localDb.getOutbox()).toHaveLength(0);
    expect(engine.getSnapshot().cashflowLogs.map((l) => l.id)).toEqual(['cf-restored-1']);

    // User chooses "reapplyFrozenOutbox" -> all 3 offline mutations are cleanly applied on top of restored snapshot!
    const reapplyRes = await engine.reapplyFrozenOutbox();
    expect(reapplyRes.ok).toBe(true);
    expect(engine.getFrozenOutbox()).toHaveLength(0);
    expect(engine.getSnapshot().cashflowLogs).toHaveLength(4);

    // P2-S9: legacy client sending old `since` (no clientEpoch/sinceSeq) when data_epoch > 1 gets fullResyncRequired: true
    const legacyRes = await processSyncRequest(db, 'owner', {
      since: '2099-01-01T00:00:00.000Z',
      mutations: [],
    });
    expect(legacyRes.fullResyncRequired).toBe(true);
    expect(legacyRes.delta.cashflowLogs.some((c) => c.id === 'cf-restored-1')).toBe(true);

    engine.destroy();
    localDb.close();
  });

  it('P2-S4 & P2-S5: unchanged market quote/FX does NOT bump version, and /api/market/refresh respects autoFxEnabled=false', async () => {
    const db = createTestD1();
    const app = createApp();

    // Setup admin via API so we have a real session cookie
    const setupRes = await app.fetch(
      new Request('http://localhost/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupSecret: 'sec-123',
          username: 'admin',
          displayName: 'Admin',
          password: 'password123',
        }),
      }),
      { DB: db, SETUP_SECRET: 'sec-123' }
    );
    expect(setupRes.status).toBe(200);
    const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];

    // Seed an auto-updated stock 2330
    await processSyncRequest(db, 'owner', {
      since: null,
      mutations: [
        {
          mutationId: 'm-s4-stock',
          entity: 'asset',
          op: 'upsert',
          recordId: 's-2330',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {
            updateMode: '自動更新',
            majorType: '資產',
            subCategory: '台股',
            liquidity: '高流動',
            itemName: '台積電',
            ticker: '2330',
            quantityOrAmount: 1000,
            currency: 'TWD',
            unitPrice: 1000,
          },
        },
      ],
    });

    const mockFetch: FetchLike = async (url) => {
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32.5 } }), { status: 200 });
      }
      if (url.includes('mis.twse.com.tw')) {
        return new Response(JSON.stringify({ msgArray: [{ z: '1050.00', y: '1020.00' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    // 1st refresh changes price 1000 -> 1050 (v1 -> v2)
    await refreshMarketData(db, mockFetch, 'owner');
    const after1 = await db
      .prepare('SELECT unit_price, previous_close, version FROM asset_items WHERE user_id = ? AND id = ?')
      .bind('owner', 's-2330')
      .first<{ unit_price: number; previous_close: number; version: number }>();
    expect(after1).toEqual({ unit_price: 1050, previous_close: 1020, version: 2 });

    // 2nd refresh returns IDENTICAL (1050, 1020) and FX (32.5) -> MUST NOT increment versions!
    const settingsBefore2 = await db
      .prepare('SELECT version FROM app_settings WHERE user_id = ?')
      .bind('owner')
      .first<{ version: number }>();
    await refreshMarketData(db, mockFetch, 'owner');
    const after2 = await db
      .prepare('SELECT unit_price, previous_close, version FROM asset_items WHERE user_id = ? AND id = ?')
      .bind('owner', 's-2330')
      .first<{ unit_price: number; previous_close: number; version: number }>();
    const settingsAfter2 = await db
      .prepare('SELECT version FROM app_settings WHERE user_id = ?')
      .bind('owner')
      .first<{ version: number }>();
    expect(after2?.version).toBe(2);
    expect(settingsAfter2?.version).toBe(settingsBefore2?.version);

    // P2-S5 (Option A): disable autoFxEnabled & set manual FX 31.0 -> POST /api/market/refresh MUST keep 31.0!
    await db
      .prepare('UPDATE app_settings SET usd_twd_rate = 31.0, auto_fx_enabled = 0 WHERE user_id = ?')
      .bind('owner')
      .run();

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 33.9 } }), { status: 200 });
      }
      if (url.includes('mis.twse.com.tw')) {
        return new Response(JSON.stringify({ msgArray: [{ z: '1060.00', y: '1050.00' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      const refreshRes = await app.fetch(
        new Request('http://localhost/api/market/refresh', {
          method: 'POST',
          headers: { cookie },
        }),
        { DB: db }
      );
      expect(refreshRes.status).toBe(200);
    } finally {
      globalThis.fetch = origFetch;
    }

    const fxRow = await db
      .prepare('SELECT usd_twd_rate FROM app_settings WHERE user_id = ?')
      .bind('owner')
      .first<{ usd_twd_rate: number }>();
    expect(fxRow?.usd_twd_rate).toBe(31.0);
  });

  it('P2-S1, P2-S8, P2-S11, P2-S12: CSV import atomic change_seq, merge does not resurrect soft-deleted rows, UTF-8 byte limit & X-Expected-User on import/market', async () => {
    const db = createTestD1();
    const app = createApp();

    const setupRes = await app.fetch(
      new Request('http://localhost/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupSecret: 'sec-123',
          username: 'admin',
          displayName: 'Admin',
          password: 'password123',
        }),
      }),
      { DB: db, SETUP_SECRET: 'sec-123' }
    );
    const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];

    // P2-S11: X-Expected-User mismatch -> 409 on /api/market/refresh, /api/import/json, /api/import/csv
    for (const path of ['/api/market/refresh', '/api/import/json', '/api/import/csv']) {
      const mismatchRes = await app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'x-expected-user': 'other-user-id',
          },
          body: JSON.stringify({}),
        }),
        { DB: db }
      );
      expect(mismatchRes.status).toBe(409);
    }

    // P2-S11: UTF-8 byte limit (800_000 Chinese chars = 800K UTF-16 length < 2M, but 2.4MB UTF-8 > 2MB -> MUST return 413!)
    const bigChinese = '中'.repeat(800_000);
    const bigRes = await app.fetch(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ mutations: [], note: bigChinese }),
      }),
      { DB: db }
    );
    expect(bigRes.status).toBe(413);

    // P2-S1: CSV import commits all rows & seq increment atomically
    const beforeState = await processSyncRequest(db, 'owner', { since: null, mutations: [] });
    const csvText = [
      '日期,年月,收支類型,分類,項目名稱,原幣金額,幣別,台幣金額,匯率,來源,備註',
      '2026-11-24,2026-11,日常花費,餐飲,牛肉麵,180,TWD,180,1,手動,',
      '2026-11-25,2026-11,日常花費,餐飲,拉麵,260,TWD,260,1,手動,',
      '2026-11-26,2026-11,日常花費,餐飲,便當,110,TWD,110,1,手動,',
    ].join('\n');
    const csvRes = await app.fetch(
      new Request('http://localhost/api/import/csv', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-expected-user': 'owner' },
        body: JSON.stringify({ csvText }),
      }),
      { DB: db }
    );
    expect(csvRes.status).toBe(200);
    const incAfterCsv = await processSyncRequest(db, 'owner', {
      sinceSeq: beforeState.syncCursor,
      mutations: [],
    });
    expect(incAfterCsv.delta.cashflowLogs).toHaveLength(3);

    // P2-S8: merge import MUST NOT resurrect a soft-deleted record
    const delId = incAfterCsv.delta.cashflowLogs[0].id;
    await db
      .prepare('UPDATE cashflow_logs SET deleted_at = ? WHERE user_id = ? AND id = ?')
      .bind('2026-11-26T05:00:00.000Z', 'owner', delId)
      .run();
    await importFullSnapshot(
      db,
      'owner',
      {
        cashflowLogs: [
          {
            ...incAfterCsv.delta.cashflowLogs[0],
            itemName: '不應復活的舊備份',
          },
        ],
      },
      'merge'
    );
    const deletedRow = await db
      .prepare('SELECT deleted_at, item_name FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind('owner', delId)
      .first<{ deleted_at: string | null; item_name: string }>();
    expect(deletedRow?.deleted_at).toBeTruthy();

    // P2-S12: ensureDefaultLedger / ensureAppSettings for a user who already has change_seq > 0 writes change_seq > 0
    const lateUser = 'late-user';
    await db
      .prepare('INSERT INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 5, 1, ?)')
      .bind(lateUser, '2026-11-26T00:00:00.000Z')
      .run();
    await ensureAppSettings(db, lateUser);
    await ensureDefaultLedger(db, lateUser);
    const lateDelta = await processSyncRequest(db, lateUser, { sinceSeq: 5, mutations: [] });
    expect(lateDelta.delta.settings).toBeTruthy();
    expect(lateDelta.delta.ledgers?.some((l) => l.id === 'default')).toBe(true);
  });

  it('P2-C8 & P2-C10: client handles 409 account mismatch halt, 429 Retry-After retry scheduling, and no-progress failure', async () => {
    const localDb = new LocalFinanceDB(`p2-c8-${crypto.randomUUID()}`);
    let callCount = 0;
    let mismatchPayload: { error: string } | null = null;

    const mockFetch: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // 429 with Retry-After: 0 (clamped to 200ms by SyncEngine)
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      if (callCount === 2) {
        // 200 OK but acked nothing (no forward progress while outbox is non-empty)
        const emptyResp: SyncResponse = {
          ok: true,
          serverTime: '2026-11-26T00:00:00.000Z',
          syncCursor: 1,
          dataEpoch: 1,
          ackedMutationIds: [],
          rejected: [],
          conflicts: [],
          delta: {
            settings: null,
            ledgers: [],
            cashflowLogs: [],
            recurringItems: [],
            sinkingItems: [],
            assetItems: [],
            savingsAdjustments: [],
            stockTransactions: [],
            netWorthHistory: [],
            rentUtilityRecords: [],
            rentUtilityRents: null,
          },
        };
        return new Response(JSON.stringify(emptyResp), { status: 200 });
      }
      // 3rd call: 409 ACCOUNT_MISMATCH
      return new Response(
        JSON.stringify({
          error: '帳號已變更',
          code: 'ACCOUNT_MISMATCH',
          expectedUserId: 'u1',
          actualUserId: 'u2',
        }),
        { status: 409 }
      );
    };

    const engine = new SyncEngine(localDb, {
      expectedUserId: 'u1',
      fetchImpl: mockFetch,
      isOnline: () => true,
      retryBaseDelayMs: 60_000,
      requestLock: async (_name, fn) => fn(),
      onAccountMismatch: (info) => {
        mismatchPayload = info;
      },
    });
    await engine.init();
    await engine.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '餐飲',
      itemName: '測試重試',
      amount: 50,
      currency: 'TWD',
    });

    // 1st call -> 429 -> returns ok: false AND schedules retry after Retry-After (~200ms)
    const r1 = await engine.syncNow();
    expect(r1.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 320));
    // Scheduled retry ran call 2 (no-progress 200 OK)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // 3rd call -> 409 halts sync and triggers onAccountMismatch
    const r3 = await engine.syncNow();
    expect(r3.ok).toBe(false);
    expect(r3.accountMismatch).toBe(true);
    expect(mismatchPayload).toBeTruthy();

    // Subsequent syncNow calls remain halted without hitting network
    const callsBefore = callCount;
    const r4 = await engine.syncNow();
    expect(r4.accountMismatch).toBe(true);
    expect(callCount).toBe(callsBefore);

    engine.destroy();
    localDb.close();
  });
});
