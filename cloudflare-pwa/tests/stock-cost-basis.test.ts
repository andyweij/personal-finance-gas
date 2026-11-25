import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  computeAllSavingsSummary,
  computeNetWorthSummary,
  computeStockPortfolioSummary,
  computeStockPositionSummary,
} from '../shared/calculations';
import type { AssetItem, StockTransaction } from '../shared/types';
import { validateAssetInput, validateStockTransactionInput } from '../shared/validation';
import { processSyncRequest, exportFullSnapshot, importFullSnapshot } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

function makeStockAsset(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: overrides.id || 'stock-0050',
    updateMode: '自動更新',
    majorType: '資產',
    subCategory: '台股',
    liquidity: '高流動',
    itemName: overrides.itemName || '0050 元大台灣50',
    ticker: overrides.ticker ?? 'TPE:0050',
    quantityOrAmount: overrides.quantityOrAmount ?? 1000,
    currency: overrides.currency || 'TWD',
    unitPrice: overrides.unitPrice ?? 40,
    costBasis: overrides.costBasis !== undefined ? overrides.costBasis : 40000,
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  };
}

function makeTx(overrides: Partial<StockTransaction>): StockTransaction {
  return {
    id: overrides.id || crypto.randomUUID(),
    assetId: overrides.assetId || 'stock-0050',
    date: overrides.date || '2026-06-01',
    txType: overrides.txType || 'buy',
    shares: overrides.shares ?? 0,
    totalAmount: overrides.totalAmount ?? 0,
    fee: overrides.fee ?? 0,
    linkedCashflowId: overrides.linkedCashflowId ?? null,
    note: overrides.note || '',
    createdAt: overrides.createdAt || '2026-06-01T01:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-06-01T01:00:00.000Z',
    deletedAt: overrides.deletedAt ?? null,
  };
}

describe('Stock cost basis, moving average, and dividend recovery calculations', () => {
  it('supports initial average cost baseline and accumulates subsequent buys accurately', () => {
    // Baseline: 1,000 shares @ avg 39 (total costBasis 39,000), current price 45
    const stock = makeStockAsset({ quantityOrAmount: 1000, costBasis: 39000, unitPrice: 45 });
    const buyMore = makeTx({
      id: 'tx-buy-1',
      date: '2026-07-01',
      txType: 'buy',
      shares: 1000,
      totalAmount: 43000, // 43 per share
    });

    const pos = computeStockPositionSummary(stock, [buyMore], 32.5);
    expect(pos.hasCostBasis).toBe(true);
    expect(pos.currentShares).toBe(2000);
    expect(pos.costBasis).toBe(82000);
    expect(pos.avgCostPerShare).toBe(41);
    expect(pos.marketValue).toBe(90000);
    expect(pos.unrealizedPnl).toBe(8000);
    expect(pos.unrealizedRoiPct).toBe(9.8); // 8000/82000 = 9.756%

    // Soft-deleting the buy cleanly restores the exact initial baseline (zero drift!)
    const posAfterDelete = computeStockPositionSummary(
      stock,
      [{ ...buyMore, deletedAt: '2026-07-02T00:00:00.000Z' }],
      32.5
    );
    expect(posAfterDelete.currentShares).toBe(1000);
    expect(posAfterDelete.costBasis).toBe(39000);
    expect(posAfterDelete.avgCostPerShare).toBe(39);
  });

  it('deducts cash dividends from unrecovered cost down to 0 and preserves excess recovery without divide-by-zero', () => {
    // 1,000 shares @ 40 (total 40,000), cash dividend 400 -> unrecovered cost 39,600 (39.60/share)
    const stock = makeStockAsset({ quantityOrAmount: 1000, costBasis: 40000, unitPrice: 42 });
    const div400 = makeTx({
      id: 'tx-div-1',
      date: '2026-07-15',
      txType: 'cash_dividend',
      totalAmount: 400,
    });

    const pos1 = computeStockPositionSummary(stock, [div400], 32.5);
    // Coexisting views:
    // 1) Price-only (不含息)
    expect(pos1.costBasis).toBe(40000);
    expect(pos1.avgCostPerShare).toBe(40);
    expect(pos1.unrealizedPnl).toBe(2000);
    expect(pos1.unrealizedRoiPct).toBe(5);
    // 2) Dividend-adjusted (配息扣成本)
    expect(pos1.cumulativeCashDividends).toBe(400);
    expect(pos1.unrecoveredCost).toBe(39600);
    expect(pos1.unrecoveredCostPerShare).toBe(39.6);
    expect(pos1.costRecoveryPct).toBe(1);
    expect(pos1.isCostRecovered).toBe(false);
    expect(pos1.totalReturnPnl).toBe(2400); // 2,000 price + 400 div
    expect(pos1.totalReturnRoiPct).toBe(6);

    // Now receive 54,600 more in dividends (total 55,000 > 40,000 cost basis)
    const divBig = makeTx({
      id: 'tx-div-2',
      date: '2027-07-15',
      txType: 'cash_dividend',
      totalAmount: 54600,
    });
    const posRecovered = computeStockPositionSummary(stock, [div400, divBig], 32.5);
    expect(posRecovered.unrecoveredCost).toBe(0);
    expect(posRecovered.unrecoveredCostPerShare).toBe(0);
    expect(posRecovered.isCostRecovered).toBe(true);
    expect(posRecovered.costRecoveryPct).toBe(100);
    expect(posRecovered.excessRecoveredCash).toBe(15000);
    expect(posRecovered.totalReturnPnl).toBe(57000); // 2,000 unrealized + 55,000 cash dividends
    expect(Number.isFinite(posRecovered.totalReturnRoiPct)).toBe(true);
    expect(posRecovered.totalReturnRoiPct).toBe(142.5); // 57000 / 40000

    // Buying 1,000 more shares @ 50 AFTER hitting zero transparently deducts the 15,000 excess cash
    const buyAfterZero = makeTx({
      id: 'tx-buy-after',
      date: '2027-08-01',
      txType: 'buy',
      shares: 1000,
      totalAmount: 50000,
    });
    const posAfterAdd = computeStockPositionSummary(stock, [div400, divBig, buyAfterZero], 32.5);
    expect(posAfterAdd.currentShares).toBe(2000);
    expect(posAfterAdd.costBasis).toBe(90000);
    expect(posAfterAdd.unrecoveredCost).toBe(35000); // 90,000 - 55,000
    expect(posAfterAdd.unrecoveredCostPerShare).toBe(17.5);
  });

  it('handles stock dividends by increasing shares and diluting avg cost without double-counting cost deduction', () => {
    const stock = makeStockAsset({ quantityOrAmount: 1000, costBasis: 40000, unitPrice: 40 });
    const stockDiv = makeTx({
      id: 'tx-sdiv-1',
      date: '2026-08-10',
      txType: 'stock_dividend',
      shares: 100, // 1.0 yuan stock dividend on 1,000 shares = 100 shares
      totalAmount: 0,
    });

    const pos = computeStockPositionSummary(stock, [stockDiv], 32.5);
    expect(pos.currentShares).toBe(1100);
    expect(pos.costBasis).toBe(40000); // total invested cost unchanged!
    expect(pos.avgCostPerShare).toBeCloseTo(36.3636, 4);
    expect(pos.marketValue).toBe(44000);
    expect(pos.unrealizedPnl).toBe(4000); // +4,000 (not +8,000!)
    expect(pos.cumulativeStockDividendShares).toBe(100);
  });

  it('applies moving-average cost on partial and full sells with realized P&L', () => {
    const stock = makeStockAsset({ quantityOrAmount: 2000, costBasis: 80000, unitPrice: 45 });
    const partialSell = makeTx({
      id: 'tx-sell-1',
      date: '2026-09-01',
      txType: 'sell',
      shares: 1000,
      totalAmount: 50000, // sold 1,000 @ 50
    });

    const pos = computeStockPositionSummary(stock, [partialSell], 32.5);
    expect(pos.currentShares).toBe(1000);
    expect(pos.avgCostPerShare).toBe(40); // unchanged by sell!
    expect(pos.costBasis).toBe(40000);
    expect(pos.realizedPnl).toBe(10000); // 50,000 - 40,000
    expect(pos.unrealizedPnl).toBe(5000); // 45,000 - 40,000
    expect(pos.totalReturnPnl).toBe(15000); // 5,000 unrealized + 10,000 realized
    expect(pos.totalReturnRoiPct).toBe(18.8); // 15,000 / 80,000 totalInvestedAllTime
  });

  it('maintains precision for odd-lot cost basis without rounding drift and updates net worth automatically', () => {
    const oddLot = makeStockAsset({
      id: 'stock-odd',
      quantityOrAmount: 300,
      costBasis: 10000, // 33.3333.../share
      unitPrice: 40,
    });
    const buyMore = makeTx({
      id: 'tx-odd-buy',
      assetId: 'stock-odd',
      txType: 'buy',
      shares: 200,
      totalAmount: 7000,
    });

    const portfolio = computeStockPortfolioSummary([oddLot], [buyMore], 32.5);
    expect(portfolio.totalCostBasisTwd).toBe(17000);
    expect(portfolio.totalMarketValueTwd).toBe(20000); // 500 * 40
    expect(portfolio.totalUnrealizedPnlTwd).toBe(3000);

    const nw = computeNetWorthSummary([oddLot], 32.5, 40000, [], [], [buyMore]);
    expect(nw.stockValue).toBe(20000);
    expect(nw.totalAssets).toBe(20000);
  });

  it('validates stock transaction payloads strictly', () => {
    expect(() =>
      validateStockTransactionInput({
        assetId: 'stock-1',
        date: '2026-06-01',
        txType: 'buy',
        shares: 0,
        totalAmount: 1000,
      })
    ).toThrow('買入或賣出股數需大於 0');

    expect(() =>
      validateStockTransactionInput({
        assetId: 'stock-1',
        date: '2026-06-01',
        txType: 'cash_dividend',
        totalAmount: 0,
      })
    ).toThrow('現金配息金額需大於 0');

    const vAsset = validateAssetInput({
      itemName: '0050',
      subCategory: '台股',
      quantityOrAmount: 1000,
      unitPrice: 40,
      costBasis: 39000,
    });
    expect(vAsset.costBasis).toBe(39000);
  });

  it('syncs stock costBasis, stock_transactions, and optional cashflow/savings linkage offline-first with D1', async () => {
    const d1 = createTestD1();
    const localDb = new LocalFinanceDB(`stock-sync-test-${crypto.randomUUID()}`);

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/sync') {
        const body = JSON.parse(String(init?.body || '{}'));
        const resp = await processSyncRequest(d1, 'owner', body);
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const engine = new SyncEngine(localDb, { fetchImpl: mockFetch, isOnline: () => true });
    await engine.init();

    // 1. Create a linked savings account with 500,000 baseline
    const savingsAcc = await engine.saveAsset({
      itemName: '中信活存',
      quantityOrAmount: 500000,
      currency: 'TWD',
      isLinkedSavings: true,
      isDefaultSavings: true,
      balanceAnchorDate: '2026-01-01',
      balanceAnchorAt: '2026-01-01T00:00:00.000Z',
    });

    // 2. Create stock with initial 1,000 shares @ 40 (costBasis 40,000)
    const stock = await engine.saveAsset({
      itemName: '0056 元大高股息',
      ticker: 'TPE:0056',
      subCategory: '台股',
      updateMode: '自動更新',
      quantityOrAmount: 1000,
      unitPrice: 42,
      costBasis: 40000,
    });

    // 3. Buy 1,000 more shares for 44,000 AND sync to cashflow + linked savings
    const buyRes = await engine.addStockTransaction({
      assetId: stock.id,
      date: '2026-06-15',
      txType: 'buy',
      shares: 1000,
      totalAmount: 44000,
      syncToCashflow: true,
      linkedAccountId: savingsAcc.id,
    });
    expect(buyRes.cashflow).not.toBeNull();

    // 4. Record 2,000 cash dividend AND sync to cashflow + linked savings
    const divRes = await engine.addStockTransaction({
      assetId: stock.id,
      date: '2026-07-15',
      txType: 'cash_dividend',
      totalAmount: 2000,
      syncToCashflow: true,
      linkedAccountId: savingsAcc.id,
    });
    expect(divRes.cashflow?.category).toBe('股息/配息');

    // Sync to D1
    const syncRes = await engine.syncNow();
    expect(syncRes.ok).toBe(true);

    // Verify savings balance deducted 44,000 and added 2,000 -> 458,000
    const snap = engine.getSnapshot();
    const savSum = computeAllSavingsSummary(
      snap.assetItems,
      snap.cashflowLogs,
      snap.savingsAdjustments,
      snap.settings.usdTwdRate
    );
    expect(savSum.totalSavingsTwd).toBe(458000);

    // Verify stock position derived across D1 export/import backup roundtrip
    const exported = await exportFullSnapshot(d1, 'owner');
    expect(exported.stockTransactions.length).toBe(2);
    const d1Pos = computeStockPositionSummary(
      exported.assetItems.find((a) => a.id === stock.id)!,
      exported.stockTransactions,
      32.5
    );
    expect(d1Pos.currentShares).toBe(2000);
    expect(d1Pos.costBasis).toBe(84000);
    expect(d1Pos.unrecoveredCost).toBe(82000);

    // Import into a brand new D1 database to verify backup restore integrity
    const d1Restored = createTestD1();
    await importFullSnapshot(d1Restored, 'owner', exported, 'replace');
    const restored = await exportFullSnapshot(d1Restored, 'owner');
    expect(restored.stockTransactions.length).toBe(2);
    expect(restored.assetItems.find((a) => a.id === stock.id)?.costBasis).toBe(40000);

    // Deleting linked stock tx with deleteLinkedCashflow = true restores both stock and savings
    await engine.deleteStockTransaction(buyRes.tx.id, true);
    const afterDelSnap = engine.getSnapshot();
    const savAfterDel = computeAllSavingsSummary(
      afterDelSnap.assetItems,
      afterDelSnap.cashflowLogs,
      afterDelSnap.savingsAdjustments,
      afterDelSnap.settings.usdTwdRate
    );
    expect(savAfterDel.totalSavingsTwd).toBe(502000); // 500,000 + 2,000 dividend
    const stockAfterDel = computeStockPositionSummary(
      afterDelSnap.assetItems.find((a) => a.id === stock.id)!,
      afterDelSnap.stockTransactions,
      32.5
    );
    expect(stockAfterDel.currentShares).toBe(1000);
    expect(stockAfterDel.costBasis).toBe(40000);
    expect(stockAfterDel.unrecoveredCost).toBe(38000);
  });
});
