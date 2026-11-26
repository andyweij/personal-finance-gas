import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  computeNetWorthSummary,
  computeStockPortfolioSummary,
  computeWatchlistSummary,
  isStockAsset,
  isWatchlistAsset,
} from '../shared/calculations';
import type { AssetItem } from '../shared/types';
import { fetchStockQuote, refreshMarketData, type FetchLike } from '../worker/market';
import { runMonthEndSnapshotD1 } from '../worker/automation';
import { exportFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

function makeAsset(overrides: Partial<AssetItem>): AssetItem {
  return {
    id: overrides.id || crypto.randomUUID(),
    updateMode: '自動更新',
    majorType: '資產',
    subCategory: '台股',
    liquidity: '高流動',
    itemName: '台積電',
    ticker: '2330',
    quantityOrAmount: 1000,
    currency: 'TWD',
    unitPrice: 1000,
    previousClose: null,
    costBasis: 800000,
    priceUpdatedAt: null,
    note: '',
    isWatchlist: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('Phase 1: Stock Watchlist, Previous Close Quotes & Daily Change', () => {
  it('parses previousClose from TWSE MIS, Yahoo Finance v8 (5d chart), and Stooq daily history', async () => {
    const mockFetch: FetchLike = async (url) => {
      if (url.includes('mis.twse.com.tw')) {
        return new Response(
          JSON.stringify({ msgArray: [{ z: '1050.00', y: '1020.00' }] }),
          { status: 200 }
        );
      }
      if (url.includes('finance.yahoo.com/v8/finance/chart/VOO')) {
        // Two daily bars: Nov 24 (540.5) and Nov 25 (548.25); regularMarketTime is Nov 25
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 548.25,
                    regularMarketTime: Math.floor(Date.UTC(2026, 10, 25, 21, 0, 0) / 1000),
                    gmtoffset: -18000,
                    chartPreviousClose: 520.0, // 5 days ago (should NOT be used as yesterday close)
                  },
                  timestamp: [
                    Math.floor(Date.UTC(2026, 10, 23, 14, 30, 0) / 1000),
                    Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000),
                    Math.floor(Date.UTC(2026, 10, 25, 14, 30, 0) / 1000),
                  ],
                  indicators: {
                    quote: [{ close: [535.0, 540.5, 548.25] }],
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('finance.yahoo.com/v8/finance/chart/NVDA')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('stooq.com/q/d/l/') && url.includes('nvda.us')) {
        return new Response(
          [
            'Date,Open,High,Low,Close,Volume',
            '2026-11-24,140.0,143.0,139.0,142.00,100000',
            '2026-11-25,142.5,146.0,141.0,145.50,120000',
          ].join('\n'),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const tw = await fetchStockQuote('2330', mockFetch, { subCategory: '台股', currency: 'TWD' });
    expect(tw).toEqual({ price: 1050, previousClose: 1020 });

    const voo = await fetchStockQuote('VOO', mockFetch, { subCategory: '美股/ETF', currency: 'USD' });
    expect(voo).toEqual({ price: 548.25, previousClose: 540.5 });

    const nvda = await fetchStockQuote('NVDA', mockFetch, { subCategory: '美股/ETF', currency: 'USD' });
    expect(nvda).toEqual({ price: 145.5, previousClose: 142 });
  });

  it('strictly excludes watchlist items from holdings portfolio, net worth, and month-end snapshots', async () => {
    const holding = makeAsset({
      id: 'h-2330',
      itemName: '台積電',
      ticker: '2330',
      quantityOrAmount: 1000,
      unitPrice: 1050,
      previousClose: 1000,
      costBasis: 900000,
      priceUpdatedAt: '2026-11-25T06:00:00.000Z',
    });
    const watch = makeAsset({
      id: 'w-nvda',
      itemName: '輝達',
      ticker: 'NVDA',
      subCategory: '美股/ETF',
      currency: 'USD',
      quantityOrAmount: 0,
      unitPrice: 145,
      previousClose: 150,
      costBasis: null,
      isWatchlist: true,
      priceUpdatedAt: '2026-11-25T06:05:00.000Z',
    });

    expect(isStockAsset(holding)).toBe(true);
    expect(isStockAsset(watch)).toBe(false);
    expect(isWatchlistAsset(watch)).toBe(true);
    expect(isWatchlistAsset(holding)).toBe(false);

    const portfolio = computeStockPortfolioSummary([holding, watch], [], 32);
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.totalMarketValueTwd).toBe(1050000);
    expect(portfolio.totalDailyPnlTwd).toBe(50000);
    expect(portfolio.totalDailyChangePct).toBe(5);
    expect(portfolio.latestPriceUpdatedAt).toBe('2026-11-25T06:00:00.000Z');
    expect(portfolio.positions[0].dailyChange).toBe(50);
    expect(portfolio.positions[0].dailyChangePct).toBe(5);

    const watchlist = computeWatchlistSummary([holding, watch]);
    expect(watchlist.items).toHaveLength(1);
    expect(watchlist.items[0].asset.id).toBe('w-nvda');
    expect(watchlist.items[0].dailyChange).toBe(-5);
    expect(watchlist.items[0].dailyChangePct).toBe(-3.33);
    expect(watchlist.latestPriceUpdatedAt).toBe('2026-11-25T06:05:00.000Z');

    const nw = computeNetWorthSummary([holding, watch], 32, 40000);
    expect(nw.totalAssets).toBe(1050000);
    expect(nw.stockValue).toBe(1050000);
  });

  it('refreshes both holdings and watchlist in D1, syncs previousClose, and converts watchlist to holding', async () => {
    const db = createTestD1();
    const userId = 'owner';

    // 1. Insert holding and watchlist via SyncEngine -> D1
    const localDb = new LocalFinanceDB(`test-phase1-${crypto.randomUUID()}`);
    const engine = new SyncEngine(localDb, {
      isOnline: () => true,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const res = await processSyncRequest(db, userId, body);
        return new Response(JSON.stringify(res), { status: 200 });
      }) as typeof fetch,
    });
    await engine.init();

    const wItem = await engine.saveAsset({
      itemName: '輝達',
      ticker: 'NVDA',
      subCategory: '美股/ETF',
      currency: 'USD',
      quantityOrAmount: 0,
      unitPrice: 0,
      isWatchlist: true,
      note: '等回測買入',
    });
    await engine.syncNow(true);

    // Verify watchlist does not affect month-end snapshot
    const snapBefore = await runMonthEndSnapshotD1(db, userId, new Date('2026-11-30T10:00:00Z'));
    expect(snapBefore.totalAssets).toBe(0);

    // 2. Refresh market data updates watchlist price & previous_close
    const mockFetch: FetchLike = async (url) => {
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32.0 } }), { status: 200 });
      }
      if (url.includes('finance.yahoo.com/v8/finance/chart/NVDA')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 150,
                    regularMarketTime: Math.floor(Date.UTC(2026, 10, 25, 21, 0, 0) / 1000),
                    gmtoffset: -18000,
                  },
                  timestamp: [
                    Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000),
                    Math.floor(Date.UTC(2026, 10, 25, 14, 30, 0) / 1000),
                  ],
                  indicators: { quote: [{ close: [145, 150] }] },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const refreshed = await refreshMarketData(db, mockFetch, userId);
    expect(refreshed.updatedTickers).toHaveLength(1);
    expect(refreshed.updatedTickers[0]).toMatchObject({
      id: wItem.id,
      ticker: 'NVDA',
      price: 150,
      previousClose: 145,
    });

    await engine.syncNow(true);
    const syncedWatch = engine.getSnapshot().assetItems.find((a) => a.id === wItem.id)!;
    expect(syncedWatch.isWatchlist).toBe(true);
    expect(syncedWatch.unitPrice).toBe(150);
    expect(syncedWatch.previousClose).toBe(145);
    expect(syncedWatch.priceUpdatedAt).toBeTruthy();

    // 3. Convert watchlist -> formal holding (preserves previousClose, flips isWatchlist = false)
    await engine.saveAsset({
      ...syncedWatch,
      id: syncedWatch.id,
      quantityOrAmount: 10,
      costBasis: 1400,
      isWatchlist: false,
    });
    await engine.syncNow(true);

    const serverSnap = await exportFullSnapshot(db, userId);
    const converted = serverSnap.assetItems.find((a) => a.id === wItem.id)!;
    expect(converted.isWatchlist).toBe(false);
    expect(converted.quantityOrAmount).toBe(10);
    expect(converted.previousClose).toBe(145);

    const snapAfter = await runMonthEndSnapshotD1(db, userId, new Date('2026-11-30T10:00:00Z'));
    expect(snapAfter.totalAssets).toBe(Math.round(10 * 150 * 32));
  });
});
