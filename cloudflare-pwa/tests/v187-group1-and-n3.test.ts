import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncMutation, SyncRequest } from '../shared/types';
import { importFullSnapshot, processSyncRequest } from '../worker/sync';
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

const assetPayload = (name: string, note = '') => ({
  updateMode: '手動快照',
  majorType: '資產',
  subCategory: '其他資產',
  liquidity: '中流動',
  itemName: name,
  quantityOrAmount: 1000,
  currency: 'TWD',
  unitPrice: 1,
  note,
});

function d1Fetch(db: D1Database, onReq?: (req: SyncRequest) => void): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
    onReq?.(body);
    const res = await processSyncRequest(db, UID, body);
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function newEngine(
  localDb: LocalFinanceDB,
  fetchImpl: typeof fetch,
  extra: Record<string, unknown> = {}
) {
  return new SyncEngine(localDb, {
    fetchImpl,
    isOnline: () => true,
    retryBaseDelayMs: 60_000,
    requestLock: async (_name, fn) => fn(),
    ...extra,
  });
}

describe('v1.8.7 Group 1 (Q1, Q2/N2, Q4/N1+R7, Q5/N4) & N3 Regression Tests', () => {
  it('Q1: poison pill in the middle of outbox drains leading healthy items 1-by-1 without bouncing back to full batch', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v187-q1-mid-${crypto.randomUUID()}`);
    const realFetch = d1Fetch(db);
    const batchSizesSeen: number[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.length > 0) {
        batchSizesSeen.push(body.mutations.length);
      }
      if (body.mutations.some((m) => m.payload?.itemName === '毒丸中間')) {
        return new Response(JSON.stringify({ error: 'poison crash' }), { status: 500 });
      }
      return realFetch(input, init);
    };

    const engine = newEngine(localDb, fetchImpl, { maxPoisonRetries: 2 });
    await engine.init();

    await engine.addCashFlow(cfPayload('正常一'));
    await engine.addCashFlow(cfPayload('正常二'));
    await engine.addCashFlow(cfPayload('毒丸中間'));
    await engine.addCashFlow(cfPayload('正常三'));

    // 1st sync: batch of 4 fails -> read-only pull succeeds -> enters poisonSearchActive (batch size 1)
    await engine.syncNow();
    // 2nd sync: drains 正常一 (1), 正常二 (1), then 毒丸中間 fails -> probe 正常三 succeeds (retryCount=1)
    await engine.syncNow();
    // 3rd sync: 毒丸中間 fails again, nothing left to probe with -> stays queued (v1.8.9 / V1)
    await engine.syncNow();

    // After the initial 4-item batch failure, every batch until quarantine stayed at size 1 (no bounce back to 3)
    expect(batchSizesSeen[0]).toBe(4);
    expect(batchSizesSeen.slice(1)).not.toContain(3);
    expect(batchSizesSeen.slice(1)).not.toContain(2);

    // v1.8.9 (V1): only one probe write succeeded after the poison (retryCount 1 < maxPoisonRetries 2),
    // so it is not quarantined; it stays queued without blocking the healthy items.
    expect(engine.getRejections()).toHaveLength(0);
    expect((await localDb.getOutbox()).map((m) => m.payload?.itemName)).toEqual(['毒丸中間']);

    const rows = await db
      .prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL')
      .bind(UID)
      .all<{ item_name: string }>();
    expect((rows.results || []).map((r) => r.item_name).sort()).toEqual(['正常一', '正常三', '正常二']);

    engine.destroy();
    localDb.close();
  });

  it('Q4 / N1 + R7: batches never send two mutations for the same entity:recordId together', async () => {
    const db = createTestD1();
    const dbName = `v187-n1-r7-${crypto.randomUUID()}`;

    // Session 1: create asset, network fails after sentAt persisted
    const local1 = new LocalFinanceDB(dbName);
    const engine1 = newEngine(local1, async () => {
      throw new TypeError('offline');
    });
    await engine1.init();
    const created = await engine1.saveAsset(assetPayload('資產一', '初始'));
    await engine1.syncNow();
    engine1.destroy();
    local1.close();

    // Session 2: edit same asset while sentAt create is still in outbox, then sync
    const local2 = new LocalFinanceDB(dbName);
    const observedBatches: SyncMutation[][] = [];
    const engine2 = newEngine(
      local2,
      d1Fetch(db, (req) => {
        if (req.mutations.length > 0) observedBatches.push(req.mutations);
      })
    );
    await engine2.init();
    await engine2.saveAsset({ ...assetPayload('資產一', '更新後'), id: created.id });
    await engine2.syncNow();

    // Every HTTP batch had at most 1 mutation for asset:<id>
    expect(observedBatches.length).toBeGreaterThanOrEqual(2);
    for (const b of observedBatches) {
      const sameKey = b.filter((m) => m.entity === 'asset' && m.recordId === created.id);
      expect(sameKey.length).toBeLessThanOrEqual(1);
    }
    expect(engine2.getConflicts()).toHaveLength(0);
    expect(await local2.getOutbox()).toHaveLength(0);
    const row = await db
      .prepare('SELECT note FROM asset_items WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(UID, created.id)
      .first<{ note: string }>();
    expect(row?.note).toBe('更新後');

    engine2.destroy();
    local2.close();
  });

  it('Q5 / N4: legacy un-epoched mutations after replace (dataEpoch > 1) are blocked with epochMismatch, and fullPullPass still sends clientEpoch', async () => {
    const db = createTestD1();
    await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    await importFullSnapshot(db, UID, { cashflowLogs: [] }, 'replace'); // epoch -> 2

    // 1. Legacy client omitting clientEpoch while sending mutations must NOT write into epoch 2
    const legacyRes = await processSyncRequest(db, UID, {
      since: null,
      mutations: [
        {
          mutationId: 'legacy-stale',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-legacy-stale',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: cfPayload('legacy-old'),
        },
      ],
    });
    expect(legacyRes.epochMismatch).toBe(true);
    expect(legacyRes.ackedMutationIds).toHaveLength(0);
    const row = await db
      .prepare('SELECT id FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind(UID, 'cf-legacy-stale')
      .first();
    expect(row).toBeNull();

    // 2. Client calling syncNow(true) (forceFullPull) still transmits its known clientEpoch
    const localDb = new LocalFinanceDB(`v187-n4-epoch-${crypto.randomUUID()}`);
    const sentEpochs: Array<number | null | undefined> = [];
    const engine = newEngine(
      localDb,
      d1Fetch(db, (req) => sentEpochs.push(req.clientEpoch))
    );
    await engine.init();
    await engine.syncNow(); // learns dataEpoch = 2
    await engine.syncNow(true); // fullPullPass must still send clientEpoch: 2
    expect(sentEpochs[sentEpochs.length - 1]).toBe(2);

    engine.destroy();
    localDb.close();
  });

  it('N3: reapplyFrozenOutbox skips records deleted after freeze and records with live outbox edits, while still reapplying untouched records', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v187-n3-edge-${crypto.randomUUID()}`);
    const engine = newEngine(localDb, d1Fetch(db));
    await engine.init();

    const aKeep = await engine.saveAsset(assetPayload('A-資產', 'A-原始'));
    const aDel = await engine.saveAsset(assetPayload('B-資產', 'B-將刪除'));
    const aLive = await engine.saveAsset(assetPayload('C-資產', 'C-將有新離線編輯'));
    await engine.syncNow();

    // Offline edits to all 3 before replace import
    await engine.saveAsset({ ...assetPayload('A-資產', 'A-凍結舊改'), id: aKeep.id });
    await engine.saveAsset({ ...assetPayload('B-資產', 'B-凍結舊改'), id: aDel.id });
    await engine.saveAsset({ ...assetPayload('C-資產', 'C-凍結舊改'), id: aLive.id });

    // Replace import on another device preserving all 3 at v1 (epoch -> 2)
    const full = await processSyncRequest(db, UID, { since: null, mutations: [] });
    await importFullSnapshot(db, UID, { assetItems: full.delta.assetItems }, 'replace');

    // Sync -> freezes all 3 edits
    await engine.syncNow();
    expect(engine.getFrozenOutbox()).toHaveLength(3);

    // After freeze: delete B and sync it to server
    await engine.deleteAsset(aDel.id);
    await engine.syncNow();

    // After freeze: edit C offline (remains in live outbox, unsynced)
    await engine.saveAsset({ ...assetPayload('C-資產', 'C-凍結後新編輯'), id: aLive.id });

    // Reapply frozen outbox: A should be reapplied, B (deleted) and C (in live outbox) must be skipped!
    const res = await engine.reapplyFrozenOutbox();
    expect(res.appliedCount).toBe(1);
    expect(res.skippedCount).toBe(2);

    await engine.syncNow();

    const snap = engine.getSnapshot();
    expect(snap.assetItems.find((a) => a.id === aKeep.id)?.note).toBe('A-凍結舊改');
    expect(snap.assetItems.find((a) => a.id === aDel.id)).toBeUndefined();
    expect(snap.assetItems.find((a) => a.id === aLive.id)?.note).toBe('C-凍結後新編輯');

    engine.destroy();
    localDb.close();
  });
});
