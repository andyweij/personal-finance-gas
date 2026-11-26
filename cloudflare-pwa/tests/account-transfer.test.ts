import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_ID } from '../shared/constants';
import {
  computeAllSavingsSummary,
  computeNetWorthSummary,
  isTransferableAccount,
} from '../shared/calculations';
import { exportFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

function createSyncedEngine(db: D1Database, userId: string): SyncEngine {
  const localDb = new LocalFinanceDB(`test-transfer-${crypto.randomUUID()}`);
  return new SyncEngine(localDb, {
    isOnline: () => true,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const res = await processSyncRequest(db, userId, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch,
  });
}

describe('v1.8.0: Account-to-Account Transfer (Savings, Fixed Deposit & Optional Fee)', () => {
  it('transfers between two linked savings accounts with fee without double deduction and supports paired undo', async () => {
    const db = createTestD1();
    const userId = 'owner';
    const engine = createSyncedEngine(db, userId);
    await engine.init();

    const bankA = await engine.saveAsset({
      itemName: '中信活存',
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

    const bankB = await engine.saveAsset({
      itemName: '台新活存',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '活存',
      liquidity: '高流動',
      quantityOrAmount: 50000,
      currency: 'TWD',
      unitPrice: 1,
      isLinkedSavings: true,
      balanceAnchorDate: '2026-11-01',
      balanceAnchorAt: '2026-11-01T00:00:00.000Z',
    });

    const transfer = await engine.transferBetweenAccounts({
      fromAccountId: bankA.id,
      toAccountId: bankB.id,
      date: '2026-11-15',
      amount: 30000,
      fee: 15,
      note: '月底資金調度',
    });

    expect(transfer.fromAdjustment?.amount).toBe(-30000);
    expect(transfer.toAdjustment?.amount).toBe(30000);
    expect(transfer.fromAdjustment?.transferGroupId).toBe(transfer.transferGroupId);
    expect(transfer.toAdjustment?.transferGroupId).toBe(transfer.transferGroupId);
    expect(transfer.feeCashflow?.twdAmount).toBe(15);
    expect(transfer.feeCashflow?.linkedAccountId).toBe(bankA.id);

    const syncRes = await engine.syncNow(true);
    expect(syncRes.ok).toBe(true);

    const snap = engine.getSnapshot();
    const sav = computeAllSavingsSummary(
      snap.assetItems,
      snap.cashflowLogs,
      snap.savingsAdjustments,
      32.5,
      DEFAULT_LEDGER_ID
    );
    const balA = sav.accounts.find((a) => a.account.id === bankA.id)?.currentBalanceTwd;
    const balB = sav.accounts.find((a) => a.account.id === bankB.id)?.currentBalanceTwd;

    // A: 100,000 - 30,000 (adj) - 15 (fee cashflow) = 69,985 (zero double deduction!)
    expect(balA).toBe(69985);
    // B: 50,000 + 30,000 = 80,000
    expect(balB).toBe(80000);
    // Total net worth only drops by the 15 TWD fee (150,000 -> 149,985)
    expect(sav.totalSavingsTwd).toBe(149985);
    // Only the 15 TWD fee is in cashflowLogs (principal 30,000 is NOT an expense)
    expect(snap.cashflowLogs).toHaveLength(1);
    expect(snap.cashflowLogs[0].twdAmount).toBe(15);

    // Paired undo deletes both sides atomically and syncs to D1
    const delRes = await engine.deleteSavingsAdjustment(transfer.fromAdjustment!.id, true);
    expect(delRes.deletedCount).toBe(2);
    await engine.syncNow(true);

    const exported = await exportFullSnapshot(db, userId);
    expect(exported.savingsAdjustments).toHaveLength(0);
  });

  it('supports transferring between linked savings and fixed deposit (both directions) with fee & balance guard', async () => {
    const db = createTestD1();
    const userId = 'owner';
    const engine = createSyncedEngine(db, userId);
    await engine.init();

    const checking = await engine.saveAsset({
      itemName: '玉山活存',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '活存',
      liquidity: '高流動',
      quantityOrAmount: 200000,
      currency: 'TWD',
      unitPrice: 1,
      isLinkedSavings: true,
      balanceAnchorDate: '2026-11-01',
      balanceAnchorAt: '2026-11-01T00:00:00.000Z',
    });

    const fixedDep = await engine.saveAsset({
      itemName: '台幣一年定存',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '定存/現金',
      liquidity: '中流動',
      quantityOrAmount: 100000,
      currency: 'TWD',
      unitPrice: 1,
    });

    const stock = await engine.saveAsset({
      itemName: '元大台灣50',
      majorType: '資產',
      updateMode: '自動更新',
      subCategory: '台股',
      liquidity: '高流動',
      ticker: '0050',
      quantityOrAmount: 1000,
      currency: 'TWD',
      unitPrice: 180,
    });

    expect(isTransferableAccount(checking)).toBe(true);
    expect(isTransferableAccount(fixedDep)).toBe(true);
    expect(isTransferableAccount(stock)).toBe(false);

    // 1. 活存 → 定存（轉存 80,000，免手續費）
    await engine.transferBetweenAccounts({
      fromAccountId: checking.id,
      toAccountId: fixedDep.id,
      date: '2026-11-10',
      amount: 80000,
      fee: 0,
      note: '新增一年定存',
    });

    // 2. 定存 → 活存（定存解約轉回 50,000 + 手續費 30）
    await engine.transferBetweenAccounts({
      fromAccountId: fixedDep.id,
      toAccountId: checking.id,
      date: '2026-11-20',
      amount: 50000,
      fee: 30,
      note: '部分定存解約',
    });

    // Reject overdraft from manual fixed deposit
    await expect(
      engine.transferBetweenAccounts({
        fromAccountId: fixedDep.id,
        toAccountId: checking.id,
        date: '2026-11-21',
        amount: 200000,
      })
    ).rejects.toThrow();

    await engine.syncNow(true);

    const snap = engine.getSnapshot();
    const updatedFixed = snap.assetItems.find((a) => a.id === fixedDep.id);
    // 定存: 100,000 + 80,000 - 50,000 - 30 = 129,970
    expect(updatedFixed?.quantityOrAmount).toBe(129970);

    const sav = computeAllSavingsSummary(
      snap.assetItems,
      snap.cashflowLogs,
      snap.savingsAdjustments,
      32.5
    );
    // 活存: 200,000 - 80,000 + 50,000 = 170,000 (fee came from fixedDep, so linkedAccountId is null)
    expect(sav.accounts[0].currentBalanceTwd).toBe(170000);

    // Total non-stock cash+deposit = 129,970 + 170,000 = 299,970 (300,000 - 30 fee)
    expect(snap.cashflowLogs).toHaveLength(1);
    expect(snap.cashflowLogs[0].linkedAccountId).toBeNull();
    expect(snap.cashflowLogs[0].twdAmount).toBe(30);
  });

  it('supports cross-currency (TWD -> USD) and cross-ledger transfers accurately', async () => {
    const db = createTestD1();
    const userId = 'owner';
    const engine = createSyncedEngine(db, userId);
    await engine.init();

    const twdSav = await engine.saveAsset({
      itemName: '台幣主活存',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '活存',
      liquidity: '高流動',
      quantityOrAmount: 100000,
      currency: 'TWD',
      unitPrice: 1,
      isLinkedSavings: true,
      balanceAnchorDate: '2026-11-01',
      balanceAnchorAt: '2026-11-01T00:00:00.000Z',
    });

    const indepLedger = await engine.saveLedger({
      name: '美金旅遊專戶',
      includeInNetWorth: false,
    });

    const usdFixed = await engine.saveAsset({
      itemName: '美金外幣定存',
      majorType: '資產',
      updateMode: '手動快照',
      subCategory: '美金',
      liquidity: '中流動',
      quantityOrAmount: 500,
      currency: 'USD',
      unitPrice: 1,
      ledgerId: indepLedger.id,
    });

    // Transfer 32,000 TWD -> actual bank FX fill 1,000 USD
    await engine.transferBetweenAccounts({
      fromAccountId: twdSav.id,
      toAccountId: usdFixed.id,
      date: '2026-11-18',
      amount: 32000,
      targetAmount: 1000,
      fee: 0,
      note: '換匯存旅遊專戶',
    });

    await engine.syncNow(true);
    const snap = engine.getSnapshot();
    const ledgers = snap.ledgers || [];

    // Personal net worth decreases by 32,000 (100,000 -> 68,000) because destination is an independent ledger
    const nwPersonal = computeNetWorthSummary(
      snap.assetItems,
      32,
      30000,
      snap.cashflowLogs,
      snap.savingsAdjustments,
      snap.stockTransactions,
      '2026-11-30',
      ledgers,
      'net_worth'
    );
    expect(nwPersonal.totalAssets).toBe(68000);

    // Independent ledger USD fixed deposit increases from 500 USD -> 1,500 USD (48,000 TWD @ 32)
    const updatedUsd = snap.assetItems.find((a) => a.id === usdFixed.id);
    expect(updatedUsd?.quantityOrAmount).toBe(1500);
    const nwTrip = computeNetWorthSummary(
      snap.assetItems,
      32,
      0,
      snap.cashflowLogs,
      snap.savingsAdjustments,
      snap.stockTransactions,
      '2026-11-30',
      ledgers,
      indepLedger.id
    );
    expect(nwTrip.totalAssets).toBe(48000);
  });
});
