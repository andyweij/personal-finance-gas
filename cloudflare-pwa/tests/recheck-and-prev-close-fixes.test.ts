import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncRequest, SyncResponse } from '../shared/types';
import { resolveStockModalPriceFields } from '../shared/validation';
import { createApp } from '../worker/index';
import { fetchStockQuote, type FetchLike } from '../worker/market';
import { processSyncRequest } from '../worker/sync';
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

describe('Phase 1 Recheck (R1-R7) & v1.8.4 Previous-Close Review (F1-F9)', () => {
  it('R1: concurrent duplicate mutationId where request B reads AFTER request A commits still acks (create, update, delete)', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // Helper: simulate A committing right BEFORE B reads the table row (both passed initial idempotency check)
    const runRace = async (mut: SyncRequest['mutations'][number]) => {
      // First apply via A
      const resA = await processSyncRequest(db, uid, { since: null, mutations: [mut] });
      expect(resA.ackedMutationIds).toContain(mut.mutationId);

      // Now wrap db.prepare so the VERY FIRST idempotency SELECT returns null (simulating B already passed pre-check),
      // while the re-check inside VersionConflictError sees the real committed sync_idempotency row!
      let skippedFirstIdem = false;
      const racingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!skippedFirstIdem && sql.includes('SELECT mutation_id FROM sync_idempotency')) {
                skippedFirstIdem = true;
                return new Proxy(stmt, {
                  get(sTarget, sProp, sReceiver) {
                    if (sProp === 'bind') {
                      return (...args: unknown[]) => {
                        const bound = sTarget.bind(...args);
                        return new Proxy(bound, {
                          get(bTarget, bProp, bReceiver) {
                            if (bProp === 'first') return async () => null;
                            const bv = Reflect.get(bTarget, bProp, bReceiver);
                            return typeof bv === 'function' ? bv.bind(bTarget) : bv;
                          },
                        });
                      };
                    }
                    const sv = Reflect.get(sTarget, sProp, sReceiver);
                    return typeof sv === 'function' ? sv.bind(sTarget) : sv;
                  },
                });
              }
              return stmt;
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });

      const resB = await processSyncRequest(racingDb, uid, { since: null, mutations: [mut] });
      expect(resB.ackedMutationIds).toContain(mut.mutationId);
      expect(resB.conflicts || []).toHaveLength(0);
    };

    // 1. Create race
    await runRace({
      mutationId: 'r1-create-1',
      entity: 'cashflow',
      op: 'upsert',
      recordId: 'cf-r1',
      clientTimestamp: '2026-11-26T00:00:00.000Z',
      baseVersion: null,
      payload: {
        date: '2026-11-26',
        type: '日常花費',
        category: '餐飲',
        itemName: 'R1新建',
        amount: 100,
        currency: 'TWD',
      },
    });

    // 2. Update race (v1 -> v2)
    await runRace({
      mutationId: 'r1-update-1',
      entity: 'cashflow',
      op: 'upsert',
      recordId: 'cf-r1',
      clientTimestamp: '2026-11-26T00:01:00.000Z',
      baseVersion: 1,
      payload: {
        date: '2026-11-26',
        type: '日常花費',
        category: '餐飲',
        itemName: 'R1更新',
        amount: 200,
        currency: 'TWD',
      },
    });

    // 3. Delete race (v2 -> v3)
    await runRace({
      mutationId: 'r1-delete-1',
      entity: 'cashflow',
      op: 'delete',
      recordId: 'cf-r1',
      clientTimestamp: '2026-11-26T00:02:00.000Z',
      baseVersion: 2,
    });
  });

  it('R2: server rejects NaN twdAmount & invalid envelope types cleanly (no 500), and client isolates & quarantines poison-pill mutations without blocking downloads', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // Server R2a: savings_adjustment with twdAmount: 'abc' MUST be rejected (not throw 500 NOT NULL!)
    const badRes = await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-r2-nan',
          entity: 'savings_adjustment',
          op: 'upsert',
          recordId: 'adj-r2',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {
            accountId: 'acc-1',
            date: '2026-11-26',
            amount: 500,
            currency: 'TWD',
            twdAmount: 'abc',
          },
        },
        {
          mutationId: 'm-r2-bad-type',
          entity: 'cashflow',
          op: 'upsert',
          recordId: { broken: true } as unknown as string,
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {},
        },
      ],
    });
    expect(badRes.rejected.some((r) => r.mutationId === 'm-r2-nan')).toBe(true);
    expect(badRes.rejected.some((r) => r.mutationId === 'm-r2-bad-type')).toBe(true);

    // Client R2b: poison-pill mutation causing persistent 500 is isolated & quarantined while valid mutation & server pull succeed!
    const localDb = new LocalFinanceDB(`r2-poison-${crypto.randomUUID()}`);
    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.some((m) => m.payload?.itemName === '毒丸')) {
        return new Response(JSON.stringify({ error: 'internal server error' }), { status: 500 });
      }
      const res: SyncResponse = {
        ok: true,
        // v1.8.9 (V1): a healthy server confirms the harmless write-health probe
        ...((body as SyncRequest & { writeProbe?: boolean }).writeProbe ? { writeProbeOk: true } : {}),
        serverTime: '2026-11-26T01:00:00.000Z',
        syncCursor: 2,
        dataEpoch: 1,
        ackedMutationIds: body.mutations.map((m) => m.mutationId),
        rejected: [],
        conflicts: [],
        delta: {
          settings: null,
          ledgers: [],
          cashflowLogs: [
            {
              id: 'cf-from-server',
              date: '2026-11-26',
              yearMonth: '2026-11',
              type: '日常花費',
              category: '餐飲',
              itemName: '雲端新增紀錄',
              amount: 333,
              currency: 'TWD',
              fxRate: 1,
              twdAmount: 333,
              source: '手動',
              note: '',
              createdAt: '2026-11-26T01:00:00.000Z',
              updatedAt: '2026-11-26T01:00:00.000Z',
              version: 1,
            },
          ],
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
      return new Response(JSON.stringify(res), { status: 200 });
    };

    const engine = new SyncEngine(localDb, {
      fetchImpl: mockFetch,
      isOnline: () => true,
      retryBaseDelayMs: 60_000,
      maxPoisonRetries: 3,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    await engine.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '餐飲',
      itemName: '毒丸',
      amount: 10,
      currency: 'TWD',
    });
    await engine.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '餐飲',
      itemName: '正常紀錄',
      amount: 100,
      currency: 'TWD',
    });

    // Even on 1st 500 failure, read-only pull downloads cf-from-server!
    await engine.syncNow();
    expect(engine.getSnapshot().cashflowLogs.some((c) => c.id === 'cf-from-server')).toBe(true);

    // After repeated failures, poison pill is isolated & quarantined into rejections, and 正常紀錄 succeeds!
    await engine.syncNow();
    await engine.syncNow();
    await engine.syncNow();

    expect(engine.getRejections().some((r) => r.clientPayload?.itemName === '毒丸')).toBe(true);
    expect(await localDb.getOutbox()).toHaveLength(0);

    engine.destroy();
    localDb.close();
  });

  it('R3 & R6 & R7: pendingFullResync persists across reload after rejection, and rejected create clears dependent pending edits without resurrecting', async () => {
    const db = createTestD1();
    const dbName = `r3-r7-${crypto.randomUUID()}`;
    const localDb1 = new LocalFinanceDB(dbName);
    const baseFetch = createD1FetchAdapter(db, 'owner');

    let failFullPullOnce = false;
    const fetch1: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (failFullPullOnce && body.since === null && body.sinceSeq === null && body.mutations.length === 0) {
        failFullPullOnce = false;
        return new Response(JSON.stringify({ error: 'temporary outage' }), { status: 503 });
      }
      return baseFetch(input, init);
    };

    const engine1 = new SyncEngine(localDb1, {
      fetchImpl: fetch1,
      isOnline: () => true,
      retryBaseDelayMs: 60_000,
      requestLock: async (_name, fn) => fn(),
    });
    await engine1.init();
    await engine1.syncNow(true);

    const lg = await engine1.saveLedger({ name: '帳本A', includeInNetWorth: true, note: '' });
    await engine1.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '餐飲',
      itemName: '綁定帳本A',
      amount: 500,
      currency: 'TWD',
      ledgerId: lg.id,
    });
    await engine1.syncNow();

    // Inject rejected ledger delete, AND simulate the follow-up full pull failing (503)
    const snapWithout = {
      ...engine1.getSnapshot(),
      ledgers: (engine1.getSnapshot().ledgers || []).filter((l) => l.id !== lg.id),
    };
    await localDb1.commitLocalMutation(snapWithout, [
      {
        mutationId: 'm-r3-del',
        entity: 'ledger',
        op: 'delete',
        recordId: lg.id,
        clientTimestamp: '2026-11-26T02:00:00.000Z',
        baseVersion: 1,
        isNewRecord: false,
      },
    ]);
    failFullPullOnce = true;
    const rFail = await engine1.syncNow();
    expect(rFail.ok).toBe(false);
    // R3: meta.pendingFullResync MUST be persisted to IndexedDB!
    const persistedMeta = await localDb1.getMeta();
    expect(persistedMeta.pendingFullResync).toBe(true);
    // Card status MUST truthfully say pending_resync (NOT falsely claim 'restored')!
    expect(engine1.getRejections().find((r) => r.mutationId === 'm-r3-del')?.resolutionStatus).toBe('pending_resync');
    engine1.destroy();
    localDb1.close();

    // Simulate reload: Engine 2 opens same DB with empty outbox -> syncNow() MUST honor pendingFullResync and restore lg!
    const localDb2 = new LocalFinanceDB(dbName);
    const engine2 = new SyncEngine(localDb2, {
      fetchImpl: baseFetch,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine2.init();
    const rRecover = await engine2.syncNow();
    expect(rRecover.ok).toBe(true);
    expect((engine2.getSnapshot().ledgers || []).some((l) => l.id === lg.id)).toBe(true);
    expect((await localDb2.getMeta()).pendingFullResync).toBeFalsy();
    expect(engine2.getRejections().find((r) => r.mutationId === 'm-r3-del')?.resolutionStatus).toBe('restored');

    // R7: Rejected in-flight create with a newer pending edit -> clears dependent pending edit & rolls back cleanly (never resurrects!)
    let holdCreate!: () => void;
    let createSent!: () => void;
    const createSentPromise = new Promise<void>((r) => {
      createSent = r;
    });
    const fetchR7: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.some((m) => m.mutationId === 'm-r7-create')) {
        createSent();
        await new Promise<void>((r) => {
          holdCreate = r;
        });
        return new Response(
          JSON.stringify({
            ok: true,
            serverTime: '2026-11-26T03:00:00.000Z',
            syncCursor: 99,
            dataEpoch: 1,
            ackedMutationIds: [],
            rejected: [{ mutationId: 'm-r7-create', reason: '建立失敗' }],
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
          }),
          { status: 200 }
        );
      }
      return baseFetch(_input, init);
    };

    const localDb3 = new LocalFinanceDB(`r7-${crypto.randomUUID()}`);
    const engine3 = new SyncEngine(localDb3, {
      fetchImpl: fetchR7,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine3.init();

    // Inject new asset create
    const snapWithNew = {
      ...engine3.getSnapshot(),
      assetItems: [
        {
          id: 'as-r7',
          updateMode: '手動快照',
          majorType: '資產',
          subCategory: '定存/現金',
          liquidity: '高流動',
          itemName: '新建資產',
          ticker: '',
          quantityOrAmount: 100,
          currency: 'TWD',
          unitPrice: 1,
          note: '',
          createdAt: '2026-11-26T02:50:00.000Z',
          updatedAt: '2026-11-26T02:50:00.000Z',
          deletedAt: null,
        },
      ],
    };
    await localDb3.commitLocalMutation(snapWithNew, [
      {
        mutationId: 'm-r7-create',
        entity: 'asset',
        op: 'upsert',
        recordId: 'as-r7',
        clientTimestamp: '2026-11-26T02:50:00.000Z',
        baseVersion: null,
        isNewRecord: true,
        payload: { ...snapWithNew.assetItems[0] },
      },
    ]);
    await engine3.reloadFromIndexedDb();

    const syncP = engine3.syncNow();
    await createSentPromise;

    // While m-r7-create is in-flight, user edits as-r7!
    await engine3.saveAsset({
      id: 'as-r7',
      updateMode: '手動快照',
      majorType: '資產',
      subCategory: '定存/現金',
      liquidity: '高流動',
      itemName: '新建後又編輯',
      ticker: '',
      quantityOrAmount: 200,
      currency: 'TWD',
      unitPrice: 1,
    });

    holdCreate();
    await syncP;

    // Both as-r7 in snapshot AND dependent pending edit in outbox MUST be rolled back/cleared cleanly!
    expect(engine3.getSnapshot().assetItems.some((a) => a.id === 'as-r7')).toBe(false);
    expect((await localDb3.getOutbox()).some((m) => m.recordId === 'as-r7')).toBe(false);
    const rejR7 = engine3.getRejections().find((r) => r.mutationId === 'm-r7-create');
    expect(rejR7?.resolutionStatus).toBe('rolled_back');

    engine2.destroy();
    localDb2.close();
    engine3.destroy();
    localDb3.close();
  });

  it('F1: omitted unitPrice/previousClose payload preserves valid local price after BOTH rebase AND conflict resolveConflictKeepLocal', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`f1-${crypto.randomUUID()}`);
    const baseFetch = createD1FetchAdapter(db, 'owner');

    // Seed auto-updated stock 2330 at v1 (price 1000, prevClose 980)
    await processSyncRequest(db, 'owner', {
      since: null,
      mutations: [
        {
          mutationId: 'm-f1-seed',
          entity: 'asset',
          op: 'upsert',
          recordId: 'st-2330',
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
            previousClose: 980,
            costBasis: 800000,
          },
        },
      ],
    });

    let online = true;
    const engine = new SyncEngine(localDb, {
      fetchImpl: baseFetch,
      isOnline: () => online,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();
    await engine.syncNow(true);

    // Server advances st-2330 to v2 with new price (1060, 1000)
    await db
      .prepare(
        `UPDATE asset_items SET unit_price = 1060, previous_close = 1000, price_updated_at = '2026-11-26T04:00:00.000Z', version = 2 WHERE user_id = 'owner' AND id = 'st-2330'`
      )
      .run();

    // Client edits ONLY costBasis (omitting unitPrice & previousClose) -> triggers v1 vs v2 conflict!
    await engine.saveAsset({
      id: 'st-2330',
      updateMode: '自動更新',
      majorType: '資產',
      subCategory: '台股',
      liquidity: '高流動',
      itemName: '台積電',
      ticker: '2330',
      quantityOrAmount: 1000,
      currency: 'TWD',
      costBasis: 850000,
    });
    await engine.syncNow();
    expect(engine.getConflicts().some((c) => c.recordId === 'st-2330')).toBe(true);

    // Go OFFLINE before clicking "Keep Local" so we verify local snapshot WITHOUT network rescue!
    online = false;
    const conflict = engine.getConflicts().find((c) => c.recordId === 'st-2330')!;
    await engine.resolveConflictKeepLocal(conflict.mutationId);
    const offlineStock = engine.getSnapshot().assetItems.find((a) => a.id === 'st-2330')!;
    expect(Number.isFinite(offlineStock.unitPrice)).toBe(true);
    expect(offlineStock.unitPrice).toBe(1060);
    expect(offlineStock.previousClose).toBe(1000);
    expect(offlineStock.costBasis).toBe(850000);

    // Go back online and sync: both local and server MUST keep 1060 / 1000 / 850000
    online = true;
    await engine.syncNow();
    const syncedStock = engine.getSnapshot().assetItems.find((a) => a.id === 'st-2330')!;
    expect(syncedStock.unitPrice).toBe(1060);
    expect(syncedStock.previousClose).toBe(1000);
    expect(syncedStock.costBasis).toBe(850000);

    engine.destroy();
    localDb.close();
  });

  it('F4 & F5 & F9: editing only prevClose does not clobber server price; changing ticker resets price/prevClose/priceUpdatedAt; soft-deleted asset does not retain stale price', async () => {
    // F4: UI helper omits unitPrice when ONLY previousClose changed
    expect(
      resolveStockModalPriceFields({
        existing: { unitPrice: 100, previousClose: 98 },
        rawPrice: '100',
        rawPrevClose: '95',
        hasPrevCloseInput: true,
      })
    ).toEqual({
      previousClose: 95,
      manualPriceOverride: true,
    });

    const db = createTestD1();
    const uid = 'owner';
    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, price_updated_at, note, created_at, updated_at, deleted_at, version)
         VALUES (?, 'st-f4', '自動更新', '資產', '台股', '高流動', '台積電', '2330', 1000, 'TWD', 120, 118, '2026-11-26T00:00:00.000Z', '', '2026-11-20T00:00:00.000Z', '2026-11-26T00:00:00.000Z', NULL, 2)`
      )
      .bind(uid)
      .run();

    // F4: client sends ONLY previousClose: 115 + manualPriceOverride: true (omitting unitPrice) -> server preserves 120 and sets previous_close = 115!
    await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-f4-prev-only',
          entity: 'asset',
          op: 'upsert',
          recordId: 'st-f4',
          clientTimestamp: '2026-11-26T01:00:00.000Z',
          baseVersion: 2,
          payload: {
            updateMode: '自動更新',
            majorType: '資產',
            subCategory: '台股',
            liquidity: '高流動',
            itemName: '台積電',
            ticker: '2330',
            quantityOrAmount: 1000,
            currency: 'TWD',
            previousClose: 115,
            manualPriceOverride: true,
          },
        },
      ],
    });
    const afterF4 = await db
      .prepare('SELECT unit_price, previous_close FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, 'st-f4')
      .first<{ unit_price: number; previous_close: number | null }>();
    expect(afterF4).toEqual({ unit_price: 120, previous_close: 115 });

    // F5: ticker changed 2330 -> 2317 without explicit new price -> resets unit_price = 0, previous_close = NULL, price_updated_at = NULL!
    await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-f5-ticker',
          entity: 'asset',
          op: 'upsert',
          recordId: 'st-f4',
          clientTimestamp: '2026-11-26T02:00:00.000Z',
          baseVersion: 3,
          payload: {
            updateMode: '自動更新',
            majorType: '資產',
            subCategory: '台股',
            liquidity: '高流動',
            itemName: '鴻海',
            ticker: '2317',
            quantityOrAmount: 1000,
            currency: 'TWD',
          },
        },
      ],
    });
    const afterF5 = await db
      .prepare('SELECT ticker, unit_price, previous_close, price_updated_at FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, 'st-f4')
      .first<{ ticker: string; unit_price: number; previous_close: number | null; price_updated_at: string | null }>();
    expect(afterF5).toEqual({ ticker: '2317', unit_price: 0, previous_close: null, price_updated_at: null });

    // F9: soft-deleted auto-updated asset re-upserted does NOT retain stale deleted-row price
    await db
      .prepare(
        `UPDATE asset_items SET unit_price = 999, previous_close = 990, deleted_at = '2026-11-26T02:30:00.000Z', version = 5 WHERE user_id = ? AND id = ?`
      )
      .bind(uid, 'st-f4')
      .run();
    await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-f9-resurrect',
          entity: 'asset',
          op: 'upsert',
          recordId: 'st-f4',
          clientTimestamp: '2026-11-26T03:00:00.000Z',
          baseVersion: 5,
          payload: {
            updateMode: '自動更新',
            majorType: '資產',
            subCategory: '台股',
            liquidity: '高流動',
            itemName: '鴻海',
            ticker: '2317',
            quantityOrAmount: 1000,
            currency: 'TWD',
            unitPrice: 210,
            previousClose: 205,
          },
        },
      ],
    });
    const afterF9 = await db
      .prepare('SELECT unit_price, previous_close, deleted_at FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, 'st-f4')
      .first<{ unit_price: number; previous_close: number | null; deleted_at: string | null }>();
    expect(afterF9).toEqual({ unit_price: 210, previous_close: 205, deleted_at: null });
  });

  it('F2 & F3: TWSE MIS skips pre-market trial matching & delayed auctions (falls back to Yahoo), uses y on confirmed post-close zero-volume day, and ignores 0.0000 book levels', async () => {
    // F2: 08:45 pre-market trial matching -> MUST fall back to Yahoo (not speculative bid/ask 1095!)
    const fetchPreMarket: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [
              {
                z: '-',
                y: '1020.00',
                o: '-',
                v: '0',
                t: '08:45:00',
                ip: '0',
                b: '1090.0000_1085.0000_',
                a: '1100.0000_1105.0000_',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('finance.yahoo.com/v8/finance/chart/2330.TW')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { regularMarketPrice: 1020, previousClose: 1005 },
                  timestamp: [1764000000, 1764086400],
                  indicators: { quote: [{ close: [1005, 1020] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const qPre = await fetchStockQuote('2330', fetchPreMarket, { subCategory: '台股', currency: 'TWD' });
    expect(qPre).toEqual({ price: 1020, previousClose: 1005 });

    // F3: Post-close (13:30:00) zero-volume day (v='0', z='-', o='-') with resting quotes -> flat close y (1020, 1020)!
    const fetchZeroVolDay: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [
              {
                z: '-',
                y: '1020.00',
                o: '-',
                v: '0',
                t: '13:30:00',
                ip: '0',
                b: '1000.0000_',
                a: '1060.0000_',
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const qZero = await fetchStockQuote('2330', fetchZeroVolDay, { subCategory: '台股', currency: 'TWD' });
    expect(qZero).toEqual({ price: 1020, previousClose: 1020 });

    // 0.0000 book level skipped + tse|otc second entry picked
    const fetchBookZero: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [
              { z: '-', y: '-', b: '-', a: '-', o: '-' },
              { z: '-', y: '30.00', b: '0.0000_30.5000_', a: '31.5000_', v: '120', t: '10:30:00', ip: '0' },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const qBook = await fetchStockQuote('00679B', fetchBookZero, { subCategory: '台股', currency: 'TWD' });
    expect(qBook).toEqual({ price: 31, previousClose: 30 });
  });

  it('R5: /api/auth/passkey/register/verify returns sanitized 500 on unexpected DB errors instead of leaking raw SQL error as 400', async () => {
    const db = createTestD1();
    const app = createApp();
    const setupRes = await app.fetch(
      new Request('http://localhost/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupSecret: 'sec-r5',
          username: 'admin',
          displayName: 'Admin',
          password: 'password123',
        }),
      }),
      { DB: db, SETUP_SECRET: 'sec-r5' }
    );
    const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];

    // Wrap DB so auth_challenges lookup throws a simulated internal SQLite error
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('auth_challenges')) {
              throw new Error('SQLITE_IOERR_READ: internal disk failure detail');
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    const clientDataJSON = Buffer.from(JSON.stringify({ challenge: 'c-r5' })).toString('base64url');
    const res = await app.fetch(
      new Request('http://localhost/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ response: { response: { clientDataJSON } } }),
      }),
      { DB: failingDb }
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/SQLITE_IOERR/i);
  });
});
