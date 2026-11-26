import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_ID } from '../shared/constants';
import {
  computeAllSavingsSummary,
  computeNetWorthSummary,
  filterCashFlowsByLedgerScope,
} from '../shared/calculations';
import { runMonthEndSnapshotD1, runMonthlyRecurringD1 } from '../worker/automation';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

function createSyncedEngine(db: D1Database, userId: string): SyncEngine {
  const localDb = new LocalFinanceDB(`test-phase2-${crypto.randomUUID()}`);
  return new SyncEngine(localDb, {
    isOnline: () => true,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const res = await processSyncRequest(db, userId, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch,
  });
}

describe('Phase 2: Multi-Ledger Isolation (Option A)', () => {
  it('isolates independent ledger assets, multiple savings, cashflow logs, and month-end snapshots from personal net worth', async () => {
    const db = createTestD1();
    const userId = 'owner';
    const engine = createSyncedEngine(db, userId);
    await engine.init();

    // 1. Create personal main ledger savings + cashflow
    const personalSav = await engine.saveAsset({
      itemName: '個人薪轉活存',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '活存',
      liquidity: '高流動',
      quantityOrAmount: 100000,
      currency: 'TWD',
      unitPrice: 1,
      isLinkedSavings: true,
      isDefaultSavings: true,
      balanceAnchorDate: '2026-11-01',
      balanceAnchorAt: '2026-11-01T00:00:00.000Z',
    });

    await engine.addCashFlow({
      date: '2026-11-10',
      type: '日常花費',
      category: '餐飲',
      itemName: '個人午餐',
      amount: 500,
      currency: 'TWD',
      linkedAccountId: personalSav.id,
      ledgerId: DEFAULT_LEDGER_ID,
    });

    // 2. Create independent ledger (includeInNetWorth: false) with multiple assets & savings
    const custodyLedger = await engine.saveLedger({
      name: '代管公帳',
      includeInNetWorth: false,
      monthlyDailyBudget: null,
      note: '不計入個人總資產',
    });
    expect(custodyLedger.includeInNetWorth).toBe(false);

    const custodySavA = await engine.saveAsset({
      itemName: '代管活存 A',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '活存',
      liquidity: '高流動',
      quantityOrAmount: 500000,
      currency: 'TWD',
      unitPrice: 1,
      isLinkedSavings: true,
      isDefaultSavings: true, // Should NOT clear personalSav.isDefaultSavings
      ledgerId: custodyLedger.id,
      balanceAnchorDate: '2026-11-01',
      balanceAnchorAt: '2026-11-01T00:00:00.000Z',
    });

    const custodyFixed = await engine.saveAsset({
      itemName: '代管定存 B',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '定存/現金',
      liquidity: '中流動',
      quantityOrAmount: 300000,
      currency: 'TWD',
      unitPrice: 1,
      ledgerId: custodyLedger.id,
    });

    // Independent ledger cashflow linked to custodySavA
    await engine.addCashFlow({
      date: '2026-11-12',
      type: '日常花費',
      category: '雜支',
      itemName: '公帳採買',
      amount: 20000,
      currency: 'TWD',
      linkedAccountId: custodySavA.id,
      ledgerId: custodyLedger.id,
    });

    // Per-asset excludeFromNetWorth inside default ledger
    const excludedDeposit = await engine.saveAsset({
      itemName: '代墊押金（單筆排除）',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '定存/現金',
      liquidity: '低流動',
      quantityOrAmount: 50000,
      currency: 'TWD',
      unitPrice: 1,
      ledgerId: DEFAULT_LEDGER_ID,
      excludeFromNetWorth: true,
    });

    const syncRes = await engine.syncNow(true);
    expect(syncRes.ok).toBe(true);

    const snap = engine.getSnapshot();
    const ledgers = snap.ledgers || [];

    // Per-ledger default savings must remain independent
    const personalSavReloaded = snap.assetItems.find((a) => a.id === personalSav.id);
    const custodySavReloaded = snap.assetItems.find((a) => a.id === custodySavA.id);
    expect(personalSavReloaded?.isDefaultSavings).toBe(true);
    expect(custodySavReloaded?.isDefaultSavings).toBe(true);

    // Ledger-scoped savings calculation
    const defaultSavSummary = computeAllSavingsSummary(
      snap.assetItems,
      snap.cashflowLogs,
      snap.savingsAdjustments || [],
      32,
      DEFAULT_LEDGER_ID
    );
    expect(defaultSavSummary.accounts).toHaveLength(1);
    expect(defaultSavSummary.totalSavingsTwd).toBe(99500);

    const custodySavSummary = computeAllSavingsSummary(
      snap.assetItems,
      snap.cashflowLogs,
      snap.savingsAdjustments || [],
      32,
      custodyLedger.id
    );
    expect(custodySavSummary.accounts).toHaveLength(1);
    expect(custodySavSummary.totalSavingsTwd).toBe(480000);

    // Net worth scope ('net_worth') strictly excludes custodyLedger AND excludedDeposit
    const nwPersonal = computeNetWorthSummary(
      snap.assetItems,
      32,
      30000,
      snap.cashflowLogs,
      snap.savingsAdjustments || [],
      snap.stockTransactions || [],
      '2026-11-30',
      ledgers,
      'net_worth'
    );
    expect(nwPersonal.totalAssets).toBe(99500);
    expect(nwPersonal.netWorth).toBe(99500);

    // Independent ledger scope shows its own multi-asset total (480,000 + 300,000 = 780,000)
    const nwCustody = computeNetWorthSummary(
      snap.assetItems,
      32,
      0,
      snap.cashflowLogs,
      snap.savingsAdjustments || [],
      snap.stockTransactions || [],
      '2026-11-30',
      ledgers,
      custodyLedger.id
    );
    expect(nwCustody.totalAssets).toBe(780000);
    expect(custodyFixed.ledgerId).toBe(custodyLedger.id);

    // 'all' scope includes everything (99,500 + 780,000 + 50,000 = 929,500)
    const nwAll = computeNetWorthSummary(
      snap.assetItems,
      32,
      30000,
      snap.cashflowLogs,
      snap.savingsAdjustments || [],
      snap.stockTransactions || [],
      '2026-11-30',
      ledgers,
      'all'
    );
    expect(nwAll.totalAssets).toBe(929500);
    expect(excludedDeposit.excludeFromNetWorth).toBe(true);

    // Cashflow filter for 'net_worth' only contains personal log
    const personalLogs = filterCashFlowsByLedgerScope(snap.cashflowLogs, 'net_worth', ledgers);
    expect(personalLogs).toHaveLength(1);
    expect(personalLogs[0].itemName).toBe('個人午餐');

    // D1 Month-end snapshot strictly uses net-worth inclusion rules
    const monthEnd = await runMonthEndSnapshotD1(db, userId, new Date('2026-11-30T12:00:00Z'));
    expect(monthEnd.totalAssets).toBe(99500);
    expect(monthEnd.netWorth).toBe(99500);
  });

  it('auto-posts identically named recurring items across separate ledgers without dedup collision', async () => {
    const db = createTestD1();
    const userId = 'owner';
    const engine = createSyncedEngine(db, userId);
    await engine.init();

    const bizLedger = await engine.saveLedger({
      name: '副業帳本',
      includeInNetWorth: false,
    });

    await engine.saveRecurring({
      type: '固定支出',
      category: '訂閱',
      itemName: '雲端主機月費',
      amount: 300,
      currency: 'TWD',
      cycle: '月繳',
      billingSpec: 'ALL',
      status: '啟用',
      ledgerId: DEFAULT_LEDGER_ID,
    });

    await engine.saveRecurring({
      type: '固定支出',
      category: '訂閱',
      itemName: '雲端主機月費',
      amount: 1200,
      currency: 'TWD',
      cycle: '月繳',
      billingSpec: 'ALL',
      status: '啟用',
      ledgerId: bizLedger.id,
    });

    const syncRes = await engine.syncNow(true);
    expect(syncRes.ok).toBe(true);

    // First run inserts both (2 inserted, 0 skipped)
    const run1 = await runMonthlyRecurringD1(db, userId, 2026, 11);
    expect(run1.insertedCount).toBe(2);
    expect(run1.skippedCount).toBe(0);

    // Second run is idempotent (0 inserted, 2 skipped)
    const run2 = await runMonthlyRecurringD1(db, userId, 2026, 11);
    expect(run2.insertedCount).toBe(0);
    expect(run2.skippedCount).toBe(2);

    const exported = await exportFullSnapshot(db, userId);
    const defaultLogs = exported.cashflowLogs.filter((l) => l.ledgerId === DEFAULT_LEDGER_ID);
    const bizLogs = exported.cashflowLogs.filter((l) => l.ledgerId === bizLedger.id);
    expect(defaultLogs).toHaveLength(1);
    expect(defaultLogs[0].twdAmount).toBe(300);
    expect(bizLogs).toHaveLength(1);
    expect(bizLogs[0].twdAmount).toBe(1200);
  });

  it('preserves ledgers on JSON backup/restore and enforces safe ledger deletion with optional migration', async () => {
    const db = createTestD1();
    const userId = 'owner';
    const engine = createSyncedEngine(db, userId);
    await engine.init();

    const tripLedger = await engine.saveLedger({
      name: '旅遊專戶',
      includeInNetWorth: false,
      monthlyDailyBudget: 15000,
    });
    const tripCash = await engine.saveAsset({
      itemName: '日幣旅遊金',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '定存/現金',
      liquidity: '高流動',
      quantityOrAmount: 30000,
      currency: 'TWD',
      unitPrice: 1,
      ledgerId: tripLedger.id,
    });
    await engine.addCashFlow({
      date: '2026-11-15',
      type: '日常花費',
      category: '旅遊',
      itemName: '機票訂金',
      amount: 8000,
      currency: 'TWD',
      ledgerId: tripLedger.id,
    });
    await engine.syncNow(true);

    // Backup & restore into a brand new D1 database
    const exported = await exportFullSnapshot(db, userId);
    expect(exported.ledgers?.some((l) => l.id === tripLedger.id && l.monthlyDailyBudget === 15000)).toBe(
      true
    );

    const db2 = createTestD1();
    await importFullSnapshot(db2, userId, exported);
    const reExported = await exportFullSnapshot(db2, userId);
    expect(reExported.ledgers?.find((l) => l.id === tripLedger.id)?.name).toBe('旅遊專戶');
    expect(reExported.assetItems.find((a) => a.id === tripCash.id)?.ledgerId).toBe(tripLedger.id);
    expect(reExported.cashflowLogs.find((l) => l.itemName === '機票訂金')?.ledgerId).toBe(
      tripLedger.id
    );

    // Cannot delete default ledger
    await expect(engine.deleteLedger(DEFAULT_LEDGER_ID)).rejects.toThrow();

    // Cannot delete non-empty ledger without migration target
    await expect(engine.deleteLedger(tripLedger.id)).rejects.toThrow();

    // Delete with migration moves all linked records back to default ledger
    const delRes = await engine.deleteLedger(tripLedger.id, {
      migrateToLedgerId: DEFAULT_LEDGER_ID,
    });
    expect(delRes.migratedCount).toBe(2);

    const syncAfterDel = await engine.syncNow(true);
    expect(syncAfterDel.ok).toBe(true);

    const finalExport = await exportFullSnapshot(db, userId);
    expect(finalExport.ledgers?.some((l) => l.id === tripLedger.id && !l.deletedAt)).toBe(false);
    expect(finalExport.assetItems.find((a) => a.id === tripCash.id)?.ledgerId).toBe(
      DEFAULT_LEDGER_ID
    );
    expect(finalExport.cashflowLogs.find((l) => l.itemName === '機票訂金')?.ledgerId).toBe(
      DEFAULT_LEDGER_ID
    );
  });
});
