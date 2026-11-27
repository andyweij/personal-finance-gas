import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  computeAssetTwdValue,
  computeNetWorthSummary,
  computeRecurringMonthlyTwd,
  computeSavingsAccountSummary,
} from '../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../shared/constants';
import {
  computeCrossTwdRatesFromUsdBase,
  formatCurrencyRaw,
  getCurrencyDecimals,
  isValidFxRateForCurrency,
  resolveFxRate,
} from '../shared/currency';
import {
  normalizeEnabledCurrencies,
  normalizeFxRates,
  validateAssetInput,
  validateCashFlowInput,
} from '../shared/validation';
import type {
  AssetItem,
  CashFlowLog,
  RecurringItem,
  SavingsAdjustment,
  SyncRequest,
} from '../shared/types';
import { runMonthEndSnapshotD1, runMonthlyRecurringD1 } from '../worker/automation';
import { fetchAllTwdFxRates, refreshMarketData } from '../worker/market';
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

describe('Phase 4 (v1.12.0) — Multi-Currency Support (JPY / EUR / HKD / GBP / etc.)', () => {
  describe('1. Cross-rate Calculation, Sanity Bounds & Formatting', () => {
    it('computes accurate cross TWD rates from USD base and rejects out-of-range values', () => {
      const rates = computeCrossTwdRatesFromUsdBase({
        TWD: 32.5,
        JPY: 150,
        EUR: 0.92,
        KRW: 1380,
        GBP: 0.0001, // absurd -> must be rejected (32.5 / 0.0001 = 325000)
        FAKE: 10, // unsupported -> ignored
      });
      expect(rates.USD).toBe(32.5);
      expect(rates.JPY).toBeCloseTo(32.5 / 150, 4);
      expect(rates.EUR).toBeCloseTo(32.5 / 0.92, 3);
      expect(rates.KRW).toBeCloseTo(32.5 / 1380, 5);
      expect(rates.GBP).toBeUndefined();
      expect(rates.FAKE).toBeUndefined();

      expect(isValidFxRateForCurrency('JPY', 0.215)).toBe(true);
      expect(isValidFxRateForCurrency('JPY', 50)).toBe(false);
      expect(isValidFxRateForCurrency('KRW', 0.0235)).toBe(true);
      expect(isValidFxRateForCurrency('KRW', 2)).toBe(false);
    });

    it('resolves decimals, symbols, and FX rates cleanly for both legacy number and multi-currency map', () => {
      expect(getCurrencyDecimals('TWD')).toBe(0);
      expect(getCurrencyDecimals('JPY')).toBe(0);
      expect(getCurrencyDecimals('KRW')).toBe(0);
      expect(getCurrencyDecimals('USD')).toBe(2);
      expect(getCurrencyDecimals('EUR')).toBe(2);

      expect(formatCurrencyRaw(12500, 'JPY', false)).toBe('¥12,500');
      expect(formatCurrencyRaw(99.5, 'EUR', false)).toBe('€99.5');
      expect(formatCurrencyRaw(100, 'JPY', true)).toBe('JPY •••');

      // Legacy numeric source still resolves USD and TWD cleanly
      expect(resolveFxRate('TWD', 32.1)).toBe(1);
      expect(resolveFxRate('USD', 32.1)).toBe(32.1);

      // Multi-currency settings object resolves JPY/EUR/USD
      const fxSource = { usdTwdRate: 32.5, fxRates: { USD: 32.5, JPY: 0.22, EUR: 35.2 } };
      expect(resolveFxRate('JPY', fxSource)).toBe(0.22);
      expect(resolveFxRate('EUR', fxSource)).toBe(35.2);
      expect(resolveFxRate('USD', fxSource)).toBe(32.5);
    });

    it('normalizes enabledCurrencies (always includes TWD) and rejects invalid currencies in validation', () => {
      expect(normalizeEnabledCurrencies(['JPY', 'FAKE', 'EUR'])).toEqual(['TWD', 'JPY', 'EUR']);
      expect(normalizeEnabledCurrencies(null)).toEqual(['TWD', 'USD']);
      expect(normalizeFxRates({ JPY: 0.215, EUR: 9999 }, 32.5)).toEqual({ USD: 32.5, JPY: 0.215 });

      const jpyLog = validateCashFlowInput(
        {
          date: '2026-11-20',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '東京拉麵',
          amount: 1500,
          currency: 'JPY',
        },
        { usdTwdRate: 32.5, fxRates: { USD: 32.5, JPY: 0.22 } }
      );
      expect(jpyLog.currency).toBe('JPY');
      expect(jpyLog.fxRate).toBe(0.22);
      expect(jpyLog.twdAmount).toBe(330);

      expect(() =>
        validateCashFlowInput({
          date: '2026-11-20',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '測試',
          amount: 100,
          currency: 'FAKE',
        })
      ).toThrow(/不支援/);

      const jpyAsset = validateAssetInput({
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '玉山日幣活存',
        quantityOrAmount: 100_000,
        currency: 'JPY',
        unitPrice: 1,
        isLinkedSavings: true,
      });
      expect(jpyAsset.currency).toBe('JPY');
    });
  });

  describe('2. Multi-Currency Savings, Recurring & Net Worth Calculations', () => {
    it('sums JPY savings account in native JPY and converts once at current rate (no historical drift)', () => {
      const fx = { usdTwdRate: 32.5, fxRates: { USD: 32.5, JPY: 0.22 } };
      const jpyAcc: AssetItem = {
        id: 'acc-jpy',
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '日幣外幣戶',
        ticker: '',
        quantityOrAmount: 100_000, // 100,000 JPY baseline
        currency: 'JPY',
        unitPrice: 1,
        note: '',
        isLinkedSavings: true,
        balanceAnchorDate: '2026-11-01',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      };
      const adjs: SavingsAdjustment[] = [
        {
          id: 'adj1',
          accountId: 'acc-jpy',
          date: '2026-11-05',
          amount: 50_000,
          twdAmount: 10_500, // recorded at older 0.21 rate
          note: '換匯存入',
          createdAt: '2026-11-05T00:00:00.000Z',
          updatedAt: '2026-11-05T00:00:00.000Z',
        },
      ];
      const logs: CashFlowLog[] = [
        {
          id: 'log1',
          date: '2026-11-10',
          yearMonth: '2026-11',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '壽司',
          amount: 10_000,
          currency: 'JPY',
          fxRate: 0.21,
          twdAmount: 2100,
          source: '手機記帳',
          note: '',
          linkedAccountId: 'acc-jpy',
          ledgerId: DEFAULT_LEDGER_ID,
          createdAt: '2026-11-10T00:00:00.000Z',
          updatedAt: '2026-11-10T00:00:00.000Z',
        },
      ];

      const summary = computeSavingsAccountSummary(jpyAcc, logs, adjs, fx);
      // Native JPY balance = 100,000 + 50,000 - 10,000 = 140,000 JPY
      // Converted once at current 0.22 = 30,800 TWD
      expect(summary.currentBalanceNative).toBe(140_000);
      expect(summary.currentBalanceTwd).toBe(30_800);

      expect(computeAssetTwdValue(jpyAcc, fx)).toBe(22_000);

      const recJpy: RecurringItem = {
        id: 'rec-jpy',
        itemName: '日本雲端服務',
        category: '軟體訂閱',
        type: CASHFLOW_TYPES.SUBSCRIPTION,
        amount: 2000,
        currency: 'JPY',
        cycle: '月繳',
        billingSpec: '',
        status: '啟用',
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      expect(computeRecurringMonthlyTwd(recJpy, fx)).toBe(440);

      const nw = computeNetWorthSummary([jpyAcc], fx, 0, logs, adjs);
      expect(nw.totalAssets).toBe(30_800);
      expect(nw.netWorth).toBe(30_800);
    });
  });

  describe('3. Market FX Refresh (Single Subrequest), Automation & Sync/Backup', () => {
    it('fetches all currencies in 1 open.er-api call, respects autoFxEnabled=false, and posts JPY recurring + snapshot', async () => {
      let fetchCalls = 0;
      const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
        fetchCalls++;
        const url = String(input);
        if (url.includes('open.er-api.com')) {
          return new Response(
            JSON.stringify({
              rates: { TWD: 32.0, JPY: 160, EUR: 0.9142857, HKD: 7.8 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const fetched = await fetchAllTwdFxRates(mockFetch);
      expect(fetchCalls).toBe(1);
      expect(fetched?.USD).toBe(32);
      expect(fetched?.JPY).toBe(0.2);
      expect(fetched?.EUR).toBeCloseTo(35, 1);

      const rawD1 = createTestD1();
      await seedUser(rawD1, 'u-fx-auto');
      await seedUser(rawD1, 'u-fx-manual');
      const counting = createCountingD1(rawD1);

      // User 1: autoFx enabled
      const db1 = new LocalFinanceDB(`mc-1-${crypto.randomUUID()}`);
      const eng1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(counting.db, 'u-fx-auto'),
        isOnline: () => true,
      });
      await eng1.init();
      await eng1.syncNow(true);
      await eng1.saveMultiCurrencySettings({
        usdTwdRate: 32.5,
        enabledCurrencies: ['TWD', 'USD', 'JPY', 'EUR'],
        fxRates: { USD: 32.5, JPY: 0.215, EUR: 35.1 },
        autoFxEnabled: true,
      });
      await eng1.syncNow();

      // User 2: autoFx disabled (manual rates must NOT be overwritten by refreshMarketData)
      const db2 = new LocalFinanceDB(`mc-2-${crypto.randomUUID()}`);
      const eng2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(rawD1, 'u-fx-manual'),
        isOnline: () => true,
      });
      await eng2.init();
      await eng2.syncNow(true);
      await eng2.saveMultiCurrencySettings({
        usdTwdRate: 31.0,
        enabledCurrencies: ['TWD', 'USD', 'JPY'],
        fxRates: { USD: 31.0, JPY: 0.25 },
        autoFxEnabled: false,
      });
      await eng2.syncNow();

      fetchCalls = 0;
      await refreshMarketData(rawD1, mockFetch);
      expect(fetchCalls).toBe(1); // single FX call for all users & all currencies!

      const exp1 = await exportFullSnapshot(rawD1, 'u-fx-auto');
      expect(exp1.settings.usdTwdRate).toBe(32);
      expect(exp1.settings.fxRates?.JPY).toBe(0.2);
      expect(exp1.settings.enabledCurrencies).toEqual(['TWD', 'USD', 'JPY', 'EUR']);

      const exp2 = await exportFullSnapshot(rawD1, 'u-fx-manual');
      expect(exp2.settings.usdTwdRate).toBe(31);
      expect(exp2.settings.fxRates?.JPY).toBe(0.25);

      // Add a JPY recurring item + JPY asset for u-fx-auto and verify automation uses 0.2 JPY/TWD
      await eng1.saveRecurring({
        itemName: '日幣訂閱',
        category: '軟體訂閱',
        type: CASHFLOW_TYPES.SUBSCRIPTION,
        amount: 5000,
        currency: 'JPY',
        cycle: '月繳',
        billingSpec: '',
        status: '啟用',
      });
      await eng1.saveAsset({
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '定存/現金',
        liquidity: '高流動',
        itemName: '日幣現金',
        quantityOrAmount: 100_000,
        currency: 'JPY',
        unitPrice: 1,
      });
      await eng1.syncNow();

      const recRes = await runMonthlyRecurringD1(rawD1, 'u-fx-auto', 2026, 12);
      expect(recRes.insertedCount).toBe(1);
      const afterRec = await exportFullSnapshot(rawD1, 'u-fx-auto');
      const postedLog = afterRec.cashflowLogs.find((l) => l.itemName === '日幣訂閱')!;
      expect(postedLog.currency).toBe('JPY');
      expect(postedLog.fxRate).toBe(0.2);
      expect(postedLog.twdAmount).toBe(1000);

      const snapRes = await runMonthEndSnapshotD1(rawD1, 'u-fx-auto', new Date('2026-12-31T15:00:00Z'));
      expect(snapRes.totalAssets).toBe(20_000); // 100,000 JPY * 0.2

      // JSON export & restore preserves multi-currency settings
      await importFullSnapshot(rawD1, 'u-fx-auto', exp1, 'replace');
      const afterRestore = await exportFullSnapshot(rawD1, 'u-fx-auto');
      expect(afterRestore.settings.enabledCurrencies).toEqual(['TWD', 'USD', 'JPY', 'EUR']);
      expect(afterRestore.settings.fxRates?.JPY).toBe(0.2);
    });
  });
});
