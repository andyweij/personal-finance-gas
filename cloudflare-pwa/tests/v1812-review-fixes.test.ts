import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '../shared/types';
import { processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const linked = (name: string, amount = 1000) => ({
  itemName: name, majorType: '資產', updateMode: '手動快照', subCategory: '活存', liquidity: '高流動',
  quantityOrAmount: amount, currency: 'TWD', unitPrice: 1, isLinkedSavings: true,
  balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z',
});
const fixedAcc = (name: string) => ({ ...linked(name, 10000), subCategory: '定存', isLinkedSavings: false });

function mkEngine(fetchImpl: typeof fetch, online: { v: boolean }, extra: Record<string, unknown> = {}) {
  const localDb = new LocalFinanceDB(`rv2-${crypto.randomUUID()}`);
  const engine = new SyncEngine(localDb, {
    fetchImpl, isOnline: () => online.v, retryBaseDelayMs: 60_000, maxPoisonRetries: 2,
    requestLock: async (_n, fn) => fn(), ...extra,
  });
  return { engine, localDb };
}

describe('v1.8.12 review fixes (client)', () => {
  it('R-A: offline new account + linked cashflow + rename account: the cashflow is accepted (dependency order)', async () => {
    const db = createTestD1();
    const online = { v: false };
    const fetchImpl: typeof fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      return new Response(JSON.stringify(await processSyncRequest(db, UID, body)), { status: 200 });
    }) as typeof fetch;
    const { engine, localDb } = mkEngine(fetchImpl, online);
    await engine.init();
    const q = await engine.saveAsset(linked('Q'));
    await sleep(3);
    await engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '午餐', amount: 100, currency: 'TWD', linkedAccountId: q.id } as never);
    await sleep(3);
    await engine.saveAsset({ ...linked('Q-renamed'), id: q.id });
    online.v = true;
    for (let i = 0; i < 4; i++) await engine.syncNow();
    const rej = engine.getRejections();
    const cf = await db.prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ?').bind(UID).all();
    expect(cf.results).toHaveLength(1);
    expect(engine.getRejections()).toEqual([]);
    engine.destroy(); localDb.close();
  });

  it('R-B: an unrelated poison mutation interleaved in a transfer unit is quarantined alone; the transfer is applied', async () => {
    const db = createTestD1();
    const online = { v: true };
    let poisonName = '';
    const fetchImpl: typeof fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (poisonName && body.mutations.some((m) => (m.payload as any)?.itemName === poisonName)) {
        return new Response(JSON.stringify({ error: 'bad' }), { status: 400 });
      }
      return new Response(JSON.stringify(await processSyncRequest(db, UID, body)), { status: 200 });
    }) as typeof fetch;
    const { engine, localDb } = mkEngine(fetchImpl, online);
    await engine.init();
    const p = await engine.saveAsset(fixedAcc('P'));
    const q = await engine.saveAsset(linked('Q'));
    await engine.syncNow();
    online.v = false;
    await engine.transferBetweenAccounts({ fromAccountId: p.id, toAccountId: q.id, date: '2026-11-26', amount: 100, fee: 0, note: '' });
    await sleep(3);
    poisonName = 'POISON';
    await engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: 'POISON', amount: 1, currency: 'TWD' } as never);
    await sleep(3);
    const pNow = engine.getSnapshot().assetItems.find((a) => a.id === p.id)!;
    await engine.saveAsset({ ...pNow, note: 'renamed note' } as never);
    online.v = true;
    for (let i = 0; i < 12; i++) await engine.syncNow();
    const adj = await db.prepare('SELECT id FROM savings_adjustments WHERE user_id = ?').bind(UID).all();
    expect(adj.results).toHaveLength(1); // the innocent transfer is applied
    expect(engine.getRejections().map((r) => [r.entity, r.resolutionStatus])).toEqual([['cashflow', 'quarantined']]);
    engine.destroy(); localDb.close();
  });

  it('R-C: an offline-created fixed account is not rolled back when a transfer from it is rejected', async () => {
    const db = createTestD1();
    const online = { v: true };
    const fetchImpl: typeof fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      return new Response(JSON.stringify(await processSyncRequest(db, UID, body)), { status: 200 });
    }) as typeof fetch;
    const { engine, localDb } = mkEngine(fetchImpl, online);
    await engine.init();
    const q = await engine.saveAsset(linked('Q'));
    await engine.syncNow();
    // another device deletes Q
    await processSyncRequest(db, UID, { mutations: [{ mutationId: crypto.randomUUID(), entity: 'asset', op: 'delete', recordId: q.id, clientTimestamp: new Date().toISOString(), baseVersion: 1 }] } as never);
    online.v = false;
    const p = await engine.saveAsset(fixedAcc('P-new'));
    await engine.transferBetweenAccounts({ fromAccountId: p.id, toAccountId: q.id, date: '2026-11-26', amount: 100, fee: 0, note: '' });
    online.v = true;
    for (let i = 0; i < 4; i++) await engine.syncNow();
    const assets = await db.prepare('SELECT item_name FROM asset_items WHERE user_id = ? AND deleted_at IS NULL').bind(UID).all();
    expect(assets.results.map((r: any) => r.item_name)).toContain('P-new');
    engine.destroy(); localDb.close();
  });
});

describe('v1.8.12 review fixes (R-D)', () => {
  it('R-D: when transfer 1 is rejected, transfer 2 (built on it) is held as a whole, never half-sent', async () => {
    const db = createTestD1();
    let failNext = false;
    const sent: string[][] = [];
    const fetchImpl: typeof fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      if (failNext && body.mutations.length > 0) {
        failNext = false;
        return new Response('{}', { status: 503 });
      }
      sent.push(body.mutations.map((m) => `${m.entity}:${m.atomicGroupId?.slice(0, 4) ?? '-'}`));
      return new Response(JSON.stringify(await processSyncRequest(db, UID, body)), { status: 200 });
    }) as typeof fetch;
    const localDb = new LocalFinanceDB(`rv2b-${crypto.randomUUID()}`);
    const engine = new SyncEngine(localDb, { fetchImpl, isOnline: () => true, retryBaseDelayMs: 60_000, maxPoisonRetries: 5, requestLock: async (_n, fn) => fn() });
    await engine.init();
    const p = await engine.saveAsset(fixedAcc('P'));
    const q = await engine.saveAsset(linked('Q'));
    const r = await engine.saveAsset(linked('R'));
    await engine.syncNow();
    // another device edits P → server version 2
    const pRow = engine.getSnapshot().assetItems.find((a) => a.id === p.id)!;
    const other = await processSyncRequest(db, UID, { mutations: [{ mutationId: crypto.randomUUID(), entity: 'asset', op: 'upsert', recordId: p.id, clientTimestamp: new Date().toISOString(), baseVersion: pRow.version ?? 1, payload: { ...pRow, note: 'other device' } }] } as never);
    expect(other.ackedMutationIds).toHaveLength(1);
    failNext = true;
    await engine.transferBetweenAccounts({ fromAccountId: p.id, toAccountId: q.id, date: '2026-11-26', amount: 100, fee: 0, note: '' });
    // the commitAndMaybeSync may already have tried; make sure the sentAt is persisted by a failed attempt
    if (failNext) await engine.syncNow();
    await sleep(3);
    await engine.transferBetweenAccounts({ fromAccountId: p.id, toAccountId: r.id, date: '2026-11-26', amount: 200, fee: 0, note: '' });
    for (let i = 0; i < 6; i++) await engine.syncNow();
    const adj = await db.prepare('SELECT account_id, amount FROM savings_adjustments WHERE user_id = ? AND deleted_at IS NULL').bind(UID).all();
    void sent;
    const pServer = await db.prepare('SELECT quantity_or_amount, note FROM asset_items WHERE user_id = ? AND id = ?').bind(UID, p.id).first();
    // atomicity: R must not be credited unless P was debited by transfer 2
    expect(adj.results.length === 0 || Number((pServer as any).quantity_or_amount) < 10000).toBe(true);
    engine.destroy(); localDb.close();
  });
});

const mut = (entity: string, recordId: string, payload?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    mutationId: crypto.randomUUID(),
    entity,
    op: 'upsert',
    recordId,
    clientTimestamp: new Date().toISOString(),
    baseVersion: null,
    ...(payload ? { payload } : {}),
    ...extra,
  }) as SyncRequest['mutations'][number];

describe('v1.8.12 review fixes (server)', () => {
  it('R-A (old clients): a request that references a record created later in the same request is applied in dependency order', async () => {
    const db = createTestD1();
    const res = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        mut('cashflow', 'cf-1', { date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: 'x', amount: 100, currency: 'TWD', linkedAccountId: 'acc-new', ledgerId: 'lg-new' }),
        mut('asset', 'acc-new', { ...linked('新帳戶'), ledgerId: 'lg-new' }),
        mut('ledger', 'lg-new', { name: '新帳本' }),
      ],
    });
    expect(res.rejected).toEqual([]);
    expect(res.ackedMutationIds).toHaveLength(3);
  });

  it('R-F: a group rejected because a reference is missing reports the missing reference', async () => {
    const db = createTestD1();
    await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [mut('asset', 'A', linked('A'))] });
    const g = 'G1';
    const res = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        mut('savings_adjustment', 'a1', { accountId: 'A', date: '2026-11-26', amount: -100, transferGroupId: g }, { atomicGroupId: g }),
        mut('savings_adjustment', 'a2', { accountId: 'NOPE', date: '2026-11-26', amount: 100, transferGroupId: g }, { atomicGroupId: g }),
      ],
    });
    expect(res.rejected).toHaveLength(2);
    expect(res.rejected.every((r) => /對應的活存帳戶不存在或已刪除/.test(r.reason))).toBe(true);
  });
});

describe('v1.8.12 review fixes (frozen re-apply keeps transfers whole)', () => {
  it('#5: a frozen transfer is re-applied with its atomic group, or skipped as a whole', async () => {
    const localDb = new LocalFinanceDB(`rv2-frozen-${crypto.randomUUID()}`);
    await localDb.open();
    const g = 'G-frozen';
    await localDb.saveFrozenOutbox([
      { ...mut('savings_adjustment', 'adj-1', { accountId: 'A', date: '2026-11-26', amount: -1, note: '', transferGroupId: g, createdAt: '2026-11-26T00:00:00.000Z' }), atomicGroupId: g, frozenBaselineExisted: false },
      { ...mut('savings_adjustment', 'adj-2', { accountId: 'B', date: '2026-11-26', amount: 1, note: '', transferGroupId: g, createdAt: '2026-11-26T00:00:00.000Z' }), atomicGroupId: g, frozenBaselineExisted: false },
    ] as never);
    const offline = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const engine = new SyncEngine(localDb, { fetchImpl: offline, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    await engine.init();
    await engine.reapplyFrozenOutbox();
    const outbox = await localDb.getOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox.every((m) => m.atomicGroupId === g)).toBe(true);
    engine.destroy();
    localDb.close();
  });
});
