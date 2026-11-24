import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { CASHFLOW_TYPES } from '../shared/constants';
import type { SyncResponse } from '../shared/types';

describe('Offline-First IndexedDB & SyncEngine', () => {
  let db: LocalFinanceDB;

  beforeEach(async () => {
    db = new LocalFinanceDB(`finance-test-${crypto.randomUUID()}`);
    await db.open();
  });

  it('commits offline expense immediately to local snapshot and queues mutation in outbox', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const engine = new SyncEngine(db, {
      fetchImpl: fetchMock,
      isOnline: () => false,
    });

    await engine.init();

    const created = await engine.addCashFlow({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '地下室買咖啡',
      amount: 135,
      currency: 'TWD',
      note: '離線測試',
    });

    expect(created.twdAmount).toBe(135);
    const snapshot = engine.getSnapshot();
    expect(snapshot.cashflowLogs).toHaveLength(1);
    expect(snapshot.cashflowLogs[0].itemName).toBe('地下室買咖啡');

    const outbox = await db.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].entity).toBe('cashflow');
    expect(outbox[0].op).toBe('upsert');
    expect(engine.getStatus().pendingCount).toBe(1);
    expect(engine.getStatus().state).toBe('offline');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues both cashflow and recurring mutations when makeRecurring is checked', async () => {
    const engine = new SyncEngine(db, {
      fetchImpl: vi.fn(),
      isOnline: () => false,
    });
    await engine.init();

    await engine.addCashFlow({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.INVESTMENT,
      category: '台股投資',
      itemName: '定期定額 0050',
      amount: 15000,
      currency: 'TWD',
      makeRecurring: true,
    });

    const snap = engine.getSnapshot();
    expect(snap.cashflowLogs).toHaveLength(1);
    expect(snap.recurringItems).toHaveLength(1);
    expect(snap.recurringItems[0].cycle).toBe('月繳');

    const outbox = await db.getOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox.map((m) => m.entity)).toEqual(['cashflow', 'recurring']);
  });

  it('flushes outbox on reconnect, merges remote delta, and clears acknowledged items', async () => {
    let online = false;
    const syncedMutationIds: string[] = [];

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const acked = (body.mutations || []).map((m: { mutationId: string }) => m.mutationId);
      syncedMutationIds.push(...acked);

      const responsePayload: SyncResponse = {
        ok: true,
        serverTime: '2026-11-23T09:00:00.000Z',
        ackedMutationIds: acked,
        rejected: [],
        delta: {
          settings: {
            monthlyDailyBudget: 50000,
            emergencyTargetMonths: 8,
            usdTwdRate: 32.8,
            fxUpdatedAt: '2026-11-23T08:00:00.000Z',
            updatedAt: '2026-11-23T08:00:00.000Z',
          },
          cashflowLogs: [
            {
              id: 'remote-log-1',
              date: '2026-11-20',
              yearMonth: '2026-11',
              type: CASHFLOW_TYPES.FIXED_INCOME,
              category: '薪資',
              itemName: '本業月薪',
              amount: 95000,
              currency: 'TWD',
              fxRate: 1,
              twdAmount: 95000,
              source: '自動入帳',
              note: '',
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:00:00.000Z',
              deletedAt: null,
            },
          ],
          recurringItems: [],
          sinkingItems: [],
          assetItems: [],
          netWorthHistory: [],
          rentUtilityRecords: [],
          rentUtilityRents: null,
        },
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const engine = new SyncEngine(db, {
      fetchImpl: fetchMock,
      isOnline: () => online,
    });
    await engine.init();

    await engine.addCashFlow({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '交通',
      itemName: '捷運',
      amount: 35,
      currency: 'TWD',
    });

    expect(engine.getStatus().pendingCount).toBe(1);

    // Reconnect and sync
    online = true;
    const result = await engine.syncNow();
    expect(result.ok).toBe(true);
    expect(syncedMutationIds).toHaveLength(1);
    expect(await db.getOutbox()).toHaveLength(0);
    expect(engine.getStatus().pendingCount).toBe(0);
    expect(engine.getStatus().state).toBe('synced');

    // Verify local + remote delta merged cleanly
    const snap = engine.getSnapshot();
    expect(snap.settings.monthlyDailyBudget).toBe(50000);
    expect(snap.cashflowLogs).toHaveLength(2);
    expect(snap.cashflowLogs.some((l) => l.id === 'remote-log-1')).toBe(true);
  });

  it('preserves outbox untouched and notifies onAuthRequired when sync receives 401', async () => {
    const onAuthRequired = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'AUTH_REQUIRED' }), { status: 401 })
    );

    const engine = new SyncEngine(db, {
      fetchImpl: fetchMock,
      isOnline: () => true,
      onAuthRequired,
    });
    await engine.init();

    await engine.addCashFlow({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '晚餐',
      amount: 220,
      currency: 'TWD',
    });

    const res = await engine.syncNow();
    expect(res.ok).toBe(false);
    expect(res.authRequired).toBe(true);
    expect(onAuthRequired).toHaveBeenCalledTimes(1);

    // Crucial offline-first guarantee: outbox MUST remain intact
    expect(await db.getOutbox()).toHaveLength(1);
    expect(engine.getSnapshot().cashflowLogs).toHaveLength(1);
  });

  it('applies remote soft deletes when merging delta', async () => {
    const engine = new SyncEngine(db, {
      fetchImpl: vi.fn(),
      isOnline: () => false,
    });
    await engine.init();

    const log = await engine.addCashFlow({
      date: '2026-11-23',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '誤記項目',
      amount: 500,
      currency: 'TWD',
    });

    await engine.deleteCashFlow(log.id);
    expect(engine.getSnapshot().cashflowLogs).toHaveLength(0);
    const outbox = await db.getOutbox();
    expect(outbox[outbox.length - 1]).toMatchObject({
      entity: 'cashflow',
      op: 'delete',
      recordId: log.id,
    });
  });

  it('saves, deletes, and syncs 5F & 6F rent utility records and fixed rents offline-first', async () => {
    const engine = new SyncEngine(db, {
      fetchImpl: vi.fn(),
      isOnline: () => false,
    });
    await engine.init();

    await engine.saveUtilityRecord({
      period: '11409',
      isBaseline: true,
      curTotal: 52803,
      cur6F: 4486,
      curA: 8989,
      curB: 5251,
      curC: 6026,
    });
    await engine.saveUtilityRecord({
      period: '11511',
      curTotal: 62500,
      cur6F: 8100,
      totalElec: 4200,
      totalWater: 550,
      f6People: 2,
      f5People: 3,
      curA: 260,
      curB: 5950,
      curC: 6460,
    });
    await engine.saveUtilityRents({ rent6F: 18000, rentA: 9500, rentB: 9000, rentC: 8500 });

    const snap = engine.getSnapshot();
    expect(snap.rentUtilityRecords).toHaveLength(2);
    expect(snap.rentUtilityRents.rent6F).toBe(18000);

    // Baseline deletion must be rejected
    await expect(engine.deleteUtilityRecord('11409')).rejects.toThrow(/起始表底/);

    await engine.deleteUtilityRecord('11511');
    expect(engine.getSnapshot().rentUtilityRecords).toHaveLength(1);
    const outbox = await db.getOutbox();
    expect(outbox.some((m) => m.entity === 'utility_record' && m.op === 'delete' && m.recordId === '11511')).toBe(true);
    expect(outbox.some((m) => m.entity === 'utility_rents' && m.op === 'upsert')).toBe(true);
  });
});
