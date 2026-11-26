/**
 * 驗收測試：尚未修正的審查項目（對應 docs/reviews/2026-11-26_v1.8.6_review.md「尚未完成清單」）
 *
 * 使用方式（交接給修正模型）：
 * - 每個 `it.fails(...)` 代表「目前仍存在的 bug」。bug 存在時斷言失敗 → vitest 視為通過，整套測試維持綠燈。
 * - 修好某一項之後，該測試會變成「意外通過」而讓 vitest 報紅 → 請把該項的 `it.fails` 改成 `it`，作為該項的驗收。
 * - 交付時：所有宣稱已修的項目，都必須已從 `it.fails` 改為 `it` 且通過。不得刪除或弱化斷言；
 *   若認為斷言不合理，請在回報中說明理由，而不是修改斷言。
 * - 測試名稱前綴即為審查文件中的編號（Q1、N1…），方便逐項回報。
 * - 標示「回歸保護」的測試以一般 `it` 撰寫、目前已通過：修正其他項目時不得讓它們變紅。
 *   （R6 僅涵蓋「欄位驗證型」拒絕；「依伺服器狀態」拒絕的情境無法穩定重現，仍請依審查文件處理。）
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncMutation, SyncRequest, SyncResponse } from '../shared/types';
import workerEntry from '../worker/index';
import type { FetchLike } from '../worker/market';
import { refreshMarketData } from '../worker/market';
import { importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

/* ============================== helpers ============================== */

const UID = 'owner';

const cfPayload = (name: string) => ({
  date: '2026-11-26',
  type: '日常花費',
  category: '餐飲',
  itemName: name,
  amount: 100,
  currency: 'TWD',
});

/** 把 SyncEngine 的 fetch 直接接到 processSyncRequest（模擬真實伺服器）。 */
function d1Fetch(db: D1Database, transform?: (req: SyncRequest, res: SyncResponse) => SyncResponse): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
    let res = await processSyncRequest(db, UID, body);
    if (transform) res = transform(body, res);
    return new Response(JSON.stringify(res), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function newEngine(localDb: LocalFinanceDB, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new SyncEngine(localDb, {
    fetchImpl,
    isOnline: () => true,
    retryBaseDelayMs: 60_000,
    requestLock: async (_name, fn) => fn(),
    ...extra,
  });
}

/** 對 D1 的 prepare 加掛 hook，用來在特定 SQL 前後插入「另一個請求」的動作。 */
function hookDb(
  db: D1Database,
  hook: (sql: string, phase: 'before' | 'after', method: string) => Promise<unknown | undefined> | unknown
): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql) as unknown as Record<string, unknown>;
          const wrap = (s: Record<string, unknown>): unknown =>
            new Proxy(s, {
              get(t, p) {
                const orig = t[p as string] as unknown;
                if (p === '__sql') return sql;
                if (p === 'bind') {
                  return (...args: unknown[]) =>
                    wrap((orig as (...a: unknown[]) => Record<string, unknown>).apply(t, args));
                }
                if (p === 'first' || p === 'all' || p === 'run') {
                  return async (...args: unknown[]) => {
                    const override = await hook(sql, 'before', String(p));
                    if (override !== undefined) return override === '__NULL__' ? null : override;
                    const r = await (orig as (...a: unknown[]) => Promise<unknown>).apply(t, args);
                    await hook(sql, 'after', String(p));
                    return r;
                  };
                }
                return typeof orig === 'function' ? (orig as (...a: unknown[]) => unknown).bind(t) : orig;
              },
            });
          return wrap(stmt);
        };
      }
      if (prop === 'batch') {
        // v1.8.13 (H5): reads are now batched — let hooks see each batched statement as method 'batch'
        return async (stmts: Array<{ __sql?: string }>) => {
          for (const st of stmts) await hook(String(st.__sql || ''), 'before', 'batch');
          const r = await target.batch(stmts as unknown as D1PreparedStatement[]);
          for (const st of stmts) await hook(String(st.__sql || ''), 'after', 'batch');
          return r;
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function serverAsset(db: D1Database, id: string) {
  return db
    .prepare('SELECT * FROM asset_items WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(UID, id)
    .first<Record<string, unknown>>();
}

const manualAsset = (note: string, quantity = 1000) => ({
  updateMode: '手動快照',
  majorType: '資產',
  subCategory: '其他資產',
  liquidity: '中流動',
  itemName: '驗收用資產',
  quantityOrAmount: quantity,
  currency: 'TWD',
  unitPrice: 1,
  note,
});

const autoUsStock = (extra: Record<string, unknown> = {}) => ({
  updateMode: '自動更新',
  majorType: '資產',
  subCategory: '美股/ETF',
  liquidity: '高流動',
  itemName: '輝達',
  ticker: 'NVDA',
  quantityOrAmount: 10,
  currency: 'USD',
  unitPrice: 148,
  ...extra,
});

/* ============================== 伺服器端 ============================== */

describe('驗收：伺服器端尚未修正項目', () => {
  it('N2: 完整重抓（epoch 不符）期間其他裝置的寫入，不得同時從 snapshot 與下一次增量中消失', async () => {
    const db = createTestD1();
    await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    await importFullSnapshot(db, UID, { cashflowLogs: [] }, 'replace'); // epoch -> 2

    let fired = false;
    const hooked = hookDb(db, async (sql, phase, method) => {
      // 在完整 snapshot 讀取途中，另一台裝置寫入一筆資料
      if (
        phase === 'after' &&
        (method === 'all' || method === 'batch') &&
        !fired &&
        /FROM rent_utility_records WHERE user_id = \? AND deleted_at IS NULL/.test(sql)
      ) {
        fired = true;
        await processSyncRequest(db, UID, {
          sinceSeq: 0,
          clientEpoch: 2,
          mutations: [
            {
              mutationId: 'other-device',
              entity: 'cashflow',
              op: 'upsert',
              recordId: 'cf-other',
              clientTimestamp: '2026-11-26T00:00:00.000Z',
              baseVersion: null,
              payload: cfPayload('other'),
            },
          ],
        });
      }
      return undefined;
    });

    const res = await processSyncRequest(hooked, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    expect(fired).toBe(true);
    const inSnapshot = res.delta.cashflowLogs.some((c) => c.id === 'cf-other');
    const next = await processSyncRequest(db, UID, {
      sinceSeq: res.syncCursor,
      clientEpoch: res.dataEpoch,
      mutations: [],
    });
    const inNextDelta = next.delta.cashflowLogs.some((c) => c.id === 'cf-other');
    expect(inSnapshot || inNextDelta).toBe(true);
  });

  it('N4: 請求途中發生 replace 匯入時，舊 epoch 的 mutation 不得寫入還原後的資料，也不得被 ack', async () => {
    const db = createTestD1();
    await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });

    let fired = false;
    const hooked = hookDb(db, async (sql, phase, method) => {
      if (phase === 'before' && (method === 'first' || method === 'batch') && !fired && /SELECT mutation_id FROM sync_idempotency/.test(sql)) {
        fired = true;
        await importFullSnapshot(db, UID, { cashflowLogs: [] }, 'replace'); // 另一台裝置完成還原
      }
      return undefined;
    });

    const res = await processSyncRequest(hooked, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'stale',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-stale',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: cfPayload('stale-old-epoch'),
        },
      ],
    });
    expect(fired).toBe(true);

    const row = await db
      .prepare('SELECT id FROM cashflow_logs WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(UID, 'cf-stale')
      .first();
    expect(row).toBeNull();
    expect(res.ackedMutationIds).not.toContain('stale');
  });

  it('F7: 報價更新後，離線裝置只改成本（未帶報價欄位）不得產生版本衝突，且不得覆蓋新報價', async () => {
    const db = createTestD1();
    // 1. 建立自動更新的美股持股（version 1）
    const create = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'create-nvda',
          entity: 'asset',
          op: 'upsert',
          recordId: 'nvda',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          isNewRecord: true,
          payload: autoUsStock(),
        } as SyncMutation,
      ],
    });
    expect(create.ackedMutationIds).toContain('create-nvda');

    // 2. 排程更新報價（148 -> 160）
    const quoteFetch: FetchLike = async (url) => {
      if (url.includes('finance.yahoo.com/v8/finance/chart/NVDA')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { regularMarketPrice: 160, previousClose: 150 },
                  timestamp: [1764000000, 1764086400],
                  indicators: { quote: [{ close: [150, 160] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32 } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    await refreshMarketData(db, quoteFetch, UID);
    const afterQuote = await serverAsset(db, 'nvda');
    expect(Number(afterQuote?.unit_price)).toBe(160);

    // 3. 尚未拉到新報價的離線裝置，以 baseVersion 1 只改成本
    const offlineEdit = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'edit-cost',
          entity: 'asset',
          op: 'upsert',
          recordId: 'nvda',
          clientTimestamp: '2026-11-26T01:00:00.000Z',
          baseVersion: 1,
          isNewRecord: false,
          payload: (() => {
            const p: Record<string, unknown> = { ...autoUsStock(), costBasis: 1400 };
            delete p.unitPrice;
            return p;
          })(),
        } as SyncMutation,
      ],
    });
    expect(offlineEdit.conflicts || []).toHaveLength(0);
    expect(offlineEdit.ackedMutationIds).toContain('edit-cost');
    const final = await serverAsset(db, 'nvda');
    expect(Number(final?.unit_price)).toBe(160);
    expect(Number(final?.cost_basis)).toBe(1400);
  });

  it('F8: 台北 23:00（UTC 15:00）的排程落在美股盤中，不得以盤中價覆寫美股報價（月底淨值快照也在這次執行）', async () => {
    const db = createTestD1();
    await db
      .prepare(
        `INSERT INTO users
          (id, username, display_name, role, password_hash, password_salt, pin_enabled, show_utility_tab, is_active, created_at, updated_at)
         VALUES (?, 'owner', 'Owner', 'admin', 'h', 's', 0, 1, 1, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`
      )
      .bind(UID)
      .run();
    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, price_updated_at, note, created_at, updated_at, deleted_at, version)
         VALUES (?, 'us-nvda', '自動更新', '資產', '美股/ETF', '高流動', '輝達', 'NVDA', 10, 'USD', 148, 140, '2026-11-25T22:00:00.000Z', '', '2026-11-25T00:00:00.000Z', '2026-11-25T22:00:00.000Z', NULL, 1)`
      )
      .bind(UID)
      .run();

    const mockFetch: FetchLike = async (url) => {
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32.1 } }), { status: 200 });
      }
      if (url.includes('finance.yahoo.com/v8/finance/chart/NVDA')) {
        // 美股盤中價
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { regularMarketPrice: 133, previousClose: 148 },
                  timestamp: [1764086400, 1764172800],
                  indicators: { quote: [{ close: [148, 133] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('mis.twse.com.tw')) {
        return new Response(JSON.stringify({ msgArray: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      await workerEntry.scheduled(
        { cron: '0 15 * * *', scheduledTime: Date.UTC(2026, 10, 26, 15, 0, 0), noRetry() {} } as ScheduledController,
        { DB: db } as never
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    const row = await serverAsset(db, 'us-nvda');
    // 修正方式一（建議）：23:00 只更新台股 → 美股維持 06:00 的收盤價 148。
    // 若改採「月底快照移到 06:00 之後」的方案，請在回報中說明並同步調整本測試。
    expect(Number(row?.unit_price)).toBe(148);
  });
});

/* ============================== 客戶端 ============================== */

describe('驗收：客戶端尚未修正項目', () => {
  it('Q1: 伺服器整體故障（與內容無關的持續 500）不得把正常 mutation 隔離出 outbox', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`q1-${crypto.randomUUID()}`);
    let serverDown = true;
    const realFetch = d1Fetch(db);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (serverDown) {
        return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 });
      }
      return realFetch(input, init);
    };
    const engine = newEngine(localDb, fetchImpl, { maxPoisonRetries: 3 });
    await engine.init();

    await engine.addCashFlow(cfPayload('正常紀錄一'));
    await engine.addCashFlow(cfPayload('正常紀錄二'));

    // 伺服器故障期間使用者多次觸發同步（超過 maxPoisonRetries）
    for (let i = 0; i < 8; i++) {
      await engine.syncNow();
    }

    // 伺服器恢復
    serverDown = false;
    await engine.syncNow();
    await engine.syncNow();

    expect(engine.getRejections()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(0);
    const rows = await db
      .prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL')
      .bind(UID)
      .all<{ item_name: string }>();
    const names = (rows.results || []).map((r) => r.item_name);
    expect(names).toEqual(expect.arrayContaining(['正常紀錄一', '正常紀錄二']));

    engine.destroy();
    localDb.close();
  });

  it('N1: 送出失敗（已標記 sentAt）後重新載入，再編輯同一筆，不得產生與自己的假衝突', async () => {
    const db = createTestD1();
    const dbName = `n1-${crypto.randomUUID()}`;

    // 第一個 session：建立資產，同步時網路失敗（mutation 已被標記為送出過）
    const local1 = new LocalFinanceDB(dbName);
    const offlineFetch: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const engine1 = newEngine(local1, offlineFetch);
    await engine1.init();
    const created = await engine1.saveAsset(manualAsset('v0'));
    await engine1.syncNow();
    const outboxAfterFail = await local1.getOutbox();
    expect(outboxAfterFail.length).toBeGreaterThan(0);
    engine1.destroy();
    local1.close();

    // 重新載入：新的 session，網路恢復，先再編輯同一筆再同步
    const local2 = new LocalFinanceDB(dbName);
    const engine2 = newEngine(local2, d1Fetch(db));
    await engine2.init();
    await engine2.saveAsset({ ...manualAsset('v1-edited'), id: created.id });
    await engine2.syncNow();
    await engine2.syncNow();

    expect(engine2.getConflicts()).toHaveLength(0);
    expect(await local2.getOutbox()).toHaveLength(0);
    const row = await serverAsset(db, created.id);
    expect(row?.note).toBe('v1-edited');

    engine2.destroy();
    local2.close();
  });

  it('R6（回歸保護，目前已通過）: 編輯被拒時，同一筆已排隊的後續編輯不得把被拒的值寫進伺服器，且本機最終須與伺服器一致', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`r6-${crypto.randomUUID()}`);
    let engineRef: SyncEngine | null = null;
    let assetId = '';
    let queuedSecondEdit = false;

    // 模擬伺服器業務規則：數量 999 一律拒絕
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      const isBad = (m: SyncMutation) =>
        m.entity === 'asset' && Number((m.payload as Record<string, unknown> | undefined)?.quantityOrAmount) === 999;
      const bad = body.mutations.filter(isBad);
      const good = body.mutations.filter((m) => !isBad(m));

      // E1（被拒的那筆）送出途中，使用者又改了同一筆的備註（E2）
      if (bad.length > 0 && !queuedSecondEdit && engineRef) {
        queuedSecondEdit = true;
        await engineRef.saveAsset({ ...manualAsset('E2-note', 999), id: assetId });
      }

      const res = await processSyncRequest(db, UID, { ...body, mutations: good });
      res.rejected = [
        ...(res.rejected || []),
        ...bad.map((m) => ({ mutationId: m.mutationId, reason: '數量不可為 999' })),
      ];
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;

    const engine = newEngine(localDb, fetchImpl);
    engineRef = engine;
    await engine.init();
    const created = await engine.saveAsset(manualAsset('original', 1000));
    assetId = created.id;
    await engine.syncNow();
    expect(Number((await serverAsset(db, assetId))?.quantity_or_amount)).toBe(1000);

    // E1：數量改成 999（伺服器會拒絕）
    await engine.saveAsset({ ...manualAsset('original', 999), id: assetId });
    for (let i = 0; i < 4; i++) {
      await engine.syncNow();
    }
    expect(queuedSecondEdit).toBe(true);

    const server = await serverAsset(db, assetId);
    expect(Number(server?.quantity_or_amount)).not.toBe(999);
    const local = engine.getSnapshot().assetItems.find((a) => a.id === assetId);
    expect(local?.quantityOrAmount).toBe(Number(server?.quantity_or_amount));

    engine.destroy();
    localDb.close();
  });

  it('N3: 「重新套用」凍結的舊編輯，不得覆蓋凍結之後才做、且已同步的較新編輯', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`n3-${crypto.randomUUID()}`);
    const engine = newEngine(localDb, d1Fetch(db));
    await engine.init();

    const created = await engine.saveAsset(manualAsset('v0'));
    await engine.syncNow();

    // 離線時的舊編輯（尚未送出）
    await engine.saveAsset({ ...manualAsset('offline-old'), id: created.id });

    // 另一台裝置以目前伺服器資料做 replace 還原（epoch -> 2），該筆資產仍存在
    const full = await processSyncRequest(db, UID, { since: null, mutations: [] });
    await importFullSnapshot(db, UID, { assetItems: full.delta.assetItems }, 'replace');

    // 同步 → epoch 不符 → 舊編輯被凍結
    await engine.syncNow();
    expect(engine.getFrozenOutbox().length).toBeGreaterThan(0);

    // 使用者在凍結後做了較新的編輯並同步成功
    await engine.saveAsset({ ...manualAsset('newer'), id: created.id });
    await engine.syncNow();
    expect((await serverAsset(db, created.id))?.note).toBe('newer');

    // 使用者按下「重新套用」
    await engine.reapplyFrozenOutbox();
    await engine.syncNow();

    expect((await serverAsset(db, created.id))?.note).toBe('newer');
    expect(engine.getSnapshot().assetItems.find((a) => a.id === created.id)?.note).toBe('newer');

    engine.destroy();
    localDb.close();
  });

  it('F1 邊界（回歸保護，目前已通過）: 重新套用凍結的持股編輯（payload 不含報價）而本機已無該資產時，價格不得變成 undefined / NaN', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`f1-${crypto.randomUUID()}`);
    const engine = newEngine(localDb, d1Fetch(db));
    await engine.init();

    const created = await engine.saveAsset(autoUsStock());
    await engine.syncNow();

    // 離線只改成本（自動更新資產，payload 會省略 unitPrice / previousClose）
    await engine.saveAsset({ ...autoUsStock({ costBasis: 1400 }), id: created.id, unitPrice: undefined });

    // 另一台裝置 replace 還原，該資產不在還原資料中
    await importFullSnapshot(db, UID, { assetItems: [] }, 'replace');
    await engine.syncNow();
    expect(engine.getFrozenOutbox().length).toBeGreaterThan(0);

    await engine.reapplyFrozenOutbox();
    const local = engine.getSnapshot().assetItems.find((a) => a.id === created.id);
    expect(local).toBeDefined();
    expect(Number.isFinite(local!.unitPrice)).toBe(true);

    engine.destroy();
    localDb.close();
  });

  it('Q8: 清空自動更新持股的代號時，不得把既有價格歸零（只有「換成另一個非空代號」才可清空價格）', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`q8-${crypto.randomUUID()}`);
    const engine = newEngine(localDb, d1Fetch(db));
    await engine.init();

    const created = await engine.saveAsset(autoUsStock());
    expect(created.unitPrice).toBe(148);

    // UI（stocksTab）清空代號時會沿用既有 updateMode，且未改價格時不帶 unitPrice
    const edited = await engine.saveAsset({
      ...autoUsStock(),
      id: created.id,
      ticker: '',
      unitPrice: undefined,
    });
    expect(edited.unitPrice).toBe(148);

    engine.destroy();
    localDb.close();
  });
});

/* ===================== v1.8.7 審查新增（docs/reviews/2026-11-26_v1.8.7_review.md） ===================== */

describe('驗收：v1.8.7 審查新增項目', () => {
  it('V1: 只有寫入路徑故障（帶 mutation 的請求 503、純拉取正常）時，不得把正常 mutation 當成毒丸隔離', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v1-${crypto.randomUUID()}`);
    let writesDown = true;
    const realFetch = d1Fetch(db);
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      // 寫入路徑故障：任何寫入請求（帶 mutation，或 v1.8.9 起的 writeProbe 寫入健康檢查）都回 503，純讀取正常
      if (writesDown && (body.mutations.length > 0 || (body as SyncRequest & { writeProbe?: boolean }).writeProbe)) {
        return new Response(JSON.stringify({ error: 'D1 write unavailable' }), { status: 503 });
      }
      return realFetch(input, init);
    };
    const engine = newEngine(localDb, fetchImpl, { maxPoisonRetries: 3 });
    await engine.init();
    for (let i = 0; i < 5; i++) {
      await engine.addCashFlow(cfPayload(`正常紀錄${i}`));
    }

    for (let i = 0; i < 12; i++) {
      await engine.syncNow();
    }
    writesDown = false;
    for (let i = 0; i < 3; i++) {
      await engine.syncNow();
    }

    expect(engine.getRejections()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(0);
    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL')
      .bind(UID)
      .first<{ n: number }>();
    expect(Number(rows?.n)).toBe(5);

    engine.destroy();
    localDb.close();
  });

  it('V2: 同一筆紀錄被延後時，後面依賴它的 mutation 不得插隊（刪除帳本並搬移紀錄不得被拒）', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v2-${crypto.randomUUID()}`);
    let online = true;
    const realFetch = d1Fetch(db);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!online) throw new TypeError('Failed to fetch');
      return realFetch(input, init);
    };
    const engine = newEngine(localDb, fetchImpl);
    await engine.init();

    const ledger = await engine.saveLedger({ name: '旅遊帳本' });
    await engine.syncNow();

    // 在新帳本新增一筆紀錄，送出時網路失敗（該筆已標記為送出過）
    online = false;
    await engine.addCashFlow({ ...cfPayload('旅遊餐費'), ledgerId: ledger.id });
    await engine.syncNow();

    // 網路恢復前，使用者刪除帳本並把紀錄搬到預設帳本
    await engine.deleteLedger(ledger.id, { migrateToLedgerId: 'default' });
    online = true;
    for (let i = 0; i < 4; i++) {
      await engine.syncNow();
    }

    expect(engine.getRejections()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(0);
    const ledgerRow = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(UID, ledger.id)
      .first();
    expect(ledgerRow).toBeNull();

    engine.destroy();
    localDb.close();
  });

  it('V3: 「重新套用」時因有較新編輯而被略過的凍結項目，必須保留給使用者檢視（不得靜默丟棄）', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v3-${crypto.randomUUID()}`);
    const engine = newEngine(localDb, d1Fetch(db));
    await engine.init();

    const created = await engine.saveAsset(manualAsset('v0'));
    await engine.syncNow();
    await engine.saveAsset({ ...manualAsset('offline-old'), id: created.id });

    const full = await processSyncRequest(db, UID, { since: null, mutations: [] });
    await importFullSnapshot(db, UID, { assetItems: full.delta.assetItems }, 'replace');
    await engine.syncNow();
    expect(engine.getFrozenOutbox().length).toBeGreaterThan(0);

    await engine.saveAsset({ ...manualAsset('newer'), id: created.id });
    await engine.syncNow();
    await engine.reapplyFrozenOutbox();

    // 被略過的 'offline-old' 編輯必須仍可取得（建議以 rejection / 狀態 'skipped_newer' 保存 clientPayload）
    const kept = engine
      .getRejections()
      .some((r) => r.recordId === created.id && (r.clientPayload as Record<string, unknown> | undefined)?.note === 'offline-old');
    expect(kept).toBe(true);

    engine.destroy();
    localDb.close();
  });

  it('V4: 請求途中 replace 後，舊 epoch 的 mutation 不得依還原後的資料被「拒絕」（應凍結，而非顯示錯誤並丟棄）', async () => {
    const db = createTestD1();
    // 舊 epoch：帳本 L2 與其中一筆紀錄
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'mk-ledger',
          entity: 'ledger',
          op: 'upsert',
          recordId: 'L2',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          isNewRecord: true,
          payload: { name: '旅遊帳本' },
        } as SyncMutation,
        {
          mutationId: 'mk-cf',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-l2',
          clientTimestamp: '2026-11-26T00:00:01.000Z',
          baseVersion: null,
          payload: { ...cfPayload('旅遊餐費'), ledgerId: 'L2' },
        },
      ],
    });
    const backup = await processSyncRequest(db, UID, { since: null, mutations: [] }); // 含 L2 與 cf-l2 的備份
    // 舊 epoch 中刪掉那筆紀錄 → L2 變成空帳本，可以刪除
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'rm-cf',
          entity: 'cashflow',
          op: 'delete',
          recordId: 'cf-l2',
          clientTimestamp: '2026-11-26T00:00:02.000Z',
          baseVersion: 1,
        },
      ],
    });

    let fired = false;
    const hooked = hookDb(db, async (sql, phase, method) => {
      if (phase === 'before' && (method === 'first' || method === 'batch') && !fired && /SELECT mutation_id FROM sync_idempotency/.test(sql)) {
        fired = true;
        // 另一台裝置用備份還原（L2 仍有關聯紀錄）
        await importFullSnapshot(
          db,
          UID,
          { ledgers: backup.delta.ledgers, cashflowLogs: backup.delta.cashflowLogs },
          'replace'
        );
      }
      return undefined;
    });

    const res = await processSyncRequest(hooked, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: 'stale-del-ledger',
          entity: 'ledger',
          op: 'delete',
          recordId: 'L2',
          clientTimestamp: '2026-11-26T00:00:03.000Z',
          baseVersion: 1,
        },
      ],
    });
    expect(fired).toBe(true);
    expect(res.epochMismatch).toBe(true);
    expect(res.rejected.map((r) => r.mutationId)).not.toContain('stale-del-ledger');
    expect(res.ackedMutationIds).not.toContain('stale-del-ledger');
  });
});
