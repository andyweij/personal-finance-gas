import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  aggregatePeriodMetrics,
  computeOverviewBreakdownGroups,
} from '../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID, WEBAPP_CATEGORY_MAP } from '../shared/constants';
import {
  buildAutocompleteSuggestions,
  resolveQuickTemplateForEntry,
} from '../shared/autocomplete';
import {
  getEffectiveCategoriesForType,
  normalizeCustomCategories,
  normalizeQuickTemplates,
  validateQuickTemplateInput,
} from '../shared/validation';
import type {
  AssetItem,
  CashFlowLog,
  Ledger,
  QuickEntryTemplate,
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

function makeLog(overrides: Partial<CashFlowLog> & { id: string }): CashFlowLog {
  const date = overrides.date ?? '2026-11-20';
  const amount = overrides.amount ?? 100;
  return {
    date,
    yearMonth: date.slice(0, 7),
    type: CASHFLOW_TYPES.DAILY_EXPENSE,
    category: '餐飲',
    itemName: '午餐',
    amount,
    currency: 'TWD',
    fxRate: 1,
    twdAmount: overrides.twdAmount ?? amount,
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

describe('Phase 3 (v1.11.0) — Custom Categories, Quick Templates & Autocomplete', () => {
  describe('1. Custom Categories Normalization & Overview Breakdown Conservation', () => {
    it('normalizes, deduplicates, truncates, excludes defaults, and caps at 30 per type', () => {
      const many = Array.from({ length: 40 }, (_, i) => `自訂分類_${i}`);
      const normalized = normalizeCustomCategories({
        [CASHFLOW_TYPES.DAILY_EXPENSE]: ['餐飲', '  寵物  ', '寵物', '', '超長分類名稱超過二十個字元應該要被自動截斷掉才對', ...many],
        不存在的類型: ['測試'],
      });
      expect(normalized['不存在的類型']).toBeUndefined();
      const daily = normalized[CASHFLOW_TYPES.DAILY_EXPENSE];
      expect(daily).toHaveLength(30);
      expect(daily).not.toContain('餐飲'); // built-in default excluded from custom list
      expect(daily[0]).toBe('寵物');
      expect(daily[1].length).toBeLessThanOrEqual(20);

      const effective = getEffectiveCategoriesForType(CASHFLOW_TYPES.DAILY_EXPENSE, normalized);
      expect(effective.slice(0, WEBAPP_CATEGORY_MAP['日常花費'].length)).toEqual(WEBAPP_CATEGORY_MAP['日常花費']);
      expect(effective).toContain('寵物');
    });

    it('preserves 100% total conservation in overview breakdown when logs use custom categories', () => {
      const logs: CashFlowLog[] = [
        makeLog({ id: 'c1', date: '2026-11-05', category: '寵物', itemName: '貓砂', twdAmount: 650 }),
        makeLog({ id: 'c2', date: '2026-11-12', category: '健身', itemName: '教練課', twdAmount: 1800 }),
        makeLog({ id: 'c3', date: '2026-11-18', category: '餐飲', itemName: '晚餐', twdAmount: 250 }),
      ];
      const monthly = aggregatePeriodMetrics(logs, 0, false);
      const groups = computeOverviewBreakdownGroups(logs, logs, [], monthly, monthly);
      const dailyGroup = groups.find((g) => g.key === 'daily_expense')!;
      expect(dailyGroup.monthlyAmount).toBe(2700);
      const childSum = dailyGroup.children.reduce((s, c) => s + c.monthlyAmount, 0);
      expect(childSum).toBe(2700);
      expect(dailyGroup.children.map((c) => c.label)).toEqual(['健身', '寵物', '餐飲']);
    });
  });

  describe('2. Quick Entry Templates Validation & Stale Reference Fallback', () => {
    it('validates template inputs and enforces oneClick requires positive amount', () => {
      const ok = validateQuickTemplateInput({
        label: '早安咖啡',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '美式咖啡',
        amount: 65,
        currency: 'TWD',
        oneClick: true,
      });
      expect(ok.amount).toBe(65);
      expect(ok.oneClick).toBe(true);

      expect(() =>
        validateQuickTemplateInput({
          label: '空白金額直記',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '咖啡',
          amount: null,
          oneClick: true,
        })
      ).toThrow(/金額/);

      expect(normalizeQuickTemplates('bad-json')).toEqual([]);
    });

    it('gracefully falls back when template linkedAccountId or ledgerId was deleted', () => {
      const ledgers: Ledger[] = [
        {
          id: DEFAULT_LEDGER_ID,
          name: '個人主帳本',
          includeInNetWorth: true,
          note: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'ledger-deleted',
          name: '已刪帳本',
          includeInNetWorth: false,
          note: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: '2026-06-01T00:00:00.000Z',
        },
      ];
      const assets: AssetItem[] = [
        {
          id: 'acc-default',
          updateMode: '手動快照',
          majorType: '資產',
          subCategory: '活存',
          liquidity: '高流動',
          itemName: '玉山活存',
          ticker: '',
          quantityOrAmount: 10000,
          currency: 'TWD',
          unitPrice: 1,
          note: '',
          isLinkedSavings: true,
          isDefaultSavings: true,
          ledgerId: DEFAULT_LEDGER_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'acc-deleted',
          updateMode: '手動快照',
          majorType: '資產',
          subCategory: '活存',
          liquidity: '高流動',
          itemName: '舊活存',
          ticker: '',
          quantityOrAmount: 0,
          currency: 'TWD',
          unitPrice: 1,
          note: '',
          isLinkedSavings: true,
          ledgerId: DEFAULT_LEDGER_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: '2026-05-01T00:00:00.000Z',
        },
      ];

      const tpl: QuickEntryTemplate = {
        id: 't1',
        label: '加油',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '交通',
        itemName: '中油加油',
        amount: 1200,
        currency: 'TWD',
        linkedAccountId: 'acc-deleted',
        ledgerId: 'ledger-deleted',
        note: '',
      };

      const resolved = resolveQuickTemplateForEntry(tpl, DEFAULT_LEDGER_ID, ledgers, assets);
      expect(resolved.ledgerId).toBe(DEFAULT_LEDGER_ID);
      expect(resolved.linkedAccountId).toBe('acc-default');
      expect(resolved.fallbackLedger).toBe(true);
      expect(resolved.fallbackAccount).toBe(true);
    });
  });

  describe('3. Autocomplete Ranking', () => {
    const logs: CashFlowLog[] = [
      makeLog({ id: 'a1', date: '2026-11-26', category: '餐飲', itemName: '星巴克拿鐵', amount: 155 }),
      makeLog({ id: 'a2', date: '2026-11-24', category: '餐飲', itemName: '星巴克拿鐵', amount: 150 }),
      makeLog({ id: 'a3', date: '2026-11-22', category: '餐飲', itemName: '星巴克拿鐵', amount: 155 }),
      makeLog({ id: 'a4', date: '2025-01-10', category: '餐飲', itemName: '星巴克舊杯子', amount: 800 }),
      makeLog({ id: 'a5', date: '2026-11-25', category: '餐飲', itemName: '星巴克已刪', amount: 999, deletedAt: '2026-11-26T00:00:00.000Z' }),
      makeLog({ id: 'a6', date: '2026-11-25', category: '餐飲', itemName: '星巴克東京', amount: 500, ledgerId: 'ledger-trip' }),
    ];

    it('ranks frequent + recent + active-ledger items first, excludes deleted rows, and handles regex chars safely', () => {
      const suggestions = buildAutocompleteSuggestions(logs, {
        query: '星巴克',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        activeLedgerId: DEFAULT_LEDGER_ID,
        todayYmd: '2026-11-27',
        limit: 5,
      });
      expect(suggestions.map((s) => s.itemName)).not.toContain('星巴克已刪');
      expect(suggestions[0].itemName).toBe('星巴克拿鐵');
      expect(suggestions[0].suggestedAmount).toBe(155); // latest amount
      expect(suggestions[0].count).toBe(3);

      // Regex special chars do not throw
      expect(
        buildAutocompleteSuggestions(logs, { query: '.*+?^$[]()', todayYmd: '2026-11-27' })
      ).toEqual([]);
    });
  });

  describe('4. Sync, Backup/Restore & D1 Query Budget', () => {
    it('syncs customCategories & quickTemplates via app_settings with +0 extra D1 queries and survives JSON backup/restore', async () => {
      const rawD1 = createTestD1();
      await seedUser(rawD1, 'u-p3');
      const counting = createCountingD1(rawD1);

      const db1 = new LocalFinanceDB(`p3-1-${crypto.randomUUID()}`);
      const eng1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(counting.db, 'u-p3'),
        isOnline: () => true,
      });
      await eng1.init();
      counting.reset();
      await eng1.syncNow(true);
      expect(counting.count()).toBeLessThanOrEqual(20);

      await eng1.saveCustomCategories({ [CASHFLOW_TYPES.DAILY_EXPENSE]: ['寵物', '健身'] });
      const tpl: QuickEntryTemplate = {
        id: 'tpl-coffee',
        label: '咖啡',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '冰美式',
        amount: 65,
        currency: 'TWD',
        linkedAccountId: null,
        ledgerId: DEFAULT_LEDGER_ID,
        note: '7-11',
        oneClick: true,
      };
      await eng1.saveQuickTemplates([tpl]);

      counting.reset();
      const res = await eng1.syncNow();
      expect(res.ok).toBe(true);
      expect(counting.count()).toBeLessThanOrEqual(10);

      // Device 2 pulls both fields
      const db2 = new LocalFinanceDB(`p3-2-${crypto.randomUUID()}`);
      const eng2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(rawD1, 'u-p3'),
        isOnline: () => true,
      });
      await eng2.init();
      await eng2.syncNow(true);
      expect(eng2.getSnapshot().settings.customCategories).toEqual({
        [CASHFLOW_TYPES.DAILY_EXPENSE]: ['寵物', '健身'],
      });
      expect(eng2.getSnapshot().settings.quickTemplates).toEqual([tpl]);

      // Export & replace restore preserves both; legacy backup without them imports cleanly
      const exported = await exportFullSnapshot(rawD1, 'u-p3');
      expect(exported.settings.customCategories?.[CASHFLOW_TYPES.DAILY_EXPENSE]).toEqual(['寵物', '健身']);
      expect(exported.settings.quickTemplates).toHaveLength(1);

      await importFullSnapshot(rawD1, 'u-p3', exported, 'replace');
      const afterRestore = await exportFullSnapshot(rawD1, 'u-p3');
      expect(afterRestore.settings.quickTemplates).toEqual([tpl]);

      await importFullSnapshot(
        rawD1,
        'u-p3',
        {
          ...exported,
          settings: {
            ...exported.settings,
            customCategories: undefined,
            quickTemplates: undefined,
          },
        },
        'replace'
      );
      const afterLegacy = await exportFullSnapshot(rawD1, 'u-p3');
      expect(afterLegacy.settings.customCategories).toEqual({});
      expect(afterLegacy.settings.quickTemplates).toEqual([]);
    });
  });

  describe('5. v1.11.0 Review Fixes Regression Tests (#1, #2, #3, 5-7)', () => {
    it('#1: rejects quick templates with unsupported quick-entry types (固定收入 / 訂閱扣款)', () => {
      for (const badType of [CASHFLOW_TYPES.FIXED_INCOME, CASHFLOW_TYPES.SUBSCRIPTION]) {
        expect(() =>
          validateQuickTemplateInput({
            label: '不支援類型',
            type: badType,
            category: '其他',
            itemName: '測試',
            amount: 1000,
          })
        ).toThrow(/不支援/);
      }

      // Valid quick-entry types still pass
      for (const okType of [
        CASHFLOW_TYPES.DAILY_EXPENSE,
        CASHFLOW_TYPES.TAX_LARGE,
        CASHFLOW_TYPES.OTHER_INCOME,
        CASHFLOW_TYPES.INVESTMENT,
        CASHFLOW_TYPES.FIXED_EXPENSE,
      ]) {
        const res = validateQuickTemplateInput({
          label: `測試-${okType}`,
          type: okType,
          category: '其他',
          itemName: '測試',
          amount: 100,
        });
        expect(res.type).toBe(okType);
      }
    });

    it('#2: filters autocomplete suggestions strictly by current type so income items never leak into daily expenses', () => {
      const mixedLogs: CashFlowLog[] = [
        makeLog({
          id: 'inc-1',
          date: '2026-11-26',
          type: CASHFLOW_TYPES.OTHER_INCOME,
          category: '獎金',
          itemName: '年終獎金',
          amount: 50000,
        }),
        makeLog({
          id: 'exp-1',
          date: '2026-11-20',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '年糕火鍋',
          amount: 450,
        }),
      ];

      const dailyResults = buildAutocompleteSuggestions(mixedLogs, {
        query: '年',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        activeLedgerId: DEFAULT_LEDGER_ID,
        todayYmd: '2026-11-27',
      });
      expect(dailyResults).toHaveLength(1);
      expect(dailyResults[0].itemName).toBe('年糕火鍋');
      expect(dailyResults[0].category).toBe('餐飲');
      expect(dailyResults[0].suggestedAmount).toBe(450);

      const incomeResults = buildAutocompleteSuggestions(mixedLogs, {
        query: '年',
        type: CASHFLOW_TYPES.OTHER_INCOME,
        activeLedgerId: DEFAULT_LEDGER_ID,
        todayYmd: '2026-11-27',
      });
      expect(incomeResults).toHaveLength(1);
      expect(incomeResults[0].itemName).toBe('年終獎金');
      expect(incomeResults[0].category).toBe('獎金');
      expect(incomeResults[0].suggestedAmount).toBe(50000);
    });

    it('#3: rejects customCategories / quickTemplates on pre-0019 DB instead of silently dropping', async () => {
      const dbPre19 = createTestD1({ stopBefore: '0019' });
      await seedUser(dbPre19, 'u-pre19');

      const res = await processSyncRequest(dbPre19, 'u-pre19', {
        sinceSeq: 0,
        clientEpoch: 1,
        mutations: [
          {
            mutationId: 'm-cat-pre19',
            entity: 'settings',
            op: 'upsert',
            recordId: '1',
            clientTimestamp: '2026-11-27T02:00:00.000Z',
            baseVersion: 1,
            payload: {
              monthlyDailyBudget: 30000,
              customCategories: { [CASHFLOW_TYPES.DAILY_EXPENSE]: ['寵物'] },
            },
          },
        ],
      });
      expect(res.ackedMutationIds).not.toContain('m-cat-pre19');
      expect(res.rejected).toHaveLength(1);
      expect(res.rejected[0].reason).toMatch(/尚未完成升級|資料庫遷移/);
    });

    it('5-7: fallback IDs in normalizeQuickTemplates never collide with explicit IDs and never drop valid templates', () => {
      const normalized = normalizeQuickTemplates([
        {
          // missing id -> must skip tpl-1 & tpl-2 because later items explicitly use them
          label: '無ID一',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '咖啡',
          amount: 60,
        },
        {
          id: 'tpl-1',
          label: '明確一',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '交通',
          itemName: '捷運',
          amount: 35,
        },
        {
          id: 'tpl-2',
          label: '明確二',
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '餐飲',
          itemName: '便當',
          amount: 120,
        },
      ]);
      expect(normalized).toHaveLength(3);
      expect(new Set(normalized.map((t) => t.id)).size).toBe(3);
      expect(normalized.map((t) => t.label)).toEqual(['無ID一', '明確一', '明確二']);
    });
  });
});
