import { describe, expect, it } from 'vitest';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../shared/constants';
import { aggregatePeriodMetrics } from '../shared/calculations';
import { exportCashFlowCsv, parseCashFlowCsv } from '../shared/csv';
import {
  collectAvailableCategories,
  isLedgerSearchActive,
  resolveDatePresetRange,
  searchCashFlowLogs,
  splitHighlightSegments,
  tokenizeSearchQuery,
  type LedgerSearchFilter,
} from '../shared/ledgerSearch';
import type { CashFlowLog, Ledger } from '../shared/types';

function makeLog(overrides: Partial<CashFlowLog> & { id: string }): CashFlowLog {
  const date = overrides.date ?? '2026-11-15';
  const amount = overrides.amount ?? 100;
  const fxRate = overrides.fxRate ?? 1;
  return {
    date,
    yearMonth: date.slice(0, 7),
    type: CASHFLOW_TYPES.DAILY_EXPENSE,
    category: '餐飲',
    itemName: '午餐',
    amount,
    currency: 'TWD',
    fxRate,
    twdAmount: overrides.twdAmount ?? Math.round(amount * fxRate),
    source: '手機記帳',
    note: '',
    linkedAccountId: null,
    ledgerId: DEFAULT_LEDGER_ID,
    createdAt: `${date}T12:00:00.000Z`,
    updatedAt: `${date}T12:00:00.000Z`,
    deletedAt: null,
    ...overrides,
  };
}

const sampleLedgers: Ledger[] = [
  {
    id: DEFAULT_LEDGER_ID,
    name: '個人主帳本',
    includeInNetWorth: true,
    monthlyDailyBudget: null,
    note: '',
    sortOrder: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'ledger-trip',
    name: '日本旅遊公帳',
    includeInNetWorth: false,
    monthlyDailyBudget: null,
    note: '',
    sortOrder: 2,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'ledger-side',
    name: '副業帳本',
    includeInNetWorth: true,
    monthlyDailyBudget: null,
    note: '',
    sortOrder: 3,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

describe('Phase 1 (v1.9.0) — shared/ledgerSearch', () => {
  describe('tokenizeSearchQuery', () => {
    it('splits ASCII and fullwidth spaces, lowercases, and deduplicates tokens', () => {
      expect(tokenizeSearchQuery('  Apple　Pay  apple  中信卡  ')).toEqual(['apple', 'pay', '中信卡']);
      expect(tokenizeSearchQuery('   　  ')).toEqual([]);
    });
  });

  describe('resolveDatePresetRange', () => {
    it('computes exact month boundaries including leap years', () => {
      expect(resolveDatePresetRange('month', '2024-02')).toEqual({
        from: '2024-02-01',
        to: '2024-02-29',
        swapped: false,
      });
      expect(resolveDatePresetRange('month', '2026-02')).toEqual({
        from: '2026-02-01',
        to: '2026-02-28',
        swapped: false,
      });
    });

    it('computes 3m preset anchored to todayYm across year boundaries (not historical anchorYm)', () => {
      // Review #1: even if user browsed 2025-03, '3m' uses todayYm (2026-01 or 2026-11)
      expect(resolveDatePresetRange('3m', '2025-03', undefined, undefined, '2026-01')).toEqual({
        from: '2025-11-01',
        to: '2026-01-31',
        swapped: false,
      });
      expect(resolveDatePresetRange('3m', '2025-03', undefined, undefined, '2026-11')).toEqual({
        from: '2026-09-01',
        to: '2026-11-30',
        swapped: false,
      });
    });

    it('computes year preset anchored to todayYm (not historical anchorYm) and all preset', () => {
      expect(resolveDatePresetRange('year', '2025-03', undefined, undefined, '2026-11')).toEqual({
        from: '2026-01-01',
        to: '2026-12-31',
        swapped: false,
      });
      expect(resolveDatePresetRange('all', '2025-03', undefined, undefined, '2026-11')).toEqual({
        from: null,
        to: null,
        swapped: false,
      });
    });

    it('normalizes swapped custom date range without throwing and ignores malformed input', () => {
      expect(resolveDatePresetRange('custom', '2026-11', '2026-12-01', '2026-01-15')).toEqual({
        from: '2026-01-15',
        to: '2026-12-01',
        swapped: true,
      });
      expect(resolveDatePresetRange('custom', '2026-11', 'not-a-date', '2026-05-01')).toEqual({
        from: null,
        to: '2026-05-01',
        swapped: false,
      });
    });
  });

  describe('searchCashFlowLogs', () => {
    const logs: CashFlowLog[] = [
      makeLog({
        id: 'l1',
        date: '2026-11-20',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '星巴克咖啡',
        twdAmount: 165,
        note: 'Apple Pay 中信卡',
        linkedAccountId: 'acc-esun',
      }),
      makeLog({
        id: 'l2',
        date: '2026-10-05',
        type: CASHFLOW_TYPES.TAX_LARGE,
        category: '家電/維修',
        itemName: '客廳冷氣維修',
        twdAmount: 4500,
        note: '現金付款',
        linkedAccountId: 'acc-esun',
      }),
      makeLog({
        id: 'l3',
        date: '2025-08-12',
        type: CASHFLOW_TYPES.TAX_LARGE,
        category: '家電/維修',
        itemName: '臥室冷氣維修',
        twdAmount: 3200,
        note: 'Apple Pay',
        linkedAccountId: null,
      }),
      makeLog({
        id: 'l4',
        date: '2026-11-01',
        type: CASHFLOW_TYPES.FIXED_INCOME,
        category: '薪資',
        itemName: '十一月薪資',
        twdAmount: 85000,
        linkedAccountId: 'acc-ctbc',
      }),
      makeLog({
        id: 'l5',
        date: '2026-11-10',
        type: CASHFLOW_TYPES.INVESTMENT,
        category: '台股投資',
        itemName: '0050 定期定額',
        twdAmount: 15000,
        linkedAccountId: 'acc-ctbc',
      }),
      makeLog({
        id: 'l6-deleted',
        date: '2026-11-18',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '星巴克已刪除',
        twdAmount: 999,
        note: 'Apple Pay',
        deletedAt: '2026-11-19T00:00:00.000Z',
      }),
      makeLog({
        id: 'l7-isolated',
        date: '2026-11-15',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '東京拉麵 Apple',
        twdAmount: 420,
        note: 'Apple Pay',
        ledgerId: 'ledger-trip',
      }),
      makeLog({
        id: 'l8-side',
        date: '2026-11-12',
        type: CASHFLOW_TYPES.OTHER_INCOME,
        category: '副業/兼職',
        itemName: '設計接案 Apple',
        twdAmount: 12000,
        ledgerId: 'ledger-side',
      }),
    ];

    it('performs cross-month AND keyword matching, case-insensitive, excluding soft-deleted rows', () => {
      const filter: LedgerSearchFilter = {
        query: '  冷氣　維修 ',
        datePreset: 'all',
        anchorYm: '2026-11',
        ledgerScope: DEFAULT_LEDGER_ID,
      };
      const res = searchCashFlowLogs(logs, filter, sampleLedgers, DEFAULT_LEDGER_ID);
      expect(res.items.map((i) => i.id)).toEqual(['l2', 'l3']);
      expect(res.summary.count).toBe(2);
      expect(res.summary.totalExpense).toBe(7700);
      expect(res.summary.totalIncome).toBe(0);
      expect(res.summary.netCashFlow).toBe(-7700);
      expect(res.summary.hasActiveFilter).toBe(true);

      const res2 = searchCashFlowLogs(
        logs,
        { query: 'APPLE pay', datePreset: 'all', anchorYm: '2026-11', ledgerScope: DEFAULT_LEDGER_ID },
        sampleLedgers,
        DEFAULT_LEDGER_ID
      );
      expect(res2.items.map((i) => i.id)).toEqual(['l1', 'l3']);
    });

    it('strictly enforces ledger isolation (default vs net_worth vs all)', () => {
      const base: LedgerSearchFilter = {
        query: 'apple',
        datePreset: 'all',
        anchorYm: '2026-11',
        ledgerScope: DEFAULT_LEDGER_ID,
      };
      // default ledger only
      expect(searchCashFlowLogs(logs, base, sampleLedgers, DEFAULT_LEDGER_ID).items.map((i) => i.id)).toEqual([
        'l1',
        'l3',
      ]);
      // net_worth includes default + side (excludes isolated ledger-trip)
      expect(
        searchCashFlowLogs(logs, { ...base, ledgerScope: 'net_worth' }, sampleLedgers, DEFAULT_LEDGER_ID).items.map(
          (i) => i.id
        )
      ).toEqual(['l1', 'l8-side', 'l3']);
      // all includes isolated ledger-trip as well (still excludes deleted l6)
      expect(
        searchCashFlowLogs(logs, { ...base, ledgerScope: 'all' }, sampleLedgers, DEFAULT_LEDGER_ID).items.map(
          (i) => i.id
        )
      ).toEqual(['l1', 'l7-isolated', 'l8-side', 'l3']);
    });

    it('filters by types, category, linkedAccountId (including unlinked __none__), and amount range', () => {
      const res = searchCashFlowLogs(
        logs,
        {
          query: '',
          datePreset: 'all',
          anchorYm: '2026-11',
          types: [CASHFLOW_TYPES.TAX_LARGE, CASHFLOW_TYPES.DAILY_EXPENSE],
          linkedAccountId: '__none__',
          minAmount: 1000,
          maxAmount: 5000,
          ledgerScope: DEFAULT_LEDGER_ID,
        },
        sampleLedgers,
        DEFAULT_LEDGER_ID
      );
      expect(res.items.map((i) => i.id)).toEqual(['l3']);
      expect(res.summary.totalExpense).toBe(3200);

      // Swapped min/max still works gracefully
      const swapped = searchCashFlowLogs(
        logs,
        {
          query: '',
          datePreset: 'all',
          anchorYm: '2026-11',
          minAmount: 5000,
          maxAmount: 4000,
          ledgerScope: DEFAULT_LEDGER_ID,
        },
        sampleLedgers,
        DEFAULT_LEDGER_ID
      );
      expect(swapped.items.map((i) => i.id)).toEqual(['l2']);
    });

    it('computes summary totals consistent with aggregatePeriodMetrics', () => {
      const res = searchCashFlowLogs(
        logs,
        {
          query: '',
          datePreset: 'month',
          anchorYm: '2026-11',
          ledgerScope: DEFAULT_LEDGER_ID,
        },
        sampleLedgers,
        DEFAULT_LEDGER_ID
      );
      const metrics = aggregatePeriodMetrics(res.items, 0, false);
      expect(res.summary.totalIncome).toBe(metrics.totalIncome);
      expect(res.summary.totalExpense).toBe(metrics.totalConsumption);
      expect(res.summary.totalInvestment).toBe(metrics.investment);
      expect(res.summary.netCashFlow).toBe(metrics.freeCashFlow);
      expect(res.summary.savingsTotal).toBe(metrics.totalSavings);
      expect(res.summary.hasActiveFilter).toBe(false);
    });

    it('handles regex special characters and XSS payloads safely without throwing or ReDoS', () => {
      const xssLog = makeLog({
        id: 'l-xss',
        date: '2026-11-22',
        itemName: '<script>alert(1)</script> (test.*+?^$[])',
        note: 'a+b=c',
        twdAmount: 50,
      });
      const res = searchCashFlowLogs(
        [...logs, xssLog],
        {
          query: '<script> .*+?^$[]',
          datePreset: 'all',
          anchorYm: '2026-11',
          ledgerScope: DEFAULT_LEDGER_ID,
        },
        sampleLedgers,
        DEFAULT_LEDGER_ID
      );
      expect(res.items.map((i) => i.id)).toEqual(['l-xss']);
      expect(exportCashFlowCsv(res.items)).toContain('<script>alert(1)</script>');
      const roundtrip = parseCashFlowCsv(exportCashFlowCsv(res.items));
      expect(roundtrip).toHaveLength(1);
      expect(roundtrip[0].itemName).toBe('<script>alert(1)</script> (test.*+?^$[])');
    });

    it('detects active filter accurately and collects scoped categories', () => {
      expect(
        isLedgerSearchActive(
          { query: '', datePreset: 'month', anchorYm: '2026-11', ledgerScope: DEFAULT_LEDGER_ID },
          DEFAULT_LEDGER_ID
        )
      ).toBe(false);
      expect(
        isLedgerSearchActive(
          { query: '', datePreset: 'year', anchorYm: '2026-11', ledgerScope: DEFAULT_LEDGER_ID },
          DEFAULT_LEDGER_ID
        )
      ).toBe(true);
      expect(
        isLedgerSearchActive(
          { query: '', datePreset: 'month', anchorYm: '2026-11', ledgerScope: 'all' },
          DEFAULT_LEDGER_ID
        )
      ).toBe(true);

      const cats = collectAvailableCategories(logs, DEFAULT_LEDGER_ID, sampleLedgers);
      expect(cats).toContain('餐飲');
      expect(cats).toContain('家電/維修');
      expect(cats).not.toContain('副業/兼職');
    });

    it('v1.9.0 review #3: searches by linked savings account name and cross-ledger name', () => {
      const accountNameById = new Map([
        ['acc-esun', '玉山活存'],
        ['acc-ctbc', '中信薪轉'],
      ]);
      // Search by linked savings account name
      const byAcc = searchCashFlowLogs(
        logs,
        { query: '玉山活存', datePreset: 'all', anchorYm: '2026-11', ledgerScope: DEFAULT_LEDGER_ID },
        sampleLedgers,
        DEFAULT_LEDGER_ID,
        { accountNameById }
      );
      expect(byAcc.items.map((i) => i.id)).toEqual(['l1', 'l2']);

      // Search by ledger name in cross-ledger mode ('all')
      const byLedger = searchCashFlowLogs(
        logs,
        { query: '日本旅遊公帳', datePreset: 'all', anchorYm: '2026-11', ledgerScope: 'all' },
        sampleLedgers,
        DEFAULT_LEDGER_ID,
        { accountNameById }
      );
      expect(byLedger.items.map((i) => i.id)).toEqual(['l7-isolated']);
    });

    it('v1.9.0 review #2: includes 帳本 column when exporting cross-ledger CSV and keeps roundtrip safe', () => {
      const ledgerNameById = new Map(sampleLedgers.map((l) => [l.id, l.name]));
      const crossLogs = logs.filter((l) => l.id === 'l1' || l.id === 'l7-isolated');
      const csvWithLedger = exportCashFlowCsv(crossLogs, { ledgerNameById });
      const lines = csvWithLedger.replace(/^\uFEFF/, '').split('\n');
      expect(lines[0]).toContain(',帳本');
      expect(lines[1]).toContain(',個人主帳本');
      expect(lines[2]).toContain(',日本旅遊公帳');

      // Re-importing 12-column CSV still parses cleanly via parseCashFlowCsv
      const reparsed = parseCashFlowCsv(csvWithLedger);
      expect(reparsed).toHaveLength(2);

      // Single-ledger export without option keeps original 11-column header
      const csvDefault = exportCashFlowCsv(crossLogs);
      expect(csvDefault.replace(/^\uFEFF/, '').split('\n')[0].endsWith(',備註')).toBe(true);
    });
  });

  describe('splitHighlightSegments', () => {
    it('v1.9.0 review #4: aligns highlight indices accurately when toLowerCase() expands UTF-16 length (e.g. İ)', () => {
      const segs = splitHighlightSegments('İstanbul 早餐', ['早餐']);
      expect(segs).toEqual([
        { text: 'İstanbul ', match: false },
        { text: '早餐', match: true },
      ]);

      const multi = splitHighlightSegments('İzmir 與 İstanbul 咖啡', ['咖啡', 'zmir']);
      expect(multi).toEqual([
        { text: 'İ', match: false },
        { text: 'zmir', match: true },
        { text: ' 與 İstanbul ', match: false },
        { text: '咖啡', match: true },
      ]);
    });
    it('merges overlapping case-insensitive matches cleanly without RegExp or HTML', () => {
      const segs = splitHighlightSegments('Apple Pay at APPLE store', ['apple', 'pay']);
      expect(segs).toEqual([
        { text: 'Apple', match: true },
        { text: ' ', match: false },
        { text: 'Pay', match: true },
        { text: ' at ', match: false },
        { text: 'APPLE', match: true },
        { text: ' store', match: false },
      ]);

      // Overlapping tokens: "冷氣維修" and "氣維"
      const merged = splitHighlightSegments('客廳冷氣維修費', ['冷氣維修', '氣維']);
      expect(merged).toEqual([
        { text: '客廳', match: false },
        { text: '冷氣維修', match: true },
        { text: '費', match: false },
      ]);

      // Special characters treated as literal text (adjacent ranges merge cleanly; separated stay distinct)
      const literalAdjacent = splitHighlightSegments('<b>[a+b]</b>', ['<b>', '[a+b]']);
      expect(literalAdjacent).toEqual([
        { text: '<b>[a+b]', match: true },
        { text: '</b>', match: false },
      ]);

      const literalSeparated = splitHighlightSegments('<b> [a+b] </b>', ['<b>', '[a+b]']);
      expect(literalSeparated).toEqual([
        { text: '<b>', match: true },
        { text: ' ', match: false },
        { text: '[a+b]', match: true },
        { text: ' </b>', match: false },
      ]);
    });
  });
});
