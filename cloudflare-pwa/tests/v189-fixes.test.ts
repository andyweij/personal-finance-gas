import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '../shared/types';
import { processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

const cfPayload = (name: string) => ({
  date: '2026-11-26',
  type: '日常花費',
  category: '餐飲',
  itemName: name,
  amount: 100,
  currency: 'TWD',
});

function d1Fetch(db: D1Database): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
    const res = await processSyncRequest(db, UID, body);
    return new Response(JSON.stringify(res), { status: 200 });
  }) as typeof fetch;
}

describe('v1.8.9 fixes (V1 write-health evidence, R-1 transaction abort)', () => {
  it('V1: a real poison pill is still quarantined when the server confirms its write path is healthy', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v189-poison-${crypto.randomUUID()}`);
    const realFetch = d1Fetch(db);
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.some((m) => m.payload?.itemName === '毒丸')) {
        return new Response(JSON.stringify({ error: 'poison crash' }), { status: 500 });
      }
      return realFetch(input, init);
    };
    const engine = new SyncEngine(localDb, {
      fetchImpl,
      isOnline: () => true,
      retryBaseDelayMs: 60_000,
      maxPoisonRetries: 2,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    await engine.addCashFlow(cfPayload('毒丸'));
    await engine.addCashFlow(cfPayload('正常一'));
    await engine.addCashFlow(cfPayload('正常二'));
    await engine.addCashFlow(cfPayload('正常三'));

    for (let i = 0; i < 4; i++) {
      await engine.syncNow();
    }

    // Each 5xx of the poison is followed by a successful write-health probe → counted → quarantined (payload kept)
    expect(engine.getRejections().map((r) => [r.clientPayload?.itemName, r.resolutionStatus])).toEqual([
      ['毒丸', 'quarantined'],
    ]);
    expect(await localDb.getOutbox()).toHaveLength(0);
    const rows = await db
      .prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL')
      .bind(UID)
      .all<{ item_name: string }>();
    expect((rows.results || []).map((r) => r.item_name).sort()).toEqual(['正常一', '正常三', '正常二']);

    engine.destroy();
    localDb.close();
  });

  it('V1: two poison pills at the head of the queue are both quarantined and the healthy items behind them drain', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v189-two-poison-${crypto.randomUUID()}`);
    const realFetch = d1Fetch(db);
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.some((m) => String(m.payload?.itemName || '').startsWith('毒'))) {
        return new Response(JSON.stringify({ error: 'poison crash' }), { status: 500 });
      }
      return realFetch(input, init);
    };
    const engine = new SyncEngine(localDb, {
      fetchImpl,
      isOnline: () => true,
      retryBaseDelayMs: 60_000,
      maxPoisonRetries: 2,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();

    await engine.addCashFlow(cfPayload('毒一'));
    await engine.addCashFlow(cfPayload('毒二'));
    await engine.addCashFlow(cfPayload('正常一'));
    await engine.addCashFlow(cfPayload('正常二'));

    for (let i = 0; i < 10; i++) {
      await engine.syncNow();
    }

    expect(engine.getRejections().map((r) => r.clientPayload?.itemName).sort()).toEqual(['毒一', '毒二']);
    expect(await localDb.getOutbox()).toHaveLength(0);
    const rows = await db
      .prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL')
      .bind(UID)
      .all<{ item_name: string }>();
    expect((rows.results || []).map((r) => r.item_name).sort()).toEqual(['正常一', '正常二']);

    engine.destroy();
    localDb.close();
  });

  it('V1: the server performs the write-health probe only when asked and reports writeProbeOk', async () => {
    const db = createTestD1();
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [], writeProbe: true });
    expect(res.writeProbeOk).toBe(true);
    const res2 = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    expect(res2.writeProbeOk).toBeUndefined();
  });

  it('R-1: an exception inside the re-apply transaction rejects instead of hanging the engine lock', async () => {
    const localDb = new LocalFinanceDB(`v189-abort-${crypto.randomUUID()}`);
    await localDb.open();
    await localDb.saveFrozenOutbox([
      {
        mutationId: 'frozen-1',
        entity: 'cashflow',
        op: 'upsert',
        recordId: 'cf-1',
        clientTimestamp: '2026-11-26T00:00:00.000Z',
        baseVersion: null,
        payload: cfPayload('x'),
      },
    ]);

    const outcome = await Promise.race([
      localDb
        .reapplyFrozenOutboxTx(() => {
          throw new Error('boom');
        })
        .then(
          () => 'resolved',
          (err: unknown) => `rejected:${err instanceof Error ? err.message : String(err)}`
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    expect(outcome).toBe('rejected:boom');
    // Transaction was aborted: frozen outbox is untouched
    expect((await localDb.getFrozenOutbox()).map((m) => m.mutationId)).toEqual(['frozen-1']);
    localDb.close();
  });
});
