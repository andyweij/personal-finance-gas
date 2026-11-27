import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  aggregatePeriodMetrics,
  computeAllSavingsSummary,
  computeNetWorthSummary,
  computeSavingsAccountSummary,
} from '../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../shared/constants';
import {
  computeAllCreditCardsSummary,
  computeBillingCycleWindow,
  computeCreditCardSummary,
  computeInstallmentPlanProgress,
  computeInstallmentScheduleAmounts,
} from '../shared/creditCard';
import { orderMutationsByDependencies } from '../shared/syncOrder';
import type { SyncMutation, SyncRequest } from '../shared/types';
import { validateAssetInput, validateInstallmentPlanInput } from '../shared/validation';
import { runMonthlyInstallmentsD1, runScheduledAutomation } from '../worker/automation';
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

describe('Phase 7 (v1.15.0): Credit Card Billing Cycles & Installment Plans', () => {
  describe('1. Billing Cycle Boundaries & Installment Schedule Math', () => {
    it('computes statement closing/due windows accurately across closing day, leap Feb, and year rollover', () => {
      // Closing 15th, due 1st: on closing day 2026-11-15 -> still in 10-16..11-15 unbilled cycle
      const onClose = computeBillingCycleWindow(15, 1, '2026-11-15');
      expect(onClose).toEqual({
        statementStart: '2026-09-16',
        statementEnd: '2026-10-15',
        paymentDueDate: '2026-11-01',
        unbilledStart: '2026-10-16',
        unbilledEnd: '2026-11-15',
      });

      // Day after closing (2026-11-16) -> 10-16..11-15 becomes closed statement, due 2026-12-01
      const afterClose = computeBillingCycleWindow(15, 1, '2026-11-16');
      expect(afterClose).toEqual({
        statementStart: '2026-10-16',
        statementEnd: '2026-11-15',
        paymentDueDate: '2026-12-01',
        unbilledStart: '2026-11-16',
        unbilledEnd: '2026-12-15',
      });

      // Cross-year rollover: 2026-12-20 with close 15th, due 5th -> due 2027-01-05
      const crossYear = computeBillingCycleWindow(15, 5, '2026-12-20');
      expect(crossYear.statementEnd).toBe('2026-12-15');
      expect(crossYear.paymentDueDate).toBe('2027-01-05');
      expect(crossYear.unbilledEnd).toBe('2027-01-15');

      // Leap year 2024 Feb with closing 31st -> clamped to 2024-02-29
      const leapFeb = computeBillingCycleWindow(31, 15, '2024-03-05');
      expect(leapFeb.statementEnd).toBe('2024-02-29');
      expect(leapFeb.paymentDueDate).toBe('2024-03-15');
      expect(leapFeb.unbilledStart).toBe('2024-03-01');
      expect(leapFeb.unbilledEnd).toBe('2024-03-31');

      // Non-leap 2026 Feb with closing 31st -> clamped to 2026-02-28
      const nonLeapFeb = computeBillingCycleWindow(31, 15, '2026-03-02');
      expect(nonLeapFeb.statementEnd).toBe('2026-02-28');

      // Same-month due day (close 10th, due 25th)
      const sameMonthDue = computeBillingCycleWindow(10, 25, '2026-11-12');
      expect(sameMonthDue.statementEnd).toBe('2026-11-10');
      expect(sameMonthDue.paymentDueDate).toBe('2026-11-25');
    });

    it('conserves 100% total for installment schedules across TWD & USD with remainder on period 1', () => {
      const s3 = computeInstallmentScheduleAmounts(10_000, 3, 'TWD');
      expect(s3).toEqual([3334, 3333, 3333]);
      expect(s3.reduce((a, b) => a + b, 0)).toBe(10_000);

      const s6 = computeInstallmentScheduleAmounts(10_000, 6, 'TWD');
      expect(s6).toEqual([1670, 1666, 1666, 1666, 1666, 1666]);
      expect(s6.reduce((a, b) => a + b, 0)).toBe(10_000);

      const sUsd = computeInstallmentScheduleAmounts(100, 3, 'USD');
      expect(sUsd).toEqual([33.34, 33.33, 33.33]);
      expect(Math.round(sUsd.reduce((a, b) => a + b, 0) * 100) / 100).toBe(100);

      const s24 = computeInstallmentScheduleAmounts(49_999, 24, 'TWD');
      expect(s24).toHaveLength(24);
      expect(s24.reduce((a, b) => a + b, 0)).toBe(49_999);
    });

    it('validates credit card & installment fields and orders cardAccountId before installment_plan', () => {
      expect(() =>
        validateAssetInput({
          itemName: '測試卡',
          quantityOrAmount: 0,
          isCreditCard: true,
          creditBillingDay: 32,
        })
      ).toThrow(/結帳日/);

      expect(() =>
        validateInstallmentPlanInput({
          itemName: '手機',
          totalAmount: 30_000,
          totalInstallments: 1,
          startYm: '2026-11',
        })
      ).toThrow(/2～60/);

      const unordered: SyncMutation[] = [
        {
          mutationId: 'm-inst',
          entity: 'installment_plan',
          op: 'upsert',
          recordId: 'inst-1',
          clientTimestamp: '2026-11-27T00:00:00Z',
          payload: { cardAccountId: 'card-new', ledgerId: DEFAULT_LEDGER_ID },
        },
        {
          mutationId: 'm-card',
          entity: 'asset',
          op: 'upsert',
          recordId: 'card-new',
          clientTimestamp: '2026-11-27T00:00:01Z',
          payload: { itemName: '中信卡', isCreditCard: true },
        },
      ];
      expect(orderMutationsByDependencies(unordered).map((m) => m.mutationId)).toEqual([
        'm-card',
        'm-inst',
      ]);
    });
  });

  describe('2. Exact Accounting Conservation: Swipe, Refund, Bill Payment, Reconcile & Net Worth', () => {
    it('excludes credit cards from savings/high-liquidity, counts spending once, conserves net worth on bill payment, and supports refund + reconcile', async () => {
      const db = new LocalFinanceDB(`cc-acct-${crypto.randomUUID()}`);
      const eng = new SyncEngine(db, { isOnline: () => false });
      await eng.init();

      const bank = await eng.saveAsset({
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '玉山活存',
        quantityOrAmount: 100_000,
        currency: 'TWD',
        unitPrice: 1,
        isLinkedSavings: true,
        isDefaultSavings: true,
        balanceAnchorDate: '2026-11-01',
        ledgerId: DEFAULT_LEDGER_ID,
      });

      const card = await eng.saveAsset({
        updateMode: '手動快照',
        majorType: '負債',
        subCategory: '信用卡',
        liquidity: '負債',
        itemName: '中信 Line Pay',
        quantityOrAmount: 0,
        currency: 'TWD',
        unitPrice: 1,
        isCreditCard: true,
        creditBillingDay: 15,
        creditDueDay: 1,
        creditLimit: 100_000,
        balanceAnchorDate: '2026-11-01',
        ledgerId: DEFAULT_LEDGER_ID,
      });

      // 1) Swipe NT$ 3,000 on 11/10 (falls in closed statement 10/16..11/15 when viewed on 11/25)
      await eng.addCashFlow({
        date: '2026-11-10',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '餐廳刷卡',
        amount: 3000,
        currency: 'TWD',
        linkedAccountId: card.id,
        ledgerId: DEFAULT_LEDGER_ID,
      });
      // 2) Swipe NT$ 2,000 on 11/20 (unbilled cycle 11/16..12/15)
      await eng.addCashFlow({
        date: '2026-11-20',
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '日用品',
        itemName: '超市刷卡',
        amount: 2000,
        currency: 'TWD',
        linkedAccountId: card.id,
        ledgerId: DEFAULT_LEDGER_ID,
      });
      // 3) Refund / cashback NT$ 500 on 11/22
      await eng.addCashFlow({
        date: '2026-11-22',
        type: CASHFLOW_TYPES.OTHER_INCOME,
        category: '其他',
        itemName: '刷卡退刷',
        amount: 500,
        currency: 'TWD',
        linkedAccountId: card.id,
        ledgerId: DEFAULT_LEDGER_ID,
      });

      const snap1 = eng.getSnapshot();
      // High-liquidity savings MUST NOT include credit card
      const sav1 = computeAllSavingsSummary(
        snap1.assetItems,
        snap1.cashflowLogs,
        snap1.savingsAdjustments,
        snap1.settings
      );
      expect(sav1.accounts).toHaveLength(1);
      expect(sav1.totalSavingsTwd).toBe(100_000);

      const cardSum1 = computeCreditCardSummary(
        snap1.assetItems.find((a) => a.id === card.id)!,
        snap1.cashflowLogs,
        snap1.savingsAdjustments,
        snap1.installmentPlans || [],
        snap1.settings,
        '2026-11-25'
      );
      expect(cardSum1.currentBalanceTwd).toBe(4500); // 3000 + 2000 - 500
      expect(cardSum1.billedUnpaidTwd).toBe(3000);
      expect(cardSum1.unbilledChargesTwd).toBe(1500); // 2000 - 500
      expect(cardSum1.utilizationPct).toBe(4.5);

      const nw1 = computeNetWorthSummary(
        snap1.assetItems,
        snap1.settings,
        0,
        snap1.cashflowLogs,
        snap1.savingsAdjustments,
        [],
        '2026-11-25'
      );
      expect(nw1.totalAssets).toBe(100_000);
      expect(nw1.highLiquidityAssets).toBe(100_000);
      expect(nw1.totalLiabilities).toBe(4500);
      expect(nw1.netWorth).toBe(95_500);

      const metrics1 = aggregatePeriodMetrics(snap1.cashflowLogs, 0, false);
      expect(metrics1.dailyExpense).toBe(5000);

      // 4) Pay NT$ 3,000 billed statement from bank -> bank -3000, card -3000, consumption UNCHANGED, net worth UNCHANGED!
      await eng.payCreditCardBill({
        fromAccountId: bank.id,
        cardAccountId: card.id,
        amount: 3000,
        date: '2026-11-26',
        note: '繳 11 月帳單',
      });

      const snap2 = eng.getSnapshot();
      const bankBal2 = computeSavingsAccountSummary(
        snap2.assetItems.find((a) => a.id === bank.id)!,
        snap2.cashflowLogs,
        snap2.savingsAdjustments,
        snap2.settings
      ).currentBalanceTwd;
      expect(bankBal2).toBe(97_000);

      const cardSum2 = computeCreditCardSummary(
        snap2.assetItems.find((a) => a.id === card.id)!,
        snap2.cashflowLogs,
        snap2.savingsAdjustments,
        snap2.installmentPlans || [],
        snap2.settings,
        '2026-11-26'
      );
      expect(cardSum2.currentBalanceTwd).toBe(1500);
      expect(cardSum2.billedUnpaidTwd).toBe(0);
      expect(cardSum2.unbilledChargesTwd).toBe(1500);

      // Monthly spending MUST NOT double-count bill payment!
      expect(aggregatePeriodMetrics(snap2.cashflowLogs, 0, false).dailyExpense).toBe(5000);

      // Net worth conserved identically at 95,500
      const nw2 = computeNetWorthSummary(
        snap2.assetItems,
        snap2.settings,
        0,
        snap2.cashflowLogs,
        snap2.savingsAdjustments,
        [],
        '2026-11-26'
      );
      expect(nw2.totalAssets).toBe(97_000);
      expect(nw2.totalLiabilities).toBe(1500);
      expect(nw2.netWorth).toBe(95_500);

      // 5) Reconcile card balance to NT$ 2,000 on 2026-11-27
      await eng.reconcileCreditCard(card.id, 2000, '2026-11-27');
      const snap3 = eng.getSnapshot();
      const cardSum3 = computeCreditCardSummary(
        snap3.assetItems.find((a) => a.id === card.id)!,
        snap3.cashflowLogs,
        snap3.savingsAdjustments,
        snap3.installmentPlans || [],
        snap3.settings,
        '2026-11-27'
      );
      expect(cardSum3.currentBalanceTwd).toBe(2000);
    });
  });

  describe('3. Installment Auto-Posting Idempotency, Early Payoff, Sync, Pre-0024 Guard & Backup', () => {
    it('posts installments idempotently via cron/D1, completes final period, supports early payoff, syncs across devices, and survives backup/restore', async () => {
      const rawD1 = createTestD1();
      await seedUser(rawD1, 'u-cc');
      const counting = createCountingD1(rawD1);

      const db1 = new LocalFinanceDB(`cc-d1-1-${crypto.randomUUID()}`);
      const eng1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(counting.db, 'u-cc'),
        isOnline: () => true,
      });
      await eng1.init();
      await eng1.syncNow(true);

      const card = await eng1.saveAsset({
        updateMode: '手動快照',
        majorType: '負債',
        subCategory: '信用卡',
        liquidity: '負債',
        itemName: '國泰 CUBE',
        quantityOrAmount: 0,
        currency: 'TWD',
        unitPrice: 1,
        isCreditCard: true,
        creditBillingDay: 15,
        creditDueDay: 1,
        creditLimit: 50_000,
        balanceAnchorDate: '2026-11-01',
        ledgerId: DEFAULT_LEDGER_ID,
      });

      // Create 3-installment NT$ 10,000 plan with immediate period-1 posting
      const createdPlan = await eng1.saveInstallmentPlan({
        ledgerId: DEFAULT_LEDGER_ID,
        cardAccountId: card.id,
        itemName: 'iPad Air',
        category: '日用品',
        totalAmount: 10_000,
        totalInstallments: 3,
        startYm: '2026-11',
        postDay: 10,
        currency: 'TWD',
        postFirstNow: true,
      });
      expect(createdPlan.firstCashflow?.twdAmount).toBe(3334);
      expect(createdPlan.plan.postedInstallments).toBe(1);

      // Card exposure includes 3,334 current unpaid + 6,666 remaining unposted = 10,000 (20% utilization of 50k)
      const ccSum = computeAllCreditCardsSummary(
        eng1.getSnapshot().assetItems,
        eng1.getSnapshot().cashflowLogs,
        eng1.getSnapshot().savingsAdjustments,
        eng1.getSnapshot().installmentPlans || [],
        eng1.getSnapshot().settings,
        DEFAULT_LEDGER_ID,
        '2026-11-12'
      );
      expect(ccSum.totalUnpaidTwd).toBe(3334);
      expect(ccSum.totalRemainingInstallmentsTwd).toBe(6666);
      expect(ccSum.totalExposureTwd).toBe(10_000);
      expect(ccSum.cards[0].utilizationPct).toBe(20);

      // Sync card + installment plan + period-1 cashflow to D1 within budget
      counting.reset();
      const pushRes = await eng1.syncNow();
      expect(pushRes.ok).toBe(true);
      expect(counting.count()).toBeLessThanOrEqual(45);

      // Run D1 monthly installment automation for 2026-12 TWICE -> idempotent!
      const decRun1 = await runMonthlyInstallmentsD1(rawD1, 'u-cc', 2026, 12);
      expect(decRun1).toMatchObject({ insertedCount: 1, skippedCount: 0, completedCount: 0, complete: true });

      const decRun2 = await runMonthlyInstallmentsD1(rawD1, 'u-cc', 2026, 12);
      expect(decRun2).toMatchObject({ insertedCount: 0, skippedCount: 1, completedCount: 0, complete: true });

      // Run D1 monthly installment automation for 2027-01 -> posts final 3rd period & marks completed!
      const janRun = await runMonthlyInstallmentsD1(rawD1, 'u-cc', 2027, 1);
      expect(janRun).toMatchObject({ insertedCount: 1, skippedCount: 0, completedCount: 1, complete: true });

      // Device 2 pulls and verifies exact sum across all 3 installments = 10,000 & plan is completed
      const db2 = new LocalFinanceDB(`cc-d1-2-${crypto.randomUUID()}`);
      const eng2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(rawD1, 'u-cc'),
        isOnline: () => true,
      });
      await eng2.init();
      await eng2.syncNow(true);
      const d2Snap = eng2.getSnapshot();
      const d2Plan = d2Snap.installmentPlans?.find((p) => p.id === createdPlan.plan.id);
      expect(d2Plan?.status).toBe('completed');
      expect(d2Plan?.postedInstallments).toBe(3);
      const instLogs = d2Snap.cashflowLogs.filter((l) => l.installmentPlanId === createdPlan.plan.id);
      expect(instLogs).toHaveLength(3);
      expect(instLogs.reduce((s, l) => s + l.twdAmount, 0)).toBe(10_000);

      // Early payoff test on Device 2: 6-month NT$ 6,000 plan (1/6 posted) -> early payoff remaining 5,000
      const plan2 = await eng2.saveInstallmentPlan({
        ledgerId: DEFAULT_LEDGER_ID,
        cardAccountId: card.id,
        itemName: '空氣清淨機',
        category: '日用品',
        totalAmount: 6000,
        totalInstallments: 6,
        startYm: '2026-11',
        postDay: 5,
        currency: 'TWD',
        postFirstNow: true,
      });
      const payoff = await eng2.payOffInstallmentPlanEarly({
        id: plan2.plan.id,
        date: '2026-11-20',
        note: '一次結清',
      });
      expect(payoff.remainingAmount).toBe(5000);
      expect(payoff.plan.status).toBe('completed');
      expect(payoff.plan.postedInstallments).toBe(6);
      expect(payoff.cashflow?.twdAmount).toBe(5000);
      expect(computeInstallmentPlanProgress(payoff.plan, eng2.getSnapshot().settings).remainingTwd).toBe(0);
      await eng2.syncNow();

      // Backup export & replace restore preserves credit card & installmentPlans
      const exported = await exportFullSnapshot(rawD1, 'u-cc');
      expect(exported.installmentPlans).toHaveLength(2);
      const expCard = exported.assetItems.find((a) => a.id === card.id);
      expect(expCard?.isCreditCard).toBe(true);
      expect(expCard?.creditBillingDay).toBe(15);
      expect(expCard?.creditLimit).toBe(50_000);

      await importFullSnapshot(rawD1, 'u-cc', exported, 'replace');
      const restored = await exportFullSnapshot(rawD1, 'u-cc');
      expect(restored.installmentPlans).toHaveLength(2);
      expect(restored.assetItems.find((a) => a.id === card.id)?.isCreditCard).toBe(true);
      expect(
        restored.cashflowLogs.filter((l) => l.installmentPlanId === createdPlan.plan.id)
      ).toHaveLength(3);
    });

    it('runs scheduled automation with active installments cleanly within D1 budget and handles pre-0024 DBs gracefully', async () => {
      // 1) Pre-0024 DB
      const legacyD1 = createTestD1({ stopBefore: '0024' });
      await seedUser(legacyD1, 'u-leg24');

      const pullRes = await processSyncRequest(legacyD1, 'u-leg24', {
        since: null,
        sinceSeq: null,
        mutations: [],
      });
      expect(pullRes.delta.installmentPlans).toEqual([]);

      const cronLegacy = await runMonthlyInstallmentsD1(legacyD1, 'u-leg24', 2026, 11);
      expect(cronLegacy.insertedCount).toBe(0);
      expect(cronLegacy.complete).toBe(true);

      const mutRes = await processSyncRequest(legacyD1, 'u-leg24', {
        sinceSeq: 0,
        clientEpoch: 1,
        mutations: [
          {
            mutationId: 'm-leg-inst',
            entity: 'installment_plan',
            op: 'upsert',
            recordId: 'inst-leg',
            clientTimestamp: '2026-11-27T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            payload: {
              itemName: '分期測試',
              totalAmount: 3000,
              totalInstallments: 3,
              startYm: '2026-11',
            },
          },
          {
            mutationId: 'm-leg-cc',
            entity: 'asset',
            op: 'upsert',
            recordId: 'cc-leg',
            clientTimestamp: '2026-11-27T00:00:01Z',
            baseVersion: null,
            isNewRecord: true,
            payload: {
              itemName: '舊庫信用卡',
              quantityOrAmount: 0,
              isCreditCard: true,
              creditBillingDay: 15,
              creditDueDay: 1,
            },
          },
        ],
      });
      expect(mutRes.rejected?.length).toBe(2);
      expect(mutRes.rejected?.[0].reason).toMatch(/0024/);
      expect(mutRes.rejected?.[1].reason).toMatch(/0024/);

      const legSnap = await exportFullSnapshot(legacyD1, 'u-leg24');
      await expect(
        importFullSnapshot(
          legacyD1,
          'u-leg24',
          {
            ...legSnap,
            installmentPlans: [
              {
                id: 'p1',
                ledgerId: DEFAULT_LEDGER_ID,
                cardAccountId: null,
                itemName: '測試分期',
                category: '其他',
                totalAmount: 3000,
                totalInstallments: 3,
                postedInstallments: 0,
                startYm: '2026-11',
                postDay: 1,
                currency: 'TWD',
                status: 'active',
                note: '',
                createdAt: '2026-11-01T00:00:00Z',
                updatedAt: '2026-11-01T00:00:00Z',
              },
            ],
          },
          'merge'
        )
      ).rejects.toThrow(/0024/);

      // 2) Full-migrated DB scheduled automation auto-posts due installment within 50-query budget
      const schedD1 = createTestD1();
      await seedUser(schedD1, 'u-sched');
      await processSyncRequest(schedD1, 'u-sched', {
        sinceSeq: 0,
        clientEpoch: 1,
        refsOrdered: true,
        mutations: [
          {
            mutationId: 'm-sched-inst',
            entity: 'installment_plan',
            op: 'upsert',
            recordId: 'plan-sched-1',
            clientTimestamp: '2026-11-01T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            payload: {
              itemName: '排程分期',
              totalAmount: 9000,
              totalInstallments: 3,
              startYm: '2026-11',
              postDay: 5,
            },
          },
        ],
      });
      const schedRes = await runScheduledAutomation(
        schedD1,
        '0 0 1 * *',
        new Date('2026-11-01T00:05:00.000Z'),
        {
          fetchImpl: async () => new Response('{}', { status: 200 }),
        }
      );
      expect(schedRes.d1Queries).toBeLessThanOrEqual(50);
      expect(schedRes.steps.every((s) => s.ok)).toBe(true);
      const runRow = await schedD1
        .prepare("SELECT status FROM automation_runs WHERE user_id = ? AND kind = 'installments' AND period = ?")
        .bind('u-sched', '2026-11')
        .first<{ status: string }>();
      expect(runRow?.status).toBe('done');
      const afterSched = await exportFullSnapshot(schedD1, 'u-sched');
      expect(afterSched.cashflowLogs.filter((l) => l.installmentPlanId === 'plan-sched-1')).toHaveLength(1);
    });
  });
});
