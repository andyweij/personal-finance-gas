/**
 * v1.8.17 審查的重現測試（docs/reviews/2026-11-27_v1.8.17_review.md）。
 *
 * it.fails：問題仍存在時本測試「預期失敗」；修好後請改回 it。
 * it：記錄目前（設計上）的行為，作為之後調整時的對照。
 */
import { describe, expect, it } from 'vitest';
import { orderMutationsByDependencies } from '../shared/syncOrder';
import { filterCashFlowsByLedgerScope } from '../shared/calculations';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

const cashflow = (extra: Record<string, unknown>) => ({
  date: '2026-11-26',
  type: '日常花費',
  category: '餐飲',
  itemName: '午餐',
  amount: 100,
  currency: 'TWD',
  ...extra,
});

const savingsAccount = (name: string) => ({
  itemName: name,
  majorType: '資產',
  updateMode: '手動快照',
  subCategory: '活存',
  liquidity: '高流動',
  quantityOrAmount: 1000,
  currency: 'TWD',
  unitPrice: 1,
  isLinkedSavings: true,
});

/** refsOrdered 省略時即 v1.8.11 舊客戶端的請求（走寬鬆的 M3 檢查） */
async function send(
  db: D1Database,
  uid: string,
  mutations: Array<{ entity: string; recordId: string; payload: Record<string, unknown> }>,
  refsOrdered = false
) {
  return processSyncRequest(db, uid, {
    sinceSeq: 0,
    clientEpoch: 1,
    ...(refsOrdered ? { refsOrdered: true } : {}),
    mutations: mutations.map((m) => ({
      mutationId: crypto.randomUUID(),
      clientTimestamp: new Date().toISOString(),
      baseVersion: null,
      op: 'upsert',
      ...m,
    })),
  } as never);
}

type Mut = { id: number; entity: string; op: string; recordId: string; payload: Record<string, unknown>; atomicGroupId?: string };

describe('發現 1：依賴排序讓同一筆紀錄的後續異動排到它自己的新增之前', () => {
  // 最小反例（隨機測試 3000 組中找到 301 組違反；v1.8.16 的排序在同一輸入下正確）。
  // 群組 g 的成員參照帳戶 A0，而 A0 的新增也在群組 g 內、之後還有一筆群組外的編輯。
  const input: Mut[] = [
    { id: 0, entity: 'savings_adjustment', op: 'upsert', recordId: 'S0', payload: { accountId: 'A0' }, atomicGroupId: 'g' },
    { id: 1, entity: 'asset', op: 'upsert', recordId: 'A0', payload: {}, atomicGroupId: 'g' },
    { id: 2, entity: 'asset', op: 'upsert', recordId: 'A0', payload: {} },
  ];

  it.fails('同一筆紀錄（asset:A0）的異動應維持原本的先後順序', () => {
    const out = orderMutationsByDependencies(input).map((m) => m.id);
    // 目前輸出 [2, 0, 1]：A0 的編輯（2）排在 A0 的新增（1）之前
    expect(out.indexOf(1)).toBeLessThan(out.indexOf(2));
  });

  it('輸出仍是輸入的排列，群組成員仍連續（不變條件的其他部分成立）', () => {
    const out = orderMutationsByDependencies(input).map((m) => m.id);
    expect([...out].sort()).toEqual([0, 1, 2]);
    expect(Math.abs(out.indexOf(0) - out.indexOf(1))).toBe(1);
  });
});

describe('發現 2：寬鬆路徑接受的懸空帳本參照，讓使用者自己的備份無法再匯入', () => {
  it('不帶 refsOrdered 時，指向從未存在之帳本的流水帳被接受，且在淨值與預設帳本檢視中都看不到', async () => {
    const db = createTestD1();
    const lenient = await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ ledgerId: 'ghost-ledger' }) }]);
    expect(lenient.rejected ?? []).toEqual([]);

    const strict = await send(db, UID, [{ entity: 'cashflow', recordId: 'c2', payload: cashflow({ ledgerId: 'ghost-ledger' }) }], true);
    expect(strict.rejected?.length).toBe(1);

    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never);
    const logs = pull.delta.cashflowLogs || [];
    expect(filterCashFlowsByLedgerScope(logs, 'net_worth', pull.delta.ledgers)).toHaveLength(0);
    expect(filterCashFlowsByLedgerScope(logs, 'default', pull.delta.ledgers)).toHaveLength(0);
    expect(filterCashFlowsByLedgerScope(logs, 'all', pull.delta.ledgers)).toHaveLength(1);
  });

  it.fails('使用者匯出的備份應能以取代模式匯回', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ ledgerId: 'ghost-ledger' }) }]);
    const backup = await exportFullSnapshot(db, UID);
    // 目前拋出「匯入資料中有 1 筆紀錄指向不存在的帳本…」
    await expect(importFullSnapshot(db, UID, backup, 'replace')).resolves.toBeTruthy();
  });
});

describe('寬鬆路徑的範圍（記錄目前行為）', () => {
  it('指向「其他使用者」的帳戶 id 會被當成從未存在而接受；不會讀到或改到對方資料', async () => {
    const db = createTestD1();
    await send(db, 'bob', [{ entity: 'asset', recordId: 'bob-acc', payload: savingsAccount('Bob 的帳戶') }], true);
    const res = await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ linkedAccountId: 'bob-acc' }) }]);
    expect(res.rejected ?? []).toEqual([]);

    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never);
    expect((pull.delta.assetItems || []).some((a) => a.id === 'bob-acc')).toBe(false);
    const bobRow = await db
      .prepare('SELECT item_name FROM asset_items WHERE user_id = ? AND id = ?')
      .bind('bob', 'bob-acc')
      .first<{ item_name: string }>();
    expect(bobRow?.item_name).toBe('Bob 的帳戶');
  });

  it('寬鬆檢查不限新紀錄：把既有流水帳改成指向不存在的帳戶也會被接受', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({}) }], true);
    const row = await db.prepare('SELECT version FROM cashflow_logs WHERE id = ?').bind('c1').first<{ version: number }>();
    const res = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: crypto.randomUUID(),
          clientTimestamp: new Date().toISOString(),
          baseVersion: row?.version,
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'c1',
          payload: cashflow({ linkedAccountId: 'never-existed' }),
        },
      ],
    } as never);
    expect(res.rejected ?? []).toEqual([]);
  });

  it('指向已刪除的帳戶仍拒絕；但取代模式匯入會清掉已刪除的紀錄，之後同一請求就被接受', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'asset', recordId: 'acc-x', payload: savingsAccount('X') }], true);
    const v = await db.prepare('SELECT version FROM asset_items WHERE id = ?').bind('acc-x').first<{ version: number }>();
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      refsOrdered: true,
      mutations: [
        { mutationId: crypto.randomUUID(), clientTimestamp: 'x', baseVersion: v?.version, entity: 'asset', op: 'delete', recordId: 'acc-x', payload: {} },
      ],
    } as never);

    const before = await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ linkedAccountId: 'acc-x' }) }]);
    expect(before.rejected?.length).toBe(1);

    await importFullSnapshot(db, UID, await exportFullSnapshot(db, UID), 'replace');
    const epoch = (await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never)).dataEpoch;
    const after = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: epoch,
      mutations: [
        { mutationId: crypto.randomUUID(), clientTimestamp: 'x', baseVersion: null, entity: 'cashflow', op: 'upsert', recordId: 'c2', payload: cashflow({ linkedAccountId: 'acc-x' }) },
      ],
    } as never);
    expect(after.rejected ?? []).toEqual([]);
  });
});
