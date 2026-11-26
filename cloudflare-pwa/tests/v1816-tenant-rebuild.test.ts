import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '../shared/types';
import { runMonthEndSnapshotD1, runMonthlyRecurringD1 } from '../worker/automation';
import { processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

/**
 * v1.8.16 (B7): migration 0017 rebuilds the 12 tenant tables to drop `user_id … DEFAULT 'owner'`.
 * The rebuild must keep every row, every column definition (except that default) and every index.
 */
const MIGRATION_0017 = readFileSync(new URL('../migrations/0017_drop_owner_default.sql', import.meta.url), 'utf8');

const TENANT_TABLES = [
  'asset_items',
  'auth_passkeys',
  'auth_sessions',
  'cashflow_logs',
  'ledgers',
  'networth_history',
  'recurring_items',
  'rent_utility_records',
  'savings_adjustments',
  'sinking_fund_items',
  'stock_transactions',
  'sync_idempotency',
];

let n = 0;
const mut = (entity: string, recordId: string, payload?: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  n += 1;
  return {
    mutationId: `m-${n}`,
    entity,
    op: 'upsert',
    recordId,
    clientTimestamp: '2026-11-26T00:00:00.000Z',
    baseVersion: null,
    ...(payload ? { payload } : {}),
    ...extra,
  } as SyncRequest['mutations'][number];
};

/** Fills every tenant table for two users through the real app code paths plus a few raw rows. */
async function populate(db: D1Database) {
  for (const uid of ['owner', 'u-mom']) {
    await db
      .prepare(
        `INSERT INTO users (id, username, display_name, role, password_hash, password_salt, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'h', 's', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .bind(uid, uid, uid === 'owner' ? '管理員' : '媽媽', uid === 'owner' ? 'admin' : 'member')
      .run();
    const acc = { updateMode: '手動快照', majorType: '資產', subCategory: '活存', liquidity: '高流動', itemName: `活存「${uid}」`, quantityOrAmount: 12345.67, currency: 'TWD', unitPrice: 1, isLinkedSavings: true, balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z' };
    const res = await processSyncRequest(db, uid, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        mut('ledger', `lg-${uid}`, { name: '旅遊 ✈️', includeInNetWorth: false, monthlyDailyBudget: 3000 }),
        mut('asset', `acc-${uid}`, acc),
        mut('asset', `stk-${uid}`, { updateMode: '自動更新', majorType: '資產', subCategory: '美股/ETF', liquidity: '中流動', itemName: 'VOO', ticker: 'VOO', quantityOrAmount: 1.2345, currency: 'USD', unitPrice: 512.33, costBasis: 600.5 }),
        mut('cashflow', `cf-${uid}`, { date: '2026-11-20', type: '日常花費', category: '餐飲', itemName: '午餐, "引號"', amount: 123.5, currency: 'USD', fxRate: 32.1, note: '多行\n備註', linkedAccountId: `acc-${uid}`, ledgerId: `lg-${uid}` }),
        mut('recurring', `rc-${uid}`, { itemName: '房租', category: '居住', type: '固定支出', amount: 15000, currency: 'TWD', cycle: '月繳', billingSpec: '', status: '啟用', note: '', linkedAccountId: `acc-${uid}` }),
        mut('sinking', `sk-${uid}`, { itemName: '地價稅', category: '稅', totalAmount: 12000, months: 12, dueNote: '11 月', status: '啟用', note: '' }),
        mut('savings_adjustment', `adj-${uid}`, { accountId: `acc-${uid}`, date: '2026-11-21', amount: -500, currency: 'TWD', note: '轉出', transferGroupId: `tg-${uid}` }),
        mut('stock_tx', `tx-${uid}`, { assetId: `stk-${uid}`, date: '2026-11-22', txType: 'buy', shares: 0.5, totalAmount: 256.17, fee: 0.99 }),
        mut('utility_record', '11411', { period: '11411', isBaseline: false, curTotal: 1234, cur6F: 456, totalElec: 2345, totalWater: 678, f6People: 2, f5People: 3, curA: 11, curB: 22, curC: 33 }),
      ],
    });
    expect(res.rejected).toEqual([]);
    // a soft-deleted row and a deleted record must survive the rebuild too
    await processSyncRequest(db, uid, { sinceSeq: 0, clientEpoch: 1, mutations: [mut('cashflow', `cf-${uid}`, undefined, { op: 'delete', baseVersion: 1 })] });
    await runMonthlyRecurringD1(db, uid, 2026, 11); // auto-posted row with recurring_dedup_key
    await runMonthEndSnapshotD1(db, uid, new Date('2026-11-30T15:00:00.000Z')); // networth_history
    await db
      .prepare(
        "INSERT INTO auth_sessions (token_hash, device_label, expires_at, created_at, last_seen_at, user_id) VALUES (?, 'iPhone', '2027-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-26T00:00:00.000Z', ?)"
      )
      .bind(`tok-${uid}`, uid)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_passkeys (credential_id, public_key, counter, transports, device_name, created_at, user_id) VALUES (?, 'pk', 7, '[\"internal\"]', 'Face ID', '2026-11-01T00:00:00.000Z', ?)"
      )
      .bind(`cred-${uid}`, uid)
      .run();
  }
}

async function dump(db: D1Database) {
  const tables: Record<string, unknown[]> = {};
  for (const t of TENANT_TABLES) {
    const cols = (await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((c) => c.name);
    const rows = await db.prepare(`SELECT * FROM ${t} ORDER BY ${cols.join(', ')}`).all();
    tables[t] = rows.results;
  }
  return tables;
}

async function columns(db: D1Database, t: string) {
  return (await db.prepare(`PRAGMA table_info(${t})`).all<Record<string, unknown>>()).results;
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').replace(/^CREATE TABLE "?(\w+?)(?:__v17)?"? ?\(/, 'CREATE TABLE $1 (').trim();

async function tableSql(db: D1Database) {
  const rows = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{ name: string; sql: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.name, norm(r.sql)]));
}

async function indexes(db: D1Database) {
  const rows = await db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .all<{ name: string; tbl_name: string; sql: string }>();
  return rows.results.map((r) => ({ name: r.name, table: r.tbl_name, sql: r.sql.replace(/\s+/g, ' ').trim() }));
}

describe('v1.8.16 migration 0017: tenant tables without DEFAULT \'owner\'', () => {
  it('keeps every row, column definition and index; only the user_id default is gone', async () => {
    const db = createTestD1({ stopBefore: '0017' });
    await populate(db);
    const before = await dump(db);
    for (const t of TENANT_TABLES) expect(before[t].length, `${t} has test rows`).toBeGreaterThan(0);
    const colsBefore = Object.fromEntries(await Promise.all(TENANT_TABLES.map(async (t) => [t, await columns(db, t)])));
    const idxBefore = await indexes(db);
    const sqlBefore = await tableSql(db);

    await db.exec(MIGRATION_0017);

    expect(await dump(db)).toEqual(before);
    for (const t of TENANT_TABLES) {
      const after = await columns(db, t);
      const expected = (colsBefore[t] as Array<Record<string, unknown>>).map((c) =>
        c.name === 'user_id' ? { ...c, dflt_value: null } : c
      );
      expect(after, t).toEqual(expected);
    }
    expect(await indexes(db)).toEqual(idxBefore);
    // CHECK / UNIQUE / PRIMARY KEY / COLLATE clauses are not in table_info: compare the full CREATE TABLE text
    const sqlAfter = await tableSql(db);
    for (const t of TENANT_TABLES) {
      expect(sqlBefore[t], t).toContain("DEFAULT 'owner'");
      expect(sqlAfter[t], t).toBe(sqlBefore[t].replace(/ DEFAULT 'owner'/, ''));
    }
    const leftovers = await db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__v17'").all();
    expect(leftovers.results).toEqual([]);
    const withDefault = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%DEFAULT ''owner''%'").all();
    expect(withDefault.results).toEqual([]);
  });

  it('an INSERT that forgets user_id now fails instead of filing the row under the admin', async () => {
    const db = createTestD1();
    await expect(
      db
        .prepare(
          "INSERT INTO cashflow_logs (id, date, year_month, type, category, item_name, amount, twd_amount, created_at, updated_at) VALUES ('x', '2026-11-26', '2026-11', '日常花費', '餐飲', 'x', 1, 1, 'x', 'x')"
        )
        .run()
    ).rejects.toThrow(/NOT NULL constraint failed: cashflow_logs\.user_id/);
    for (const t of TENANT_TABLES) {
      const col = (await columns(db, t)).find((c) => c.name === 'user_id');
      expect(col?.notnull, t).toBe(1);
      expect(col?.dflt_value, t).toBeNull();
    }
  });

  it('the app keeps working on the rebuilt tables (unique dedup index, sync, auto-posting)', async () => {
    const db = createTestD1({ stopBefore: '0017' });
    await populate(db);
    await db.exec(MIGRATION_0017);
    // the partial UNIQUE index still prevents a second auto-posting of the same item and month
    const again = await runMonthlyRecurringD1(db, 'owner', 2026, 11);
    expect(again.insertedCount).toBe(0);
    const res = await processSyncRequest(db, 'owner', {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [mut('cashflow', 'cf-after', { date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '遷移後', amount: 10, currency: 'TWD' })],
    });
    expect(res.rejected).toEqual([]);
    expect(res.ackedMutationIds).toHaveLength(1);
    const pull = await processSyncRequest(db, 'u-mom', { sinceSeq: null as never, clientEpoch: 1, mutations: [] });
    expect(pull.delta.assetItems.map((a) => a.id).sort()).toEqual(['acc-u-mom', 'stk-u-mom']);
    expect(pull.delta.cashflowLogs.every((c) => c.id !== 'cf-after')).toBe(true); // tenants stay separated
  });
});
