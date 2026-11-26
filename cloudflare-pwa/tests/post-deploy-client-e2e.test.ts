import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
// 上線後審查修正（v1.8.17）：目前版本的客戶端（LocalFinanceDB＋SyncEngine）對目前版本的伺服器，端到端驗證離線操作順序。
// v1.8.11 舊客戶端的相同情境，以 `git archive 2ffcbdb~1` 的舊版樹執行，見 docs/reviews/2026-11-26_v1.8.17_changes.md。
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';
const acc = (name: string, qty = 100000) => ({
  itemName: name, majorType: '資產', updateMode: '手動快照', subCategory: '活存', liquidity: '高流動',
  quantityOrAmount: qty, currency: 'TWD', unitPrice: 1, isLinkedSavings: true,
  balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z',
});

function setup(opts: { failFirstMutationRequest?: boolean } = {}) {
  const db = createTestD1();
  let online = true;
  let failNext = false;
  const requests: number[] = [];
  const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (failNext && body.mutations?.length > 0) {
      failNext = false;
      throw new TypeError('Failed to fetch'); // flaky network right after coming back online
    }
    requests.push(body.mutations?.length ?? 0);
    const res = await processSyncRequest(db, UID, body);
    return new Response(JSON.stringify(res), { status: 200 });
  }) as typeof fetch;
  const engine = new SyncEngine(new LocalFinanceDB(`agentA-old-${crypto.randomUUID()}`), {
    fetchImpl, isOnline: () => online, retryBaseDelayMs: 60_000, requestLock: async (_n, fn) => fn(),
  });
  return {
    db, engine, requests,
    setOnline: (v: boolean) => { online = v; },
    armNetworkFailure: () => { failNext = true; },
  };
}

async function drain(engine: SyncEngine, times = 6) {
  for (let i = 0; i < times; i++) await engine.syncNow();
}

describe('v1.8.17 client against v1.8.17 server (post-deploy review fixes)', () => {
  it('O1: offline account + linked cashflow + account rename, first sync attempt hits a network error -> cashflow accepted', async () => {
    const t = setup();
    await t.engine.init();
    t.setOnline(false);
    const b = await t.engine.saveAsset(acc('新活存'));
    const cf = await t.engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '午餐', amount: 120, currency: 'TWD', linkedAccountId: b.id } as never);
    await t.engine.saveAsset({ ...acc('新活存(改名)'), id: b.id }); // coalesced create moves behind the cashflow
    t.setOnline(true);
    t.armNetworkFailure();
    await t.engine.syncNow(); // fails -> consecutiveFailures = 1 -> next batch size 1
    await drain(t.engine);
    const rej = t.engine.getRejections();
    const server = await t.db.prepare('SELECT id FROM cashflow_logs WHERE id = ?').bind(cf.id).first();
    expect(server).not.toBeNull();
    expect(rej).toEqual([]);
  });

  it('O1-control: same without network error -> accepted', async () => {
    const t = setup();
    await t.engine.init();
    t.setOnline(false);
    const b = await t.engine.saveAsset(acc('新活存'));
    const cf = await t.engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '午餐', amount: 120, currency: 'TWD', linkedAccountId: b.id } as never);
    await t.engine.saveAsset({ ...acc('新活存(改名)'), id: b.id });
    t.setOnline(true);
    await drain(t.engine);
    expect(t.engine.getRejections()).toEqual([]);
    expect(await t.db.prepare('SELECT id FROM cashflow_logs WHERE id = ?').bind(cf.id).first()).not.toBeNull();
  });

  it('O2: offline new account, transfer into it, rename it -> transfer accepted (both legs)', async () => {
    const t = setup();
    await t.engine.init();
    const a = await t.engine.saveAsset(acc('A'));
    await drain(t.engine, 2);
    t.setOnline(false);
    const b = await t.engine.saveAsset(acc('B', 0));
    await t.engine.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, date: '2026-11-26', amount: 500, fee: 0 } as never);
    await t.engine.saveAsset({ ...acc('B(改名)', 0), id: b.id });
    t.setOnline(true);
    await drain(t.engine);
    const rej = t.engine.getRejections();
    const adjs = await t.db.prepare('SELECT COUNT(*) AS n FROM savings_adjustments').first<{ n: number }>();
    expect(Number(adjs?.n)).toBe(2);
    expect(rej).toEqual([]);
  });

  it('O3: 70 queued mutations drain with partial acks, no rejection / conflict / quarantine', async () => {
    const t = setup();
    await t.engine.init();
    t.setOnline(false);
    for (let i = 0; i < 70; i++) {
      await t.engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: `x${i}`, amount: 1, currency: 'TWD' } as never);
    }
    t.setOnline(true);
    await t.engine.syncNow();
    await drain(t.engine, 3);
    const n = await t.db.prepare('SELECT COUNT(*) AS n FROM cashflow_logs').first<{ n: number }>();
    expect(Number(n?.n)).toBe(70);
    expect(t.engine.getRejections()).toEqual([]);
    expect(t.engine.getConflicts()).toEqual([]);
  });

  it('O4: transfer create + paired delete (no atomicGroupId) still works', async () => {
    const t = setup();
    await t.engine.init();
    const a = await t.engine.saveAsset(acc('A'));
    const b = await t.engine.saveAsset(acc('B'));
    const tr = await t.engine.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, date: '2026-11-26', amount: 500, fee: 10 } as never);
    await drain(t.engine, 2);
    expect(Number((await t.db.prepare('SELECT COUNT(*) AS n FROM savings_adjustments WHERE deleted_at IS NULL').first<{ n: number }>())?.n)).toBe(2);
    await t.engine.deleteSavingsAdjustment(tr.fromAdjustment!.id, true);
    await drain(t.engine, 2);
    expect(Number((await t.db.prepare('SELECT COUNT(*) AS n FROM savings_adjustments WHERE deleted_at IS NULL').first<{ n: number }>())?.n)).toBe(0);
    expect(t.engine.getRejections()).toEqual([]);
    expect(t.engine.getConflicts()).toEqual([]);
  });
});
