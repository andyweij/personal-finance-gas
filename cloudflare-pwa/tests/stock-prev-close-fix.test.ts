import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { resolveStockModalPriceFields } from '../shared/validation';
import { fetchStockQuote, refreshMarketData, type FetchLike } from '../worker/market';
import { processSyncRequest } from '../worker/sync';
import workerEntry from '../worker/index';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

describe('Stock previousClose & Live Price Consistency Fixes (v1.8.4)', () => {
  it('#1 TWSE MIS z="-" uses bid/ask midpoint -> single bid/ask -> open -> Yahoo fallback, never silently returns previousClose y as live price', async () => {
    // 1a. z === '-', both b and a present -> midpoint (1045 + 1055) / 2 = 1050
    const fetchBidAsk: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [
              {
                z: '-',
                y: '1020.0000',
                b: '1045.0000_1040.0000_1035.0000_',
                a: '1055.0000_1060.0000_1065.0000_',
                o: '1030.0000',
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const q1 = await fetchStockQuote('2330', fetchBidAsk, { subCategory: '台股', currency: 'TWD' });
    expect(q1).toEqual({ price: 1050, previousClose: 1020 });

    // 1b. z === '-', only b present (a is '-') -> best bid 1045
    const fetchBidOnly: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [{ z: '-', y: '1020.0000', b: '1045.0000_1040.0000_', a: '-', o: '1030.0000' }],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const q2 = await fetchStockQuote('2330', fetchBidOnly, { subCategory: '台股', currency: 'TWD' });
    expect(q2).toEqual({ price: 1045, previousClose: 1020 });

    // 1c. z === '-', no b/a, only open price o -> 1030
    const fetchOpenOnly: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [{ z: '-', y: '1020.0000', b: '-', a: '-', o: '1030.0000' }],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const q3 = await fetchStockQuote('2330', fetchOpenOnly, { subCategory: '台股', currency: 'TWD' });
    expect(q3).toEqual({ price: 1030, previousClose: 1020 });

    // 1d. z === '-', no b/a/o (only y) -> MUST fall back to Yahoo Finance instead of returning price = y!
    const seenUrls: string[] = [];
    const fetchFallbackYahoo: FetchLike = async (url) => {
      seenUrls.push(url);
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({
            msgArray: [{ z: '-', y: '1020.0000', b: '-', a: '-', o: '-' }],
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
                  meta: {
                    regularMarketPrice: 1055,
                    regularMarketTime: Math.floor(Date.UTC(2026, 10, 25, 5, 30, 0) / 1000),
                    gmtoffset: 28800,
                  },
                  timestamp: [
                    Math.floor(Date.UTC(2026, 10, 24, 1, 0, 0) / 1000),
                    Math.floor(Date.UTC(2026, 10, 25, 1, 0, 0) / 1000),
                  ],
                  indicators: { quote: [{ close: [1020, 1055] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };
    const q4 = await fetchStockQuote('2330', fetchFallbackYahoo, { subCategory: '台股', currency: 'TWD' });
    expect(q4).toEqual({ price: 1055, previousClose: 1020 });
    expect(seenUrls.some((u) => u.includes('finance.yahoo.com/v8/finance/chart/2330.TW'))).toBe(true);
  });

  it('#2 06:00 TW (0 22 * * *) cron updates ONLY US stocks & FX without touching TW stocks; 23:00 TW updates TW stocks', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // Seed active owner user so scheduled all-user refresh includes this user
    await db
      .prepare(
        `INSERT INTO users
          (id, username, display_name, role, password_hash, password_salt, pin_enabled, show_utility_tab, is_active, created_at, updated_at)
         VALUES (?, 'owner', 'Owner', 'admin', 'h', 's', 0, 1, 1, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`
      )
      .bind(uid)
      .run();

    // Seed both a TW stock (2330) and a US stock (NVDA)
    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, price_updated_at, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, '自動更新', '資產', '台股', '高流動', '台積電', '2330', 1000, 'TWD', 1050, 1020, '2026-11-25T15:00:00.000Z', '', '2026-11-25T00:00:00.000Z', '2026-11-25T15:00:00.000Z', NULL, 1)`
      )
      .bind(uid, 'tw-2330')
      .run();
    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, price_updated_at, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, '自動更新', '資產', '美股/ETF', '高流動', '輝達', 'NVDA', 10, 'USD', 140, 138, '2026-11-25T15:00:00.000Z', '', '2026-11-25T00:00:00.000Z', '2026-11-25T15:00:00.000Z', NULL, 1)`
      )
      .bind(uid, 'us-nvda')
      .run();

    const fetchedUrls: string[] = [];
    const mockFetch: FetchLike = async (url) => {
      fetchedUrls.push(url);
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32.1 } }), { status: 200 });
      }
      if (url.includes('finance.yahoo.com/v8/finance/chart/NVDA')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 148,
                    regularMarketTime: Math.floor(Date.UTC(2026, 10, 25, 21, 0, 0) / 1000),
                    gmtoffset: -18000,
                  },
                  timestamp: [
                    Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000),
                    Math.floor(Date.UTC(2026, 10, 25, 14, 30, 0) / 1000),
                  ],
                  indicators: { quote: [{ close: [140, 148] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('mis.twse.com.tw')) {
        return new Response(JSON.stringify({ msgArray: [{ z: '1065.00', y: '1050.00' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      // 06:00 TW (22:00 UTC): US + FX only!
      await workerEntry.scheduled(
        {
          cron: '0 22 * * *',
          scheduledTime: Date.UTC(2026, 10, 25, 22, 0, 0),
          noRetry() {},
        } as ScheduledController,
        { DB: db }
      );

      expect(fetchedUrls.some((u) => u.includes('mis.twse.com.tw'))).toBe(false);
      expect(fetchedUrls.some((u) => u.includes('2330'))).toBe(false);
      const twRowAfter6am = await db
        .prepare('SELECT unit_price, previous_close FROM asset_items WHERE user_id = ? AND id = ?')
        .bind(uid, 'tw-2330')
        .first<{ unit_price: number; previous_close: number }>();
      const usRowAfter6am = await db
        .prepare('SELECT unit_price, previous_close FROM asset_items WHERE user_id = ? AND id = ?')
        .bind(uid, 'us-nvda')
        .first<{ unit_price: number; previous_close: number }>();
      expect(twRowAfter6am).toEqual({ unit_price: 1050, previous_close: 1020 });
      expect(usRowAfter6am).toEqual({ unit_price: 148, previous_close: 140 });

      // 23:00 TW (15:00 UTC): TW + US both refreshed!
      await workerEntry.scheduled(
        {
          cron: '0 15 * * *',
          scheduledTime: Date.UTC(2026, 10, 26, 15, 0, 0),
          noRetry() {},
        } as ScheduledController,
        { DB: db }
      );
      const twRowAfter11pm = await db
        .prepare('SELECT unit_price, previous_close FROM asset_items WHERE user_id = ? AND id = ?')
        .bind(uid, 'tw-2330')
        .first<{ unit_price: number; previous_close: number }>();
      expect(twRowAfter11pm).toEqual({ unit_price: 1065, previous_close: 1050 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('#3 when quote returns previousClose: null, refreshMarketData clears stale previous_close to NULL instead of retaining old value', async () => {
    const db = createTestD1();
    const uid = 'owner';

    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, price_updated_at, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, '自動更新', '資產', '美股/ETF', '高流動', '輝達', 'NVDA', 10, 'USD', 105, 100, '2026-11-20T00:00:00.000Z', '', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', NULL, 1)`
      )
      .bind(uid, 'us-nvda-stale')
      .run();

    // Yahoo fails -> Stooq daily history fails -> Stooq /q/l/ returns { price: 120, previousClose: null }
    const mockFetch: FetchLike = async (url) => {
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32.0 } }), { status: 200 });
      }
      if (url.includes('stooq.com/q/l/')) {
        return new Response(
          'Symbol,Date,Time,Open,High,Low,Close,Volume\nNVDA.US,2026-11-26,22:00:00,118,121,117,120,500000',
          { status: 200 }
        );
      }
      return new Response('unavailable', { status: 503 });
    };

    const res = await refreshMarketData(db, mockFetch, uid);
    expect(res.updatedTickers).toHaveLength(1);
    expect(res.updatedTickers[0].price).toBe(120);

    const row = await db
      .prepare('SELECT unit_price, previous_close FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, 'us-nvda-stale')
      .first<{ unit_price: number; previous_close: number | null }>();
    expect(row?.unit_price).toBe(120);
    expect(row?.previous_close).toBeNull();
  });

  it('#4 Yahoo range=5d does NOT use week-old chartPreviousClose as yesterday close; falls back to range=1d or null', async () => {
    // Case A: range=5d returns 1 bar + week-old chartPreviousClose (480); range=1d returns real previousClose (515)
    const seenUrlsA: string[] = [];
    const fetchWith1d: FetchLike = async (url) => {
      seenUrlsA.push(url);
      if (url.includes('range=5d')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 520,
                    regularMarketTime: Math.floor(Date.UTC(2026, 10, 25, 21, 0, 0) / 1000),
                    gmtoffset: -18000,
                    chartPreviousClose: 480, // ~1 week ago, MUST NOT be used!
                  },
                  timestamp: [Math.floor(Date.UTC(2026, 10, 25, 14, 30, 0) / 1000)],
                  indicators: { quote: [{ close: [520] }] },
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
              result: [
                {
                  meta: {
                    regularMarketPrice: 520,
                    previousClose: 515,
                    chartPreviousClose: 515,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const qA = await fetchStockQuote('VOO', fetchWith1d, { subCategory: '美股/ETF', currency: 'USD' });
    expect(qA).toEqual({ price: 520, previousClose: 515 });
    expect(seenUrlsA.some((u) => u.includes('range=1d'))).toBe(true);

    // Case B: range=5d returns 1 bar + week-old chartPreviousClose (480), range=1d fails -> previousClose MUST be null (never 480!)
    const fetch1dFail: FetchLike = async (url) => {
      if (url.includes('range=5d')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 520,
                    regularMarketTime: Math.floor(Date.UTC(2026, 10, 25, 21, 0, 0) / 1000),
                    gmtoffset: -18000,
                    chartPreviousClose: 480,
                  },
                  timestamp: [Math.floor(Date.UTC(2026, 10, 25, 14, 30, 0) / 1000)],
                  indicators: { quote: [{ close: [520] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const qB = await fetchStockQuote('VOO', fetch1dFail, { subCategory: '美股/ETF', currency: 'USD' });
    expect(qB).toEqual({ price: 520, previousClose: null });
  });

  it('#5 & #6 server preserves auto-updated quotes on non-manual upsert, and client clears previousClose when price is manually edited', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // #6 Server has v3 auto-updated stock at (120, 118)
    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, cost_basis, price_updated_at, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, '自動更新', '資產', '台股', '高流動', '台積電', '2330', 1000, 'TWD', 120, 118, 90000, '2026-11-26T00:00:00.000Z', '', '2026-11-20T00:00:00.000Z', '2026-11-26T00:00:00.000Z', NULL, 3)`
      )
      .bind(uid, 'stock-2330')
      .run();

    // Client sends baseVersion: 3 editing costBasis, carrying stale (100, 99) WITHOUT manualPriceOverride
    const res1 = await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-edit-cost-only',
          entity: 'asset',
          op: 'upsert',
          recordId: 'stock-2330',
          clientTimestamp: '2026-11-26T01:00:00.000Z',
          baseVersion: 3,
          isNewRecord: false,
          payload: {
            updateMode: '自動更新',
            majorType: '資產',
            subCategory: '台股',
            liquidity: '高流動',
            itemName: '台積電',
            ticker: '2330',
            quantityOrAmount: 1000,
            currency: 'TWD',
            unitPrice: 100,
            previousClose: 99,
            costBasis: 95000,
            note: '修正期初成本',
          },
        },
      ],
    });
    expect(res1.ackedMutationIds).toContain('m-edit-cost-only');

    const rowAfterCostEdit = await db
      .prepare('SELECT unit_price, previous_close, cost_basis, version FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, 'stock-2330')
      .first<{ unit_price: number; previous_close: number | null; cost_basis: number; version: number }>();
    expect(rowAfterCostEdit).toEqual({
      unit_price: 120,
      previous_close: 118,
      cost_basis: 95000,
      version: 4,
    });

    // When client explicitly passes manualPriceOverride: true (e.g., user edited stPrice to 125 and cleared prevClose), server accepts!
    const res2 = await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-manual-price',
          entity: 'asset',
          op: 'upsert',
          recordId: 'stock-2330',
          clientTimestamp: '2026-11-26T02:00:00.000Z',
          baseVersion: 4,
          isNewRecord: false,
          payload: {
            updateMode: '自動更新',
            majorType: '資產',
            subCategory: '台股',
            liquidity: '高流動',
            itemName: '台積電',
            ticker: '2330',
            quantityOrAmount: 1000,
            currency: 'TWD',
            unitPrice: 125,
            previousClose: null,
            costBasis: 95000,
            manualPriceOverride: true,
          },
        },
      ],
    });
    expect(res2.ackedMutationIds).toContain('m-manual-price');
    const rowAfterManual = await db
      .prepare('SELECT unit_price, previous_close, version FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, 'stock-2330')
      .first<{ unit_price: number; previous_close: number | null; version: number }>();
    expect(rowAfterManual).toEqual({ unit_price: 125, previous_close: null, version: 5 });

    // #5 Client SyncEngine.saveAsset: when saving existing stock with changed unitPrice & no explicit previousClose, clears previousClose to null;
    // when saving WITHOUT unitPrice/previousClose, omits them from outbox mutation payload so server live quotes are untouched.
    const localDb = new LocalFinanceDB(`stock-fix-c5-${crypto.randomUUID()}`);
    const engine = new SyncEngine(localDb, {
      isOnline: () => false,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    const created = await engine.saveAsset({
      itemName: '台積電',
      majorType: '資產',
      updateMode: '自動更新',
      subCategory: '台股',
      liquidity: '高流動',
      quantityOrAmount: 1000,
      currency: 'TWD',
      ticker: '2330',
      unitPrice: 1000,
      previousClose: 980,
      costBasis: 800000,
    });
    await localDb.acknowledgeOutboxAndSave(
      (await localDb.getOutbox()).map((m) => m.mutationId),
      engine.getSnapshot(),
      { lastSyncedAt: '2026-11-26T00:00:00.000Z', pinEnabled: false, pinSalt: null, pinHash: null }
    );

    // Edit cost only (omitting unitPrice & previousClose) -> outbox payload MUST NOT send unitPrice/previousClose
    await engine.saveAsset({
      id: created.id,
      itemName: '台積電',
      majorType: '資產',
      updateMode: '自動更新',
      subCategory: '台股',
      liquidity: '高流動',
      quantityOrAmount: 1000,
      currency: 'TWD',
      ticker: '2330',
      costBasis: 810000,
    });
    const outboxCostOnly = await localDb.getOutbox();
    expect(outboxCostOnly).toHaveLength(1);
    expect(outboxCostOnly[0].payload?.unitPrice).toBeUndefined();
    expect(outboxCostOnly[0].payload?.previousClose).toBeUndefined();
    expect(outboxCostOnly[0].payload?.manualPriceOverride).toBeUndefined();

    // Manually change unitPrice without changing previousClose -> previousClose cleared to null + manualPriceOverride: true
    const updatedManual = await engine.saveAsset({
      id: created.id,
      itemName: '台積電',
      majorType: '資產',
      updateMode: '自動更新',
      subCategory: '台股',
      liquidity: '高流動',
      quantityOrAmount: 1000,
      currency: 'TWD',
      ticker: '2330',
      unitPrice: 1050,
      costBasis: 810000,
      manualPriceOverride: true,
    });
    expect(updatedManual.unitPrice).toBe(1050);
    expect(updatedManual.previousClose).toBeNull();
    const outboxManual = await localDb.getOutbox();
    expect(outboxManual[0].payload?.unitPrice).toBe(1050);
    expect(outboxManual[0].payload?.previousClose).toBeNull();
    expect(outboxManual[0].payload?.manualPriceOverride).toBe(true);

    localDb.close();
  });

  it('#5 UI helper resolveStockModalPriceFields omits unchanged prices, clears stale previousClose on manual price edit, and preserves explicit previousClose edits', () => {
    const existing = { unitPrice: 100, previousClose: 98 };

    // Unchanged price & prevClose (user only edited cost/shares/note) -> omit both so server live quotes are preserved
    expect(
      resolveStockModalPriceFields({
        existing,
        rawPrice: '100',
        rawPrevClose: '98',
        hasPrevCloseInput: true,
      })
    ).toEqual({});

    // User manually changed market price (100 -> 115) without touching prevClose (left at 98) -> clear prevClose to null!
    expect(
      resolveStockModalPriceFields({
        existing,
        rawPrice: '115',
        rawPrevClose: '98',
        hasPrevCloseInput: true,
      })
    ).toEqual({
      unitPrice: 115,
      previousClose: null,
      manualPriceOverride: true,
    });

    // User explicitly updated BOTH market price (115) and prevClose (110) -> keep both with manualPriceOverride: true
    expect(
      resolveStockModalPriceFields({
        existing,
        rawPrice: '115',
        rawPrevClose: '110',
        hasPrevCloseInput: true,
      })
    ).toEqual({
      unitPrice: 115,
      previousClose: 110,
      manualPriceOverride: true,
    });

    // User explicitly cleared prevClose only -> update previousClose: null with manualPriceOverride: true (and omit unchanged unitPrice per F4)
    expect(
      resolveStockModalPriceFields({
        existing,
        rawPrice: '100',
        rawPrevClose: '',
        hasPrevCloseInput: true,
      })
    ).toEqual({
      previousClose: null,
      manualPriceOverride: true,
    });
  });
});
