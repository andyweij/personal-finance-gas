import { normalizeRecurringPostDay } from '../shared/recurring';
import { atomicGroupKeyOf, orderMutationsByDependencies } from '../shared/syncOrder';
import type { FxRateSource } from '../shared/currency';
import { countD1Queries } from './d1Budget';
import {
  DEFAULT_EMERGENCY_MONTHS,
  DEFAULT_LEDGER_ID,
  DEFAULT_LEDGER_NAME,
  D1_QUERIES_PER_INVOCATION_FREE,
  SYNC_MAX_MUTATIONS_PER_REQUEST,
  DEFAULT_MONTHLY_DAILY_BUDGET,
  DEFAULT_PNL_COLOR_SCHEME,
  DEFAULT_USD_TWD_RATE,
} from '../shared/constants';
import type {
  AppSettings,
  AssetItem,
  CashFlowLog,
  FinancialGoal,
  FinancialGoalType,
  FinanceSnapshot,
  Ledger,
  NetWorthHistory,
  RecurringItem,
  RentUtilityRecord,
  RentUtilityRents,
  SavingsAdjustment,
  SinkingFundItem,
  SplitReceivable,
  SplitReceivableStatus,
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
  normalizeCustomCategories,
  normalizeCustomStockCategories,
  normalizeEnabledCurrencies,
  normalizeFxRates,
  normalizeLedgerId,
  normalizeLinkedAssetIds,
  normalizePnlColorScheme,
  normalizeQuickTemplates,
  normalizeRebalanceTargets,
  normalizeSortOrder,
  normalizeStockCategory,
  toSafeNumber,
  validateAssetInput,
  validateCashFlowInput,
  validateFinancialGoalInput,
  validateLedgerInput,
  validateRecurringInput,
  validateSavingsAdjustmentInput,
  validateSinkingInput,
  validateSplitReceivableInput,
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

function mapAppSettingsRow(row: Record<string, unknown>): AppSettings {
  const usdTwdRate = Number(row.usd_twd_rate);
  return {
    monthlyDailyBudget: Number(row.monthly_daily_budget),
    emergencyTargetMonths: Number(row.emergency_target_months),
    usdTwdRate,
    enabledCurrencies: normalizeEnabledCurrencies(row.enabled_currencies_json),
    fxRates: normalizeFxRates(row.fx_rates_json, usdTwdRate),
    autoFxEnabled:
      row.auto_fx_enabled !== undefined && row.auto_fx_enabled !== null ? Number(row.auto_fx_enabled) !== 0 : true,
    fxUpdatedAt: (row.fx_updated_at as string | null) ?? null,
    pnlColorScheme: normalizePnlColorScheme(row.pnl_color_scheme),
    customStockCategories: normalizeCustomStockCategories(row.custom_stock_categories),
    rebalanceTargets: normalizeRebalanceTargets(row.rebalance_targets_json),
    customCategories: normalizeCustomCategories(row.custom_categories_json),
    quickTemplates: normalizeQuickTemplates(row.quick_templates_json),
    updatedAt: String(row.updated_at),
    version: Number(row.version ?? 1),
  };
}

function mapRentUtilityRow(row: Record<string, unknown>): RentUtilityRents {
  return {
    rent6F: Number(row.rent_6f || 0),
    rentA: Number(row.rent_a || 0),
    rentB: Number(row.rent_b || 0),
    rentC: Number(row.rent_c || 0),
    updatedAt: String(row.updated_at || ''),
    version: Number(row.version ?? 1),
  };
}

/**
 * H5 (v1.8.13): creates the per-user baseline rows (sync state, settings, rent settings, default ledger) if
 * missing and reads them back — all in ONE D1 call, instead of 4–6 separate ensure* round trips per request.
 */
export async function ensureSyncBaseline(
  db: D1Database,
  userId: string
): Promise<{ settings: AppSettings; rents: RentUtilityRents; changeSeq: number; dataEpoch: number }> {
  const uid = assertUserId(userId);
  const nowIso = new Date().toISOString();
  const bump = () =>
    db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
      .bind(nowIso, uid);
  const results = await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
      .bind(uid, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO app_settings (user_id, monthly_daily_budget, emergency_target_months, usd_twd_rate, auto_fx_enabled, pnl_color_scheme, custom_stock_categories, updated_at, version, change_seq)
         VALUES (?, ?, ?, ?, 1, ?, '[]', ?, 1, ${NEXT_SEQ_SQL})`
      )
      .bind(uid, DEFAULT_MONTHLY_DAILY_BUDGET, DEFAULT_EMERGENCY_MONTHS, DEFAULT_USD_TWD_RATE, DEFAULT_PNL_COLOR_SCHEME, nowIso, uid),
    bump(),
    db
      .prepare(
        `INSERT OR IGNORE INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version, change_seq)
         VALUES (?, 0, 0, 0, 0, ?, 1, ${NEXT_SEQ_SQL})`
      )
      .bind(uid, nowIso, uid),
    bump(),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledgers
          (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
         VALUES (?, ?, ?, 1, NULL, ?, 1, ?, ?, NULL, 1, ${NEXT_SEQ_SQL})`
      )
      .bind(uid, DEFAULT_LEDGER_ID, DEFAULT_LEDGER_NAME, '預設個人帳本（納入總資產與淨值統計）', nowIso, nowIso, uid),
    bump(),
    db.prepare('SELECT * FROM app_settings WHERE user_id = ?').bind(uid),
    db.prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?').bind(uid),
    db.prepare('SELECT change_seq, data_epoch FROM user_sync_state WHERE user_id = ?').bind(uid),
  ]);
  const settingsRow = (results[7]?.results?.[0] ?? null) as Record<string, unknown> | null;
  const rentsRow = (results[8]?.results?.[0] ?? null) as Record<string, unknown> | null;
  const stateRow = (results[9]?.results?.[0] ?? null) as Record<string, unknown> | null;
  if (!settingsRow || !rentsRow || !stateRow) throw new Error('sync baseline rows could not be read');
  return {
    settings: mapAppSettingsRow(settingsRow),
    rents: mapRentUtilityRow(rentsRow),
    changeSeq: Number(stateRow.change_seq ?? 0),
    dataEpoch: Number(stateRow.data_epoch ?? 1),
  };
}

async function ensureAppSettingsWithRow(
  db: D1Database,
  userId: string
): Promise<{ settings: AppSettings; row: Record<string, unknown> | null }> {
  const uid = assertUserId(userId);
  const row = await db
    .prepare('SELECT * FROM app_settings WHERE user_id = ?')
    .bind(uid)
    .first<Record<string, unknown>>();

  if (row) {
    return { settings: mapAppSettingsRow(row), row };
  }

  const nowIso = new Date().toISOString();
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
      .bind(uid, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO app_settings (user_id, monthly_daily_budget, emergency_target_months, usd_twd_rate, auto_fx_enabled, pnl_color_scheme, custom_stock_categories, updated_at, version, change_seq)
         VALUES (?, ?, ?, ?, 1, ?, '[]', ?, 1, ${NEXT_SEQ_SQL})`
      )
      .bind(
        uid,
        DEFAULT_MONTHLY_DAILY_BUDGET,
        DEFAULT_EMERGENCY_MONTHS,
        DEFAULT_USD_TWD_RATE,
        DEFAULT_PNL_COLOR_SCHEME,
        nowIso,
        uid
      ),
    db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
      .bind(nowIso, uid),
  ]);

  return {
    row: null,
    settings: {
      monthlyDailyBudget: DEFAULT_MONTHLY_DAILY_BUDGET,
      emergencyTargetMonths: DEFAULT_EMERGENCY_MONTHS,
      usdTwdRate: DEFAULT_USD_TWD_RATE,
      enabledCurrencies: ['TWD', 'USD'],
      fxRates: { USD: DEFAULT_USD_TWD_RATE },
      autoFxEnabled: true,
      fxUpdatedAt: null,
      pnlColorScheme: DEFAULT_PNL_COLOR_SCHEME,
      customStockCategories: [],
      rebalanceTargets: [],
      customCategories: {},
      quickTemplates: [],
      updatedAt: nowIso,
      version: 1,
    },
  };
}

export async function ensureAppSettings(db: D1Database, userId: string): Promise<AppSettings> {
  const { settings } = await ensureAppSettingsWithRow(db, userId);
  return settings;
}

export async function ensureDefaultLedger(db: D1Database, userId: string): Promise<void> {
  const uid = assertUserId(userId);
  const existing = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ? AND id = ?')
    .bind(uid, DEFAULT_LEDGER_ID)
    .first();
  if (existing) return;
  const nowIso = new Date().toISOString();
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
      .bind(uid, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledgers
          (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
         VALUES (?, ?, ?, 1, NULL, ?, 1, ?, ?, NULL, 1, ${NEXT_SEQ_SQL})`
      )
      .bind(
        uid,
        DEFAULT_LEDGER_ID,
        DEFAULT_LEDGER_NAME,
        '預設個人帳本（納入總資產與淨值統計）',
        nowIso,
        nowIso,
        uid
      ),
    db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
      .bind(nowIso, uid),
  ]);
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
    postDay: normalizeRecurringPostDay(r.post_day),
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

function mapFinancialGoalRow(r: Record<string, unknown>): FinancialGoal {
  return {
    id: String(r.id),
    name: String(r.name),
    goalType: (String(r.goal_type || 'manual') as FinancialGoalType),
    targetAmount: Number(r.target_amount),
    currency: String(r.currency || 'TWD'),
    linkedLedgerId: r.linked_ledger_id ? String(r.linked_ledger_id) : null,
    linkedAssetIds: normalizeLinkedAssetIds(r.linked_asset_ids_json),
    currentManualAmount: Number(r.current_manual_amount ?? 0),
    expectedAnnualReturnPct: Number(r.expected_annual_return_pct ?? 0),
    monthlyContributionOverride:
      r.monthly_contribution_override !== null && r.monthly_contribution_override !== undefined
        ? Number(r.monthly_contribution_override)
        : null,
    fireSwrPct:
      r.fire_swr_pct !== null && r.fire_swr_pct !== undefined ? Number(r.fire_swr_pct) : null,
    targetDate: r.target_date ? String(r.target_date) : null,
    sortOrder: Number(r.sort_order ?? 0),
    note: String(r.note || ''),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapSplitReceivableRow(r: Record<string, unknown>): SplitReceivable {
  return {
    id: String(r.id),
    ledgerId: normalizeLedgerId(r.ledger_id),
    splitGroupId: String(r.split_group_id || ''),
    counterparty: String(r.counterparty),
    date: String(r.date),
    itemName: String(r.item_name),
    category: String(r.category || '其他'),
    amount: Number(r.amount),
    settledAmount: Number(r.settled_amount ?? 0),
    currency: String(r.currency || 'TWD'),
    fxRate: Number(r.fx_rate ?? 1),
    twdAmount: Number(r.twd_amount ?? 0),
    status: (String(r.status || 'open') as SplitReceivableStatus),
    sourceCashflowId: r.source_cashflow_id ? String(r.source_cashflow_id) : null,
    sourceAccountId: r.source_account_id ? String(r.source_account_id) : null,
    sourceAdjustmentId: r.source_adjustment_id ? String(r.source_adjustment_id) : null,
    note: String(r.note || ''),
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
  // P2-S12: allocate a change_seq like every other synced row, so a lazily created row is never invisible
  // to a device that already holds a cursor.
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
      .bind(uid, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version, change_seq)
         VALUES (?, 0, 0, 0, 0, ?, 1, ${NEXT_SEQ_SQL})`
      )
      .bind(uid, nowIso, uid),
    db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
      .bind(nowIso, uid),
  ]);

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

class EpochMismatchError extends Error {
  constructor() {
    super('Data epoch changed concurrently');
    this.name = 'EpochMismatchError';
  }
}

/**
 * M3: Referential integrity for writes. A record may only point at a ledger / asset that exists for the same
 * user and is not soft-deleted. Only references that this write changes are checked (a brand-new record checks
 * all of them): legacy rows written before v1.8.12 may already hold a dangling reference, and an unrelated edit
 * such as changing the note must not be rejected because of it. The `default` ledger always exists.
 *
 * The check is part of the primary write statement (`AND EXISTS (...)`), so a reference deleted by a concurrent
 * request between our reads and the write cannot slip through (no TOCTOU). When the guarded write changes 0 rows
 * we re-check the references and turn a missing one into a RejectError.
 */
type RefKind = 'ledger' | 'asset';
interface RefCheck {
  kind: RefKind;
  id: string;
  label: string;
}

function collectChangedRefs(
  existing: Record<string, unknown> | null,
  specs: Array<{ kind: RefKind; value: string | null | undefined; column: string; label: string }>
): RefCheck[] {
  const out: RefCheck[] = [];
  for (const spec of specs) {
    const id = spec.value === null || spec.value === undefined ? '' : String(spec.value);
    if (!id) continue;
    if (spec.kind === 'ledger' && id === DEFAULT_LEDGER_ID) continue;
    if (existing) {
      const prev = existing[spec.column];
      const prevId =
        spec.kind === 'ledger' ? normalizeLedgerId(prev) : prev === null || prev === undefined ? '' : String(prev);
      if (prevId === id) continue;
    }
    out.push({ kind: spec.kind, id, label: spec.label });
  }
  return out;
}

/**
 * Post-deploy review fix (v1.8.17): a v1.8.11 client (it does not send `refsOrdered`) can send a child record
 * before the account / ledger it points at — its batches are strict outbox prefixes without dependency order, and
 * after a failed request it sends one mutation at a time. Rejecting the child would roll it back for good, so for
 * such requests a reference to a record that has NEVER existed on the server is accepted (the v1.8.11 behaviour;
 * the referenced record is still in that client's outbox). A reference to a DELETED record is still rejected.
 * Current clients send `refsOrdered: true` and always get the strict check.
 */
function refGuardSql(db: D1Database, uid: string, refs: RefCheck[]): { sql: string; binds: unknown[] } {
  const lenient = isLegacyRefRequest(db);
  let sql = '';
  const binds: unknown[] = [];
  for (const ref of refs) {
    const table = ref.kind === 'ledger' ? 'ledgers' : 'asset_items';
    if (lenient) {
      sql += ` AND (EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at IS NULL) OR NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ?))`;
      binds.push(uid, ref.id, uid, ref.id);
    } else {
      sql += ` AND EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at IS NULL)`;
      binds.push(uid, ref.id);
    }
  }
  return { sql, binds };
}

async function rejectMissingRefs(db: D1Database, uid: string, refs: RefCheck[]): Promise<void> {
  const lenient = isLegacyRefRequest(db);
  for (const ref of refs) {
    const table = ref.kind === 'ledger' ? 'ledgers' : 'asset_items';
    const row = await db
      .prepare(
        lenient
          ? `SELECT id FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at IS NOT NULL`
          : `SELECT id FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      )
      .bind(uid, ref.id)
      .first();
    if (lenient ? Boolean(row) : !row) {
      throw new RejectError(`${ref.label}不存在或已刪除，伺服器拒絕此筆異動。`);
    }
  }
}

/**
 * H5 (v1.8.13): rows each mutation of a request needs are read up front in the same batch as the idempotency
 * check, so a typical mutation costs one D1 call (its commit). A prefetched row is used once; after any commit
 * that also updates other rows (post statements such as clearing another default account) the cache is dropped.
 */
const ROW_PREFETCH = Symbol('syncRowPrefetch');
type RowPrefetch = Map<string, Record<string, unknown> | null>;

const LEGACY_REFS = Symbol('syncLegacyRefs');

function withRowPrefetch(db: D1Database, prefetch: RowPrefetch, legacyRefs = false): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === ROW_PREFETCH) return prefetch;
      if (prop === LEGACY_REFS) return legacyRefs;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** true for a request from a client that does not order mutations by their references (see refGuardSql) */
function isLegacyRefRequest(db: D1Database): boolean {
  return (db as unknown as { [LEGACY_REFS]?: boolean })[LEGACY_REFS] === true;
}

function getRowPrefetch(db: D1Database): RowPrefetch | undefined {
  return (db as unknown as { [ROW_PREFETCH]?: RowPrefetch })[ROW_PREFETCH];
}

/**
 * v1.13.1: whether migration 0022 (recurring_items.post_day) has been applied. One cheap query; only used when a
 * write needs the column and no existing row tells us already.
 */
async function hasRecurringPostDayColumn(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT post_day FROM recurring_items LIMIT 0').all();
    return true;
  } catch {
    return false;
  }
}

const RECURRING_POST_DAY_MIGRATION_ERROR =
  '伺服器資料庫尚未完成升級（缺少「入帳日」欄位），請先執行資料庫遷移後再重試。';

async function readExistingRow(
  db: D1Database,
  uid: string,
  table: string,
  keyColumn: 'id' | 'period',
  recordId: string
): Promise<Record<string, unknown> | null> {
  const prefetch = getRowPrefetch(db);
  const key = `${table}:${recordId}`;
  if (prefetch?.has(key)) {
    const row = prefetch.get(key) ?? null;
    prefetch.delete(key);
    return row;
  }
  return db
    .prepare(`SELECT * FROM ${table} WHERE user_id = ? AND ${keyColumn} = ?`)
    .bind(uid, recordId)
    .first<Record<string, unknown>>();
}

const ENTITY_ROW_TABLE: Record<string, { table: string; keyColumn: 'id' | 'period' }> = {
  ledger: { table: 'ledgers', keyColumn: 'id' },
  cashflow: { table: 'cashflow_logs', keyColumn: 'id' },
  recurring: { table: 'recurring_items', keyColumn: 'id' },
  sinking: { table: 'sinking_fund_items', keyColumn: 'id' },
  asset: { table: 'asset_items', keyColumn: 'id' },
  savings_adjustment: { table: 'savings_adjustments', keyColumn: 'id' },
  stock_tx: { table: 'stock_transactions', keyColumn: 'id' },
  financial_goal: { table: 'financial_goals', keyColumn: 'id' },
  split_receivable: { table: 'split_receivables', keyColumn: 'id' },
};

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
const EPOCH_GUARD_SQL = 'COALESCE((SELECT data_epoch FROM user_sync_state WHERE user_id = ?), 1) = ?';

async function getCurrentDataEpoch(db: D1Database, uid: string): Promise<number> {
  const row = await db
    .prepare('SELECT data_epoch FROM user_sync_state WHERE user_id = ?')
    .bind(uid)
    .first<{ data_epoch?: number }>();
  return Number(row?.data_epoch ?? 1);
}

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
  'financial_goal',
  'split_receivable',
]);

const ALLOWED_SYNC_OPS = new Set<string>(['upsert', 'delete']);

async function recordIdempotencyOnly(
  db: D1Database,
  uid: string,
  mutationId: string,
  serverTime: string,
  expectedEpoch: number
): Promise<void> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO sync_idempotency (user_id, mutation_id, applied_at)
       SELECT ?, ?, ? WHERE ${EPOCH_GUARD_SQL}`
    )
    .bind(uid, mutationId, serverTime, uid, expectedEpoch)
    .run();
  if (Number(res?.meta?.changes ?? 0) === 0) {
    const already = await db
      .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
      .bind(uid, mutationId)
      .first();
    if (already) return;
    const currEpoch = await getCurrentDataEpoch(db, uid);
    if (currEpoch !== expectedEpoch) {
      throw new EpochMismatchError();
    }
    // R-8: Neither recorded nor an epoch change — never ack silently; let the request fail and be retried.
    throw new Error('sync_idempotency row could not be recorded');
  }
}

/**
 * M4: atomic mutation groups (account transfers). Each member is evaluated normally (validation, version check,
 * reference guards); instead of committing, commitAtomicMutation hands its statements to the collector. The
 * executor then commits all members in ONE D1 batch, with a guard statement after each member's idempotency /
 * change_seq statements that raises an error when that member's guarded write changed 0 rows. Any error rolls back
 * the whole batch, so either every leg of the transfer is written or none is.
 */
const GROUP_COLLECTOR = Symbol('syncGroupCollector');
interface GroupCollector {
  items: Array<{ mutation: SyncMutation; statements: D1PreparedStatement[]; onZeroChanges?: () => Promise<void> }>;
  groupMutations: SyncMutation[];
}

const GROUP_GUARD_MARKER = 'atomic_group_guard_failed';

class GroupRejectError extends Error {
  constructor(
    public readonly failedMutationId: string | null,
    message: string
  ) {
    super(message);
    this.name = 'GroupRejectError';
  }
}

function withGroupCollector(db: D1Database, collector: GroupCollector): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === GROUP_COLLECTOR) return collector;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function getGroupContext(db: D1Database): GroupCollector | undefined {
  return (db as unknown as { [GROUP_COLLECTOR]?: GroupCollector })[GROUP_COLLECTOR];
}

async function applyMutationGroup(
  db: D1Database,
  uid: string,
  group: SyncMutation[],
  defaultFxRate: FxRateSource,
  serverTime: string,
  expectedEpoch: number
): Promise<void> {
  const collector: GroupCollector = { items: [], groupMutations: group };
  const collectingDb = withGroupCollector(db, collector);
  for (const m of group) {
    try {
      await applySingleMutation(collectingDb, uid, m, defaultFxRate, serverTime, expectedEpoch);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        // Inside a transfer a conflict cannot be resolved for one leg alone: reject the whole group (the client
        // restores the cloud copy and keeps the payloads in its rejection list).
        throw new GroupRejectError(m.mutationId, '此筆資料已在其他裝置變更（版本衝突），整筆轉帳未套用並已還原雲端資料');
      }
      if (err instanceof RejectError) {
        throw new GroupRejectError(m.mutationId, err.message);
      }
      throw err;
    }
  }
  if (collector.items.length === 0) return;
  const guardSql = `SELECT json(CASE WHEN changes() > 0 THEN '1' ELSE '${GROUP_GUARD_MARKER}' END) AS ok`;
  const stmts: D1PreparedStatement[] = [];
  for (const item of collector.items) {
    // [primary write, idempotency (changes() > 0), change_seq bump (changes() > 0)] → guard → extras / post statements
    stmts.push(...item.statements.slice(0, 3), db.prepare(guardSql), ...item.statements.slice(3));
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const pending: string[] = [];
    for (const item of collector.items) {
      const done = await db
        .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
        .bind(uid, item.mutation.mutationId)
        .first();
      if (!done) pending.push(item.mutation.mutationId);
    }
    if (pending.length === 0) return; // an identical concurrent retry committed the whole group
    if ((await getCurrentDataEpoch(db, uid)) !== expectedEpoch) {
      throw new EpochMismatchError();
    }
    if (/malformed JSON/i.test(msg) || msg.includes(GROUP_GUARD_MARKER)) {
      // Review R-F: report a missing reference (M3) precisely instead of the generic "changed elsewhere"
      for (const item of collector.items) {
        try {
          await item.onZeroChanges?.();
        } catch (refErr) {
          if (refErr instanceof RejectError) throw new GroupRejectError(item.mutation.mutationId, refErr.message);
          throw refErr;
        }
      }
      throw new GroupRejectError(null, '轉帳的部分資料已在其他裝置變更，整筆轉帳未套用並已還原雲端資料');
    }
    throw err;
  }
}

/**
 * Splits the request into units: a single mutation, or every mutation of the request sharing an atomic group id.
 * Legacy clients (no atomicGroupId) still get atomicity for the two savings legs of a transfer sent in the same
 * request: savings_adjustment upserts sharing `payload.transferGroupId` form an implicit group.
 */
function groupKeyOf(m: SyncMutation): string | null {
  return atomicGroupKeyOf(m);
}

async function commitAtomicMutation(
  db: D1Database,
  uid: string,
  mutation: SyncMutation,
  serverTime: string,
  expectedEpoch: number,
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
  const groupCollector = (db as unknown as { [GROUP_COLLECTOR]?: GroupCollector })[GROUP_COLLECTOR];
  if (groupCollector) {
    // M4: part of an atomic group — the group executor commits every member in one batch
    if (postStatements.length > 0) getRowPrefetch(db)?.clear();
    groupCollector.items.push({ mutation, statements: batchStmts, onZeroChanges });
    return;
  }
  if (postStatements.length > 0) getRowPrefetch(db)?.clear(); // other rows may change too
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

      // Q5 / N4: Check if a concurrent replace import bumped data_epoch BEFORE reporting conflict/rejection
      const currEpoch = await getCurrentDataEpoch(db, uid);
      if (currEpoch !== expectedEpoch) {
        throw new EpochMismatchError();
      }

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
    if (err instanceof VersionConflictError || err instanceof RejectError || err instanceof EpochMismatchError) {
      throw err;
    }
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
  defaultFxRate: FxRateSource,
  serverTime: string,
  expectedEpoch: number
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
    // H5: one read (the baseline batch of this request already created the row)
    let existingRow = await db
      .prepare('SELECT * FROM app_settings WHERE user_id = ?')
      .bind(uid)
      .first<Record<string, unknown>>();
    if (!existingRow) {
      await ensureAppSettings(db, uid);
      existingRow = await db.prepare('SELECT * FROM app_settings WHERE user_id = ?').bind(uid).first<Record<string, unknown>>();
    }
    const existing = mapAppSettingsRow(existingRow || {});
    const check = checkVersionOrThrow(
      mutation,
      existingRow,
      existing as unknown as Record<string, unknown>,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
      return;
    }
    const expectedVersion = Number(existingRow?.version ?? 1);
    const budget = Math.max(0, Math.round(toSafeNumber(p.monthlyDailyBudget, existing.monthlyDailyBudget)));
    const months = Math.min(60, Math.max(1, Math.round(toSafeNumber(p.emergencyTargetMonths, existing.emergencyTargetMonths))));
    const fx = toSafeNumber(p.usdTwdRate, existing.usdTwdRate);
    const validFx = fx > 10 && fx < 100 ? fx : existing.usdTwdRate;
    const enabledCurrencies =
      p.enabledCurrencies !== undefined
        ? normalizeEnabledCurrencies(p.enabledCurrencies)
        : existing.enabledCurrencies || ['TWD', 'USD'];
    const fxRates =
      p.fxRates !== undefined
        ? normalizeFxRates({ ...(p.fxRates as Record<string, unknown>), USD: validFx }, validFx)
        : normalizeFxRates({ ...(existing.fxRates || {}), USD: validFx }, validFx);
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
    const rebalanceTargets =
      p.rebalanceTargets !== undefined
        ? normalizeRebalanceTargets(p.rebalanceTargets)
        : existing.rebalanceTargets || [];
    const customCategories =
      p.customCategories !== undefined
        ? normalizeCustomCategories(p.customCategories)
        : existing.customCategories || {};
    const quickTemplates =
      p.quickTemplates !== undefined
        ? normalizeQuickTemplates(p.quickTemplates)
        : existing.quickTemplates || [];
    const optionalSettingCols: Array<{
      col: string;
      hasNonDefaultPayload: boolean;
      value: string;
      label: string;
    }> = [
      {
        col: 'rebalance_targets_json',
        hasNonDefaultPayload: p.rebalanceTargets !== undefined && rebalanceTargets.length > 0,
        value: JSON.stringify(rebalanceTargets),
        label: '再平衡目標',
      },
      {
        col: 'custom_categories_json',
        hasNonDefaultPayload: p.customCategories !== undefined && Object.keys(customCategories).length > 0,
        value: JSON.stringify(customCategories),
        label: '自訂分類',
      },
      {
        col: 'quick_templates_json',
        hasNonDefaultPayload: p.quickTemplates !== undefined && quickTemplates.length > 0,
        value: JSON.stringify(quickTemplates),
        label: '快速記帳範本',
      },
      {
        col: 'enabled_currencies_json',
        hasNonDefaultPayload:
          p.enabledCurrencies !== undefined &&
          (enabledCurrencies.length !== 2 || enabledCurrencies[0] !== 'TWD' || enabledCurrencies[1] !== 'USD'),
        value: JSON.stringify(enabledCurrencies),
        label: '多幣別清單',
      },
      {
        col: 'fx_rates_json',
        hasNonDefaultPayload:
          p.fxRates !== undefined && Object.keys(fxRates).some((k) => k !== 'USD'),
        value: JSON.stringify(fxRates),
        label: '多幣別匯率',
      },
    ];
    const extraCols: string[] = [];
    const extraVals: unknown[] = [];
    for (const opt of optionalSettingCols) {
      if (!existingRow || opt.col in existingRow) {
        extraCols.push(`${opt.col} = ?`);
        extraVals.push(opt.value);
      } else if (opt.hasNonDefaultPayload) {
        throw new RejectError(
          `伺服器資料庫尚未完成升級（缺少「${opt.label}」欄位），請先執行資料庫遷移後再重試。`
        );
      }
    }
    const extraSql = extraCols.length ? `, ${extraCols.join(', ')}` : '';
    const writeStmt = db
      .prepare(
        `UPDATE app_settings
         SET monthly_daily_budget = ?, emergency_target_months = ?, usd_twd_rate = ?, auto_fx_enabled = ?, pnl_color_scheme = ?, custom_stock_categories = ?${extraSql}, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL}
         WHERE user_id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
      )
      .bind(
        budget,
        months,
        validFx,
        autoFxEnabled ? 1 : 0,
        pnlScheme,
        JSON.stringify(customStockCats),
        ...extraVals,
        check.writeTs,
        check.nextVersion,
        uid,
        uid,
        expectedVersion,
        uid,
        expectedEpoch
      );
    await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, writeStmt, [], async () => {
      const row = await db
        .prepare('SELECT * FROM app_settings WHERE user_id = ?')
        .bind(uid)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapAppSettingsRow(row) as unknown as Record<string, unknown>) : null,
      };
    }, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'ledger') {
    const existing = await readExistingRow(db, uid, 'ledgers', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapLedgerRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const countLinkedRecords = async () => {
        // H5: one query instead of three
        const row = await db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM cashflow_logs WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL) +
               (SELECT COUNT(*) FROM asset_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL) +
               (SELECT COUNT(*) FROM recurring_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL) AS cnt`
          )
          .bind(uid, mutation.recordId, uid, mutation.recordId, uid, mutation.recordId)
          .first<{ cnt: number }>();
        return Number(row?.cnt || 0);
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
           WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}
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
          expectedEpoch,
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
        expectedEpoch,
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
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
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
            Number(existing.version ?? 1),
            uid,
            expectedEpoch
          )
      : db
          .prepare(
            `INSERT INTO ledgers
              (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}
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
            uid,
            uid,
            expectedEpoch
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, writeStmt, [], refetchLedger, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'cashflow') {
    const existing = await readExistingRow(db, uid, 'cashflow_logs', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapCashFlowRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE cashflow_logs SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchCashflow, check.legacyClientTs);
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

    // M3: only references changed by this write are checked; the guard is part of the write statement
    const changedRefs = collectChangedRefs(existing, [
      { kind: 'ledger', value: v.ledgerId, column: 'ledger_id', label: '指定的帳本' },
      { kind: 'asset', value: v.linkedAccountId, column: 'linked_account_id', label: '連動的活存帳戶' },
    ]);
    const refGuard = refGuardSql(db, uid, changedRefs);

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE cashflow_logs
             SET date = ?, year_month = ?, type = ?, category = ?, item_name = ?, amount = ?, currency = ?, fx_rate = ?, twd_amount = ?, source = ?, note = ?, linked_account_id = ?, ledger_id = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${refGuard.sql}`
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
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...refGuard.binds
          )
      : db
          .prepare(
            `INSERT INTO cashflow_logs
              (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, linked_account_id, ledger_id, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${refGuard.sql}
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
            uid,
            uid,
            expectedEpoch,
            ...refGuard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      [],
      refetchCashflow,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, changedRefs)
    );
    return;
  }

  if (mutation.entity === 'recurring') {
    const existing = await readExistingRow(db, uid, 'recurring_items', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapRecurringRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE recurring_items SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchRecurring, check.legacyClientTs);
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
        // v1.13.1: a client older than v1.13.1 does not send postDay — keep the stored day instead of resetting it
        postDay:
          p.postDay !== undefined && p.postDay !== null
            ? (p.postDay as number | string)
            : existing?.post_day !== undefined && existing?.post_day !== null
              ? Number(existing.post_day)
              : undefined,
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

    // M3: only references changed by this write are checked; the guard is part of the write statement
    const changedRefs = collectChangedRefs(existing, [
      { kind: 'ledger', value: v.ledgerId, column: 'ledger_id', label: '指定的帳本' },
      { kind: 'asset', value: v.linkedAccountId, column: 'linked_account_id', label: '連動的活存帳戶' },
    ]);
    const refGuard = refGuardSql(db, uid, changedRefs);

    // v1.13.1: post_day (migration 0022). Before the migration a non-default day is rejected (never silently
    // dropped); the default day 1 is simply not written (the column default / previous behaviour applies).
    const postDayColumnKnown = existing ? 'post_day' in existing : v.postDay === 1 ? false : await hasRecurringPostDayColumn(db);
    if (!postDayColumnKnown && v.postDay !== 1) {
      throw new RejectError(RECURRING_POST_DAY_MIGRATION_ERROR);
    }
    const postDaySet = postDayColumnKnown ? ', post_day = ?' : '';
    const postDayBind = postDayColumnKnown ? [v.postDay] : [];
    const postDayInsertCol = postDayColumnKnown ? ', post_day' : '';
    const postDayInsertVal = postDayColumnKnown ? ', ?' : '';

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE recurring_items
             SET item_name = ?, category = ?, type = ?, amount = ?, currency = ?, cycle = ?, billing_spec = ?, status = ?, note = ?, linked_account_id = ?, ledger_id = ?, sort_order = ?${postDaySet}, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${refGuard.sql}`
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
            ...postDayBind,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...refGuard.binds
          )
      : db
          .prepare(
            `INSERT INTO recurring_items
              (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, ledger_id, sort_order${postDayInsertCol}, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${postDayInsertVal}, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${refGuard.sql}
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
            ...postDayBind,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            expectedEpoch,
            ...refGuard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      [],
      refetchRecurring,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, changedRefs)
    );
    return;
  }

  if (mutation.entity === 'sinking') {
    const existing = await readExistingRow(db, uid, 'sinking_fund_items', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapSinkingRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE sinking_fund_items SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchSinking, check.legacyClientTs);
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
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
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
            Number(existing.version ?? 1),
            uid,
            expectedEpoch
          )
      : db
          .prepare(
            `INSERT INTO sinking_fund_items
              (user_id, id, item_name, category, total_amount, months, due_note, status, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}
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
            uid,
            uid,
            expectedEpoch
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, writeStmt, [], refetchSinking, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'financial_goal') {
    let existing: Record<string, unknown> | null = null;
    try {
      existing = await readExistingRow(db, uid, 'financial_goals', 'id', mutation.recordId);
    } catch (err) {
      if (/no such table:\s*financial_goals/i.test(err instanceof Error ? err.message : String(err))) {
        throw new RejectError(
          '伺服器資料庫尚未完成升級（缺少財務目標資料表），請先執行資料庫遷移後再重試。'
        );
      }
      throw err;
    }
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapFinancialGoalRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
      return;
    }

    const refetchGoal = async () => {
      const row = await db
        .prepare('SELECT * FROM financial_goals WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapFinancialGoalRow(row) as unknown as Record<string, unknown>) : null,
      };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE financial_goals SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(
        db,
        uid,
        mutation,
        serverTime,
        expectedEpoch,
        delStmt,
        [],
        refetchGoal,
        check.legacyClientTs
      );
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateFinancialGoalInput({
        name: String(p.name || ''),
        goalType: String(p.goalType || 'manual'),
        targetAmount: Number(p.targetAmount),
        currency: String(p.currency || 'TWD'),
        linkedLedgerId: p.linkedLedgerId !== undefined ? (p.linkedLedgerId as string | null) : null,
        linkedAssetIds: p.linkedAssetIds as string[] | string | undefined,
        currentManualAmount: p.currentManualAmount !== undefined ? Number(p.currentManualAmount) : 0,
        expectedAnnualReturnPct:
          p.expectedAnnualReturnPct !== undefined ? Number(p.expectedAnnualReturnPct) : 0,
        monthlyContributionOverride:
          p.monthlyContributionOverride !== undefined && p.monthlyContributionOverride !== null
            ? Number(p.monthlyContributionOverride)
            : null,
        fireSwrPct: p.fireSwrPct !== undefined && p.fireSwrPct !== null ? Number(p.fireSwrPct) : null,
        targetDate: p.targetDate !== undefined && p.targetDate !== null ? String(p.targetDate) : null,
        sortOrder:
          p.sortOrder !== undefined
            ? normalizeSortOrder(p.sortOrder, 0)
            : existing?.sort_order !== undefined
              ? Number(existing.sort_order)
              : 0,
        note: String(p.note || ''),
      })
    );

    const refs: RefCheck[] = [];
    if (v.linkedLedgerId && v.linkedLedgerId !== DEFAULT_LEDGER_ID) {
      const prevLid = existing?.linked_ledger_id ? String(existing.linked_ledger_id) : '';
      if (!existing || prevLid !== v.linkedLedgerId) {
        refs.push({ kind: 'ledger', id: v.linkedLedgerId, label: '目標綁定帳本' });
      }
    }
    if (v.linkedAssetIds.length > 0) {
      const prevAssetIds = new Set(existing ? normalizeLinkedAssetIds(existing.linked_asset_ids_json) : []);
      for (const aid of v.linkedAssetIds) {
        if (!existing || !prevAssetIds.has(aid)) {
          refs.push({ kind: 'asset', id: aid, label: '目標綁定資產' });
        }
      }
    }
    const guard = refGuardSql(db, uid, refs);

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE financial_goals
             SET name = ?, goal_type = ?, target_amount = ?, currency = ?, linked_ledger_id = ?, linked_asset_ids_json = ?, current_manual_amount = ?, expected_annual_return_pct = ?, monthly_contribution_override = ?, fire_swr_pct = ?, target_date = ?, sort_order = ?, note = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${guard.sql}`
          )
          .bind(
            v.name,
            v.goalType,
            v.targetAmount,
            v.currency,
            v.linkedLedgerId,
            JSON.stringify(v.linkedAssetIds),
            v.currentManualAmount,
            v.expectedAnnualReturnPct,
            v.monthlyContributionOverride,
            v.fireSwrPct,
            v.targetDate,
            v.sortOrder,
            v.note,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...guard.binds
          )
      : db
          .prepare(
            `INSERT INTO financial_goals
              (user_id, id, name, goal_type, target_amount, currency, linked_ledger_id, linked_asset_ids_json, current_manual_amount, expected_annual_return_pct, monthly_contribution_override, fire_swr_pct, target_date, sort_order, note, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${guard.sql}
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.name,
            v.goalType,
            v.targetAmount,
            v.currency,
            v.linkedLedgerId,
            JSON.stringify(v.linkedAssetIds),
            v.currentManualAmount,
            v.expectedAnnualReturnPct,
            v.monthlyContributionOverride,
            v.fireSwrPct,
            v.targetDate,
            v.sortOrder,
            v.note,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            expectedEpoch,
            ...guard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      [],
      refetchGoal,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, refs)
    );
    return;
  }

  if (mutation.entity === 'split_receivable') {
    let existing: Record<string, unknown> | null = null;
    try {
      existing = await readExistingRow(db, uid, 'split_receivables', 'id', mutation.recordId);
    } catch (err) {
      if (/no such table:\s*split_receivables/i.test(err instanceof Error ? err.message : String(err))) {
        throw new RejectError(
          '伺服器資料庫尚未完成升級（缺少代墊／拆帳資料表），請先執行 0023 資料庫遷移後再重試。'
        );
      }
      throw err;
    }
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapSplitReceivableRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
      return;
    }

    const refetchSplit = async () => {
      const row = await db
        .prepare('SELECT * FROM split_receivables WHERE user_id = ? AND id = ?')
        .bind(uid, mutation.recordId)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapSplitReceivableRow(row) as unknown as Record<string, unknown>) : null,
      };
    };

    if (mutation.op === 'delete') {
      if (!existing) {
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE split_receivables SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(
        db,
        uid,
        mutation,
        serverTime,
        expectedEpoch,
        delStmt,
        [],
        refetchSplit,
        check.legacyClientTs
      );
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateSplitReceivableInput(
        {
          ledgerId: p.ledgerId !== undefined ? String(p.ledgerId) : undefined,
          splitGroupId: p.splitGroupId !== undefined ? String(p.splitGroupId) : '',
          counterparty: String(p.counterparty || ''),
          date: String(p.date || ''),
          itemName: String(p.itemName || ''),
          category: String(p.category || '其他'),
          amount: Number(p.amount),
          settledAmount: p.settledAmount !== undefined ? Number(p.settledAmount) : 0,
          currency: String(p.currency || 'TWD'),
          fxRate: p.fxRate !== undefined ? Number(p.fxRate) : undefined,
          status: p.status !== undefined ? String(p.status) : undefined,
          sourceCashflowId:
            p.sourceCashflowId !== undefined ? (p.sourceCashflowId as string | null) : null,
          sourceAccountId:
            p.sourceAccountId !== undefined ? (p.sourceAccountId as string | null) : null,
          sourceAdjustmentId:
            p.sourceAdjustmentId !== undefined ? (p.sourceAdjustmentId as string | null) : null,
          note: String(p.note || ''),
        },
        defaultFxRate
      )
    );

    const refs = collectChangedRefs(existing, [
      { kind: 'ledger', column: 'ledger_id', value: v.ledgerId, label: '帳本' },
      { kind: 'asset', column: 'source_account_id', value: v.sourceAccountId, label: '付款活存帳戶' },
    ]);
    const guard = refGuardSql(db, uid, refs);

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE split_receivables
             SET ledger_id = ?, split_group_id = ?, counterparty = ?, date = ?, item_name = ?, category = ?, amount = ?, settled_amount = ?, currency = ?, fx_rate = ?, twd_amount = ?, status = ?, source_cashflow_id = ?, source_account_id = ?, source_adjustment_id = ?, note = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${guard.sql}`
          )
          .bind(
            v.ledgerId,
            v.splitGroupId,
            v.counterparty,
            v.date,
            v.itemName,
            v.category,
            v.amount,
            v.settledAmount,
            v.currency,
            v.fxRate,
            v.twdAmount,
            v.status,
            v.sourceCashflowId,
            v.sourceAccountId,
            v.sourceAdjustmentId,
            v.note,
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            mutation.recordId,
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...guard.binds
          )
      : db
          .prepare(
            `INSERT INTO split_receivables
              (user_id, id, ledger_id, split_group_id, counterparty, date, item_name, category, amount, settled_amount, currency, fx_rate, twd_amount, status, source_cashflow_id, source_account_id, source_adjustment_id, note, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${guard.sql}
             ON CONFLICT(user_id, id) DO NOTHING`
          )
          .bind(
            uid,
            mutation.recordId,
            v.ledgerId,
            v.splitGroupId,
            v.counterparty,
            v.date,
            v.itemName,
            v.category,
            v.amount,
            v.settledAmount,
            v.currency,
            v.fxRate,
            v.twdAmount,
            v.status,
            v.sourceCashflowId,
            v.sourceAccountId,
            v.sourceAdjustmentId,
            v.note,
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            expectedEpoch,
            ...guard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      [],
      refetchSplit,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, refs)
    );
    return;
  }

  if (mutation.entity === 'asset') {
    const existing = await readExistingRow(db, uid, 'asset_items', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapAssetRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE asset_items SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchAsset, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const isManualPriceOverride = Boolean(p.manualPriceOverride);
    const isActiveExisting = Boolean(existing && !existing.deleted_at);
    const existingTicker = isActiveExisting ? String(existing?.ticker || '').trim().toUpperCase() : '';
    const incomingTicker = String(p.ticker || '').trim().toUpperCase();
    const tickerChanged = Boolean(isActiveExisting && existingTicker !== incomingTicker);
    // Q8 / F5: Only a replacement with ANOTHER NON-EMPTY ticker invalidates the old quote; clearing the ticker
    // keeps the last known price (the holding simply stops auto-updating).
    const tickerReplaced = tickerChanged && incomingTicker !== '';
    const incomingIsAutoWithTicker = String(p.updateMode || '') === '自動更新' && incomingTicker !== '';

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
            : isActiveExisting && existing?.unit_price !== undefined
              ? Number(existing.unit_price)
              : // Q8: new / resurrected auto-updated asset without a price → 0 ("待更新"), consistent with ticker replacement
                incomingIsAutoWithTicker
                ? 0
                : 1,
        previousClose:
          p.previousClose !== undefined
            ? (p.previousClose as number | null)
            : isActiveExisting && existing?.previous_close !== undefined && existing?.previous_close !== null
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

    // Server-owned live quotes (F4, F5, F9):
    // - Same ticker on active auto-updated asset: preserve server unit_price & previous_close unless explicitly overridden.
    //   When manualPriceOverride is true, only override fields actually sent in payload (e.g. editing only previousClose won't clobber unit_price).
    // - Ticker changed on active auto-updated asset: clear stale price_updated_at and unprovided old quotes.
    // - Resurrecting a soft-deleted asset: never retain stale deleted-row price_updated_at or prices.
    let finalUnitPrice = v.unitPrice;
    let finalPreviousClose = v.previousClose;
    let clearPriceUpdatedAt = false;
    if (isActiveExisting && v.updateMode === '自動更新') {
      if (!tickerReplaced) {
        if (!isManualPriceOverride) {
          finalUnitPrice = existing!.unit_price !== undefined ? Number(existing!.unit_price) : v.unitPrice;
          finalPreviousClose =
            existing!.previous_close !== undefined && existing!.previous_close !== null
              ? Number(existing!.previous_close)
              : null;
        } else {
          finalUnitPrice =
            p.unitPrice !== undefined
              ? v.unitPrice
              : existing!.unit_price !== undefined
                ? Number(existing!.unit_price)
                : v.unitPrice;
          finalPreviousClose =
            p.previousClose !== undefined
              ? v.previousClose
              : existing!.previous_close !== undefined && existing!.previous_close !== null
                ? Number(existing!.previous_close)
                : null;
        }
      } else {
        clearPriceUpdatedAt = true;
        if (p.unitPrice === undefined) {
          finalUnitPrice = 0;
        }
        if (p.previousClose === undefined) {
          finalPreviousClose = null;
        }
      }
    } else if (existing && !isActiveExisting && v.updateMode === '自動更新') {
      clearPriceUpdatedAt = true;
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

    const nextPriceUpdatedAt = clearPriceUpdatedAt
      ? null
      : existing?.price_updated_at !== undefined && existing?.price_updated_at !== null
        ? String(existing.price_updated_at)
        : null;

    // M3: only references changed by this write are checked; the guard is part of the write statement
    const changedRefs = collectChangedRefs(existing, [{ kind: 'ledger', value: v.ledgerId, column: 'ledger_id', label: '指定的帳本' }]);
    const refGuard = refGuardSql(db, uid, changedRefs);

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE asset_items
             SET update_mode = ?, major_type = ?, sub_category = ?, liquidity = ?, item_name = ?, ticker = ?, quantity_or_amount = ?, currency = ?, unit_price = ?, previous_close = ?, price_updated_at = ?, cost_basis = ?, note = ?, is_linked_savings = ?, balance_anchor_date = ?, balance_anchor_at = ?, is_default_savings = ?, is_amortizing_loan = ?, loan_annual_rate = ?, loan_monthly_payment = ?, loan_billing_day = ?, stock_category = ?, is_watchlist = ?, ledger_id = ?, exclude_from_net_worth = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${refGuard.sql}`
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
            nextPriceUpdatedAt,
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
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...refGuard.binds
          )
      : db
          .prepare(
            `INSERT INTO asset_items
              (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, cost_basis, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, stock_category, is_watchlist, ledger_id, exclude_from_net_worth, sort_order, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${refGuard.sql}
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
            uid,
            uid,
            expectedEpoch,
            ...refGuard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      postStatements,
      refetchAsset,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, changedRefs)
    );
    return;
  }

  if (mutation.entity === 'savings_adjustment') {
    const existing = await readExistingRow(db, uid, 'savings_adjustments', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapSavingsAdjustmentRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE savings_adjustments SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchAdj, check.legacyClientTs);
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
    let twdAmount = v.twdAmount;
    if (p.twdAmount !== undefined) {
      const parsedTwd = Number(p.twdAmount);
      if (!Number.isFinite(parsedTwd)) {
        throw new RejectError('台幣金額格式無效。');
      }
      twdAmount = Math.round(parsedTwd);
    }

    // M4: one leg of a transfer may not change its amount / account on its own (the pair would no longer balance).
    // Note-only edits are fine; changing the money of a transfer requires every active leg in the same atomic group.
    if (existing && existing.transfer_group_id && !existing.deleted_at) {
      const moneyChanged =
        Number(existing.amount) !== Number(v.amount) || String(existing.account_id) !== String(v.accountId);
      if (moneyChanged) {
        const siblings = await db
          .prepare(
            'SELECT id FROM savings_adjustments WHERE user_id = ? AND transfer_group_id = ? AND id != ? AND deleted_at IS NULL'
          )
          .bind(uid, String(existing.transfer_group_id), mutation.recordId)
          .all<{ id: string }>();
        const inGroup = new Set(
          (getGroupContext(db)?.groupMutations || [])
            .filter((m) => m.entity === 'savings_adjustment')
            .map((m) => m.recordId)
        );
        if ((siblings.results || []).some((r) => !inGroup.has(String(r.id)))) {
          throw new RejectError('帳戶互轉的其中一邊不可單獨修改金額或帳戶，請刪除整筆轉帳後重新建立。');
        }
      }
    }

    // M3: only references changed by this write are checked; the guard is part of the write statement
    const changedRefs = collectChangedRefs(existing, [{ kind: 'asset', value: v.accountId, column: 'account_id', label: '對應的活存帳戶' }]);
    const refGuard = refGuardSql(db, uid, changedRefs);

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE savings_adjustments
             SET account_id = ?, date = ?, amount = ?, twd_amount = ?, note = ?, transfer_group_id = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${refGuard.sql}`
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
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...refGuard.binds
          )
      : db
          .prepare(
            `INSERT INTO savings_adjustments
              (user_id, id, account_id, date, amount, twd_amount, note, transfer_group_id, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${refGuard.sql}
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
            uid,
            uid,
            expectedEpoch,
            ...refGuard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      [],
      refetchAdj,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, changedRefs)
    );
    return;
  }

  if (mutation.entity === 'stock_tx') {
    const existing = await readExistingRow(db, uid, 'stock_transactions', 'id', mutation.recordId);
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapStockTransactionRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE stock_transactions SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          mutation.recordId,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchStockTx, check.legacyClientTs);
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

    // M3: only references changed by this write are checked; the guard is part of the write statement
    const changedRefs = collectChangedRefs(existing, [{ kind: 'asset', value: v.assetId, column: 'asset_id', label: '對應的持股標的' }]);
    const refGuard = refGuardSql(db, uid, changedRefs);

    const writeStmt = existing
      ? db
          .prepare(
            `UPDATE stock_transactions
             SET asset_id = ?, date = ?, tx_type = ?, shares = ?, total_amount = ?, fee = ?, linked_cashflow_id = ?, note = ?, updated_at = ?, deleted_at = NULL, version = ?, change_seq = ${NEXT_SEQ_SQL}
             WHERE user_id = ? AND id = ? AND version = ? AND ${EPOCH_GUARD_SQL}${refGuard.sql}`
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
            Number(existing.version ?? 1),
            uid,
            expectedEpoch,
            ...refGuard.binds
          )
      : db
          .prepare(
            `INSERT INTO stock_transactions
              (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}${refGuard.sql}
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
            uid,
            uid,
            expectedEpoch,
            ...refGuard.binds
          );

    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      writeStmt,
      [],
      refetchStockTx,
      check.legacyClientTs,
      () => rejectMissingRefs(db, uid, changedRefs)
    );
    return;
  }

  if (mutation.entity === 'utility_rents') {
    if (mutation.op !== 'upsert') {
      throw new RejectError('不支援刪除固定房租設定。');
    }
    let existingRow = await db
      .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
      .bind(uid)
      .first<Record<string, unknown>>();
    if (!existingRow) {
      await ensureRentUtilitySettings(db, uid);
      existingRow = await db
        .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
        .bind(uid)
        .first<Record<string, unknown>>();
    }
    const existing = mapRentUtilityRow(existingRow || {});
    const check = checkVersionOrThrow(
      mutation,
      existingRow,
      existing as unknown as Record<string, unknown>,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
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
         WHERE user_id = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
      )
      .bind(
        v.rent6F,
        v.rentA,
        v.rentB,
        v.rentC,
        check.writeTs,
        check.nextVersion,
        uid,
        uid,
        expectedVersion,
        uid,
        expectedEpoch
      );

    await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, writeStmt, [], async () => {
      const row = await db
        .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
        .bind(uid)
        .first<Record<string, unknown>>();
      return {
        row,
        mapped: row ? (mapRentUtilityRow(row) as unknown as Record<string, unknown>) : null,
      };
    }, check.legacyClientTs);
    return;
  }

  if (mutation.entity === 'utility_record') {
    const normalizedPeriod = mutation.recordId.trim();
    // validateUtilityRecordInput truncates period to 20 characters; reject longer keys up front so lookups,
    // writes and sync_lww_timestamps all use the same key (no spurious conflicts on a truncated key).
    if (!normalizedPeriod || normalizedPeriod.length > 20 || normalizedPeriod !== mutation.recordId) {
      throw new RejectError('水電期別鍵值格式不符（不得含前後空白，且長度不得超過 20 字）。');
    }
    if (mutation.op !== 'delete') {
      const pEarly = mutation.payload || {};
      const payloadPeriodEarly =
        pEarly.period !== undefined && pEarly.period !== null ? String(pEarly.period).trim() : '';
      if (payloadPeriodEarly && payloadPeriodEarly !== normalizedPeriod) {
        throw new RejectError(`水電期別鍵值不一致（${normalizedPeriod} vs ${payloadPeriodEarly}）。`);
      }
    }
    const existing = await db
      .prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND period = ?')
      .bind(uid, normalizedPeriod)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapUtilityRecordRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime,
      legacyCompareTs
    );
    if (!check.shouldApply) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
      return;
    }

    const refetchUtil = async () => {
      const row = await db
        .prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND period = ?')
        .bind(uid, normalizedPeriod)
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
        await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch);
        return;
      }
      const delStmt = db
        .prepare(
          `UPDATE rent_utility_records SET deleted_at = ?, updated_at = ?, version = ?, change_seq = ${NEXT_SEQ_SQL} WHERE user_id = ? AND period = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
        )
        .bind(
          check.writeTs,
          check.writeTs,
          check.nextVersion,
          uid,
          uid,
          normalizedPeriod,
          Number(existing.version ?? 1),
          uid,
          expectedEpoch
        );
      await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, delStmt, [], refetchUtil, check.legacyClientTs);
      return;
    }

    const p = mutation.payload || {};
    const v = runValidation(() =>
      validateUtilityRecordInput({
        period: normalizedPeriod,
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
             WHERE user_id = ? AND period = ? AND version = ? AND ${EPOCH_GUARD_SQL}`
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
            v.period,
            Number(existing.version ?? 1),
            uid,
            expectedEpoch
          )
      : db
          .prepare(
            `INSERT INTO rent_utility_records
              (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version, change_seq)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${NEXT_SEQ_SQL}
             WHERE ${EPOCH_GUARD_SQL}
             ON CONFLICT(user_id, period) DO NOTHING`
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
            String(p.createdAt || check.writeTs),
            check.writeTs,
            check.nextVersion,
            uid,
            uid,
            expectedEpoch
          );

    await commitAtomicMutation(db, uid, mutation, serverTime, expectedEpoch, writeStmt, [], refetchUtil, check.legacyClientTs);
    return;
  }

  throw new RejectError(`不支援的同步資料類型：${String(mutation.entity)}`);
}

type DeltaMode = { kind: 'seq'; sinceSeq: number; maxSeq?: number } | { kind: 'since'; since: string } | { kind: 'full' };

/**
 * H5 (v1.8.13): reads a delta (or the full snapshot) together with the user's sync cursor and data epoch in ONE
 * D1 batch. A batch runs as a single transaction, so the rows, the cursor and the epoch are mutually consistent —
 * no concurrent write or replace import can land between them (replaces the separate before/after cursor and
 * epoch reads and the R-4 retry loop). In `seq` mode without `maxSeq` the upper bound is the current change_seq.
 */
async function readDeltaWithState(
  db: D1Database,
  uid: string,
  mode: DeltaMode
): Promise<{ delta: SyncDelta; changeSeq: number; dataEpoch: number }> {
  const coreTables: Array<{ table: string; order: string; liveOnlyWhenFull: boolean }> = [
    { table: 'ledgers', order: 'sort_order ASC, created_at ASC', liveOnlyWhenFull: true },
    { table: 'cashflow_logs', order: 'date DESC', liveOnlyWhenFull: true },
    { table: 'recurring_items', order: 'sort_order ASC, created_at ASC', liveOnlyWhenFull: true },
    { table: 'sinking_fund_items', order: 'sort_order ASC, created_at ASC', liveOnlyWhenFull: true },
    { table: 'asset_items', order: 'sort_order ASC, created_at ASC', liveOnlyWhenFull: true },
    { table: 'savings_adjustments', order: 'date DESC', liveOnlyWhenFull: true },
    { table: 'stock_transactions', order: 'date DESC', liveOnlyWhenFull: true },
    { table: 'networth_history', order: 'year_month DESC', liveOnlyWhenFull: false },
    { table: 'rent_utility_records', order: '', liveOnlyWhenFull: true },
  ];
  const goalTable = { table: 'financial_goals', order: 'sort_order ASC, created_at ASC', liveOnlyWhenFull: true };
  const splitTable = { table: 'split_receivables', order: 'date DESC, created_at DESC', liveOnlyWhenFull: true };
  const upper =
    mode.kind === 'seq' && typeof mode.maxSeq === 'number'
      ? { sql: '?', binds: [mode.maxSeq] as unknown[] }
      : { sql: '(SELECT change_seq FROM user_sync_state WHERE user_id = ?)', binds: [uid] as unknown[] };
  const buildEntityStmt = ({ table, order, liveOnlyWhenFull }: { table: string; order: string; liveOnlyWhenFull: boolean }) => {
    const orderSql = order ? ` ORDER BY ${order}` : '';
    if (mode.kind === 'seq') {
      return db
        .prepare(`SELECT * FROM ${table} WHERE user_id = ? AND change_seq > ? AND change_seq <= ${upper.sql}${orderSql}`)
        .bind(uid, mode.sinceSeq, ...upper.binds);
    }
    if (mode.kind === 'since') {
      return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND updated_at > ?${orderSql}`).bind(uid, mode.since);
    }
    return db
      .prepare(`SELECT * FROM ${table} WHERE user_id = ?${liveOnlyWhenFull ? ' AND deleted_at IS NULL' : ''}${orderSql}`)
      .bind(uid);
  };
  const headerStmts = [
    db.prepare('SELECT change_seq, data_epoch FROM user_sync_state WHERE user_id = ?').bind(uid),
    db.prepare('SELECT * FROM app_settings WHERE user_id = ?').bind(uid),
    db.prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?').bind(uid),
  ];
  const coreStmts = coreTables.map(buildEntityStmt);
  let includeGoals = true;
  let includeSplits = true;
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([...headerStmts, ...coreStmts, buildEntityStmt(goalTable), buildEntityStmt(splitTable)]);
  } catch (err) {
    if (!/no such table:\s*(financial_goals|split_receivables)/i.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
    const existingOpt = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('financial_goals', 'split_receivables')")
      .all<{ name: string }>();
    const optNames = new Set((existingOpt.results || []).map((r) => r.name));
    includeGoals = optNames.has('financial_goals');
    includeSplits = optNames.has('split_receivables');
    const fallbackBatch: D1PreparedStatement[] = [...headerStmts, ...coreStmts];
    if (includeGoals) fallbackBatch.push(buildEntityStmt(goalTable));
    if (includeSplits) fallbackBatch.push(buildEntityStmt(splitTable));
    results = await db.batch(fallbackBatch);
  }
  const rowsOf = (i: number) => (results[i]?.results || []) as Record<string, unknown>[];
  const stateRow = rowsOf(0)[0];
  const settingsRow = rowsOf(1)[0];
  const rentsRow = rowsOf(2)[0];
  const changeSeq = Number(stateRow?.change_seq ?? 0);
  const dataEpoch = Number(stateRow?.data_epoch ?? 1);
  const settings = settingsRow ? mapAppSettingsRow(settingsRow) : null;
  const rents = rentsRow ? mapRentUtilityRow(rentsRow) : null;
  const upperSeq = mode.kind === 'seq' && typeof mode.maxSeq === 'number' ? mode.maxSeq : changeSeq;
  const inSeqWindow = (row: Record<string, unknown> | undefined) => {
    if (!row || mode.kind !== 'seq') return false;
    const seq = Number(row.change_seq ?? 0);
    return seq > mode.sinceSeq && seq <= upperSeq;
  };
  const includeSettings =
    mode.kind === 'full' ? true : mode.kind === 'since' ? Boolean(settings && settings.updatedAt > mode.since) : inSeqWindow(settingsRow);
  const includeRents =
    mode.kind === 'full' ? true : mode.kind === 'since' ? Boolean(rents && rents.updatedAt > mode.since) : inSeqWindow(rentsRow);
  const base = 3;
  let nextIdx = base + 9;
  const goalsRows = includeGoals ? rowsOf(nextIdx++) : [];
  const splitsRows = includeSplits ? rowsOf(nextIdx++) : [];
  const delta: SyncDelta = {
    settings: includeSettings ? settings : null,
    ledgers: rowsOf(base).map(mapLedgerRow),
    cashflowLogs: rowsOf(base + 1).map(mapCashFlowRow),
    recurringItems: rowsOf(base + 2).map(mapRecurringRow),
    sinkingItems: rowsOf(base + 3).map(mapSinkingRow),
    assetItems: rowsOf(base + 4).map(mapAssetRow),
    savingsAdjustments: rowsOf(base + 5).map(mapSavingsAdjustmentRow),
    stockTransactions: rowsOf(base + 6).map(mapStockTransactionRow),
    netWorthHistory: rowsOf(base + 7).map(mapNetWorthRow),
    rentUtilityRecords: rowsOf(base + 8).map(mapUtilityRecordRow),
    rentUtilityRents: includeRents ? rents : null,
    financialGoals: goalsRows.map(mapFinancialGoalRow),
    splitReceivables: splitsRows.map(mapSplitReceivableRow),
  };
  return { delta, changeSeq, dataEpoch };
}

export async function querySyncDelta(
  db: D1Database,
  userId: string,
  since?: string | null,
  sinceSeq?: number | null,
  maxSeq?: number
): Promise<SyncDelta> {
  const uid = assertUserId(userId);
  await ensureSyncBaseline(db, uid);
  const mode: DeltaMode =
    typeof sinceSeq === 'number' && Number.isFinite(sinceSeq)
      ? { kind: 'seq', sinceSeq, ...(typeof maxSeq === 'number' ? { maxSeq } : {}) }
      : since
        ? { kind: 'since', since }
        : { kind: 'full' };
  return (await readDeltaWithState(db, uid, mode)).delta;
}

/** H5: queries reserved for authentication (session lookup / refresh) done before processSyncRequest. */
export const SYNC_AUTH_QUERY_RESERVE = 5;
/** H5: worst case D1 queries one mutation can use (legacy LWW read, row read, commit, and the 0-row diagnosis). */
const PER_MUTATION_QUERY_WORST = 10;
/** H5: queries kept for the response (delta read + a possible full resync). */
const SYNC_TAIL_QUERY_RESERVE = 3;

export async function processSyncRequest(
  rawDb: D1Database,
  userId: string,
  req: SyncRequest,
  opts: { queryBudget?: number } = {}
): Promise<SyncResponse> {
  const uid = assertUserId(userId);
  const serverTime = new Date().toISOString();
  // H5: every D1 call of this request is counted against the per-invocation budget (50 on the Free plan,
  // minus what authentication used). Mutations that do not fit are left unacked for the next request.
  const counter = countD1Queries(rawDb);
  let db = counter.db;
  const queryBudget = Math.max(
    15,
    Math.floor(opts.queryBudget ?? D1_QUERIES_PER_INVOCATION_FREE - SYNC_AUTH_QUERY_RESERVE)
  );
  const baseline = await ensureSyncBaseline(db, uid);
  const settings = baseline.settings;
  const syncStateBefore = { changeSeq: baseline.changeSeq, dataEpoch: baseline.dataEpoch };
  // Review R-A (v1.8.12): apply records before the mutations that reference them (older clients can send a
  // renamed/coalesced account after the cashflow that is linked to it), so the M3 guards do not reject them.
  const mutations = Array.isArray(req.mutations) ? orderMutationsByDependencies(req.mutations) : [];
  const ackedMutationIds: string[] = [];
  const rejected: Array<{ mutationId: string; reason: string }> = [];
  const conflicts: SyncConflict[] = [];

  const buildFullResyncResponse = async (markEpochMismatch: boolean): Promise<SyncResponse> => {
    // Q2 / N2 / R-4: the full snapshot, its cursor and its epoch are read in one D1 batch (one transaction), so
    // they are consistent: a concurrent write lands either before (included) or after (cursor is lower).
    const full = await readDeltaWithState(db, uid, { kind: 'full' });
    return {
      ok: true,
      serverTime,
      syncCursor: full.changeSeq,
      dataEpoch: full.dataEpoch,
      fullResyncRequired: true,
      ...(markEpochMismatch ? { epochMismatch: true } : {}),
      ackedMutationIds,
      rejected,
      conflicts,
      delta: full.delta,
    };
  };

  const hasClientEpoch = typeof req.clientEpoch === 'number' && Number.isFinite(req.clientEpoch);
  const expectedEpoch = hasClientEpoch ? Number(req.clientEpoch) : syncStateBefore.dataEpoch;
  const epochMismatch =
    (hasClientEpoch && req.clientEpoch !== syncStateBefore.dataEpoch) ||
    (!hasClientEpoch && mutations.length > 0 && syncStateBefore.dataEpoch > 1);

  if (epochMismatch) {
    // P2-C4 & Q2/N2: Do NOT dump mutations into rejected[]; return epochMismatch: true + full snapshot
    // with pre-query changeSeq cursor so the client freezes ALL pending outbox items and misses 0 writes.
    return buildFullResyncResponse(true);
  }

  // V1: Harmless write used by clients as evidence that the D1 write path is healthy. If this write fails the
  // whole request fails (5xx), so a client never mistakes a write outage for a broken mutation.
  let writeProbeOk = false;
  if (req.writeProbe === true && mutations.length === 0) {
    await db
      .prepare('UPDATE user_sync_state SET updated_at = ? WHERE user_id = ?')
      .bind(serverTime, uid)
      .run();
    writeProbeOk = true;
  }

  let epochChangedDuringMutations = false;

  const envelopeError = (m: SyncMutation): string | null => {
    const hasValidEnvelope =
      Boolean(m && typeof m === 'object') &&
      typeof m.mutationId === 'string' &&
      m.mutationId.trim().length > 0 &&
      typeof m.entity === 'string' &&
      typeof m.recordId === 'string' &&
      m.recordId.trim().length > 0 &&
      typeof m.op === 'string' &&
      (m.baseVersion === undefined ||
        m.baseVersion === null ||
        (typeof m.baseVersion === 'number' && Number.isInteger(m.baseVersion))) &&
      (m.payload === undefined ||
        m.payload === null ||
        (typeof m.payload === 'object' && !Array.isArray(m.payload))) &&
      (m.atomicGroupId === undefined || m.atomicGroupId === null || typeof m.atomicGroupId === 'string');
    if (!hasValidEnvelope) return 'Invalid mutation format';
    if (!ALLOWED_SYNC_ENTITIES.has(String(m.entity)) || !ALLOWED_SYNC_OPS.has(String(m.op))) {
      return `不支援的同步類型或操作：${String(m.entity)}:${String(m.op)}`;
    }
    return null;
  };

  const isApplied = async (mutationId: string): Promise<boolean> =>
    Boolean(
      await db
        .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
        .bind(uid, mutationId)
        .first()
    );

  /** M4: applies an atomic group; returns true when the request must stop (epoch changed). */
  const processGroup = async (members: SyncMutation[]): Promise<boolean> => {
    const pendingMembers: SyncMutation[] = [];
    for (const m of members) {
      if (alreadyApplied.has(m.mutationId)) ackedMutationIds.push(m.mutationId);
      else pendingMembers.push(m);
    }
    if (pendingMembers.length === 0) return false;
    try {
      await applyMutationGroup(db, uid, pendingMembers, settings, serverTime, expectedEpoch);
      for (const m of pendingMembers) ackedMutationIds.push(m.mutationId);
      return false;
    } catch (err) {
      if (err instanceof EpochMismatchError) {
        epochChangedDuringMutations = true;
        return true;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConstraint =
        /SQLITE_CONSTRAINT|NOT NULL constraint|CHECK constraint|FOREIGN KEY constraint|D1_TYPE_ERROR/i.test(errMsg);
      if (!(err instanceof GroupRejectError) && !isConstraint) {
        console.error('[sync] transient group failure:', pendingMembers.map((m) => `${m.entity}:${m.recordId}`), err);
        throw err;
      }
      // V4: a rejection evaluated against data restored by a concurrent replace import is meaningless
      if ((await getCurrentDataEpoch(db, uid)) !== expectedEpoch) {
        epochChangedDuringMutations = true;
        return true;
      }
      // R1: an identical concurrent retry may have committed the whole group meanwhile
      let allApplied = true;
      for (const m of pendingMembers) {
        if (!(await isApplied(m.mutationId))) {
          allApplied = false;
          break;
        }
      }
      if (allApplied) {
        for (const m of pendingMembers) ackedMutationIds.push(m.mutationId);
        return false;
      }
      const baseReason = err instanceof GroupRejectError ? err.message : '資料格式或欄位約束不符合規範';
      const failedId = err instanceof GroupRejectError ? err.failedMutationId : null;
      for (const m of pendingMembers) {
        rejected.push({
          mutationId: m.mutationId,
          reason:
            failedId === null || failedId === m.mutationId
              ? baseReason
              : `同一筆轉帳的另一筆資料被拒絕（${baseReason}），整筆轉帳未套用`,
        });
      }
      return false;
    }
  };

  // H5: ONE batch tells which mutations were already applied and reads the current row of each mutation
  // (instead of 2 queries per mutation)
  const alreadyApplied = new Set<string>();
  const rowPrefetch: RowPrefetch = new Map();
  if (mutations.length > 0) {
    const valid = mutations.filter(
      (m) => m && typeof m === 'object' && typeof m.mutationId === 'string' && m.mutationId.trim()
    );
    const ids = Array.from(new Set(valid.map((m) => m.mutationId)));
    const stmts: D1PreparedStatement[] = [];
    let idemStatements = 0;
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      stmts.push(
        db
          .prepare(
            `SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id IN (${chunk.map(() => '?').join(', ')})`
          )
          .bind(uid, ...chunk)
      );
      idemStatements += 1;
    }
    const rowKeys: string[] = [];
    for (const m of valid.slice(0, SYNC_MAX_MUTATIONS_PER_REQUEST * 2)) {
      const spec = ENTITY_ROW_TABLE[String(m.entity)];
      if (!spec || typeof m.recordId !== 'string') continue;
      const key = `${spec.table}:${m.recordId}`;
      if (rowKeys.includes(key)) continue;
      rowKeys.push(key);
      stmts.push(
        db.prepare(`SELECT * FROM ${spec.table} WHERE user_id = ? AND ${spec.keyColumn} = ?`).bind(uid, m.recordId)
      );
    }
    if (stmts.length > 0) {
      let results: D1Result<unknown>[];
      let prefetchedRowKeys = rowKeys;
      try {
        results = await db.batch(stmts);
      } catch (err) {
        if (!/no such table:\s*(financial_goals|split_receivables)/i.test(err instanceof Error ? err.message : String(err))) {
          throw err;
        }
        // Pre-migration DB: drop optional post-0020 tables from prefetch so applySingleMutation rejects them cleanly
        const fallbackStmts = stmts.slice(0, idemStatements);
        prefetchedRowKeys = [];
        rowKeys.forEach((key, idx) => {
          if (!key.startsWith('financial_goals:') && !key.startsWith('split_receivables:')) {
            prefetchedRowKeys.push(key);
            fallbackStmts.push(stmts[idemStatements + idx]);
          }
        });
        results = await db.batch(fallbackStmts);
      }
      for (let i = 0; i < idemStatements; i++) {
        for (const r of (results[i]?.results || []) as Array<{ mutation_id: string }>) {
          alreadyApplied.add(String(r.mutation_id));
        }
      }
      prefetchedRowKeys.forEach((key, i) => {
        const row = (results[idemStatements + i]?.results?.[0] ?? null) as Record<string, unknown> | null;
        rowPrefetch.set(key, row);
      });
    }
  }
  db = withRowPrefetch(db, rowPrefetch, req.refsOrdered !== true);

  let processedMutations = 0;
  // H5: before starting a unit, make sure its worst case still fits the query budget (and the per-request
  // mutation cap). The first unit is always processed so every request makes progress.
  // Atomic groups commit all members in a single D1 batch (1 query on success; bounded diagnosis on error).
  const fitsBudget = (unitSize: number, isAtomicGroup = false): boolean => {
    if (processedMutations === 0) return true;
    const worstQueries = isAtomicGroup
      ? Math.min(PER_MUTATION_QUERY_WORST * unitSize, 4 + 3 * unitSize)
      : PER_MUTATION_QUERY_WORST * unitSize;
    return (
      processedMutations + unitSize <= SYNC_MAX_MUTATIONS_PER_REQUEST &&
      counter.used() + worstQueries + SYNC_TAIL_QUERY_RESERVE <= queryBudget
    );
  };

  const handledIdx = new Set<number>();
  for (let idx = 0; idx < mutations.length; idx++) {
    if (handledIdx.has(idx)) continue;
    const mut = mutations[idx];
    const rawId =
      mut && typeof mut === 'object' && typeof mut.mutationId === 'string' && mut.mutationId.trim()
        ? mut.mutationId
        : 'unknown';
    const envErr = envelopeError(mut);
    if (envErr) {
      handledIdx.add(idx);
      rejected.push({ mutationId: rawId, reason: envErr });
      continue;
    }

    const groupKey = groupKeyOf(mut);
    if (groupKey) {
      const memberIdx: number[] = [idx];
      for (let j = idx + 1; j < mutations.length; j++) {
        if (handledIdx.has(j)) continue;
        const other = mutations[j];
        if (!envelopeError(other) && groupKeyOf(other) === groupKey) memberIdx.push(j);
      }
      if (memberIdx.length > 1) {
        const members = memberIdx.map((j) => mutations[j]);
        const pendingCount = members.filter((m) => !alreadyApplied.has(m.mutationId)).length;
        if (pendingCount > 0 && !fitsBudget(pendingCount, true)) break; // H5: leave the rest for the next request
        for (const j of memberIdx) handledIdx.add(j);
        processedMutations += pendingCount;
        if (await processGroup(members)) break;
        continue;
      }
    }

    if (alreadyApplied.has(mut.mutationId)) {
      handledIdx.add(idx);
      ackedMutationIds.push(mut.mutationId);
      continue;
    }
    if (!fitsBudget(1)) break; // H5: leave the rest for the next request
    handledIdx.add(idx);
    processedMutations += 1;

    try {
      await applySingleMutation(db, uid, mut, settings, serverTime, expectedEpoch);
      ackedMutationIds.push(mut.mutationId);
    } catch (err) {
      if (err instanceof EpochMismatchError) {
        // Q5 / N4: Concurrent replace import bumped data_epoch mid-request.
        // Stop immediately so neither this nor any remaining stale-epoch mutation is applied or acked.
        epochChangedDuringMutations = true;
        break;
      }
      if (err instanceof VersionConflictError) {
        // R1: Concurrent duplicate mutationId race — Request A may have committed between our initial
        // sync_idempotency check and our table SELECT, causing checkVersionOrThrow to throw before
        // commitAtomicMutation ran. Re-check sync_idempotency before declaring a false conflict!
        const appliedByRace = await db
          .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
          .bind(uid, mut.mutationId)
          .first();
        if (appliedByRace) {
          ackedMutationIds.push(mut.mutationId);
        } else {
          // Q5 / N4: Also check if epoch changed (e.g. replace import reset row version before checkVersionOrThrow)
          const currEpoch = await getCurrentDataEpoch(db, uid);
          if (currEpoch !== expectedEpoch) {
            epochChangedDuringMutations = true;
            break;
          }
          conflicts.push(err.conflict);
        }
      } else if (err instanceof RejectError) {
        // V4: A rejection evaluated against data restored by a concurrent replace import is meaningless
        // for a stale-epoch client — stop and let the client freeze it instead of dropping it as an error.
        if ((await getCurrentDataEpoch(db, uid)) !== expectedEpoch) {
          epochChangedDuringMutations = true;
          break;
        }
        rejected.push({
          mutationId: mut.mutationId,
          reason: err.message || '資料驗證失敗，伺服器拒絕此筆異動',
        });
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        // R2: Deterministic SQLite/D1 schema/type constraint errors are permanent payload failures,
        // NOT transient infrastructure failures — reject with a sanitized message (never leak SQL text).
        if (
          /SQLITE_CONSTRAINT|NOT NULL constraint|CHECK constraint|FOREIGN KEY constraint|D1_TYPE_ERROR/i.test(
            errMsg
          )
        ) {
          // V4: same epoch re-check as the RejectError branch
          if ((await getCurrentDataEpoch(db, uid)) !== expectedEpoch) {
            epochChangedDuringMutations = true;
            break;
          }
          console.warn('[sync] deterministic constraint rejected:', mut.entity, mut.recordId, errMsg);
          rejected.push({
            mutationId: mut.mutationId,
            reason: '資料格式或欄位約束不符合規範，伺服器拒絕此筆異動',
          });
        } else {
          // S2: Transient / infrastructure error (e.g. D1 overload/timeout) must NOT be treated as permanent rejection
          console.error('[sync] transient mutation failure:', mut.entity, mut.recordId, err);
          throw err;
        }
      }
    }
  }

  if (epochChangedDuringMutations) {
    return buildFullResyncResponse(true);
  }
  const useSeqCursor = typeof req.sinceSeq === 'number' && Number.isFinite(req.sinceSeq);
  const legacySinceAfterReplace =
    !useSeqCursor &&
    Boolean(req.since) &&
    (req.clientEpoch === undefined || req.clientEpoch === null) &&
    syncStateBefore.dataEpoch > 1;
  if (legacySinceAfterReplace) {
    // P2-S2 / P2-S9: never return a partial delta to a legacy `since` client after a replace import
    return buildFullResyncResponse(false);
  }

  // H5: the delta, its cursor and the epoch are read in one batch (one transaction)
  const read = await readDeltaWithState(
    db,
    uid,
    useSeqCursor
      ? { kind: 'seq', sinceSeq: Number(req.sinceSeq) }
      : req.since
        ? { kind: 'since', since: String(req.since) }
        : { kind: 'full' }
  );
  if (read.dataEpoch !== syncStateBefore.dataEpoch) {
    // P2-S2 & Q2/N2: a replace import committed during this request
    return buildFullResyncResponse(true);
  }

  return {
    ok: true,
    serverTime,
    syncCursor: read.changeSeq,
    dataEpoch: read.dataEpoch,
    fullResyncRequired: false,
    ackedMutationIds,
    rejected,
    conflicts,
    delta: read.delta,
    ...(writeProbeOk ? { writeProbeOk: true } : {}),
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
    financialGoals: delta.financialGoals || [],
    splitReceivables: delta.splitReceivables || [],
  };
}

/**
 * v1.8.13 review: ids and timestamps of imported records must be text (or absent) — an object / array / number
 * would otherwise be stored as its JSON text, and `true` ids would collide.
 */
function importText(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`匯入資料格式錯誤：${field} 必須是文字。`);
  return v;
}

/** M13: rows per `INSERT … SELECT … FROM json_each(?)` statement in an import batch */
export const IMPORT_CHUNK_ROWS = 200;

export async function importFullSnapshot(
  db: D1Database,
  userId: string,
  data: Partial<FinanceSnapshot>,
  mode: 'merge' | 'replace' = 'merge'
): Promise<{ importedLogs: number; importedRecurring: number; importedSinking: number; importedAssets: number }> {
  const uid = assertUserId(userId);
  const nowIso = new Date().toISOString();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('匯入資料格式錯誤：內容必須是物件。');
  }
  // M13: every list must be an array of objects; anything else is the client's fault (400), never a TypeError (500)
  for (const field of [
    'ledgers',
    'cashflowLogs',
    'recurringItems',
    'sinkingItems',
    'assetItems',
    'savingsAdjustments',
    'stockTransactions',
    'netWorthHistory',
    'rentUtilityRecords',
    'financialGoals',
    'splitReceivables',
  ] as const) {
    const list = (data as Record<string, unknown>)[field];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new Error(`匯入資料格式錯誤：${field} 必須是陣列。`);
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`匯入資料格式錯誤：${field} 第 ${i + 1} 筆不是物件。`);
      }
    });
  }
  for (const field of ['settings', 'rentUtilityRents'] as const) {
    const v = (data as Record<string, unknown>)[field];
    if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) {
      throw new Error(`匯入資料格式錯誤：${field} 必須是物件。`);
    }
  }
  const { settings: currentSettings, row: ensuredSettingsRow } = await ensureAppSettingsWithRow(db, uid);

  // 1. Pre-validate ALL records in memory BEFORE mutating any database table
  const fxForImport = data.settings
    ? toSafeNumber(data.settings.usdTwdRate, currentSettings.usdTwdRate)
    : currentSettings.usdTwdRate;
  const fxForImportSource = {
    usdTwdRate: fxForImport,
    fxRates: normalizeFxRates(data.settings?.fxRates ?? currentSettings.fxRates, fxForImport),
  };

  const validatedLedgers: Array<{
    id: string;
    v: ReturnType<typeof validateLedgerInput>;
    createdAt: string;
  }> = [];
  for (const lg of data.ledgers || []) {
    if (!lg || lg.deletedAt) continue;
    validatedLedgers.push({
      id: normalizeLedgerId(importText(lg.id, 'id')),
      v: validateLedgerInput(lg),
      createdAt: importText(lg.createdAt, 'createdAt') || nowIso,
    });
  }

  const validatedLogs: Array<{
    id: string;
    v: ReturnType<typeof validateCashFlowInput>;
    createdAt: string;
  }> = [];
  for (const log of data.cashflowLogs || []) {
    validatedLogs.push({
      id: importText(log.id, 'id') || crypto.randomUUID(),
      v: validateCashFlowInput(log, fxForImportSource),
      createdAt: importText(log.createdAt, 'createdAt') || nowIso,
    });
  }

  const validatedRecurring: Array<{
    id: string;
    v: ReturnType<typeof validateRecurringInput>;
    createdAt: string;
  }> = [];
  for (const r of data.recurringItems || []) {
    validatedRecurring.push({
      id: importText(r.id, 'id') || crypto.randomUUID(),
      v: validateRecurringInput(r),
      createdAt: importText(r.createdAt, 'createdAt') || nowIso,
    });
  }

  const validatedSinking: Array<{
    id: string;
    v: ReturnType<typeof validateSinkingInput>;
    createdAt: string;
  }> = [];
  for (const s of data.sinkingItems || []) {
    validatedSinking.push({
      id: importText(s.id, 'id') || crypto.randomUUID(),
      v: validateSinkingInput(s),
      createdAt: importText(s.createdAt, 'createdAt') || nowIso,
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
      id: importText(a.id, 'id') || crypto.randomUUID(),
      v: validateAssetInput(a),
      priceUpdatedAt: importText(a.priceUpdatedAt, 'priceUpdatedAt') || null,
      createdAt: importText(a.createdAt, 'createdAt') || nowIso,
    });
  }

  const validatedAdjs: Array<{
    id: string;
    v: ReturnType<typeof validateSavingsAdjustmentInput>;
    twdAmount: number;
    createdAt: string;
  }> = [];
  for (const adj of data.savingsAdjustments || []) {
    const v = validateSavingsAdjustmentInput(adj, fxForImportSource);
    validatedAdjs.push({
      id: importText(adj.id, 'id') || crypto.randomUUID(),
      v,
      twdAmount: adj.twdAmount !== undefined ? Math.round(adj.twdAmount) : v.twdAmount,
      createdAt: importText(adj.createdAt, 'createdAt') || nowIso,
    });
  }

  const validatedStockTxs: Array<{
    id: string;
    v: ReturnType<typeof validateStockTransactionInput>;
    createdAt: string;
  }> = [];
  for (const tx of data.stockTransactions || []) {
    validatedStockTxs.push({
      id: importText(tx.id, 'id') || crypto.randomUUID(),
      v: validateStockTransactionInput(tx),
      createdAt: importText(tx.createdAt, 'createdAt') || nowIso,
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
      createdAt: importText(u.createdAt, 'createdAt') || nowIso,
    });
  }

  // M3: every ledger reference must resolve to the default ledger, a ledger in this import, or (merge mode) an
  // active ledger already on the server — otherwise the money would silently drop out of every total.
  // Asset references (linked account / adjustment account / stock asset) are not rejected here: exports legitimately
  // contain records whose account was deleted earlier (those rows are inert), and refusing them would make such
  // backups impossible to restore. New dangling asset references are blocked on the sync write path instead.
  {
    const knownLedgers = new Set<string>([DEFAULT_LEDGER_ID, ...validatedLedgers.map((l) => l.id)]);
    if (mode === 'merge') {
      const existingLedgers = await db
        .prepare('SELECT id FROM ledgers WHERE user_id = ? AND deleted_at IS NULL')
        .bind(uid)
        .all<{ id: string }>();
      for (const r of existingLedgers.results || []) knownLedgers.add(String(r.id));
    }
    const dangling: string[] = [];
    const checkLedger = (kind: string, id: string, ledgerId: string) => {
      if (!knownLedgers.has(normalizeLedgerId(ledgerId))) dangling.push(`${kind} ${id} → ${ledgerId}`);
    };
    for (const r of validatedLogs) checkLedger('流水帳', r.id, r.v.ledgerId);
    for (const r of validatedRecurring) checkLedger('常態收支', r.id, r.v.ledgerId);
    for (const r of validatedAssets) checkLedger('資產', r.id, r.v.ledgerId);
    if (dangling.length > 0) {
      throw new Error(
        `匯入資料中有 ${dangling.length} 筆紀錄指向不存在的帳本（例如：${dangling.slice(0, 3).join('、')}），請先確認帳本資料後再匯入。`
      );
    }
  }

  const validatedHistory = (data.netWorthHistory || []).map((h, i) => {
    const ym = typeof h.yearMonth === 'string' ? h.yearMonth.trim() : '';
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`匯入資料格式錯誤：netWorthHistory 第 ${i + 1} 筆的年月無效。`);
    const num = (v: unknown) => Math.round(toSafeNumber(v, 0));
    return {
      yearMonth: ym,
      snapshotDate: typeof h.snapshotDate === 'string' ? h.snapshotDate : `${ym}-01`,
      totalAssets: num(h.totalAssets),
      totalLiabilities: num(h.totalLiabilities),
      netWorth: num(h.netWorth),
      highLiquidityAssets: num(h.highLiquidityAssets),
      investmentAssets: num(h.investmentAssets),
      insuranceAssets: num(h.insuranceAssets),
      monthlyIncome: num(h.monthlyIncome),
      monthlyConsumption: num(h.monthlyConsumption),
      savingsRate: toSafeNumber(h.savingsRate, 0),
      note: typeof h.note === 'string' ? h.note : '',
    };
  });

  const validatedGoals: Array<{
    id: string;
    v: ReturnType<typeof validateFinancialGoalInput>;
    createdAt: string;
  }> = [];
  for (const g of data.financialGoals || []) {
    if (!g || g.deletedAt) continue;
    validatedGoals.push({
      id: importText(g.id, 'id') || crypto.randomUUID(),
      v: validateFinancialGoalInput(g),
      createdAt: importText(g.createdAt, 'createdAt') || nowIso,
    });
  }

  const validatedSplits: Array<{
    id: string;
    v: ReturnType<typeof validateSplitReceivableInput>;
    createdAt: string;
  }> = [];
  for (const sp of data.splitReceivables || []) {
    if (!sp || sp.deletedAt) continue;
    validatedSplits.push({
      id: importText(sp.id, 'id') || crypto.randomUUID(),
      v: validateSplitReceivableInput(sp, fxForImportSource),
      createdAt: importText(sp.createdAt, 'createdAt') || nowIso,
    });
  }

  const optTablesRes = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('financial_goals', 'split_receivables')")
    .all<{ name: string }>();
  const optTables = new Set((optTablesRes.results || []).map((r) => r.name));
  const hasGoalsTable = optTables.has('financial_goals');
  const hasSplitsTable = optTables.has('split_receivables');
  if (!hasGoalsTable && validatedGoals.length > 0) {
    throw new Error(
      '伺服器資料庫尚未完成升級（缺少財務目標資料表），請先執行資料庫遷移後再匯入備份。'
    );
  }
  if (!hasSplitsTable && validatedSplits.length > 0) {
    throw new Error(
      '伺服器資料庫尚未完成升級（缺少代墊／拆帳資料表），請先執行 0023 資料庫遷移後再匯入備份。'
    );
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
    if (hasGoalsTable) {
      stmts.push(db.prepare('DELETE FROM financial_goals WHERE user_id = ?').bind(uid));
    }
    if (hasSplitsTable) {
      stmts.push(db.prepare('DELETE FROM split_receivables WHERE user_id = ?').bind(uid));
    }
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
          `INSERT INTO ledgers
            (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ${CURR_SEQ_SQL})
           ON CONFLICT(user_id, id) DO UPDATE SET
             name = excluded.name,
             include_in_net_worth = excluded.include_in_net_worth,
             monthly_daily_budget = excluded.monthly_daily_budget,
             note = excluded.note,
             sort_order = excluded.sort_order,
             updated_at = excluded.updated_at,
             version = ledgers.version + 1,
             change_seq = excluded.change_seq
           WHERE ledgers.deleted_at IS NULL`
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
          uid
        )
    );
  }

  if (data.settings) {
    const existingSettingsRow =
      ensuredSettingsRow ??
      (await db
        .prepare('SELECT * FROM app_settings WHERE user_id = ?')
        .bind(uid)
        .first<Record<string, unknown>>());
    const customStockCategories = normalizeCustomStockCategories(
      data.settings.customStockCategories ?? currentSettings.customStockCategories
    );
    const rebalanceTargets = normalizeRebalanceTargets(
      data.settings.rebalanceTargets ?? (mode === 'replace' ? [] : currentSettings.rebalanceTargets)
    );
    const customCategories = normalizeCustomCategories(
      data.settings.customCategories ?? (mode === 'replace' ? {} : currentSettings.customCategories)
    );
    const quickTemplates = normalizeQuickTemplates(
      data.settings.quickTemplates ?? (mode === 'replace' ? [] : currentSettings.quickTemplates)
    );
    const enabledCurrencies = normalizeEnabledCurrencies(
      data.settings.enabledCurrencies ?? (mode === 'replace' ? ['TWD', 'USD'] : currentSettings.enabledCurrencies)
    );
    const fxRates = normalizeFxRates(
      data.settings.fxRates ?? (mode === 'replace' ? { USD: fxForImport } : currentSettings.fxRates),
      fxForImport
    );
    const autoFxEnabled =
      data.settings.autoFxEnabled !== undefined
        ? Boolean(data.settings.autoFxEnabled)
        : currentSettings.autoFxEnabled !== undefined
          ? currentSettings.autoFxEnabled
          : true;

    const optionalImportCols: Array<{
      col: string;
      hasNonDefaultPayload: boolean;
      value: string;
      label: string;
    }> = [
      {
        col: 'rebalance_targets_json',
        hasNonDefaultPayload: data.settings.rebalanceTargets !== undefined && rebalanceTargets.length > 0,
        value: JSON.stringify(rebalanceTargets),
        label: '再平衡目標',
      },
      {
        col: 'custom_categories_json',
        hasNonDefaultPayload:
          data.settings.customCategories !== undefined && Object.keys(customCategories).length > 0,
        value: JSON.stringify(customCategories),
        label: '自訂分類',
      },
      {
        col: 'quick_templates_json',
        hasNonDefaultPayload: data.settings.quickTemplates !== undefined && quickTemplates.length > 0,
        value: JSON.stringify(quickTemplates),
        label: '快速記帳範本',
      },
      {
        col: 'enabled_currencies_json',
        hasNonDefaultPayload:
          data.settings.enabledCurrencies !== undefined &&
          (enabledCurrencies.length !== 2 || enabledCurrencies[0] !== 'TWD' || enabledCurrencies[1] !== 'USD'),
        value: JSON.stringify(enabledCurrencies),
        label: '多幣別清單',
      },
      {
        col: 'fx_rates_json',
        hasNonDefaultPayload:
          data.settings.fxRates !== undefined && Object.keys(fxRates).some((k) => k !== 'USD'),
        value: JSON.stringify(fxRates),
        label: '多幣別匯率',
      },
    ];
    const importExtraCols: string[] = [];
    const importExtraVals: unknown[] = [];
    for (const opt of optionalImportCols) {
      if (!existingSettingsRow || opt.col in existingSettingsRow) {
        importExtraCols.push(`${opt.col} = ?`);
        importExtraVals.push(opt.value);
      } else if (opt.hasNonDefaultPayload) {
        throw new Error(
          `伺服器資料庫尚未完成升級（缺少「${opt.label}」欄位），請先執行資料庫遷移後再匯入備份。`
        );
      }
    }
    const importExtraSql = importExtraCols.length ? `, ${importExtraCols.join(', ')}` : '';
    stmts.push(
      db
        .prepare(
          `UPDATE app_settings
           SET monthly_daily_budget = ?, emergency_target_months = ?, usd_twd_rate = ?, auto_fx_enabled = ?, pnl_color_scheme = ?, custom_stock_categories = ?${importExtraSql}, updated_at = ?, version = version + 1, change_seq = ${CURR_SEQ_SQL}
           WHERE user_id = ?`
        )
        .bind(
          Math.max(0, Math.round(toSafeNumber(data.settings.monthlyDailyBudget, currentSettings.monthlyDailyBudget))),
          Math.min(60, Math.max(1, Math.round(toSafeNumber(data.settings.emergencyTargetMonths, currentSettings.emergencyTargetMonths)))),
          fxForImport,
          autoFxEnabled ? 1 : 0,
          normalizePnlColorScheme(data.settings.pnlColorScheme ?? currentSettings.pnlColorScheme),
          JSON.stringify(customStockCategories),
          ...importExtraVals,
          nowIso,
          uid,
          uid
        )
    );
  }

  // M13 (v1.8.13): rows are written in chunks of IMPORT_CHUNK_ROWS through `INSERT … SELECT … FROM json_each(?)`,
  // and every chunk is part of the SAME single D1 batch as the deletes / epoch bump above — a large import is a
  // bounded number of statements and either lands completely or not at all.
  const chunked = (
    insertHead: string,
    jsonColumns: number,
    tail: string,
    conflict: string,
    rows: unknown[][]
  ): { start: number; end: number } => {
    const start = stmts.length;
    const selectCols = Array.from({ length: jsonColumns }, (_, i) => `json_extract(value, '$[${i}]')`).join(', ');
    for (let i = 0; i < rows.length; i += IMPORT_CHUNK_ROWS) {
      const chunk = rows.slice(i, i + IMPORT_CHUNK_ROWS);
      stmts.push(
        db
          .prepare(`${insertHead} SELECT ?, ${selectCols}, ${tail} FROM json_each(?) WHERE true ${conflict}`)
          .bind(uid, uid, JSON.stringify(chunk))
      );
    }
    return { start, end: stmts.length };
  };
  const tailLive = `NULL, 1, ${CURR_SEQ_SQL}`;

  const logsRange = chunked(
    `INSERT INTO cashflow_logs
      (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, linked_account_id, ledger_id, created_at, updated_at, deleted_at, version, change_seq)`,
    16,
    tailLive,
    `ON CONFLICT(user_id, id) DO UPDATE SET
       date = excluded.date, year_month = excluded.year_month, type = excluded.type, category = excluded.category,
       item_name = excluded.item_name, amount = excluded.amount, currency = excluded.currency, fx_rate = excluded.fx_rate,
       twd_amount = excluded.twd_amount, source = excluded.source, note = excluded.note,
       linked_account_id = excluded.linked_account_id, ledger_id = excluded.ledger_id, updated_at = excluded.updated_at,
       version = cashflow_logs.version + 1, change_seq = excluded.change_seq
     WHERE cashflow_logs.deleted_at IS NULL`,
    validatedLogs.map(({ id, v, createdAt }) => [
      id, v.date, v.yearMonth, v.type, v.category, v.itemName, v.amount, v.currency, v.fxRate, v.twdAmount,
      v.source, v.note, v.linkedAccountId, v.ledgerId, createdAt, nowIso,
    ])
  );

  // v1.13.1: post_day only when migration 0022 is applied; without it a non-default day fails the import loudly
  const recurringPostDayCol = await hasRecurringPostDayColumn(db);
  if (!recurringPostDayCol && validatedRecurring.some((r) => r.v.postDay !== 1)) {
    throw new Error('伺服器資料庫尚未完成升級（缺少「入帳日」欄位），請先執行資料庫遷移後再匯入備份。');
  }
  const recurringRange = chunked(
    `INSERT INTO recurring_items
      (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, ledger_id, sort_order, created_at, updated_at${recurringPostDayCol ? ', post_day' : ''}, deleted_at, version, change_seq)`,
    recurringPostDayCol ? 16 : 15,
    tailLive,
    `ON CONFLICT(user_id, id) DO UPDATE SET
       item_name = excluded.item_name, category = excluded.category, type = excluded.type, amount = excluded.amount,
       currency = excluded.currency, cycle = excluded.cycle, billing_spec = excluded.billing_spec, status = excluded.status,
       note = excluded.note, linked_account_id = excluded.linked_account_id, ledger_id = excluded.ledger_id,
       sort_order = excluded.sort_order, updated_at = excluded.updated_at,${recurringPostDayCol ? ' post_day = excluded.post_day,' : ''}
       version = recurring_items.version + 1, change_seq = excluded.change_seq
     WHERE recurring_items.deleted_at IS NULL`,
    validatedRecurring.map(({ id, v, createdAt }) => [
      id, v.itemName, v.category, v.type, v.amount, v.currency, v.cycle, v.billingSpec, v.status, v.note,
      v.linkedAccountId, v.ledgerId, v.sortOrder, createdAt, nowIso,
      ...(recurringPostDayCol ? [v.postDay] : []),
    ])
  );

  const sinkingRange = chunked(
    `INSERT INTO sinking_fund_items
      (user_id, id, item_name, category, total_amount, months, due_note, status, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)`,
    11,
    tailLive,
    `ON CONFLICT(user_id, id) DO UPDATE SET
       item_name = excluded.item_name, category = excluded.category, total_amount = excluded.total_amount,
       months = excluded.months, due_note = excluded.due_note, status = excluded.status, note = excluded.note,
       sort_order = excluded.sort_order, updated_at = excluded.updated_at,
       version = sinking_fund_items.version + 1, change_seq = excluded.change_seq
     WHERE sinking_fund_items.deleted_at IS NULL`,
    validatedSinking.map(({ id, v, createdAt }) => [
      id, v.itemName, v.category, v.totalAmount, v.months, v.dueNote, v.status, v.note, v.sortOrder, createdAt, nowIso,
    ])
  );

  const assetsRange = chunked(
    `INSERT INTO asset_items
      (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, previous_close, cost_basis, price_updated_at, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, sort_order, stock_category, is_watchlist, ledger_id, exclude_from_net_worth, created_at, updated_at, deleted_at, version, change_seq)`,
    29,
    tailLive,
    `ON CONFLICT(user_id, id) DO UPDATE SET
       update_mode = excluded.update_mode, major_type = excluded.major_type, sub_category = excluded.sub_category,
       liquidity = excluded.liquidity, item_name = excluded.item_name, ticker = excluded.ticker,
       quantity_or_amount = excluded.quantity_or_amount, currency = excluded.currency, unit_price = excluded.unit_price,
       previous_close = excluded.previous_close, cost_basis = excluded.cost_basis,
       price_updated_at = excluded.price_updated_at, note = excluded.note, is_linked_savings = excluded.is_linked_savings,
       balance_anchor_date = excluded.balance_anchor_date, balance_anchor_at = excluded.balance_anchor_at,
       is_default_savings = excluded.is_default_savings, is_amortizing_loan = excluded.is_amortizing_loan,
       loan_annual_rate = excluded.loan_annual_rate, loan_monthly_payment = excluded.loan_monthly_payment,
       loan_billing_day = excluded.loan_billing_day, sort_order = excluded.sort_order,
       stock_category = excluded.stock_category, is_watchlist = excluded.is_watchlist, ledger_id = excluded.ledger_id,
       exclude_from_net_worth = excluded.exclude_from_net_worth, updated_at = excluded.updated_at,
       version = asset_items.version + 1, change_seq = excluded.change_seq
     WHERE asset_items.deleted_at IS NULL`,
    validatedAssets.map(({ id, v, priceUpdatedAt, createdAt }) => [
      id, v.updateMode, v.majorType, v.subCategory, v.liquidity, v.itemName, v.ticker, v.quantityOrAmount, v.currency,
      v.unitPrice, v.previousClose, v.costBasis, priceUpdatedAt, v.note, v.isLinkedSavings ? 1 : 0,
      v.balanceAnchorDate, v.balanceAnchorAt, v.isDefaultSavings ? 1 : 0, v.isAmortizingLoan ? 1 : 0,
      v.loanAnnualRate, v.loanMonthlyPayment, v.loanBillingDay, v.sortOrder, v.stockCategory, v.isWatchlist ? 1 : 0,
      v.ledgerId, v.excludeFromNetWorth ? 1 : 0, createdAt, nowIso,
    ])
  );

  chunked(
    `INSERT INTO savings_adjustments
      (user_id, id, account_id, date, amount, twd_amount, note, transfer_group_id, created_at, updated_at, deleted_at, version, change_seq)`,
    9,
    tailLive,
    `ON CONFLICT(user_id, id) DO UPDATE SET
       account_id = excluded.account_id, date = excluded.date, amount = excluded.amount,
       twd_amount = excluded.twd_amount, note = excluded.note, transfer_group_id = excluded.transfer_group_id,
       updated_at = excluded.updated_at, version = savings_adjustments.version + 1, change_seq = excluded.change_seq
     WHERE savings_adjustments.deleted_at IS NULL`,
    validatedAdjs.map(({ id, v, twdAmount, createdAt }) => [
      id, v.accountId, v.date, v.amount, twdAmount, v.note, v.transferGroupId, createdAt, nowIso,
    ])
  );

  chunked(
    `INSERT INTO stock_transactions
      (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version, change_seq)`,
    11,
    tailLive,
    `ON CONFLICT(user_id, id) DO UPDATE SET
       asset_id = excluded.asset_id, date = excluded.date, tx_type = excluded.tx_type, shares = excluded.shares,
       total_amount = excluded.total_amount, fee = excluded.fee, linked_cashflow_id = excluded.linked_cashflow_id,
       note = excluded.note, updated_at = excluded.updated_at,
       version = stock_transactions.version + 1, change_seq = excluded.change_seq
     WHERE stock_transactions.deleted_at IS NULL`,
    validatedStockTxs.map(({ id, v, createdAt }) => [
      id, v.assetId, v.date, v.txType, v.shares, v.totalAmount, v.fee, v.linkedCashflowId, v.note, createdAt, nowIso,
    ])
  );

  chunked(
    `INSERT OR REPLACE INTO networth_history
      (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq)`,
    13,
    CURR_SEQ_SQL,
    '',
    validatedHistory.map((h) => [
      h.yearMonth, h.snapshotDate, h.totalAssets, h.totalLiabilities, h.netWorth, h.highLiquidityAssets,
      h.investmentAssets, h.insuranceAssets, h.monthlyIncome, h.monthlyConsumption, h.savingsRate, h.note, nowIso,
    ])
  );

  if (validatedUtilityRents) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, 1, ${CURR_SEQ_SQL})
           ON CONFLICT(user_id) DO UPDATE SET
             rent_6f = excluded.rent_6f,
             rent_a = excluded.rent_a,
             rent_b = excluded.rent_b,
             rent_c = excluded.rent_c,
             updated_at = excluded.updated_at,
             version = rent_utility_settings.version + 1,
             change_seq = excluded.change_seq`
        )
        .bind(
          uid,
          validatedUtilityRents.rent6F,
          validatedUtilityRents.rentA,
          validatedUtilityRents.rentB,
          validatedUtilityRents.rentC,
          nowIso,
          uid
        )
    );
  }

  chunked(
    `INSERT INTO rent_utility_records
      (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version, change_seq)`,
    13,
    tailLive,
    `ON CONFLICT(user_id, period) DO UPDATE SET
       is_baseline = excluded.is_baseline, cur_total = excluded.cur_total, cur_6f = excluded.cur_6f,
       total_elec = excluded.total_elec, total_water = excluded.total_water, f6_people = excluded.f6_people,
       f5_people = excluded.f5_people, cur_a = excluded.cur_a, cur_b = excluded.cur_b, cur_c = excluded.cur_c,
       updated_at = excluded.updated_at, version = rent_utility_records.version + 1, change_seq = excluded.change_seq
     WHERE rent_utility_records.deleted_at IS NULL`,
    validatedUtilityRecords.map(({ v, createdAt }) => [
      v.period, v.isBaseline ? 1 : 0, v.curTotal, v.cur6F, v.totalElec, v.totalWater, v.f6People, v.f5People,
      v.curA, v.curB, v.curC, createdAt, nowIso,
    ])
  );

  if (hasGoalsTable && validatedGoals.length > 0) {
    chunked(
      `INSERT INTO financial_goals
        (user_id, id, name, goal_type, target_amount, currency, linked_ledger_id, linked_asset_ids_json, current_manual_amount, expected_annual_return_pct, monthly_contribution_override, fire_swr_pct, target_date, sort_order, note, created_at, updated_at, deleted_at, version, change_seq)`,
      16,
      tailLive,
      `ON CONFLICT(user_id, id) DO UPDATE SET
         name = excluded.name, goal_type = excluded.goal_type, target_amount = excluded.target_amount,
         currency = excluded.currency, linked_ledger_id = excluded.linked_ledger_id,
         linked_asset_ids_json = excluded.linked_asset_ids_json, current_manual_amount = excluded.current_manual_amount,
         expected_annual_return_pct = excluded.expected_annual_return_pct,
         monthly_contribution_override = excluded.monthly_contribution_override,
         fire_swr_pct = excluded.fire_swr_pct, target_date = excluded.target_date,
         sort_order = excluded.sort_order, note = excluded.note, updated_at = excluded.updated_at,
         version = financial_goals.version + 1, change_seq = excluded.change_seq
       WHERE financial_goals.deleted_at IS NULL`,
      validatedGoals.map(({ id, v, createdAt }) => [
        id,
        v.name,
        v.goalType,
        v.targetAmount,
        v.currency,
        v.linkedLedgerId,
        JSON.stringify(v.linkedAssetIds),
        v.currentManualAmount,
        v.expectedAnnualReturnPct,
        v.monthlyContributionOverride,
        v.fireSwrPct,
        v.targetDate,
        v.sortOrder,
        v.note,
        createdAt,
        nowIso,
      ])
    );
  }

  if (hasSplitsTable && validatedSplits.length > 0) {
    chunked(
      `INSERT INTO split_receivables
        (user_id, id, ledger_id, split_group_id, counterparty, date, item_name, category, amount, settled_amount, currency, fx_rate, twd_amount, status, source_cashflow_id, source_account_id, source_adjustment_id, note, created_at, updated_at, deleted_at, version, change_seq)`,
      19,
      tailLive,
      `ON CONFLICT(user_id, id) DO UPDATE SET
         ledger_id = excluded.ledger_id, split_group_id = excluded.split_group_id, counterparty = excluded.counterparty,
         date = excluded.date, item_name = excluded.item_name, category = excluded.category,
         amount = excluded.amount, settled_amount = excluded.settled_amount, currency = excluded.currency,
         fx_rate = excluded.fx_rate, twd_amount = excluded.twd_amount, status = excluded.status,
         source_cashflow_id = excluded.source_cashflow_id, source_account_id = excluded.source_account_id,
         source_adjustment_id = excluded.source_adjustment_id, note = excluded.note, updated_at = excluded.updated_at,
         version = split_receivables.version + 1, change_seq = excluded.change_seq
       WHERE split_receivables.deleted_at IS NULL`,
      validatedSplits.map(({ id, v, createdAt }) => [
        id,
        v.ledgerId,
        v.splitGroupId,
        v.counterparty,
        v.date,
        v.itemName,
        v.category,
        v.amount,
        v.settledAmount,
        v.currency,
        v.fxRate,
        v.twdAmount,
        v.status,
        v.sourceCashflowId,
        v.sourceAccountId,
        v.sourceAdjustmentId,
        v.note,
        createdAt,
        nowIso,
      ])
    );
  }

  const results = stmts.length > 0 ? await db.batch(stmts) : [];
  // Count rows actually written: merge mode skips rows that are soft-deleted on the server
  // (ON CONFLICT ... WHERE deleted_at IS NULL), and those must not be reported as imported.
  const countChanged = (range: { start: number; end: number }) => {
    let n = 0;
    for (let i = range.start; i < range.end; i++) n += Number(results[i]?.meta?.changes ?? 0);
    return n;
  };

  return {
    importedLogs: countChanged(logsRange),
    importedRecurring: countChanged(recurringRange),
    importedSinking: countChanged(sinkingRange),
    importedAssets: countChanged(assetsRange),
  };
}
