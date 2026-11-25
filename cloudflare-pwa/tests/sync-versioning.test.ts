import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './helpers/mockD1';
import { processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { CASHFLOW_TYPES } from '../shared/constants';
import type { SyncRequest } from '../shared/types';

describe('Optimistic Locking (version) & Offline Conflict Resolution', () => {
  let d1: D1Database;

  beforeEach(() => {
    d1 = createTestD1();
  });

  it('increments server version monotonically (1 -> 2 -> 3) and is immune to client clock skew', async () => {
    // 1. Create asset -> version 1
    const r1 = await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'm-1',
          entity: 'asset',
          op: 'upsert',
          recordId: 'asset-ver-1',
          clientTimestamp: '2026-11-24T10:00:00.000Z',
          baseVersion: null,
          payload: {
            updateMode: '手動快照',
            majorType: '負債',
            subCategory: '房貸餘額',
            liquidity: '負債',
            itemName: '自住房貸',
            quantityOrAmount: 3760328,
            currency: 'TWD',
            unitPrice: 1,
            note: '初始',
          },
        },
      ],
    });
    expect(r1.ackedMutationIds).toEqual(['m-1']);
    expect(r1.conflicts || []).toHaveLength(0);
    const created = r1.delta.assetItems.find((a) => a.id === 'asset-ver-1');
    expect(created?.version).toBe(1);

    // 2. Update with baseVersion=1 even if client clock is skewed 2 hours backward -> succeeds to v2
    const r2 = await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'm-2',
          entity: 'asset',
          op: 'upsert',
          recordId: 'asset-ver-1',
          clientTimestamp: '2026-11-24T08:00:00.000Z', // skewed earlier!
          baseVersion: 1,
          payload: {
            updateMode: '手動快照',
            majorType: '負債',
            subCategory: '房貸餘額',
            liquidity: '負債',
            itemName: '自住房貸',
            quantityOrAmount: 3320000,
            currency: 'TWD',
            unitPrice: 1,
            note: '電腦校準',
          },
        },
      ],
    });
    expect(r2.ackedMutationIds).toEqual(['m-2']);
    expect(r2.conflicts || []).toHaveLength(0);
    expect(r2.delta.assetItems.find((a) => a.id === 'asset-ver-1')?.version).toBe(2);
    expect(r2.delta.assetItems.find((a) => a.id === 'asset-ver-1')?.quantityOrAmount).toBe(3320000);

    // 3. Update with baseVersion=2 -> succeeds to v3
    const r3 = await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'm-3',
          entity: 'asset',
          op: 'upsert',
          recordId: 'asset-ver-1',
          clientTimestamp: '2026-11-24T08:05:00.000Z',
          baseVersion: 2,
          payload: {
            updateMode: '手動快照',
            majorType: '負債',
            subCategory: '房貸餘額',
            liquidity: '負債',
            itemName: '自住房貸',
            quantityOrAmount: 3300000,
            currency: 'TWD',
            unitPrice: 1,
            note: '再次更新',
          },
        },
      ],
    });
    expect(r3.ackedMutationIds).toEqual(['m-3']);
    expect(r3.delta.assetItems.find((a) => a.id === 'asset-ver-1')?.version).toBe(3);
  });

  it('detects stale offline edit conflict without overwriting D1 and without blocking non-conflicting mutations', async () => {
    // Seed v1
    await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'seed-1',
          entity: 'asset',
          op: 'upsert',
          recordId: 'mortgage-1',
          clientTimestamp: '2026-11-24T10:00:00.000Z',
          baseVersion: null,
          payload: {
            updateMode: '手動快照',
            majorType: '負債',
            subCategory: '房貸餘額',
            liquidity: '負債',
            itemName: '自住房貸',
            quantityOrAmount: 3760328,
            currency: 'TWD',
            unitPrice: 1,
            note: '',
          },
        },
      ],
    });

    // Desktop edits online: v1 -> v2 (updates balance to 3,320,000)
    await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'desktop-v2',
          entity: 'asset',
          op: 'upsert',
          recordId: 'mortgage-1',
          clientTimestamp: '2026-11-24T10:05:00.000Z',
          baseVersion: 1,
          payload: {
            updateMode: '手動快照',
            majorType: '負債',
            subCategory: '房貸餘額',
            liquidity: '負債',
            itemName: '自住房貸',
            quantityOrAmount: 3320000,
            currency: 'TWD',
            unitPrice: 1,
            note: '電腦校準餘額',
          },
        },
      ],
    });

    // iPhone was offline at v1, later at 10:10 edits note on mortgage-1 AND adds a new lunch cashflow
    const phoneSync = await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'phone-stale-asset',
          entity: 'asset',
          op: 'upsert',
          recordId: 'mortgage-1',
          clientTimestamp: '2026-11-24T10:10:00.000Z', // newer timestamp, but stale baseVersion=1!
          baseVersion: 1,
          payload: {
            updateMode: '手動快照',
            majorType: '負債',
            subCategory: '房貸餘額',
            liquidity: '負債',
            itemName: '自住房貸',
            quantityOrAmount: 3760328,
            currency: 'TWD',
            unitPrice: 1,
            note: '手機改備註',
          },
        },
        {
          mutationId: 'phone-new-lunch',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-lunch-1',
          clientTimestamp: '2026-11-24T10:11:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-24',
            type: CASHFLOW_TYPES.DAILY_EXPENSE,
            category: '餐飲',
            itemName: '午餐便當',
            amount: 150,
            currency: 'TWD',
            fxRate: 1,
            source: '手機記帳',
            note: '',
          },
        },
      ],
    });

    // New lunch cashflow succeeds (not blocked!), while stale asset edit goes to conflicts
    expect(phoneSync.ackedMutationIds).toEqual(['phone-new-lunch']);
    expect(phoneSync.conflicts).toHaveLength(1);
    expect(phoneSync.conflicts?.[0]).toMatchObject({
      mutationId: 'phone-stale-asset',
      entity: 'asset',
      recordId: 'mortgage-1',
      baseVersion: 1,
      serverVersion: 2,
    });
    expect(phoneSync.conflicts?.[0].serverRecord?.quantityOrAmount).toBe(3320000);

    // D1 MUST still hold Desktop's v2 balance (NOT overwritten by iPhone's newer timestamp!)
    const dbRow = await d1
      .prepare('SELECT quantity_or_amount, note, version FROM asset_items WHERE id = ?')
      .bind('mortgage-1')
      .first<{ quantity_or_amount: number; note: string; version: number }>();
    expect(dbRow).toEqual({
      quantity_or_amount: 3320000,
      note: '電腦校準餘額',
      version: 2,
    });
  });

  it('persists conflicts in SyncEngine and resolves cleanly via Keep Local (bumps to v3) and Keep Server', async () => {
    const dbA = new LocalFinanceDB(`ver-a-${crypto.randomUUID()}`);
    const dbB = new LocalFinanceDB(`ver-b-${crypto.randomUUID()}`);
    await dbA.open();
    await dbB.open();

    let onlineB = true;
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      const res = await processSyncRequest(d1, 'owner', req);
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const engineA = new SyncEngine(dbA, { fetchImpl: mockFetch, isOnline: () => true });
    const engineB = new SyncEngine(dbB, { fetchImpl: mockFetch, isOnline: () => onlineB });
    await engineA.init();
    await engineB.init();

    // Device A creates an asset & syncs -> v1
    const asset = await engineA.saveAsset({
      updateMode: '手動快照',
      majorType: '資產',
      subCategory: '定存/現金',
      liquidity: '高流動',
      itemName: '台幣定存',
      quantityOrAmount: 100000,
      currency: 'TWD',
    });
    await engineA.syncNow();
    await engineB.syncNow(true);
    expect(engineB.getSnapshot().assetItems.find((a) => a.id === asset.id)?.version).toBe(1);

    // Device B goes offline; Device A updates online to 150,000 (v2)
    onlineB = false;
    await engineA.saveAsset({ ...engineA.getSnapshot().assetItems[0], quantityOrAmount: 150000, note: 'A改15萬' });
    await engineA.syncNow();

    // Device B edits offline (based on v1) to 120,000
    await engineB.saveAsset({ ...engineB.getSnapshot().assetItems[0], quantityOrAmount: 120000, note: 'B改12萬' });

    // Device B reconnects and syncs -> conflict detected and persisted!
    onlineB = true;
    await engineB.syncNow();
    expect(engineB.getConflicts()).toHaveLength(1);
    expect(engineB.getStatus().state).toBe('conflict');
    expect(engineB.getStatus().conflictCount).toBe(1);

    // Reload Device B from IndexedDB -> conflict is still persisted
    const engineBReloaded = new SyncEngine(dbB, { fetchImpl: mockFetch, isOnline: () => true });
    await engineBReloaded.init();
    expect(engineBReloaded.getConflicts()).toHaveLength(1);

    // Resolve by keeping local (120,000) -> advances server to v3 and clears conflicts
    const conflictId = engineBReloaded.getConflicts()[0].mutationId;
    await engineBReloaded.resolveConflictKeepLocal(conflictId);
    expect(engineBReloaded.getConflicts()).toHaveLength(0);
    expect(engineBReloaded.getStatus().state).toBe('synced');
    const finalAsset = engineBReloaded.getSnapshot().assetItems.find((a) => a.id === asset.id);
    expect(finalAsset?.quantityOrAmount).toBe(120000);
    expect(finalAsset?.version).toBe(3);

    // Now test Keep Server resolution: A updates online (v3 -> v4) while B is stale at v3
    await engineA.syncNow();
    await engineA.saveAsset({ ...engineA.getSnapshot().assetItems[0], quantityOrAmount: 200000, note: 'A改20萬' });
    await engineA.syncNow();

    await engineBReloaded.saveAsset({ ...finalAsset!, quantityOrAmount: 180000, note: 'B改18萬' });
    await engineBReloaded.syncNow();
    expect(engineBReloaded.getConflicts()).toHaveLength(1);

    await engineBReloaded.resolveConflictKeepServer(engineBReloaded.getConflicts()[0].mutationId);
    expect(engineBReloaded.getConflicts()).toHaveLength(0);
    expect(engineBReloaded.getSnapshot().assetItems.find((a) => a.id === asset.id)?.quantityOrAmount).toBe(200000);
    expect(engineBReloaded.getSnapshot().assetItems.find((a) => a.id === asset.id)?.version).toBe(4);
  });

  it('coalesces multiple offline edits to the same record in Outbox while preserving original baseVersion', async () => {
    const db = new LocalFinanceDB(`ver-coal-${crypto.randomUUID()}`);
    await db.open();
    const engine = new SyncEngine(db, { fetchImpl: vi.fn(), isOnline: () => false });
    await engine.init();

    // 1. Brand-new offline record edited twice -> single coalesced upsert with baseVersion=null
    const created = await engine.saveAsset({
      updateMode: '手動快照',
      majorType: '資產',
      subCategory: '定存/現金',
      liquidity: '高流動',
      itemName: '現金袋',
      quantityOrAmount: 5000,
      currency: 'TWD',
    });
    await engine.saveAsset({ ...created, quantityOrAmount: 8000 });
    let outbox = await db.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].baseVersion).toBeNull();
    expect(outbox[0].payload?.quantityOrAmount).toBe(8000);

    // 2. Deleting a brand-new never-synced record cancels out completely -> 0 outbox entries
    await engine.deleteAsset(created.id);
    outbox = await db.getOutbox();
    expect(outbox).toHaveLength(0);
  });

  it('remains backward-compatible when legacy mutations omit baseVersion', async () => {
    const r1 = await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'legacy-1',
          entity: 'settings',
          op: 'upsert',
          recordId: '1',
          clientTimestamp: '2099-01-01T00:00:00.000Z',
          payload: { monthlyDailyBudget: 25000, emergencyTargetMonths: 6, usdTwdRate: 32.5 },
        },
      ],
    });
    expect(r1.ackedMutationIds).toEqual(['legacy-1']);
    expect(r1.conflicts || []).toHaveLength(0);
    expect(r1.delta.settings?.monthlyDailyBudget).toBe(25000);
    expect(r1.delta.settings?.version).toBe(2);

    // Stale legacy mutation with older timestamp is safely ignored via LWW without conflict
    const r2 = await processSyncRequest(d1, 'owner', {
      mutations: [
        {
          mutationId: 'legacy-old',
          entity: 'settings',
          op: 'upsert',
          recordId: '1',
          clientTimestamp: '2020-01-01T00:00:00.000Z',
          payload: { monthlyDailyBudget: 12000, emergencyTargetMonths: 6, usdTwdRate: 32.5 },
        },
      ],
    });
    expect(r2.ackedMutationIds).toEqual(['legacy-old']);
    expect(r2.conflicts || []).toHaveLength(0);
    expect(r2.delta.settings?.monthlyDailyBudget).toBe(25000);
    expect(r2.delta.settings?.version).toBe(2);
  });
});
