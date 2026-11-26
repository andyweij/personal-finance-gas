import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { processSyncRequest } from '../worker/sync';
import type { WorkerEnv } from '../worker/types';
import { buildMonthlyDedupKey } from '../shared/recurring';
import { createCountingD1, createTestD1 } from './helpers/mockD1';

/**
 * 上線後審查（2026-11-26 post-deploy review）：模擬正式環境的升級路徑。
 *   1. 以 0001～0015 建立資料庫，放入 v1.8.11 舊版排程在 11/1 產生的資料（舊版的名稱式去重鍵）。
 *   2. 套用 0016（把 'now' 固定為正式環境套用 migration 的時間 2026-11-26）與 0017。
 *   3. 依序執行上線後實際會觸發的排程：11/26 23:00、11/27 06:00（台北時間），以及 11/30 月底、12/1 06:00 與 08:00。
 */

const MIGRATION_NOW = '2026-11-26 14:00:00';
const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replaceAll("'now'", `'${MIGRATION_NOW}'`);

const scheduledAt = (cron: string, iso: string) =>
  ({ cron, scheduledTime: Date.parse(iso), noRetry() {} }) as unknown as ScheduledController;

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

async function seedUser(db: D1Database, id: string, createdAt: string) {
  await db
    .prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, password_salt, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'x', 'x', 1, ?, ?)`
    )
    .bind(id, id, id, createdAt, createdAt)
    .run();
}

async function seedRecurring(db: D1Database, uid: string, names: string[]) {
  await processSyncRequest(db, uid, {
    sinceSeq: 0,
    clientEpoch: 1,
    mutations: names.map((n, i) => ({
      mutationId: `${uid}-r${i}`,
      entity: 'recurring',
      op: 'upsert',
      recordId: `${uid}-rc${i}`,
      clientTimestamp: 'x',
      baseVersion: null,
      payload: recurringPayload(n, 1000 + i),
    })) as never,
  });
  // 項目在 10 月就已建立
  await db.prepare("UPDATE recurring_items SET created_at = '2026-10-05T00:00:00.000Z' WHERE user_id = ?").bind(uid).run();
}

/** v1.8.11 舊版排程在 11/1 寫入的自動入帳（名稱式去重鍵） */
async function seedLegacyAutoPost(db: D1Database, uid: string, name: string, amount: number) {
  await db
    .prepare(
      `INSERT INTO cashflow_logs (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, ledger_id, created_at, updated_at, version, change_seq)
       VALUES (?, ?, '2026-11-01', '2026-11', '固定支出', '居住', ?, ?, 'TWD', 1, ?, '自動入帳', '', ?, 'default', '2026-11-01T00:00:05.000Z', '2026-11-01T00:00:05.000Z', 1, 1)`
    )
    .bind(uid, crypto.randomUUID(), name, amount, amount, buildMonthlyDedupKey('2026-11', '固定支出', name, 'default'))
    .run();
}

async function autoRows(db: D1Database, uid: string, ym: string) {
  const r = await db
    .prepare("SELECT item_name FROM cashflow_logs WHERE user_id = ? AND year_month = ? AND source = '自動入帳' AND deleted_at IS NULL")
    .bind(uid, ym)
    .all<{ item_name: string }>();
  return r.results.map((x) => x.item_name).sort();
}

async function snapshots(db: D1Database, uid: string) {
  const r = await db
    .prepare('SELECT year_month, snapshot_date FROM networth_history WHERE user_id = ? ORDER BY year_month')
    .bind(uid)
    .all<{ year_month: string; snapshot_date: string }>();
  return r.results.map((x) => `${x.year_month}@${x.snapshot_date}`);
}

describe('上線後第一次排程（0016 標記 + 補跑）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('舊版已在 11/1 入帳、10 月已有快照的帳號：上線後的排程不會重複入帳或補快照；12/1 只入帳一次', async () => {
    const db = createTestD1({ stopBefore: '0016' });
    await seedUser(db, 'u1', '2026-09-01T00:00:00.000Z');
    await seedRecurring(db, 'u1', ['房租', '電信', '保險']);
    for (const [i, n] of ['房租', '電信', '保險'].entries()) await seedLegacyAutoPost(db, 'u1', n, 1000 + i);
    await db
      .prepare(
        `INSERT INTO networth_history (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq)
         VALUES ('u1', '2026-10', '2026-10-31', 1, 0, 1, 0, 0, 0, 0, 0, 0, '', '2026-10-31T15:00:00.000Z', 1)`
      )
      .run();

    await db.exec(migration('0016_automation_runs.sql'));
    await db.exec(migration('0017_drop_owner_default.sql'));
    const marks = await db
      .prepare("SELECT kind, period, status FROM automation_runs WHERE user_id = 'u1' ORDER BY kind, period")
      .all<{ kind: string; period: string; status: string }>();
    expect(marks.results.map((m) => `${m.kind}:${m.period}:${m.status}`)).toEqual([
      'recurring:2026-11:done',
      'snapshot:2026-10:done',
    ]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // 11/26 23:00、11/27 06:00（台北）
    for (const [cron, iso] of [
      ['0 15 * * *', '2026-11-26T15:00:00.000Z'],
      ['0 22 * * *', '2026-11-26T22:00:00.000Z'],
    ] as const) {
      const counting = createCountingD1(db);
      await worker.scheduled(scheduledAt(cron, iso), { DB: counting.db } as WorkerEnv);
      expect(counting.count()).toBeLessThanOrEqual(50);
    }
    expect(await autoRows(db, 'u1', '2026-11')).toEqual(['保險', '房租', '電信']);
    expect(await snapshots(db, 'u1')).toEqual(['2026-10@2026-10-31']);

    // 11/30 23:00 月底快照、12/1 06:00（每日美股）與 08:00（每月）
    for (const [cron, iso] of [
      ['0 15 * * *', '2026-11-30T15:00:00.000Z'],
      ['0 22 * * *', '2026-11-30T22:00:00.000Z'],
      ['0 0 1 * *', '2026-12-01T00:00:00.000Z'],
    ] as const) {
      await worker.scheduled(scheduledAt(cron, iso), { DB: db } as WorkerEnv);
    }
    expect(await snapshots(db, 'u1')).toEqual(['2026-10@2026-10-31', '2026-11@2026-11-30']);
    expect(await autoRows(db, 'u1', '2026-12')).toEqual(['保險', '房租', '電信']);
  });

  it('沒有 11 月自動入帳證據的舊帳號：上線後第一次排程（11/26 23:00）就會補入 11 月常態收支，並補一筆以「今天」資產值計算的 10 月快照', async () => {
    // 這是設計上的行為（H6 補跑），列出來讓使用者確認正式環境資料是否屬於這種情況
    const db = createTestD1({ stopBefore: '0016' });
    await seedUser(db, 'u2', '2026-10-10T00:00:00.000Z');
    await seedRecurring(db, 'u2', ['房租']);
    await db.exec(migration('0016_automation_runs.sql'));
    await db.exec(migration('0017_drop_owner_default.sql'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled(scheduledAt('0 15 * * *', '2026-11-26T15:00:00.000Z'), { DB: db } as WorkerEnv);
    expect(await autoRows(db, 'u2', '2026-11')).toEqual(['房租']);
    const entry = await db
      .prepare("SELECT date FROM cashflow_logs WHERE user_id = 'u2' AND year_month = '2026-11' AND source = '自動入帳'")
      .first<{ date: string }>();
    expect(entry?.date).toBe('2026-11-01');
    expect(await snapshots(db, 'u2')).toEqual(['2026-10@2026-10-31']);
  });
});
