import { describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_ID } from '../shared/constants';
import type { SyncEntity, SyncMutation } from '../shared/types';
import {
  ALLOWED_SYNC_ENTITIES,
  buildChunkedImportSql,
  buildDeltaSelectSql,
  buildRowUpsertSql,
  buildSoftDeleteSql,
  CURR_SEQ_SQL,
  ENTITY_ROW_TABLE,
  EPOCH_GUARD_SQL,
  isMissingOptionalTableError,
  NEXT_SEQ_SQL,
  OPTIONAL_SYNC_METAS,
  OPTIONAL_SYNC_TABLES,
  SYNC_ENTITY_BY_NAME,
  SYNC_ENTITY_METAS,
} from '../worker/entityRegistry';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

function countPlaceholders(sql: string): number {
  return (sql.match(/\?/g) || []).length;
}

async function seedUser(db: D1Database, userId: string): Promise<void> {
  const now = '2026-01-01T00:00:00.000Z';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, password_salt, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'hash', 'salt', ?, ?)`
    )
    .bind(userId, userId, userId, now, now)
    .run();
}

describe('worker/entityRegistry contracts', () => {
  const ALL_SYNC_ENTITIES: SyncEntity[] = [
    'settings',
    'utility_rents',
    'ledger',
    'cashflow',
    'recurring',
    'sinking',
    'asset',
    'savings_adjustment',
    'stock_tx',
    'utility_record',
    'financial_goal',
    'split_receivable',
    'installment_plan',
  ];

  it('covers every SyncEntity with unique entity, table, and deltaField metadata', () => {
    expect(SYNC_ENTITY_METAS).toHaveLength(ALL_SYNC_ENTITIES.length);
    const entities = new Set(SYNC_ENTITY_METAS.map((m) => m.entity));
    const tables = new Set(SYNC_ENTITY_METAS.map((m) => m.table));
    const deltaFields = new Set(SYNC_ENTITY_METAS.map((m) => m.deltaField));

    expect(entities.size).toBe(ALL_SYNC_ENTITIES.length);
    expect(tables.size).toBe(ALL_SYNC_ENTITIES.length);
    expect(deltaFields.size).toBe(ALL_SYNC_ENTITIES.length);

    for (const e of ALL_SYNC_ENTITIES) {
      expect(ALLOWED_SYNC_ENTITIES.has(e)).toBe(true);
      expect(SYNC_ENTITY_BY_NAME[e]?.entity).toBe(e);
    }
  });

  it('derives ENTITY_ROW_TABLE strictly from prefetchable row entities', () => {
    expect(Object.keys(ENTITY_ROW_TABLE).sort()).toEqual(
      [
        'asset',
        'cashflow',
        'financial_goal',
        'installment_plan',
        'ledger',
        'recurring',
        'savings_adjustment',
        'sinking',
        'split_receivable',
        'stock_tx',
      ].sort()
    );
    expect(ENTITY_ROW_TABLE.settings).toBeUndefined();
    expect(ENTITY_ROW_TABLE.utility_rents).toBeUndefined();
    expect(ENTITY_ROW_TABLE.utility_record).toBeUndefined();
  });

  it('tracks all optional post-0020 tables with user-facing migration errors', () => {
    expect(OPTIONAL_SYNC_TABLES).toEqual(['financial_goals', 'split_receivables', 'installment_plans']);
    for (const meta of OPTIONAL_SYNC_METAS) {
      expect(meta.optionalTable).toBe(true);
      expect(meta.missingTableError && meta.missingTableError.length > 0).toBe(true);
      expect(isMissingOptionalTableError(new Error(`SQLITE_ERROR: no such table: ${meta.table}`))).toBe(true);
      expect(isMissingOptionalTableError(new Error(`SQLITE_ERROR: no such table: ${meta.table}`), meta.table)).toBe(
        true
      );
      expect(isMissingOptionalTableError(new Error(`SQLITE_ERROR: no such table: ${meta.table}`), 'other_table')).toBe(
        false
      );
    }
    expect(isMissingOptionalTableError(new Error('SQLITE_ERROR: no such table: cashflow_logs'))).toBe(false);
    expect(isMissingOptionalTableError(new Error('SQLITE_CONSTRAINT: UNIQUE'))).toBe(false);
  });

  it('buildSoftDeleteSql aligns placeholders and binds for id and period keys with optional guards', () => {
    const basic = buildSoftDeleteSql({
      table: 'sinking_fund_items',
      keyColumn: 'id',
      uid: 'u1',
      recordId: 'sf_1',
      writeTs: '2026-05-01T00:00:00.000Z',
      nextVersion: 2,
      expectedVersion: 1,
      expectedEpoch: 3,
    });
    expect(countPlaceholders(basic.sql)).toBe(basic.binds.length);
    expect(basic.sql).toContain(NEXT_SEQ_SQL);
    expect(basic.sql).toContain(EPOCH_GUARD_SQL);
    expect(basic.sql).toContain('WHERE user_id = ? AND id = ? AND version = ?');

    const guarded = buildSoftDeleteSql({
      table: 'ledgers',
      keyColumn: 'id',
      uid: 'u1',
      recordId: 'led_2',
      writeTs: '2026-05-01T00:00:00.000Z',
      nextVersion: 4,
      expectedVersion: 3,
      expectedEpoch: 1,
      extraGuardSql: ' AND NOT EXISTS (SELECT 1 FROM cashflow_logs WHERE user_id = ? AND ledger_id = ?)',
      extraGuardBinds: ['u1', 'led_2'],
    });
    expect(countPlaceholders(guarded.sql)).toBe(guarded.binds.length);
    expect(guarded.binds.slice(-2)).toEqual(['u1', 'led_2']);

    const periodDel = buildSoftDeleteSql({
      table: 'rent_utility_records',
      keyColumn: 'period',
      uid: 'u1',
      recordId: '2026-04',
      writeTs: '2026-05-01T00:00:00.000Z',
      nextVersion: 2,
      expectedVersion: 1,
      expectedEpoch: 1,
    });
    expect(countPlaceholders(periodDel.sql)).toBe(periodDel.binds.length);
    expect(periodDel.sql).toContain('AND period = ?');
  });

  it('buildRowUpsertSql handles updateOnly, updateValue, insertValue, and guardSql cleanly', () => {
    const columns = [
      { col: 'item_name', value: 'VOO' },
      { col: 'unit_price', updateValue: 510, insertValue: 500 },
      { col: 'price_updated_at', updateValue: '2026-05-01T01:00:00.000Z', updateOnly: true },
    ];

    const upd = buildRowUpsertSql({
      table: 'asset_items',
      keyColumn: 'id',
      isUpdate: true,
      uid: 'u1',
      recordId: 'ast_1',
      columns,
      createdAt: '2026-01-01T00:00:00.000Z',
      writeTs: '2026-05-01T02:00:00.000Z',
      nextVersion: 3,
      expectedVersion: 2,
      expectedEpoch: 1,
      guardSql: ' AND EXISTS (SELECT 1 FROM ledgers WHERE user_id = ? AND id = ?)',
      guardBinds: ['u1', 'main'],
    });
    expect(countPlaceholders(upd.sql)).toBe(upd.binds.length);
    expect(upd.sql).toContain('price_updated_at = ?');
    expect(upd.sql).toContain('deleted_at = NULL');
    expect(upd.binds.slice(0, 3)).toEqual(['VOO', 510, '2026-05-01T01:00:00.000Z']);

    const ins = buildRowUpsertSql({
      table: 'asset_items',
      keyColumn: 'id',
      isUpdate: false,
      uid: 'u1',
      recordId: 'ast_1',
      columns,
      createdAt: '2026-01-01T00:00:00.000Z',
      writeTs: '2026-05-01T02:00:00.000Z',
      nextVersion: 1,
      expectedEpoch: 1,
      guardSql: ' AND EXISTS (SELECT 1 FROM ledgers WHERE user_id = ? AND id = ?)',
      guardBinds: ['u1', 'main'],
    });
    expect(countPlaceholders(ins.sql)).toBe(ins.binds.length);
    expect(ins.sql).not.toContain('price_updated_at');
    expect(ins.sql).toContain('ON CONFLICT(user_id, id) DO NOTHING');
    expect(ins.binds.slice(0, 4)).toEqual(['u1', 'ast_1', 'VOO', 500]);
  });

  it('buildDeltaSelectSql generates valid SQL for seq, since, and full modes across all entities', () => {
    for (const meta of SYNC_ENTITY_METAS) {
      const seqOpen = buildDeltaSelectSql({ ...meta, uid: 'u1', mode: { kind: 'seq', sinceSeq: 5 } });
      expect(countPlaceholders(seqOpen.sql)).toBe(seqOpen.binds.length);
      expect(seqOpen.sql).toContain('(SELECT change_seq FROM user_sync_state WHERE user_id = ?)');

      const seqBounded = buildDeltaSelectSql({
        ...meta,
        uid: 'u1',
        mode: { kind: 'seq', sinceSeq: 5, maxSeq: 20 },
      });
      expect(countPlaceholders(seqBounded.sql)).toBe(seqBounded.binds.length);
      expect(seqBounded.binds).toEqual(['u1', 5, 20]);

      const since = buildDeltaSelectSql({
        ...meta,
        uid: 'u1',
        mode: { kind: 'since', since: '2026-01-01T00:00:00.000Z' },
      });
      expect(countPlaceholders(since.sql)).toBe(since.binds.length);

      const full = buildDeltaSelectSql({ ...meta, uid: 'u1', mode: { kind: 'full' } });
      expect(countPlaceholders(full.sql)).toBe(full.binds.length);
      expect(full.sql.includes('deleted_at IS NULL')).toBe(meta.liveOnlyWhenFull);
    }
  });

  it('buildChunkedImportSql aligns JSON tuple indices and excludes immutable columns from conflict updates', () => {
    const sql = buildChunkedImportSql({
      table: 'sinking_fund_items',
      keyColumn: 'id',
      jsonColumns: ['id', 'item_name', 'total_amount', 'created_at', 'updated_at'],
    });
    expect(countPlaceholders(sql)).toBe(3); // user_id, CURR_SEQ_SQL user_id, json_each payload
    expect(sql).toContain(CURR_SEQ_SQL);
    expect(sql).toContain("json_extract(value, '$[0]')");
    expect(sql).toContain("json_extract(value, '$[4]')");
    expect(sql).toContain('item_name = excluded.item_name');
    expect(sql).toContain('updated_at = excluded.updated_at');
    expect(sql).not.toContain('id = excluded.id');
    expect(sql).not.toContain('created_at = excluded.created_at');
    expect(sql).toContain('WHERE sinking_fund_items.deleted_at IS NULL');
  });
});

describe('entityRegistry end-to-end sync & import golden matrix', () => {
  it('supports create, update, conflict, soft-delete, guards, and full export/import across all 13 entities', async () => {
    const db = createTestD1();
    const uid = 'u-registry';
    await seedUser(db, uid);

    const bootstrap = await processSyncRequest(db, uid, { mutations: [] });
    expect(bootstrap.ok).toBe(true);
    const epoch = bootstrap.dataEpoch;
    let cursor = bootstrap.syncCursor;
    let seqId = 1;
    const mid = (tag: string) => `m_${tag}_${seqId++}`;

    // 1. Create all 11 row entities + update both singletons
    const createMutations: SyncMutation[] = [
      {
        mutationId: mid('settings'),
        entity: 'settings',
        op: 'upsert',
        recordId: 'settings',
        baseVersion: bootstrap.delta.settings!.version,
        clientTimestamp: '2026-05-01T00:01:00.000Z',
        payload: { monthlyDailyBudget: 36000, emergencyTargetMonths: 8, usdTwdRate: 32.1 },
      },
      {
        mutationId: mid('rents'),
        entity: 'utility_rents',
        op: 'upsert',
        recordId: 'utility_rents',
        baseVersion: bootstrap.delta.rentUtilityRents!.version,
        clientTimestamp: '2026-05-01T00:01:01.000Z',
        payload: { rent6F: 18000, rentA: 9000, rentB: 8500, rentC: 8000 },
      },
      {
        mutationId: mid('ledger'),
        entity: 'ledger',
        op: 'upsert',
        recordId: 'led_trip',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:02.000Z',
        payload: { name: '日本旅遊', includeInNetWorth: true, monthlyDailyBudget: 15000, note: 'Tokyo', sortOrder: 2 },
      },
      {
        mutationId: mid('savings'),
        entity: 'asset',
        op: 'upsert',
        recordId: 'ast_sav',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:03.000Z',
        payload: {
          updateMode: '手動快照',
          majorType: '資產',
          subCategory: '活存',
          liquidity: '高流動',
          itemName: '薪轉活存',
          quantityOrAmount: 100000,
          currency: 'TWD',
          isLinkedSavings: true,
          isDefaultSavings: true,
          ledgerId: DEFAULT_LEDGER_ID,
        },
      },
      {
        mutationId: mid('card'),
        entity: 'asset',
        op: 'upsert',
        recordId: 'ast_card',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:04.000Z',
        payload: {
          updateMode: '手動快照',
          majorType: '負債',
          subCategory: '信用卡未繳',
          liquidity: '負債',
          itemName: '玉山卡',
          quantityOrAmount: 0,
          currency: 'TWD',
          isCreditCard: true,
          creditBillingDay: 15,
          creditDueDay: 2,
          creditLimit: 120000,
          ledgerId: DEFAULT_LEDGER_ID,
        },
      },
      {
        mutationId: mid('stock'),
        entity: 'asset',
        op: 'upsert',
        recordId: 'ast_voo',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:05.000Z',
        payload: {
          updateMode: '自動更新',
          majorType: '資產',
          subCategory: '股票',
          liquidity: '中流動',
          itemName: 'VOO',
          ticker: 'VOO',
          quantityOrAmount: 10,
          currency: 'USD',
          unitPrice: 500,
          previousClose: 495,
          ledgerId: DEFAULT_LEDGER_ID,
        },
      },
      {
        mutationId: mid('cf'),
        entity: 'cashflow',
        op: 'upsert',
        recordId: 'cf_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:06.000Z',
        payload: {
          date: '2026-05-01',
          type: '日常花費',
          category: '飲食',
          itemName: '拉麵',
          amount: 320,
          currency: 'TWD',
          linkedAccountId: 'ast_sav',
          ledgerId: DEFAULT_LEDGER_ID,
        },
      },
      {
        mutationId: mid('rec'),
        entity: 'recurring',
        op: 'upsert',
        recordId: 'rec_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:07.000Z',
        payload: {
          itemName: '房租',
          category: '居住',
          type: '固定支出',
          amount: 15000,
          currency: 'TWD',
          cycle: '月繳',
          postDay: 5,
          linkedAccountId: 'ast_sav',
          ledgerId: DEFAULT_LEDGER_ID,
        },
      },
      {
        mutationId: mid('sink'),
        entity: 'sinking',
        op: 'upsert',
        recordId: 'sf_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:08.000Z',
        payload: {
          itemName: '牌照稅',
          category: '稅金',
          totalAmount: 12000,
          months: 12,
          dueNote: '4月',
        },
      },
      {
        mutationId: mid('adj'),
        entity: 'savings_adjustment',
        op: 'upsert',
        recordId: 'adj_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:09.000Z',
        payload: {
          accountId: 'ast_sav',
          date: '2026-05-01',
          amount: 5000,
          currency: 'TWD',
          note: '校正',
        },
      },
      {
        mutationId: mid('stx'),
        entity: 'stock_tx',
        op: 'upsert',
        recordId: 'stx_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:10.000Z',
        payload: {
          assetId: 'ast_voo',
          date: '2026-05-01',
          txType: 'buy',
          shares: 2,
          totalAmount: 1000,
          fee: 1,
        },
      },
      {
        mutationId: mid('util_base'),
        entity: 'utility_record',
        op: 'upsert',
        recordId: '2026-03',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:11.000Z',
        payload: {
          period: '2026-03',
          isBaseline: true,
          curTotal: 1000,
          cur6F: 200,
          curA: 100,
          curB: 100,
          curC: 100,
        },
      },
      {
        mutationId: mid('util_cur'),
        entity: 'utility_record',
        op: 'upsert',
        recordId: '2026-04',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:12.000Z',
        payload: {
          period: '2026-04',
          isBaseline: false,
          curTotal: 1300,
          cur6F: 260,
          totalElec: 1500,
          totalWater: 400,
          curA: 140,
          curB: 130,
          curC: 120,
        },
      },
      {
        mutationId: mid('goal'),
        entity: 'financial_goal',
        op: 'upsert',
        recordId: 'goal_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:13.000Z',
        payload: {
          name: '緊急預備金目標',
          goalType: 'asset_bucket',
          targetAmount: 300000,
          currency: 'TWD',
          linkedAssetIds: ['ast_sav'],
        },
      },
      {
        mutationId: mid('split'),
        entity: 'split_receivable',
        op: 'upsert',
        recordId: 'sp_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:14.000Z',
        payload: {
          ledgerId: DEFAULT_LEDGER_ID,
          splitGroupId: 'grp_1',
          counterparty: 'Alice',
          date: '2026-05-01',
          itemName: '聚餐',
          category: '飲食',
          amount: 600,
          currency: 'TWD',
          sourceAccountId: 'ast_sav',
        },
      },
      {
        mutationId: mid('inst'),
        entity: 'installment_plan',
        op: 'upsert',
        recordId: 'inst_1',
        baseVersion: 0,
        clientTimestamp: '2026-05-01T00:01:15.000Z',
        payload: {
          ledgerId: DEFAULT_LEDGER_ID,
          cardAccountId: 'ast_card',
          itemName: '筆電',
          category: '3C',
          totalAmount: 36000,
          totalInstallments: 12,
          startYm: '2026-05',
          postDay: 10,
          currency: 'TWD',
        },
      },
    ];

    const res1 = await processSyncRequest(
      db,
      uid,
      { mutations: createMutations, sinceSeq: cursor, clientEpoch: epoch },
      { queryBudget: 200 }
    );
    expect(res1.rejected).toEqual([]);
    expect(res1.conflicts).toEqual([]);
    expect(res1.ackedMutationIds).toHaveLength(createMutations.length);
    cursor = res1.syncCursor;

    // 2. Verify server-owned live quotes on auto-updated asset + optimistic lock conflict
    await db
      .prepare("UPDATE asset_items SET unit_price = 525, previous_close = 520, price_updated_at = '2026-05-02T00:00:00.000Z' WHERE user_id = ? AND id = ?")
      .bind(uid, 'ast_voo')
      .run();

    const res2 = await processSyncRequest(
      db,
      uid,
      {
        sinceSeq: cursor,
        clientEpoch: epoch,
        mutations: [
          {
            mutationId: mid('voo_edit'),
            entity: 'asset',
            op: 'upsert',
            recordId: 'ast_voo',
            baseVersion: 1,
            clientTimestamp: '2026-05-02T01:00:00.000Z',
            payload: {
              updateMode: '自動更新',
              majorType: '資產',
              subCategory: '股票',
              liquidity: '中流動',
              itemName: 'VOO ETF',
              ticker: 'VOO',
              quantityOrAmount: 12,
              currency: 'USD',
              unitPrice: 400, // stale client price must NOT overwrite server 525
              previousClose: 390,
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
          {
            mutationId: mid('cf_stale'),
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_1',
            baseVersion: 99, // mismatch -> VersionConflict
            clientTimestamp: '2026-05-02T01:00:01.000Z',
            payload: {
              date: '2026-05-01',
              type: '日常花費',
              category: '飲食',
              itemName: '拉麵加蛋',
              amount: 350,
              currency: 'TWD',
              linkedAccountId: 'ast_sav',
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
        ],
      },
      { queryBudget: 100 }
    );
    expect(res2.ackedMutationIds).toEqual([expect.stringContaining('voo_edit')]);
    expect(res2.conflicts).toHaveLength(1);
    expect(res2.conflicts?.[0].recordId).toBe('cf_1');
    const updatedVoo = res2.delta.assetItems.find((a) => a.id === 'ast_voo');
    expect(updatedVoo?.unitPrice).toBe(525);
    expect(updatedVoo?.previousClose).toBe(520);
    expect(updatedVoo?.quantityOrAmount).toBe(12);
    expect(updatedVoo?.version).toBe(2);
    cursor = res2.syncCursor;

    // 3. Verify special rejection guards (default ledger delete, baseline utility delete, invalid period, missing ref)
    const resGuards = await processSyncRequest(
      db,
      uid,
      {
        sinceSeq: cursor,
        clientEpoch: epoch,
        refsOrdered: true,
        mutations: [
          {
            mutationId: mid('del_main_ledger'),
            entity: 'ledger',
            op: 'delete',
            recordId: DEFAULT_LEDGER_ID,
            baseVersion: 1,
            clientTimestamp: '2026-05-02T02:00:00.000Z',
          },
          {
            mutationId: mid('del_util_base'),
            entity: 'utility_record',
            op: 'delete',
            recordId: '2026-03',
            baseVersion: 1,
            clientTimestamp: '2026-05-02T02:00:01.000Z',
          },
          {
            mutationId: mid('bad_util_period'),
            entity: 'utility_record',
            op: 'upsert',
            recordId: ' 2026-05 ',
            baseVersion: 0,
            clientTimestamp: '2026-05-02T02:00:02.000Z',
            payload: { curTotal: 1500, cur6F: 300, curA: 150, curB: 150, curC: 150 },
          },
          {
            mutationId: mid('dangling_ref'),
            entity: 'installment_plan',
            op: 'upsert',
            recordId: 'inst_bad',
            baseVersion: 0,
            clientTimestamp: '2026-05-02T02:00:03.000Z',
            payload: {
              ledgerId: DEFAULT_LEDGER_ID,
              cardAccountId: 'nonexistent_card',
              itemName: '不存在的卡',
              category: '3C',
              totalAmount: 12000,
              totalInstallments: 6,
              startYm: '2026-05',
              currency: 'TWD',
            },
          },
        ],
      },
      { queryBudget: 100 }
    );
    expect(resGuards.ackedMutationIds).toEqual([]);
    expect(resGuards.rejected).toHaveLength(4);
    expect(resGuards.rejected[0].reason).toContain('不可刪除預設個人主帳本');
    expect(resGuards.rejected[1].reason).toContain('不可刪除起始表底紀錄');
    expect(resGuards.rejected[2].reason).toContain('水電期別鍵值格式不符');
    expect(resGuards.rejected[3].reason).toContain('綁定信用卡');

    // 4. Soft-delete non-baseline utility_record & sinking item, verify delta + export/import roundtrip
    const resDel = await processSyncRequest(
      db,
      uid,
      {
        sinceSeq: cursor,
        clientEpoch: epoch,
        mutations: [
          {
            mutationId: mid('del_util_cur'),
            entity: 'utility_record',
            op: 'delete',
            recordId: '2026-04',
            baseVersion: 1,
            clientTimestamp: '2026-05-02T03:00:00.000Z',
          },
          {
            mutationId: mid('del_sink'),
            entity: 'sinking',
            op: 'delete',
            recordId: 'sf_1',
            baseVersion: 1,
            clientTimestamp: '2026-05-02T03:00:01.000Z',
          },
        ],
      },
      { queryBudget: 100 }
    );
    expect(resDel.ackedMutationIds).toHaveLength(2);
    expect(resDel.delta.rentUtilityRecords.find((r) => r.period === '2026-04')?.deletedAt).toBeTruthy();
    expect(resDel.delta.sinkingItems.find((s) => s.id === 'sf_1')?.deletedAt).toBeTruthy();

    // 5. Full export -> merge import must NOT resurrect soft-deleted sf_1, and replace import round-trips cleanly
    const exported = await exportFullSnapshot(db, uid);
    expect(exported.cashflowLogs).toHaveLength(1);
    expect(exported.recurringItems).toHaveLength(1);
    expect(exported.recurringItems[0].postDay).toBe(5);
    expect(exported.financialGoals).toHaveLength(1);
    expect(exported.splitReceivables).toHaveLength(1);
    expect(exported.installmentPlans).toHaveLength(1);
    expect(exported.sinkingItems).toHaveLength(0); // soft-deleted excluded from export

    // Merge import attempting to write back soft-deleted sf_1 must keep it deleted
    const mergeRes = await importFullSnapshot(
      db,
      uid,
      {
        ...exported,
        sinkingItems: [
          {
            id: 'sf_1',
            itemName: '復活測試',
            category: '稅金',
            totalAmount: 12000,
            months: 12,
            dueNote: '4月',
            status: '啟用',
            note: '',
            sortOrder: 0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-02T04:00:00.000Z',
            version: 1,
          },
        ],
      },
      'merge'
    );
    expect(mergeRes.importedSinking).toBe(0);

    // Replace import into fresh user preserves every entity cleanly
    const uid2 = 'u-registry-clone';
    await seedUser(db, uid2);
    const replaceRes = await importFullSnapshot(db, uid2, exported, 'replace');
    expect(replaceRes.importedLogs).toBe(1);
    expect(replaceRes.importedRecurring).toBe(1);
    expect(replaceRes.importedAssets).toBe(3);

    const cloned = await exportFullSnapshot(db, uid2);
    expect(cloned.ledgers?.some((l) => l.id === 'led_trip')).toBe(true);
    expect(cloned.cashflowLogs[0].itemName).toBe('拉麵');
    expect(cloned.recurringItems[0].postDay).toBe(5);
    expect(cloned.assetItems.find((a) => a.id === 'ast_card')?.isCreditCard).toBe(true);
    expect(cloned.financialGoals?.[0].name).toBe('緊急預備金目標');
    expect(cloned.splitReceivables?.[0].counterparty).toBe('Alice');
    expect(cloned.installmentPlans?.[0].itemName).toBe('筆電');
    expect(cloned.rentUtilityRecords).toHaveLength(1);
    expect(cloned.rentUtilityRents?.rent6F).toBe(18000);
  });
});
