import {
  DEFAULT_EMERGENCY_MONTHS,
  DEFAULT_MONTHLY_DAILY_BUDGET,
  DEFAULT_USD_TWD_RATE,
} from '../shared/constants';
import type {
  AppSettings,
  AssetItem,
  CashFlowLog,
  FinanceSnapshot,
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
  toSafeNumber,
  validateAssetInput,
  validateCashFlowInput,
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

export async function ensureAppSettings(db: D1Database, userId: string): Promise<AppSettings> {
  const uid = assertUserId(userId);
  const row = await db
    .prepare('SELECT * FROM app_settings WHERE user_id = ?')
    .bind(uid)
    .first<{
      monthly_daily_budget: number;
      emergency_target_months: number;
      usd_twd_rate: number;
      fx_updated_at: string | null;
      updated_at: string;
      version?: number;
    }>();

  if (row) {
    return {
      monthlyDailyBudget: row.monthly_daily_budget,
      emergencyTargetMonths: row.emergency_target_months,
      usdTwdRate: row.usd_twd_rate,
      fxUpdatedAt: row.fx_updated_at,
      updatedAt: row.updated_at,
      version: Number(row.version ?? 1),
    };
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO app_settings (user_id, monthly_daily_budget, emergency_target_months, usd_twd_rate, updated_at, version)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
    .bind(uid, DEFAULT_MONTHLY_DAILY_BUDGET, DEFAULT_EMERGENCY_MONTHS, DEFAULT_USD_TWD_RATE, nowIso)
    .run();

  return {
    monthlyDailyBudget: DEFAULT_MONTHLY_DAILY_BUDGET,
    emergencyTargetMonths: DEFAULT_EMERGENCY_MONTHS,
    usdTwdRate: DEFAULT_USD_TWD_RATE,
    fxUpdatedAt: null,
    updatedAt: nowIso,
    version: 1,
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

function checkVersionOrThrow(
  mutation: SyncMutation,
  existingRow: Record<string, unknown> | null,
  existingMapped: Record<string, unknown> | null,
  serverTime: string
): { shouldApply: boolean; nextVersion: number; writeTs: string } {
  const clientTs = mutation.clientTimestamp || serverTime;
  const hasExplicitBase = mutation.baseVersion !== undefined;
  const writeTs = hasExplicitBase ? serverTime : clientTs;

  if (!existingRow) {
    return { shouldApply: true, nextVersion: 1, writeTs };
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

  // Legacy client without baseVersion -> LWW fallback
  if (!isNewerOrEqual(clientTs, existingUpdatedAt)) {
    return { shouldApply: false, nextVersion: serverVersion, writeTs };
  }
  return { shouldApply: true, nextVersion: serverVersion + 1, writeTs };
}

async function applySingleMutation(
  db: D1Database,
  userId: string,
  mutation: SyncMutation,
  defaultFxRate: number,
  serverTime: string
): Promise<void> {
  const uid = assertUserId(userId);

  if (mutation.entity === 'settings') {
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
      serverTime
    );
    if (!check.shouldApply) return;
    const budget = Math.max(0, Math.round(toSafeNumber(p.monthlyDailyBudget, existing.monthlyDailyBudget)));
    const months = Math.min(60, Math.max(1, Math.round(toSafeNumber(p.emergencyTargetMonths, existing.emergencyTargetMonths))));
    const fx = toSafeNumber(p.usdTwdRate, existing.usdTwdRate);
    const validFx = fx > 10 && fx < 100 ? fx : existing.usdTwdRate;
    await db
      .prepare(
        `UPDATE app_settings
         SET monthly_daily_budget = ?, emergency_target_months = ?, usd_twd_rate = ?, updated_at = ?, version = ?
         WHERE user_id = ?`
      )
      .bind(budget, months, validFx, check.writeTs, check.nextVersion, uid)
      .run();
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
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (!existing) return;
      await db
        .prepare('UPDATE cashflow_logs SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND id = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateCashFlowInput(
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
      },
      defaultFxRate
    );

    await db
      .prepare(
        `INSERT INTO cashflow_logs
          (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, linked_account_id, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           date = excluded.date,
           year_month = excluded.year_month,
           type = excluded.type,
           category = excluded.category,
           item_name = excluded.item_name,
           amount = excluded.amount,
           currency = excluded.currency,
           fx_rate = excluded.fx_rate,
           twd_amount = excluded.twd_amount,
           source = excluded.source,
           note = excluded.note,
           linked_account_id = excluded.linked_account_id,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
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
        String(p.createdAt || check.writeTs),
        check.writeTs,
        check.nextVersion
      )
      .run();
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
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (!existing) return;
      await db
        .prepare('UPDATE recurring_items SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND id = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateRecurringInput({
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
    });

    await db
      .prepare(
        `INSERT INTO recurring_items
          (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           item_name = excluded.item_name,
           category = excluded.category,
           type = excluded.type,
           amount = excluded.amount,
           currency = excluded.currency,
           cycle = excluded.cycle,
           billing_spec = excluded.billing_spec,
           status = excluded.status,
           note = excluded.note,
           linked_account_id = excluded.linked_account_id,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
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
        String(p.createdAt || check.writeTs),
        check.writeTs,
        check.nextVersion
      )
      .run();
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
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (!existing) return;
      await db
        .prepare('UPDATE sinking_fund_items SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND id = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateSinkingInput({
      itemName: String(p.itemName || ''),
      category: String(p.category || ''),
      totalAmount: Number(p.totalAmount),
      months: Number(p.months),
      dueNote: String(p.dueNote || ''),
      status: String(p.status || '啟用'),
      note: String(p.note || ''),
    });

    await db
      .prepare(
        `INSERT INTO sinking_fund_items
          (user_id, id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           item_name = excluded.item_name,
           category = excluded.category,
           total_amount = excluded.total_amount,
           months = excluded.months,
           due_note = excluded.due_note,
           status = excluded.status,
           note = excluded.note,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
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
        String(p.createdAt || check.writeTs),
        check.writeTs,
        check.nextVersion
      )
      .run();
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
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (!existing) return;
      await db
        .prepare('UPDATE asset_items SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND id = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateAssetInput({
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
    });

    if (v.isDefaultSavings) {
      await db
        .prepare(
          'UPDATE asset_items SET is_default_savings = 0, updated_at = ?, version = version + 1 WHERE user_id = ? AND is_default_savings = 1 AND id != ?'
        )
        .bind(check.writeTs, uid, mutation.recordId)
        .run();
    }

    await db
      .prepare(
        `INSERT INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, cost_basis, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           update_mode = excluded.update_mode,
           major_type = excluded.major_type,
           sub_category = excluded.sub_category,
           liquidity = excluded.liquidity,
           item_name = excluded.item_name,
           ticker = excluded.ticker,
           quantity_or_amount = excluded.quantity_or_amount,
           currency = excluded.currency,
           unit_price = excluded.unit_price,
           cost_basis = excluded.cost_basis,
           note = excluded.note,
           is_linked_savings = excluded.is_linked_savings,
           balance_anchor_date = excluded.balance_anchor_date,
           balance_anchor_at = excluded.balance_anchor_at,
           is_default_savings = excluded.is_default_savings,
           is_amortizing_loan = excluded.is_amortizing_loan,
           loan_annual_rate = excluded.loan_annual_rate,
           loan_monthly_payment = excluded.loan_monthly_payment,
           loan_billing_day = excluded.loan_billing_day,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
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
        String(p.createdAt || check.writeTs),
        check.writeTs,
        check.nextVersion
      )
      .run();
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
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (!existing) return;
      await db
        .prepare('UPDATE savings_adjustments SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND id = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateSavingsAdjustmentInput(
      {
        accountId: String(p.accountId || ''),
        date: String(p.date || ''),
        amount: Number(p.amount),
        currency: p.currency ? String(p.currency) : 'TWD',
        note: String(p.note || ''),
      },
      defaultFxRate
    );
    const twdAmount = p.twdAmount !== undefined ? Math.round(Number(p.twdAmount)) : v.twdAmount;

    await db
      .prepare(
        `INSERT INTO savings_adjustments
          (user_id, id, account_id, date, amount, twd_amount, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           account_id = excluded.account_id,
           date = excluded.date,
           amount = excluded.amount,
           twd_amount = excluded.twd_amount,
           note = excluded.note,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
      )
      .bind(
        uid,
        mutation.recordId,
        v.accountId,
        v.date,
        v.amount,
        twdAmount,
        v.note,
        String(p.createdAt || check.writeTs),
        check.writeTs,
        check.nextVersion
      )
      .run();
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
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (!existing) return;
      await db
        .prepare('UPDATE stock_transactions SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND id = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateStockTransactionInput({
      assetId: String(p.assetId || ''),
      date: String(p.date || ''),
      txType: String(p.txType || ''),
      shares: p.shares !== undefined ? Number(p.shares) : 0,
      totalAmount: p.totalAmount !== undefined ? Number(p.totalAmount) : 0,
      fee: p.fee !== undefined ? Number(p.fee) : 0,
      linkedCashflowId: p.linkedCashflowId ? String(p.linkedCashflowId) : null,
      note: String(p.note || ''),
    });

    await db
      .prepare(
        `INSERT INTO stock_transactions
          (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           asset_id = excluded.asset_id,
           date = excluded.date,
           tx_type = excluded.tx_type,
           shares = excluded.shares,
           total_amount = excluded.total_amount,
           fee = excluded.fee,
           linked_cashflow_id = excluded.linked_cashflow_id,
           note = excluded.note,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
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
        check.nextVersion
      )
      .run();
    return;
  }

  if (mutation.entity === 'utility_rents') {
    const existing = await ensureRentUtilitySettings(db, uid);
    const existingRow = await db
      .prepare('SELECT * FROM rent_utility_settings WHERE user_id = ?')
      .bind(uid)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existingRow,
      existing as unknown as Record<string, unknown>,
      serverTime
    );
    if (!check.shouldApply) return;
    const v = validateUtilityRentsInput((mutation.payload || {}) as Partial<RentUtilityRents>);
    await db
      .prepare(
        `INSERT INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           rent_6f = excluded.rent_6f,
           rent_a = excluded.rent_a,
           rent_b = excluded.rent_b,
           rent_c = excluded.rent_c,
           updated_at = excluded.updated_at,
           version = excluded.version`
      )
      .bind(uid, v.rent6F, v.rentA, v.rentB, v.rentC, check.writeTs, check.nextVersion)
      .run();
    return;
  }

  if (mutation.entity === 'utility_record') {
    const existing = await db
      .prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND period = ?')
      .bind(uid, mutation.recordId)
      .first<Record<string, unknown>>();
    const check = checkVersionOrThrow(
      mutation,
      existing,
      existing ? (mapUtilityRecordRow(existing) as unknown as Record<string, unknown>) : null,
      serverTime
    );
    if (!check.shouldApply) return;

    if (mutation.op === 'delete') {
      if (existing && Number(existing.is_baseline) === 1) {
        throw new Error('不可刪除起始表底紀錄。');
      }
      if (!existing) return;
      await db
        .prepare('UPDATE rent_utility_records SET deleted_at = ?, updated_at = ?, version = ? WHERE user_id = ? AND period = ?')
        .bind(check.writeTs, check.writeTs, check.nextVersion, uid, mutation.recordId)
        .run();
      return;
    }

    const p = mutation.payload || {};
    const v = validateUtilityRecordInput({
      period: String(p.period || mutation.recordId),
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
    });

    await db
      .prepare(
        `INSERT INTO rent_utility_records
          (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, period) DO UPDATE SET
           is_baseline = excluded.is_baseline,
           cur_total = excluded.cur_total,
           cur_6f = excluded.cur_6f,
           total_elec = excluded.total_elec,
           total_water = excluded.total_water,
           f6_people = excluded.f6_people,
           f5_people = excluded.f5_people,
           cur_a = excluded.cur_a,
           cur_b = excluded.cur_b,
           cur_c = excluded.cur_c,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           version = excluded.version`
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
        check.nextVersion
      )
      .run();
  }
}

export async function querySyncDelta(
  db: D1Database,
  userId: string,
  since?: string | null
): Promise<SyncDelta> {
  const uid = assertUserId(userId);
  const [settings, utilityRents] = await Promise.all([
    ensureAppSettings(db, uid),
    ensureRentUtilitySettings(db, uid),
  ]);

  if (since) {
    const [logs, rec, sink, assets, adjs, stockTxs, hist, utilRecs] = await Promise.all([
      db.prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND updated_at > ? ORDER BY date DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM recurring_items WHERE user_id = ? AND updated_at > ?').bind(uid, since).all(),
      db.prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND updated_at > ?').bind(uid, since).all(),
      db.prepare('SELECT * FROM asset_items WHERE user_id = ? AND updated_at > ?').bind(uid, since).all(),
      db.prepare('SELECT * FROM savings_adjustments WHERE user_id = ? AND updated_at > ? ORDER BY date DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM stock_transactions WHERE user_id = ? AND updated_at > ? ORDER BY date DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM networth_history WHERE user_id = ? AND updated_at > ? ORDER BY year_month DESC').bind(uid, since).all(),
      db.prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND updated_at > ?').bind(uid, since).all(),
    ]);

    return {
      settings: settings.updatedAt > since ? settings : null,
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

  const [logs, rec, sink, assets, adjs, stockTxs, hist, utilRecs] = await Promise.all([
    db.prepare('SELECT * FROM cashflow_logs WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT * FROM recurring_items WHERE user_id = ? AND deleted_at IS NULL').bind(uid).all(),
    db.prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND deleted_at IS NULL').bind(uid).all(),
    db.prepare('SELECT * FROM asset_items WHERE user_id = ? AND deleted_at IS NULL').bind(uid).all(),
    db.prepare('SELECT * FROM savings_adjustments WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT * FROM stock_transactions WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT * FROM networth_history WHERE user_id = ? ORDER BY year_month DESC').bind(uid).all(),
    db.prepare('SELECT * FROM rent_utility_records WHERE user_id = ? AND deleted_at IS NULL').bind(uid).all(),
  ]);

  return {
    settings,
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
  const settings = await ensureAppSettings(db, uid);
  const mutations = Array.isArray(req.mutations) ? req.mutations : [];
  const ackedMutationIds: string[] = [];
  const rejected: Array<{ mutationId: string; reason: string }> = [];
  const conflicts: SyncConflict[] = [];

  for (const mut of mutations) {
    if (!mut || !mut.mutationId || !mut.entity || !mut.recordId) {
      rejected.push({ mutationId: mut?.mutationId || 'unknown', reason: 'Invalid mutation format' });
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
      await db
        .prepare('INSERT INTO sync_idempotency (user_id, mutation_id, applied_at) VALUES (?, ?, ?)')
        .bind(uid, mut.mutationId, serverTime)
        .run();
      ackedMutationIds.push(mut.mutationId);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        conflicts.push(err.conflict);
      } else {
        rejected.push({
          mutationId: mut.mutationId,
          reason: err instanceof Error ? err.message : 'Failed to apply mutation',
        });
      }
    }
  }

  const delta = await querySyncDelta(db, uid, req.since);
  return {
    ok: true,
    serverTime,
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

  if (mode === 'replace') {
    await db.prepare('DELETE FROM cashflow_logs WHERE user_id = ?').bind(uid).run();
    await db.prepare('DELETE FROM recurring_items WHERE user_id = ?').bind(uid).run();
    await db.prepare('DELETE FROM sinking_fund_items WHERE user_id = ?').bind(uid).run();
    await db.prepare('DELETE FROM asset_items WHERE user_id = ?').bind(uid).run();
    await db.prepare('DELETE FROM savings_adjustments WHERE user_id = ?').bind(uid).run();
    await db.prepare('DELETE FROM stock_transactions WHERE user_id = ?').bind(uid).run();
    await db.prepare('DELETE FROM networth_history WHERE user_id = ?').bind(uid).run();
    if (Array.isArray(data.rentUtilityRecords) && data.rentUtilityRecords.length > 0) {
      await db.prepare('DELETE FROM rent_utility_records WHERE user_id = ?').bind(uid).run();
    }
  }

  const currentSettings = await ensureAppSettings(db, uid);
  if (data.settings) {
    await db
      .prepare(
        `UPDATE app_settings
         SET monthly_daily_budget = ?, emergency_target_months = ?, usd_twd_rate = ?, updated_at = ?, version = 1
         WHERE user_id = ?`
      )
      .bind(
        Math.max(0, Math.round(toSafeNumber(data.settings.monthlyDailyBudget, currentSettings.monthlyDailyBudget))),
        Math.min(60, Math.max(1, Math.round(toSafeNumber(data.settings.emergencyTargetMonths, currentSettings.emergencyTargetMonths)))),
        toSafeNumber(data.settings.usdTwdRate, currentSettings.usdTwdRate),
        nowIso,
        uid
      )
      .run();
  }

  let importedLogs = 0;
  for (const log of data.cashflowLogs || []) {
    const v = validateCashFlowInput(log, currentSettings.usdTwdRate);
    await db
      .prepare(
        `INSERT OR REPLACE INTO cashflow_logs
          (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, linked_account_id, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        log.id || crypto.randomUUID(),
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
        log.createdAt || nowIso,
        nowIso
      )
      .run();
    importedLogs++;
  }

  let importedRecurring = 0;
  for (const r of data.recurringItems || []) {
    const v = validateRecurringInput(r);
    await db
      .prepare(
        `INSERT OR REPLACE INTO recurring_items
          (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        r.id || crypto.randomUUID(),
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
        r.createdAt || nowIso,
        nowIso
      )
      .run();
    importedRecurring++;
  }

  let importedSinking = 0;
  for (const s of data.sinkingItems || []) {
    const v = validateSinkingInput(s);
    await db
      .prepare(
        `INSERT OR REPLACE INTO sinking_fund_items
          (user_id, id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        s.id || crypto.randomUUID(),
        v.itemName,
        v.category,
        v.totalAmount,
        v.months,
        v.dueNote,
        v.status,
        v.note,
        s.createdAt || nowIso,
        nowIso
      )
      .run();
    importedSinking++;
  }

  let importedAssets = 0;
  for (const a of data.assetItems || []) {
    const v = validateAssetInput(a);
    await db
      .prepare(
        `INSERT OR REPLACE INTO asset_items
          (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, cost_basis, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        a.id || crypto.randomUUID(),
        v.updateMode,
        v.majorType,
        v.subCategory,
        v.liquidity,
        v.itemName,
        v.ticker,
        v.quantityOrAmount,
        v.currency,
        v.unitPrice,
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
        a.createdAt || nowIso,
        nowIso
      )
      .run();
    importedAssets++;
  }

  for (const adj of data.savingsAdjustments || []) {
    const v = validateSavingsAdjustmentInput(adj, currentSettings.usdTwdRate);
    await db
      .prepare(
        `INSERT OR REPLACE INTO savings_adjustments
          (user_id, id, account_id, date, amount, twd_amount, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        adj.id || crypto.randomUUID(),
        v.accountId,
        v.date,
        v.amount,
        adj.twdAmount !== undefined ? Math.round(adj.twdAmount) : v.twdAmount,
        v.note,
        adj.createdAt || nowIso,
        nowIso
      )
      .run();
  }

  for (const tx of data.stockTransactions || []) {
    const v = validateStockTransactionInput(tx);
    await db
      .prepare(
        `INSERT OR REPLACE INTO stock_transactions
          (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        tx.id || crypto.randomUUID(),
        v.assetId,
        v.date,
        v.txType,
        v.shares,
        v.totalAmount,
        v.fee,
        v.linkedCashflowId,
        v.note,
        tx.createdAt || nowIso,
        nowIso
      )
      .run();
  }

  for (const h of data.netWorthHistory || []) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO networth_history
          (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        nowIso
      )
      .run();
  }

  if (data.rentUtilityRents) {
    const v = validateUtilityRentsInput(data.rentUtilityRents);
    await db
      .prepare(
        `INSERT OR REPLACE INTO rent_utility_settings (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(uid, v.rent6F, v.rentA, v.rentB, v.rentC, nowIso)
      .run();
  }

  for (const u of data.rentUtilityRecords || []) {
    const v = validateUtilityRecordInput(u);
    await db
      .prepare(
        `INSERT OR REPLACE INTO rent_utility_records
          (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
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
        u.createdAt || nowIso,
        nowIso
      )
      .run();
  }

  return { importedLogs, importedRecurring, importedSinking, importedAssets };
}
