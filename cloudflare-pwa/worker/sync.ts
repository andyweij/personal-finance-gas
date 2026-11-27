import { normalizeRecurringPostDay } from '../shared/recurring';
import { atomicGroupKeyOf, orderMutationsByDependencies } from '../shared/syncOrder';
import type { FxRateSource } from '../shared/currency';
import { countD1Queries } from './d1Budget';
import { isMissingSharedLedgerTableError } from './sharedLedgers';
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
  type ColumnAssignment,
  type DeltaQueryMode,
} from './entityRegistry';
import {
  DEFAULT_EMERGENCY_MONTHS,
  DEFAULT_LEDGER_ID,
  DEFAULT_LEDGER_NAME,
  D1_QUERIES_PER_INVOCATION_FREE,
  SHARED_LEDGER_ENTITY_SET,
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
  InstallmentPlan,
  InstallmentPlanStatus,
  Ledger,
  NetWorthHistory,
  RecurringItem,
  RentUtilityRecord,
  RentUtilityRents,
  SavingsAdjustment,
  SharedLedgerRole,
  SharedLedgerSyncState,
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
  validateInstallmentPlanInput,
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

export interface RawLedgerMembership {
  ledger_id: string;
  owner_user_id: string;
  role: SharedLedgerRole;
  include_in_net_worth: number;
  revoked_at: string | null;
}

/**
 * H5 (v1.8.13): creates the per-user baseline rows (sync state, settings, rent settings, default ledger) if
 * missing and reads them back — all in ONE D1 call, instead of 4–6 separate ensure* round trips per request.
 * Phase 9 (v2.0.0): also reads `ledger_members` in the same batch (+0 D1 calls for users without shared ledgers).
 */
export async function ensureSyncBaseline(
  db: D1Database,
  userId: string
): Promise<{
  settings: AppSettings;
  rents: RentUtilityRents;
  changeSeq: number;
  dataEpoch: number;
  memberships: RawLedgerMembership[];
  hasSharedLedgerSchema: boolean;
}> {
  const uid = assertUserId(userId);
  const nowIso = new Date().toISOString();
  const bump = () =>
    db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
      .bind(nowIso, uid);
  const baseStmts = [
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
  ];

  let results: D1Result<unknown>[];
  let hasSharedLedgerSchema = true;
  try {
    results = await db.batch([
      ...baseStmts,
      db
        .prepare(
          `SELECT lm.ledger_id, lm.owner_user_id, lm.role, lm.include_in_net_worth,
                  COALESCE(lm.revoked_at, CASE WHEN l.id IS NULL THEN lm.updated_at END) AS revoked_at
           FROM ledger_members lm
           LEFT JOIN ledgers l ON l.user_id = lm.owner_user_id AND l.id = lm.ledger_id AND l.deleted_at IS NULL
           WHERE lm.member_user_id = ?`
        )
        .bind(uid),
    ]);
  } catch (err) {
    if (!isMissingSharedLedgerTableError(err)) throw err;
    hasSharedLedgerSchema = false;
    results = await db.batch(baseStmts);
  }
  const settingsRow = (results[7]?.results?.[0] ?? null) as Record<string, unknown> | null;
  const rentsRow = (results[8]?.results?.[0] ?? null) as Record<string, unknown> | null;
  const stateRow = (results[9]?.results?.[0] ?? null) as Record<string, unknown> | null;
  if (!settingsRow || !rentsRow || !stateRow) throw new Error('sync baseline rows could not be read');
  const memberships = hasSharedLedgerSchema
    ? ((results[10]?.results || []) as RawLedgerMembership[])
    : [];
  return {
    settings: mapAppSettingsRow(settingsRow),
    rents: mapRentUtilityRow(rentsRow),
    changeSeq: Number(stateRow.change_seq ?? 0),
    dataEpoch: Number(stateRow.data_epoch ?? 1),
    memberships,
    hasSharedLedgerSchema,
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
    installmentPlanId: r.installment_plan_id ? String(r.installment_plan_id) : null,
    installmentSeq:
      r.installment_seq !== null && r.installment_seq !== undefined ? Number(r.installment_seq) : null,
    ...(r.updated_by ? { updatedByUserId: String(r.updated_by) } : {}),
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
    ...(r.updated_by ? { updatedByUserId: String(r.updated_by) } : {}),
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
    // v2.1.0 (0026): before the migration these columns are absent → legacy (unscheduled) item
    startYm: r.start_ym ? String(r.start_ym) : null,
    repeatYearly: Number(r.repeat_yearly ?? 0) === 1,
    fundKind: r.fund_kind === 'amortize' ? 'amortize' : 'save_first',
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
    ...(r.updated_by ? { updatedByUserId: String(r.updated_by) } : {}),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    version: Number(r.version ?? 1),
  };
}

function mapInstallmentPlanRow(r: Record<string, unknown>): InstallmentPlan {
  return {
    id: String(r.id),
    ledgerId: normalizeLedgerId(r.ledger_id),
    cardAccountId: r.card_account_id ? String(r.card_account_id) : null,
    itemName: String(r.item_name),
    category: String(r.category || '其他'),
    totalAmount: Number(r.total_amount),
    totalInstallments: Number(r.total_installments),
    postedInstallments: Number(r.posted_installments ?? 0),
    startYm: String(r.start_ym),
    postDay: Number(r.post_day ?? 1),
    currency: String(r.currency || 'TWD'),
    status: String(r.status || 'active') as InstallmentPlanStatus,
    note: String(r.note || ''),
    ...(r.updated_by ? { updatedByUserId: String(r.updated_by) } : {}),
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
    isCreditCard: Number(r.is_credit_card || 0) === 1,
    creditBillingDay:
      r.credit_billing_day !== null && r.credit_billing_day !== undefined
        ? Number(r.credit_billing_day)
        : null,
    creditDueDay:
      r.credit_due_day !== null && r.credit_due_day !== undefined ? Number(r.credit_due_day) : null,
    creditLimit:
      r.credit_limit !== null && r.credit_limit !== undefined ? Number(r.credit_limit) : null,
    stockCategory: String(r.stock_category || ''),
    isWatchlist: Number(r.is_watchlist || 0) === 1,
    ledgerId: normalizeLedgerId(r.ledger_id),
    excludeFromNetWorth: Number(r.exclude_from_net_worth || 0) === 1,
    sortOrder: Number(r.sort_order ?? 0),
    ...(r.updated_by ? { updatedByUserId: String(r.updated_by) } : {}),
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
    ...(r.updated_by ? { updatedByUserId: String(r.updated_by) } : {}),
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
  /** Phase 9 (SL-4): when set on an asset ref inside a shared ledger, the asset MUST live in this exact ledger. */
  requiredLedgerId?: string;
  /**
   * aa75631 review R1: an asset reference a member's write keeps or removes must not point at a LIVE account of
   * ANOTHER ledger (that would change the owner's private balance). A deleted account, or one in the same ledger,
   * is fine — otherwise records linked to a since-deleted account could never be edited or deleted again.
   */
  forbidLiveOutsideLedgerId?: string;
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
    if (ref.kind === 'asset' && ref.forbidLiveOutsideLedgerId) {
      sql += ` AND NOT EXISTS (SELECT 1 FROM asset_items WHERE user_id = ? AND id = ? AND ledger_id != ? AND deleted_at IS NULL)`;
      binds.push(uid, ref.id, ref.forbidLiveOutsideLedgerId);
    } else if (ref.kind === 'asset' && ref.requiredLedgerId) {
      // SL-4: cross-tenant shared writes NEVER allow lenient mode and MUST stay within the same shared ledger
      sql += ` AND EXISTS (SELECT 1 FROM asset_items WHERE user_id = ? AND id = ? AND ledger_id = ? AND deleted_at IS NULL)`;
      binds.push(uid, ref.id, ref.requiredLedgerId);
    } else if (lenient) {
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
    if (ref.kind === 'asset' && ref.forbidLiveOutsideLedgerId) {
      const row = await db
        .prepare('SELECT id FROM asset_items WHERE user_id = ? AND id = ? AND ledger_id != ? AND deleted_at IS NULL')
        .bind(uid, ref.id, ref.forbidLiveOutsideLedgerId)
        .first();
      if (row) {
        throw new RejectError('此紀錄連動至共同帳本以外的帳戶，僅帳本擁有者可修改或刪除。');
      }
      continue;
    }
    if (ref.kind === 'asset' && ref.requiredLedgerId) {
      const row = await db
        .prepare('SELECT id FROM asset_items WHERE user_id = ? AND id = ? AND ledger_id = ? AND deleted_at IS NULL')
        .bind(uid, ref.id, ref.requiredLedgerId)
        .first();
      if (!row) {
        throw new RejectError(`${ref.label}不屬於此共同帳本、不存在或已刪除，伺服器拒絕此筆異動。`);
      }
      continue;
    }
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

/** v2.1.0: whether migration 0026 (sinking_fund_items.start_ym / repeat_yearly / fund_kind) has been applied. */
async function hasSinkingScheduleColumns(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT start_ym, repeat_yearly, fund_kind FROM sinking_fund_items LIMIT 0').all();
    return true;
  } catch {
    return false;
  }
}

const SINKING_SCHEDULE_MIGRATION_ERROR =
  '伺服器資料庫尚未完成升級（缺少攤提「開始月份」欄位），請先執行資料庫遷移 0026 後再重試。';

function isDefaultSinkingSchedule(v: { startYm: string | null; repeatYearly: boolean; fundKind: string }): boolean {
  return v.startYm === null && !v.repeatYearly && v.fundKind === 'save_first';
}

const RECURRING_POST_DAY_MIGRATION_ERROR =
  '伺服器資料庫尚未完成升級（缺少「入帳日」欄位），請先執行資料庫遷移後再重試。';

async function hasAssetCreditCardColumns(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT is_credit_card FROM asset_items LIMIT 0').all();
    return true;
  } catch {
    return false;
  }
}

async function hasCashflowInstallmentColumns(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT installment_plan_id FROM cashflow_logs LIMIT 0').all();
    return true;
  } catch {
    return false;
  }
}

async function readExistingRow(
  db: D1Database,
  uid: string,
  table: string,
  keyColumn: 'id' | 'period',
  recordId: string
): Promise<Record<string, unknown> | null> {
  const prefetch = getRowPrefetch(db);
  const key = `${uid}:${table}:${recordId}`;
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

function runValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RejectError) throw err;
    throw new RejectError(err instanceof Error ? err.message : '資料驗證失敗');
  }
}

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

const ALLOWED_SYNC_OPS = new Set<string>(['upsert', 'delete']);

async function recordIdempotencyOnly(
  db: D1Database,
  storageUid: string,
  mutationId: string,
  serverTime: string,
  expectedEpoch: number,
  actorUid = storageUid
): Promise<void> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO sync_idempotency (user_id, mutation_id, applied_at)
       SELECT ?, ?, ? WHERE ${EPOCH_GUARD_SQL}`
    )
    .bind(actorUid, mutationId, serverTime, storageUid, expectedEpoch)
    .run();
  if (Number(res?.meta?.changes ?? 0) === 0) {
    const already = await db
      .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
      .bind(actorUid, mutationId)
      .first();
    if (already) return;
    const currEpoch = await getCurrentDataEpoch(db, storageUid);
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

interface SharedWriteScope {
  actorUid: string;
  storageUid: string;
  sharedLedgerId: string | null;
  sharedRole: SharedLedgerRole | null;
  ownedSharedLedgerIds: ReadonlySet<string>;
  hasUpdatedByCols: boolean;
}

async function applyMutationGroup(
  db: D1Database,
  storageUid: string,
  group: SyncMutation[],
  defaultFxRate: FxRateSource,
  serverTime: string,
  expectedEpoch: number,
  sharedScope?: SharedWriteScope
): Promise<void> {
  const actorUid = sharedScope?.actorUid ?? storageUid;
  const collector: GroupCollector = { items: [], groupMutations: group };
  const collectingDb = withGroupCollector(db, collector);
  for (const m of group) {
    try {
      await applySingleMutation(collectingDb, storageUid, m, defaultFxRate, serverTime, expectedEpoch, sharedScope);
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
        .bind(actorUid, item.mutation.mutationId)
        .first();
      if (!done) pending.push(item.mutation.mutationId);
    }
    if (pending.length === 0) return; // an identical concurrent retry committed the whole group
    if ((await getCurrentDataEpoch(db, storageUid)) !== expectedEpoch) {
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
  storageUid: string,
  mutation: SyncMutation,
  serverTime: string,
  expectedEpoch: number,
  primaryWriteStmt: D1PreparedStatement,
  postStatements: D1PreparedStatement[],
  refetchCurrent: () => Promise<{ row: Record<string, unknown> | null; mapped: Record<string, unknown> | null }>,
  legacyClientTs?: string,
  onZeroChanges?: () => Promise<void>,
  actorUid = storageUid
): Promise<void> {
  const idempStmt = db
    .prepare(
      'INSERT INTO sync_idempotency (user_id, mutation_id, applied_at) SELECT ?, ?, ? WHERE changes() > 0'
    )
    .bind(actorUid, mutation.mutationId, serverTime);

  const bumpSeqStmt = db
    .prepare(
      'UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0'
    )
    .bind(serverTime, storageUid);

  const extraStmts: D1PreparedStatement[] = [];
  if (legacyClientTs) {
    extraStmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO sync_lww_timestamps (user_id, entity, record_id, client_ts)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?)`
        )
        .bind(actorUid, mutation.entity, mutation.recordId, legacyClientTs, actorUid, mutation.mutationId)
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
        .bind(actorUid, mutation.mutationId)
        .first();
      if (already) return;

      // Q5 / N4: Check if a concurrent replace import bumped data_epoch BEFORE reporting conflict/rejection
      const currEpoch = await getCurrentDataEpoch(db, storageUid);
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
      .bind(actorUid, mutation.mutationId)
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
  expectedEpoch: number,
  sharedScope?: SharedWriteScope
): Promise<void> {
  const uid = assertUserId(userId);
  const actorUid = sharedScope?.actorUid ?? uid;
  let legacyCompareTs: string | null = null;
  if (mutation.baseVersion === undefined) {
    const lwwRow = await db
      .prepare('SELECT client_ts FROM sync_lww_timestamps WHERE user_id = ? AND entity = ? AND record_id = ?')
      .bind(actorUid, mutation.entity, mutation.recordId)
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

  const rowHandler = ROW_ENTITY_HANDLERS[mutation.entity as RowSyncEntity];
  if (rowHandler) {
    await applyRowEntityMutation(
      db,
      uid,
      mutation,
      mutation.entity as RowSyncEntity,
      rowHandler,
      defaultFxRate,
      serverTime,
      expectedEpoch,
      legacyCompareTs,
      sharedScope
    );
    return;
  }

  throw new RejectError(`不支援的同步資料類型：${String(mutation.entity)}`);
}

type RowSyncEntity =
  | 'ledger'
  | 'cashflow'
  | 'recurring'
  | 'sinking'
  | 'financial_goal'
  | 'split_receivable'
  | 'installment_plan'
  | 'asset'
  | 'savings_adjustment'
  | 'stock_tx'
  | 'utility_record';

const LEDGER_COLUMN_ENTITIES: ReadonlySet<RowSyncEntity> = new Set([
  'cashflow',
  'asset',
  'recurring',
  'split_receivable',
  'installment_plan',
]);

const UPDATED_BY_ENTITIES: ReadonlySet<RowSyncEntity> = new Set([
  'cashflow',
  'asset',
  'recurring',
  'savings_adjustment',
  'split_receivable',
  'installment_plan',
]);

interface RowMutationCtx {
  db: D1Database;
  uid: string;
  actorUid: string;
  mutation: SyncMutation;
  recordId: string;
  existing: Record<string, unknown> | null;
  defaultFxRate: FxRateSource;
  writeTs: string;
}

interface RowDeletePlan {
  extraGuardSql?: string;
  extraGuardBinds?: unknown[];
  onZeroChanges?: () => Promise<void>;
}

interface RowUpsertPlan {
  columns: ColumnAssignment[];
  refs?: RefCheck[];
  postStatements?: D1PreparedStatement[];
}

interface RowEntityHandler {
  mapRow: (row: Record<string, unknown>) => unknown;
  normalizeRecordId?: (mutation: SyncMutation) => string;
  beforeDeleteCheck?: (ctx: RowMutationCtx) => void;
  prepareDeleteGuard?: (ctx: RowMutationCtx & { existing: Record<string, unknown> }) => Promise<RowDeletePlan>;
  prepareUpsert: (ctx: RowMutationCtx) => Promise<RowUpsertPlan> | RowUpsertPlan;
}

const SHARED_ASSET_REF_COLUMNS: Partial<Record<RowSyncEntity, readonly string[]>> = {
  cashflow: ['linked_account_id'],
  recurring: ['linked_account_id'],
  savings_adjustment: ['account_id'],
  split_receivable: ['source_account_id'],
  installment_plan: ['card_account_id'],
};

/**
 * SL-4 asset references of a write inside a shared ledger (aa75631 review R1):
 * - a NEW or CHANGED reference must point at a live account of the same shared ledger (owner and members);
 * - for a member's write, the reference the row currently holds (kept, replaced or removed, and on delete) must
 *   not be a live account of another ledger — that is the owner's private balance. The owner may keep / delete
 *   their own pre-sharing links, and records linked to a since-deleted account stay editable and deletable.
 * `values` is null for a delete.
 */
function sharedAssetRefs(
  entity: RowSyncEntity,
  values: Record<string, unknown> | null,
  existing: Record<string, unknown> | null,
  ledgerId: string,
  isDelegated: boolean
): RefCheck[] {
  const asId = (v: unknown) => (typeof v === 'string' && v ? v : '');
  return (SHARED_ASSET_REF_COLUMNS[entity] || []).flatMap((column) => {
    const out: RefCheck[] = [];
    const prevId = existing ? asId(existing[column]) : '';
    const nextId = values ? asId(values[column]) : '';
    if (nextId && nextId !== prevId) {
      out.push({ kind: 'asset', id: nextId, label: '共同帳本連動帳戶', requiredLedgerId: ledgerId });
    }
    if (isDelegated && prevId) {
      out.push({ kind: 'asset', id: prevId, label: '共同帳本連動帳戶', forbidLiveOutsideLedgerId: ledgerId });
    }
    return out;
  });
}

async function applyRowEntityMutation(
  db: D1Database,
  uid: string,
  mutation: SyncMutation,
  entity: RowSyncEntity,
  handler: RowEntityHandler,
  defaultFxRate: FxRateSource,
  serverTime: string,
  expectedEpoch: number,
  legacyCompareTs: string | null,
  sharedScope?: SharedWriteScope
): Promise<void> {
  const actorUid = sharedScope?.actorUid ?? uid;
  let sharedLedgerId = sharedScope?.sharedLedgerId ?? null;
  const ownedSharedLedgerIds = sharedScope?.ownedSharedLedgerIds ?? new Set<string>();
  const meta = SYNC_ENTITY_BY_NAME[entity];
  const keyColumn = meta.keyColumn as 'id' | 'period';
  const recordId = handler.normalizeRecordId ? handler.normalizeRecordId(mutation) : mutation.recordId;

  let existing: Record<string, unknown> | null = null;
  try {
    existing = await readExistingRow(db, uid, meta.table, keyColumn, recordId);
  } catch (err) {
    if (meta.optionalTable && isMissingOptionalTableError(err, meta.table)) {
      throw new RejectError(meta.missingTableError!);
    }
    throw err;
  }

  if (!sharedLedgerId && existing && LEDGER_COLUMN_ENTITIES.has(entity)) {
    const existingLedgerId = normalizeLedgerId(existing.ledger_id);
    if (ownedSharedLedgerIds.has(existingLedgerId)) sharedLedgerId = existingLedgerId;
  }
  const isDelegatedSharedWrite = Boolean(sharedLedgerId && actorUid !== uid);

  // SL-1 / SL-5: Verify an existing row truly belongs to the target shared ledger before version check or mutation
  // (prevents an editor from probing/modifying/deleting the owner's private records via ID guessing).
  if (sharedLedgerId && existing) {
    if (entity === 'ledger') {
      if (recordId !== sharedLedgerId) {
        throw new RejectError('目標帳本與共同帳本識別碼不一致，伺服器拒絕操作。');
      }
    } else if (LEDGER_COLUMN_ENTITIES.has(entity)) {
      if (normalizeLedgerId(existing.ledger_id) !== sharedLedgerId) {
        throw new RejectError('目標紀錄不屬於此共同帳本，伺服器拒絕操作。');
      }
    } else if (entity === 'savings_adjustment') {
      const accRow = await db
        .prepare('SELECT ledger_id FROM asset_items WHERE user_id = ? AND id = ?')
        .bind(uid, String(existing.account_id || ''))
        .first<{ ledger_id?: string }>();
      if (!accRow || normalizeLedgerId(accRow.ledger_id) !== sharedLedgerId) {
        throw new RejectError('目標餘額調整紀錄不屬於此共同帳本，伺服器拒絕操作。');
      }
    }
  }

  const check = checkVersionOrThrow(
    mutation,
    existing,
    existing ? (handler.mapRow(existing) as Record<string, unknown>) : null,
    serverTime,
    legacyCompareTs
  );
  if (!check.shouldApply) {
    await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch, actorUid);
    return;
  }

  const refetchRow = async () => {
    const row = await db
      .prepare(`SELECT * FROM ${meta.table} WHERE user_id = ? AND ${keyColumn} = ?`)
      .bind(uid, recordId)
      .first<Record<string, unknown>>();
    return {
      row,
      mapped: row ? (handler.mapRow(row) as Record<string, unknown>) : null,
    };
  };

  // SL-2: Atomic SQL membership + role guard for delegated member writes (prevents revocation TOCTOU)
  const membershipGuardSql = isDelegatedSharedWrite
    ? " AND EXISTS (SELECT 1 FROM ledger_members WHERE ledger_id = ? AND owner_user_id = ? AND member_user_id = ? AND role IN ('owner', 'editor') AND revoked_at IS NULL)"
    : '';
  const membershipGuardBinds = isDelegatedSharedWrite ? [sharedLedgerId!, uid, actorUid] : [];
  const checkMembershipStillWritable = async () => {
    if (!isDelegatedSharedWrite) return;
    const row = await db
      .prepare(
        "SELECT role FROM ledger_members WHERE ledger_id = ? AND owner_user_id = ? AND member_user_id = ? AND role IN ('owner', 'editor') AND revoked_at IS NULL"
      )
      .bind(sharedLedgerId!, uid, actorUid)
      .first();
    if (!row) {
      throw new RejectError('您在此共同帳本的編輯權限已變更或遭移除，伺服器拒絕此筆異動。');
    }
  };

  const ctx: RowMutationCtx = {
    db,
    uid,
    actorUid,
    mutation,
    recordId,
    existing,
    defaultFxRate,
    writeTs: check.writeTs,
  };

  if (mutation.op === 'delete') {
    handler.beforeDeleteCheck?.(ctx);
    if (!existing) {
      await recordIdempotencyOnly(db, uid, mutation.mutationId, serverTime, expectedEpoch, actorUid);
      return;
    }
    const delPlan = handler.prepareDeleteGuard
      ? await handler.prepareDeleteGuard({ ...ctx, existing })
      : {};
    const refs = sharedLedgerId
      ? sharedAssetRefs(entity, null, existing, sharedLedgerId, isDelegatedSharedWrite)
      : [];
    const refGuard = refs.length ? refGuardSql(db, uid, refs) : { sql: '', binds: [] };
    const built = buildSoftDeleteSql({
      table: meta.table,
      keyColumn,
      uid,
      recordId,
      writeTs: check.writeTs,
      nextVersion: check.nextVersion,
      expectedVersion: Number(existing.version ?? 1),
      expectedEpoch,
      extraGuardSql: `${delPlan.extraGuardSql || ''}${membershipGuardSql}${refGuard.sql}`,
      extraGuardBinds: [...(delPlan.extraGuardBinds || []), ...membershipGuardBinds, ...refGuard.binds],
    });
    const delStmt = db.prepare(built.sql).bind(...built.binds);
    const postStatements = entity === 'ledger' && sharedScope?.hasUpdatedByCols
      ? [db.prepare(
          `UPDATE ledger_invites SET revoked_at = ?
           WHERE owner_user_id = ? AND ledger_id = ? AND used_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?)`
        ).bind(check.writeTs, uid, recordId, actorUid, mutation.mutationId)]
      : [];
    await commitAtomicMutation(
      db,
      uid,
      mutation,
      serverTime,
      expectedEpoch,
      delStmt,
      postStatements,
      refetchRow,
      check.legacyClientTs,
      isDelegatedSharedWrite || refs.length || delPlan.onZeroChanges
        ? async () => {
            await checkMembershipStillWritable();
            await rejectMissingRefs(db, uid, refs);
            await delPlan.onZeroChanges?.();
          }
        : undefined,
      actorUid
    );
    return;
  }

  const plan = await handler.prepareUpsert(ctx);

  // SL-5: Anti-smuggling — forbid moving records across personal <-> shared or shared A <-> shared B boundaries
  if (LEDGER_COLUMN_ENTITIES.has(entity)) {
    const ledgerCol = plan.columns.find((c) => c.col === 'ledger_id');
    const targetLedgerId = normalizeLedgerId(ledgerCol?.value);
    if (sharedLedgerId) {
      if (targetLedgerId !== sharedLedgerId) {
        throw new RejectError('共同帳本內的紀錄不可變更所屬帳本。');
      }
    } else if (existing && ownedSharedLedgerIds.size > 0) {
      const prevLedgerId = normalizeLedgerId(existing.ledger_id);
      if (ownedSharedLedgerIds.has(prevLedgerId) && targetLedgerId !== prevLedgerId) {
        throw new RejectError('已共用的帳本紀錄不可移出至其他帳本。');
      }
      if (!ownedSharedLedgerIds.has(prevLedgerId) && ownedSharedLedgerIds.has(targetLedgerId)) {
        throw new RejectError('個人帳本紀錄不可直接移入已共用的帳本。');
      }
    }
  }

  // SL-4: Same-scope reference guard — shared writes may ONLY link to assets belonging to the SAME shared ledger
  const rawRefs = plan.refs ?? [];
  const refs: RefCheck[] = sharedLedgerId
    ? [
        ...rawRefs.filter((r) => r.kind !== 'asset'),
        ...sharedAssetRefs(
          entity,
          Object.fromEntries(plan.columns.map(({ col, value }) => [col, value])),
          existing,
          sharedLedgerId,
          isDelegatedSharedWrite
        ),
      ]
    : rawRefs;
  const guard = refs.length > 0 ? refGuardSql(db, uid, refs) : { sql: '', binds: [] };

  // Phase 9 attribution: record actorUid into updated_by when 0025 columns exist
  const columns: ColumnAssignment[] =
    sharedScope?.hasUpdatedByCols && UPDATED_BY_ENTITIES.has(entity)
      ? [...plan.columns, { col: 'updated_by', value: actorUid }]
      : plan.columns;

  const p = mutation.payload || {};
  const built = buildRowUpsertSql({
    table: meta.table,
    keyColumn,
    isUpdate: Boolean(existing),
    uid,
    recordId,
    columns,
    createdAt: String(p.createdAt || check.writeTs),
    writeTs: check.writeTs,
    nextVersion: check.nextVersion,
    expectedVersion: existing ? Number(existing.version ?? 1) : undefined,
    expectedEpoch,
    guardSql: `${guard.sql}${membershipGuardSql}`,
    guardBinds: [...guard.binds, ...membershipGuardBinds],
  });
  const writeStmt = db.prepare(built.sql).bind(...built.binds);

  await commitAtomicMutation(
    db,
    uid,
    mutation,
    serverTime,
    expectedEpoch,
    writeStmt,
    plan.postStatements ?? [],
    refetchRow,
    check.legacyClientTs,
    refs.length > 0 || isDelegatedSharedWrite
      ? async () => {
          await checkMembershipStillWritable();
          if (refs.length > 0) await rejectMissingRefs(db, uid, refs);
        }
      : undefined,
    actorUid
  );
}

const ROW_ENTITY_HANDLERS: Readonly<Record<RowSyncEntity, RowEntityHandler>> = {
  ledger: {
    mapRow: mapLedgerRow,
    beforeDeleteCheck({ recordId }) {
      if (recordId === DEFAULT_LEDGER_ID) {
        throw new RejectError('不可刪除預設個人主帳本。');
      }
    },
    async prepareDeleteGuard({ db, uid, recordId }) {
      try {
        const otherMembers = await db
          .prepare(
            'SELECT COUNT(*) AS cnt FROM ledger_members WHERE ledger_id = ? AND owner_user_id = ? AND member_user_id != ? AND revoked_at IS NULL'
          )
          .bind(recordId, uid, uid)
          .first<{ cnt: number }>();
        if (Number(otherMembers?.cnt || 0) > 0) {
          throw new RejectError('此共同帳本仍有其他活躍成員，請先移除所有成員後再刪除帳本。');
        }
      } catch (err) {
        if (err instanceof RejectError) throw err;
        if (!isMissingSharedLedgerTableError(err)) throw err;
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
          .bind(uid, recordId, uid, recordId, uid, recordId)
          .first<{ cnt: number }>();
        return Number(row?.cnt || 0);
      };
      const remaining = await countLinkedRecords();
      if (remaining > 0) {
        throw new RejectError(`此帳本仍有 ${remaining} 筆關聯紀錄，請先轉移至其他帳本或刪除紀錄後再移除帳本。`);
      }
      return {
        extraGuardSql:
          ' AND NOT EXISTS (SELECT 1 FROM cashflow_logs WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL)' +
          ' AND NOT EXISTS (SELECT 1 FROM asset_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL)' +
          ' AND NOT EXISTS (SELECT 1 FROM recurring_items WHERE user_id = ? AND ledger_id = ? AND deleted_at IS NULL)',
        extraGuardBinds: [uid, recordId, uid, recordId, uid, recordId],
        onZeroChanges: async () => {
          const concurrentRemaining = await countLinkedRecords();
          if (concurrentRemaining > 0) {
            throw new RejectError(
              `此帳本仍有 ${concurrentRemaining} 筆關聯紀錄，請先轉移至其他帳本或刪除紀錄後再移除帳本。`
            );
          }
        },
      };
    },
    prepareUpsert({ mutation, recordId, existing }) {
      const p = mutation.payload || {};
      const v = runValidation(() =>
        validateLedgerInput({
          name: String(p.name || ''),
          includeInNetWorth:
            recordId === DEFAULT_LEDGER_ID
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
      return {
        columns: [
          { col: 'name', value: v.name },
          { col: 'include_in_net_worth', value: v.includeInNetWorth ? 1 : 0 },
          { col: 'monthly_daily_budget', value: v.monthlyDailyBudget },
          { col: 'note', value: v.note },
          { col: 'sort_order', value: v.sortOrder },
        ],
      };
    },
  },

  cashflow: {
    mapRow: mapCashFlowRow,
    async prepareUpsert({ db, mutation, existing, defaultFxRate }) {
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
            installmentPlanId:
              p.installmentPlanId !== undefined
                ? (p.installmentPlanId as string | null)
                : existing?.installment_plan_id
                  ? String(existing.installment_plan_id)
                  : null,
            installmentSeq:
              p.installmentSeq !== undefined
                ? (p.installmentSeq as number | null)
                : existing?.installment_seq !== undefined && existing?.installment_seq !== null
                  ? Number(existing.installment_seq)
                  : null,
          },
          defaultFxRate
        )
      );

      // M3: only references changed by this write are checked; the guard is part of the write statement
      const refs = collectChangedRefs(existing, [
        { kind: 'ledger', value: v.ledgerId, column: 'ledger_id', label: '指定的帳本' },
        { kind: 'asset', value: v.linkedAccountId, column: 'linked_account_id', label: '連動的活存或信用卡帳戶' },
      ]);

      const hasInstCols = existing
        ? 'installment_plan_id' in existing
        : v.installmentPlanId === null && v.installmentSeq === null
          ? false
          : await hasCashflowInstallmentColumns(db);
      if (!hasInstCols && (v.installmentPlanId !== null || v.installmentSeq !== null)) {
        throw new RejectError(
          '伺服器資料庫尚未完成升級（缺少流水帳分期關聯欄位），請先執行 0024 資料庫遷移後再重試。'
        );
      }

      const columns: ColumnAssignment[] = [
        { col: 'date', value: v.date },
        { col: 'year_month', value: v.yearMonth },
        { col: 'type', value: v.type },
        { col: 'category', value: v.category },
        { col: 'item_name', value: v.itemName },
        { col: 'amount', value: v.amount },
        { col: 'currency', value: v.currency },
        { col: 'fx_rate', value: v.fxRate },
        { col: 'twd_amount', value: v.twdAmount },
        { col: 'source', value: v.source },
        { col: 'note', value: v.note },
        { col: 'linked_account_id', value: v.linkedAccountId },
        { col: 'ledger_id', value: v.ledgerId },
        ...(hasInstCols
          ? [
              { col: 'installment_plan_id', value: v.installmentPlanId },
              { col: 'installment_seq', value: v.installmentSeq },
            ]
          : []),
      ];
      return { columns, refs };
    },
  },

  recurring: {
    mapRow: mapRecurringRow,
    async prepareUpsert({ db, mutation, existing }) {
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
      const refs = collectChangedRefs(existing, [
        { kind: 'ledger', value: v.ledgerId, column: 'ledger_id', label: '指定的帳本' },
        { kind: 'asset', value: v.linkedAccountId, column: 'linked_account_id', label: '連動的活存帳戶' },
      ]);

      // v1.13.1: post_day (migration 0022). Before the migration a non-default day is rejected (never silently
      // dropped); the default day 1 is simply not written (the column default / previous behaviour applies).
      const postDayColumnKnown = existing
        ? 'post_day' in existing
        : v.postDay === 1
          ? false
          : await hasRecurringPostDayColumn(db);
      if (!postDayColumnKnown && v.postDay !== 1) {
        throw new RejectError(RECURRING_POST_DAY_MIGRATION_ERROR);
      }

      const columns: ColumnAssignment[] = [
        { col: 'item_name', value: v.itemName },
        { col: 'category', value: v.category },
        { col: 'type', value: v.type },
        { col: 'amount', value: v.amount },
        { col: 'currency', value: v.currency },
        { col: 'cycle', value: v.cycle },
        { col: 'billing_spec', value: v.billingSpec },
        { col: 'status', value: v.status },
        { col: 'note', value: v.note },
        { col: 'linked_account_id', value: v.linkedAccountId },
        { col: 'ledger_id', value: v.ledgerId },
        { col: 'sort_order', value: v.sortOrder },
        ...(postDayColumnKnown ? [{ col: 'post_day', value: v.postDay }] : []),
      ];
      return { columns, refs };
    },
  },

  sinking: {
    mapRow: mapSinkingRow,
    async prepareUpsert({ db, mutation, existing }) {
      const p = mutation.payload || {};
      // v2.1.0: a client older than v2.1.0 does not send the schedule fields — keep what is stored instead of
      // silently turning a scheduled item back into an unlimited one
      const keep = (field: string, col: string): unknown =>
        p[field] !== undefined ? p[field] : existing && col in existing ? existing[col] : undefined;
      const v = runValidation(() =>
        validateSinkingInput({
          itemName: String(p.itemName || ''),
          category: String(p.category || ''),
          totalAmount: Number(p.totalAmount),
          months: Number(p.months),
          dueNote: String(p.dueNote || ''),
          status: String(p.status || '啟用'),
          note: String(p.note || ''),
          startYm: keep('startYm', 'start_ym') as string | null | undefined,
          repeatYearly: keep('repeatYearly', 'repeat_yearly') as boolean | number | undefined,
          fundKind: keep('fundKind', 'fund_kind') as string | undefined,
          sortOrder:
            p.sortOrder !== undefined
              ? normalizeSortOrder(p.sortOrder, 0)
              : existing?.sort_order !== undefined
                ? Number(existing.sort_order)
                : 0,
        })
      );

      // 0026 not applied: a schedule is rejected (never silently dropped); a default item is written without it
      const scheduleColumnsKnown = existing
        ? 'start_ym' in existing
        : isDefaultSinkingSchedule(v)
          ? false
          : await hasSinkingScheduleColumns(db);
      if (!scheduleColumnsKnown && !isDefaultSinkingSchedule(v)) {
        throw new RejectError(SINKING_SCHEDULE_MIGRATION_ERROR);
      }

      return {
        columns: [
          { col: 'item_name', value: v.itemName },
          { col: 'category', value: v.category },
          { col: 'total_amount', value: v.totalAmount },
          { col: 'months', value: v.months },
          { col: 'due_note', value: v.dueNote },
          { col: 'status', value: v.status },
          { col: 'note', value: v.note },
          { col: 'sort_order', value: v.sortOrder },
          ...(scheduleColumnsKnown
            ? [
                { col: 'start_ym', value: v.startYm },
                { col: 'repeat_yearly', value: v.repeatYearly ? 1 : 0 },
                { col: 'fund_kind', value: v.fundKind },
              ]
            : []),
        ],
      };
    },
  },

  financial_goal: {
    mapRow: mapFinancialGoalRow,
    prepareUpsert({ mutation, existing }) {
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

      return {
        refs,
        columns: [
          { col: 'name', value: v.name },
          { col: 'goal_type', value: v.goalType },
          { col: 'target_amount', value: v.targetAmount },
          { col: 'currency', value: v.currency },
          { col: 'linked_ledger_id', value: v.linkedLedgerId },
          { col: 'linked_asset_ids_json', value: JSON.stringify(v.linkedAssetIds) },
          { col: 'current_manual_amount', value: v.currentManualAmount },
          { col: 'expected_annual_return_pct', value: v.expectedAnnualReturnPct },
          { col: 'monthly_contribution_override', value: v.monthlyContributionOverride },
          { col: 'fire_swr_pct', value: v.fireSwrPct },
          { col: 'target_date', value: v.targetDate },
          { col: 'sort_order', value: v.sortOrder },
          { col: 'note', value: v.note },
        ],
      };
    },
  },

  split_receivable: {
    mapRow: mapSplitReceivableRow,
    prepareUpsert({ mutation, existing, defaultFxRate }) {
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

      return {
        refs,
        columns: [
          { col: 'ledger_id', value: v.ledgerId },
          { col: 'split_group_id', value: v.splitGroupId },
          { col: 'counterparty', value: v.counterparty },
          { col: 'date', value: v.date },
          { col: 'item_name', value: v.itemName },
          { col: 'category', value: v.category },
          { col: 'amount', value: v.amount },
          { col: 'settled_amount', value: v.settledAmount },
          { col: 'currency', value: v.currency },
          { col: 'fx_rate', value: v.fxRate },
          { col: 'twd_amount', value: v.twdAmount },
          { col: 'status', value: v.status },
          { col: 'source_cashflow_id', value: v.sourceCashflowId },
          { col: 'source_account_id', value: v.sourceAccountId },
          { col: 'source_adjustment_id', value: v.sourceAdjustmentId },
          { col: 'note', value: v.note },
        ],
      };
    },
  },

  installment_plan: {
    mapRow: mapInstallmentPlanRow,
    prepareUpsert({ mutation, existing }) {
      const p = mutation.payload || {};
      const v = runValidation(() =>
        validateInstallmentPlanInput({
          ledgerId:
            p.ledgerId !== undefined
              ? normalizeLedgerId(p.ledgerId)
              : normalizeLedgerId(existing?.ledger_id),
          cardAccountId:
            p.cardAccountId !== undefined ? (p.cardAccountId as string | null) : null,
          itemName: String(p.itemName || ''),
          category: String(p.category || '其他'),
          totalAmount: Number(p.totalAmount),
          totalInstallments: Number(p.totalInstallments),
          postedInstallments: p.postedInstallments !== undefined ? Number(p.postedInstallments) : 0,
          startYm: String(p.startYm || ''),
          postDay: p.postDay !== undefined && p.postDay !== null ? Number(p.postDay) : 1,
          currency: String(p.currency || 'TWD'),
          status: p.status !== undefined ? String(p.status) : undefined,
          note: String(p.note || ''),
        })
      );

      const refs = collectChangedRefs(existing, [
        { kind: 'ledger', column: 'ledger_id', value: v.ledgerId, label: '帳本' },
        { kind: 'asset', column: 'card_account_id', value: v.cardAccountId, label: '綁定信用卡' },
      ]);

      return {
        refs,
        columns: [
          { col: 'ledger_id', value: v.ledgerId },
          { col: 'card_account_id', value: v.cardAccountId },
          { col: 'item_name', value: v.itemName },
          { col: 'category', value: v.category },
          { col: 'total_amount', value: v.totalAmount },
          { col: 'total_installments', value: v.totalInstallments },
          { col: 'posted_installments', value: v.postedInstallments },
          { col: 'start_ym', value: v.startYm },
          { col: 'post_day', value: v.postDay },
          { col: 'currency', value: v.currency },
          { col: 'status', value: v.status },
          { col: 'note', value: v.note },
        ],
      };
    },
  },

  asset: {
    mapRow: mapAssetRow,
    async prepareUpsert({ db, uid, actorUid, mutation, recordId, existing, writeTs }) {
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
          isCreditCard:
            p.isCreditCard !== undefined
              ? Boolean(p.isCreditCard)
              : Number(existing?.is_credit_card || 0) === 1,
          creditBillingDay:
            p.creditBillingDay !== undefined
              ? (p.creditBillingDay as number | null)
              : existing?.credit_billing_day !== undefined && existing?.credit_billing_day !== null
                ? Number(existing.credit_billing_day)
                : null,
          creditDueDay:
            p.creditDueDay !== undefined
              ? (p.creditDueDay as number | null)
              : existing?.credit_due_day !== undefined && existing?.credit_due_day !== null
                ? Number(existing.credit_due_day)
                : null,
          creditLimit:
            p.creditLimit !== undefined
              ? (p.creditLimit as number | null)
              : existing?.credit_limit !== undefined && existing?.credit_limit !== null
                ? Number(existing.credit_limit)
                : null,
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
            .bind(writeTs, uid, uid, v.ledgerId, recordId, actorUid, mutation.mutationId)
        );
      }

      const nextPriceUpdatedAt = clearPriceUpdatedAt
        ? null
        : existing?.price_updated_at !== undefined && existing?.price_updated_at !== null
          ? String(existing.price_updated_at)
          : null;

      // M3: only references changed by this write are checked; the guard is part of the write statement
      const refs = collectChangedRefs(existing, [{ kind: 'ledger', value: v.ledgerId, column: 'ledger_id', label: '指定的帳本' }]);

      const hasCcCols = existing
        ? 'is_credit_card' in existing
        : !v.isCreditCard
          ? false
          : await hasAssetCreditCardColumns(db);
      if (!hasCcCols && v.isCreditCard) {
        throw new RejectError(
          '伺服器資料庫尚未完成升級（缺少信用卡欄位），請先執行 0024 資料庫遷移後再重試。'
        );
      }

      const columns: ColumnAssignment[] = [
        { col: 'update_mode', value: v.updateMode },
        { col: 'major_type', value: v.majorType },
        { col: 'sub_category', value: v.subCategory },
        { col: 'liquidity', value: v.liquidity },
        { col: 'item_name', value: v.itemName },
        { col: 'ticker', value: v.ticker },
        { col: 'quantity_or_amount', value: v.quantityOrAmount },
        { col: 'currency', value: v.currency },
        { col: 'unit_price', updateValue: finalUnitPrice, insertValue: v.unitPrice },
        { col: 'previous_close', updateValue: finalPreviousClose, insertValue: v.previousClose },
        { col: 'price_updated_at', updateValue: nextPriceUpdatedAt, updateOnly: true },
        { col: 'cost_basis', value: v.costBasis },
        { col: 'note', value: v.note },
        { col: 'is_linked_savings', value: v.isLinkedSavings ? 1 : 0 },
        { col: 'balance_anchor_date', value: v.balanceAnchorDate },
        { col: 'balance_anchor_at', value: v.balanceAnchorAt },
        { col: 'is_default_savings', value: v.isDefaultSavings ? 1 : 0 },
        { col: 'is_amortizing_loan', value: v.isAmortizingLoan ? 1 : 0 },
        { col: 'loan_annual_rate', value: v.loanAnnualRate },
        { col: 'loan_monthly_payment', value: v.loanMonthlyPayment },
        { col: 'loan_billing_day', value: v.loanBillingDay },
        { col: 'stock_category', value: v.stockCategory },
        { col: 'is_watchlist', value: v.isWatchlist ? 1 : 0 },
        { col: 'ledger_id', value: v.ledgerId },
        { col: 'exclude_from_net_worth', value: v.excludeFromNetWorth ? 1 : 0 },
        { col: 'sort_order', value: v.sortOrder },
        ...(hasCcCols
          ? [
              { col: 'is_credit_card', value: v.isCreditCard ? 1 : 0 },
              { col: 'credit_billing_day', value: v.creditBillingDay },
              { col: 'credit_due_day', value: v.creditDueDay },
              { col: 'credit_limit', value: v.creditLimit },
            ]
          : []),
      ];

      return { columns, refs, postStatements };
    },
  },

  savings_adjustment: {
    mapRow: mapSavingsAdjustmentRow,
    async prepareUpsert({ db, uid, mutation, recordId, existing, defaultFxRate }) {
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
            .bind(uid, String(existing.transfer_group_id), recordId)
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
      const refs = collectChangedRefs(existing, [{ kind: 'asset', value: v.accountId, column: 'account_id', label: '對應的活存帳戶' }]);

      return {
        refs,
        columns: [
          { col: 'account_id', value: v.accountId },
          { col: 'date', value: v.date },
          { col: 'amount', value: v.amount },
          { col: 'twd_amount', value: twdAmount },
          { col: 'note', value: v.note },
          { col: 'transfer_group_id', value: v.transferGroupId },
        ],
      };
    },
  },

  stock_tx: {
    mapRow: mapStockTransactionRow,
    prepareUpsert({ mutation, existing }) {
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
      const refs = collectChangedRefs(existing, [{ kind: 'asset', value: v.assetId, column: 'asset_id', label: '對應的持股標的' }]);

      return {
        refs,
        columns: [
          { col: 'asset_id', value: v.assetId },
          { col: 'date', value: v.date },
          { col: 'tx_type', value: v.txType },
          { col: 'shares', value: v.shares },
          { col: 'total_amount', value: v.totalAmount },
          { col: 'fee', value: v.fee },
          { col: 'linked_cashflow_id', value: v.linkedCashflowId },
          { col: 'note', value: v.note },
        ],
      };
    },
  },

  utility_record: {
    mapRow: mapUtilityRecordRow,
    normalizeRecordId(mutation) {
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
      return normalizedPeriod;
    },
    beforeDeleteCheck({ existing }) {
      if (existing && Number(existing.is_baseline) === 1) {
        throw new RejectError('不可刪除起始表底紀錄。');
      }
    },
    prepareUpsert({ mutation, recordId }) {
      const p = mutation.payload || {};
      const v = runValidation(() =>
        validateUtilityRecordInput({
          period: recordId,
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
      return {
        columns: [
          { col: 'is_baseline', value: v.isBaseline ? 1 : 0 },
          { col: 'cur_total', value: v.curTotal },
          { col: 'cur_6f', value: v.cur6F },
          { col: 'total_elec', value: v.totalElec },
          { col: 'total_water', value: v.totalWater },
          { col: 'f6_people', value: v.f6People },
          { col: 'f5_people', value: v.f5People },
          { col: 'cur_a', value: v.curA },
          { col: 'cur_b', value: v.curB },
          { col: 'cur_c', value: v.curC },
        ],
      };
    },
  },
};

type DeltaMode = DeltaQueryMode;

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
  const coreTables: Array<{ table: string; orderBy: string; liveOnlyWhenFull: boolean }> = [
    SYNC_ENTITY_BY_NAME.ledger,
    SYNC_ENTITY_BY_NAME.cashflow,
    SYNC_ENTITY_BY_NAME.recurring,
    SYNC_ENTITY_BY_NAME.sinking,
    SYNC_ENTITY_BY_NAME.asset,
    SYNC_ENTITY_BY_NAME.savings_adjustment,
    SYNC_ENTITY_BY_NAME.stock_tx,
    { table: 'networth_history', orderBy: 'year_month DESC', liveOnlyWhenFull: false },
    SYNC_ENTITY_BY_NAME.utility_record,
  ];
  const buildEntityStmt = (spec: { table: string; orderBy: string; liveOnlyWhenFull: boolean }) => {
    const built = buildDeltaSelectSql({ ...spec, uid, mode });
    return db.prepare(built.sql).bind(...built.binds);
  };
  const headerStmts = [
    db.prepare('SELECT change_seq, data_epoch FROM user_sync_state WHERE user_id = ?').bind(uid),
    db.prepare('SELECT * FROM app_settings WHERE user_id = ?').bind(uid),
    db.prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?').bind(uid),
  ];
  const coreStmts = coreTables.map(buildEntityStmt);
  let includedOptionalTables = new Set<string>(OPTIONAL_SYNC_TABLES);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      ...headerStmts,
      ...coreStmts,
      ...OPTIONAL_SYNC_METAS.map(buildEntityStmt),
    ]);
  } catch (err) {
    if (!isMissingOptionalTableError(err)) {
      throw err;
    }
    const placeholders = OPTIONAL_SYNC_TABLES.map(() => '?').join(', ');
    const existingOpt = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .bind(...OPTIONAL_SYNC_TABLES)
      .all<{ name: string }>();
    includedOptionalTables = new Set((existingOpt.results || []).map((r) => r.name));
    const fallbackBatch: D1PreparedStatement[] = [
      ...headerStmts,
      ...coreStmts,
      ...OPTIONAL_SYNC_METAS.filter((m) => includedOptionalTables.has(m.table)).map(buildEntityStmt),
    ];
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
  let nextIdx = base + coreTables.length;
  const optionalRowsByTable = new Map<string, Record<string, unknown>[]>();
  for (const m of OPTIONAL_SYNC_METAS) {
    optionalRowsByTable.set(m.table, includedOptionalTables.has(m.table) ? rowsOf(nextIdx++) : []);
  }
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
    financialGoals: (optionalRowsByTable.get('financial_goals') || []).map(mapFinancialGoalRow),
    splitReceivables: (optionalRowsByTable.get('split_receivables') || []).map(mapSplitReceivableRow),
    installmentPlans: (optionalRowsByTable.get('installment_plans') || []).map(mapInstallmentPlanRow),
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
/** H5 / Phase 9: queries kept for the response (personal delta + optional shared delta batch + resync). */
const SYNC_TAIL_QUERY_RESERVE = 4;

interface SharedLedgerReadResult {
  sharedLedgers: SharedLedgerSyncState[];
  userDisplayNames: Map<string, string>;
  joinedLedgers: Ledger[];
  joinedCashflow: CashFlowLog[];
  joinedAssets: AssetItem[];
  joinedRecurring: RecurringItem[];
  joinedAdjustments: SavingsAdjustment[];
  joinedSplits: SplitReceivable[];
  joinedInstallments: InstallmentPlan[];
}

function enrichUpdatedByName<T extends { updatedByUserId?: string | null; updatedByName?: string | null }>(
  items: T[] | undefined,
  names: Map<string, string>
): void {
  if (!items || names.size === 0) return;
  for (const item of items) {
    if (item.updatedByUserId) {
      const name = names.get(item.updatedByUserId);
      if (name) item.updatedByName = name;
    }
  }
}

/**
 * Phase 9 (v2.0.0): reads member directory, owner sync cursors, and delta rows for ALL joined shared ledgers
 * in ONE single D1 batch (or 0 queries when the user has no active shared ledgers).
 */
async function readSharedLedgersDelta(
  db: D1Database,
  actorUid: string,
  activeMemberships: RawLedgerMembership[],
  personalState: { changeSeq: number; dataEpoch: number },
  sharedCursors: Record<string, { sinceSeq: number; clientEpoch: number }> | undefined,
  forceFullSharedIds: ReadonlySet<string>,
  epochMismatchSharedIds: ReadonlySet<string>
): Promise<SharedLedgerReadResult> {
  const empty: SharedLedgerReadResult = {
    sharedLedgers: [],
    userDisplayNames: new Map(),
    joinedLedgers: [],
    joinedCashflow: [],
    joinedAssets: [],
    joinedRecurring: [],
    joinedAdjustments: [],
    joinedSplits: [],
    joinedInstallments: [],
  };
  if (activeMemberships.length === 0) return empty;

  const ledgerIds = Array.from(new Set(activeMemberships.map((m) => m.ledger_id)));
  const joinedMemberships = activeMemberships.filter((m) => m.owner_user_id !== actorUid);
  const distinctJoinedOwners = Array.from(new Set(joinedMemberships.map((m) => m.owner_user_id)));

  // Step A: Read member directory + owner sync states in 1 batch (if joined exist, also read owner states)
  const metaStmts: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT lm.ledger_id, lm.owner_user_id, lm.member_user_id, lm.role, u.username, u.display_name
         FROM ledger_members lm
         JOIN users u ON u.id = lm.member_user_id
         WHERE lm.revoked_at IS NULL AND lm.ledger_id IN (${ledgerIds.map(() => '?').join(', ')})
         ORDER BY CASE lm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, lm.joined_at ASC`
      )
      .bind(...ledgerIds),
  ];
  if (distinctJoinedOwners.length > 0) {
    metaStmts.push(
      db
        .prepare(
          `SELECT user_id, change_seq, data_epoch
           FROM user_sync_state
           WHERE user_id IN (${distinctJoinedOwners.map(() => '?').join(', ')})`
        )
        .bind(...distinctJoinedOwners)
    );
  }
  const metaRes = await db.batch(metaStmts);
  const allMemberRows = (metaRes[0]?.results || []) as Array<{
    ledger_id: string;
    owner_user_id: string;
    member_user_id: string;
    role: SharedLedgerRole;
    username: string;
    display_name: string;
  }>;
  const ownerStateMap = new Map<string, { changeSeq: number; dataEpoch: number }>();
  ownerStateMap.set(actorUid, personalState);
  if (distinctJoinedOwners.length > 0) {
    for (const r of (metaRes[1]?.results || []) as Array<{
      user_id: string;
      change_seq: number;
      data_epoch: number;
    }>) {
      ownerStateMap.set(String(r.user_id), {
        changeSeq: Number(r.change_seq ?? 0),
        dataEpoch: Number(r.data_epoch ?? 1),
      });
    }
  }

  const userDisplayNames = new Map<string, string>();
  const membersByLedger = new Map<string, Array<{ userId: string; displayName: string; role: SharedLedgerRole }>>();
  for (const r of allMemberRows) {
    const displayName = r.display_name || '共同帳本成員';
    userDisplayNames.set(r.member_user_id, displayName);
    const list = membersByLedger.get(r.ledger_id) || [];
    list.push({ userId: r.member_user_id, displayName, role: r.role });
    membersByLedger.set(r.ledger_id, list);
  }

  // Step B: For joined shared ledgers, fetch all 7 shareable entity slices across all joined ledgers in 1 single D1 batch
  const dataStmts: D1PreparedStatement[] = [];
  const joinedPlans: Array<{
    m: RawLedgerMembership;
    ownerState: { changeSeq: number; dataEpoch: number };
    full: boolean;
    epochMismatch: boolean;
    startIdx: number;
  }> = [];

  for (const m of joinedMemberships) {
    const ownerState = ownerStateMap.get(m.owner_user_id) || { changeSeq: 0, dataEpoch: 1 };
    const clientCur = sharedCursors?.[m.ledger_id];
    const hasClientEpoch =
      clientCur && typeof clientCur.clientEpoch === 'number' && Number.isFinite(clientCur.clientEpoch);
    const curEpochMismatch =
      epochMismatchSharedIds.has(m.ledger_id) ||
      Boolean(hasClientEpoch && clientCur!.clientEpoch !== ownerState.dataEpoch);
    const isFull =
      curEpochMismatch ||
      forceFullSharedIds.has(m.ledger_id) ||
      !clientCur ||
      typeof clientCur.sinceSeq !== 'number' ||
      !Number.isFinite(clientCur.sinceSeq);

    const startIdx = dataStmts.length;
    joinedPlans.push({ m, ownerState, full: isFull, epochMismatch: curEpochMismatch, startIdx });

    const seqClause = isFull ? ' AND deleted_at IS NULL' : ' AND change_seq > ? AND change_seq <= ?';
    const seqBinds = isFull ? [] : [Number(clientCur!.sinceSeq), ownerState.changeSeq];

    // 0: ledgers (always fetch live row on full, or seq window on incremental; on incremental also fetch if changed)
    dataStmts.push(
      db
        .prepare(`SELECT * FROM ledgers WHERE user_id = ? AND id = ?${isFull ? ' AND deleted_at IS NULL' : ''}`)
        .bind(m.owner_user_id, m.ledger_id)
    );
    // 1: cashflow_logs
    dataStmts.push(
      db
        .prepare(`SELECT * FROM cashflow_logs WHERE user_id = ? AND ledger_id = ?${seqClause} ORDER BY date DESC`)
        .bind(m.owner_user_id, m.ledger_id, ...seqBinds)
    );
    // 2: asset_items
    dataStmts.push(
      db
        .prepare(`SELECT * FROM asset_items WHERE user_id = ? AND ledger_id = ?${seqClause} ORDER BY sort_order ASC, created_at ASC`)
        .bind(m.owner_user_id, m.ledger_id, ...seqBinds)
    );
    // 3: recurring_items
    dataStmts.push(
      db
        .prepare(`SELECT * FROM recurring_items WHERE user_id = ? AND ledger_id = ?${seqClause} ORDER BY sort_order ASC, created_at ASC`)
        .bind(m.owner_user_id, m.ledger_id, ...seqBinds)
    );
    // 4: savings_adjustments (linked via shared ledger's asset_items)
    dataStmts.push(
      db
        .prepare(
          `SELECT * FROM savings_adjustments
           WHERE user_id = ?
             AND account_id IN (SELECT id FROM asset_items WHERE user_id = ? AND ledger_id = ?)${seqClause}
           ORDER BY date DESC`
        )
        .bind(m.owner_user_id, m.owner_user_id, m.ledger_id, ...seqBinds)
    );
    // 5: split_receivables
    dataStmts.push(
      db
        .prepare(`SELECT * FROM split_receivables WHERE user_id = ? AND ledger_id = ?${seqClause} ORDER BY date DESC, created_at DESC`)
        .bind(m.owner_user_id, m.ledger_id, ...seqBinds)
    );
    // 6: installment_plans
    dataStmts.push(
      db
        .prepare(`SELECT * FROM installment_plans WHERE user_id = ? AND ledger_id = ?${seqClause} ORDER BY start_ym DESC, created_at DESC`)
        .bind(m.owner_user_id, m.ledger_id, ...seqBinds)
    );
  }

  const dataResults = dataStmts.length > 0 ? await db.batch(dataStmts) : [];
  const rowsAt = (idx: number) => (dataResults[idx]?.results || []) as Record<string, unknown>[];

  const joinedLedgers: Ledger[] = [];
  const joinedCashflow: CashFlowLog[] = [];
  const joinedAssets: AssetItem[] = [];
  const joinedRecurring: RecurringItem[] = [];
  const joinedAdjustments: SavingsAdjustment[] = [];
  const joinedSplits: SplitReceivable[] = [];
  const joinedInstallments: InstallmentPlan[] = [];
  const joinedStateByLedger = new Map<string, SharedLedgerSyncState>();

  for (const plan of joinedPlans) {
    const { m, ownerState, full, epochMismatch, startIdx } = plan;
    const ledgerRow = rowsAt(startIdx)[0];
    if (!ledgerRow || ledgerRow.deleted_at) continue;
    const members = membersByLedger.get(m.ledger_id) || [];
    const ownerDisplayName = userDisplayNames.get(m.owner_user_id) || '擁有者';
    const mappedLedger: Ledger = {
      ...mapLedgerRow(ledgerRow),
      // Per-member net worth preference overrides owner's flag for this member
      includeInNetWorth: Number(m.include_in_net_worth ?? 0) === 1,
      isShared: true,
      ownerUserId: m.owner_user_id,
      ownerDisplayName,
      myRole: m.role,
      memberCount: members.length,
    };
    joinedLedgers.push(mappedLedger);
    joinedCashflow.push(...rowsAt(startIdx + 1).map(mapCashFlowRow));
    joinedAssets.push(...rowsAt(startIdx + 2).map(mapAssetRow));
    joinedRecurring.push(...rowsAt(startIdx + 3).map(mapRecurringRow));
    joinedAdjustments.push(...rowsAt(startIdx + 4).map(mapSavingsAdjustmentRow));
    joinedSplits.push(...rowsAt(startIdx + 5).map(mapSplitReceivableRow));
    joinedInstallments.push(...rowsAt(startIdx + 6).map(mapInstallmentPlanRow));

    joinedStateByLedger.set(m.ledger_id, {
      ledgerId: m.ledger_id,
      ownerUserId: m.owner_user_id,
      ownerDisplayName,
      myRole: m.role,
      includeInNetWorth: Number(m.include_in_net_worth ?? 0) === 1,
      memberCount: members.length,
      members,
      changeSeq: ownerState.changeSeq,
      dataEpoch: ownerState.dataEpoch,
      ...(full ? { fullResyncRequired: true } : {}),
      ...(epochMismatch ? { epochMismatch: true } : {}),
    });
  }

  const sharedLedgers: SharedLedgerSyncState[] = [];
  for (const m of activeMemberships) {
    if (m.owner_user_id !== actorUid) {
      const st = joinedStateByLedger.get(m.ledger_id);
      if (st) sharedLedgers.push(st);
      continue;
    }
    const members = membersByLedger.get(m.ledger_id) || [];
    // Only mark as actively shared on the owner's side if at least 1 other member exists or membership exists
    const ownerDisplayName = userDisplayNames.get(actorUid) || '擁有者';
    sharedLedgers.push({
      ledgerId: m.ledger_id,
      ownerUserId: actorUid,
      ownerDisplayName,
      myRole: 'owner',
      includeInNetWorth: Number(m.include_in_net_worth ?? 0) === 1,
      memberCount: members.length,
      members,
      changeSeq: personalState.changeSeq,
      dataEpoch: personalState.dataEpoch,
    });
  }

  return {
    sharedLedgers,
    userDisplayNames,
    joinedLedgers,
    joinedCashflow,
    joinedAssets,
    joinedRecurring,
    joinedAdjustments,
    joinedSplits,
    joinedInstallments,
  };
}

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

  // Phase 9 (v2.0.0): active & revoked shared ledger memberships (0 extra D1 calls when empty)
  const activeMemberships = baseline.memberships.filter((m) => !m.revoked_at);
  const activeByLedgerId = new Map<string, RawLedgerMembership>(
    activeMemberships.map((m) => [m.ledger_id, m])
  );
  const ownedSharedLedgerIds = new Set<string>(
    activeMemberships.filter((m) => m.owner_user_id === uid && m.role === 'owner').map((m) => m.ledger_id)
  );
  const joinedMemberships = activeMemberships.filter((m) => m.owner_user_id !== uid);
  const revokedSharedSet = new Set<string>(
    baseline.memberships
      .filter((m) => m.owner_user_id !== uid && Boolean(m.revoked_at))
      .map((m) => m.ledger_id)
  );
  if (req.sharedCursors && typeof req.sharedCursors === 'object') {
    for (const lid of Object.keys(req.sharedCursors)) {
      if (!activeByLedgerId.has(lid)) {
        revokedSharedSet.add(lid);
      }
    }
  }
  const revokedSharedLedgerIds = Array.from(revokedSharedSet);
  const sharedEpochMismatchIds = new Set<string>();
  const forceFullSharedIds = new Set<string>();

  // Review R-A (v1.8.12): apply records before the mutations that reference them (older clients can send a
  // renamed/coalesced account after the cashflow that is linked to it), so the M3 guards do not reject them.
  const mutations = Array.isArray(req.mutations) ? orderMutationsByDependencies(req.mutations) : [];
  const ackedMutationIds: string[] = [];
  const rejected: Array<{ mutationId: string; reason: string }> = [];
  const conflicts: SyncConflict[] = [];

  const mergeSharedIntoDelta = async (
    delta: SyncDelta,
    personalState: { changeSeq: number; dataEpoch: number },
    forceAllSharedFull: boolean
  ): Promise<{ sharedLedgers?: SharedLedgerSyncState[]; revokedSharedLedgerIds?: string[] }> => {
    if (activeMemberships.length === 0) {
      return revokedSharedLedgerIds.length > 0 ? { revokedSharedLedgerIds } : {};
    }
    const forceSet = forceAllSharedFull
      ? new Set(activeMemberships.map((m) => m.ledger_id))
      : forceFullSharedIds;
    const shared = await readSharedLedgersDelta(
      db,
      uid,
      activeMemberships,
      personalState,
      req.sharedCursors,
      forceSet,
      sharedEpochMismatchIds
    );
    // Tag owner's own shared ledgers in delta.ledgers with shared metadata
    const stateByLedger = new Map(shared.sharedLedgers.map((s) => [s.ledgerId, s]));
    if (delta.ledgers) {
      for (const l of delta.ledgers) {
        const st = stateByLedger.get(l.id);
        if (st && st.ownerUserId === uid) {
          l.isShared = true;
          l.ownerUserId = uid;
          l.ownerDisplayName = st.ownerDisplayName;
          l.myRole = 'owner';
          l.memberCount = st.memberCount;
        }
      }
    }
    if (shared.joinedLedgers.length > 0) {
      delta.ledgers = [...(delta.ledgers || []), ...shared.joinedLedgers];
      delta.cashflowLogs = [...delta.cashflowLogs, ...shared.joinedCashflow];
      delta.assetItems = [...delta.assetItems, ...shared.joinedAssets];
      delta.recurringItems = [...delta.recurringItems, ...shared.joinedRecurring];
      delta.savingsAdjustments = [...(delta.savingsAdjustments || []), ...shared.joinedAdjustments];
      delta.splitReceivables = [...(delta.splitReceivables || []), ...shared.joinedSplits];
      delta.installmentPlans = [...(delta.installmentPlans || []), ...shared.joinedInstallments];
    }
    // Enrich updatedByName for all shareable entities
    enrichUpdatedByName(delta.cashflowLogs, shared.userDisplayNames);
    enrichUpdatedByName(delta.assetItems, shared.userDisplayNames);
    enrichUpdatedByName(delta.recurringItems, shared.userDisplayNames);
    enrichUpdatedByName(delta.savingsAdjustments, shared.userDisplayNames);
    enrichUpdatedByName(delta.splitReceivables, shared.userDisplayNames);
    enrichUpdatedByName(delta.installmentPlans, shared.userDisplayNames);

    const missingJoinedIds = joinedMemberships
      .filter((membership) => !stateByLedger.has(membership.ledger_id))
      .map((membership) => membership.ledger_id);
    const revokedIds = [...new Set([...revokedSharedLedgerIds, ...missingJoinedIds])];
    return {
      ...(shared.sharedLedgers.length > 0 ? { sharedLedgers: shared.sharedLedgers } : {}),
      ...(revokedIds.length > 0 ? { revokedSharedLedgerIds: revokedIds } : {}),
    };
  };

  const buildFullResyncResponse = async (markEpochMismatch: boolean): Promise<SyncResponse> => {
    // Q2 / N2 / R-4: the full snapshot, its cursor and its epoch are read in one D1 batch (one transaction), so
    // they are consistent: a concurrent write lands either before (included) or after (cursor is lower).
    const full = await readDeltaWithState(db, uid, { kind: 'full' });
    const sharedMeta = await mergeSharedIntoDelta(
      full.delta,
      { changeSeq: full.changeSeq, dataEpoch: full.dataEpoch },
      true
    );
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
      ...sharedMeta,
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
      (m.atomicGroupId === undefined || m.atomicGroupId === null || typeof m.atomicGroupId === 'string') &&
      (m.sharedLedgerId === undefined || m.sharedLedgerId === null || typeof m.sharedLedgerId === 'string');
    if (!hasValidEnvelope) return 'Invalid mutation format';
    if (!ALLOWED_SYNC_ENTITIES.has(String(m.entity)) || !ALLOWED_SYNC_OPS.has(String(m.op))) {
      return `不支援的同步類型或操作：${String(m.entity)}:${String(m.op)}`;
    }
    return null;
  };

  // Phase 9: load owner data_epochs when incoming mutations may target joined shared ledgers (0 calls otherwise)
  const joinedOwnerEpochs = new Map<string, number>();
  if (mutations.length > 0 && joinedMemberships.length > 0) {
    const distinctOwners = Array.from(new Set(joinedMemberships.map((m) => m.owner_user_id)));
    const rows = await db
      .prepare(
        `SELECT user_id, data_epoch FROM user_sync_state WHERE user_id IN (${distinctOwners.map(() => '?').join(', ')})`
      )
      .bind(...distinctOwners)
      .all<{ user_id: string; data_epoch: number }>();
    for (const r of rows.results || []) {
      joinedOwnerEpochs.set(String(r.user_id), Number(r.data_epoch ?? 1));
    }
  }

  type ResolvedMutationTarget =
    | { ok: true; storageUid: string; expectedEpoch: number; scope: SharedWriteScope }
    | { ok: false; kind: 'reject'; reason: string }
    | { ok: false; kind: 'shared_epoch_mismatch'; ledgerId: string };

  const rowPrefetch: RowPrefetch = new Map();
  const resolveMutationTarget = (m: SyncMutation): ResolvedMutationTarget => {
    const hintedSharedId =
      typeof m.sharedLedgerId === 'string' && m.sharedLedgerId.trim() ? m.sharedLedgerId.trim() : null;
    const payloadLid =
      m.payload && typeof m.payload.ledgerId === 'string' && m.payload.ledgerId.trim()
        ? m.payload.ledgerId.trim()
        : null;
    const payloadMem = payloadLid ? activeByLedgerId.get(payloadLid) : undefined;
    const recordMem = m.entity === 'ledger' ? activeByLedgerId.get(m.recordId) : undefined;
    const table = ENTITY_ROW_TABLE[m.entity]?.table;
    const ownRow = table ? rowPrefetch.get(`${uid}:${table}:${m.recordId}`) : undefined;
    const ownLedgerId = normalizeLedgerId(ownRow?.ledger_id);
    const targetSharedId = hintedSharedId ||
      (payloadMem ? payloadLid : null) ||
      (recordMem ? m.recordId : null) ||
      (ownedSharedLedgerIds.has(ownLedgerId) ? ownLedgerId : null);

    if (!targetSharedId) {
      return {
        ok: true,
        storageUid: uid,
        expectedEpoch,
        scope: {
          actorUid: uid,
          storageUid: uid,
          sharedLedgerId: null,
          sharedRole: null,
          ownedSharedLedgerIds,
          hasUpdatedByCols: baseline.hasSharedLedgerSchema,
        },
      };
    }

    if (targetSharedId === DEFAULT_LEDGER_ID) {
      return { ok: false, kind: 'reject', reason: '預設個人主帳本不支援共同帳本同步操作。' };
    }
    const membership = activeByLedgerId.get(targetSharedId);
    if (!membership) {
      return {
        ok: false,
        kind: 'reject',
        reason: '您沒有此共同帳本的存取權限，或成員資格已被移除。',
      };
    }
    if (!SHARED_LEDGER_ENTITY_SET.has(m.entity)) {
      return { ok: false, kind: 'reject', reason: '此資料類型不支援在共同帳本內同步。' };
    }
    if (m.entity === 'ledger') {
      if (membership.role !== 'owner' || membership.owner_user_id !== uid) {
        return { ok: false, kind: 'reject', reason: '僅共同帳本擁有者可修改或刪除帳本設定。' };
      }
    } else if (membership.role === 'viewer') {
      return {
        ok: false,
        kind: 'reject',
        reason: '您在此共同帳本為「僅檢視」權限，無法新增、修改或刪除資料。',
      };
    }

    const storageUid = membership.owner_user_id;
    let targetEpoch = expectedEpoch;
    if (storageUid !== uid) {
      const ownerEpoch = joinedOwnerEpochs.get(storageUid) ?? 1;
      const clientSharedEpoch = req.sharedCursors?.[targetSharedId]?.clientEpoch;
      if (
        typeof clientSharedEpoch === 'number' &&
        Number.isFinite(clientSharedEpoch) &&
        clientSharedEpoch !== ownerEpoch
      ) {
        return { ok: false, kind: 'shared_epoch_mismatch', ledgerId: targetSharedId };
      }
      targetEpoch = ownerEpoch;
    }

    return {
      ok: true,
      storageUid,
      expectedEpoch: targetEpoch,
      scope: {
        actorUid: uid,
        storageUid,
        sharedLedgerId: targetSharedId,
        sharedRole: membership.role,
        ownedSharedLedgerIds,
        hasUpdatedByCols: baseline.hasSharedLedgerSchema,
      },
    };
  };

  const isApplied = async (mutationId: string): Promise<boolean> =>
    Boolean(
      await db
        .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
        .bind(uid, mutationId)
        .first()
    );

  /** M4: applies an atomic group; returns true when the request must stop (personal epoch changed). */
  const processGroup = async (members: SyncMutation[]): Promise<boolean> => {
    const pendingMembers: SyncMutation[] = [];
    for (const m of members) {
      if (alreadyApplied.has(m.mutationId)) ackedMutationIds.push(m.mutationId);
      else pendingMembers.push(m);
    }
    if (pendingMembers.length === 0) return false;

    // Resolve and verify every member targets the exact same domain (personal or single shared ledger)
    let groupTarget: Extract<ResolvedMutationTarget, { ok: true }> | null = null;
    for (const m of pendingMembers) {
      const resolved = resolveMutationTarget(m);
      if (!resolved.ok) {
        if (resolved.kind === 'shared_epoch_mismatch') {
          sharedEpochMismatchIds.add(resolved.ledgerId);
          return false; // leave unacked so client freezes this shared ledger's outbox
        }
        for (const member of pendingMembers) {
          rejected.push({ mutationId: member.mutationId, reason: resolved.reason });
        }
        return false;
      }
      if (!groupTarget) {
        groupTarget = resolved;
      } else if (
        groupTarget.storageUid !== resolved.storageUid ||
        groupTarget.scope.sharedLedgerId !== resolved.scope.sharedLedgerId
      ) {
        for (const member of pendingMembers) {
          rejected.push({
            mutationId: member.mutationId,
            reason: '同一筆原子異動不可跨個人與共同帳本或跨不同共同帳本。',
          });
        }
        return false;
      }
    }
    if (!groupTarget) return false;

    try {
      await applyMutationGroup(
        db,
        groupTarget.storageUid,
        pendingMembers,
        settings,
        serverTime,
        groupTarget.expectedEpoch,
        groupTarget.scope
      );
      for (const m of pendingMembers) ackedMutationIds.push(m.mutationId);
      return false;
    } catch (err) {
      if (err instanceof EpochMismatchError) {
        if (groupTarget.storageUid !== uid && groupTarget.scope.sharedLedgerId) {
          sharedEpochMismatchIds.add(groupTarget.scope.sharedLedgerId);
          return false;
        }
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
      if ((await getCurrentDataEpoch(db, groupTarget.storageUid)) !== groupTarget.expectedEpoch) {
        if (groupTarget.storageUid !== uid && groupTarget.scope.sharedLedgerId) {
          sharedEpochMismatchIds.add(groupTarget.scope.sharedLedgerId);
          return false;
        }
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
      const target = resolveMutationTarget(m);
      if (!target.ok) continue;
      const key = `${target.storageUid}:${spec.table}:${m.recordId}`;
      if (rowKeys.includes(key)) continue;
      rowKeys.push(key);
      stmts.push(
        db
          .prepare(`SELECT * FROM ${spec.table} WHERE user_id = ? AND ${spec.keyColumn} = ?`)
          .bind(target.storageUid, m.recordId)
      );
    }
    if (stmts.length > 0) {
      let results: D1Result<unknown>[];
      let prefetchedRowKeys = rowKeys;
      try {
        results = await db.batch(stmts);
      } catch (err) {
        if (!isMissingOptionalTableError(err)) {
          throw err;
        }
        // Pre-migration DB: drop optional post-0020 tables from prefetch so applySingleMutation rejects them cleanly
        const fallbackStmts = stmts.slice(0, idemStatements);
        prefetchedRowKeys = [];
        rowKeys.forEach((key, idx) => {
          const isOpt = OPTIONAL_SYNC_TABLES.some((tbl) => key.includes(`:${tbl}:`));
          if (!isOpt) {
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

    const target = resolveMutationTarget(mut);
    if (!target.ok) {
      handledIdx.add(idx);
      if (target.kind === 'shared_epoch_mismatch') {
        sharedEpochMismatchIds.add(target.ledgerId);
      } else {
        rejected.push({ mutationId: mut.mutationId, reason: target.reason });
      }
      continue;
    }

    if (!fitsBudget(1)) break; // H5: leave the rest for the next request
    handledIdx.add(idx);
    processedMutations += 1;

    try {
      await applySingleMutation(
        db,
        target.storageUid,
        mut,
        settings,
        serverTime,
        target.expectedEpoch,
        target.scope
      );
      ackedMutationIds.push(mut.mutationId);
    } catch (err) {
      if (err instanceof EpochMismatchError) {
        if (target.storageUid !== uid && target.scope.sharedLedgerId) {
          sharedEpochMismatchIds.add(target.scope.sharedLedgerId);
          continue;
        }
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
          const currEpoch = await getCurrentDataEpoch(db, target.storageUid);
          if (currEpoch !== target.expectedEpoch) {
            if (target.storageUid !== uid && target.scope.sharedLedgerId) {
              sharedEpochMismatchIds.add(target.scope.sharedLedgerId);
              continue;
            }
            epochChangedDuringMutations = true;
            break;
          }
          conflicts.push(err.conflict);
        }
      } else if (err instanceof RejectError) {
        // V4: A rejection evaluated against data restored by a concurrent replace import is meaningless
        // for a stale-epoch client — stop and let the client freeze it instead of dropping it as an error.
        if ((await getCurrentDataEpoch(db, target.storageUid)) !== target.expectedEpoch) {
          if (target.storageUid !== uid && target.scope.sharedLedgerId) {
            sharedEpochMismatchIds.add(target.scope.sharedLedgerId);
            continue;
          }
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
          if ((await getCurrentDataEpoch(db, target.storageUid)) !== target.expectedEpoch) {
            if (target.storageUid !== uid && target.scope.sharedLedgerId) {
              sharedEpochMismatchIds.add(target.scope.sharedLedgerId);
              continue;
            }
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

  const sharedMeta = await mergeSharedIntoDelta(
    read.delta,
    { changeSeq: read.changeSeq, dataEpoch: read.dataEpoch },
    !useSeqCursor && !req.since
  );

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
    ...sharedMeta,
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
    installmentPlans: delta.installmentPlans || [],
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
): Promise<{
  importedLogs: number;
  importedRecurring: number;
  importedSinking: number;
  importedAssets: number;
  /** v1.8.17 review: ledgers recreated because imported records pointed at a ledger missing from the backup */
  recoveredLedgers: number;
}> {
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
  // active ledger already on the server — otherwise the money would silently drop out of every total. Since the
  // v1.8.17 review, an unresolved ledger is recreated as a recovered ledger (below) instead of failing the import.
  // Asset references (linked account / adjustment account / stock asset) are not rejected here: exports legitimately
  // contain records whose account was deleted earlier (those rows are inert), and refusing them would make such
  // backups impossible to restore. The sync write path blocks new dangling references for current clients
  // (v1.8.11 clients get the lenient check, see refGuardSql).
  let recoveredLedgerCount = 0;
  {
    const knownLedgers = new Set<string>([DEFAULT_LEDGER_ID, ...validatedLedgers.map((l) => l.id)]);
    const deletedLedgerIds = new Set<string>();
    if (mode === 'merge') {
      const existingLedgers = await db
        .prepare('SELECT id, deleted_at FROM ledgers WHERE user_id = ?')
        .bind(uid)
        .all<{ id: string; deleted_at: string | null }>();
      for (const r of existingLedgers.results || []) {
        if (r.deleted_at) deletedLedgerIds.add(String(r.id));
        else knownLedgers.add(String(r.id));
      }
    }
    // v1.8.17 review finding 2: a record can point at a ledger that never reached the server (accepted by the
    // lenient M3 path for v1.8.11 clients). Rejecting such records made the user's own backup impossible to
    // restore. Instead, recreate each missing ledger as a "recovered" ledger that is excluded from net worth —
    // the records become visible again and every total stays exactly as it was before the export.
    const recoveredLedgerIds = new Map<string, string>();
    const resolveImportLedger = (ledgerId: string): string => {
      const lid = normalizeLedgerId(ledgerId);
      if (knownLedgers.has(lid)) return lid;
      let target = recoveredLedgerIds.get(lid);
      if (!target) {
        // a soft-deleted ledger with the same id would not be revived by the upsert below — use a fresh id
        target = deletedLedgerIds.has(lid) ? crypto.randomUUID() : lid;
        recoveredLedgerIds.set(lid, target);
        knownLedgers.add(target);
        validatedLedgers.push({
          id: target,
          v: validateLedgerInput({
            name: `復原的帳本 ${lid.slice(0, 8)}`,
            includeInNetWorth: false,
            note: `匯入時自動重建：備份中有紀錄指向不存在的帳本（原 id：${lid.slice(0, 64)}）`,
          }),
          createdAt: nowIso,
        });
      }
      return target;
    };
    for (const r of validatedLogs) r.v.ledgerId = resolveImportLedger(r.v.ledgerId);
    for (const r of validatedRecurring) r.v.ledgerId = resolveImportLedger(r.v.ledgerId);
    for (const r of validatedAssets) r.v.ledgerId = resolveImportLedger(r.v.ledgerId);
    recoveredLedgerCount = recoveredLedgerIds.size;
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

  const validatedInstallments: Array<{
    id: string;
    v: ReturnType<typeof validateInstallmentPlanInput>;
    createdAt: string;
  }> = [];
  for (const ip of data.installmentPlans || []) {
    if (!ip || ip.deletedAt) continue;
    validatedInstallments.push({
      id: importText(ip.id, 'id') || crypto.randomUUID(),
      v: validateInstallmentPlanInput(ip),
      createdAt: importText(ip.createdAt, 'createdAt') || nowIso,
    });
  }

  const optTablesRes = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('financial_goals', 'split_receivables', 'installment_plans', 'ledger_members', 'ledger_invites')"
    )
    .all<{ name: string }>();
  const optTables = new Set((optTablesRes.results || []).map((r) => r.name));
  const hasGoalsTable = optTables.has('financial_goals');
  const hasSplitsTable = optTables.has('split_receivables');
  const hasInstallmentsTable = optTables.has('installment_plans');
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
  if (!hasInstallmentsTable && validatedInstallments.length > 0) {
    throw new Error(
      '伺服器資料庫尚未完成升級（缺少分期付款資料表），請先執行 0024 資料庫遷移後再匯入備份。'
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
    if (hasInstallmentsTable) {
      stmts.push(db.prepare('DELETE FROM installment_plans WHERE user_id = ?').bind(uid));
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
  const chunkedEntity = (
    table: string,
    keyColumn: 'id' | 'period',
    jsonColumns: readonly string[],
    rows: unknown[][]
  ): { start: number; end: number } => {
    const start = stmts.length;
    if (rows.length === 0) return { start, end: start };
    const sql = buildChunkedImportSql({ table, keyColumn, jsonColumns });
    for (let i = 0; i < rows.length; i += IMPORT_CHUNK_ROWS) {
      const chunk = rows.slice(i, i + IMPORT_CHUNK_ROWS);
      stmts.push(db.prepare(sql).bind(uid, uid, JSON.stringify(chunk)));
    }
    return { start, end: stmts.length };
  };

  const hasCcColsImport = hasInstallmentsTable || (await hasAssetCreditCardColumns(db));
  if (!hasCcColsImport && validatedAssets.some((a) => a.v.isCreditCard)) {
    throw new Error(
      '伺服器資料庫尚未完成升級（缺少信用卡欄位），請先執行 0024 資料庫遷移後再匯入備份。'
    );
  }
  const hasCfInstColsImport = hasInstallmentsTable || (await hasCashflowInstallmentColumns(db));
  if (!hasCfInstColsImport && validatedLogs.some((l) => l.v.installmentPlanId !== null || l.v.installmentSeq !== null)) {
    throw new Error(
      '伺服器資料庫尚未完成升級（缺少流水帳分期關聯欄位），請先執行 0024 資料庫遷移後再匯入備份。'
    );
  }

  const logsRange = chunkedEntity(
    'cashflow_logs',
    'id',
    [
      'id', 'date', 'year_month', 'type', 'category', 'item_name', 'amount', 'currency',
      'fx_rate', 'twd_amount', 'source', 'note', 'linked_account_id', 'ledger_id', 'created_at', 'updated_at',
      ...(hasCfInstColsImport ? ['installment_plan_id', 'installment_seq'] : []),
    ],
    validatedLogs.map(({ id, v, createdAt }) => [
      id, v.date, v.yearMonth, v.type, v.category, v.itemName, v.amount, v.currency, v.fxRate, v.twdAmount,
      v.source, v.note, v.linkedAccountId, v.ledgerId, createdAt, nowIso,
      ...(hasCfInstColsImport ? [v.installmentPlanId, v.installmentSeq] : []),
    ])
  );

  // v1.13.1: post_day only when migration 0022 is applied; without it a non-default day fails the import loudly
  const recurringPostDayCol = await hasRecurringPostDayColumn(db);
  if (!recurringPostDayCol && validatedRecurring.some((r) => r.v.postDay !== 1)) {
    throw new Error('伺服器資料庫尚未完成升級（缺少「入帳日」欄位），請先執行資料庫遷移後再匯入備份。');
  }
  const recurringRange = chunkedEntity(
    'recurring_items',
    'id',
    [
      'id', 'item_name', 'category', 'type', 'amount', 'currency', 'cycle', 'billing_spec',
      'status', 'note', 'linked_account_id', 'ledger_id', 'sort_order', 'created_at', 'updated_at',
      ...(recurringPostDayCol ? ['post_day'] : []),
    ],
    validatedRecurring.map(({ id, v, createdAt }) => [
      id, v.itemName, v.category, v.type, v.amount, v.currency, v.cycle, v.billingSpec, v.status, v.note,
      v.linkedAccountId, v.ledgerId, v.sortOrder, createdAt, nowIso,
      ...(recurringPostDayCol ? [v.postDay] : []),
    ])
  );

  // v2.1.0: schedule columns only when migration 0026 is applied; without it a scheduled item fails the import loudly
  const sinkingScheduleCols = await hasSinkingScheduleColumns(db);
  if (!sinkingScheduleCols && validatedSinking.some((r) => !isDefaultSinkingSchedule(r.v))) {
    throw new Error('伺服器資料庫尚未完成升級（缺少攤提「開始月份」欄位），請先執行資料庫遷移 0026 後再匯入備份。');
  }
  const sinkingRange = chunkedEntity(
    'sinking_fund_items',
    'id',
    [
      'id', 'item_name', 'category', 'total_amount', 'months', 'due_note', 'status', 'note', 'sort_order', 'created_at', 'updated_at',
      ...(sinkingScheduleCols ? ['start_ym', 'repeat_yearly', 'fund_kind'] : []),
    ],
    validatedSinking.map(({ id, v, createdAt }) => [
      id, v.itemName, v.category, v.totalAmount, v.months, v.dueNote, v.status, v.note, v.sortOrder, createdAt, nowIso,
      ...(sinkingScheduleCols ? [v.startYm, v.repeatYearly ? 1 : 0, v.fundKind] : []),
    ])
  );

  const assetsRange = chunkedEntity(
    'asset_items',
    'id',
    [
      'id', 'update_mode', 'major_type', 'sub_category', 'liquidity', 'item_name', 'ticker', 'quantity_or_amount',
      'currency', 'unit_price', 'previous_close', 'cost_basis', 'price_updated_at', 'note', 'is_linked_savings',
      'balance_anchor_date', 'balance_anchor_at', 'is_default_savings', 'is_amortizing_loan', 'loan_annual_rate',
      'loan_monthly_payment', 'loan_billing_day', 'sort_order', 'stock_category', 'is_watchlist', 'ledger_id',
      'exclude_from_net_worth', 'created_at', 'updated_at',
      ...(hasCcColsImport ? ['is_credit_card', 'credit_billing_day', 'credit_due_day', 'credit_limit'] : []),
    ],
    validatedAssets.map(({ id, v, priceUpdatedAt, createdAt }) => [
      id, v.updateMode, v.majorType, v.subCategory, v.liquidity, v.itemName, v.ticker, v.quantityOrAmount, v.currency,
      v.unitPrice, v.previousClose, v.costBasis, priceUpdatedAt, v.note, v.isLinkedSavings ? 1 : 0,
      v.balanceAnchorDate, v.balanceAnchorAt, v.isDefaultSavings ? 1 : 0, v.isAmortizingLoan ? 1 : 0,
      v.loanAnnualRate, v.loanMonthlyPayment, v.loanBillingDay, v.sortOrder, v.stockCategory, v.isWatchlist ? 1 : 0,
      v.ledgerId, v.excludeFromNetWorth ? 1 : 0, createdAt, nowIso,
      ...(hasCcColsImport ? [v.isCreditCard ? 1 : 0, v.creditBillingDay, v.creditDueDay, v.creditLimit] : []),
    ])
  );

  chunkedEntity(
    'savings_adjustments',
    'id',
    ['id', 'account_id', 'date', 'amount', 'twd_amount', 'note', 'transfer_group_id', 'created_at', 'updated_at'],
    validatedAdjs.map(({ id, v, twdAmount, createdAt }) => [
      id, v.accountId, v.date, v.amount, twdAmount, v.note, v.transferGroupId, createdAt, nowIso,
    ])
  );

  chunkedEntity(
    'stock_transactions',
    'id',
    ['id', 'asset_id', 'date', 'tx_type', 'shares', 'total_amount', 'fee', 'linked_cashflow_id', 'note', 'created_at', 'updated_at'],
    validatedStockTxs.map(({ id, v, createdAt }) => [
      id, v.assetId, v.date, v.txType, v.shares, v.totalAmount, v.fee, v.linkedCashflowId, v.note, createdAt, nowIso,
    ])
  );

  if (validatedHistory.length > 0) {
    const historySelectCols = Array.from({ length: 13 }, (_, i) => `json_extract(value, '$[${i}]')`).join(', ');
    const historySql = `INSERT OR REPLACE INTO networth_history (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq) SELECT ?, ${historySelectCols}, ${CURR_SEQ_SQL} FROM json_each(?) WHERE true`;
    const historyRows = validatedHistory.map((h) => [
      h.yearMonth, h.snapshotDate, h.totalAssets, h.totalLiabilities, h.netWorth, h.highLiquidityAssets,
      h.investmentAssets, h.insuranceAssets, h.monthlyIncome, h.monthlyConsumption, h.savingsRate, h.note, nowIso,
    ]);
    for (let i = 0; i < historyRows.length; i += IMPORT_CHUNK_ROWS) {
      const chunk = historyRows.slice(i, i + IMPORT_CHUNK_ROWS);
      stmts.push(db.prepare(historySql).bind(uid, uid, JSON.stringify(chunk)));
    }
  }

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

  chunkedEntity(
    'rent_utility_records',
    'period',
    ['period', 'is_baseline', 'cur_total', 'cur_6f', 'total_elec', 'total_water', 'f6_people', 'f5_people', 'cur_a', 'cur_b', 'cur_c', 'created_at', 'updated_at'],
    validatedUtilityRecords.map(({ v, createdAt }) => [
      v.period, v.isBaseline ? 1 : 0, v.curTotal, v.cur6F, v.totalElec, v.totalWater, v.f6People, v.f5People,
      v.curA, v.curB, v.curC, createdAt, nowIso,
    ])
  );

  if (hasGoalsTable && validatedGoals.length > 0) {
    chunkedEntity(
      'financial_goals',
      'id',
      [
        'id', 'name', 'goal_type', 'target_amount', 'currency', 'linked_ledger_id', 'linked_asset_ids_json',
        'current_manual_amount', 'expected_annual_return_pct', 'monthly_contribution_override', 'fire_swr_pct',
        'target_date', 'sort_order', 'note', 'created_at', 'updated_at',
      ],
      validatedGoals.map(({ id, v, createdAt }) => [
        id, v.name, v.goalType, v.targetAmount, v.currency, v.linkedLedgerId, JSON.stringify(v.linkedAssetIds),
        v.currentManualAmount, v.expectedAnnualReturnPct, v.monthlyContributionOverride, v.fireSwrPct,
        v.targetDate, v.sortOrder, v.note, createdAt, nowIso,
      ])
    );
  }

  if (hasSplitsTable && validatedSplits.length > 0) {
    chunkedEntity(
      'split_receivables',
      'id',
      [
        'id', 'ledger_id', 'split_group_id', 'counterparty', 'date', 'item_name', 'category', 'amount',
        'settled_amount', 'currency', 'fx_rate', 'twd_amount', 'status', 'source_cashflow_id',
        'source_account_id', 'source_adjustment_id', 'note', 'created_at', 'updated_at',
      ],
      validatedSplits.map(({ id, v, createdAt }) => [
        id, v.ledgerId, v.splitGroupId, v.counterparty, v.date, v.itemName, v.category, v.amount,
        v.settledAmount, v.currency, v.fxRate, v.twdAmount, v.status, v.sourceCashflowId,
        v.sourceAccountId, v.sourceAdjustmentId, v.note, createdAt, nowIso,
      ])
    );
  }

  if (hasInstallmentsTable && validatedInstallments.length > 0) {
    chunkedEntity(
      'installment_plans',
      'id',
      [
        'id', 'ledger_id', 'card_account_id', 'item_name', 'category', 'total_amount', 'total_installments',
        'posted_installments', 'start_ym', 'post_day', 'currency', 'status', 'note', 'created_at', 'updated_at',
      ],
      validatedInstallments.map(({ id, v, createdAt }) => [
        id, v.ledgerId, v.cardAccountId, v.itemName, v.category, v.totalAmount, v.totalInstallments,
        v.postedInstallments, v.startYm, v.postDay, v.currency, v.status, v.note, createdAt, nowIso,
      ])
    );
  }

  if (mode === 'replace') {
    for (const table of ['ledger_members', 'ledger_invites']) {
      if (!optTables.has(table)) continue;
      stmts.push(db.prepare(
        `UPDATE ${table} SET revoked_at = ?
         WHERE owner_user_id = ? AND revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM ledgers WHERE user_id = ${table}.owner_user_id
               AND id = ${table}.ledger_id AND deleted_at IS NULL
           )`
      ).bind(nowIso, uid));
    }
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
    recoveredLedgers: recoveredLedgerCount,
  };
}
