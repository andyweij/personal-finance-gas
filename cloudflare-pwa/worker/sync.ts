import {
  DEFAULT_EMERGENCY_MONTHS,
  DEFAULT_LEDGER_ID,
  DEFAULT_LEDGER_NAME,
  DEFAULT_MONTHLY_DAILY_BUDGET,
  DEFAULT_PNL_COLOR_SCHEME,
  DEFAULT_USD_TWD_RATE,
} from '../shared/constants';
import type {
  AppSettings,
  AssetItem,
  CashFlowLog,
  FinanceSnapshot,
  Ledger,
  NetWorthHistory,
  RecurringItem,
  RentUtilityRecord,
  RentUtilityRents,
  SavingsAdjustment,
  SinkingFundItem,
  StockTransaction,
  SyncConflict,
  SyncDelta,
  SyncMutation,
  SyncRequest,
  SyncResponse,
} from '../shared/types';
import {
  DEFAULT_UTILITY_RENTS,
  validateUtilityRecordInput,
  validateUtilityRentsInput,
} from '../shared/rentUtility';
import {
  normalizeCustomStockCategories,
  normalizeLedgerId,
  normalizePnlColorScheme,
  normalizeSortOrder,
  normalizeStockCategory,
  toSafeNumber,
  validateAssetInput,
  validateCashFlowInput,
  validateLedgerInput,
  validateRecurringInput,
  validateSavingsAdjustmentInput,
  validateSinkingInput,
  validateStockTransactionInput,
} from '../shared/validation';

export function assertUserId(userId: string): string {
  const cleaned = String(userId || '').trim();
  if (!cleaned) {
    throw new Error('缺少租戶身分識別（userId），拒絕存取資料。');
  }
  return cleaned;
}

export async function ensureUserSyncState(
  db: D1Database,
  userId: string
): Promise<{ changeSeq: number; dataEpoch: number }> {
  const uid = assertUserId(userId);
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at)
       VALUES (?, 0, 1, ?)`
    )
    .bind(uid, nowIso)
    .run();
  const row = await db
    .prepare('SELECT change_seq, data_epoch FROM user_sync_state WHERE user_id = ?')
    .bind(uid)
    .first<{ change_seq: number; data_epoch: number }>();
  return {
    changeSeq: Number(row?.change_seq ?? 0),
    dataEpoch: Number(row?.data_epoch ?? 1),
  };
}

export async function ensureAppSettings(db: D1Database, userId: string): Promise<AppSettings> {
  const uid = assertUserId(userId);
  const row = await db
    .prepare('SELECT * FROM app_settings WHERE user_id = ?')
    .bind(uid)
    .first<{
      monthly_daily_budget: number;
      emergency_target_months: number;
      usd_twd_rate: number;
      auto_fx_enabled?: number | null;
      fx_updated_at: string | null;
      pnl_color_scheme?: string | null;
      custom_stock_categories?: string | null;
      updated_at: string;
      version?: number;
    }>();

  if (row) {
    return {
      monthlyDailyBudget: row.monthly_daily_budget,
      emergencyTargetMonths: row.emergency_target_months,
      usdTwdRate: row.usd_twd_rate,
      autoFxEnabled: row.auto_fx_enabled !== undefined && row.auto_fx_enabled !== null ? Number(row.auto_fx_enabled) !== 0 : true,
      fxUpdatedAt: row.fx_updated_at,
      pnlColorScheme: normalizePnlColorScheme(row.pnl_color_scheme),
      customStockCategories: normalizeCustomStockCategories(row.custom_stock_categories),
      updatedAt: row.updated_at,
      version: Number(row.version ?? 1),
    };
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO app_settings (user_id, monthly_daily_budget, emergency_target_months, usd_twd_rate, auto_fx_enabled, pnl_color_scheme, custom_stock_categories, updated_at, version)
       VALUES (?, ?, ?, ?, 1, ?, '[]', ?, 1)`
    )
    .bind(
      uid,
      DEFAULT_MONTHLY_DAILY_BUDGET,
      DEFAULT_EMERGENCY_MONTHS,
      DEFAULT_USD_TWD_RATE,
      DEFAULT_PNL_COLOR_SCHEME,
      nowIso
    )
    .run();

  return {
    monthlyDailyBudget: DEFAULT_MONTHLY_DAILY_BUDGET,
    emergencyTargetMonths: DEFAULT_EMERGENCY_MONTHS,
    usdTwdRate: DEFAULT_USD_TWD_RATE,
    autoFxEnabled: true,
    fxUpdatedAt: null,
    pnlColorScheme: DEFAULT_PNL_COLOR_SCHEME,
    customStockCategories: [],
    updatedAt: nowIso,
    version: 1,
  };
}

export async function ensureDefaultLedger(db: D1Database, userId: string): Promise<void> {
  const uid = assertUserId(userId);
  const existing = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ? AND id = ?')
    .bind(uid, DEFAULT_LEDGER_ID)
    .first();
  if (existing) return;
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO ledgers
        (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version)
       VALUES (?, ?, ?, 1, NULL, ?, 1, ?, ?, NULL, 1)`
    )
    .bind(
      uid,
      DEFAULT_LEDGER_ID,
      DEFAULT_LEDGER_NAME,
      '預設個人帳本（納入總資產與淨值統計）',
      nowIso,
      nowIso
    )
    .run();
}

function mapLedgerRow(r: Record<string, unknown>): Ledger {
  return {
    id: String(r.id),
    name: String(r.name || DEFAULT_LEDGER_NAME),
    includeInNetWorth: Number(r.include_in_net_worth ?? 1) === 1,
    monthlyDailyBudget:
      r.monthly_daily_budget !== null && r.monthly_daily_budget !== undefined
        ? Number(r.monthly_daily_budget)
        : null,
    note: String(r.note || ''),
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapCashFlowRow(r: Record<string, unknown>): CashFlowLog {
  return {
    id: String(r.id),
    date: String(r.date),
    yearMonth: String(r.year_month),
    type: String(r.type),
    category: String(r.category),
    itemName: String(r.item_name),
    amount: Number(r.amount),
    currency: String(r.currency),
    fxRate: Number(r.fx_rate),
    twdAmount: Number(r.twd_amount),
    source: String(r.source),
    note: String(r.note || ''),
    recurringDedupKey: r.recurring_dedup_key ? String(r.recurring_dedup_key) : null,
    linkedAccountId: r.linked_account_id ? String(r.linked_account_id) : null,
    ledgerId: normalizeLedgerId(r.ledger_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapRecurringRow(r: Record<string, unknown>): RecurringItem {
  return {
    id: String(r.id),
    itemName: String(r.item_name),
    category: String(r.category),
    type: String(r.type),
    amount: Number(r.amount),
    currency: String(r.currency),
    cycle: String(r.cycle),
    billingSpec: String(r.billing_spec || ''),
    status: String(r.status),
    note: String(r.note || ''),
    linkedAccountId: r.linked_account_id ? String(r.linked_account_id) : null,
    ledgerId: normalizeLedgerId(r.ledger_id),
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapSinkingRow(r: Record<string, unknown>): SinkingFundItem {
  return {
    id: String(r.id),
    itemName: String(r.item_name),
    category: String(r.category),
    totalAmount: Number(r.total_amount),
    months: Number(r.months),
    dueNote: String(r.due_note || ''),
    status: String(r.status),
    note: String(r.note || ''),
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapAssetRow(r: Record<string, unknown>): AssetItem {
  return {
    id: String(r.id),
    updateMode: String(r.update_mode),
    majorType: String(r.major_type),
    subCategory: String(r.sub_category),
    liquidity: String(r.liquidity),
    itemName: String(r.item_name),
    ticker: String(r.ticker || ''),
    quantityOrAmount: Number(r.quantity_or_amount),
    currency: String(r.currency),
    unitPrice: Number(r.unit_price),
    previousClose:
      r.previous_close !== null && r.previous_close !== undefined ? Number(r.previous_close) : null,
    costBasis: r.cost_basis !== null && r.cost_basis !== undefined ? Number(r.cost_basis) : null,
    priceUpdatedAt: r.price_updated_at ? String(r.price_updated_at) : null,
    note: String(r.note || ''),
    isLinkedSavings: Number(r.is_linked_savings || 0) === 1,
    balanceAnchorDate: r.balance_anchor_date ? String(r.balance_anchor_date) : null,
    balanceAnchorAt: r.balance_anchor_at ? String(r.balance_anchor_at) : null,
    isDefaultSavings: Number(r.is_default_savings || 0) === 1,
    isAmortizingLoan: Number(r.is_amortizing_loan || 0) === 1,
    loanAnnualRate:
      r.loan_annual_rate !== null && r.loan_annual_rate !== undefined ? Number(r.loan_annual_rate) : null,
    loanMonthlyPayment:
      r.loan_monthly_payment !== null && r.loan_monthly_payment !== undefined
        ? Number(r.loan_monthly_payment)
        : null,
    loanBillingDay:
      r.loan_billing_day !== null && r.loan_billing_day !== undefined ? Number(r.loan_billing_day) : null,
    stockCategory: String(r.stock_category || ''),
    isWatchlist: Number(r.is_watchlist || 0) === 1,
    ledgerId: normalizeLedgerId(r.ledger_id),
    excludeFromNetWorth: Number(r.exclude_from_net_worth || 0) === 1,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapSavingsAdjustmentRow(r: Record<string, unknown>): SavingsAdjustment {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    date: String(r.date),
    amount: Number(r.amount),
    twdAmount: Number(r.twd_amount),
    note: String(r.note || ''),
    transferGroupId: r.transfer_group_id ? String(r.transfer_group_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapStockTransactionRow(r: Record<string, unknown>): StockTransaction {
  return {
    id: String(r.id),
    assetId: String(r.asset_id),
    date: String(r.date),
    txType: String(r.tx_type) as StockTransaction['txType'],
    shares: Number(r.shares || 0),
    totalAmount: Number(r.total_amount || 0),
    fee: Number(r.fee || 0),
    linkedCashflowId: r.linked_cashflow_id ? String(r.linked_cashflow_id) : null,
    note: String(r.note || ''),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapNetWorthRow(r: Record<string, unknown>): NetWorthHistory {
  return {
    yearMonth: String(r.year_month),
    snapshotDate: String(r.snapshot_date),
    totalAssets: Number(r.total_assets),
    totalLiabilities: Number(r.total_liabilities),
    netWorth: Number(r.net_worth),
    highLiquidityAssets: Number(r.high_liquidity_assets),
    investmentAssets: Number(r.investment_assets),
    insuranceAssets: Number(r.insurance_assets),
    monthlyIncome: Number(r.monthly_income),
    monthlyConsumption: Number(r.monthly_consumption),
    savingsRate: Number(r.savings_rate),
    note: String(r.note || ''),
    updatedAt: String(r.updated_at),
  };
}

export async function ensureRentUtilitySettings(
  db: D1Database,
  userId: string
): Promise<RentUtilityRents> {
  const uid = assertUserId(userId);
  const row = await db
    .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
    .bind(uid)
    .first<{
      rent_6f: number;
      rent_a: number;
      rent_b: number;
      rent_c: number;
      updated_at: string;
      version?: number;
    }>();

  if (row) {
    return {
      rent6F: Number(row.rent_6f || 0),
      rentA: Number(row.rent_a || 0),
      rentB: Number(row.rent_b || 0),
      rentC: Number(row.rent_c || 0),
      updatedAt: String(row.updated_at || ''),
      version: Number(row.version ?? 1),
    };
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version)
       VALUES (?, 0, 0, 0, 0, ?, 1)`
    )
    .bind(uid, nowIso)
    .run();

  return { ...DEFAULT_UTILITY_RENTS, updatedAt: nowIso, version: 1 };
}

function mapUtilityRecordRow(r: Record<string, unknown>): RentUtilityRecord {
  return {
    period: String(r.period),
    isBaseline: Number(r.is_baseline) === 1,
    curTotal: Number(r.cur_total),
    cur6F: Number(r.cur_6f),
    totalElec: Number(r.total_elec),
    totalWater: Number(r.total_water),
    f6People: Number(r.f6_people),
    f5People: Number(r.f5_people),
    curA: Number(r.cur_a),
    curB: Number(r.cur_b),
    curC: Number(r.cur_c),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function isNewerOrEqual(incomingTs: string, existingTs: string | null | undefined): boolean {
  if (!existingTs) return true;
  return incomingTs >= existingTs;
}

class VersionConflictError extends Error {
  constructor(public readonly conflict: SyncConflict) {
    super(`Version conflict on ${conflict.entity}:${conflict.recordId}`);
  }
}

class RejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectError';
  }
}

function runValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RejectError) throw err;
    throw new RejectError(err instanceof Error ? err.message : '資料驗證失敗');
  }
}

const NEXT_SEQ_SQL = 'COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0) + 1';
const CURR_SEQ_SQL = 'COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0)';

function checkVersionOrThrow(
  mutation: SyncMutation,
  existingRow: Record<string, unknown> | null,
  existingMapped: Record<string, unknown> | null,
  serverTime: string,
  legacyCompareTs?: string | null
): { shouldApply: boolean; nextVersion: number; writeTs: string; legacyClientTs?: string } {
  const clientTs = mutation.clientTimestamp || serverTime;
  // Always persist serverTime as updated_at to eliminate clock-skew issues
  const writeTs = serverTime;

  if (!existingRow) {
    return {
      shouldApply: true,
      nextVersion: 1,
      writeTs,
      ...(mutation.baseVersion === undefined ? { legacyClientTs: clientTs } : {}),
    };
  }

  const serverVersion = Number(existingRow.version ?? 1);
  const existingUpdatedAt = existingRow.updated_at ? String(existingRow.updated_at) : null;
  const existingDeleted = Boolean(existingRow.deleted_at);

  if (mutation.baseVersion !== undefined) {
    if (mutation.baseVersion === null) {
      if (!existingDeleted && mutation.op === 'upsert') {
        throw new VersionConflictError({
          mutationId: mutation.mutationId,
          entity: mutation.entity,
          op: mutation.op,
          recordId: mutation.recordId,
          baseVersion: 0,
          serverVersion,
          clientPayload: mutation.payload,
          serverRecord: existingMapped,
          detectedAt: serverTime,
        });
      }
      return { shouldApply: true, nextVersion: serverVersion + 1, writeTs };
    }

    if (mutation.baseVersion !== serverVersion) {
      throw new VersionConflictError({
        mutationId: mutation.mutationId,
        entity: mutation.entity,
        op: mutation.op,
        recordId: mutation.recordId,
        baseVersion: mutation.baseVersion,
        serverVersion,
        clientPayload: mutation.payload,
        serverRecord: existingMapped,
        detectedAt: serverTime,
      });
    }
    return { shouldApply: true, nextVersion: serverVersion + 1, writeTs };
  }

  // Legacy client without baseVersion -> LWW fallback using stored legacy client timestamp if present
  const compareTs = legacyCompareTs ?? existingUpdatedAt;
  if (!isNewerOrEqual(clientTs, compareTs)) {
    return { shouldApply: false, nextVersion: serverVersion, writeTs };
  }
  return { shouldApply: true, nextVersion: serverVersion + 1, writeTs, legacyClientTs: clientTs };
}

const ALLOWED_SYNC_ENTITIES = new Set<string>([
  'settings',
  'ledger',
  'cashflow',
  'recurring',
  'sinking',
  'asset',
  'savings_adjustment',
  'stock_tx',
  'utility_record',
  'utility_rents',
]);

const ALLOWED_SYNC_OPS = new Set<string>(['upsert', 'delete']);

async function recordIdempotencyOnly(
  db: D1Database,
  uid: string,
  mutationId: string,
  serverTime: string
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO sync_idempotency (user_id, mutation_id, applied_at) VALUES (?, ?, ?)')
    .bind(uid, mutationId, serverTime)
    .run();
}

async function commitAtomicMutation(
  db: D1Database,
  uid: string,
  mutation: SyncMutation,
  serverTime: string,
  primaryWriteStmt: D1PreparedStatement,
  postStatements: D1PreparedStatement[],
  refetchCurrent: () => Promise<{ row: Record<string, unknown> | null; mapped: Record<string, unknown> | null }>,
  legacyClientTs?: string,
  onZeroChanges?: () => Promise<void>
): Promise<void> {
  const idempStmt = db
    .prepare(
      'INSERT INTO sync_idempotency (user_id, mutation_id, applied_at) SELECT ?, ?, ? WHERE changes() > 0'
    )
    .bind(uid, mutation.mutationId, serverTime);

  const bumpSeqStmt = db
    .prepare(
      'UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0'
    )
    .bind(serverTime, uid);

  const extraStmts: D1PreparedStatement[] = [];
  if (legacyClientTs) {
    extraStmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO sync_lww_timestamps (user_id, entity, record_id, client_ts)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?)`
        )
        .bind(uid, mutation.entity, mutation.recordId, legacyClientTs, uid, mutation.mutationId)
    );
  }

  const batchStmts = [primaryWriteStmt, idempStmt, bumpSeqStmt, ...extraStmts, ...postStatements];
  try {
    const results = await db.batch(batchStmts);
    const changed = Number(results[0]?.meta?.changes ?? 0);
    if (changed !== 1) {
      // S1: Check if an identical concurrent retry already succeeded and recorded idempotency
      const already = await db
        .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
        .bind(uid, mutation.mutationId)
        .first();
      if (already) return;

      if (onZeroChanges) {
        await onZeroChanges();
      }

      const latest = await refetchCurrent();
      const serverVersion = Number(latest.row?.version ?? 1);
      throw new VersionConflictError({
        mutationId: mutation.mutationId,
        entity: mutation.entity,
        op: mutation.op,
        recordId: mutation.recordId,
        baseVersion: mutation.baseVersion ?? 0,
        serverVersion,
        clientPayload: mutation.payload,
        serverRecord: latest.mapped,
        detectedAt: serverTime,
      });
    }
  } catch (err) {
    if (err instanceof VersionConflictError || err instanceof RejectError) throw err;
    const already = await db
      .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
      .bind(uid, mutation.mutationId)
      .first();
    if (already) return;
    throw err;
  }
}

async function applySingleMutation(
  db: D1Database,
  userId: string,
  mutation: SyncMutation,
  defaultFxRate: number,
  serverTime: string
): Promise<void> {
  const uid = assertUserId(userId);
  let legacyCompareTs: string | null = null;
  if (mutation.baseVersion === undefined) {
    const lwwRow = await db
      .prepare('SELECT client_ts FROM sync_lww_timestamps WHERE user_id = ? AND entity = ? AND record_id = ?')
      .bind(uid, mutation.entity, mutation.recordId)
      .first<{ client_ts: string }>();
    legacyCompareTs = lwwRow?.client_ts ?? null;
  }

  if (mutation.entity === 'settings') {
    if (mutation.op !== 'upsert') {
      throw new RejectError('不支援刪除系統設定。');
    }
    const p = mutation.payload || {};
    const existing = await ensureAppSettings(db, uid);
    const existingRow = await db
      .prepare('SELECT * FROM app_settings WHERE user_id = ?')
      .bind(uid)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existingRow,
      existing as unknown as Record<string, unknown>,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }
    const expectedVersion = Number(existingRow?.version ?? 1);
    const budget = Math.max(0, Math.round(toSafeNumber(p.monthlyDailyBudget, existing.monthlyDailyBudget)));
    const months = Math.min(60, Math.max(1, Math.round(toSafeNumber(p.emergencyTargetMonths, existing.emergencyTargetMonths))));
    const fx = toSafeNumber(p.usdTwdRate, existing.usdTwdRate);
    const validFx = fx > 10 && fx < 100 ? fx : existing.usdTwdRate;
    const autoFxEnabled =
      p.autoFxEnabled !== undefined
        ? Boolean(p.autoFxEnabled)
        : existing.autoFxEnabled !== undefined
          ? existing.autoFxEnabled
          : true;
    const pnlScheme =
      p.pnlColorScheme !== undefined
        ? normalizePnlColorScheme(p.pnlColorScheme)
        : existing.pnlColorScheme || DEFAULT_PNL_COLOR_SCHEME;
    const customStockCats =
      p.customStockCategories !== undefined
        ? normalizeCustomStockCategories(p.customStockCategories)
        : existing.customStockCategories || [];
    const writeStmt = db
      .prepare(
        `UPDATE app_settings
         SET monthly_daily_budget = ?, emergency_target_months = ?, usd_twd_rate = ?, auto_fx_enabled = ?, pnl_color_scheme = ?, custom_stock_categories = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL}
         WHERE user_id = ? AND version = ?`
      )
      .bind(
        budget,
        months,
        validFx,
        autoFxEnabled ? 1 : 0,
        pnlScheme,
        JSON.stringify(customStockCats),
        check.writeTs,
        check.nextVersion,
        uid,
        uid,
        expectedVersion
      );
    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], async () => {
      const row = await db
        .prepare('SELECT * FROM app_settings WHERE user_id = ?')
        .bind(uid)
        .first<Record<string, unknown>>();
      const mapped = await ensureAppSettings(db, uid);
      return {
        row,
        mapped: mapped as unknown as Record<string, unknown>,
      };
    }, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'ledger') {
    await ensureDefaultLedger(db, uid);
    const existing = await db
      .prepare('SELECT * FROM ledgers WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapLedgerRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchLedger = async () => {
      const row = await db
        .prepare('SELECT * FROM ledgers WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return { row, mapped: row ? (mapLedgerRow(row) as unknown as Record<string, unknown>) : null };
    };

    if (mutation.op === 'delete') {
      if (mutation.recordId === DEFAULT_LEDGER_ID) {
        throw new RejectError('不可刪除預設個人主帳本。');
      }
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const countLinkedRecords = async () => {
        const [cfCnt, asCnt, recCnt] = await Promise.all([
          db
            .prepare('SELECT COUNT(*) AS cnt FROM cashflow_logs WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL')
            .bind(uid, mutation.recordId)
            .first<{ cnt: number }>(),
          db
            .prepare('SELECT COUNT(*) AS cnt FROM asset_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL')
            .bind(uid, mutation.recordId)
            .first<{ cnt: number }>(),
          db
            .prepare('SELECT COUNT(*) AS cnt FROM recurring_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL')
            .bind(uid, mutation.recordId)
            .first<{ cnt: number }>(),
        ]);
        return Number(cfCnt?.cnt || 0) + Number(asCnt?.cnt || 0) + Number(recCnt?.cnt || 0);
      };
      const remaining = await countLinkedRecords();
      if (remaining > 0) {
        throw new RejectError(`此帳本仍有 ${remaining} 筆關聯紀錄，請先轉移至其他帳本或刪除紀錄後再移除帳本。`);
      }
      const expectedVersion = Number(existing.version ?? 1);
      const delStmt = db
        .prepare(
          `UPDATE ledgers
           SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL}
           WHERE user_id = ? AND id = ? AND version = ?
             AND NOT EXISTS (SELECT 1 FROM cashflow_logs WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM asset_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM recurring_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL)`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          expectedVersion,
          uid,
          mutation.recordId,
          uid,
          mutation.recordId,
          uid,
          mutation.recordId
        );
      await commitAtomicMutation(
        db,
        uid,
        mutation,
        serverTime,
        delStmt,
        [],
        refetchLedger,
        check.legacyClientTs,
        async () => {
          const concurrentRemaining = await countLinkedRecords();
          if (concurrentRemaining > 0) {
            throw new RejectError(
              `此帳本仍有 ${concurrentRemaining} 筆關聯紀錄，請先轉移至其他帳本或刪除紀錄後再移除帳本。`
            );
          }
        }
      );
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateLedgerInput({
      name: String(p.name || ''),
      includeInNetWorth:
        mutation.recordId === DEFAULT_LEDGER_ID
          ? true
          : p.includeInNetWorth !== undefined
            ? Boolean(p.includeInNetWorth)
            : existing
              ? Number(existing.include_in_net_worth ?? 1) === 1
              : false,
      monthlyDailyBudget:
        p.monthlyDailyBudget !== undefined
          ? (p.monthlyDailyBudget as number | null)
          : existing?.monthly_daily_budget !== undefined && existing?.monthly_daily_budget !== null
            ? Number(existing.monthly_daily_budget)
            : null,
      note: String(p.note || ''),
      sortOrder:
        p.sortOrder !== undefined
          ? normalizeSortOrder(p.sortOrder, 0)
          : existing?.sort_order !== undefined
            ? Number(existing.sort_order)
            : 0,
      })
    );

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE ledgers
             SET name = ?, include_in_net_worth = ?, monthly_daily_budget = ?, note = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.name,
            v.includeInNetWorth ? 1 : 0,
            v.monthlyDailyBudget,
            v.note,
            v.sortOrder,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO ledgers
              (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.name,
            v.includeInNetWorth ? 1 : 0,
            v.monthlyDailyBudget,
            v.note,
            v.sortOrder,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchLedger, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'cashflow') {
    const existing = await db
      .prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapCashFlowRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchCashflow = async () => {
      const row = await db
        .prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return { row, mapped: row ? (mapCashFlowRow(row) as unknown as Record<string, unknown>) : null };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE cashflow_logs SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchCashflow, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateCashFlowInput(
        {
          date: String(p.date || ''),
          type: String(p.type || ''),
          category: String(p.category || ''),
          itemName: String(p.itemName || ''),
          amount: Number(p.amount),
          currency: String(p.currency || 'TWD'),
          fxRate: p.fxRate !== undefined ? Number(p.fxRate) : undefined,
          source: String(p.source || '手機記帳'),
          note: String(p.note || ''),
          linkedAccountId: p.linkedAccountId ? String(p.linkedAccountId) : null,
          ledgerId:
            p.ledgerId !== undefined
              ? normalizeLedgerId(p.ledgerId)
              : normalizeLedgerId(existing?.ledger_id),
        },
        defaultFxRate
      )
    );

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE cashflow_logs
             SET date = ?, year_month = ?, type = ?, category = ?, item_name = ?, amount = ?, currency = ?, fx_rate = ?, twd_amount = ?, source = ?, note = ?, linked_account_id = ?, ledger_id = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.date,
            v.yearMonth,
            v.type,
            v.category,
            v.itemName,
            v.amount,
            v.currency,
            v.fxRate,
            v.twdAmount,
            v.source,
            v.note,
            v.linkedAccountId,
            v.ledgerId,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO cashflow_logs
              (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, linked_account_id, ledger_id, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.date,
            v.yearMonth,
            v.type,
            v.category,
            v.itemName,
            v.amount,
            v.currency,
            v.fxRate,
            v.twdAmount,
            v.source,
            v.note,
            v.linkedAccountId,
            v.ledgerId,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchCashflow, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'recurring') {
    const existing = await db
      .prepare('SELECT * FROM recurring_items WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapRecurringRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchRecurring = async () => {
      const row = await db
        .prepare('SELECT * FROM recurring_items WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return { row, mapped: row ? (mapRecurringRow(row) as unknown as Record<string, unknown>) : null };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE recurring_items SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchRecurring, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateRecurringInput({
        itemName: String(p.itemName || ''),
        category: String(p.category || ''),
        type: String(p.type || ''),
        amount: Number(p.amount),
        currency: String(p.currency || 'TWD'),
        cycle: String(p.cycle || '月繳'),
        billingSpec: String(p.billingSpec || ''),
        status: String(p.status || '啟用'),
        note: String(p.note || ''),
        linkedAccountId: p.linkedAccountId ? String(p.linkedAccountId) : null,
        ledgerId:
          p.ledgerId !== undefined
            ? normalizeLedgerId(p.ledgerId)
            : normalizeLedgerId(existing?.ledger_id),
        sortOrder:
          p.sortOrder !== undefined
            ? normalizeSortOrder(p.sortOrder, 0)
            : existing?.sort_order !== undefined
              ? Number(existing.sort_order)
              : 0,
      })
    );

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE recurring_items
             SET item_name = ?, category = ?, type = ?, amount = ?, currency = ?, cycle = ?, billing_spec = ?, status = ?, note = ?, linked_account_id = ?, ledger_id = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.itemName,
            v.category,
            v.type,
            v.amount,
            v.currency,
            v.cycle,
            v.billingSpec,
            v.status,
            v.note,
            v.linkedAccountId,
            v.ledgerId,
            v.sortOrder,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO recurring_items
              (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, ledger_id, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.itemName,
            v.category,
            v.type,
            v.amount,
            v.currency,
            v.cycle,
            v.billingSpec,
            v.status,
            v.note,
            v.linkedAccountId,
            v.ledgerId,
            v.sortOrder,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchRecurring, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'sinking') {
    const existing = await db
      .prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapSinkingRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchSinking = async () => {
      const row = await db
        .prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return { row, mapped: row ? (mapSinkingRow(row) as unknown as Record<string, unknown>) : null };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE sinking_fund_items SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchSinking, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateSinkingInput({
        itemName: String(p.itemName || ''),
        category: String(p.category || ''),
        totalAmount: Number(p.totalAmount),
        months: Number(p.months),
        dueNote: String(p.dueNote || ''),
        status: String(p.status || '啟用'),
        note: String(p.note || ''),
        sortOrder:
          p.sortOrder !== undefined
            ? normalizeSortOrder(p.sortOrder, 0)
            : existing?.sort_order !== undefined
              ? Number(existing.sort_order)
              : 0,
      })
    );

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE sinking_fund_items
             SET item_name = ?, category = ?, total_amount = ?, months = ?, due_note = ?, status = ?, note = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.itemName,
            v.category,
            v.totalAmount,
            v.months,
            v.dueNote,
            v.status,
            v.note,
            v.sortOrder,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO sinking_fund_items
              (user_id, id, item_name, category, total_amount, months, due_note, status, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.itemName,
            v.category,
            v.totalAmount,
            v.months,
            v.dueNote,
            v.status,
            v.note,
            v.sortOrder,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchSinking, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'asset') {
    const existing = await db
      .prepare('SELECT * FROM asset_items WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapAssetRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchAsset = async () => {
      const row = await db
        .prepare('SELECT * FROM asset_items WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return { row, mapped: row ? (mapAssetRow(row) as unknown as Record<string, unknown>) : null };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE asset_items SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchAsset, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const isManualPriceOverride = Boolean(p.manualPriceOverride);
    const existingTicker = existing ? String(existing.ticker || '').trim().toUpperCase() : '';
    const incomingTicker = String(p.ticker || '').trim().toUpperCase();
    const tickerChanged = Boolean(existing && existingTicker !== incomingTicker);

    const v = runValidation(() =>
      validateAssetInput({
        updateMode: String(p.updateMode || '手動快照'),
        majorType: String(p.majorType || '資產'),
        subCategory: String(p.subCategory || '其他資產'),
        liquidity: String(p.liquidity || '中流動'),
        itemName: String(p.itemName || ''),
        ticker: String(p.ticker || ''),
        quantityOrAmount: Number(p.quantityOrAmount),
        currency: String(p.currency || 'TWD'),
        unitPrice:
          p.unitPrice !== undefined
            ? Number(p.unitPrice)
            : existing?.unit_price !== undefined
              ? Number(existing.unit_price)
              : 1,
        previousClose:
          p.previousClose !== undefined
            ? (p.previousClose as number | null)
            : existing?.previous_close !== undefined && existing?.previous_close !== null
              ? Number(existing.previous_close)
              : null,
        costBasis:
          p.costBasis !== undefined
            ? (p.costBasis as number | null)
            : existing?.cost_basis !== undefined && existing?.cost_basis !== null
              ? Number(existing.cost_basis)
              : null,
        note: String(p.note || ''),
        isLinkedSavings: Boolean(p.isLinkedSavings),
        balanceAnchorDate: p.balanceAnchorDate ? String(p.balanceAnchorDate) : null,
        balanceAnchorAt: p.balanceAnchorAt ? String(p.balanceAnchorAt) : null,
        isDefaultSavings: Boolean(p.isDefaultSavings),
        isAmortizingLoan: Boolean(p.isAmortizingLoan),
        loanAnnualRate:
          p.loanAnnualRate !== undefined && p.loanAnnualRate !== null ? Number(p.loanAnnualRate) : null,
        loanMonthlyPayment:
          p.loanMonthlyPayment !== undefined && p.loanMonthlyPayment !== null
            ? Number(p.loanMonthlyPayment)
            : null,
        loanBillingDay:
          p.loanBillingDay !== undefined && p.loanBillingDay !== null ? Number(p.loanBillingDay) : null,
        stockCategory:
          p.stockCategory !== undefined
            ? normalizeStockCategory(p.stockCategory)
            : existing?.stock_category !== undefined
              ? String(existing.stock_category || '')
              : '',
        isWatchlist:
          p.isWatchlist !== undefined
            ? Boolean(p.isWatchlist)
            : Number(existing?.is_watchlist || 0) === 1,
        ledgerId:
          p.ledgerId !== undefined
            ? normalizeLedgerId(p.ledgerId)
            : normalizeLedgerId(existing?.ledger_id),
        excludeFromNetWorth:
          p.excludeFromNetWorth !== undefined
            ? Boolean(p.excludeFromNetWorth)
            : Number(existing?.exclude_from_net_worth || 0) === 1,
        sortOrder:
          p.sortOrder !== undefined
            ? normalizeSortOrder(p.sortOrder, 0)
            : existing?.sort_order !== undefined
              ? Number(existing.sort_order)
              : 0,
      })
    );

    // Server-owned live quotes: for existing auto-updated assets on the same ticker, preserve server's
    // unit_price & previous_close unless the client explicitly marks manualPriceOverride: true.
    let finalUnitPrice = v.unitPrice;
    let finalPreviousClose = v.previousClose;
    if (existing && v.updateMode === '自動更新' && !isManualPriceOverride) {
      if (!tickerChanged) {
        finalUnitPrice = existing.unit_price !== undefined ? Number(existing.unit_price) : v.unitPrice;
        finalPreviousClose =
          existing.previous_close !== undefined && existing.previous_close !== null
            ? Number(existing.previous_close)
            : null;
      } else if (p.previousClose === undefined) {
        // Ticker changed: do not pair old ticker's previous_close with new ticker
        finalPreviousClose = null;
      }
    }

    const postStatements: D1PreparedStatement[] = [];
    if (v.isDefaultSavings) {
      postStatements.push(
        db
          .prepare(
            `UPDATE asset_items
             SET is_default_savings = 0, updated_at = ?, version = version + 1, change_seq = ${CURR_SEQ_SQL}
             WHERE user_id = ? AND ledger_id = ? AND is_default_savings = 1 AND id != ?
               AND EXISTS (SELECT 1 FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?)`
          )
          .bind(check.writeTs, uid, uid, v.ledgerId, mutation.recordId, uid, mutation.mutationId)
      );
    }

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE asset_items
             SET update_mode = ?, major_type = ?, sub_category = ?, liquidity = ?, item_name = ?, ticker = ?, quantity_or_amount = ?, currency = ?, unit_price = ?, previous_close = ?, cost_basis = ?, note = ?, is_linked_savings = ?, balance_anchor_date = ?, balance_anchor_at = ?, is_default_savings = ?, is_amortizing_loan = ?, loan_annual_rate = ?, loan_monthly_payment = ?, loan_billing_day = ?, stock_category = ?, is_watchlist = ?, ledger_id = ?, exclude_from_net_worth = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.updateMode,
            v.majorType,
            v.subCategory,
            v.liquidity,
            v.itemName,
            v.ticker,
            v.quantityOrAmount,
            v.currency,
            finalUnitPrice,
            finalPreviousClose,
            v.costBasis,
            v.note,
            v.isLinkedSavings ? 1 : 0,
            v.balanceAnchorDate,
            v.balanceAnchorAt,
            v.isDefaultSavings ? 1 : 0,
            v.isAmortizingLoan ? 1 : 0,
            v.loanAnnualRate,
            v.loanMonthlyPayment,
            v.loanBillingDay,
            v.stockCategory,
            v.isWatchlist ? 1 : 0,
            v.ledgerId,
            v.excludeFromNetWorth ? 1 : 0,
            v.sortOrder,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO asset_items
              (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, cost_basis, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, stock_category, is_watchlist, ledger_id, exclude_from_net_worth, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.updateMode,
            v.majorType,
            v.subCategory,
            v.liquidity,
            v.itemName,
            v.ticker,
            v.quantityOrAmount,
            v.currency,
            v.unitPrice,
            v.previousClose,
            v.costBasis,
            v.note,
            v.isLinkedSavings ? 1 : 0,
            v.balanceAnchorDate,
            v.balanceAnchorAt,
            v.isDefaultSavings ? 1 : 0,
            v.isAmortizingLoan ? 1 : 0,
            v.loanAnnualRate,
            v.loanMonthlyPayment,
            v.loanBillingDay,
            v.stockCategory,
            v.isWatchlist ? 1 : 0,
            v.ledgerId,
            v.excludeFromNetWorth ? 1 : 0,
            v.sortOrder,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, postStatements, refetchAsset, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'savings_adjustment') {
    const existing = await db
      .prepare('SELECT * FROM savings_adjustments WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapSavingsAdjustmentRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchAdj = async () => {
      const row = await db
        .prepare('SELECT * FROM savings_adjustments WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapSavingsAdjustmentRow(row) as unknown as Record<string, unknown>) : null,
      };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE savings_adjustments SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchAdj, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateSavingsAdjustmentInput(
        {
          accountId: String(p.accountId || ''),
          date: String(p.date || ''),
          amount: Number(p.amount),
          currency: p.currency ? String(p.currency) : 'TWD',
          note: String(p.note || ''),
          transferGroupId: p.transferGroupId ? String(p.transferGroupId) : null,
        },
        defaultFxRate
      )
    );
    const twdAmount = p.twdAmount !== undefined ? Math.round(Number(p.twdAmount)) : v.twdAmount;

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE savings_adjustments
             SET account_id = ?, date = ?, amount = ?, twd_amount = ?, note = ?, transfer_group_id = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.accountId,
            v.date,
            v.amount,
            twdAmount,
            v.note,
            v.transferGroupId,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO savings_adjustments
              (user_id, id, account_id, date, amount, twd_amount, note, transfer_group_id, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.accountId,
            v.date,
            v.amount,
            twdAmount,
            v.note,
            v.transferGroupId,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchAdj, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'stock_tx') {
    const existing = await db
      .prepare('SELECT * FROM stock_transactions WHERE user_id = ? AND id = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapStockTransactionRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchStockTx = async () => {
      const row = await db
        .prepare('SELECT * FROM stock_transactions WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapStockTransactionRow(row) as unknown as Record<string, unknown>) : null,
      };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE stock_transactions SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchStockTx, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateStockTransactionInput({
        assetId: String(p.assetId || ''),
        date: String(p.date || ''),
        txType: String(p.txType || ''),
        shares: p.shares !== undefined ? Number(p.shares) : 0,
        totalAmount: p.totalAmount !== undefined ? Number(p.totalAmount) : 0,
        fee: p.fee !== undefined ? Number(p.fee) : 0,
        linkedCashflowId: p.linkedCashflowId ? String(p.linkedCashflowId) : null,
        note: String(p.note || ''),
      })
    );

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE stock_transactions
             SET asset_id = ?, date = ?, tx_type = ?, shares = ?, total_amount = ?, fee = ?, linked_cashflow_id = ?, note = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ?`
          )
          .bind(
            v.assetId,
            v.date,
            v.txType,
            v.shares,
            v.totalAmount,
            v.fee,
            v.linkedCashflowId,
            v.note,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO stock_transactions
              (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.assetId,
            v.date,
            v.txType,
            v.shares,
            v.totalAmount,
            v.fee,
            v.linkedCashflowId,
            v.note,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchStockTx, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'utility_rents') {
    if (mutation.op !== 'upsert') {
      throw new RejectError('不支援刪除固定房租設定。');
    }
    const existing = await ensureRentUtilitySettings(db, uid);
    const existingRow = await db
      .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
      .bind(uid)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existingRow,
      existing as unknown as Record<string, unknown>,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }
    const v = runValidation(() =>
      validateUtilityRentsInput((mutation.payload || {}) as Partial<RentUtilityRents>)
    );
    const expectedVersion = Number(existingRow?.version ?? 1);
    const writeStmt = db
      .prepare(
        `UPDATE rent_utility_settings
         SET rent_6f = ?, rent_a = ?, rent_b = ?, rent_c = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL}
         WHERE user_id = ? AND version = ?`
      )
      .bind(v.rent6F, v.rentA, v.rentB, v.rentC, check.writeTs, check.nextVersion, uid, uid, expectedVersion);

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], async () => {
      const row = await db
        .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
        .bind(uid)
        .first<Record<string, unknown>>();
      const mapped = await ensureRentUtilitySettings(db, uid);
      return {
        row,
        mapped: mapped as unknown as Record<string, unknown>,
      };
    }, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'utility_record') {
    if (mutation.op !== 'delete') {
      const pEarly = mutation.payload || {};
      const payloadPeriodEarly =
        pEarly.period !== undefined && pEarly.period !== null ? String(pEarly.period).trim() : '';
      if (payloadPeriodEarly && payloadPeriodEarly !== mutation.recordId) {
        throw new RejectError(`水電期別鍵值不一致（${mutation.recordId} vs ${payloadPeriodEarly}）。`);
      }
    }
    const existing = await db
      .prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND period = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapUtilityRecordRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
      return;
    }

    const refetchUtil = async () => {
      const row = await db
        .prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND period = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapUtilityRecordRow(row) as unknown as Record<string, unknown>) : null,
      };
    };

    if (mutation.op === 'delete') {
      if (existing && Number(existing.is_baseline) === 1) {
        throw new RejectError('不可刪除起始表底紀錄。');
      }
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE rent_utility_records SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND period = ? AND version = ?`
        )
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, uid, mutation.recordId, Number(existing.version ?? 1));
      await commitAtomicMutation(db, uid, mutation, serverTime, delStmt, [], refetchUtil, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateUtilityRecordInput({
        period: mutation.recordId,
        isBaseline: Boolean(p.isBaseline),
        curTotal: Number(p.curTotal),
        cur6F: Number(p.cur6F),
        totalElec: Number(p.totalElec ?? 0),
        totalWater: Number(p.totalWater ?? 0),
        f6People: Number(p.f6People ?? 2),
        f5People: Number(p.f5People ?? 3),
        curA: Number(p.curA),
        curB: Number(p.curB),
        curC: Number(p.curC),
      })
    );

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE rent_utility_records
             SET is_baseline = ?, cur_total = ?, cur_6f = ?, total_elec = ?, total_water = ?, f6_people = ?, f5_people = ?, cur_a = ?, cur_b = ?, cur_c = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND period = ? AND version = ?`
          )
          .bind(
            v.isBaseline ? 1 : 0,
            v.curTotal,
            v.cur6F,
            v.totalElec,
            v.totalWater,
            v.f6People,
            v.f5People,
            v.curA,
            v.curB,
            v.curC,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1)
          )
      : db
          .prepare(
            `INSERT INTO rent_utility_records
              (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL})
             ON CONFLICT(user_id, period) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.isBaseline ? 1 : 0,
            v.curTotal,
            v.cur6F,
            v.totalElec,
            v.totalWater,
            v.f6People,
            v.f5People,
            v.curA,
            v.curB,
            v.curC,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, writeStmt, [], refetchUtil, check.legacyClientTs);
    return;
  }

  throw new RejectError(`不支援的同步資料類型：${String(mutation.entity)}`);
}

export async function querySyncDelta(
  db: D1Database,
  userId: string,
  since?: string | null,
  sinceSeq?: number | null,
  maxSeq?: number
): Promise<SyncDelta> {
  const uid = assertUserId(userId);
  const [settings, utilityRents] = await Promise.all([
    ensureAppSettings(db, uid),
    ensureRentUtilitySettings(db, uid),
    ensureDefaultLedger(db, uid),
  ]);

  if (typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) && typeof maxSeq === 'number') {
    const [settingsSeqRow, utilityRentsSeqRow, ledgers, logs, rec, sink, assets, adjs, stockTxs, hist, utilRecs] =
      await Promise.all([
        db.prepare('SELECT change_seq FROM app_settings WHERE user_id = ?').bind(uid).first<{ change_seq?: number }>(),
        db
          .prepare('SELECT change_seq FROM rent_utility_settings WHERE user_id = ?')
          .bind(uid)
          .first<{ change_seq?: number }>(),
        db
          .prepare(
            'SELECT * FROM ledgers WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY sort_order ASC, created_at ASC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY date DESC')
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare(
            'SELECT * FROM recurring_items WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY sort_order ASC, created_at ASC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare(
            'SELECT * FROM sinking_fund_items WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY sort_order ASC, created_at ASC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare(
            'SELECT * FROM asset_items WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY sort_order ASC, created_at ASC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare(
            'SELECT * FROM savings_adjustments WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY date DESC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare(
            'SELECT * FROM stock_transactions WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY date DESC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare(
            'SELECT * FROM networth_history WHERE user_id = ? AND change_seq > ? AND change_seq <= ? ORDER BY year_month DESC'
          )
          .bind(uid, sinceSeq, maxSeq)
          .all(),
        db
          .prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND change_seq > ? AND change_seq <= ?')
          .bind(uid, sinceSeq, maxSeq)
          .all(),
      ]);

    const settingsSeq = Number(settingsSeqRow?.change_seq ?? 0);
    const utilityRentsSeq = Number(utilityRentsSeqRow?.change_seq ?? 0);

    return {
      settings: settingsSeq > sinceSeq && settingsSeq <= maxSeq ? settings : null,
      ledgers: ledgers.results.map(mapLedgerRow),
      cashflowLogs: logs.results.map(mapCashFlowRow),
      recurringItems: rec.results.map(mapRecurringRow),
      sinkingItems: sink.results.map(mapSinkingRow),
      assetItems: assets.results.map(mapAssetRow),
      savingsAdjustments: adjs.results.map(mapSavingsAdjustmentRow),
      stockTransactions: stockTxs.results.map(mapStockTransactionRow),
      netWorthHistory: hist.results.map(mapNetWorthRow),
      rentUtilityRecords: utilRecs.results.map(mapUtilityRecordRow),
      rentUtilityRents: utilityRentsSeq > sinceSeq && utilityRentsSeq <= maxSeq ? utilityRents : null,
    };
  }

  if (since) {
    const [ledgers, logs, rec, sink, assets, adjs, stockTxs, hist, utilRecs] = await Promise.all([
      db.prepare('SELECT * FROM ledgers WHERE user_id = ? AND updated_at > ? ORDER BY sort_order ASC, created_at ASC').bind(uid, since).all(),
      db.prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND updated_at > ? ORDER BY date DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM recurring_items WHERE user_id = ? AND updated_at > ? ORDER BY sort_order ASC, created_at ASC').bind(uid, since).all(),
      db.prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND updated_at > ? ORDER BY sort_order ASC, created_at ASC').bind(uid, since).all(),
      db.prepare('SELECT * FROM asset_items WHERE user_id = ? AND updated_at > ? ORDER BY sort_order ASC, created_at ASC').bind(uid, since).all(),
      db.prepare('SELECT * FROM savings_adjustments WHERE user_id = ? AND updated_at > ? ORDER BY date DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM stock_transactions WHERE user_id = ? AND updated_at > ? ORDER BY date DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM networth_history WHERE user_id = ? AND updated_at > ? ORDER BY year_month DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND updated_at > ?').bind(uid, since).all(),
    ]);

    return {
      settings: settings.updatedAt > since ? settings : null,
      ledgers: ledgers.results.map(mapLedgerRow),
      cashflowLogs: logs.results.map(mapCashFlowRow),
      recurringItems: rec.results.map(mapRecurringRow),
      sinkingItems: sink.results.map(mapSinkingRow),
      assetItems: assets.results.map(mapAssetRow),
      savingsAdjustments: adjs.results.map(mapSavingsAdjustmentRow),
      stockTransactions: stockTxs.results.map(mapStockTransactionRow),
      netWorthHistory: hist.results.map(mapNetWorthRow),
      rentUtilityRecords: utilRecs.results.map(mapUtilityRecordRow),
      rentUtilityRents: utilityRents.updatedAt > since ? utilityRents : null,
    };
  }

  const [ledgers, logs, rec, sink, assets, adjs, stockTxs, hist, utilRecs] = await Promise.all([
    db.prepare('SELECT * FROM ledgers WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC').bind(uid).all(),
    db.prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT * FROM recurring_items WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC').bind(uid).all(),
    db.prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC').bind(uid).all(),
    db.prepare('SELECT * FROM asset_items WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC').bind(uid).all(),
    db.prepare('SELECT * FROM savings_adjustments WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT * FROM stock_transactions WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT * FROM networth_history WHERE user_id = ? ORDER BY year_month DESC').bind(uid).all(),
    db.prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND deleted_at IS NULL').bind(uid).all(),
  ]);

  return {
    settings,
    ledgers: ledgers.results.map(mapLedgerRow),
    cashflowLogs: logs.results.map(mapCashFlowRow),
    recurringItems: rec.results.map(mapRecurringRow),
    sinkingItems: sink.results.map(mapSinkingRow),
    assetItems: assets.results.map(mapAssetRow),
    savingsAdjustments: adjs.results.map(mapSavingsAdjustmentRow),
    stockTransactions: stockTxs.results.map(mapStockTransactionRow),
    netWorthHistory: hist.results.map(mapNetWorthRow),
    rentUtilityRecords: utilRecs.results.map(mapUtilityRecordRow),
    rentUtilityRents: utilityRents,
  };
}

export async function processSyncRequest(
  db: D1Database,
  userId: string,
  req: SyncRequest
): Promise<SyncResponse> {
  const uid = assertUserId(userId);
  const serverTime = new Date().toISOString();
  const [settings, syncStateBefore] = await Promise.all([
    ensureAppSettings(db, uid),
    ensureUserSyncState(db, uid),
    ensureDefaultLedger(db, uid),
  ]);
  const mutations = Array.isArray(req.mutations) ? req.mutations : [];
  const ackedMutationIds: string[] = [];
  const rejected: Array<{ mutationId: string; reason: string }> = [];
  const conflicts: SyncConflict[] = [];

  const epochMismatch =
    typeof req.clientEpoch === 'number' &&
    Number.isFinite(req.clientEpoch) &&
    req.clientEpoch !== syncStateBefore.dataEpoch;

  if (epochMismatch) {
    for (const mut of mutations) {
      if (mut?.mutationId) {
        rejected.push({
          mutationId: mut.mutationId,
          reason: '伺服器資料已透過備份還原重設，請於完整重載後確認是否重新套用',
        });
      }
    }
    const fullDelta = await querySyncDelta(db, uid, null);
    return {
      ok: true,
      serverTime,
      syncCursor: syncStateBefore.changeSeq,
      dataEpoch: syncStateBefore.dataEpoch,
      fullResyncRequired: true,
      ackedMutationIds,
      rejected,
      conflicts,
      delta: fullDelta,
    };
  }

  for (const mut of mutations) {
    if (!mut || !mut.mutationId || !mut.entity || !mut.recordId) {
      rejected.push({ mutationId: mut?.mutationId || 'unknown', reason: 'Invalid mutation format' });
      continue;
    }
    if (!ALLOWED_SYNC_ENTITIES.has(String(mut.entity)) || !ALLOWED_SYNC_OPS.has(String(mut.op))) {
      rejected.push({
        mutationId: mut.mutationId,
        reason: `不支援的同步類型或操作：${String(mut.entity)}:${String(mut.op)}`,
      });
      continue;
    }

    const already = await db
      .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
      .bind(uid, mut.mutationId)
      .first();

    if (already) {
      ackedMutationIds.push(mut.mutationId);
      continue;
    }

    try {
      await applySingleMutation(db, uid, mut, settings.usdTwdRate, serverTime);
      ackedMutationIds.push(mut.mutationId);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        conflicts.push(err.conflict);
      } else if (err instanceof RejectError) {
        rejected.push({
          mutationId: mut.mutationId,
          reason: err.message || '資料驗證失敗，伺服器拒絕此筆異動',
        });
      } else {
        // S2: Transient / infrastructure error (e.g. D1 overload/timeout) must NOT be treated as permanent rejection
        console.error('[sync] transient mutation failure:', mut.entity, mut.recordId, err);
        throw err;
      }
    }
  }

  const syncStateAfter = await ensureUserSyncState(db, uid);
  const useSeqCursor = typeof req.sinceSeq === 'number' && Number.isFinite(req.sinceSeq);
  const delta = useSeqCursor
    ? await querySyncDelta(db, uid, null, req.sinceSeq, syncStateAfter.changeSeq)
    : await querySyncDelta(db, uid, req.since);

  return {
    ok: true,
    serverTime,
    syncCursor: syncStateAfter.changeSeq,
    dataEpoch: syncStateAfter.dataEpoch,
    fullResyncRequired: false,
    ackedMutationIds,
    rejected,
    conflicts,
    delta,
  };
}

export async function exportFullSnapshot(
  db: D1Database,
  userId: string
): Promise<FinanceSnapshot> {
  const uid = assertUserId(userId);
  const delta = await querySyncDelta(db, uid, null);
  return {
    settings: delta.settings || (await ensureAppSettings(db, uid)),
    ledgers: delta.ledgers || [],
    cashflowLogs: delta.cashflowLogs,
    recurringItems: delta.recurringItems,
    sinkingItems: delta.sinkingItems,
    assetItems: delta.assetItems,
    savingsAdjustments: delta.savingsAdjustments || [],
    stockTransactions: delta.stockTransactions || [],
    netWorthHistory: delta.netWorthHistory,
    rentUtilityRecords: delta.rentUtilityRecords,
    rentUtilityRents: delta.rentUtilityRents || (await ensureRentUtilitySettings(db, uid)),
  };
}

export async function importFullSnapshot(
  db: D1Database,
  userId: string,
  data: Partial<FinanceSnapshot>,
  mode: 'merge' | 'replace' = 'merge'
): Promise<{ importedLogs: number; importedRecurring: number; importedSinking: number; importedAssets: number }> {
  const uid = assertUserId(userId);
  const nowIso = new Date().toISOString();
  const currentSettings = await ensureAppSettings(db, uid);

  // 1. Pre-validate ALL records in memory BEFORE mutating any database table
  const fxForImport = data.settings
    ? toSafeNumber(data.settings.usdTwdRate, currentSettings.usdTwdRate)
    : currentSettings.usdTwdRate;

  const validatedLedgers: Array<{
    id: string;
    v: ReturnType<typeof validateLedgerInput>;
    createdAt: string;
  }> = [];
  for (const lg of data.ledgers || []) {
    if (!lg || lg.deletedAt) continue;
    validatedLedgers.push({
      id: normalizeLedgerId(lg.id),
      v: validateLedgerInput(lg),
      createdAt: lg.createdAt || nowIso,
    });
  }

  const validatedLogs: Array<{
    id: string;
    v: ReturnType<typeof validateCashFlowInput>;
    createdAt: string;
  }> = [];
  for (const log of data.cashflowLogs || []) {
    validatedLogs.push({
      id: log.id || crypto.randomUUID(),
      v: validateCashFlowInput(log, fxForImport),
      createdAt: log.createdAt || nowIso,
    });
  }

  const validatedRecurring: Array<{
    id: string;
    v: ReturnType<typeof validateRecurringInput>;
    createdAt: string;
  }> = [];
  for (const r of data.recurringItems || []) {
    validatedRecurring.push({
      id: r.id || crypto.randomUUID(),
      v: validateRecurringInput(r),
      createdAt: r.createdAt || nowIso,
    });
  }

  const validatedSinking: Array<{
    id: string;
    v: ReturnType<typeof validateSinkingInput>;
    createdAt: string;
  }> = [];
  for (const s of data.sinkingItems || []) {
    validatedSinking.push({
      id: s.id || crypto.randomUUID(),
      v: validateSinkingInput(s),
      createdAt: s.createdAt || nowIso,
    });
  }

  const validatedAssets: Array<{
    id: string;
    v: ReturnType<typeof validateAssetInput>;
    priceUpdatedAt: string | null;
    createdAt: string;
  }> = [];
  for (const a of data.assetItems || []) {
    validatedAssets.push({
      id: a.id || crypto.randomUUID(),
      v: validateAssetInput(a),
      priceUpdatedAt: a.priceUpdatedAt || null,
      createdAt: a.createdAt || nowIso,
    });
  }

  const validatedAdjs: Array<{
    id: string;
    v: ReturnType<typeof validateSavingsAdjustmentInput>;
    twdAmount: number;
    createdAt: string;
  }> = [];
  for (const adj of data.savingsAdjustments || []) {
    const v = validateSavingsAdjustmentInput(adj, fxForImport);
    validatedAdjs.push({
      id: adj.id || crypto.randomUUID(),
      v,
      twdAmount: adj.twdAmount !== undefined ? Math.round(adj.twdAmount) : v.twdAmount,
      createdAt: adj.createdAt || nowIso,
    });
  }

  const validatedStockTxs: Array<{
    id: string;
    v: ReturnType<typeof validateStockTransactionInput>;
    createdAt: string;
  }> = [];
  for (const tx of data.stockTransactions || []) {
    validatedStockTxs.push({
      id: tx.id || crypto.randomUUID(),
      v: validateStockTransactionInput(tx),
      createdAt: tx.createdAt || nowIso,
    });
  }

  const validatedUtilityRents = data.rentUtilityRents
    ? validateUtilityRentsInput(data.rentUtilityRents)
    : null;

  const validatedUtilityRecords: Array<{
    v: ReturnType<typeof validateUtilityRecordInput>;
    createdAt: string;
  }> = [];
  for (const u of data.rentUtilityRecords || []) {
    validatedUtilityRecords.push({
      v: validateUtilityRecordInput(u),
      createdAt: u.createdAt || nowIso,
    });
  }

  await ensureUserSyncState(db, uid);

  // 2. Assemble ALL DELETE + INSERT statements into a single atomic D1 batch
  const stmts: D1PreparedStatement[] = [];

  if (mode === 'replace') {
    stmts.push(
      db
        .prepare(
          'UPDATE user_sync_state SET change_seq = change_seq + 1, data_epoch = data_epoch + 1, updated_at = ? WHERE user_id = ?'
        )
        .bind(nowIso, uid),
      db.prepare('DELETE FROM sync_lww_timestamps WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM ledgers WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM cashflow_logs WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM recurring_items WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM sinking_fund_items WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM asset_items WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM savings_adjustments WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM stock_transactions WHERE user_id = ?').bind(uid),
      db.prepare('DELETE FROM networth_history WHERE user_id = ?').bind(uid)
    );
    if (validatedUtilityRecords.length > 0) {
      stmts.push(db.prepare('DELETE FROM rent_utility_records WHERE user_id = ?').bind(uid));
    }
  } else {
    stmts.push(
      db
        .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ?')
        .bind(nowIso, uid)
    );
  }

  // Always ensure default primary ledger exists inside the batch
  stmts.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO ledgers
          (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
         VALUES (?, ?, ?, 1, NULL, ?, 1, ?, ?, NULL, 1, ${CURR_SEQ_SQL})`
      )
      .bind(
        uid,
        DEFAULT_LEDGER_ID,
        DEFAULT_LEDGER_NAME,
        '預設個人帳本（納入總資產與淨值統計）',
        nowIso,
        nowIso,
        uid
      )
  );

  for (const { id: lid, v, createdAt } of validatedLedgers) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO ledgers
            (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM ledgers WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          lid,
          v.name,
          lid === DEFAULT_LEDGER_ID ? 1 : v.includeInNetWorth ? 1 : 0,
          v.monthlyDailyBudget,
          v.note,
          v.sortOrder,
          createdAt,
          nowIso,
          uid,
          lid,
          uid
        )
    );
  }

  if (data.settings) {
    const customStockCategories = normalizeCustomStockCategories(
      data.settings.customStockCategories ?? currentSettings.customStockCategories
    );
    const autoFxEnabled =
      data.settings.autoFxEnabled !== undefined
        ? Boolean(data.settings.autoFxEnabled)
        : currentSettings.autoFxEnabled !== undefined
          ? currentSettings.autoFxEnabled
          : true;
    stmts.push(
      db
        .prepare(
          `UPDATE app_settings
           SET monthly_daily_budget = ?, emergency_target_months = ?, usd_twd_rate = ?, auto_fx_enabled = ?, pnl_color_scheme = ?, custom_stock_categories = ?, updated_at = ?, version = version + 1, change_seq = ${CURR_SEQ_SQL}
           WHERE user_id = ?`
        )
        .bind(
          Math.max(0, Math.round(toSafeNumber(data.settings.monthlyDailyBudget, currentSettings.monthlyDailyBudget))),
          Math.min(60, Math.max(1, Math.round(toSafeNumber(data.settings.emergencyTargetMonths, currentSettings.emergencyTargetMonths)))),
          fxForImport,
          autoFxEnabled ? 1 : 0,
          normalizePnlColorScheme(data.settings.pnlColorScheme ?? currentSettings.pnlColorScheme),
          JSON.stringify(customStockCategories),
          nowIso,
          uid,
          uid
        )
    );
  }

  for (const { id, v, createdAt } of validatedLogs) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO cashflow_logs
            (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, linked_account_id, ledger_id, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM cashflow_logs WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          id,
          v.date,
          v.yearMonth,
          v.type,
          v.category,
          v.itemName,
          v.amount,
          v.currency,
          v.fxRate,
          v.twdAmount,
          v.source,
          v.note,
          v.linkedAccountId,
          v.ledgerId,
          createdAt,
          nowIso,
          uid,
          id,
          uid
        )
    );
  }

  for (const { id, v, createdAt } of validatedRecurring) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO recurring_items
            (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, ledger_id, sort_order, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM recurring_items WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          id,
          v.itemName,
          v.category,
          v.type,
          v.amount,
          v.currency,
          v.cycle,
          v.billingSpec,
          v.status,
          v.note,
          v.linkedAccountId,
          v.ledgerId,
          v.sortOrder,
          createdAt,
          nowIso,
          uid,
          id,
          uid
        )
    );
  }

  for (const { id, v, createdAt } of validatedSinking) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO sinking_fund_items
            (user_id, id, item_name, category, total_amount, months, due_note, status, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM sinking_fund_items WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          id,
          v.itemName,
          v.category,
          v.totalAmount,
          v.months,
          v.dueNote,
          v.status,
          v.note,
          v.sortOrder,
          createdAt,
          nowIso,
          uid,
          id,
          uid
        )
    );
  }

  for (const { id, v, priceUpdatedAt, createdAt } of validatedAssets) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO asset_items
            (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, cost_basis, price_updated_at, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, sort_order, stock_category, is_watchlist, ledger_id, exclude_from_net_worth, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM asset_items WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          id,
          v.updateMode,
          v.majorType,
          v.subCategory,
          v.liquidity,
          v.itemName,
          v.ticker,
          v.quantityOrAmount,
          v.currency,
          v.unitPrice,
          v.previousClose,
          v.costBasis,
          priceUpdatedAt,
          v.note,
          v.isLinkedSavings ? 1 : 0,
          v.balanceAnchorDate,
          v.balanceAnchorAt,
          v.isDefaultSavings ? 1 : 0,
          v.isAmortizingLoan ? 1 : 0,
          v.loanAnnualRate,
          v.loanMonthlyPayment,
          v.loanBillingDay,
          v.sortOrder,
          v.stockCategory,
          v.isWatchlist ? 1 : 0,
          v.ledgerId,
          v.excludeFromNetWorth ? 1 : 0,
          createdAt,
          nowIso,
          uid,
          id,
          uid
        )
    );
  }

  for (const { id, v, twdAmount, createdAt } of validatedAdjs) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO savings_adjustments
            (user_id, id, account_id, date, amount, twd_amount, note, transfer_group_id, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM savings_adjustments WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          id,
          v.accountId,
          v.date,
          v.amount,
          twdAmount,
          v.note,
          v.transferGroupId,
          createdAt,
          nowIso,
          uid,
          id,
          uid
        )
    );
  }

  for (const { id, v, createdAt } of validatedStockTxs) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO stock_transactions
            (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM stock_transactions WHERE user_id = ? AND id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          id,
          v.assetId,
          v.date,
          v.txType,
          v.shares,
          v.totalAmount,
          v.fee,
          v.linkedCashflowId,
          v.note,
          createdAt,
          nowIso,
          uid,
          id,
          uid
        )
    );
  }

  for (const h of data.netWorthHistory || []) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO networth_history
            (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          h.yearMonth,
          h.snapshotDate,
          Math.round(h.totalAssets),
          Math.round(h.totalLiabilities),
          Math.round(h.netWorth),
          Math.round(h.highLiquidityAssets),
          Math.round(h.investmentAssets),
          Math.round(h.insuranceAssets),
          Math.round(h.monthlyIncome),
          Math.round(h.monthlyConsumption),
          h.savingsRate,
          h.note || '',
          nowIso,
          uid
        )
    );
  }

  if (validatedUtilityRents) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT version FROM rent_utility_settings WHERE user_id = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          validatedUtilityRents.rent6F,
          validatedUtilityRents.rentA,
          validatedUtilityRents.rentB,
          validatedUtilityRents.rentC,
          nowIso,
          uid,
          uid
        )
    );
  }

  for (const { v, createdAt } of validatedUtilityRecords) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO rent_utility_records
            (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE((SELECT version FROM rent_utility_records WHERE user_id = ? AND period = ?), 0) + 1, ${CURR_SEQ_SQL})`
        )
        .bind(
          uid,
          v.period,
          v.isBaseline ? 1 : 0,
          v.curTotal,
          v.cur6F,
          v.totalElec,
          v.totalWater,
          v.f6People,
          v.f5People,
          v.curA,
          v.curB,
          v.curC,
          createdAt,
          nowIso,
          uid,
          v.period,
          uid
        )
    );
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  return {
    importedLogs: validatedLogs.length,
    importedRecurring: validatedRecurring.length,
    importedSinking: validatedSinking.length,
    importedAssets: validatedAssets.length,
  };
}
