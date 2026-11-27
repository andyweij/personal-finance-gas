import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { computeStockPortfolioSummary } from '../shared/calculations';
import { STOCK_TX_TYPES } from '../shared/constants';
import {
  computeDividendCalendar,
  computeNetWorthTrendSeries,
  computeRebalancePlan,
} from '../shared/analytics';
import {
  normalizeRebalanceTargets,
  validateRebalanceTargetsForSave,
} from '../shared/validation';
import type {
  AssetItem,
  NetWorthHistory,
  RebalanceTargetRule,
  StockTransaction,
  SyncRequest,
} from '../shared/types';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createCountingD1, createTestD1 } from './helpers/mockD1';

function createD1FetchAdapter(db: D1Database, userId: string): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body || '{}')) as SyncRequest;
    const res = await processSyncRequest(db, userId, reqBody);
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function seedUser(db: D1Database, userId: string): Promise<void> {
  const now = '2026-01-01T00:00:00.000Z';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, password_salt, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'hash', 'salt', ?, ?)`
    )
    .bind(userId, userId, userId, now, now)
    .run();
}

function makeHistory(ym: string, partial: Partial<NetWorthHistory> = {}): NetWorthHistory {
  const totalAssets = partial.totalAssets ?? 1_000_000;
  const totalLiabilities = partial.totalLiabilities ?? 200_000;
  return {
    yearMonth: ym,
    snapshotDate: `${ym}-28`,
    totalAssets,
    totalLiabilities,
    netWorth: partial.netWorth ?? totalAssets - totalLiabilities,
    highLiquidityAssets: partial.highLiquidityAssets ?? 300_000,
    investmentAssets: partial.investmentAssets ?? 500_000,
    insuranceAssets: partial.insuranceAssets ?? 150_000,
    monthlyIncome: partial.monthlyIncome ?? 90_000,
    monthlyConsumption: partial.monthlyConsumption ?? 40_000,
    savingsRate: partial.savingsRate ?? 0.55,
    note: '',
    updatedAt: `${ym}-28T15:00:00.000Z`,
    ...partial,
  };
}

function makeStockAsset(overrides: Partial<AssetItem> & { id: string; itemName: string }): AssetItem {
  return {
    updateMode: '自動更新',
    majorType: '資產',
    subCategory: '台股',
    liquidity: '中流動',
    ticker: '0050',
    quantityOrAmount: 1000,
    currency: 'TWD',
    unitPrice: 100,
    costBasis: 80_000,
    stockCategory: 'ETF',
    isWatchlist: false,
    note: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function makeStockTx(overrides: Partial<StockTransaction> & { id: string; assetId: string }): StockTransaction {
  return {
    date: '2026-07-15',
    txType: STOCK_TX_TYPES.CASH_DIVIDEND,
    shares: 0,
    totalAmount: 1000,
    fee: 0,
    note: '',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('Phase 2 (v1.10.0) — Analytics, Dividend Calendar & Rebalance', () => {
  describe('1. Net Worth Trend Series', () => {
    it('handles empty, single-point, and negative net worth safely without NaN/Infinity', () => {
      const empty = computeNetWorthTrendSeries([], '12m');
      expect(empty.points).toEqual([]);
      expect(empty.deltaAmount).toBe(0);
      expect(empty.deltaPct).toBeNull();

      const single = computeNetWorthTrendSeries([makeHistory('2026-11', { netWorth: 500_000 })], '12m');
      expect(single.points).toHaveLength(1);
      expect(single.deltaAmount).toBe(0);
      expect(single.deltaPct).toBeNull();

      const negativeStart = computeNetWorthTrendSeries(
        [
          makeHistory('2026-01', { totalAssets: 200_000, totalLiabilities: 500_000, netWorth: -300_000 }),
          makeHistory('2026-02', { totalAssets: 400_000, totalLiabilities: 450_000, netWorth: -50_000 }),
        ],
        '12m'
      );
      expect(negativeStart.deltaAmount).toBe(250_000);
      expect(negativeStart.deltaPct).toBeNull(); // start <= 0 → no misleading percentage
      expect(negativeStart.minNetWorth).toBe(-300_000);
      expect(negativeStart.maxNetWorth).toBe(-50_000);
    });

    it('sorts chronologically, slices 12m vs all, and computes otherAssets + growth accurately', () => {
      const raw: NetWorthHistory[] = [];
      for (let i = 0; i < 15; i++) {
        const y = 2025 + Math.floor(i / 12);
        const m = (i % 12) + 1;
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        raw.push(
          makeHistory(ym, {
            totalAssets: 1_000_000 + i * 50_000,
            totalLiabilities: 200_000,
            netWorth: 800_000 + i * 50_000,
            highLiquidityAssets: 300_000,
            investmentAssets: 500_000 + i * 40_000,
            insuranceAssets: 100_000,
          })
        );
      }
      // Shuffle input order (descending)
      const reversed = raw.slice().reverse();

      const last12 = computeNetWorthTrendSeries(reversed, '12m');
      expect(last12.points).toHaveLength(12);
      expect(last12.points[0].yearMonth).toBe('2025-04');
      expect(last12.points[11].yearMonth).toBe('2026-03');
      expect(last12.deltaAmount).toBe(11 * 50_000);
      expect(last12.deltaPct).toBeCloseTo(((11 * 50_000) / 950_000) * 100, 1);
      // otherAssets = totalAssets - (highLiquidity + investment + insurance)
      expect(last12.points[0].otherAssets).toBe(1_150_000 - (300_000 + 620_000 + 100_000));

      const all = computeNetWorthTrendSeries(reversed, 'all');
      expect(all.points).toHaveLength(15);
      expect(all.points[0].yearMonth).toBe('2025-01');
      expect(all.deltaAmount).toBe(14 * 50_000);
      expect(all.deltaPct).toBe(87.5);
    });
  });

  describe('2. Stock Dividend Calendar', () => {
    const assets: AssetItem[] = [
      makeStockAsset({ id: 'a-0050', itemName: '元大台灣50', ticker: '0050', currency: 'TWD' }),
      makeStockAsset({ id: 'a-voo', itemName: 'VOO', ticker: 'VOO', subCategory: '美股/ETF', currency: 'USD' }),
      makeStockAsset({ id: 'a-watch', itemName: '觀察股', ticker: '2330', isWatchlist: true }),
      makeStockAsset({ id: 'a-del', itemName: '已刪股', ticker: '0056', deletedAt: '2026-05-01T00:00:00.000Z' }),
    ];

    const txs: StockTransaction[] = [
      makeStockTx({ id: 't1', assetId: 'a-0050', date: '2026-01-20', totalAmount: 6000 }),
      makeStockTx({ id: 't2', assetId: 'a-voo', date: '2026-01-25', totalAmount: 100 }), // 100 * 32 = 3200
      makeStockTx({ id: 't3', assetId: 'a-0050', date: '2026-07-18', totalAmount: 14800 }),
      makeStockTx({ id: 't4-prev-yr', assetId: 'a-0050', date: '2025-07-18', totalAmount: 9000 }),
      // Must be excluded:
      makeStockTx({ id: 't5-buy', assetId: 'a-0050', date: '2026-03-01', txType: STOCK_TX_TYPES.BUY, shares: 100, totalAmount: 15000 }),
      makeStockTx({ id: 't6-stockdiv', assetId: 'a-0050', date: '2026-08-01', txType: STOCK_TX_TYPES.STOCK_DIVIDEND, shares: 10, totalAmount: 0 }),
      makeStockTx({ id: 't7-deleted', assetId: 'a-0050', date: '2026-02-01', totalAmount: 5000, deletedAt: '2026-02-02T00:00:00.000Z' }),
      makeStockTx({ id: 't8-watch', assetId: 'a-watch', date: '2026-04-01', totalAmount: 4000 }),
      makeStockTx({ id: 't9-del-asset', assetId: 'a-del', date: '2026-06-01', totalAmount: 3000 }),
    ];

    it('aggregates TWD + USD cash dividends by month, excludes non-cash/deleted/watchlist, and computes coverage safely', () => {
      const cal = computeDividendCalendar(assets, txs, 32, 2026, 40_000);
      expect(cal.year).toBe(2026);
      expect(cal.availableYears).toEqual([2026, 2025]);
      expect(cal.months).toHaveLength(12);
      expect(cal.months[0].totalTwd).toBe(9200); // Jan: 6000 + 3200
      expect(cal.months[0].count).toBe(2);
      expect(cal.months[6].totalTwd).toBe(14800); // Jul
      expect(cal.annualTotalTwd).toBe(24_000);
      expect(cal.monthlyAverageTwd).toBe(2000);
      expect(cal.peakMonth).toBe(7);
      expect(cal.maxMonthTwd).toBe(14800);
      expect(cal.expenseCoveragePct).toBe(5); // 2000 / 40000 = 5.0%
      expect(cal.txCount).toBe(3);

      // Zero monthly consumption -> null coverage (no divide by zero)
      const calNoCons = computeDividendCalendar(assets, txs, 32, 2026, 0);
      expect(calNoCons.expenseCoveragePct).toBeNull();
    });
  });

  describe('3. Portfolio Rebalance Calculator & Target Validation', () => {
    const assets: AssetItem[] = [
      makeStockAsset({ id: 'a-etf', itemName: '0050', ticker: '0050', quantityOrAmount: 1000, unitPrice: 600, stockCategory: 'ETF' }), // 600,000 (60%)
      makeStockAsset({ id: 'a-stock', itemName: '2330', ticker: '2330', quantityOrAmount: 300, unitPrice: 1000, stockCategory: '個股' }), // 300,000 (30%)
      makeStockAsset({ id: 'a-bond', itemName: '00679B', ticker: '00679B', quantityOrAmount: 2500, unitPrice: 40, stockCategory: '債券ETF' }), // 100,000 (10%)
    ];
    const portfolio = computeStockPortfolioSummary(assets, [], 32);

    const catRules: RebalanceTargetRule[] = [
      { id: 'r1', kind: 'category', key: 'ETF', label: 'ETF', targetPct: 40 },
      { id: 'r2', kind: 'category', key: '個股', label: '個股', targetPct: 30 },
      { id: 'r3', kind: 'category', key: '債券ETF', label: '債券ETF', targetPct: 30 },
    ];

    it('validates rebalance target rules and rejects sum != 100%', () => {
      expect(validateRebalanceTargetsForSave(catRules)).toHaveLength(3);
      expect(validateRebalanceTargetsForSave([])).toEqual([]);
      expect(() =>
        validateRebalanceTargetsForSave([
          { id: 'r1', kind: 'category', key: 'ETF', label: 'ETF', targetPct: 60 },
          { id: 'r2', kind: 'category', key: '個股', label: '個股', targetPct: 30 },
        ])
      ).toThrow(/100%/);
      // Normalization ignores malformed entries and caps at 30 rules
      expect(normalizeRebalanceTargets('not-json')).toEqual([]);
    });

    it('computes exact buy/sell actions in full mode with zero rounding drift', () => {
      const plan = computeRebalancePlan(portfolio, catRules, 'category', 0, 'full');
      expect(plan.isValidTargets).toBe(true);
      expect(plan.currentTotalTwd).toBe(1_000_000);
      expect(plan.projectedTotalTwd).toBe(1_000_000);
      expect(plan.totalBuyTwd).toBe(200_000);
      expect(plan.totalSellTwd).toBe(200_000);
      const etfRow = plan.rows.find((r) => r.key === 'ETF')!;
      const bondRow = plan.rows.find((r) => r.key === '債券ETF')!;
      expect(etfRow.actionTwd).toBe(-200_000);
      expect(bondRow.actionTwd).toBe(200_000);
    });

    it('distributes new capital in buy_only mode via water-fill without selling overweight holdings', () => {
      // Current: ETF 600k (target 40%), 個股 300k (target 30%), 債券 100k (target 30%)
      // Add 100,000 TWD in buy_only mode:
      // ETF is heavily overweight (600k / 0.4 = 1.5M implied total), 個股 (300k / 0.3 = 1M), 債券 (100k / 0.3 = 333k)
      // All 100,000 must go to 債券ETF (still below 300k), ZERO sells!
      const plan1 = computeRebalancePlan(portfolio, catRules, 'category', 100_000, 'buy_only');
      expect(plan1.totalSellTwd).toBe(0);
      expect(plan1.totalBuyTwd).toBe(100_000);
      expect(plan1.rows.every((r) => r.actionTwd >= 0)).toBe(true);
      expect(plan1.rows.find((r) => r.key === '債券ETF')!.actionTwd).toBe(100_000);
      expect(plan1.rows.find((r) => r.key === 'ETF')!.actionTwd).toBe(0);

      // Odd contribution (NT$ 100,001 across 3 equal targets on empty portfolio): exact integer sum = 100,001
      const emptyPortfolio = computeStockPortfolioSummary([], [], 32);
      const equalRules: RebalanceTargetRule[] = [
        { id: 'e1', kind: 'category', key: 'A', label: 'A', targetPct: 33.34 },
        { id: 'e2', kind: 'category', key: 'B', label: 'B', targetPct: 33.33 },
        { id: 'e3', kind: 'category', key: 'C', label: 'C', targetPct: 33.33 },
      ];
      const planEmpty = computeRebalancePlan(emptyPortfolio, equalRules, 'category', 100_001, 'buy_only');
      expect(planEmpty.totalBuyTwd).toBe(100_001);
      expect(planEmpty.rows.reduce((s, r) => s + r.actionTwd, 0)).toBe(100_001);
    });
  });

  describe('4. Sync, Optimistic Locking, JSON Backup & D1 Query Budget', () => {
    it('syncs rebalanceTargets with D1, detects conflicts, preserves across backup/restore, and adds 0 D1 queries', async () => {
      const rawD1 = createTestD1();
      await seedUser(rawD1, 'u-reb');
      const counting = createCountingD1(rawD1);

      const db1 = new LocalFinanceDB(`reb-1-${crypto.randomUUID()}`);
      const eng1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(counting.db, 'u-reb'),
        isOnline: () => true,
      });
      await eng1.init();
      counting.reset();
      await eng1.syncNow(true);
      const initialPullQueries = counting.count();
      expect(initialPullQueries).toBeLessThanOrEqual(20);

      const rules: RebalanceTargetRule[] = [
        { id: 'c1', kind: 'category', key: 'ETF', label: 'ETF', targetPct: 70 },
        { id: 'c2', kind: 'category', key: '個股', label: '個股', targetPct: 30 },
      ];
      await eng1.saveRebalanceTargets(rules);
      counting.reset();
      const pushRes = await eng1.syncNow();
      expect(pushRes.ok).toBe(true);
      expect(counting.count()).toBeLessThanOrEqual(10);

      // Device 2 pulls the synced rebalance targets
      const db2 = new LocalFinanceDB(`reb-2-${crypto.randomUUID()}`);
      const eng2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(rawD1, 'u-reb'),
        isOnline: () => true,
      });
      await eng2.init();
      await eng2.syncNow(true);
      expect(eng2.getSnapshot().settings.rebalanceTargets).toEqual(rules);

      // Concurrent edit from Device 1 and Device 2 triggers optimistic lock conflict
      await eng1.saveRebalanceTargets([
        { id: 'c1', kind: 'category', key: 'ETF', label: 'ETF', targetPct: 80 },
        { id: 'c2', kind: 'category', key: '個股', label: '個股', targetPct: 20 },
      ]);
      await eng1.syncNow();

      await eng2.saveRebalanceTargets([
        { id: 'c1', kind: 'category', key: 'ETF', label: 'ETF', targetPct: 60 },
        { id: 'c2', kind: 'category', key: '個股', label: '個股', targetPct: 40 },
      ]);
      await eng2.syncNow();
      expect(eng2.getConflicts().length).toBeGreaterThanOrEqual(1);

      // Export & replace restore preserves rebalanceTargets
      const exported = await exportFullSnapshot(rawD1, 'u-reb');
      expect(exported.settings.rebalanceTargets).toHaveLength(2);
      expect(exported.settings.rebalanceTargets?.[0].targetPct).toBe(80);

      await importFullSnapshot(rawD1, 'u-reb', exported, 'replace');
      const afterRestore = await exportFullSnapshot(rawD1, 'u-reb');
      expect(afterRestore.settings.rebalanceTargets?.[0].targetPct).toBe(80);

      // Legacy backup without rebalanceTargets imports cleanly without crashing
      const legacyPayload = {
        ...exported,
        settings: {
          ...exported.settings,
          rebalanceTargets: undefined,
        },
      };
      await importFullSnapshot(rawD1, 'u-reb', legacyPayload, 'replace');
      const afterLegacy = await exportFullSnapshot(rawD1, 'u-reb');
      expect(Array.isArray(afterLegacy.settings.rebalanceTargets)).toBe(true);
    });
  });
});
