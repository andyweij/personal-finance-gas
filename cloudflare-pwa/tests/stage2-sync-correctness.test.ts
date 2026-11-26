import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/index';
import {
  createInviteCode,
  createSession,
  registerWithInviteCode,
  setupInitialAdmin,
} from '../worker/auth';
import { importFullSnapshot, processSyncRequest } from '../worker/sync';
import { refreshMarketData } from '../worker/market';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';
import type { SyncRequest, SyncResponse } from '../shared/types';

function createD1FetchAdapter(db: D1Database, userId = 'owner') {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/sync' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}')) as SyncRequest;
      const result = await processSyncRequest(db, userId, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };
}

describe('Stage 2 Sync Correctness (2.1 - 2.7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('2.1(a): editing a record while an earlier update is in-flight rebases cleanly without conflict', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`stage2-21a-${crypto.randomUUID()}`);

    let releaseFirstSync!: () => void;
    let firstSyncBlocked = false;
    let callCount = 0;

    const baseFetch = createD1FetchAdapter(db, 'owner');
    const controlledFetch: typeof fetch = async (input, init) => {
      callCount += 1;
      if (callCount === 2) {
        // Hold the 2nd sync (the first edit v1->v2) in-flight until test releases it
        firstSyncBlocked = true;
        await new Promise<void>((resolve) => {
          releaseFirstSync = resolve;
        });
      }
      return baseFetch(input, init);
    };

    const engine = new SyncEngine(localDb, {
      fetchImpl: controlledFetch,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    // 1. Create record & sync to v1
    const created = await engine.saveRecurring({
      itemName: '原始訂閱',
      category: '訂閱',
      type: '固定支出',
      amount: 100,
      currency: 'TWD',
      cycle: '月繳',
      billingSpec: '',
      status: '啟用',
      note: '',
    });
    const r1 = await engine.syncNow();
    expect(r1.ok).toBe(true);
    expect(engine.getSnapshot().recurringItems.find((r) => r.id === created.id)?.version).toBe(1);

    // 2. Make edit #1 and kick off syncNow() (will pause in-flight)
    await engine.saveRecurring({
      id: created.id,
      itemName: '同步中第一次修改',
      category: '訂閱',
      type: '固定支出',
      amount: 150,
      currency: 'TWD',
      cycle: '月繳',
      billingSpec: '',
      status: '啟用',
      note: '',
    });
    const inFlightPromise = engine.syncNow();

    // Wait until fetch #2 is actually in-flight
    for (let i = 0; i < 20 && !firstSyncBlocked; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(firstSyncBlocked).toBe(true);

    // 3. While edit #1 is in-flight, edit the SAME record again locally (edit #2)
    await engine.saveRecurring({
      id: created.id,
      itemName: '同步中第二次修改',
      category: '訂閱',
      type: '固定支出',
      amount: 220,
      currency: 'TWD',
      cycle: '月繳',
      billingSpec: '',
      status: '啟用',
      note: '',
    });

    // Release edit #1 response
    releaseFirstSync();
    const r2 = await inFlightPromise;
    expect(r2.ok).toBe(true);

    // Local snapshot MUST preserve edit #2 (not overwritten by stale edit #1 response)
    expect(engine.getSnapshot().recurringItems.find((r) => r.id === created.id)?.itemName).toBe(
      '同步中第二次修改'
    );
    expect(engine.getConflicts()).toHaveLength(0);

    // 4. Sync remaining rebased edit #2 -> MUST succeed with 0 conflicts!
    const r3 = await engine.syncNow();
    expect(r3.ok).toBe(true);
    expect(engine.getConflicts()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(0);

    // Verify server holds edit #2 at version 3
    const row = await db
      .prepare('SELECT item_name, amount, version FROM recurring_items WHERE user_id = ? AND id = ?')
      .bind('owner', created.id)
      .first<{ item_name: string; amount: number; version: number }>();
    expect(row?.item_name).toBe('同步中第二次修改');
    expect(row?.amount).toBe(220);
    expect(row?.version).toBe(3);

    localDb.close();
  });

  it('2.1(b): deleting a brand-new record while its create is in-flight does not resurrect it and deletes cleanly on server', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`stage2-21b-${crypto.randomUUID()}`);

    let releaseCreateSync!: () => void;
    let createInFlight = false;
    let callCount = 0;

    const baseFetch = createD1FetchAdapter(db, 'owner');
    const controlledFetch: typeof fetch = async (input, init) => {
      callCount += 1;
      if (callCount === 1) {
        createInFlight = true;
        await new Promise<void>((resolve) => {
          releaseCreateSync = resolve;
        });
      }
      return baseFetch(input, init);
    };

    const engine = new SyncEngine(localDb, {
      fetchImpl: controlledFetch,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    // 1. Create a brand-new record and start syncing it
    const created = await engine.addCashFlow({
      date: '2026-11-25',
      type: '日常花費',
      category: '餐飲',
      itemName: '剛新增就被刪',
      amount: 99,
      currency: 'TWD',
    });
    const inFlightCreate = engine.syncNow();

    for (let i = 0; i < 20 && !createInFlight; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(createInFlight).toBe(true);

    // 2. Delete it while create is in-flight
    await engine.deleteCashFlow(created.id);
    expect(engine.getSnapshot().cashflowLogs.find((c) => c.id === created.id)).toBeUndefined();

    // 3. Release create response
    releaseCreateSync();
    const r1 = await inFlightCreate;
    expect(r1.ok).toBe(true);

    // Record MUST NOT resurrect locally!
    expect(engine.getSnapshot().cashflowLogs.find((c) => c.id === created.id)).toBeUndefined();

    // 4. Sync remaining rebased delete -> MUST delete on server with 0 conflicts
    const r2 = await engine.syncNow();
    expect(r2.ok).toBe(true);
    expect(engine.getConflicts()).toHaveLength(0);
    expect(engine.getSnapshot().cashflowLogs.find((c) => c.id === created.id)).toBeUndefined();

    const row = await db
      .prepare('SELECT deleted_at FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind('owner', created.id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeTruthy();

    localDb.close();
  });

  it('2.2: uses server-assigned monotonic change_seq cursor and always persists server updated_at', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // Legacy client sends a wildly skewed old clientTimestamp
    const res1 = await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-skew-1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-skew-1',
          clientTimestamp: '2020-01-01T00:00:00.000Z',
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '餐飲',
            itemName: '時鐘偏差測試',
            amount: 50,
            currency: 'TWD',
          },
        },
      ],
    });

    expect(res1.ackedMutationIds).toEqual(['m-skew-1']);
    expect(typeof (res1 as SyncResponse & { syncCursor?: number }).syncCursor).toBe('number');
    const cursor1 = (res1 as SyncResponse & { syncCursor?: number }).syncCursor as number;
    expect(cursor1).toBeGreaterThan(0);

    // Persisted updated_at MUST be server time (not 2020-01-01)
    const row = await db
      .prepare('SELECT updated_at FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind(uid, 'cf-skew-1')
      .first<{ updated_at: string }>();
    expect(row?.updated_at.startsWith('2020-')).toBe(false);

    // Second write advances cursor monotonically
    const res2 = await processSyncRequest(db, uid, {
      sinceSeq: cursor1,
      mutations: [
        {
          mutationId: 'm-seq-2',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-seq-2',
          clientTimestamp: '2020-01-02T00:00:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '交通',
            itemName: '第二筆變更',
            amount: 80,
            currency: 'TWD',
          },
        },
      ],
    } as SyncRequest);

    const cursor2 = (res2 as SyncResponse & { syncCursor?: number }).syncCursor as number;
    expect(cursor2).toBeGreaterThan(cursor1);

    // Another device polling with sinceSeq = cursor1 MUST see ONLY cf-seq-2 (not miss it!)
    const pullRes = await processSyncRequest(db, uid, {
      sinceSeq: cursor1,
      mutations: [],
    } as SyncRequest);
    expect(pullRes.delta.cashflowLogs.map((l) => l.id)).toEqual(['cf-seq-2']);
  });

  it('2.3: replace import bumps data_epoch and forces other synced devices to perform a full resync', async () => {
    const db = createTestD1();
    const localDbB = new LocalFinanceDB(`stage2-23-${crypto.randomUUID()}`);
    const engineB = new SyncEngine(localDbB, {
      fetchImpl: createD1FetchAdapter(db, 'owner'),
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engineB.init();

    // Seed cf-old on server & sync Device B
    await processSyncRequest(db, 'owner', {
      since: null,
      mutations: [
        {
          mutationId: 'm-old-1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-old',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '餐飲',
            itemName: '被覆蓋前的舊資料',
            amount: 300,
            currency: 'TWD',
          },
        },
      ],
    });
    await engineB.syncNow();
    expect(engineB.getSnapshot().cashflowLogs.map((c) => c.id)).toEqual(['cf-old']);

    // Device A performs a replace import with completely different data
    await importFullSnapshot(
      db,
      'owner',
      {
        cashflowLogs: [
          {
            id: 'cf-restored',
            date: '2026-11-20',
            yearMonth: '2026-11',
            type: '日常花費',
            category: '生活',
            itemName: '還原後的新資料',
            amount: 500,
            currency: 'TWD',
            fxRate: 1,
            twdAmount: 500,
            source: '手動',
            note: '',
            createdAt: '2026-11-20T10:00:00.000Z',
            updatedAt: '2026-11-20T10:00:00.000Z',
          },
        ],
      },
      'replace'
    );

    // Device B does a normal incremental syncNow() -> MUST detect epoch bump and drop cf-old!
    const syncRes = await engineB.syncNow();
    expect(syncRes.ok).toBe(true);
    expect(engineB.getSnapshot().cashflowLogs.map((c) => c.id)).toEqual(['cf-restored']);

    localDbB.close();
  });

  it('2.4: market refresh increments version/change_seq and respects auto_fx_enabled during cron', async () => {
    const db = createTestD1();

    // Setup owner (autoFxEnabled = true by default) and member (autoFxEnabled = false, manual FX 31.0)
    await setupInitialAdmin(db, { username: 'admin', displayName: '管理員', password: 'adminpass123' });
    const invite = await createInviteCode(db, 'owner', { note: '成員' });
    const member = await registerWithInviteCode(db, {
      inviteCode: invite.inviteCode,
      username: 'member1',
      displayName: '成員',
      password: 'memberpass123',
    });

    // Add an auto-updated stock to owner
    const createStockRes = await processSyncRequest(db, 'owner', {
      since: null,
      mutations: [
        {
          mutationId: 'm-stock-1',
          entity: 'asset',
          op: 'upsert',
          recordId: 'asset-2330',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
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
            unitPrice: 900,
          },
        },
      ],
    });
    const beforeCursor = (createStockRes as SyncResponse & { syncCursor?: number }).syncCursor ?? 0;

    // Member sets manual FX rate 31.0 and disables autoFxEnabled
    await processSyncRequest(db, member.id, {
      since: null,
      mutations: [
        {
          mutationId: 'm-member-fx',
          entity: 'settings',
          op: 'upsert',
          recordId: '1',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
          baseVersion: 1,
          payload: {
            monthlyDailyBudget: 15000,
            emergencyTargetMonths: 6,
            usdTwdRate: 31.0,
            autoFxEnabled: false,
          },
        },
      ],
    });

    // Mock Yahoo Finance FX (33.25) and 2330.TW stock quote (1050)
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('TWD=X') || url.includes('USDTWD')) {
        return new Response(
          JSON.stringify({
            chart: { result: [{ meta: { regularMarketPrice: 33.25 } }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('2330')) {
        return new Response(
          JSON.stringify({
            chart: { result: [{ meta: { regularMarketPrice: 1050, chartPreviousClose: 1020 } }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    // Run global cron market refresh (no targetUserId)
    await refreshMarketData(db, mockFetch);

    // 1. Stock unitPrice & version incremented!
    const stockRow = await db
      .prepare('SELECT unit_price, version FROM asset_items WHERE user_id = ? AND id = ?')
      .bind('owner', 'asset-2330')
      .first<{ unit_price: number; version: number }>();
    expect(stockRow?.unit_price).toBe(1050);
    expect(stockRow?.version).toBe(2);

    // 2. Owner's FX updated AND app_settings.version incremented!
    const ownerSettings = await db
      .prepare('SELECT usd_twd_rate, version FROM app_settings WHERE user_id = ?')
      .bind('owner')
      .first<{ usd_twd_rate: number; version: number }>();
    expect(ownerSettings?.usd_twd_rate).toBe(33.25);
    expect(ownerSettings?.version).toBeGreaterThan(1);

    // 3. Owner's incremental sync since beforeCursor MUST receive the updated stock & settings!
    const deltaRes = await processSyncRequest(db, 'owner', {
      sinceSeq: beforeCursor,
      mutations: [],
    } as SyncRequest);
    expect(deltaRes.delta.assetItems.some((a) => a.id === 'asset-2330' && a.unitPrice === 1050)).toBe(true);

    // 4. Member with autoFxEnabled=false MUST keep manual FX 31.0 untouched!
    const memberSettings = await db
      .prepare('SELECT usd_twd_rate FROM app_settings WHERE user_id = ?')
      .bind(member.id)
      .first<{ usd_twd_rate: number }>();
    expect(memberSettings?.usd_twd_rate).toBe(31.0);
  });

  it('2.5: rejects cross-account sync with HTTP 409 when X-Expected-User mismatches session user', async () => {
    const db = createTestD1();
    const env = { DB: db, APP_NAME: 'test' } as never;
    const app = createApp();

    const owner = await setupInitialAdmin(db, {
      username: 'owneruser',
      displayName: '擁有者',
      password: 'ownerpass123',
    });
    const session = await createSession(db, owner.id, 'test-ua');

    // Direct API test: session is 'owner', header expects 'other-user-id' -> 409
    const apiRes = await app.fetch(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `pf_session=${session}`,
          'x-expected-user': 'other-user-id',
        },
        body: JSON.stringify({ since: null, mutations: [] }),
      }),
      env
    );
    expect(apiRes.status).toBe(409);

    // SyncEngine client test: sends X-Expected-User and halts cleanly on 409
    const localDb = new LocalFinanceDB(`stage2-25-${crypto.randomUUID()}`);
    let capturedHeader: string | null = null;
    let mismatchFired = false;

    const engine = new SyncEngine(localDb, {
      expectedUserId: 'other-user-id',
      onAccountMismatch: () => {
        mismatchFired = true;
      },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        capturedHeader = headers.get('x-expected-user');
        return app.fetch(
          new Request(`http://localhost${typeof input === 'string' ? input : input.toString()}`, {
            method: init?.method,
            headers: {
              'content-type': 'application/json',
              cookie: `pf_session=${session}`,
              ...(capturedHeader ? { 'x-expected-user': capturedHeader } : {}),
            },
            body: init?.body,
          }),
          env
        );
      },
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    const syncRes = await engine.syncNow();
    expect(capturedHeader).toBe('other-user-id');
    expect(syncRes.ok).toBe(false);
    expect((syncRes as { accountMismatch?: boolean }).accountMismatch).toBe(true);
    expect(mismatchFired).toBe(true);

    localDb.close();
  });

  it('2.6: supports AbortController timeout, client/server batch limits, and cross-tab lock acquisition', async () => {
    const db = createTestD1();
    const env = { DB: db, APP_NAME: 'test' } as never;
    const app = createApp();
    const owner = await setupInitialAdmin(db, {
      username: 'owneruser',
      displayName: '擁有者',
      password: 'ownerpass123',
    });
    const session = await createSession(db, owner.id, 'test-ua');

    // (a) Server rejects > 200 mutations in one batch with 400
    const tooMany = Array.from({ length: 205 }, (_, i) => ({
      mutationId: `m-many-${i}`,
      entity: 'cashflow',
      op: 'upsert',
      recordId: `cf-many-${i}`,
      clientTimestamp: '2026-11-25T10:00:00.000Z',
      baseVersion: null,
      payload: {},
    }));
    const oversizedRes = await app.fetch(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `pf_session=${session}`,
        },
        body: JSON.stringify({ since: null, mutations: tooMany }),
      }),
      env
    );
    expect(oversizedRes.status).toBe(400);

    // (b) Client AbortController timeout prevents hanging forever
    const localDbTimeout = new LocalFinanceDB(`stage2-26-to-${crypto.randomUUID()}`);
    const engineTimeout = new SyncEngine(localDbTimeout, {
      requestTimeoutMs: 40,
      retryBaseDelayMs: 60_000,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    });
    await engineTimeout.init();
    const startMs = Date.now();
    const toRes = await engineTimeout.syncNow();
    expect(toRes.ok).toBe(false);
    expect(Date.now() - startMs).toBeLessThan(1000);
    engineTimeout.destroy?.();
    localDbTimeout.close();

    // (c) Client splits large outbox into maxBatchSize chunks and acquires cross-tab lock
    const localDbBatch = new LocalFinanceDB(`stage2-26-batch-${crypto.randomUUID()}`);
    const sentBatchSizes: number[] = [];
    let lockAcquired = 0;
    const baseFetch = createD1FetchAdapter(db, 'owner');
    const engineBatch = new SyncEngine(localDbBatch, {
      maxBatchSize: 20,
      isOnline: () => true,
      requestLock: async (_name, fn) => {
        lockAcquired += 1;
        return fn();
      },
      fetchImpl: async (input, init) => {
        const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
        sentBatchSizes.push(body.mutations.length);
        return baseFetch(input, init);
      },
    });
    await engineBatch.init();

    for (let i = 0; i < 45; i++) {
      await engineBatch.addCashFlow({
        date: '2026-11-25',
        type: '日常花費',
        category: '餐飲',
        itemName: `批次紀錄 ${i}`,
        amount: 10 + i,
        currency: 'TWD',
      });
    }

    const batchRes = await engineBatch.syncNow();
    expect(batchRes.ok).toBe(true);
    expect(lockAcquired).toBeGreaterThanOrEqual(1);
    expect(sentBatchSizes).toEqual([20, 20, 5]);
    expect(await localDbBatch.getOutbox()).toHaveLength(0);
    localDbBatch.close();
  });

  it('2.7: commits to IndexedDB BEFORE mutating in-memory snapshot so failed writes leave state intact', async () => {
    const localDb = new LocalFinanceDB(`stage2-27-${crypto.randomUUID()}`);
    const errors: string[] = [];
    const engine = new SyncEngine(localDb, {
      isOnline: () => false,
      onError: (msg) => errors.push(msg),
    });
    await engine.init();

    // Seed 1 valid log
    await engine.addCashFlow({
      date: '2026-11-25',
      type: '日常花費',
      category: '餐飲',
      itemName: '已持久化紀錄',
      amount: 100,
      currency: 'TWD',
    });
    expect(engine.getSnapshot().cashflowLogs).toHaveLength(1);

    // Simulate IndexedDB failure (e.g. QuotaExceededError)
    vi.spyOn(localDb, 'commitLocalMutation').mockRejectedValueOnce(new Error('QuotaExceededError'));

    await expect(
      engine.addCashFlow({
        date: '2026-11-25',
        type: '日常花費',
        category: '餐飲',
        itemName: '寫入失敗不該殘留於記憶體',
        amount: 999,
        currency: 'TWD',
      })
    ).rejects.toThrow('QuotaExceededError');

    // In-memory snapshot MUST remain unchanged (still only 1 record)
    expect(engine.getSnapshot().cashflowLogs).toHaveLength(1);
    expect(engine.getSnapshot().cashflowLogs[0].itemName).toBe('已持久化紀錄');
    expect(errors.length).toBeGreaterThanOrEqual(1);

    localDb.close();
  });
});
