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

describe('v1.8.9 fixes (V1 probe evidence, R-1 transaction abort)', () => {
  it('V1: a real poison pill is still quarantined once enough probe writes of other records succeed after it', async () => {
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

    // Two probe writes succeeded right after the poison failed → retryCount 2 → quarantined (payload kept)
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

  it('V1: a probe rejected by the server (possibly only because of ordering) stays queued instead of being dropped', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v189-probe-reject-${crypto.randomUUID()}`);
    const realFetch = d1Fetch(db);
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.some((m) => m.payload?.itemName === '毒丸')) {
        return new Response(JSON.stringify({ error: 'poison crash' }), { status: 500 });
      }
      const res = await realFetch(input, init);
      const json = (await res.json()) as Record<string, unknown> & {
        ackedMutationIds: string[];
        rejected: Array<{ mutationId: string; reason: string }>;
      };
      // Pretend the server rejects the probe (e.g. it depended on the poison)
      const probe = body.mutations.find((m) => m.payload?.itemName === '依賴毒丸');
      if (probe) {
        json.ackedMutationIds = json.ackedMutationIds.filter((id) => id !== probe.mutationId);
        json.rejected = [...json.rejected, { mutationId: probe.mutationId, reason: 'depends on poison' }];
      }
      return new Response(JSON.stringify(json), { status: 200 });
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
    await engine.addCashFlow(cfPayload('依賴毒丸'));
    for (let i = 0; i < 3; i++) {
      await engine.syncNow();
    }

    expect(engine.getRejections()).toHaveLength(0);
    expect((await localDb.getOutbox()).map((m) => m.payload?.itemName).sort()).toEqual(['依賴毒丸', '毒丸']);

    engine.destroy();
    localDb.close();
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
