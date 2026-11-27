import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { computeNetWorthSummary } from '../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../shared/constants';
import {
  computeRequiredMonthlyContribution,
  computeSuggestedFireTargetTwd,
  estimateTrailingMonthlyMetrics,
  evaluateFinancialGoal,
  projectMonthsToTarget,
} from '../shared/goals';
import { orderMutationsByDependencies } from '../shared/syncOrder';
import type {
  AssetItem,
  CashFlowLog,
  FinancialGoal,
  Ledger,
  SyncMutation,
  SyncRequest,
} from '../shared/types';
import { validateFinancialGoalInput } from '../shared/validation';
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

function makeGoal(overrides: Partial<FinancialGoal> & { id: string; name: string }): FinancialGoal {
  return {
    goalType: 'net_worth',
    targetAmount: 1_000_000,
    currency: 'TWD',
    linkedLedgerId: null,
    linkedAssetIds: [],
    currentManualAmount: 0,
    expectedAnnualReturnPct: 0,
    monthlyContributionOverride: null,
    fireSwrPct: null,
    targetDate: null,
    sortOrder: 1,
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('Phase 5 (v1.13.0) — Financial Goals & Achievement Date Projection', () => {
  describe('1. Projection Math & Boundary Safety', () => {
    it('handles r=0% linear, r=6% compounding, pure compounding, achieved, and unreachable safely', () => {
      // Linear r=0%: 400k -> 1,000k at 50k/mo = 12 months
      expect(projectMonthsToTarget(400_000, 1_000_000, 50_000, 0)).toEqual({
        status: 'projected',
        months: 12,
      });

      // Compounding r=6%: over a 2M target (linear = 32 months), compounding finishes strictly faster (~28 months)
      expect(projectMonthsToTarget(400_000, 2_000_000, 50_000, 0)).toEqual({
        status: 'projected',
        months: 32,
      });
      const comp = projectMonthsToTarget(400_000, 2_000_000, 50_000, 6);
      expect(comp.status).toBe('projected');
      expect(comp.months).toBeGreaterThan(20);
      expect(comp.months!).toBeLessThan(32);

      // Pure compounding (monthlyContribution = 0, positive starting balance, r = 6%)
      const pureComp = projectMonthsToTarget(500_000, 1_000_000, 0, 6);
      expect(pureComp.status).toBe('projected');
      expect(pureComp.months).toBeGreaterThanOrEqual(138);
      expect(pureComp.months).toBeLessThanOrEqual(142);

      // Already achieved
      expect(projectMonthsToTarget(1_200_000, 1_000_000, 0, 0)).toEqual({
        status: 'achieved',
        months: 0,
      });

      // Unreachable: zero contribution at 0% return, or negative contribution dragging balance down
      expect(projectMonthsToTarget(400_000, 1_000_000, 0, 0)).toEqual({
        status: 'unreachable',
        months: null,
      });
      expect(projectMonthsToTarget(-200_000, 1_000_000, 500, 6)).toEqual({
        status: 'unreachable',
        months: null,
      });
      // Exceeds 100-year cap
      expect(projectMonthsToTarget(0, 100_000_000, 100, 0)).toEqual({
        status: 'unreachable',
        months: null,
      });
    });

    it('computes required monthly contribution accurately for targetDate (r=0% and r=6%) and FIRE 4% rule', () => {
      // r=0%: 400k -> 1,000k in 12 months = 50,000/mo
      expect(computeRequiredMonthlyContribution(400_000, 1_000_000, 12, 0)).toBe(50_000);

      // r=6%: needs less than 50,000/mo
      const reqComp = computeRequiredMonthlyContribution(400_000, 1_000_000, 12, 6);
      expect(reqComp).not.toBeNull();
      expect(reqComp!).toBeGreaterThan(40_000);
      expect(reqComp!).toBeLessThan(50_000);

      // Already achieved -> 0; expired targetDate -> null
      expect(computeRequiredMonthlyContribution(1_000_000, 1_000_000, 12, 5)).toBe(0);
      expect(computeRequiredMonthlyContribution(400_000, 1_000_000, 0, 5)).toBeNull();

      // FIRE 4% rule: 600,000 annual spending -> 15,000,000 target
      expect(computeSuggestedFireTargetTwd(600_000, 4)).toBe(15_000_000);
      expect(computeSuggestedFireTargetTwd(0, 4)).toBeNull();
    });
  });

  describe('2. Valuation Modes (net_worth / fire / ledger_bucket / asset_bucket / manual)', () => {
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
        id: 'ledger-trip',
        name: '日本旅遊桶',
        includeInNetWorth: false,
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const assets: AssetItem[] = [
      {
        id: 'acc-main',
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '玉山活存',
        ticker: '',
        quantityOrAmount: 500_000,
        currency: 'TWD',
        unitPrice: 1,
        note: '',
        isLinkedSavings: true,
        ledgerId: DEFAULT_LEDGER_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'asset-jpy',
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '定存/現金',
        liquidity: '高流動',
        itemName: '日幣旅遊金',
        ticker: '',
        quantityOrAmount: 200_000, // 200,000 * 0.22 = 44,000 TWD
        currency: 'JPY',
        unitPrice: 1,
        note: '',
        ledgerId: 'ledger-trip',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const logs: CashFlowLog[] = [
      {
        id: 'cf-1',
        date: '2026-10-15',
        yearMonth: '2026-10',
        type: CASHFLOW_TYPES.FIXED_INCOME,
        category: '薪資',
        itemName: '月薪',
        amount: 100_000,
        currency: 'TWD',
        fxRate: 1,
        twdAmount: 100_000,
        source: '自動入帳',
        note: '',
        ledgerId: DEFAULT_LEDGER_ID,
        createdAt: '2026-10-15T00:00:00.000Z',
        updatedAt: '2026-10-15T00:00:00.000Z',
      },
      {
        id: 'cf-2',
        date: '2026-10-20',
        yearMonth: '2026-10',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '餐費',
        amount: 40_000,
        currency: 'TWD',
        fxRate: 1,
        twdAmount: 40_000,
        source: '手機記帳',
        note: '',
        ledgerId: DEFAULT_LEDGER_ID,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
    ];

    const fxSource = { usdTwdRate: 32.5, fxRates: { USD: 32.5, JPY: 0.22 } };
    const ctx = {
      assetItems: assets,
      cashflowLogs: logs,
      savingsAdjustments: [],
      stockTransactions: [],
      ledgers,
      fxSource,
      referenceDateYmd: '2026-11-27',
    };

    it('matches computeNetWorthSummary for net_worth & fire, isolates ledger_bucket, sums asset_bucket & manual', () => {
      const trailing = estimateTrailingMonthlyMetrics(logs, ledgers, '2026-11-27');
      expect(trailing.monthsCount).toBe(1);
      expect(trailing.avgMonthlySavingsTwd).toBe(60_000);
      expect(trailing.annualizedConsumptionTwd).toBe(480_000);

      const expectedNw = computeNetWorthSummary(assets, fxSource, 0, logs, [], [], undefined, ledgers, 'net_worth').netWorth;
      const gNw = evaluateFinancialGoal(
        makeGoal({ id: 'g1', name: '第一桶金', goalType: 'net_worth', targetAmount: 1_100_000 }),
        ctx,
        trailing
      );
      expect(gNw.currentAmountTwd).toBe(expectedNw); // 500,000 (excludes ledger-trip!)
      expect(gNw.isAutoContribution).toBe(true);
      expect(gNw.monthlyContributionTwd).toBe(60_000);
      expect(gNw.monthsToTarget).toBe(10); // (1,100k - 500k) / 60k = 10
      expect(gNw.estimatedAchieveYm).toBe('2027-09');

      // FIRE goal suggests 25x annualized consumption (480k * 25 = 12,000,000)
      const gFire = evaluateFinancialGoal(
        makeGoal({ id: 'g2', name: 'FIRE', goalType: 'fire', targetAmount: 12_000_000, fireSwrPct: 4 }),
        ctx,
        trailing
      );
      expect(gFire.suggestedFireTargetTwd).toBe(12_000_000);
      expect(gFire.currentAmountTwd).toBe(expectedNw);

      // Independent travel ledger bucket isolates strictly to ledger-trip (44,000 TWD)
      const gLedger = evaluateFinancialGoal(
        makeGoal({
          id: 'g3',
          name: '日本旅費',
          goalType: 'ledger_bucket',
          linkedLedgerId: 'ledger-trip',
          targetAmount: 100_000,
          monthlyContributionOverride: 10_000,
          targetDate: '2027-05', // 6 months away
        }),
        ctx,
        trailing
      );
      expect(gLedger.currentAmountTwd).toBe(44_000);
      expect(gLedger.monthsToTarget).toBe(6); // ceil(56k / 10k) = 6
      expect(gLedger.requiredMonthlyTwd).toBe(Math.ceil(56_000 / 6));
      expect(gLedger.isOnTrack).toBe(true);

      // Asset bucket with one deleted asset -> sums active and warns missing
      const gAsset = evaluateFinancialGoal(
        makeGoal({
          id: 'g4',
          name: '雙資產桶',
          goalType: 'asset_bucket',
          linkedAssetIds: ['acc-main', 'asset-jpy', 'deleted-asset-id'],
          targetAmount: 600_000,
        }),
        ctx,
        trailing
      );
      expect(gAsset.currentAmountTwd).toBe(544_000);
      expect(gAsset.missingReferenceWarning).toMatch(/1 筆/);

      // Manual JPY goal converts via fxSource
      const gManual = evaluateFinancialGoal(
        makeGoal({
          id: 'g5',
          name: '日圓存款目標',
          goalType: 'manual',
          currency: 'JPY',
          currentManualAmount: 100_000,
          targetAmount: 500_000,
        }),
        ctx,
        trailing
      );
      expect(gManual.currentAmountTwd).toBe(22_000);
      expect(gManual.targetAmountTwd).toBe(110_000);
    });
  });

  describe('3. Validation & Offline Dependency Ordering', () => {
    it('validates goal fields strictly and orders referenced ledger/asset before financial_goal', () => {
      expect(() =>
        validateFinancialGoalInput({ name: '', goalType: 'net_worth', targetAmount: 100_000 })
      ).toThrow(/名稱/);
      expect(() =>
        validateFinancialGoalInput({ name: 'X', goalType: 'net_worth', targetAmount: 0 })
      ).toThrow(/大於 0/);
      expect(() =>
        validateFinancialGoalInput({ name: 'X', goalType: 'ledger_bucket', targetAmount: 100, linkedLedgerId: '' })
      ).toThrow(/帳本/);
      expect(() =>
        validateFinancialGoalInput({ name: 'X', goalType: 'asset_bucket', targetAmount: 100, linkedAssetIds: [] })
      ).toThrow(/資產/);
      expect(() =>
        validateFinancialGoalInput({ name: 'X', goalType: 'net_worth', targetAmount: 100, expectedAnnualReturnPct: 50 })
      ).toThrow(/報酬率/);
      expect(() =>
        validateFinancialGoalInput({ name: 'X', goalType: 'net_worth', targetAmount: 100, targetDate: '2026-13' })
      ).toThrow(/範圍/);

      // Dependency order: goal created before its referenced asset in array -> asset moves first
      const unordered: SyncMutation[] = [
        {
          mutationId: 'm-goal',
          entity: 'financial_goal',
          op: 'upsert',
          recordId: 'g-1',
          clientTimestamp: '2026-11-27T00:00:00Z',
          payload: { name: 'G', goalType: 'asset_bucket', linkedAssetIds: ['a-new'] },
        },
        {
          mutationId: 'm-asset',
          entity: 'asset',
          op: 'upsert',
          recordId: 'a-new',
          clientTimestamp: '2026-11-27T00:00:01Z',
          payload: { itemName: '新活存' },
        },
      ];
      const ordered = orderMutationsByDependencies(unordered);
      expect(ordered.map((m) => m.mutationId)).toEqual(['m-asset', 'm-goal']);
    });
  });

  describe('4. Full-Stack D1 Sync, Optimistic Locking, Pre-0021 Guard, Backup & D1 Budget', () => {
    it('syncs financial_goals CRUD, detects conflicts, enforces refs, stays within D1 budget, and survives backup/restore', async () => {
      const rawD1 = createTestD1();
      await seedUser(rawD1, 'u-goal');
      const counting = createCountingD1(rawD1);

      const db1 = new LocalFinanceDB(`goal-1-${crypto.randomUUID()}`);
      const eng1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(counting.db, 'u-goal'),
        isOnline: () => true,
      });
      await eng1.init();
      counting.reset();
      await eng1.syncNow(true);
      expect(counting.count()).toBeLessThanOrEqual(20); // well below 50-query free limit

      const created = await eng1.saveFinancialGoal({
        name: 'FIRE 退休金',
        goalType: 'fire',
        targetAmount: 15_000_000,
        currency: 'TWD',
        expectedAnnualReturnPct: 6,
        fireSwrPct: 4,
        targetDate: '2036-12',
        note: '4% 法則',
      });
      counting.reset();
      const pushRes = await eng1.syncNow();
      expect(pushRes.ok).toBe(true);
      expect(counting.count()).toBeLessThanOrEqual(20);

      // Device 2 pulls the synced goal
      const db2 = new LocalFinanceDB(`goal-2-${crypto.randomUUID()}`);
      const eng2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(rawD1, 'u-goal'),
        isOnline: () => true,
      });
      await eng2.init();
      await eng2.syncNow(true);
      expect(eng2.getSnapshot().financialGoals).toHaveLength(1);
      expect(eng2.getSnapshot().financialGoals?.[0].name).toBe('FIRE 退休金');

      // Concurrent edit triggers optimistic lock conflict
      await eng1.saveFinancialGoal({
        id: created.id,
        name: 'FIRE 退休金 (設備1)',
        goalType: 'fire',
        targetAmount: 16_000_000,
        currency: 'TWD',
        expectedAnnualReturnPct: 6,
        fireSwrPct: 4,
      });
      await eng1.syncNow();

      await eng2.saveFinancialGoal({
        id: created.id,
        name: 'FIRE 退休金 (設備2)',
        goalType: 'fire',
        targetAmount: 18_000_000,
        currency: 'TWD',
        expectedAnnualReturnPct: 5,
        fireSwrPct: 4,
      });
      await eng2.syncNow();
      expect(eng2.getConflicts().length).toBeGreaterThanOrEqual(1);

      // Export & replace restore preserves financialGoals
      const exported = await exportFullSnapshot(rawD1, 'u-goal');
      expect(exported.financialGoals).toHaveLength(1);
      expect(exported.financialGoals?.[0].targetAmount).toBe(16_000_000);

      await importFullSnapshot(rawD1, 'u-goal', exported, 'replace');
      const restored = await exportFullSnapshot(rawD1, 'u-goal');
      expect(restored.financialGoals).toHaveLength(1);
      expect(restored.financialGoals?.[0].name).toBe('FIRE 退休金 (設備1)');

      // Referential integrity: goal referencing non-existent asset is rejected
      const badRefRes = await processSyncRequest(rawD1, 'u-goal', {
        sinceSeq: 0,
        clientEpoch: 2,
        refsOrdered: true,
        mutations: [
          {
            mutationId: 'm-bad-asset-ref',
            entity: 'financial_goal',
            op: 'upsert',
            recordId: 'g-bad-ref',
            clientTimestamp: '2026-11-27T05:00:00.000Z',
            baseVersion: null,
            payload: {
              name: '無效資產目標',
              goalType: 'asset_bucket',
              targetAmount: 500_000,
              currency: 'TWD',
              linkedAssetIds: ['non-existent-asset'],
            },
          },
        ],
      });
      expect(badRefRes.rejected).toHaveLength(1);
      expect(badRefRes.rejected[0].reason).toMatch(/不存在|已刪除/);

      // Soft delete syncs cleanly
      await eng1.syncNow(true);
      await eng1.deleteFinancialGoal(created.id);
      await eng1.syncNow();
      const afterDel = await exportFullSnapshot(rawD1, 'u-goal');
      expect(afterDel.financialGoals).toEqual([]);
    });

    it('gracefully handles pre-0021 DB: pull returns [], write rejects with upgrade hint, legacy import succeeds', async () => {
      const dbPre21 = createTestD1({ stopBefore: '0021' });
      await seedUser(dbPre21, 'u-pre21');

      // Pull works cleanly without crashing on missing table
      const pullRes = await processSyncRequest(dbPre21, 'u-pre21', {
        sinceSeq: 0,
        clientEpoch: 1,
        mutations: [],
      });
      expect(pullRes.ok).toBe(true);
      expect(pullRes.delta?.financialGoals).toEqual([]);

      // Writing a financial_goal on pre-0021 DB rejects cleanly with upgrade message
      const writeRes = await processSyncRequest(dbPre21, 'u-pre21', {
        sinceSeq: 0,
        clientEpoch: 1,
        mutations: [
          {
            mutationId: 'm-goal-pre21',
            entity: 'financial_goal',
            op: 'upsert',
            recordId: 'g-pre21',
            clientTimestamp: '2026-11-27T06:00:00.000Z',
            baseVersion: null,
            payload: {
              name: '第一桶金',
              goalType: 'net_worth',
              targetAmount: 1_000_000,
              currency: 'TWD',
            },
          },
        ],
      });
      expect(writeRes.ackedMutationIds).not.toContain('m-goal-pre21');
      expect(writeRes.rejected).toHaveLength(1);
      expect(writeRes.rejected[0].reason).toMatch(/尚未完成升級|資料庫遷移/);

      // Backup containing financialGoals rejects on pre-0021; backup without financialGoals succeeds
      const exp = await exportFullSnapshot(dbPre21, 'u-pre21');
      await expect(
        importFullSnapshot(
          dbPre21,
          'u-pre21',
          {
            ...exp,
            financialGoals: [makeGoal({ id: 'g1', name: '目標' })],
          },
          'replace'
        )
      ).rejects.toThrow(/尚未完成升級|資料庫遷移/);

      await expect(
        importFullSnapshot(dbPre21, 'u-pre21', { ...exp, financialGoals: [] }, 'replace')
      ).resolves.toBeTruthy();
    });
  });
});
