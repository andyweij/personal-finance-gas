import type { SyncDelta, SyncEntity } from '../shared/types';

export const NEXT_SEQ_SQL = 'COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0) + 1';
export const CURR_SEQ_SQL = 'COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0)';
export const EPOCH_GUARD_SQL = 'COALESCE((SELECT data_epoch FROM user_sync_state WHERE user_id = ?), 1) = ?';

export interface SyncEntityMeta {
  entity: SyncEntity;
  table: string;
  kind: 'row' | 'singleton';
  keyColumn: 'id' | 'period' | 'user_id';
  deltaField: keyof SyncDelta;
  orderBy: string;
  liveOnlyWhenFull: boolean;
  /** True for post-0020 tables that may be absent on a not-yet-migrated D1 database. */
  optionalTable?: boolean;
  /** User-facing error when a write/import targets an optionalTable missing in D1. */
  missingTableError?: string;
  /** Include in processSyncRequest row prefetch batch (true for all standard row entities except period-keyed). */
  prefetchable?: boolean;
}

/**
 * Single source of truth for every synced D1 entity.
 * `ALLOWED_SYNC_ENTITIES`, `ENTITY_ROW_TABLE`, optional-table detection, and delta queries
 * are all derived from this list so entity additions cannot drift across sync paths.
 */
export const SYNC_ENTITY_METAS: readonly SyncEntityMeta[] = [
  {
    entity: 'settings',
    table: 'app_settings',
    kind: 'singleton',
    keyColumn: 'user_id',
    deltaField: 'settings',
    orderBy: '',
    liveOnlyWhenFull: false,
  },
  {
    entity: 'utility_rents',
    table: 'rent_utility_settings',
    kind: 'singleton',
    keyColumn: 'user_id',
    deltaField: 'rentUtilityRents',
    orderBy: '',
    liveOnlyWhenFull: false,
  },
  {
    entity: 'ledger',
    table: 'ledgers',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'ledgers',
    orderBy: 'sort_order ASC, created_at ASC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'cashflow',
    table: 'cashflow_logs',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'cashflowLogs',
    orderBy: 'date DESC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'recurring',
    table: 'recurring_items',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'recurringItems',
    orderBy: 'sort_order ASC, created_at ASC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'sinking',
    table: 'sinking_fund_items',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'sinkingItems',
    orderBy: 'sort_order ASC, created_at ASC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'asset',
    table: 'asset_items',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'assetItems',
    orderBy: 'sort_order ASC, created_at ASC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'savings_adjustment',
    table: 'savings_adjustments',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'savingsAdjustments',
    orderBy: 'date DESC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'stock_tx',
    table: 'stock_transactions',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'stockTransactions',
    orderBy: 'date DESC',
    liveOnlyWhenFull: true,
    prefetchable: true,
  },
  {
    entity: 'utility_record',
    table: 'rent_utility_records',
    kind: 'row',
    keyColumn: 'period',
    deltaField: 'rentUtilityRecords',
    orderBy: '',
    liveOnlyWhenFull: true,
    prefetchable: false,
  },
  {
    entity: 'financial_goal',
    table: 'financial_goals',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'financialGoals',
    orderBy: 'sort_order ASC, created_at ASC',
    liveOnlyWhenFull: true,
    optionalTable: true,
    missingTableError:
      '伺服器資料庫尚未完成升級（缺少財務目標資料表），請先執行資料庫遷移後再重試。',
    prefetchable: true,
  },
  {
    entity: 'split_receivable',
    table: 'split_receivables',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'splitReceivables',
    orderBy: 'date DESC, created_at DESC',
    liveOnlyWhenFull: true,
    optionalTable: true,
    missingTableError:
      '伺服器資料庫尚未完成升級（缺少代墊／拆帳資料表），請先執行 0023 資料庫遷移後再重試。',
    prefetchable: true,
  },
  {
    entity: 'installment_plan',
    table: 'installment_plans',
    kind: 'row',
    keyColumn: 'id',
    deltaField: 'installmentPlans',
    orderBy: 'start_ym DESC, created_at DESC',
    liveOnlyWhenFull: true,
    optionalTable: true,
    missingTableError:
      '伺服器資料庫尚未完成升級（缺少分期付款資料表），請先執行 0024 資料庫遷移後再重試。',
    prefetchable: true,
  },
] as const;

export const SYNC_ENTITY_BY_NAME: Readonly<Record<SyncEntity, SyncEntityMeta>> = Object.fromEntries(
  SYNC_ENTITY_METAS.map((m) => [m.entity, m])
) as Readonly<Record<SyncEntity, SyncEntityMeta>>;

export const ALLOWED_SYNC_ENTITIES: ReadonlySet<string> = new Set(
  SYNC_ENTITY_METAS.map((m) => m.entity)
);

export const ENTITY_ROW_TABLE: Readonly<Record<string, { table: string; keyColumn: 'id' | 'period' }>> =
  Object.fromEntries(
    SYNC_ENTITY_METAS.filter((m) => m.kind === 'row' && m.prefetchable).map((m) => [
      m.entity,
      { table: m.table, keyColumn: m.keyColumn as 'id' | 'period' },
    ])
  );

export const OPTIONAL_SYNC_METAS: readonly SyncEntityMeta[] = SYNC_ENTITY_METAS.filter(
  (m) => m.optionalTable
);

export const OPTIONAL_SYNC_TABLES: readonly string[] = OPTIONAL_SYNC_METAS.map((m) => m.table);

export function isMissingOptionalTableError(err: unknown, tableName?: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (tableName) {
    return new RegExp(`no such table:\\s*${tableName}\\b`, 'i').test(msg);
  }
  const pattern = OPTIONAL_SYNC_TABLES.join('|');
  return new RegExp(`no such table:\\s*(${pattern})\\b`, 'i').test(msg);
}

/* ==================== Declarative SQL Statement Builders ==================== */

export interface ColumnAssignment {
  col: string;
  /** Used for both UPDATE and INSERT unless overridden by updateValue/insertValue. */
  value?: unknown;
  updateValue?: unknown;
  insertValue?: unknown;
  /** If true, column is included in UPDATE SET but omitted from INSERT column list. */
  updateOnly?: boolean;
}

export interface BuiltSql {
  sql: string;
  binds: unknown[];
}

export function buildSoftDeleteSql(params: {
  table: string;
  keyColumn: 'id' | 'period';
  uid: string;
  recordId: string;
  writeTs: string;
  nextVersion: number;
  expectedVersion: number;
  expectedEpoch: number;
  extraGuardSql?: string;
  extraGuardBinds?: unknown[];
}): BuiltSql {
  const extraSql = params.extraGuardSql || '';
  const extraBinds = params.extraGuardBinds || [];
  return {
    sql: `UPDATE ${params.table} SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND ${params.keyColumn} = ? AND version = ? AND ${EPOCH_GUARD_SQL}${extraSql}`,
    binds: [
      params.writeTs,
      params.writeTs,
      params.nextVersion,
      params.uid,
      params.uid,
      params.recordId,
      params.expectedVersion,
      params.uid,
      params.expectedEpoch,
      ...extraBinds,
    ],
  };
}

export function buildRowUpsertSql(params: {
  table: string;
  keyColumn: 'id' | 'period';
  isUpdate: boolean;
  uid: string;
  recordId: string;
  columns: readonly ColumnAssignment[];
  createdAt: string;
  writeTs: string;
  nextVersion: number;
  expectedVersion?: number;
  expectedEpoch: number;
  guardSql?: string;
  guardBinds?: unknown[];
}): BuiltSql {
  const guardSql = params.guardSql || '';
  const guardBinds = params.guardBinds || [];

  if (params.isUpdate) {
    const setParts = params.columns.map((c) => `${c.col} = ?`);
    const colVals = params.columns.map((c) => ('updateValue' in c ? c.updateValue : c.value));
    return {
      sql: `UPDATE ${params.table}
 SET ${setParts.join(', ')}, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
 WHERE user_id = ? AND ${params.keyColumn} = ? AND version = ? AND ${EPOCH_GUARD_SQL}${guardSql}`,
      binds: [
        ...colVals,
        params.writeTs,
        params.nextVersion,
        params.uid,
        params.uid,
        params.recordId,
        Number(params.expectedVersion ?? 1),
        params.uid,
        params.expectedEpoch,
        ...guardBinds,
      ],
    };
  }

  const insertCols = params.columns.filter((c) => !c.updateOnly);
  const colNames = [
    'user_id',
    params.keyColumn,
    ...insertCols.map((c) => c.col),
    'created_at',
    'updated_at',
    'deleted_at',
    'version',
    'change_seq',
  ];
  const valuePlaceholders = [
    '?',
    '?',
    ...insertCols.map(() => '?'),
    '?',
    '?',
    'NULL',
    '?',
    NEXT_SEQ_SQL,
  ];
  const colVals = insertCols.map((c) => ('insertValue' in c ? c.insertValue : c.value));

  return {
    sql: `INSERT INTO ${params.table}
 (${colNames.join(', ')})
 SELECT ${valuePlaceholders.join(', ')}
 WHERE ${EPOCH_GUARD_SQL}${guardSql}
 ON CONFLICT(user_id, ${params.keyColumn}) DO NOTHING`,
    binds: [
      params.uid,
      params.recordId,
      ...colVals,
      params.createdAt,
      params.writeTs,
      params.nextVersion,
      params.uid,
      params.uid,
      params.expectedEpoch,
      ...guardBinds,
    ],
  };
}

export type DeltaQueryMode =
  | { kind: 'seq'; sinceSeq: number; maxSeq?: number }
  | { kind: 'since'; since: string }
  | { kind: 'full' };

export function buildDeltaSelectSql(params: {
  table: string;
  orderBy: string;
  liveOnlyWhenFull: boolean;
  uid: string;
  mode: DeltaQueryMode;
}): BuiltSql {
  const orderSql = params.orderBy ? ` ORDER BY ${params.orderBy}` : '';
  if (params.mode.kind === 'seq') {
    const hasMax = typeof params.mode.maxSeq === 'number';
    const upperSql = hasMax ? '?' : '(SELECT change_seq FROM user_sync_state WHERE user_id = ?)';
    const upperBind = hasMax ? params.mode.maxSeq : params.uid;
    return {
      sql: `SELECT * FROM ${params.table} WHERE user_id = ? AND change_seq > ? AND change_seq <= ${upperSql}${orderSql}`,
      binds: [params.uid, params.mode.sinceSeq, upperBind],
    };
  }
  if (params.mode.kind === 'since') {
    return {
      sql: `SELECT * FROM ${params.table} WHERE user_id = ? AND updated_at > ?${orderSql}`,
      binds: [params.uid, params.mode.since],
    };
  }
  const liveClause = params.liveOnlyWhenFull ? ' AND deleted_at IS NULL' : '';
  return {
    sql: `SELECT * FROM ${params.table} WHERE user_id = ?${liveClause}${orderSql}`,
    binds: [params.uid],
  };
}

/**
 * Generates an atomic `INSERT ... SELECT ... FROM json_each(?) ON CONFLICT DO UPDATE`
 * statement template for bulk JSON backup imports, guaranteeing exact alignment between
 * column names, JSON tuple indices, and ON CONFLICT update assignments.
 */
export function buildChunkedImportSql(params: {
  table: string;
  keyColumn: 'id' | 'period';
  /** Column names corresponding 1:1 to JSON array positions 0..N-1 (starts with keyColumn, includes created_at/updated_at). */
  jsonColumns: readonly string[];
  /** Columns excluded from ON CONFLICT DO UPDATE (defaults to [keyColumn, 'created_at']). */
  immutableColumns?: readonly string[];
}): string {
  const immutable = new Set(params.immutableColumns ?? [params.keyColumn, 'created_at']);
  const insertCols = ['user_id', ...params.jsonColumns, 'deleted_at', 'version', 'change_seq'];
  const selectExprs = params.jsonColumns.map((_, i) => `json_extract(value, '$[${i}]')`);
  const updateCols = params.jsonColumns.filter((c) => !immutable.has(c));
  const updateAssignments = [
    ...updateCols.map((c) => `${c} = excluded.${c}`),
    `version = ${params.table}.version + 1`,
    `change_seq = excluded.change_seq`,
  ];

  return `INSERT INTO ${params.table} (${insertCols.join(', ')}) SELECT ?, ${selectExprs.join(', ')}, NULL, 1, ${CURR_SEQ_SQL} FROM json_each(?) WHERE true ON CONFLICT(user_id, ${params.keyColumn}) DO UPDATE SET ${updateAssignments.join(', ')} WHERE ${params.table}.deleted_at IS NULL`;
}
