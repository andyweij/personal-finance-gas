import { describe, expect, it } from 'vitest';
import { CASHFLOW_TYPES } from '../shared/constants';
import {
  parseLocalDate,
  validateAssetInput,
  validateCashFlowInput,
  validateRecurringInput,
  validateSinkingInput,
} from '../shared/validation';
import {
  buildMonthlyDedupKey,
  buildRecurringDedupKey,
  shouldPostRecurringItem,
} from '../shared/recurring';
import {
  aggregatePeriodMetrics,
  computeAssetTwdValue,
  computeMonthlyTrend,
  computeNetWorthSummary,
  computeRecurringMonthlyTwd,
  computeSinkingMonthlyReserve,
} from '../shared/calculations';
import { exportCashFlowCsv, parseCashFlowCsv } from '../shared/csv';
import type { AssetItem, CashFlowLog, RecurringItem, SinkingFundItem } from '../shared/types';

describe('shared/validation', () => {
  it('validates calendar dates strictly including leap years', () => {
    expect(parseLocalDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29, yearMonth: '2024-02' });
    expect(parseLocalDate('2026-11-23')).toEqual({ year: 2026, month: 11, day: 23, yearMonth: '2026-11' });
    expect(() => parseLocalDate('2026-02-29')).toThrow(/無效的日期/);
    expect(() => parseLocalDate('2026-02-30')).toThrow(/無效的日期/);
    expect(() => parseLocalDate('2026/11/23')).toThrow(/日期格式錯誤/);
  });

  it('validates CashFlowLog input and rejects invalid amount, currency, or type', () => {
    const ok = validateCashFlowInput({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '午餐',
      amount: 185,
      currency: 'twd',
      note: 'Apple Pay',
    });
    expect(ok.currency).toBe('TWD');
    expect(ok.yearMonth).toBe('2026-11');

    expect(() =>
      validateCashFlowInput({
        date: '2026-11-23',
        type: '不存在的類型',
        category: '餐飲',
        itemName: '午餐',
        amount: 100,
        currency: 'TWD',
      })
    ).toThrow(/不支援的收支類型/);

    expect(() =>
      validateCashFlowInput({
        date: '2026-11-23',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '午餐',
        amount: -10,
        currency: 'TWD',
      })
    ).toThrow(/大於 0/);

    expect(() =>
      validateCashFlowInput({
        date: '2026-11-23',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '午餐',
        amount: 100,
        currency: 'JPY',
      })
    ).toThrow(/不支援的幣別/);
  });

  it('validates recurring, sinking fund, and asset inputs', () => {
    expect(() =>
      validateRecurringInput({
        itemName: '',
        category: '訂閱',
        type: CASHFLOW_TYPES.SUBSCRIPTION,
        amount: 20,
        currency: 'USD',
        cycle: '月繳',
        status: '啟用',
      })
    ).toThrow(/項目名稱/);

    expect(() =>
      validateSinkingInput({
        itemName: '綜合所得稅',
        category: '所得稅',
        totalAmount: 60000,
        months: 0,
        status: '啟用',
      })
    ).toThrow(/分攤月數/);

    const liab = validateAssetInput({
      updateMode: '手動快照',
      majorType: '負債',
      subCategory: '房貸餘額',
      liquidity: '高流動',
      itemName: '房屋貸款',
      quantityOrAmount: 5000000,
      currency: 'TWD',
    });
    expect(liab.liquidity).toBe('負債');
  });
});

describe('shared/recurring', () => {
  it('evaluates monthly, annual, specific months, and one-time schedules accurately', () => {
    expect(shouldPostRecurringItem('月繳', '', 2026, 1)).toBe(true);
    expect(shouldPostRecurringItem('年繳', '6', 2026, 6)).toBe(true);
    expect(shouldPostRecurringItem('年繳', '6', 2026, 5)).toBe(false);
    expect(shouldPostRecurringItem('特定月份', '3,6,9,12', 2026, 9)).toBe(true);
    expect(shouldPostRecurringItem('特定月份', '3、6、9、12', 2026, 12)).toBe(true);
    expect(shouldPostRecurringItem('特定月份', '3/6/9/12', 2026, 10)).toBe(false);
    expect(shouldPostRecurringItem('一次性', '', 2026, 11)).toBe(true);
    expect(shouldPostRecurringItem('一次性', '2026-12', 2026, 12)).toBe(true);
    expect(shouldPostRecurringItem('一次性', '2026-12', 2026, 11)).toBe(false);
    expect(shouldPostRecurringItem('一次性', '11', 2026, 11)).toBe(true);
  });

  it('normalizes whitespace in dedup keys', () => {
    expect(buildRecurringDedupKey(' 訂閱扣款 ', ' Google AI Pro ')).toBe('訂閱扣款||Google AI Pro');
    expect(buildMonthlyDedupKey('2026-11', ' 訂閱扣款 ', ' Claude Pro ')).toBe('2026-11||訂閱扣款||Claude Pro');
  });
});

describe('shared/calculations', () => {
  const sampleLogs: CashFlowLog[] = [
    {
      id: '1',
      date: '2026-11-01',
      yearMonth: '2026-11',
      type: CASHFLOW_TYPES.FIXED_INCOME,
      category: '薪資',
      itemName: '本業月薪',
      amount: 100000,
      currency: 'TWD',
      fxRate: 1,
      twdAmount: 100000,
      source: '自動入帳',
      note: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: '2',
      date: '2026-11-01',
      yearMonth: '2026-11',
      type: CASHFLOW_TYPES.FIXED_EXPENSE,
      category: '房貸',
      itemName: '房貸',
      amount: 25000,
      currency: 'TWD',
      fxRate: 1,
      twdAmount: 25000,
      source: '自動入帳',
      note: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: '3',
      date: '2026-11-01',
      yearMonth: '2026-11',
      type: CASHFLOW_TYPES.INVESTMENT,
      category: '台股投資',
      itemName: '定期定額 0050',
      amount: 20000,
      currency: 'TWD',
      fxRate: 1,
      twdAmount: 20000,
      source: '自動入帳',
      note: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: '4',
      date: '2026-11-05',
      yearMonth: '2026-11',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '聚餐',
      amount: 10000,
      currency: 'TWD',
      fxRate: 1,
      twdAmount: 10000,
      source: '手機記帳',
      note: '',
      createdAt: '2026-11-05T00:00:00.000Z',
      updatedAt: '2026-11-05T00:00:00.000Z',
    },
    {
      id: '5',
      date: '2026-11-10',
      yearMonth: '2026-11',
      type: CASHFLOW_TYPES.TAX_LARGE,
      category: '所得稅',
      itemName: '補稅',
      amount: 12000,
      currency: 'TWD',
      fxRate: 1,
      twdAmount: 12000,
      source: '手機記帳',
      note: '',
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z',
    },
  ];

  it('computes true savings rate excluding investment from consumption (monthly vs yearly)', () => {
    // Monthly uses sinkingReserve (5000) instead of actual taxLarge (12000)
    const monthly = aggregatePeriodMetrics(sampleLogs, 5000, true);
    expect(monthly.totalIncome).toBe(100000);
    expect(monthly.totalConsumption).toBe(25000 + 10000 + 5000); // 40000
    expect(monthly.investment).toBe(20000);
    expect(monthly.freeCashFlow).toBe(100000 - 40000 - 20000); // 40000
    expect(monthly.totalSavings).toBe(60000); // 20000 inv + 40000 free
    expect(monthly.savingsRate).toBe(60); // 60.0%
    expect(monthly.investmentStock).toBe(20000);
    expect(monthly.mortgage).toBe(25000);

    // Yearly uses actual taxLarge (12000)
    const yearly = aggregatePeriodMetrics(sampleLogs, 60000, false);
    expect(yearly.totalConsumption).toBe(25000 + 10000 + 12000); // 47000
    expect(yearly.totalSavings).toBe(53000);
    expect(yearly.savingsRate).toBe(53);
  });

  it('computes recurring monthly TWD, sinking reserve, and asset TWD value', () => {
    const rec: RecurringItem = {
      id: 'r1',
      itemName: 'Claude Pro',
      category: 'AI訂閱',
      type: CASHFLOW_TYPES.SUBSCRIPTION,
      amount: 20,
      currency: 'USD',
      cycle: '月繳',
      billingSpec: '',
      status: '啟用',
      note: '',
      createdAt: '',
      updatedAt: '',
    };
    expect(computeRecurringMonthlyTwd(rec, 32.5)).toBe(650);
    expect(computeRecurringMonthlyTwd({ ...rec, status: '停用' }, 32.5)).toBe(0);
    expect(computeRecurringMonthlyTwd({ ...rec, cycle: '特定月份', billingSpec: '3,6,9,12' }, 32.5)).toBe(217);

    const sf: SinkingFundItem = {
      id: 's1',
      itemName: '所得稅',
      category: '所得稅',
      totalAmount: 60000,
      months: 12,
      dueNote: '5月',
      status: '啟用',
      note: '',
      createdAt: '',
      updatedAt: '',
    };
    expect(computeSinkingMonthlyReserve(sf)).toBe(5000);
    expect(computeSinkingMonthlyReserve({ ...sf, status: '停用' })).toBe(0);

    const usdCash: AssetItem = {
      id: 'a1',
      updateMode: '自動更新',
      majorType: '資產',
      subCategory: '美金',
      liquidity: '高流動',
      itemName: '美金活存',
      ticker: '',
      quantityOrAmount: 1000,
      currency: 'USD',
      unitPrice: 1,
      note: '',
      createdAt: '',
      updatedAt: '',
    };
    expect(computeAssetTwdValue(usdCash, 32.5)).toBe(32500);
  });

  it('computes 12-month trend and net worth breakdown accurately', () => {
    const trend = computeMonthlyTrend(sampleLogs, 2026);
    expect(trend).toHaveLength(12);
    expect(trend[10]).toMatchObject({
      month: 11,
      ym: '2026-11',
      income: 100000,
      fixedSub: 25000,
      daily: 10000,
      taxLarge: 12000,
      investment: 20000,
      netCashFlow: 33000,
      totalSavings: 53000,
    });

    const assets: AssetItem[] = [
      {
        id: 'a1',
        updateMode: '自動更新',
        majorType: '資產',
        subCategory: '台股',
        liquidity: '高流動',
        itemName: '0050',
        ticker: 'TPE:0050',
        quantityOrAmount: 1000,
        currency: 'TWD',
        unitPrice: 200,
        note: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'a2',
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '定存/現金',
        liquidity: '高流動',
        itemName: '台幣活存',
        ticker: '',
        quantityOrAmount: 300000,
        currency: 'TWD',
        unitPrice: 1,
        note: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'l1',
        updateMode: '手動快照',
        majorType: '負債',
        subCategory: '房貸餘額',
        liquidity: '負債',
        itemName: '房貸',
        ticker: '',
        quantityOrAmount: 100000,
        currency: 'TWD',
        unitPrice: 1,
        note: '',
        createdAt: '',
        updatedAt: '',
      },
    ];

    const nw = computeNetWorthSummary(assets, 32.5, 50000);
    expect(nw.totalAssets).toBe(500000);
    expect(nw.totalLiabilities).toBe(100000);
    expect(nw.netWorth).toBe(400000);
    expect(nw.debtRatio).toBe(20);
    expect(nw.highLiquidityAssets).toBe(500000);
    expect(nw.emergencyMonths).toBe(10);
    expect(nw.stockValue).toBe(200000);
    expect(nw.cashUsdValue).toBe(300000);
  });
});

describe('shared/csv', () => {
  it('exports UTF-8 BOM CSV and parses GAS CashFlow_Log CSV cleanly', () => {
    const logs: CashFlowLog[] = [
      {
        id: 'id-1',
        date: '2026-11-23',
        yearMonth: '2026-11',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '拉麵, 加蛋',
        amount: 280,
        currency: 'TWD',
        fxRate: 1,
        twdAmount: 280,
        source: '手機記帳',
        note: '使用 "Apple Pay"',
        createdAt: '2026-11-23T01:00:00.000Z',
        updatedAt: '2026-11-23T01:00:00.000Z',
      },
    ];

    const csv = exportCashFlowCsv(logs);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"拉麵, 加蛋"');
    expect(csv).toContain('"使用 ""Apple Pay"""');

    const parsed = parseCashFlowCsv(csv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '拉麵, 加蛋',
      amount: 280,
      currency: 'TWD',
      fxRate: 1,
      source: '手機記帳',
      note: '使用 "Apple Pay"',
    });
  });
});
