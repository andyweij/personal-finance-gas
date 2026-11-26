import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '../shared/types';
import { orderMutationsByDependencies } from '../shared/syncOrder';
import { processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

/**
 * 上線後審查（2026-11-26 post-deploy review）發現 1：轉帳群組在「第一個成員」的位置就整組處理，
 * 但 orderMutationsByDependencies 只把依賴移到「參照它的那個成員」前面。
 * 離線時「新增帳戶 B → 從 A 轉帳到 B → 再編輯 B」會讓佇列變成 [legA, legB, B]，
 * 排序後為 [legA, B, legB]：群組在 legA 處執行時 B 尚不存在，M3 拒絕 legB，整組回滾。
 * it.fails：bug 仍存在時本測試「預期失敗」；修好後請改回 it。
 */
const UID = 'owner';
let n = 0;
function mut(
  entity: string,
  recordId: string,
  payload: Record<string, unknown>,
  atomicGroupId?: string
): SyncRequest['mutations'][number] {
  n += 1;
  return {
    mutationId: `pd-${n}-${crypto.randomUUID()}`,
    entity,
    op: 'upsert',
    recordId,
    clientTimestamp: new Date().toISOString(),
    baseVersion: null,
    payload,
    ...(atomicGroupId ? { atomicGroupId } : {}),
  } as SyncRequest['mutations'][number];
}
const savingsAcc = (name: string) => ({
  updateMode: '手動快照',
  majorType: '資產',
  subCategory: '活存',
  liquidity: '高流動',
  itemName: name,
  quantityOrAmount: 1000,
  currency: 'TWD',
  unitPrice: 1,
  isLinkedSavings: true,
  note: '',
});
const adj = (accountId: string, amount: number, tg: string) => ({
  accountId,
  date: '2026-11-26',
  amount,
  currency: 'TWD',
  note: '',
  transferGroupId: tg,
});
const req = (mutations: SyncRequest['mutations']) => ({ sinceSeq: 0, clientEpoch: 1, mutations }) as SyncRequest;

describe('post-deploy 發現 1：轉帳群組早於所參照的新帳戶', () => {
  for (const withGroupId of [true, false]) {
    it(`新帳戶排在兩邊轉帳之後時，轉帳應成立（atomicGroupId=${withGroupId}，false 即 v1.8.11 舊客戶端）`, async () => {
      const db = createTestD1();
      await processSyncRequest(db, UID, req([mut('asset', 'acc-a', savingsAcc('A'))]));
      const g = withGroupId ? 'tg-x' : undefined;
      const legA = mut('savings_adjustment', 'adj-out', adj('acc-a', -100, 'tg-x'), g);
      const legB = mut('savings_adjustment', 'adj-in', adj('acc-new', 100, 'tg-x'), g);
      const accNew = mut('asset', 'acc-new', savingsAcc('New（改名）'));
      const res = await processSyncRequest(db, UID, req([legA, legB, accNew]));
      expect(res.rejected).toEqual([]);
      expect(res.ackedMutationIds.sort()).toEqual([legA.mutationId, legB.mutationId, accNew.mutationId].sort());
    });
  }

  it('排序：新帳戶排在整個群組之前，群組成員連續輸出', () => {
    const legA = mut('savings_adjustment', 'adj-out', adj('acc-a', -100, 'tg-y'), 'tg-y');
    const legB = mut('savings_adjustment', 'adj-in', adj('acc-new2', 100, 'tg-y'), 'tg-y');
    const accNew = mut('asset', 'acc-new2', savingsAcc('N'));
    const ordered = orderMutationsByDependencies([legA, legB, accNew]).map((m) => m.recordId);
    expect(ordered).toEqual(['acc-new2', 'adj-out', 'adj-in']);
  });

  it('排序：群組成員的依賴之間仍保持各自的原始順序；沒有依賴時順序不變', () => {
    const a = mut('cashflow', 'c1', { date: '2026-11-26', type: '日常花費', itemName: 'x', amount: 1 });
    const legA = mut('savings_adjustment', 'o', adj('acc-a', -1, 'tg-z'), 'tg-z');
    const legB = mut('savings_adjustment', 'i', adj('acc-b', 1, 'tg-z'), 'tg-z');
    const b = mut('cashflow', 'c2', { date: '2026-11-26', type: '日常花費', itemName: 'y', amount: 1 });
    expect(orderMutationsByDependencies([a, legA, b, legB]).map((m) => m.recordId)).toEqual(['c1', 'o', 'i', 'c2']);
  });
});

describe('post-deploy 發現 2：v1.8.11 舊客戶端先送出子紀錄', () => {
  const cashflow = (accountId: string) => ({
    date: '2026-11-26',
    type: '日常花費',
    category: '餐飲',
    itemName: '午餐',
    amount: 120,
    currency: 'TWD',
    linkedAccountId: accountId,
  });

  it('沒有 refsOrdered：參照尚未送達（從未存在）的帳戶時接受，帳戶之後送達也正常', async () => {
    const db = createTestD1();
    const child = mut('cashflow', 'cf-1', cashflow('acc-later'));
    const r1 = await processSyncRequest(db, UID, req([child]));
    expect(r1.rejected).toEqual([]);
    expect(r1.ackedMutationIds).toEqual([child.mutationId]);
    const account = mut('asset', 'acc-later', savingsAcc('之後才送達'));
    const r2 = await processSyncRequest(db, UID, req([account]));
    expect(r2.ackedMutationIds).toEqual([account.mutationId]);
    const row = await db
      .prepare("SELECT linked_account_id FROM cashflow_logs WHERE user_id = ? AND id = 'cf-1'")
      .bind(UID)
      .first<{ linked_account_id: string }>();
    expect(row?.linked_account_id).toBe('acc-later');
  });

  it('沒有 refsOrdered：參照已刪除的帳戶仍拒絕', async () => {
    const db = createTestD1();
    await processSyncRequest(db, UID, req([mut('asset', 'acc-dead', savingsAcc('已刪除'))]));
    await processSyncRequest(db, UID, req([{ ...mut('asset', 'acc-dead', savingsAcc('已刪除')), op: 'delete', baseVersion: 1 } as never]));
    const child = mut('cashflow', 'cf-2', cashflow('acc-dead'));
    const res = await processSyncRequest(db, UID, req([child]));
    expect(res.ackedMutationIds).toEqual([]);
    expect(res.rejected.map((r) => r.mutationId)).toEqual([child.mutationId]);
  });

  it('沒有 refsOrdered：參照不存在的帳本也照 v1.8.11 行為接受；refsOrdered（新版客戶端）維持拒絕', async () => {
    const db = createTestD1();
    const legacy = mut('cashflow', 'cf-3', { ...cashflow(''), linkedAccountId: undefined, ledgerId: 'lg-later' });
    expect((await processSyncRequest(db, UID, req([legacy]))).ackedMutationIds).toEqual([legacy.mutationId]);
    const strict = mut('cashflow', 'cf-4', cashflow('acc-never'));
    const res = await processSyncRequest(db, UID, { ...req([strict]), refsOrdered: true });
    expect(res.ackedMutationIds).toEqual([]);
    expect(res.rejected.map((r) => r.mutationId)).toEqual([strict.mutationId]);
  });
});
