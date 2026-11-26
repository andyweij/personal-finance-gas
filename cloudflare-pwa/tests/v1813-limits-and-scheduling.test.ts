import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncRequest, SyncResponse } from '../shared/types';
import { createApp } from '../worker/index';
import type { WorkerEnv } from '../worker/types';
import { createCountingD1, createTestD1 } from './helpers/mockD1';

/**
 * H5: Cloudflare's D1 limit is 50 queries per Worker invocation on the Free plan (1000 on Paid). Every request,
 * including authentication, must stay within 50 even in the worst case.
 */
const D1_FREE_LIMIT = 50;

const cf = (name: string) => ({
  date: '2026-11-26',
  type: '日常花費',
  category: '餐飲',
  itemName: name,
  amount: 100,
  currency: 'TWD',
});

async function setupApp() {
  const app = createApp();
  const inner = createTestD1();
  const counting = createCountingD1(inner);
  const env = { DB: counting.db, SETUP_SECRET: 'secret-123' } as WorkerEnv;
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
  const sync = async (body: Partial<SyncRequest>) => {
    counting.reset();
    const r = await app.request(
      '/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'cf-connecting-ip': '10.0.0.1' },
        body: JSON.stringify({ sinceSeq: 0, clientEpoch: 1, mutations: [], ...body }),
      },
      env
    );
    return { status: r.status, json: (await r.json()) as SyncResponse, queries: counting.count() };
  };
  return { sync, inner };
}

let seq = 0;
const mut = (entity: string, recordId: string, payload?: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    mutationId: `h5-${seq}-${crypto.randomUUID()}`,
    entity,
    op: 'upsert',
    recordId,
    clientTimestamp: new Date().toISOString(),
    baseVersion: null,
    ...(payload ? { payload } : {}),
    ...extra,
  } as SyncRequest['mutations'][number];
};

describe('v1.8.13 H5 D1 query budget', () => {
  it('a pull-only sync (incremental, write-probe and full) uses only a handful of queries', async () => {
    const { sync } = await setupApp();
    const first = await sync({ sinceSeq: null as never });
    expect(first.status).toBe(200);
    expect(first.queries).toBeLessThanOrEqual(8);
    const incremental = await sync({ sinceSeq: first.json.syncCursor });
    expect(incremental.queries).toBeLessThanOrEqual(8);
    const probe = await sync({ sinceSeq: first.json.syncCursor, writeProbe: true });
    expect(probe.json.writeProbeOk).toBe(true);
    expect(probe.queries).toBeLessThanOrEqual(9);
  });

  it('a full client batch of creates stays within the Free-plan limit', async () => {
    const { SYNC_MAX_MUTATIONS_PER_REQUEST } = await import('../shared/constants');
    const { sync } = await setupApp();
    const ms = Array.from({ length: SYNC_MAX_MUTATIONS_PER_REQUEST }, (_, i) => mut('cashflow', `cf-${i}`, cf(`n${i}`)));
    let pending = ms;
    for (let round = 0; round < 10 && pending.length > 0; round++) {
      const res = await sync({ mutations: pending });
      expect(res.status).toBe(200);
      expect(res.queries).toBeLessThanOrEqual(D1_FREE_LIMIT);
      expect(res.json.rejected).toEqual([]);
      expect(res.json.ackedMutationIds.length).toBeGreaterThan(0);
      const acked = new Set(res.json.ackedMutationIds);
      pending = pending.filter((m) => !acked.has(m.mutationId));
    }
    expect(pending).toEqual([]);
  });

  it('an older client sending 50 mutations at once is never rejected for size and is drained within the limit', async () => {
    const { sync } = await setupApp();
    const ms = Array.from({ length: 50 }, (_, i) => mut('cashflow', `old-${i}`, cf(`old${i}`)));
    let pending = ms;
    let rounds = 0;
    while (pending.length > 0 && rounds < 20) {
      rounds += 1;
      const res = await sync({ mutations: pending });
      expect(res.status).toBe(200);
      expect(res.queries).toBeLessThanOrEqual(D1_FREE_LIMIT);
      expect(res.json.rejected).toEqual([]);
      const acked = new Set(res.json.ackedMutationIds);
      expect(acked.size).toBeGreaterThan(0);
      pending = pending.filter((m) => !acked.has(m.mutationId));
    }
    expect(pending).toEqual([]);
  });

  it('a worst-case batch (every mutation conflicts or is rejected) still stays within the limit and makes progress', async () => {
    const { SYNC_MAX_MUTATIONS_PER_REQUEST } = await import('../shared/constants');
    const { sync } = await setupApp();
    const seed = Array.from({ length: SYNC_MAX_MUTATIONS_PER_REQUEST }, (_, i) => mut('cashflow', `w-${i}`, cf(`w${i}`)));
    let pending = seed;
    for (let r = 0; r < 10 && pending.length; r++) {
      const res = await sync({ mutations: pending });
      const acked = new Set(res.json.ackedMutationIds);
      pending = pending.filter((m) => !acked.has(m.mutationId));
    }
    // stale versions (conflicts), dangling references (rejections) and a ledger delete with linked rows
    const bad = [
      ...Array.from({ length: SYNC_MAX_MUTATIONS_PER_REQUEST - 4 }, (_, i) =>
        mut('cashflow', `w-${i}`, { ...cf('conflict'), ledgerId: 'NOPE' }, { baseVersion: 99 })
      ),
      mut('savings_adjustment', 'adj-x', { accountId: 'missing', date: '2026-11-26', amount: 1, transferGroupId: 'g' }, { atomicGroupId: 'g' }),
      mut('savings_adjustment', 'adj-y', { accountId: 'missing2', date: '2026-11-26', amount: -1, transferGroupId: 'g' }, { atomicGroupId: 'g' }),
      mut('ledger', 'default', undefined, { op: 'delete', baseVersion: 1 }),
      mut('settings', 'settings', { monthlyDailyBudget: 1 }, { baseVersion: 42 }),
    ];
    let remaining = bad;
    for (let r = 0; r < 20 && remaining.length; r++) {
      const res = await sync({ mutations: remaining });
      expect(res.status).toBe(200);
      expect(res.queries).toBeLessThanOrEqual(D1_FREE_LIMIT);
      const handled = new Set([
        ...res.json.ackedMutationIds,
        ...res.json.rejected.map((x) => x.mutationId),
        ...(res.json.conflicts || []).map((x) => x.mutationId),
      ]);
      expect(handled.size).toBeGreaterThan(0);
      remaining = remaining.filter((m) => !handled.has(m.mutationId));
    }
    expect(remaining).toEqual([]);
  });

  it('the client batch size equals the server per-request limit', async () => {
    const { SYNC_MAX_MUTATIONS_PER_REQUEST } = await import('../shared/constants');
    const { SyncEngine } = await import('../web/src/sync/syncEngine');
    const { LocalFinanceDB } = await import('../web/src/db/localDb');
    const engine = new SyncEngine(new LocalFinanceDB(`h5-${crypto.randomUUID()}`), { isOnline: () => false });
    expect((engine as unknown as { maxBatchSize: number }).maxBatchSize).toBe(SYNC_MAX_MUTATIONS_PER_REQUEST);
    expect(SYNC_MAX_MUTATIONS_PER_REQUEST).toBeLessThanOrEqual(20);
    engine.destroy();
  });
});

/* ============================== H6 scheduling ============================== */

import { afterEach, vi } from 'vitest';
import worker from '../worker/index';
import { processSyncRequest } from '../worker/sync';

const recurringPayload = (name: string, amount: number) => ({
  itemName: name,
  category: '居住',
  type: '固定支出',
  amount,
  currency: 'TWD',
  cycle: '月繳',
  billingSpec: '',
  status: '啟用',
  note: '',
});

const stockAsset = (ticker: string) => ({
  updateMode: '自動更新',
  majorType: '資產',
  subCategory: '台股',
  liquidity: '中流動',
  itemName: `股票 ${ticker}`,
  ticker,
  quantityOrAmount: 1,
  currency: 'TWD',
  unitPrice: 10,
});

async function seedUser(db: D1Database, id: string, createdAt = '2026-01-01T00:00:00.000Z') {
  await db
    .prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, password_salt, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'x', 'x', 1, ?, ?)`
    )
    .bind(id, id, id, createdAt, createdAt)
    .run();
}

const scheduledAt = (cron: string, iso: string) =>
  ({ cron, scheduledTime: Date.parse(iso), noRetry() {} }) as unknown as ScheduledController;

async function autoRows(db: D1Database, uid: string, ym: string) {
  const r = await db
    .prepare("SELECT item_name FROM cashflow_logs WHERE user_id = ? AND year_month = ? AND source = '自動入帳' AND deleted_at IS NULL")
    .bind(uid, ym)
    .all<{ item_name: string }>();
  return r.results.map((x) => x.item_name).sort();
}

describe('v1.8.13 H6 scheduled automation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on the 1st, recurring posting runs first and still happens when the quote refresh fails', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    await processSyncRequest(db, 'u1', { sinceSeq: 0, clientEpoch: 1, mutations: [{ mutationId: 'r1', entity: 'recurring', op: 'upsert', recordId: 'rc1', clientTimestamp: 'x', baseVersion: null, payload: recurringPayload('房租', 1000) }] });
    await processSyncRequest(db, 'u1', { sinceSeq: 0, clientEpoch: 1, mutations: [{ mutationId: 'a1', entity: 'asset', op: 'upsert', recordId: 'as1', clientTimestamp: 'x', baseVersion: null, payload: { ...stockAsset('AAPL'), subCategory: '美股/ETF', currency: 'USD' } }] });
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push(`fetch:${(await autoRows(db, 'u1', '2026-12')).length}`);
      throw new Error('network down');
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // the D1 write of the quote refresh also fails
    const failingDb = new Proxy(db, {
      get(t, p) {
        if (p === 'batch') {
          return (stmts: D1PreparedStatement[]) => {
            if (stmts.some((s) => /SET unit_price/.test(String((s as unknown as { query: string }).query)))) {
              return Promise.reject(new Error('D1 overloaded'));
            }
            return t.batch(stmts);
          };
        }
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    await worker.scheduled(scheduledAt('0 0 1 * *', '2026-12-01T00:00:00.000Z'), { DB: failingDb } as WorkerEnv);
    expect(await autoRows(db, 'u1', '2026-12')).toEqual(['房租']);
    expect(order.every((o) => o === 'fetch:1')).toBe(true); // every fetch happened after posting
    const run = await db.prepare("SELECT status FROM automation_runs WHERE user_id = 'u1' AND kind = 'recurring' AND period = '2026-12'").first<{ status: string }>();
    expect(run?.status).toBe('done');
    void errSpy;
  });

  it('a missed 1st-of-month run is caught up by the next scheduled run, once', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    await processSyncRequest(db, 'u1', { sinceSeq: 0, clientEpoch: 1, mutations: [{ mutationId: 'r1', entity: 'recurring', op: 'upsert', recordId: 'rc1', clientTimestamp: 'x', baseVersion: null, payload: recurringPayload('房租', 1000) }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await worker.scheduled(scheduledAt('0 22 * * *', '2026-12-04T22:00:00.000Z'), { DB: db } as WorkerEnv);
    expect(await autoRows(db, 'u1', '2026-12')).toEqual(['房租']);
    // the November month-end snapshot was missed too
    const snap = await db.prepare("SELECT snapshot_date FROM networth_history WHERE user_id = 'u1' AND year_month = '2026-11'").first<{ snapshot_date: string }>();
    expect(snap?.snapshot_date).toBe('2026-11-30');
    await worker.scheduled(scheduledAt('0 15 * * *', '2026-12-05T15:00:00.000Z'), { DB: db } as WorkerEnv);
    expect(await autoRows(db, 'u1', '2026-12')).toEqual(['房租']);
  });

  it('a user who joined after the 1st is not back-posted for that month', async () => {
    const db = createTestD1();
    await seedUser(db, 'late', '2026-12-10T03:00:00.000Z');
    await processSyncRequest(db, 'late', { sinceSeq: 0, clientEpoch: 1, mutations: [{ mutationId: 'r1', entity: 'recurring', op: 'upsert', recordId: 'rc1', clientTimestamp: 'x', baseVersion: null, payload: recurringPayload('房租', 1000) }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await worker.scheduled(scheduledAt('0 22 * * *', '2026-12-12T22:00:00.000Z'), { DB: db } as WorkerEnv);
    expect(await autoRows(db, 'late', '2026-12')).toEqual([]);
  });

  it('migration 0016 marks periods that already ran so deploying never back-fills them', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../migrations/0016_automation_runs.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS automation_runs/);
    expect(sql).toMatch(/INSERT OR IGNORE INTO automation_runs/);
  });

  it('quote refresh never exceeds the per-invocation subrequest budget, refreshes stalest first and every request has a timeout signal', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    const muts = Array.from({ length: 30 }, (_, i) => ({ mutationId: `s${i}`, entity: 'asset', op: 'upsert', recordId: `st${i}`, clientTimestamp: 'x', baseVersion: null, payload: stockAsset(String(1100 + i)) }));
    for (let i = 0; i < muts.length; i += 10) {
      await processSyncRequest(db, 'u1', { sinceSeq: 0, clientEpoch: 1, mutations: muts.slice(i, i + 10) as never });
    }
    let calls = 0;
    let withoutSignal = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (!init?.signal) withoutSignal += 1;
      return new Response('{}', { status: 503 }); // every source fails → maximum requests per ticker
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await worker.scheduled(scheduledAt('0 15 * * *', '2026-11-20T15:00:00.000Z'), { DB: db } as WorkerEnv);
    expect(calls).toBeLessThanOrEqual(50);
    expect(calls).toBeGreaterThan(0);
    expect(withoutSignal).toBe(0);
  });

  it('the scheduled run stays within 50 D1 queries with many users and recurring items', async () => {
    const inner = createTestD1();
    for (let u = 0; u < 6; u++) {
      await seedUser(inner, `u${u}`);
      await processSyncRequest(inner, `u${u}`, {
        sinceSeq: 0,
        clientEpoch: 1,
        mutations: Array.from({ length: 8 }, (_, i) => ({ mutationId: `r${u}-${i}`, entity: 'recurring', op: 'upsert', recordId: `rc${u}-${i}`, clientTimestamp: 'x', baseVersion: null, payload: recurringPayload(`項目${i}`, 100 + i) })) as never,
      });
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let posted = 0;
    for (let run = 0; run < 6; run++) {
      const counting = createCountingD1(inner);
      await worker.scheduled(scheduledAt('0 22 * * *', `2026-12-0${run + 2}T22:00:00.000Z`), { DB: counting.db } as WorkerEnv);
      expect(counting.count()).toBeLessThanOrEqual(50);
      posted = 0;
      for (let u = 0; u < 6; u++) posted += (await autoRows(inner, `u${u}`, '2026-12')).length;
      if (posted === 48) break;
    }
    expect(posted).toBe(48);
  });
});

/* ============================== month-end snapshot ============================== */

describe('v1.8.13 month-end snapshot', () => {
  it('records dated after the snapshot date are not counted; APP_TIMEZONE drives the date', async () => {
    const { runMonthEndSnapshotD1, getTaiwanDateParts } = await import('../worker/automation');
    const db = createTestD1();
    await seedUser(db, 'u1');
    const linkedAcc = { updateMode: '手動快照', majorType: '資產', subCategory: '活存', liquidity: '高流動', itemName: '活存', quantityOrAmount: 1000, currency: 'TWD', unitPrice: 1, isLinkedSavings: true, balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z' };
    await processSyncRequest(db, 'u1', {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        { mutationId: 'a', entity: 'asset', op: 'upsert', recordId: 'acc', clientTimestamp: 'x', baseVersion: null, payload: linkedAcc },
        { mutationId: 'c', entity: 'cashflow', op: 'upsert', recordId: 'future', clientTimestamp: 'x', baseVersion: null, payload: { date: '2026-12-05', type: '日常花費', category: '餐飲', itemName: '未來支出', amount: 300, currency: 'TWD', linkedAccountId: 'acc' } },
        { mutationId: 'd', entity: 'savings_adjustment', op: 'upsert', recordId: 'futadj', clientTimestamp: 'x', baseVersion: null, payload: { accountId: 'acc', date: '2026-12-03', amount: 500, currency: 'TWD', note: '' } },
      ] as never,
    });
    const res = await runMonthEndSnapshotD1(db, 'u1', new Date('2026-11-30T15:00:00.000Z'));
    expect(res.yearMonth).toBe('2026-11');
    expect(res.totalAssets).toBe(1000); // future cashflow / adjustment excluded

    expect(getTaiwanDateParts(new Date('2026-11-30T20:00:00.000Z'), 'Asia/Taipei').ymd).toBe('2026-12-01');
    expect(getTaiwanDateParts(new Date('2026-11-30T20:00:00.000Z'), 'America/New_York').ymd).toBe('2026-11-30');
  });

  it('sinking-fund reserve (no ledger) is part of the main ledger, as in the overview net-worth scope', async () => {
    const { runMonthEndSnapshotD1 } = await import('../worker/automation');
    const db = createTestD1();
    await seedUser(db, 'u1');
    await processSyncRequest(db, 'u1', {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        { mutationId: 's', entity: 'sinking', op: 'upsert', recordId: 'sk', clientTimestamp: 'x', baseVersion: null, payload: { itemName: '地價稅', category: '稅', totalAmount: 1200, months: 12, dueNote: '', status: '啟用', note: '' } },
      ] as never,
    });
    await runMonthEndSnapshotD1(db, 'u1', new Date('2026-11-30T15:00:00.000Z'));
    const row = await db.prepare("SELECT monthly_consumption FROM networth_history WHERE user_id = 'u1' AND year_month = '2026-11'").first<{ monthly_consumption: number }>();
    expect(Number(row?.monthly_consumption)).toBe(100);
  });
});

/* ============================== M13 import hardening ============================== */

describe('v1.8.13 import endpoints (M13)', () => {
  async function importApp() {
    const app = createApp();
    const inner = createTestD1();
    const counting = createCountingD1(inner);
    const env = { DB: counting.db, SETUP_SECRET: 'secret-123' } as WorkerEnv;
    const res = await app.request(
      '/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' },
        body: JSON.stringify({ setupSecret: 'secret-123', username: 'admin', displayName: '管理員', password: 'AdminPassword123!' }),
      },
      env
    );
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const me = ((await res.json()) as { user: { id: string } }).user.id;
    const post = async (path: string, body: BodyInit, extraHeaders: Record<string, string> = {}) => {
      counting.reset();
      const r = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'cf-connecting-ip': '10.0.0.1', ...extraHeaders }, body, duplex: 'half' } as RequestInit, env);
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, queries: counting.count() };
    };
    return { post, inner, me };
  }

  const streamOf = (bytes: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
        for (let sent = 0; sent < bytes; sent += chunk.length) controller.enqueue(chunk);
        controller.close();
      },
    });

  it('JSON and CSV imports use the same streaming size limit as /api/sync (413)', async () => {
    const { post } = await importApp();
    for (const path of ['/api/import/json', '/api/import/csv']) {
      const r = await post(path, streamOf(3 * 1024 * 1024) as never, {});
      expect(r.status, path).toBe(413);
    }
  });

  it('wrong field types are a 400, never a 500', async () => {
    const { post } = await importApp();
    for (const data of [{ cashflowLogs: {} }, { cashflowLogs: [123] }, { assetItems: 'x' }, { ledgers: [null] }, { netWorthHistory: [{ yearMonth: 5 }] }]) {
      const r = await post('/api/import/json', JSON.stringify({ mode: 'merge', data }));
      expect(r.status, JSON.stringify(data)).toBe(400);
    }
    const csv = await post('/api/import/csv', JSON.stringify({ csvText: 12345 }));
    expect(csv.status).toBe(400);
  });

  it('a large import is written atomically in a bounded number of statements and D1 queries', async () => {
    const { post, inner, me } = await importApp();
    const logs = Array.from({ length: 3000 }, (_, i) => ({ ...cf(`匯入${i}`), id: `imp-${i}` }));
    let maxBatch = 0;
    const realBatch = inner.batch.bind(inner);
    (inner as unknown as { batch: typeof inner.batch }).batch = (async (stmts: D1PreparedStatement[]) => {
      maxBatch = Math.max(maxBatch, stmts.length);
      return realBatch(stmts);
    }) as typeof inner.batch;
    const r = await post('/api/import/json', JSON.stringify({ mode: 'replace', data: { cashflowLogs: logs } }));
    expect(r.status).toBe(200);
    expect(r.json.importedLogs).toBe(3000);
    expect(r.queries).toBeLessThanOrEqual(D1_FREE_LIMIT);
    expect(maxBatch).toBeLessThanOrEqual(100);
    const n = await inner.prepare('SELECT COUNT(*) AS n FROM cashflow_logs WHERE user_id = ?').bind(me).first<{ n: number }>();
    expect(Number(n?.n)).toBe(3000);
  });

  it('CSV import uses deterministic ids: importing the same CSV twice does not duplicate, identical lines are kept, rows get ledger_id', async () => {
    const { post, inner, me } = await importApp();
    const csvText = [
      '日期,年月,收支類型,分類,項目名稱,原幣金額,幣別,台幣金額,匯率,來源,備註',
      '2026/11/01,2026-11,日常花費,餐飲,咖啡,60,TWD,60,1,匯入,',
      '2026/11/01,2026-11,日常花費,餐飲,咖啡,60,TWD,60,1,匯入,',
      '2026/11/02,2026-11,日常花費,交通,捷運,30,TWD,30,1,匯入,',
    ].join('\n');
    const first = await post('/api/import/csv', JSON.stringify({ csvText }));
    expect(first.status).toBe(200);
    const second = await post('/api/import/csv', JSON.stringify({ csvText }));
    expect(second.status).toBe(200);
    const rows = await inner
      .prepare('SELECT item_name, ledger_id FROM cashflow_logs WHERE user_id = ? ORDER BY item_name')
      .bind(me)
      .all<{ item_name: string; ledger_id: string }>();
    expect(rows.results.map((x) => x.item_name)).toEqual(['咖啡', '咖啡', '捷運']);
    expect(rows.results.every((x) => x.ledger_id === 'default')).toBe(true);
  });
});
