import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  aggregatePeriodMetrics,
  computeSavingsAccountSummary,
} from '../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../shared/constants';
import {
  computeEqualSplitShares,
  computeSettlementPreview,
  computeSplitReceivablesSummary,
} from '../shared/splits';
import { orderMutationsByDependencies } from '../shared/syncOrder';
import type { SyncMutation, SyncRequest } from '../shared/types';
import { validateSplitReceivableInput } from '../shared/validation';
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

describe('Phase 6 (v1.14.0): Split Expenses & Receivables', () => {
  describe('1. Pure Split Math & Validation', () => {
    it('conserves exact sum for equal splits across TWD, JPY and USD', () => {
      const twdShares = computeEqualSplitShares(1000, 3, 'TWD');
      expect(twdShares).toEqual([334, 333, 333]);
      expect(twdShares.reduce((a, b) => a + b, 0)).toBe(1000);

      const usdShares = computeEqualSplitShares(100, 3, 'USD');
      expect(usdShares).toEqual([33.34, 33.33, 33.33]);
      expect(Math.round(usdShares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(100);

      const jpyShares = computeEqualSplitShares(5000, 3, 'JPY');
      expect(jpyShares).toEqual([1667, 1667, 1666]);
      expect(jpyShares.reduce((a, b) => a + b, 0)).toBe(5000);
    });

    it('enforces validation rules including settledAmount <= amount', () => {
      const fx = { usdTwdRate: 32.5, fxRates: { USD: 32.5, JPY: 0.22 } };
      expect(() =>
        validateSplitReceivableInput(
          {
            splitGroupId: 'g1',
            counterparty: '',
            date: '2026-11-27',
            itemName: '聚餐',
            amount: 1000,
          },
          fx
        )
      ).toThrow(/對象/);

      expect(() =>
        validateSplitReceivableInput(
          {
            splitGroupId: 'g1',
            counterparty: '小明',
            date: '2026-11-27',
            itemName: '聚餐',
            amount: 1000,
            settledAmount: 1200,
          },
          fx
        )
      ).toThrow(/超過/);

      const partial = validateSplitReceivableInput(
        {
          splitGroupId: 'g1',
          counterparty: '小明',
          date: '2026-11-27',
          itemName: '聚餐',
          amount: 1200,
          settledAmount: 500,
          currency: 'TWD',
        },
        fx
      );
      expect(partial.status).toBe('partial');

      const settled = validateSplitReceivableInput(
        {
          splitGroupId: 'g1',
          counterparty: '小明',
          date: '2026-11-27',
          itemName: '聚餐',
          amount: 1200,
          settledAmount: 1200,
          currency: 'TWD',
        },
        fx
      );
      expect(settled.status).toBe('settled');
    });

    it('orders newly created sourceAccountId assets before split_receivable mutations', () => {
      const unordered: SyncMutation[] = [
        {
          mutationId: 'm-split',
          entity: 'split_receivable',
          op: 'upsert',
          recordId: 'sr-1',
          clientTimestamp: '2026-11-27T00:00:00Z',
          payload: { sourceAccountId: 'acc-new', ledgerId: DEFAULT_LEDGER_ID },
        },
        {
          mutationId: 'm-acc',
          entity: 'asset',
          op: 'upsert',
          recordId: 'acc-new',
          clientTimestamp: '2026-11-27T00:00:01Z',
          payload: { itemName: '玉山活存' },
        },
      ];
      const ordered = orderMutationsByDependencies(unordered);
      expect(ordered.map((m) => m.mutationId)).toEqual(['m-acc', 'm-split']);
    });
  });

  describe('2. Exact Accounting Conservation, Settlement, Write-Off & Undo', () => {
    it('conserves bank balance, isolates personal budget/savings rate, supports partial->full settlement, write-off without double deduction, and paired undo', async () => {
      const db = new LocalFinanceDB(`split-acct-${crypto.randomUUID()}`);
      const eng = new SyncEngine(db, { isOnline: () => false });
      await eng.init();

      // Seed linked savings account with NT$ 50,000
      const acc = await eng.saveAsset({
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '玉山活存',
        quantityOrAmount: 50_000,
        currency: 'TWD',
        unitPrice: 1,
        isLinkedSavings: true,
        isDefaultSavings: true,
        balanceAnchorDate: '2026-11-01',
        ledgerId: DEFAULT_LEDGER_ID,
      });

      // Add NT$ 50,000 salary (not linked so bank stays cleanly at 50,000) to measure savings rate
      await eng.addCashFlow({
        date: '2026-11-05',
        type: CASHFLOW_TYPES.FIXED_INCOME,
        category: '薪資',
        itemName: '月薪',
        amount: 50_000,
        currency: 'TWD',
        linkedAccountId: null,
        ledgerId: DEFAULT_LEDGER_ID,
      });

      const getBankBal = () => {
        const snap = eng.getSnapshot();
        const latestAcc = snap.assetItems.find((a) => a.id === acc.id)!;
        return computeSavingsAccountSummary(
          latestAcc,
          snap.cashflowLogs,
          snap.savingsAdjustments,
          snap.settings
        ).currentBalanceTwd;
      };

      const getMonthMetrics = () => {
        const snap = eng.getSnapshot();
        const novLogs = snap.cashflowLogs.filter((l) => !l.deletedAt && l.yearMonth === '2026-11');
        return aggregatePeriodMetrics(novLogs, 0, false);
      };

      expect(getBankBal()).toBe(50_000);

      // 1) Total dinner NT$ 3,000 = my share 600 + 小明 1,200 + 小華 1,200
      const created = await eng.createSplitExpense({
        date: '2026-11-10',
        itemName: '居酒屋聚餐',
        category: '餐飲',
        currency: 'TWD',
        myShareAmount: 600,
        participants: [
          { counterparty: '小明', amount: 1200 },
          { counterparty: '小華', amount: 1200 },
        ],
        sourceAccountId: acc.id,
        ledgerId: DEFAULT_LEDGER_ID,
      });

      expect(created.cashflow?.twdAmount).toBe(600);
      expect(created.savingsAdjustment?.twdAmount).toBe(-2400);
      expect(created.receivables).toHaveLength(2);

      // Bank balance drops by full 3,000 (600 + 2,400) -> 47,000
      expect(getBankBal()).toBe(47_000);
      // Personal daily spending sees ONLY 600; income is still 50,000
      const m1 = getMonthMetrics();
      expect(m1.dailyExpense).toBe(600);
      expect(m1.totalIncome).toBe(50_000);
      expect(m1.totalSavings).toBe(49_400);

      const recMing = created.receivables.find((r) => r.counterparty === '小明')!;
      const recHua = created.receivables.find((r) => r.counterparty === '小華')!;

      // Summary shows NT$ 2,400 outstanding
      const sum1 = computeSplitReceivablesSummary(
        eng.getSnapshot().splitReceivables || [],
        eng.getSnapshot().settings
      );
      expect(sum1.totalOutstandingTwd).toBe(2400);
      expect(sum1.openCount).toBe(2);

      // 2) Partial repayment: 小明 pays back 500
      const partRes = await eng.settleSplitReceivable({
        id: recMing.id,
        settleAmount: 500,
        date: '2026-11-12',
        depositAccountId: acc.id,
        note: '先轉一半',
      });
      expect(partRes.receivable.status).toBe('partial');
      expect(partRes.receivable.settledAmount).toBe(500);
      expect(getBankBal()).toBe(47_500);
      // Income & savings rate MUST NOT be polluted by repayment!
      expect(getMonthMetrics().totalIncome).toBe(50_000);
      expect(getMonthMetrics().dailyExpense).toBe(600);

      // Over-settlement (> remaining 700) MUST throw
      await expect(
        eng.settleSplitReceivable({
          id: recMing.id,
          settleAmount: 800,
          date: '2026-11-13',
          depositAccountId: acc.id,
        })
      ).rejects.toThrow(/超過/);

      // Undo whole group MUST be rejected once a member has partial settlement
      await expect(
        eng.deleteSplitReceivable(recHua.id, { undoWholeGroup: true })
      ).rejects.toThrow(/收回/);

      // 3) Full repayment: 小明 pays remaining 700
      const fullRes = await eng.settleSplitReceivable({
        id: recMing.id,
        settleAmount: 700,
        date: '2026-11-14',
        depositAccountId: acc.id,
      });
      expect(fullRes.receivable.status).toBe('settled');
      expect(fullRes.receivable.settledAmount).toBe(1200);
      expect(getBankBal()).toBe(48_200); // 50,000 - 3,000 + 1,200 = 48,200
      expect(getMonthMetrics().totalIncome).toBe(50_000);

      // 4) Write-off 小華's 1,200 -> converts to 日常花費 with linkedAccountId = null (NO double deduction!)
      const woRes = await eng.writeOffSplitReceivable({
        id: recHua.id,
        date: '2026-11-15',
        category: '餐飲',
        note: '請客免還',
      });
      expect(woRes.receivable.status).toBe('written_off');
      expect(woRes.cashflow?.linkedAccountId).toBeNull();
      expect(woRes.cashflow?.twdAmount).toBe(1200);
      // Bank balance stays EXACTLY 48,200!
      expect(getBankBal()).toBe(48_200);
      // Personal daily spending now includes my 600 + written-off 1,200 = 1,800
      expect(getMonthMetrics().dailyExpense).toBe(1800);

      // Summary outstanding is now 0
      const sumAfter = computeSplitReceivablesSummary(
        eng.getSnapshot().splitReceivables || [],
        eng.getSnapshot().settings
      );
      expect(sumAfter.totalOutstandingTwd).toBe(0);
      expect(sumAfter.settledCount).toBe(1);
      expect(sumAfter.writtenOffCount).toBe(1);

      // 5) Paired group undo on a fresh unsettled split restores bank balance cleanly
      const mistake = await eng.createSplitExpense({
        date: '2026-11-16',
        itemName: '打錯的電影票',
        category: '娛樂',
        currency: 'TWD',
        myShareAmount: 300,
        participants: [{ counterparty: '小王', amount: 300 }],
        sourceAccountId: acc.id,
        ledgerId: DEFAULT_LEDGER_ID,
      });
      expect(getBankBal()).toBe(47_600); // 48,200 - 600
      const undoRes = await eng.deleteSplitReceivable(mistake.receivables[0].id, {
        undoWholeGroup: true,
      });
      expect(undoRes).toEqual({
        deletedReceivableCount: 1,
        undoneCashflow: true,
        undoneAdjustment: true,
      });
      expect(getBankBal()).toBe(48_200);
      expect(getMonthMetrics().dailyExpense).toBe(1800);
    });

    it('supports cross-currency split & settlement (JPY advance repaid in TWD with FX diff)', async () => {
      const db = new LocalFinanceDB(`split-fx-${crypto.randomUUID()}`);
      const eng = new SyncEngine(db, { isOnline: () => false });
      await eng.init();
      await eng.saveMultiCurrencySettings({
        usdTwdRate: 32.5,
        autoFxEnabled: false,
        enabledCurrencies: ['TWD', 'USD', 'JPY'],
        fxRates: { USD: 32.5, JPY: 0.22 },
      });

      const twdAcc = await eng.saveAsset({
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '台幣主帳戶',
        quantityOrAmount: 100_000,
        currency: 'TWD',
        unitPrice: 1,
        isLinkedSavings: true,
        balanceAnchorDate: '2026-11-01',
        ledgerId: DEFAULT_LEDGER_ID,
      });

      // Paid JPY 15,000 total (my JPY 5,000 + friend JPY 10,000) from TWD account @ 0.22
      const res = await eng.createSplitExpense({
        date: '2026-11-20',
        itemName: '東京飯店',
        category: '旅遊',
        currency: 'JPY',
        myShareAmount: 5000,
        participants: [{ counterparty: '阿哲', amount: 10_000 }],
        sourceAccountId: twdAcc.id,
      });
      expect(res.cashflow?.twdAmount).toBe(1100);
      expect(res.savingsAdjustment?.twdAmount).toBe(-2200);
      expect(res.receivables[0].twdAmount).toBe(2200);

      const preview = computeSettlementPreview({
        receivable: res.receivables[0],
        settleAmountNative: 10_000,
        depositCurrency: 'TWD',
        fxSource: eng.getSnapshot().settings,
        customDepositAmount: 2300,
      });
      expect(preview.originalPortionTwd).toBe(2200);
      expect(preview.actualDepositAmount).toBe(2300);
      expect(preview.fxDiffTwd).toBe(100);

      const settled = await eng.settleSplitReceivable({
        id: res.receivables[0].id,
        settleAmount: 10_000,
        date: '2026-11-25',
        depositAccountId: twdAcc.id,
        customDepositAmount: 2300,
      });
      expect(settled.receivable.status).toBe('settled');
      expect(settled.savingsAdjustment?.twdAmount).toBe(2300);

      const snap = eng.getSnapshot();
      const bal = computeSavingsAccountSummary(
        snap.assetItems.find((a) => a.id === twdAcc.id)!,
        snap.cashflowLogs,
        snap.savingsAdjustments,
        snap.settings
      ).currentBalanceTwd;
      // 100,000 - 1,100 (my share) - 2,200 (advance) + 2,300 (TWD repaid) = 99,000
      expect(bal).toBe(99_000);
    });
  });

  describe('3. Full-Stack D1 Sync, Atomic Group Rollback, Optimistic Lock, Pre-0023 Guard & Backup', () => {
    it('syncs splits atomically across devices, detects conflicts, rolls back broken atomic groups, stays within D1 budget, and survives backup/restore', async () => {
      const rawD1 = createTestD1();
      await seedUser(rawD1, 'u-split');
      const counting = createCountingD1(rawD1);

      const db1 = new LocalFinanceDB(`split-d1-1-${crypto.randomUUID()}`);
      const eng1 = new SyncEngine(db1, {
        fetchImpl: createD1FetchAdapter(counting.db, 'u-split'),
        isOnline: () => true,
      });
      await eng1.init();
      await eng1.syncNow(true);

      const acc = await eng1.saveAsset({
        updateMode: '手動快照',
        majorType: '資產',
        subCategory: '活存',
        liquidity: '高流動',
        itemName: '國泰活存',
        quantityOrAmount: 80_000,
        currency: 'TWD',
        unitPrice: 1,
        isLinkedSavings: true,
        balanceAnchorDate: '2026-11-01',
        ledgerId: DEFAULT_LEDGER_ID,
      });

      const created = await eng1.createSplitExpense({
        date: '2026-11-21',
        itemName: '火鍋聚餐',
        category: '餐飲',
        currency: 'TWD',
        myShareAmount: 500,
        participants: [
          { counterparty: '小明', amount: 500 },
          { counterparty: '小美', amount: 500 },
        ],
        sourceAccountId: acc.id,
      });

      counting.reset();
      const pushRes = await eng1.syncNow();
      expect(pushRes.ok).toBe(true);
      expect(counting.count()).toBeLessThanOrEqual(45); // strictly within 50-query free budget

      // Device 2 pulls full snapshot and sees all synced records
      const db2 = new LocalFinanceDB(`split-d1-2-${crypto.randomUUID()}`);
      const eng2 = new SyncEngine(db2, {
        fetchImpl: createD1FetchAdapter(rawD1, 'u-split'),
        isOnline: () => true,
      });
      await eng2.init();
      await eng2.syncNow(true);
      expect(eng2.getSnapshot().splitReceivables).toHaveLength(2);
      expect(eng2.getSnapshot().cashflowLogs).toHaveLength(1);
      expect(eng2.getSnapshot().savingsAdjustments).toHaveLength(1);

      // Optimistic lock protection across devices:
      // 1) Atomic group conflict (with depositAccountId): rejects BOTH legs so bank is NOT double-credited
      const targetId = created.receivables[0].id;
      const targetId2 = created.receivables[1].id;
      await eng1.settleSplitReceivable({
        id: targetId,
        settleAmount: 200,
        date: '2026-11-22',
        depositAccountId: acc.id,
      });
      await eng1.syncNow();

      await eng2.settleSplitReceivable({
        id: targetId,
        settleAmount: 300,
        date: '2026-11-22',
        depositAccountId: acc.id,
      });
      await eng2.syncNow();
      expect(eng2.getRejections().length).toBeGreaterThanOrEqual(2);
      expect(eng2.getSnapshot().splitReceivables?.find((s) => s.id === targetId)?.settledAmount).toBe(200);

      // 2) Single-mutation optimistic lock conflict (depositAccountId: null) triggers SyncConflict
      await eng1.settleSplitReceivable({
        id: targetId2,
        settleAmount: 100,
        date: '2026-11-22',
        depositAccountId: null,
      });
      await eng1.syncNow();

      await eng2.settleSplitReceivable({
        id: targetId2,
        settleAmount: 150,
        date: '2026-11-22',
        depositAccountId: null,
      });
      await eng2.syncNow();
      expect(eng2.getConflicts().length).toBeGreaterThanOrEqual(1);

      // Atomic group rollback: a 3-leg split group where split_receivable has a bad sourceAccountId
      // MUST roll back the entire D1 batch (zero orphan cashflow or savings_adjustment!)
      const beforeSnap = await exportFullSnapshot(rawD1, 'u-split');
      const badGroupId = 'atomic-bad-split-group';
      const badRes = await processSyncRequest(rawD1, 'u-split', {
        sinceSeq: 0,
        clientEpoch: 1,
        refsOrdered: true,
        mutations: [
          {
            mutationId: 'bad-cf',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'orphan-cf-id',
            clientTimestamp: '2026-11-23T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            atomicGroupId: badGroupId,
            payload: {
              date: '2026-11-23',
              type: CASHFLOW_TYPES.DAILY_EXPENSE,
              category: '餐飲',
              itemName: '不該殘留的消費',
              amount: 500,
              currency: 'TWD',
              linkedAccountId: acc.id,
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
          {
            mutationId: 'bad-adj',
            entity: 'savings_adjustment',
            op: 'upsert',
            recordId: 'orphan-adj-id',
            clientTimestamp: '2026-11-23T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            atomicGroupId: badGroupId,
            payload: {
              accountId: acc.id,
              date: '2026-11-23',
              amount: -500,
              currency: 'TWD',
              note: '不該殘留的扣款',
            },
          },
          {
            mutationId: 'bad-sr',
            entity: 'split_receivable',
            op: 'upsert',
            recordId: 'orphan-sr-id',
            clientTimestamp: '2026-11-23T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            atomicGroupId: badGroupId,
            payload: {
              ledgerId: DEFAULT_LEDGER_ID,
              splitGroupId: 'grp-bad',
              counterparty: '不存在帳戶',
              date: '2026-11-23',
              itemName: '測試回滾',
              category: '餐飲',
              amount: 500,
              settledAmount: 0,
              currency: 'TWD',
              sourceAccountId: 'non-existent-account-id',
            },
          },
        ],
      });
      expect(badRes.rejected?.length).toBe(3);
      const afterBadSnap = await exportFullSnapshot(rawD1, 'u-split');
      expect(afterBadSnap.cashflowLogs.length).toBe(beforeSnap.cashflowLogs.length);
      expect(afterBadSnap.savingsAdjustments.length).toBe(beforeSnap.savingsAdjustments.length);
      expect(afterBadSnap.splitReceivables?.length).toBe(beforeSnap.splitReceivables?.length);

      // Server rejects over-settlement (settledAmount > amount)
      const overRes = await processSyncRequest(rawD1, 'u-split', {
        sinceSeq: 0,
        clientEpoch: 1,
        refsOrdered: true,
        mutations: [
          {
            mutationId: 'over-settle',
            entity: 'split_receivable',
            op: 'upsert',
            recordId: 'sr-over',
            clientTimestamp: '2026-11-24T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            payload: {
              ledgerId: DEFAULT_LEDGER_ID,
              splitGroupId: 'grp-over',
              counterparty: '超收測試',
              date: '2026-11-24',
              itemName: '測試',
              amount: 100,
              settledAmount: 200,
              currency: 'TWD',
            },
          },
        ],
      });
      expect(overRes.rejected?.some((r) => r.mutationId === 'over-settle')).toBe(true);

      // JSON backup export & replace restore preserves splitReceivables
      const exported = await exportFullSnapshot(rawD1, 'u-split');
      expect(exported.splitReceivables).toHaveLength(2);
      await importFullSnapshot(rawD1, 'u-split', exported, 'replace');
      const restored = await exportFullSnapshot(rawD1, 'u-split');
      expect(restored.splitReceivables).toHaveLength(2);
      expect(
        restored.splitReceivables?.find((s) => s.id === targetId)?.settledAmount
      ).toBe(200);
    });

    it('gracefully handles pre-0023 D1 databases on pull, rejects split mutations, and rejects backup with splitReceivables', async () => {
      const legacyD1 = createTestD1({ stopBefore: '0023' });
      await seedUser(legacyD1, 'u-legacy');

      const pullRes = await processSyncRequest(legacyD1, 'u-legacy', {
        since: null,
        sinceSeq: null,
        mutations: [],
      });
      expect(pullRes.delta.splitReceivables).toEqual([]);

      const mutRes = await processSyncRequest(legacyD1, 'u-legacy', {
        sinceSeq: 0,
        clientEpoch: 1,
        mutations: [
          {
            mutationId: 'm-legacy-split',
            entity: 'split_receivable',
            op: 'upsert',
            recordId: 'sr-legacy',
            clientTimestamp: '2026-11-27T00:00:00Z',
            baseVersion: null,
            isNewRecord: true,
            payload: {
              splitGroupId: 'g-legacy',
              counterparty: '小明',
              date: '2026-11-27',
              itemName: '聚餐',
              amount: 500,
              currency: 'TWD',
            },
          },
        ],
      });
      expect(mutRes.rejected?.length).toBe(1);
      expect(mutRes.rejected?.[0].reason).toMatch(/0023/);

      const snap = await exportFullSnapshot(legacyD1, 'u-legacy');
      await expect(
        importFullSnapshot(
          legacyD1,
          'u-legacy',
          {
            ...snap,
            splitReceivables: [
              {
                id: 'sr-1',
                ledgerId: DEFAULT_LEDGER_ID,
                splitGroupId: 'g-1',
                counterparty: '小明',
                date: '2026-11-27',
                itemName: '聚餐',
                category: '餐飲',
                amount: 500,
                settledAmount: 0,
                currency: 'TWD',
                fxRate: 1,
                twdAmount: 500,
                status: 'open',
                sourceCashflowId: null,
                sourceAccountId: null,
                sourceAdjustmentId: null,
                note: '',
                createdAt: '2026-11-27T00:00:00Z',
                updatedAt: '2026-11-27T00:00:00Z',
              },
            ],
          },
          'merge'
        )
      ).rejects.toThrow(/0023/);
    });
  });
});
