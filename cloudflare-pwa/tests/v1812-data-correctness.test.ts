import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '../shared/types';
import { processSyncRequest } from '../worker/sync';
import { createApp } from '../worker/index';
import type { WorkerEnv } from '../worker/types';
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

const manualAsset = (note: string, quantity = 1000) => ({
  updateMode: '手動快照',
  majorType: '資產',
  subCategory: '其他資產',
  liquidity: '中流動',
  itemName: '測試資產',
  quantityOrAmount: quantity,
  currency: 'TWD',
  unitPrice: 1,
  note,
});

function newEngine(localDb: LocalFinanceDB, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new SyncEngine(localDb, {
    fetchImpl,
    isOnline: () => true,
    retryBaseDelayMs: 60_000,
    maxPoisonRetries: 2,
    requestLock: async (_name, fn) => fn(),
    ...extra,
  });
}

describe('v1.8.12 client sync isolation (M6, M7)', () => {
  it('M6: when an edit is quarantined, queued follow-up edits of the same record are held and never reach the server', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v1812-m6-${crypto.randomUUID()}`);
    let engineRef: SyncEngine | null = null;
    let assetId = '';
    let poisonMutationId: string | null = null;
    let armed = false;

    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      const target = armed ? body.mutations.find((m) => m.entity === 'asset') : undefined;
      if (target && !poisonMutationId) {
        poisonMutationId = target.mutationId;
        // While the poison edit E1 is in flight the user edits another field (E2) built on top of E1
        await engineRef!.saveAsset({ ...manualAsset('E2-note', 777), id: assetId });
      }
      if (poisonMutationId && body.mutations.some((m) => m.mutationId === poisonMutationId)) {
        return new Response(JSON.stringify({ error: 'poison crash' }), { status: 500 });
      }
      const res = await processSyncRequest(db, UID, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;

    const engine = newEngine(localDb, fetchImpl);
    engineRef = engine;
    await engine.init();
    const created = await engine.saveAsset(manualAsset('original', 1000));
    assetId = created.id;
    await engine.syncNow();

    armed = true;
    await engine.saveAsset({ ...manualAsset('original', 777), id: assetId }); // E1: quantity 777 (poison)
    for (let i = 0; i < 8; i++) await engine.syncNow();

    const server = await db
      .prepare('SELECT quantity_or_amount, note FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(UID, assetId)
      .first<{ quantity_or_amount: number; note: string }>();
    // The quarantined value (777) must never reach the server through the follow-up edit
    expect(Number(server?.quantity_or_amount)).toBe(1000);
    expect(server?.note).toBe('original');
    const statuses = engine.getRejections().map((r) => r.resolutionStatus).sort();
    expect(statuses).toEqual(['held_after_reject', 'quarantined']);
    const held = engine.getRejections().find((r) => r.resolutionStatus === 'held_after_reject');
    expect(held?.clientPayload?.note).toBe('E2-note');
    expect(await localDb.getOutbox()).toHaveLength(0);
    // Full re-pull restored the cloud value locally
    const local = engine.getSnapshot().assetItems.find((a) => a.id === assetId);
    expect(local?.quantityOrAmount).toBe(1000);
    expect(engine.getMeta().pendingFullResync).toBeFalsy();

    engine.destroy();
    localDb.close();
  });

  it('M7: a request-level 400 (read-only pull also fails) never quarantines anything', async () => {
    const localDb = new LocalFinanceDB(`v1812-m7-400-${crypto.randomUUID()}`);
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: 'bad request (WAF / version skew)' }), { status: 400 })) as typeof fetch;
    const engine = newEngine(localDb, fetchImpl);
    await engine.init();
    await engine.addCashFlow(cfPayload('正常一'));
    await engine.addCashFlow(cfPayload('正常二'));
    for (let i = 0; i < 8; i++) await engine.syncNow();
    expect(engine.getRejections()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(2);
    expect(engine.getSnapshot().cashflowLogs.map((c) => c.itemName).sort()).toEqual(['正常一', '正常二']);
    engine.destroy();
    localDb.close();
  });

  it('M7: a request-level 413 never quarantines anything', async () => {
    const localDb = new LocalFinanceDB(`v1812-m7-413-${crypto.randomUUID()}`);
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: 'too large' }), { status: 413 })) as typeof fetch;
    const engine = newEngine(localDb, fetchImpl);
    await engine.init();
    await engine.addCashFlow(cfPayload('單筆'));
    for (let i = 0; i < 8; i++) await engine.syncNow();
    expect(engine.getRejections()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(1);
    engine.destroy();
    localDb.close();
  });

  it('M7: a 400 is quarantined only when the read-only pull + write probe succeed', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v1812-m7-item-${crypto.randomUUID()}`);
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.some((m) => m.payload?.itemName === '壞資料')) {
        return new Response(JSON.stringify({ error: 'bad item' }), { status: 400 });
      }
      const res = await processSyncRequest(db, UID, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;
    const engine = newEngine(localDb, fetchImpl);
    await engine.init();
    await engine.addCashFlow(cfPayload('壞資料'));
    await engine.addCashFlow(cfPayload('正常'));
    for (let i = 0; i < 8; i++) await engine.syncNow();
    expect(engine.getRejections().map((r) => [r.clientPayload?.itemName, r.resolutionStatus])).toEqual([
      ['壞資料', 'quarantined'],
    ]);
    expect(await localDb.getOutbox()).toHaveLength(0);
    engine.destroy();
    localDb.close();
  });

  it('M7: a 400 against a server that does not confirm the write probe quarantines nothing', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`v1812-m7-noprobe-${crypto.randomUUID()}`);
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (body.mutations.length > 0) {
        return new Response(JSON.stringify({ error: 'bad item' }), { status: 400 });
      }
      const res = await processSyncRequest(db, UID, body);
      delete (res as { writeProbeOk?: boolean }).writeProbeOk; // older server: no write probe support
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;
    const engine = newEngine(localDb, fetchImpl);
    await engine.init();
    await engine.addCashFlow(cfPayload('A'));
    for (let i = 0; i < 8; i++) await engine.syncNow();
    expect(engine.getRejections()).toHaveLength(0);
    expect(await localDb.getOutbox()).toHaveLength(1);
    engine.destroy();
    localDb.close();
  });
});

/* ============================== M3 referential integrity ============================== */

let mutSeq = 0;
function mut(entity: string, recordId: string, payload: Record<string, unknown> | undefined, opts: { op?: 'upsert' | 'delete'; baseVersion?: number | null } = {}) {
  mutSeq += 1;
  return {
    mutationId: `m3-${mutSeq}-${crypto.randomUUID()}`,
    entity,
    op: opts.op || 'upsert',
    recordId,
    clientTimestamp: new Date().toISOString(),
    baseVersion: opts.baseVersion === undefined ? null : opts.baseVersion,
    ...(payload ? { payload } : {}),
  } as SyncRequest['mutations'][number];
}

async function syncOne(db: D1Database, m: SyncRequest['mutations'][number]) {
  return processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: [m] });
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

describe('v1.8.12 server referential integrity (M3)', () => {
  async function seed() {
    const db = createTestD1();
    // a live ledger, a soft-deleted ledger, a live account, a soft-deleted account
    expect((await syncOne(db, mut('ledger', 'lg-live', { name: '旅遊' }))).ackedMutationIds).toHaveLength(1);
    expect((await syncOne(db, mut('ledger', 'lg-dead', { name: '舊帳本' }))).ackedMutationIds).toHaveLength(1);
    expect((await syncOne(db, mut('ledger', 'lg-dead', undefined, { op: 'delete', baseVersion: 1 }))).ackedMutationIds).toHaveLength(1);
    expect((await syncOne(db, mut('asset', 'acc-live', savingsAcc('活存A')))).ackedMutationIds).toHaveLength(1);
    expect((await syncOne(db, mut('asset', 'acc-dead', savingsAcc('活存B')))).ackedMutationIds).toHaveLength(1);
    expect((await syncOne(db, mut('asset', 'acc-dead', undefined, { op: 'delete', baseVersion: 1 }))).ackedMutationIds).toHaveLength(1);
    return db;
  }

  const expectRejected = async (db: D1Database, m: SyncRequest['mutations'][number]) => {
    const res = await syncOne(db, m);
    expect(res.ackedMutationIds).toEqual([]);
    expect(res.rejected.map((r) => r.mutationId)).toEqual([m.mutationId]);
    return res;
  };
  const expectAcked = async (db: D1Database, m: SyncRequest['mutations'][number]) => {
    const res = await syncOne(db, m);
    expect(res.rejected).toEqual([]);
    expect(res.conflicts).toEqual([]);
    expect(res.ackedMutationIds).toEqual([m.mutationId]);
    return res;
  };

  it('rejects cashflow / recurring / asset rows pointing at an unknown or soft-deleted ledger; default and live ledgers are fine', async () => {
    const db = await seed();
    await expectRejected(db, mut('cashflow', 'cf-nope', { ...cfPayload('x'), ledgerId: 'NOPE' }));
    await expectRejected(db, mut('cashflow', 'cf-dead', { ...cfPayload('x'), ledgerId: 'lg-dead' }));
    await expectRejected(db, mut('recurring', 'rc-nope', { itemName: '房租', category: '居住', type: '固定支出', amount: 1, currency: 'TWD', cycle: '月繳', billingSpec: '1', status: '啟用', ledgerId: 'NOPE' }));
    await expectRejected(db, mut('asset', 'as-nope', { ...savingsAcc('x'), ledgerId: 'NOPE' }));
    await expectAcked(db, mut('cashflow', 'cf-default', { ...cfPayload('x'), ledgerId: 'default' }));
    await expectAcked(db, mut('cashflow', 'cf-live', { ...cfPayload('x'), ledgerId: 'lg-live' }));
    const rows = await db.prepare('SELECT id FROM cashflow_logs WHERE user_id = ? ORDER BY id').bind(UID).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual(['cf-default', 'cf-live']);
  });

  it('rejects linkedAccountId / accountId / assetId that do not exist or are soft-deleted', async () => {
    const db = await seed();
    await expectRejected(db, mut('cashflow', 'cf-l1', { ...cfPayload('x'), linkedAccountId: 'acc-none' }));
    await expectRejected(db, mut('cashflow', 'cf-l2', { ...cfPayload('x'), linkedAccountId: 'acc-dead' }));
    await expectRejected(db, mut('recurring', 'rc-l', { itemName: '房租', category: '居住', type: '固定支出', amount: 1, currency: 'TWD', cycle: '月繳', billingSpec: '1', status: '啟用', linkedAccountId: 'acc-dead' }));
    await expectRejected(db, mut('savings_adjustment', 'adj-1', { accountId: 'acc-none', date: '2026-11-26', amount: 10, currency: 'TWD', note: '' }));
    await expectRejected(db, mut('savings_adjustment', 'adj-2', { accountId: 'acc-dead', date: '2026-11-26', amount: 10, currency: 'TWD', note: '' }));
    await expectRejected(db, mut('stock_tx', 'tx-1', { assetId: 'acc-none', date: '2026-11-26', txType: 'buy', shares: 1, totalAmount: 10, fee: 0 }));
    await expectAcked(db, mut('cashflow', 'cf-ok', { ...cfPayload('x'), linkedAccountId: 'acc-live' }));
    await expectAcked(db, mut('savings_adjustment', 'adj-ok', { accountId: 'acc-live', date: '2026-11-26', amount: 10, currency: 'TWD', note: '' }));
  });

  it('does not reject an edit of a legacy row whose already-dangling references are unchanged', async () => {
    const db = await seed();
    await expectAcked(db, mut('cashflow', 'cf-legacy', { ...cfPayload('legacy'), linkedAccountId: 'acc-live' }));
    // Simulate legacy data written before v1.8.12: dangling ledger and a link to an account deleted afterwards
    await db.prepare("UPDATE cashflow_logs SET ledger_id = 'GONE', linked_account_id = 'acc-dead' WHERE id = 'cf-legacy'").run();
    await expectAcked(db, mut('cashflow', 'cf-legacy', { ...cfPayload('legacy'), note: '只改備註', ledgerId: 'GONE', linkedAccountId: 'acc-dead' }, { baseVersion: 1 }));
    // Changing the dangling reference to another dangling value is rejected
    await expectRejected(db, mut('cashflow', 'cf-legacy', { ...cfPayload('legacy'), ledgerId: 'NOPE2', linkedAccountId: 'acc-dead' }, { baseVersion: 2 }));
    // Moving it to a valid ledger and clearing the link is fine
    await expectAcked(db, mut('cashflow', 'cf-legacy', { ...cfPayload('legacy'), ledgerId: 'default', linkedAccountId: null }, { baseVersion: 2 }));
  });

  it('a reference deleted between the pre-read and the write is still rejected (guard is part of the write statement)', async () => {
    const db = await seed();
    const m = mut('cashflow', 'cf-race', { ...cfPayload('x'), ledgerId: 'lg-live' });
    // Soft-delete the ledger with a raw statement right before the write, emulating a concurrent request
    const realBatch = db.batch.bind(db);
    let first = true;
    (db as unknown as { batch: typeof db.batch }).batch = (async (stmts: D1PreparedStatement[]) => {
      if (first) {
        first = false;
        await db.prepare("UPDATE ledgers SET deleted_at = '2026-11-26T00:00:00.000Z' WHERE id = 'lg-live'").run();
      }
      return realBatch(stmts);
    }) as typeof db.batch;
    await expectRejected(db, m);
  });

  // v1.8.17 review finding 2 changed this from "rejects": rejecting made the user's own backup impossible to restore
  // when a record pointed at a ledger that never reached the server. The goal of M3 here — money must not silently
  // drop out of every total — is kept: the record is placed under a recreated ledger, excluded from net worth, so it
  // is visible and every total is the same as before the export.
  it('import keeps records pointing at an unknown ledger under a recovered ledger (excluded from net worth)', async () => {
    const db = createTestD1();
    const { importFullSnapshot } = await import('../worker/sync');
    const res = await importFullSnapshot(
      db,
      UID,
      { cashflowLogs: [{ ...cfPayload('x'), id: 'imp-1', ledgerId: 'NOPE' } as never] },
      'merge'
    );
    expect(res.recoveredLedgers).toBe(1);
    const recovered = await db
      .prepare("SELECT l.id, l.name, l.include_in_net_worth FROM cashflow_logs c JOIN ledgers l ON l.user_id = c.user_id AND l.id = c.ledger_id WHERE c.id = 'imp-1'")
      .first<{ id: string; name: string; include_in_net_worth: number }>();
    expect(recovered?.id).toBe('NOPE');
    expect(recovered?.name).toMatch(/復原的帳本/);
    expect(recovered?.include_in_net_worth).toBe(0);
    // A ledger contained in the same import is fine
    await importFullSnapshot(
      db,
      UID,
      {
        ledgers: [{ id: 'lg-imp', name: '匯入帳本', includeInNetWorth: true } as never],
        cashflowLogs: [{ ...cfPayload('x'), id: 'imp-2', ledgerId: 'lg-imp' } as never],
      },
      'merge'
    );
    const row = await db.prepare("SELECT ledger_id FROM cashflow_logs WHERE id = 'imp-2'").first<{ ledger_id: string }>();
    expect(row?.ledger_id).toBe('lg-imp');
  });
});

/* ============================== M4 transfer atomicity ============================== */

const adjPayload = (accountId: string, amount: number, transferGroupId: string | null, note = '') => ({
  accountId,
  date: '2026-11-26',
  amount,
  currency: 'TWD',
  note,
  transferGroupId,
});

function grouped<T extends SyncRequest['mutations'][number]>(groupId: string, ...ms: T[]): T[] {
  return ms.map((m) => ({ ...m, atomicGroupId: groupId }));
}

async function seedAccounts(db: D1Database) {
  for (const id of ['acc-a', 'acc-b']) {
    const res = await syncOne(db, mut('asset', id, savingsAcc(id)));
    expect(res.ackedMutationIds).toHaveLength(1);
  }
  const fixed = await syncOne(db, mut('asset', 'acc-fixed', { ...savingsAcc('定存'), subCategory: '定存', isLinkedSavings: false }));
  expect(fixed.ackedMutationIds).toHaveLength(1);
}

async function adjRows(db: D1Database) {
  const rows = await db
    .prepare('SELECT id, amount, deleted_at FROM savings_adjustments WHERE user_id = ? ORDER BY id')
    .bind(UID)
    .all<{ id: string; amount: number; deleted_at: string | null }>();
  return rows.results;
}

describe('v1.8.12 server transfer atomicity (M4)', () => {
  it('a transfer group whose second leg is invalid writes neither leg', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    const ms = grouped(
      'tg-1',
      mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-1')),
      mut('savings_adjustment', 'adj-in', adjPayload('acc-missing', 100, 'tg-1'))
    );
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: ms });
    expect(res.ackedMutationIds).toEqual([]);
    expect(res.rejected.map((r) => r.mutationId).sort()).toEqual(ms.map((m) => m.mutationId).sort());
    expect(await adjRows(db)).toEqual([]);
    const idem = await db.prepare('SELECT COUNT(*) AS n FROM sync_idempotency WHERE user_id = ?').bind(UID).first<{ n: number }>();
    expect(Number(idem?.n)).toBe(3); // only the 3 seed mutations
  });

  it('a version conflict on the fixed-deposit leg rolls back the savings leg written in the same group', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    const ms = grouped(
      'tg-2',
      mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-2')),
      mut('asset', 'acc-fixed', { ...savingsAcc('定存'), subCategory: '定存', isLinkedSavings: false, quantityOrAmount: 1100 }, { baseVersion: 7 })
    );
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: ms });
    expect(res.ackedMutationIds).toEqual([]);
    expect(res.conflicts).toEqual([]);
    expect(res.rejected.map((r) => r.mutationId).sort()).toEqual(ms.map((m) => m.mutationId).sort());
    expect(await adjRows(db)).toEqual([]);
    const fixed = await db.prepare("SELECT quantity_or_amount FROM asset_items WHERE id = 'acc-fixed'").first<{ quantity_or_amount: number }>();
    expect(Number(fixed?.quantity_or_amount)).toBe(1000);
  });

  it('a group whose write loses a race at commit time (0 rows changed) is rolled back as a whole', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    const ms = grouped(
      'tg-race',
      mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-race')),
      mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 100, 'tg-race'))
    );
    // Another device creates a row with the second leg's id right before the group commits
    const realBatch = db.batch.bind(db);
    let batchCalls = 0;
    (db as unknown as { batch: typeof db.batch }).batch = (async (stmts: D1PreparedStatement[]) => {
      batchCalls += 1;
      // batch #1 is the per-request baseline, #2 the prefetch, #3 the group commit (v1.8.13 H5)
      if (batchCalls === 3) {
        await db
          .prepare(
            "INSERT INTO savings_adjustments (user_id, id, account_id, date, amount, twd_amount, note, created_at, updated_at, version, change_seq) VALUES ('owner', 'adj-in', 'acc-b', '2026-11-26', 5, 5, 'other', 'x', 'x', 1, 99)"
          )
          .run();
      }
      return realBatch(stmts);
    }) as typeof db.batch;
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: ms });
    expect(res.ackedMutationIds).toEqual([]);
    expect((await adjRows(db)).map((r) => [r.id, Number(r.amount)])).toEqual([['adj-in', 5]]);
  });

  it('a successful group is written together and a retry of the same group acks both without duplicates', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    const ms = grouped(
      'tg-3',
      mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-3')),
      mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 100, 'tg-3'))
    );
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: ms });
    expect(res.rejected).toEqual([]);
    expect(res.ackedMutationIds.sort()).toEqual(ms.map((m) => m.mutationId).sort());
    const retry = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: ms });
    expect(retry.ackedMutationIds.sort()).toEqual(ms.map((m) => m.mutationId).sort());
    expect((await adjRows(db)).map((r) => [r.id, Number(r.amount)])).toEqual([
      ['adj-in', 100],
      ['adj-out', -100],
    ]);
  });

  it('legacy clients: two transfer legs in the same request (no atomicGroupId) are grouped by transferGroupId', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    const ms = [
      mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-legacy')),
      // v1.8.17: a legacy request may reference a record that never existed (still in its outbox), so the
      // invalid leg points at a soft-deleted account instead
      mut('savings_adjustment', 'adj-in', adjPayload('acc-gone', 100, 'tg-legacy')),
    ];
    expect((await syncOne(db, mut('asset', 'acc-gone', savingsAcc('acc-gone')))).ackedMutationIds).toHaveLength(1);
    expect((await syncOne(db, mut('asset', 'acc-gone', undefined, { op: 'delete', baseVersion: 1 }))).ackedMutationIds).toHaveLength(1);
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: ms } /* legacy client: no refsOrdered */);
    expect(res.ackedMutationIds).toEqual([]);
    expect(await adjRows(db)).toEqual([]);
  });

  it('a paired delete is all-or-nothing', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    const create = grouped(
      'tg-4',
      mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-4')),
      mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 100, 'tg-4'))
    );
    await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: create });
    const del = grouped(
      'tg-4',
      mut('savings_adjustment', 'adj-out', undefined, { op: 'delete', baseVersion: 1 }),
      mut('savings_adjustment', 'adj-in', undefined, { op: 'delete', baseVersion: 9 }) // stale version
    );
    const res = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, refsOrdered: true, mutations: del });
    expect(res.ackedMutationIds).toEqual([]);
    expect((await adjRows(db)).every((r) => r.deleted_at === null)).toBe(true);
  });

  it('editing the amount of only one leg of a transfer is rejected; a note-only edit or a grouped edit of both legs is accepted', async () => {
    const db = createTestD1();
    await seedAccounts(db);
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: grouped(
        'tg-5',
        mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -100, 'tg-5')),
        mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 100, 'tg-5'))
      ),
    });
    await expectRejectedSingle(db, mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 999, 'tg-5'), { baseVersion: 1 }));
    const noteOnly = await syncOne(db, mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 100, 'tg-5', '備註'), { baseVersion: 1 }));
    expect(noteOnly.ackedMutationIds).toHaveLength(1);
    const both = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: grouped(
        'tg-5',
        mut('savings_adjustment', 'adj-out', adjPayload('acc-a', -200, 'tg-5'), { baseVersion: 1 }),
        mut('savings_adjustment', 'adj-in', adjPayload('acc-b', 200, 'tg-5', '備註'), { baseVersion: 2 })
      ),
    });
    expect(both.rejected).toEqual([]);
    expect(both.ackedMutationIds).toHaveLength(2);
  });
});

async function expectRejectedSingle(db: D1Database, m: SyncRequest['mutations'][number]) {
  const res = await syncOne(db, m);
  expect(res.ackedMutationIds).toEqual([]);
  expect(res.rejected.map((r) => r.mutationId)).toEqual([m.mutationId]);
}

describe('v1.8.12 client transfer atomicity (M4)', () => {
  async function setupEngine(fetchImpl: typeof fetch, maxBatchSize = 50) {
    const localDb = new LocalFinanceDB(`v1812-m4-${crypto.randomUUID()}`);
    const engine = newEngine(localDb, fetchImpl, { maxBatchSize });
    await engine.init();
    return { engine, localDb };
  }
  const linked = (name: string, amount: number) => ({
    itemName: name,
    majorType: '資產',
    updateMode: '手動快照',
    subCategory: '活存',
    liquidity: '高流動',
    quantityOrAmount: amount,
    currency: 'TWD',
    unitPrice: 1,
    isLinkedSavings: true,
    balanceAnchorDate: '2026-11-01',
    balanceAnchorAt: '2026-11-01T00:00:00.000Z',
  });

  it('all mutations of a transfer share an atomicGroupId and are never split across batches (even with batch size 1)', async () => {
    const db = createTestD1();
    const batches: string[][] = [];
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      batches.push(body.mutations.map((m) => `${m.entity}:${m.atomicGroupId ?? '-'}`));
      const res = await processSyncRequest(db, UID, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;
    const { engine, localDb } = await setupEngine(fetchImpl, 1);
    const a = await engine.saveAsset(linked('A', 1000));
    const b = await engine.saveAsset(linked('B', 1000));
    for (let i = 0; i < 4; i++) await engine.syncNow();
    batches.length = 0;
    const t = await engine.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, date: '2026-11-26', amount: 100, fee: 5, note: '' });
    for (let i = 0; i < 4; i++) await engine.syncNow();
    const transferBatch = batches.find((bt) => bt.length > 0)!;
    expect(transferBatch).toEqual([
      `savings_adjustment:${t.transferGroupId}`,
      `savings_adjustment:${t.transferGroupId}`,
      `cashflow:${t.transferGroupId}`,
    ]);
    expect(await localDb.getOutbox()).toHaveLength(0);
    engine.destroy();
    localDb.close();
  });

  it('a transfer that keeps failing is quarantined as a unit and the items behind it still drain', async () => {
    const db = createTestD1();
    let poisonGroup: string | null = null;
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (poisonGroup && body.mutations.some((m) => m.atomicGroupId === poisonGroup)) {
        return new Response(JSON.stringify({ error: 'crash' }), { status: 500 });
      }
      const res = await processSyncRequest(db, UID, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;
    const { engine, localDb } = await setupEngine(fetchImpl);
    const a = await engine.saveAsset(linked('A', 1000));
    const b = await engine.saveAsset(linked('B', 1000));
    await engine.syncNow();
    const t = await engine.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, date: '2026-11-26', amount: 100, fee: 0, note: '' });
    poisonGroup = t.transferGroupId;
    await engine.addCashFlow(cfPayload('後面的正常資料'));
    for (let i = 0; i < 12; i++) await engine.syncNow();
    expect(engine.getRejections().map((r) => r.resolutionStatus)).toEqual(['quarantined', 'quarantined']);
    expect(await localDb.getOutbox()).toHaveLength(0);
    expect(await adjRows(db)).toEqual([]);
    const cf = await db.prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ?').bind(UID).all<{ item_name: string }>();
    expect(cf.results.map((r) => r.item_name)).toEqual(['後面的正常資料']);
    // Neither leg remains locally
    expect(engine.getSnapshot().savingsAdjustments).toEqual([]);
    engine.destroy();
    localDb.close();
  });

  it('a paired delete is sent as one group', async () => {
    const db = createTestD1();
    const sent: SyncRequest['mutations'][] = [];
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      sent.push(body.mutations);
      const res = await processSyncRequest(db, UID, body);
      return new Response(JSON.stringify(res), { status: 200 });
    }) as typeof fetch;
    const { engine, localDb } = await setupEngine(fetchImpl);
    const a = await engine.saveAsset(linked('A', 1000));
    const b = await engine.saveAsset(linked('B', 1000));
    const t = await engine.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, date: '2026-11-26', amount: 100, fee: 0, note: '' });
    await engine.syncNow();
    sent.length = 0;
    await engine.deleteSavingsAdjustment(t.fromAdjustment!.id, true);
    await engine.syncNow();
    const dels = sent.flat().filter((m) => m.op === 'delete');
    expect(dels).toHaveLength(2);
    expect(new Set(dels.map((m) => m.atomicGroupId))).toEqual(new Set([t.transferGroupId]));
    expect((await adjRows(db)).every((r) => r.deleted_at !== null)).toBe(true);
    engine.destroy();
    localDb.close();
  });
});

describe('v1.8.12 outbox coalescing keeps transfers atomic (M4)', () => {
  it('two offline transfers touching the same fixed-deposit account keep separate groups; nothing is coalesced across groups', async () => {
    const localDb = new LocalFinanceDB(`v1812-m4-coalesce-${crypto.randomUUID()}`);
    const offline = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const engine = new SyncEngine(localDb, { fetchImpl: offline, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    await engine.init();
    const fixed = await engine.saveAsset({ ...savingsAcc('定存'), subCategory: '定存', isLinkedSavings: false, quantityOrAmount: 10000 });
    const a = await engine.saveAsset({ ...savingsAcc('A'), balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z' });
    const b = await engine.saveAsset({ ...savingsAcc('B'), balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z' });
    const t1 = await engine.transferBetweenAccounts({ fromAccountId: fixed.id, toAccountId: a.id, date: '2026-11-26', amount: 100, fee: 0, note: '' });
    const t2 = await engine.transferBetweenAccounts({ fromAccountId: fixed.id, toAccountId: b.id, date: '2026-11-26', amount: 200, fee: 0, note: '' });
    const outbox = await localDb.getOutbox();
    const fixedMuts = outbox.filter((m) => m.recordId === fixed.id);
    // the offline create and each transfer's debit stay separate mutations (review R-C)
    expect(fixedMuts.map((m) => m.atomicGroupId ?? null)).toEqual([null, t1.transferGroupId, t2.transferGroupId]);
    for (const t of [t1, t2]) {
      expect(outbox.filter((m) => m.atomicGroupId === t.transferGroupId).map((m) => m.entity).sort()).toEqual(['asset', 'savings_adjustment']);
    }
    engine.destroy();
    localDb.close();
  });
});

/* ============================== M5 recurring dedup ============================== */

const recurringPayload = (name: string, amount: number, extra: Record<string, unknown> = {}) => ({
  itemName: name,
  category: '居住',
  type: '固定支出',
  amount,
  currency: 'TWD',
  cycle: '月繳',
  billingSpec: '',
  status: '啟用',
  note: '',
  ...extra,
});

describe('v1.8.12 recurring auto-posting (M5)', () => {
  async function autoRows(db: D1Database, ym = '2026-12') {
    const rows = await db
      .prepare("SELECT item_name, amount, recurring_dedup_key FROM cashflow_logs WHERE user_id = ? AND year_month = ? AND source = '自動入帳' AND deleted_at IS NULL ORDER BY amount")
      .bind(UID, ym)
      .all<{ item_name: string; amount: number; recurring_dedup_key: string }>();
    return rows.results;
  }

  it('two recurring items with the same name and type are both posted', async () => {
    const { runMonthlyRecurringD1 } = await import('../worker/automation');
    const db = createTestD1();
    await syncOne(db, mut('recurring', 'rc-1', recurringPayload('保險', 1000)));
    await syncOne(db, mut('recurring', 'rc-2', recurringPayload('保險', 2000)));
    const res = await runMonthlyRecurringD1(db, UID, 2026, 12);
    expect(res.insertedCount).toBe(2);
    expect((await autoRows(db)).map((r) => Number(r.amount))).toEqual([1000, 2000]);
    // Running again posts nothing new
    const again = await runMonthlyRecurringD1(db, UID, 2026, 12);
    expect(again.insertedCount).toBe(0);
    expect(await autoRows(db)).toHaveLength(2);
  });

  it('concurrent runs (cron + manual button) neither crash nor duplicate', async () => {
    const { runMonthlyRecurringD1 } = await import('../worker/automation');
    const db = createTestD1();
    await syncOne(db, mut('recurring', 'rc-a', recurringPayload('房租', 10000)));
    await syncOne(db, mut('recurring', 'rc-b', recurringPayload('網路', 500)));
    await syncOne(db, mut('recurring', 'rc-c', recurringPayload('電信', 600)));
    const [r1, r2] = await Promise.all([
      runMonthlyRecurringD1(db, UID, 2026, 12),
      runMonthlyRecurringD1(db, UID, 2026, 12),
    ]);
    expect(r1.insertedCount + r2.insertedCount).toBe(3);
    expect((await autoRows(db)).map((r) => r.item_name).sort()).toEqual(['房租', '網路', '電信']);
  });

  it('a month already posted with the legacy name-based key is not posted again', async () => {
    const { runMonthlyRecurringD1 } = await import('../worker/automation');
    const { buildMonthlyDedupKey } = await import('../shared/recurring');
    const db = createTestD1();
    await syncOne(db, mut('recurring', 'rc-old', recurringPayload('房租', 10000)));
    // Row written by v1.8.11 for 2026-12 with the legacy key
    await db
      .prepare(
        `INSERT INTO cashflow_logs (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, ledger_id, created_at, updated_at, version, change_seq)
         VALUES ('owner', 'legacy-row', '2026-12-01', '2026-12', '固定支出', '居住', '房租', 10000, 'TWD', 1, 10000, '自動入帳', '', ?, 'default', 'x', 'x', 1, 1)`
      )
      .bind(buildMonthlyDedupKey('2026-12', '固定支出', '房租', 'default'))
      .run();
    const res = await runMonthlyRecurringD1(db, UID, 2026, 12);
    expect(res.insertedCount).toBe(0);
    expect(await autoRows(db)).toHaveLength(1);
  });

  it('legacy key consumed by one of two same-name items: only the other one is posted', async () => {
    const { runMonthlyRecurringD1 } = await import('../worker/automation');
    const { buildMonthlyDedupKey } = await import('../shared/recurring');
    const db = createTestD1();
    await syncOne(db, mut('recurring', 'rc-x', recurringPayload('保險', 1000)));
    await syncOne(db, mut('recurring', 'rc-y', recurringPayload('保險', 2000)));
    await db
      .prepare(
        `INSERT INTO cashflow_logs (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, ledger_id, created_at, updated_at, version, change_seq)
         VALUES ('owner', 'legacy-row', '2026-12-01', '2026-12', '固定支出', '居住', '保險', 2000, 'TWD', 1, 2000, '自動入帳', '', ?, 'default', 'x', 'x', 1, 1)`
      )
      .bind(buildMonthlyDedupKey('2026-12', '固定支出', '保險', 'default'))
      .run();
    const res = await runMonthlyRecurringD1(db, UID, 2026, 12);
    expect(res.insertedCount).toBe(1);
    // The legacy row matched the 2000 item (same amount), so the 1000 item is the one posted now
    expect((await autoRows(db)).map((r) => Number(r.amount))).toEqual([1000, 2000]);
  });
});

/* ============================== M8 USD savings ============================== */

describe('v1.8.12 non-TWD savings balance (M8)', () => {
  const usdAccount = {
    id: 'usd-acc',
    updateMode: '手動快照',
    majorType: '資產',
    subCategory: '活存',
    liquidity: '高流動',
    itemName: 'USD 活存',
    ticker: '',
    quantityOrAmount: 1000,
    currency: 'USD',
    unitPrice: 1,
    note: '',
    isLinkedSavings: true,
    balanceAnchorDate: '2026-11-01',
    balanceAnchorAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const usdExpense = {
    id: 'cf-usd',
    date: '2026-11-10',
    yearMonth: '2026-11',
    type: '日常花費',
    category: '其他',
    itemName: '美元支出',
    amount: 100,
    currency: 'USD',
    fxRate: 32,
    twdAmount: 3200, // recorded when the rate was 32
    source: '手機記帳',
    note: '',
    linkedAccountId: 'usd-acc',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  };

  it('sums a USD account in USD and converts once at the current rate', async () => {
    const { computeSavingsAccountSummary, computeAllSavingsSummary } = await import('../shared/calculations');
    const s30 = computeSavingsAccountSummary(usdAccount as never, [usdExpense as never], [], 30);
    expect(s30.currentBalanceTwd).toBe(27000); // (1000 - 100) USD × 30
    expect(s30.currentBalanceNative).toBe(900);
    const s32 = computeSavingsAccountSummary(usdAccount as never, [usdExpense as never], [], 32);
    expect(s32.currentBalanceTwd).toBe(28800);
    expect(computeAllSavingsSummary([usdAccount as never], [usdExpense as never], [], 30).totalSavingsTwd).toBe(27000);
  });

  it('a TWD cashflow linked to a USD account is converted to USD at the current rate', async () => {
    const { computeSavingsAccountSummary } = await import('../shared/calculations');
    const twdExpense = { ...usdExpense, id: 'cf-twd', amount: 3000, currency: 'TWD', fxRate: 1, twdAmount: 3000 };
    // No historical USD rate on a TWD entry: it is converted at the view rate (3000 / 30 = 100 USD)
    const s = computeSavingsAccountSummary(usdAccount as never, [twdExpense as never], [], 30);
    expect(s.currentBalanceNative).toBe(900);
    expect(s.currentBalanceTwd).toBe(27000);
  });

  it('TWD accounts are unchanged', async () => {
    const { computeSavingsAccountSummary } = await import('../shared/calculations');
    const twdAcc = { ...usdAccount, currency: 'TWD', quantityOrAmount: 10000 };
    const twdLog = { ...usdExpense, amount: 500, currency: 'TWD', fxRate: 1, twdAmount: 500 };
    const s = computeSavingsAccountSummary(twdAcc as never, [twdLog as never], [], 30);
    expect(s.currentBalanceTwd).toBe(9500);
    expect(s.currentBalanceNative).toBe(9500);
  });
});

/* ============================== M14 manual posting API ============================== */

describe('v1.8.12 manual recurring API validation (M14)', () => {
  async function adminSession() {
    const app = createApp();
    const env = { DB: createTestD1(), SETUP_SECRET: 'secret-123' } as WorkerEnv;
    const res = await app.request(
      '/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' },
        body: JSON.stringify({ setupSecret: 'secret-123', username: 'admin', displayName: '管理員', password: 'AdminPassword123!' }),
      },
      env
    );
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const post = (body: unknown) =>
      app.request(
        '/api/automation/recurring',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie, 'cf-connecting-ip': '10.0.0.1' },
          body: JSON.stringify(body),
        },
        env
      );
    return { post, env };
  }

  it('rejects invalid year / month with 400 and writes nothing', async () => {
    const { post, env } = await adminSession();
    for (const body of [
      { year: 2026, month: 13 },
      { year: 2026, month: 0 },
      { year: 2026, month: -1 },
      { year: 2026, month: 1.5 },
      { year: 2026.5, month: 1 },
      { year: 1899, month: 1 },
      { year: 3000, month: 1 },
      { year: '2026', month: '12' },
      { year: 2026 },
      { month: 5 },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM cashflow_logs WHERE year_month LIKE '%-13'").first<{ n: number }>();
    expect(Number(rows?.n)).toBe(0);
  });

  it('accepts a valid year / month, or neither (current month)', async () => {
    const { post } = await adminSession();
    expect((await post({ year: 2026, month: 12 })).status).toBe(200);
    expect((await post({})).status).toBe(200);
  });
});

/* ============================== M9 cross-tab lock settings ============================== */

describe('v1.8.12 lock settings changed in another tab (M9)', () => {
  const noFetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
  const pk = (id: string) => ({ credentialId: id, publicKey: 'pk', algorithm: -7, deviceName: 'd' }) as never;

  it('login / startup refresh of passkeys never writes a stale biometric flag back', async () => {
    const dbName = `v1812-m9-${crypto.randomUUID()}`;
    const tabA = new SyncEngine(new LocalFinanceDB(dbName), { fetchImpl: noFetch, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    const tabB = new SyncEngine(new LocalFinanceDB(dbName), { fetchImpl: noFetch, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    await tabA.init();
    await tabB.init();
    await tabA.updateLocalBiometricCache(false, [pk('a')]);
    await tabB.reloadFromIndexedDb();
    // Tab B turns the Face ID lock on; tab A has not reloaded yet
    await tabB.updateLocalBiometricCache(true);
    // Tab A's login flow refreshes the passkey list from the server
    await tabA.updateLocalPasskeysCache([pk('a'), pk('b')]);
    const fresh = new LocalFinanceDB(dbName);
    await fresh.open();
    const meta = await fresh.getMeta();
    expect(meta.biometricLockEnabled).toBe(true);
    expect((meta.passkeys || []).length).toBe(2);
    // And tab A's in-memory meta now reflects the stored lock settings, not its stale copy
    expect(tabA.getMeta().biometricLockEnabled).toBe(true);
    tabA.destroy();
    tabB.destroy();
    fresh.close();
  });

  it('applyAuthMetaToState copies PIN / biometric / passkeys from the engine meta into the UI state', async () => {
    const { applyAuthMetaToState } = await import('../web/src/ui/state');
    const state = { pinEnabled: false, pinSalt: null, pinHash: null, biometricLockEnabled: false, passkeys: [], passkeyCount: 0 } as never as Parameters<typeof applyAuthMetaToState>[0];
    applyAuthMetaToState(state, { pinEnabled: true, pinSalt: 's', pinHash: 'h', biometricLockEnabled: true, passkeys: [pk('x')] } as never);
    expect([state.pinEnabled, state.pinSalt, state.pinHash, state.biometricLockEnabled, state.passkeyCount]).toEqual([true, 's', 'h', true, 1]);
  });

  it('the UI refreshes lock settings from the engine on every reload and does not write the stale biometric flag on login', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
    const sec = readFileSync(new URL('../web/src/ui/securityUi.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/onSnapshotChange:[\s\S]{0,200}applyAuthMetaToState/);
    for (const src of [main, sec]) {
      expect(src).not.toMatch(/updateLocalBiometricCache\((ctx\.)?state\.biometricLockEnabled/);
    }
  });
});
