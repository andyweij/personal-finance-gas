import { describe, expect, it } from 'vitest';
import { CASHFLOW_TYPES } from '../shared/constants';
import {
  aggregatePeriodMetrics,
  computeAllSavingsSummary,
  computeNetWorthSummary,
  computeSavingsAccountSummary,
} from '../shared/calculations';
import { validateSavingsAdjustmentInput } from '../shared/validation';
import type { AssetItem, CashFlowLog, SavingsAdjustment } from '../shared/types';

function makeSavingsAccount(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: 'acc-1',
    updateMode: '手動快照',
    majorType: '資產',
    subCategory: '活存',
    liquidity: '高流動',
    itemName: '中信活存',
    ticker: '',
    quantityOrAmount: 300000,
    currency: 'TWD',
    unitPrice: 1,
    note: '',
    isLinkedSavings: true,
    balanceAnchorDate: '2026-11-24',
    balanceAnchorAt: '2026-11-24T04:00:00.000Z',
    isDefaultSavings: true,
    createdAt: '2026-11-24T04:00:00.000Z',
    updatedAt: '2026-11-24T04:00:00.000Z',
    ...overrides,
  };
}

function makeLog(overrides: Partial<CashFlowLog> = {}): CashFlowLog {
  return {
    id: 'log-1',
    date: '2026-11-24',
    yearMonth: '2026-11',
    type: CASHFLOW_TYPES.DAILY_EXPENSE,
    category: '餐飲',
    itemName: '大額支出',
    amount: 100000,
    currency: 'TWD',
    fxRate: 1,
    twdAmount: 100000,
    source: '手機記帳',
    note: '',
    linkedAccountId: 'acc-1',
    createdAt: '2026-11-24T05:00:00.000Z',
    updatedAt: '2026-11-24T05:00:00.000Z',
    ...overrides,
  };
}

describe('Live-Linked Savings Accounts & CashFlow Linkage', () => {
  it('accumulates multiple savings accounts and deducts linked expenses in real time (500k - 100k = 400k)', () => {
    const acc1 = makeSavingsAccount({ id: 'acc-1', itemName: '中信活存', quantityOrAmount: 300000 });
    const acc2 = makeSavingsAccount({
      id: 'acc-2',
      itemName: '台新活存',
      quantityOrAmount: 200000,
      isDefaultSavings: false,
    });

    const expense100k = makeLog({ id: 'l1', linkedAccountId: 'acc-1', twdAmount: 100000 });
    const summary = computeAllSavingsSummary([acc1, acc2], [expense100k], [], 32.5);

    expect(summary.accounts).toHaveLength(2);
    expect(summary.accounts[0].currentBalanceTwd).toBe(200000);
    expect(summary.accounts[1].currentBalanceTwd).toBe(200000);
    expect(summary.totalSavingsTwd).toBe(400000);
    expect(summary.defaultAccountId).toBe('acc-1');
  });

  it('accumulates N deposit/withdrawal adjustments on a single savings account without distorting cashflow income', () => {
    const acc = makeSavingsAccount({ id: 'acc-1', quantityOrAmount: 0 });
    const adjustments: SavingsAdjustment[] = [
      {
        id: 'adj-1',
        accountId: 'acc-1',
        date: '2026-11-24',
        amount: 200000,
        twdAmount: 200000,
        note: '定存解約轉入',
        createdAt: '2026-11-24T04:10:00.000Z',
        updatedAt: '2026-11-24T04:10:00.000Z',
      },
      {
        id: 'adj-2',
        accountId: 'acc-1',
        date: '2026-11-24',
        amount: 150000,
        twdAmount: 150000,
        note: '第二筆存入',
        createdAt: '2026-11-24T04:20:00.000Z',
        updatedAt: '2026-11-24T04:20:00.000Z',
      },
      {
        id: 'adj-3',
        accountId: 'acc-1',
        date: '2026-11-25',
        amount: 150000,
        twdAmount: 150000,
        note: '第三筆存入',
        createdAt: '2026-11-25T01:00:00.000Z',
        updatedAt: '2026-11-25T01:00:00.000Z',
      },
    ];
    const logs = [makeLog({ id: 'l1', linkedAccountId: 'acc-1', twdAmount: 100000 })];

    const res = computeSavingsAccountSummary(acc, logs, adjustments, 32.5);
    expect(res.adjustmentsTotalTwd).toBe(500000);
    expect(res.cashflowNetTwd).toBe(-100000);
    expect(res.currentBalanceTwd).toBe(400000);

    // Savings adjustments never inflate cashflow income metrics
    const metrics = aggregatePeriodMetrics(logs, 0, true);
    expect(metrics.totalIncome).toBe(0);
  });

  it('handles all 7 cashflow types accurately (income +, all expenses and investment -) and restores balance on delete', () => {
    const acc = makeSavingsAccount({ id: 'acc-1', quantityOrAmount: 500000 });
    const logs: CashFlowLog[] = [
      makeLog({ id: '1', type: CASHFLOW_TYPES.FIXED_INCOME, twdAmount: 80000 }),
      makeLog({ id: '2', type: CASHFLOW_TYPES.OTHER_INCOME, twdAmount: 20000 }),
      makeLog({ id: '3', type: CASHFLOW_TYPES.FIXED_EXPENSE, twdAmount: 30000 }),
      makeLog({ id: '4', type: CASHFLOW_TYPES.SUBSCRIPTION, twdAmount: 2000 }),
      makeLog({ id: '5', type: CASHFLOW_TYPES.DAILY_EXPENSE, twdAmount: 10000 }),
      makeLog({ id: '6', type: CASHFLOW_TYPES.TAX_LARGE, twdAmount: 8000 }),
      makeLog({ id: '7', type: CASHFLOW_TYPES.INVESTMENT, twdAmount: 25000 }),
      // Unlinked log should NOT affect balance
      makeLog({ id: '8', type: CASHFLOW_TYPES.DAILY_EXPENSE, twdAmount: 99999, linkedAccountId: null }),
    ];

    // 500,000 + 100,000 - (30,000 + 2,000 + 10,000 + 8,000 + 25,000) = 525,000
    const res = computeSavingsAccountSummary(acc, logs, [], 32.5);
    expect(res.currentBalanceTwd).toBe(525000);

    // Soft-deleting the 25k investment immediately restores balance to 550,000
    const afterDelete = logs.map((l) => (l.id === '7' ? { ...l, deletedAt: '2026-11-24T09:00:00.000Z' } : l));
    const res2 = computeSavingsAccountSummary(acc, afterDelete, [], 32.5);
    expect(res2.currentBalanceTwd).toBe(550000);
  });

  it('excludes historical logs before anchor date or earlier on the anchor day to prevent double deduction', () => {
    const acc = makeSavingsAccount({
      id: 'acc-1',
      quantityOrAmount: 500000,
      balanceAnchorDate: '2026-11-24',
      balanceAnchorAt: '2026-11-24T04:00:00.000Z',
    });

    const logs: CashFlowLog[] = [
      // Prior day -> ignored
      makeLog({ id: 'old-day', date: '2026-11-23', twdAmount: 50000, createdAt: '2026-11-23T12:00:00.000Z' }),
      // Same day BEFORE anchor timestamp -> ignored
      makeLog({ id: 'same-day-early', date: '2026-11-24', twdAmount: 30000, createdAt: '2026-11-24T02:00:00.000Z' }),
      // Same day AFTER anchor timestamp -> included
      makeLog({ id: 'same-day-after', date: '2026-11-24', twdAmount: 100000, createdAt: '2026-11-24T05:00:00.000Z' }),
      // Next day -> included regardless of createdAt
      makeLog({ id: 'next-day', date: '2026-11-25', twdAmount: 20000, createdAt: '2026-11-25T01:00:00.000Z' }),
    ];

    const res = computeSavingsAccountSummary(acc, logs, [], 32.5);
    expect(res.currentBalanceTwd).toBe(380000); // 500k - 100k - 20k
  });

  it('uses live savings balances inside computeNetWorthSummary without double counting', () => {
    const acc = makeSavingsAccount({ id: 'acc-1', quantityOrAmount: 500000 });
    const stock: AssetItem = {
      id: 'stock-1',
      updateMode: '自動更新',
      majorType: '資產',
      subCategory: '台股',
      liquidity: '中流動',
      itemName: '0050',
      ticker: 'TPE:0050',
      quantityOrAmount: 1000,
      currency: 'TWD',
      unitPrice: 200,
      note: '',
      createdAt: '',
      updatedAt: '',
    };
    const expense100k = makeLog({ id: 'l1', linkedAccountId: 'acc-1', twdAmount: 100000 });

    const nw = computeNetWorthSummary([acc, stock], 32.5, 40000, [expense100k], []);
    expect(nw.totalAssets).toBe(600000); // 400k live savings + 200k stock
    expect(nw.cashUsdValue).toBe(400000);
    expect(nw.highLiquidityAssets).toBe(400000);
    expect(nw.emergencyMonths).toBe(10);
  });

  it('validates savings adjustment inputs strictly', () => {
    const valid = validateSavingsAdjustmentInput({
      accountId: 'acc-1',
      date: '2026-11-24',
      amount: 50000,
      note: '存入',
    });
    expect(valid.twdAmount).toBe(50000);

    expect(() =>
      validateSavingsAdjustmentInput({ accountId: 'acc-1', date: '2026-11-24', amount: 0 })
    ).toThrow(/不可為 0/);
  });
});
