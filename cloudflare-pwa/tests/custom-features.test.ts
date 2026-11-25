import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregatePeriodMetrics,
  applySubsetReorder,
  compareBySortOrder,
  computeAllSavingsSummary,
  computeOverviewBreakdownGroups,
  computeSinkingMonthlyReserve,
  computeStockPortfolioSummary,
} from '../shared/calculations';
import { CASHFLOW_TYPES } from '../shared/constants';
import {
  normalizeCustomStockCategories,
  normalizePnlColorScheme,
  normalizeStockCategory,
} from '../shared/validation';
import type { AssetItem, CashFlowLog, SinkingFundItem, SyncRequest } from '../shared/types';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import {
  buildStockChartItems,
  computePieArcs,
  computeTreemapRects,
} from '../web/src/ui/stockCharts';
import { computeDropTargetIndex } from '../web/src/ui/reorderHelper';
import { DB_SCHEMA_VERSION, SW_CACHE_VERSION, VERSION_HIGHLIGHTS } from '../web/src/version';
import { createTestD1 } from './helpers/mockD1';

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

describe('Custom PnL Color Scheme, Manual Sort Order & Stock Allocation Charts', () => {
  describe('1. Customizable Positive/Negative Color Scheme', () => {
    it('normalizes valid schemes and falls back to intl for unknown values', () => {
      expect(normalizePnlColorScheme('intl')).toBe('intl');
      expect(normalizePnlColorScheme('tw')).toBe('tw');
      expect(normalizePnlColorScheme('tw_stocks')).toBe('tw_stocks');
      expect(normalizePnlColorScheme('invalid')).toBe('intl');
      expect(normalizePnlColorScheme(null)).toBe('intl');
    });

    it('syncs pnlColorScheme per-user with D1 and preserves it through JSON backup/restore', async () => {
      const d1 = createTestD1();
      const dbA = new LocalFinanceDB(`pnl-a-${crypto.randomUUID()}`);
      const engineA = new SyncEngine(dbA, {
        fetchImpl: createD1FetchAdapter(d1, 'user-a'),
        isOnline: () => true,
      });
      await engineA.init();
      await engineA.syncNow(true);

      expect(engineA.getSnapshot().settings.pnlColorScheme).toBe('intl');

      await engineA.savePnlColorScheme('tw');
      expect(engineA.getSnapshot().settings.pnlColorScheme).toBe('tw');
      const syncRes = await engineA.syncNow();
      expect(syncRes.ok).toBe(true);

      // Fresh device for user-a receives 'tw'
      const dbA2 = new LocalFinanceDB(`pnl-a2-${crypto.randomUUID()}`);
      const engineA2 = new SyncEngine(dbA2, {
        fetchImpl: createD1FetchAdapter(d1, 'user-a'),
        isOnline: () => true,
      });
      await engineA2.init();
      await engineA2.syncNow(true);
      expect(engineA2.getSnapshot().settings.pnlColorScheme).toBe('tw');

      // User B remains isolated with default 'intl'
      const dbB = new LocalFinanceDB(`pnl-b-${crypto.randomUUID()}`);
      const engineB = new SyncEngine(dbB, {
        fetchImpl: createD1FetchAdapter(d1, 'user-b'),
        isOnline: () => true,
      });
      await engineB.init();
      await engineB.syncNow(true);
      expect(engineB.getSnapshot().settings.pnlColorScheme).toBe('intl');

      // Export & restore into a new user preserves 'tw_stocks'
      await engineA2.savePnlColorScheme('tw_stocks');
      await engineA2.syncNow();
      const exported = await exportFullSnapshot(d1, 'user-a');
      expect(exported.settings.pnlColorScheme).toBe('tw_stocks');

      await importFullSnapshot(d1, 'user-c', exported, 'replace');
      const exportedC = await exportFullSnapshot(d1, 'user-c');
      expect(exportedC.settings.pnlColorScheme).toBe('tw_stocks');
    });
  });

  describe('2. Manual Sort Order Persistence & Subset Reordering', () => {
    it('reorders a filtered subset while preserving relative slots of non-visible items', () => {
      const items = [
        { id: 'inc-1', type: 'income', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'fix-1', type: 'fixed', sortOrder: 2, createdAt: '2026-01-02T00:00:00Z' },
        { id: 'inv-1', type: 'invest', sortOrder: 3, createdAt: '2026-01-03T00:00:00Z' },
        { id: 'fix-2', type: 'fixed', sortOrder: 4, createdAt: '2026-01-04T00:00:00Z' },
        { id: 'fix-3', type: 'fixed', sortOrder: 5, createdAt: '2026-01-05T00:00:00Z' },
      ];

      // Reorder only the 'fixed' subset from [fix-1, fix-2, fix-3] -> [fix-3, fix-1, fix-2]
      const { nextItems, changedItems } = applySubsetReorder(items, ['fix-3', 'fix-1', 'fix-2']);

      expect(nextItems.map((i) => i.id)).toEqual(['inc-1', 'fix-3', 'inv-1', 'fix-1', 'fix-2']);
      expect(nextItems.map((i) => i.sortOrder)).toEqual([1, 2, 3, 4, 5]);
      // inc-1 (1) and inv-1 (3) did NOT change sortOrder, so only 3 mutations needed!
      expect(changedItems.map((i) => i.id).sort()).toEqual(['fix-1', 'fix-2', 'fix-3']);
    });

    it('falls back deterministically to createdAt when legacy items share sortOrder = 0', () => {
      const items = [
        { id: 'b', sortOrder: 0, createdAt: '2026-02-01T00:00:00Z' },
        { id: 'a', sortOrder: 0, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'c', sortOrder: 0, createdAt: '2026-03-01T00:00:00Z' },
      ];
      expect(items.slice().sort(compareBySortOrder).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('persists manual sort order for stocks, savings, recurring, and sinking items across D1 sync', async () => {
      const d1 = createTestD1();
      const db1 = new LocalFinanceDB(`sort-1-${crypto.randomUUID()}`);
      const engine1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(d1, 'owner'),
        isOnline: () => true,
      });
      await engine1.init();
      await engine1.syncNow(true);

      // Create 3 stocks and 2 savings accounts
      const s1 = await engine1.saveAsset({
        itemName: '0050',
        majorType: '資產',
        updateMode: '自動更新',
        subCategory: '台股',
        ticker: 'TPE:0050',
        quantityOrAmount: 1000,
        unitPrice: 180,
        currency: 'TWD',
      });
      const sv1 = await engine1.saveAsset({
        itemName: '中信活存',
        majorType: '資產',
        subCategory: '活存',
        quantityOrAmount: 100000,
        currency: 'TWD',
        isLinkedSavings: true,
      });
      const s2 = await engine1.saveAsset({
        itemName: '台積電',
        majorType: '資產',
        updateMode: '自動更新',
        subCategory: '台股',
        ticker: 'TPE:2330',
        quantityOrAmount: 500,
        unitPrice: 1000,
        currency: 'TWD',
      });
      const s3 = await engine1.saveAsset({
        itemName: 'VOO',
        majorType: '資產',
        updateMode: '自動更新',
        subCategory: '美股/ETF',
        ticker: 'VOO',
        quantityOrAmount: 10,
        unitPrice: 500,
        currency: 'USD',
      });
      const sv2 = await engine1.saveAsset({
        itemName: 'Richart',
        majorType: '資產',
        subCategory: '活存',
        quantityOrAmount: 50000,
        currency: 'TWD',
        isLinkedSavings: true,
      });

      // Create 3 recurring items and 2 sinking items
      const r1 = await engine1.saveRecurring({
        itemName: '房貸',
        type: CASHFLOW_TYPES.FIXED_EXPENSE,
        category: '房貸',
        amount: 30000,
        currency: 'TWD',
      });
      const r2 = await engine1.saveRecurring({
        itemName: '車貸',
        type: CASHFLOW_TYPES.FIXED_EXPENSE,
        category: '車貸',
        amount: 12000,
        currency: 'TWD',
      });
      const r3 = await engine1.saveRecurring({
        itemName: 'Netflix',
        type: CASHFLOW_TYPES.SUBSCRIPTION,
        category: '影音訂閱',
        amount: 390,
        currency: 'TWD',
      });

      const sf1 = await engine1.saveSinking({
        itemName: '所得稅',
        category: '所得稅',
        totalAmount: 60000,
        months: 12,
      });
      const sf2 = await engine1.saveSinking({
        itemName: '保費',
        category: '保費',
        totalAmount: 36000,
        months: 12,
      });

      expect((await engine1.syncNow()).ok).toBe(true);

      // Reorder stocks to [VOO, 0050, 台積電], savings to [Richart, 中信活存], recurring fixed to [車貸, 房貸], sinking to [保費, 所得稅]
      const changedStocks = await engine1.reorderAssets([s3.id, s1.id, s2.id]);
      expect(changedStocks).toBe(3);

      const changedSavings = await engine1.reorderAssets([sv2.id, sv1.id]);
      expect(changedSavings).toBe(2);

      const changedRec = await engine1.reorderRecurring([r2.id, r1.id]);
      expect(changedRec).toBe(2);

      const changedSink = await engine1.reorderSinking([sf2.id, sf1.id]);
      expect(changedSink).toBe(2);

      // Sync reorders to D1 (must succeed with zero version conflicts!)
      const syncAfterReorder = await engine1.syncNow();
      expect(syncAfterReorder.ok).toBe(true);
      expect(engine1.getConflicts()).toHaveLength(0);

      // Verify on a fresh device pulling from D1
      const db2 = new LocalFinanceDB(`sort-2-${crypto.randomUUID()}`);
      const engine2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(d1, 'owner'),
        isOnline: () => true,
      });
      await engine2.init();
      await engine2.syncNow(true);

      const snap2 = engine2.getSnapshot();
      const portfolio2 = computeStockPortfolioSummary(snap2.assetItems, [], 32.5);
      expect(portfolio2.positions.map((p) => p.asset.itemName)).toEqual(['VOO', '0050', '台積電']);

      const savings2 = computeAllSavingsSummary(snap2.assetItems, [], [], 32.5);
      expect(savings2.accounts.map((a) => a.account.itemName)).toEqual(['Richart', '中信活存']);

      expect(snap2.recurringItems.map((r) => r.itemName)).toEqual(['車貸', '房貸', 'Netflix']);
      expect(snap2.sinkingItems.map((s) => s.itemName)).toEqual(['保費', '所得稅']);
    });
  });

  describe('3. Stock Percentage Charts Math (Donut, Pie, Bar, Treemap)', () => {
    const sampleAssets: AssetItem[] = [
      {
        id: 'st-1',
        updateMode: '自動更新',
        majorType: '資產',
        subCategory: '台股',
        liquidity: '高流動',
        itemName: '0050',
        ticker: 'TPE:0050',
        quantityOrAmount: 1000,
        currency: 'TWD',
        unitPrice: 200, // 200,000 TWD
        costBasis: 150000,
        note: '',
        sortOrder: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'st-2',
        updateMode: '自動更新',
        majorType: '資產',
        subCategory: '台股',
        liquidity: '高流動',
        itemName: '台積電',
        ticker: 'TPE:2330',
        quantityOrAmount: 500,
        currency: 'TWD',
        unitPrice: 1000, // 500,000 TWD
        costBasis: 400000,
        note: '',
        sortOrder: 2,
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 'st-3',
        updateMode: '自動更新',
        majorType: '資產',
        subCategory: '美股/ETF',
        liquidity: '高流動',
        itemName: 'VOO',
        ticker: 'VOO',
        quantityOrAmount: 20,
        currency: 'USD',
        unitPrice: 500, // 10,000 USD * 30 = 300,000 TWD
        costBasis: null, // No cost basis set
        note: '',
        sortOrder: 3,
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
    ];

    it('builds accurate chart slices across value, cost, and market dimensions', () => {
      const portfolio = computeStockPortfolioSummary(sampleAssets, [], 30);

      // Value dimension: total = 1,000,000 TWD -> 台積電 50%, VOO 30%, 0050 20%
      const byVal = buildStockChartItems(portfolio, 'value');
      expect(byVal.map((i) => ({ label: i.label, pct: i.pct }))).toEqual([
        { label: '台積電', pct: 50 },
        { label: 'VOO', pct: 30 },
        { label: '0050', pct: 20 },
      ]);

      // Cost dimension: excludes VOO (costBasis null), total cost = 550,000 -> 台積電 72.7%, 0050 27.3%
      const byCost = buildStockChartItems(portfolio, 'cost');
      expect(byCost).toHaveLength(2);
      expect(byCost[0].label).toBe('台積電');
      expect(byCost[0].pct).toBeCloseTo(72.7, 1);
      expect(byCost[1].label).toBe('0050');
      expect(byCost[1].pct).toBeCloseTo(27.3, 1);

      // Market dimension: 台股 70%, 美股/ETF 30%
      const byMarket = buildStockChartItems(portfolio, 'market');
      expect(byMarket.map((i) => ({ label: i.label, pct: i.pct }))).toEqual([
        { label: '台股', pct: 70 },
        { label: '美股 / ETF', pct: 30 },
      ]);
    });

    it('handles single-stock 100% pie arc without SVG degeneracy and sums multi-slice arcs to 360°', () => {
      const singlePortfolio = computeStockPortfolioSummary([sampleAssets[0]], [], 30);
      const singleArcs = computePieArcs(buildStockChartItems(singlePortfolio, 'value'));
      expect(singleArcs).toHaveLength(1);
      expect(singleArcs[0].isFullCircle).toBe(true);
      expect(singleArcs[0].sweepAngle).toBe(360);

      const multiPortfolio = computeStockPortfolioSummary(sampleAssets, [], 30);
      const multiArcs = computePieArcs(buildStockChartItems(multiPortfolio, 'value'));
      expect(multiArcs).toHaveLength(3);
      expect(multiArcs[0].startAngle).toBe(0);
      expect(multiArcs[multiArcs.length - 1].endAngle).toBeCloseTo(360, 5);
      expect(multiArcs.every((a) => !a.isFullCircle)).toBe(true);
    });

    it('computes non-overlapping treemap rectangles conserving total area', () => {
      const portfolio = computeStockPortfolioSummary(sampleAssets, [], 30);
      const items = buildStockChartItems(portfolio, 'value');
      const W = 320;
      const H = 186;
      const rects = computeTreemapRects(items, W, H);

      expect(rects).toHaveLength(3);
      const totalArea = rects.reduce((s, r) => s + r.w * r.h, 0);
      expect(totalArea).toBeCloseTo(W * H, 2);

      // Verify exact proportional areas and bounds
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(W + 0.01);
        expect(r.y + r.h).toBeLessThanOrEqual(H + 0.01);
        const areaPct = ((r.w * r.h) / (W * H)) * 100;
        expect(areaPct).toBeCloseTo(r.item.pct, 0);
      }
    });
  });

  describe('4. Universal Expandable Overview Breakdown (Option A)', () => {
    it('groups cashflow logs and sinking items into universal groups with dynamic category children', () => {
      const mkLog = (
        id: string,
        ym: string,
        type: CashFlowLog['type'],
        category: string,
        twdAmount: number
      ): CashFlowLog => ({
        id,
        date: `${ym}-05`,
        yearMonth: ym,
        type,
        category,
        itemName: category,
        amount: twdAmount,
        currency: 'TWD',
        fxRate: 1,
        twdAmount,
        source: '手動',
        note: '',
        createdAt: `${ym}-05T00:00:00Z`,
        updatedAt: `${ym}-05T00:00:00Z`,
      });

      const yearLogs: CashFlowLog[] = [
        mkLog('l1', '2026-01', CASHFLOW_TYPES.FIXED_INCOME, '本業薪資', 80000),
        mkLog('l2', '2026-02', CASHFLOW_TYPES.FIXED_INCOME, '本業薪資', 80000),
        mkLog('l3', '2026-02', CASHFLOW_TYPES.OTHER_INCOME, '自由接案', 15000),
        mkLog('l4', '2026-02', CASHFLOW_TYPES.FIXED_EXPENSE, '自訂租屋', 18000),
        mkLog('l5', '2026-02', CASHFLOW_TYPES.FIXED_EXPENSE, '學貸', 5000),
        mkLog('l6', '2026-02', CASHFLOW_TYPES.INVESTMENT, '美股 ETF', 20000),
        mkLog('l7', '2026-01', CASHFLOW_TYPES.INVESTMENT, '台股個股', 10000),
        mkLog('l8', '2026-02', CASHFLOW_TYPES.DAILY_EXPENSE, '餐飲', 12000),
        mkLog('l9', '2026-01', CASHFLOW_TYPES.TAX_LARGE, '綜合所得稅', 24000),
      ];
      const monthLogs = yearLogs.filter((l) => l.yearMonth === '2026-02');

      const sinkingItems: SinkingFundItem[] = [
        {
          id: 'sf-1',
          itemName: '綜合所得稅',
          category: '綜合所得稅',
          totalAmount: 24000,
          months: 12,
          dueNote: '5月',
          status: '啟用',
          note: '',
          sortOrder: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'sf-2',
          itemName: '停用項目',
          category: '牌照稅',
          totalAmount: 12000,
          months: 12,
          dueNote: '4月',
          status: '停用',
          note: '',
          sortOrder: 2,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];

      const monthlySinking = sinkingItems.reduce((s, item) => s + computeSinkingMonthlyReserve(item), 0);
      const monthly = aggregatePeriodMetrics(monthLogs, monthlySinking, true);
      const yearly = aggregatePeriodMetrics(yearLogs, monthlySinking * 12, false);

      const groups = computeOverviewBreakdownGroups(monthLogs, yearLogs, sinkingItems, monthly, yearly);

      // Universal major group labels (no hardcoded personal labels like 房貸/車貸 or 中信基金)
      expect(groups.map((g) => g.label)).toEqual([
        '固定收入',
        '其他收入',
        '固定支出',
        '訂閱扣款',
        '日常花費',
        '稅金攤提(月) / 實支(年)',
        '投資流出',
        '總儲蓄（投資＋結餘）',
      ]);

      const fixedExp = groups.find((g) => g.key === 'fixed_expense')!;
      expect(fixedExp.monthlyAmount).toBe(23000);
      expect(fixedExp.children.map((c) => c.label)).toEqual(['自訂租屋', '學貸']);

      const invest = groups.find((g) => g.key === 'investment')!;
      expect(invest.monthlyAmount).toBe(20000);
      expect(invest.yearlyAmount).toBe(30000);
      expect(invest.children).toEqual([
        { label: '美股 ETF', monthlyAmount: 20000, yearlyAmount: 20000 },
        { label: '台股個股', monthlyAmount: 0, yearlyAmount: 10000 },
      ]);

      const taxSinking = groups.find((g) => g.key === 'sinking_tax')!;
      expect(taxSinking.monthlyAmount).toBe(2000);
      expect(taxSinking.yearlyAmount).toBe(24000);
      expect(taxSinking.children).toEqual([
        { label: '綜合所得稅', monthlyAmount: 2000, yearlyAmount: 24000 },
      ]);

      const totalRow = groups[groups.length - 1];
      expect(totalRow.isTotal).toBe(true);
      expect(totalRow.monthlyAmount).toBe(monthly.totalSavings);
      expect(totalRow.yearlyAmount).toBe(yearly.totalSavings);
    });
  });

  describe('5. Stock Categories (Default + Custom) Sync & Category Chart Grouping', () => {
    it('normalizes stock category and deduplicates custom stock categories excluding defaults', () => {
      expect(normalizeStockCategory('  ETF  ')).toBe('ETF');
      expect(normalizeStockCategory('')).toBe('');
      expect(
        normalizeCustomStockCategories(['高股息', 'ETF', '債券ETF', '高股息', '  ', '特別股'])
      ).toEqual(['高股息', '債券ETF']);
    });

    it('groups positions by category in buildStockChartItems (e.g. 個股 50%, ETF 30%, 特別股 20%)', () => {
      const assets: AssetItem[] = [
        {
          id: 'c1',
          updateMode: '自動更新',
          majorType: '資產',
          subCategory: '台股',
          liquidity: '高流動',
          itemName: '台積電',
          ticker: 'TPE:2330',
          quantityOrAmount: 500,
          currency: 'TWD',
          unitPrice: 1000, // 500,000 -> 50%
          costBasis: 400000,
          stockCategory: '個股',
          note: '',
          sortOrder: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'c2',
          updateMode: '自動更新',
          majorType: '資產',
          subCategory: '台股',
          liquidity: '高流動',
          itemName: '0050',
          ticker: 'TPE:0050',
          quantityOrAmount: 1000,
          currency: 'TWD',
          unitPrice: 200, // 200,000
          costBasis: 150000,
          stockCategory: 'ETF',
          note: '',
          sortOrder: 2,
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'c3',
          updateMode: '自動更新',
          majorType: '資產',
          subCategory: '美股/ETF',
          liquidity: '高流動',
          itemName: 'VOO',
          ticker: 'VOO',
          quantityOrAmount: 10,
          currency: 'USD',
          unitPrice: 333.3333, // ~100,000 TWD at 30 -> total ETF = 300,000 (30%)
          costBasis: null,
          stockCategory: 'ETF',
          note: '',
          sortOrder: 3,
          createdAt: '2026-01-03T00:00:00Z',
          updatedAt: '2026-01-03T00:00:00Z',
        },
        {
          id: 'c4',
          updateMode: '自動更新',
          majorType: '資產',
          subCategory: '台股',
          liquidity: '高流動',
          itemName: '富邦金乙特',
          ticker: 'TPE:2881B',
          quantityOrAmount: 3000,
          currency: 'TWD',
          unitPrice: 50, // 150,000 -> 15%
          costBasis: 150000,
          stockCategory: '特別股',
          note: '',
          sortOrder: 4,
          createdAt: '2026-01-04T00:00:00Z',
          updatedAt: '2026-01-04T00:00:00Z',
        },
        {
          id: 'c5',
          updateMode: '手動快照',
          majorType: '資產',
          subCategory: '美股/ETF',
          liquidity: '高流動',
          itemName: '未標籤持股',
          ticker: '',
          quantityOrAmount: 100,
          currency: 'TWD',
          unitPrice: 500, // 50,000 -> 5% (未分類, placed last)
          costBasis: null,
          stockCategory: '',
          note: '',
          sortOrder: 5,
          createdAt: '2026-01-05T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
        },
      ];

      const portfolio = computeStockPortfolioSummary(assets, [], 30);
      const byCat = buildStockChartItems(portfolio, 'category');

      expect(byCat.map((i) => ({ label: i.label, pct: i.pct }))).toEqual([
        { label: '個股', pct: 50 },
        { label: 'ETF', pct: 30 },
        { label: '特別股', pct: 15 },
        { label: '未分類', pct: 5 },
      ]);
      expect(byCat[1].subLabel).toContain('0050');
      expect(byCat[1].subLabel).toContain('VOO');
      expect(byCat[3].color).toBe('#94A3B8');
    });

    it('syncs stockCategory and customStockCategories with D1 and preserves through JSON backup/restore', async () => {
      const d1 = createTestD1();
      const db1 = new LocalFinanceDB(`cat-1-${crypto.randomUUID()}`);
      const engine1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(d1, 'owner'),
        isOnline: () => true,
      });
      await engine1.init();
      await engine1.syncNow(true);

      await engine1.saveCustomStockCategories(['債券ETF', '高股息']);
      const stock = await engine1.saveAsset({
        itemName: '00679B',
        majorType: '資產',
        updateMode: '自動更新',
        subCategory: '台股',
        ticker: 'TPE:00679B',
        quantityOrAmount: 2000,
        unitPrice: 30,
        currency: 'TWD',
        stockCategory: '債券ETF',
      });
      expect((await engine1.syncNow()).ok).toBe(true);

      // Quick 1-tap category update
      await engine1.updateAssetStockCategory(stock.id, '高股息');
      expect((await engine1.syncNow()).ok).toBe(true);

      // Fresh device pulls updated categories
      const db2 = new LocalFinanceDB(`cat-2-${crypto.randomUUID()}`);
      const engine2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(d1, 'owner'),
        isOnline: () => true,
      });
      await engine2.init();
      await engine2.syncNow(true);

      const snap2 = engine2.getSnapshot();
      expect(snap2.settings.customStockCategories).toEqual(['債券ETF', '高股息']);
      expect(snap2.assetItems.find((a) => a.id === stock.id)?.stockCategory).toBe('高股息');

      // Export & restore into another user preserves both fields
      const exported = await exportFullSnapshot(d1, 'owner');
      await importFullSnapshot(d1, 'member-2', exported, 'replace');
      const exported2 = await exportFullSnapshot(d1, 'member-2');
      expect(exported2.settings.customStockCategories).toEqual(['債券ETF', '高股息']);
      expect(exported2.assetItems.find((a) => a.id === stock.id)?.stockCategory).toBe('高股息');
    });
  });

  describe('6. Version Info Metadata Consistency', () => {
    it('keeps SW_CACHE_VERSION and DB_SCHEMA_VERSION aligned with sw.js and migrations', () => {
      const rootDir = path.resolve(__dirname, '..');
      const swText = fs.readFileSync(path.join(rootDir, 'web/public/sw.js'), 'utf8');
      expect(swText).toContain(`'${SW_CACHE_VERSION}'`);

      const migrations = fs
        .readdirSync(path.join(rootDir, 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const latestMigration = migrations[migrations.length - 1];
      expect(latestMigration.startsWith(`${DB_SCHEMA_VERSION}_`)).toBe(true);
      expect(VERSION_HIGHLIGHTS.length).toBeGreaterThan(0);
    });
  });

  describe('7. Drag Target Multi-Slot Math & Rapid In-Flight Scheme Switching', () => {
    it('computes exact multi-slot drop target index across any drag jump', () => {
      const midpoints = [100, 160, 220, 280];
      expect(computeDropTargetIndex(50, midpoints)).toBe(0);
      expect(computeDropTargetIndex(130, midpoints)).toBe(1);
      expect(computeDropTargetIndex(250, midpoints)).toBe(3);
      expect(computeDropTargetIndex(400, midpoints)).toBe(4);
    });

    it('preserves tw_stocks when user switches tw -> tw_stocks while first sync is still in flight', async () => {
      const d1 = createTestD1();
      let releaseFirstSync!: () => void;
      let syncCallCount = 0;

      const delayedFetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        syncCallCount += 1;
        const reqBody = JSON.parse(String(init?.body || '{}')) as SyncRequest;
        const res = await processSyncRequest(d1, 'owner', reqBody);
        if (syncCallCount === 2) {
          // Hold the 'tw' sync response until after the user clicks 'tw_stocks'
          await new Promise<void>((resolve) => {
            releaseFirstSync = resolve;
          });
        }
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const db = new LocalFinanceDB(`inflight-pnl-${crypto.randomUUID()}`);
      const engine = new SyncEngine(db, {
        fetchImpl: delayedFetch,
        isOnline: () => true,
      });
      await engine.init();
      await engine.syncNow(true); // call 1: initial pull

      // User clicks 'tw', starts syncing (call 2, held in flight)
      await engine.savePnlColorScheme('tw');
      const firstSyncPromise = engine.syncNow();

      // Wait a tick for call 2 to start, then user immediately switches to 'tw_stocks'
      await new Promise((r) => setTimeout(r, 20));
      await engine.savePnlColorScheme('tw_stocks');
      expect(engine.getSnapshot().settings.pnlColorScheme).toBe('tw_stocks');

      // Release call 2 ('tw' finishes on server) -> must NOT revert local 'tw_stocks'
      releaseFirstSync();
      await firstSyncPromise;
      expect(engine.getSnapshot().settings.pnlColorScheme).toBe('tw_stocks');
      expect(engine.getConflicts()).toHaveLength(0);

      // Next sync uploads rebased 'tw_stocks' cleanly with zero conflicts
      const secondSync = await engine.syncNow();
      expect(secondSync.ok).toBe(true);
      expect(engine.getConflicts()).toHaveLength(0);
      expect(engine.getSnapshot().settings.pnlColorScheme).toBe('tw_stocks');

      const exported = await exportFullSnapshot(d1, 'owner');
      expect(exported.settings.pnlColorScheme).toBe('tw_stocks');
    });
  });
});
