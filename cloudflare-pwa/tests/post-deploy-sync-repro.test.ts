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
    it.fails(`新帳戶排在兩邊轉帳之後時，轉帳應成立（atomicGroupId=${withGroupId}，false 即 v1.8.11 舊客戶端）`, async () => {
      const db = createTestD1();
      await processSyncRequest(db, UID, req([mut('asset', 'acc-a', savingsAcc('A'))]));
      const g = withGroupId ? 'tg-x' : undefined;
      const legA = mut('savings_adjustment', 'adj-out', adj('acc-a', -100, 'tg-x'), g);
      const legB = mut('savings_adjustment', 'adj-in', adj('acc-new', 100, 'tg-x'), g);
      const accNew = mut('asset', 'acc-new', savingsAcc('New（改名）'));
      const res = await processSyncRequest(db, UID, req([legA, legB, accNew]));
      // 目前實際結果：只 ack accNew，legA / legB 都在 rejected（rolled_back）
      expect(res.rejected).toEqual([]);
      expect(res.ackedMutationIds.sort()).toEqual([legA.mutationId, legB.mutationId, accNew.mutationId].sort());
    });
  }

  it('現況記錄：排序後新帳戶夾在兩個成員之間（根因）', () => {
    const legA = mut('savings_adjustment', 'adj-out', adj('acc-a', -100, 'tg-y'), 'tg-y');
    const legB = mut('savings_adjustment', 'adj-in', adj('acc-new2', 100, 'tg-y'), 'tg-y');
    const accNew = mut('asset', 'acc-new2', savingsAcc('N'));
    const ordered = orderMutationsByDependencies([legA, legB, accNew]).map((m) => m.recordId);
    expect(ordered).toEqual(['adj-out', 'acc-new2', 'adj-in']);
  });
});
