import { CASHFLOW_TYPES } from '../shared/constants';
import {
  computeAssetEffectiveTwdValue,
  computeSinkingMonthlyReserve,
  getEffectiveLedgerId,
  isAssetIncludedInNetWorth,
  isLedgerIncludedInNetWorth,
} from '../shared/calculations';
import { buildMonthlyDedupKey, shouldPostRecurringItem } from '../shared/recurring';
import { assertUserId, ensureAppSettings, exportFullSnapshot } from './sync';

export function getTaiwanDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  ymd: string;
  yearMonth: string;
} {
  const tw = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = tw.getUTCFullYear();
  const month = tw.getUTCMonth() + 1;
  const day = tw.getUTCDate();
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const ymd = `${ym}-${String(day).padStart(2, '0')}`;
  return { year, month, day, ymd, yearMonth: ym };
}

export function isTaiwanMonthEnd(date: Date): boolean {
  const tomorrowTw = getTaiwanDateParts(new Date(date.getTime() + 24 * 60 * 60 * 1000));
  return tomorrowTw.day === 1;
}

export async function runMonthlyRecurringD1(
  db: D1Database,
  userId: string,
  targetYear?: number,
  targetMonth?: number
): Promise<{
  yearMonth: string;
  insertedCount: number;
  skippedCount: number;
  deactivatedOneTimeCount: number;
  fxRate: number;
}> {
  const uid = assertUserId(userId);
  const settings = await ensureAppSettings(db, uid);
  const nowParts = getTaiwanDateParts(new Date());
  const year = targetYear || nowParts.year;
  const month = targetMonth || nowParts.month;
  const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
  const entryDate = `${yearMonth}-01`;
  const usdRate = settings.usdTwdRate;
  const nowIso = new Date().toISOString();

  const existingRows = await db
    .prepare(
      `SELECT type, item_name, recurring_dedup_key, ledger_id
       FROM cashflow_logs
       WHERE user_id = ? AND year_month = ? AND source = '自動入帳' AND deleted_at IS NULL`
    )
    .bind(uid, yearMonth)
    .all<{ type: string; item_name: string; recurring_dedup_key: string | null; ledger_id?: string | null }>();

  const existingKeys = new Set<string>();
  for (const r of existingRows.results) {
    existingKeys.add(
      r.recurring_dedup_key ||
        buildMonthlyDedupKey(yearMonth, r.type, r.item_name, r.ledger_id || 'default')
    );
  }

  const recurringRows = await db
    .prepare(`SELECT * FROM recurring_items WHERE user_id = ? AND status = '啟用' AND deleted_at IS NULL`)
    .bind(uid)
    .all<{
      id: string;
      item_name: string;
      category: string;
      type: string;
      amount: number;
      currency: string;
      cycle: string;
      billing_spec: string;
      note: string;
      linked_account_id: string | null;
      ledger_id?: string | null;
    }>();

  let insertedCount = 0;
  let skippedCount = 0;
  let deactivatedOneTimeCount = 0;

  for (const item of recurringRows.results) {
    if (!item.item_name || !item.type || item.amount <= 0) continue;
    if (!shouldPostRecurringItem(item.cycle, item.billing_spec, year, month)) continue;

    const ledgerId = String(item.ledger_id || 'default').trim() || 'default';
    const dedupKey = buildMonthlyDedupKey(yearMonth, item.type, item.item_name, ledgerId);
    if (existingKeys.has(dedupKey)) {
      skippedCount++;
      continue;
    }

    const fxRate = item.currency === 'USD' ? usdRate : 1;
    const twdAmount = Math.round(item.amount * fxRate);
    let cycleTag = '';
    if (item.cycle === '年繳') cycleTag = '[年繳到期] ';
    else if (item.cycle === '特定月份') cycleTag = '[特定月份] ';
    else if (item.cycle === '一次性') cycleTag = '[一次性排程] ';
    const finalNote = `${cycleTag}${item.note || ''}`.trim();

    await db
      .prepare(
        `INSERT INTO cashflow_logs
          (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, linked_account_id, ledger_id, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '自動入帳', ?, ?, ?, ?, ?, ?, NULL, 1)`
      )
      .bind(
        uid,
        crypto.randomUUID(),
        entryDate,
        yearMonth,
        item.type,
        item.category || '其他',
        item.item_name,
        item.amount,
        item.currency,
        fxRate,
        twdAmount,
        finalNote,
        dedupKey,
        item.linked_account_id || null,
        ledgerId,
        nowIso,
        nowIso
      )
      .run();

    existingKeys.add(dedupKey);
    insertedCount++;

    if (item.cycle === '一次性') {
      const suffix = `[已一次性入帳 ${yearMonth}]`;
      const updatedNote = item.note ? `${item.note} ${suffix}` : suffix;
      await db
        .prepare(
          `UPDATE recurring_items SET status = '停用', note = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND id = ?`
        )
        .bind(updatedNote, nowIso, uid, item.id)
        .run();
      deactivatedOneTimeCount++;
    }
  }

  return {
    yearMonth,
    insertedCount,
    skippedCount,
    deactivatedOneTimeCount,
    fxRate: usdRate,
  };
}

export async function runMonthEndSnapshotD1(
  db: D1Database,
  userId: string,
  targetDate = new Date()
): Promise<{
  yearMonth: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  updated: boolean;
}> {
  const uid = assertUserId(userId);
  const full = await exportFullSnapshot(db, uid);
  const parts = getTaiwanDateParts(targetDate);
  const yearMonth = parts.yearMonth;
  const nowIso = new Date().toISOString();

  let totalAssets = 0;
  let totalLiabilities = 0;
  let highLiquidityAssets = 0;
  let investmentAssets = 0;
  let insuranceAssets = 0;

  for (const item of full.assetItems) {
    if (!isAssetIncludedInNetWorth(item, full.ledgers)) continue;
    const twdValue = computeAssetEffectiveTwdValue(
      item,
      full.settings.usdTwdRate,
      full.cashflowLogs,
      full.savingsAdjustments,
      full.stockTransactions,
      parts.ymd
    );
    if (twdValue === 0) continue;
    if (item.majorType === '資產') {
      totalAssets += twdValue;
      if (item.liquidity === '高流動' || item.isLinkedSavings) highLiquidityAssets += twdValue;
      if (
        item.subCategory === '台股' ||
        item.subCategory === '美股/ETF' ||
        item.subCategory === '中信基金' ||
        item.subCategory === '結構性商品'
      ) {
        investmentAssets += twdValue;
      }
      if (item.subCategory === '保單(保價金)') insuranceAssets += twdValue;
    } else if (item.majorType === '負債') {
      totalLiabilities += twdValue;
    }
  }

  const netWorth = Math.round(totalAssets - totalLiabilities);

  let monthlyIncome = 0;
  let monthlyCoreExpense = 0;
  for (const l of full.cashflowLogs) {
    if (l.yearMonth !== yearMonth) continue;
    if (!isLedgerIncludedInNetWorth(getEffectiveLedgerId(l), full.ledgers)) continue;
    if (l.type === CASHFLOW_TYPES.FIXED_INCOME || l.type === CASHFLOW_TYPES.OTHER_INCOME) {
      monthlyIncome += l.twdAmount;
    } else if (
      l.type === CASHFLOW_TYPES.FIXED_EXPENSE ||
      l.type === CASHFLOW_TYPES.SUBSCRIPTION ||
      l.type === CASHFLOW_TYPES.DAILY_EXPENSE
    ) {
      monthlyCoreExpense += l.twdAmount;
    }
  }

  let monthlySinking = 0;
  for (const s of full.sinkingItems) {
    monthlySinking += computeSinkingMonthlyReserve(s);
  }

  const totalConsumption = Math.round(monthlyCoreExpense + monthlySinking);
  const savingsRate =
    monthlyIncome > 0 ? Math.round(((monthlyIncome - totalConsumption) / monthlyIncome) * 10000) / 10000 : 0;

  const existing = await db
    .prepare('SELECT year_month FROM networth_history WHERE user_id = ? AND year_month = ?')
    .bind(uid, yearMonth)
    .first();
  const updated = Boolean(existing);

  await db
    .prepare(
      `INSERT OR REPLACE INTO networth_history
        (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      uid,
      yearMonth,
      parts.ymd,
      Math.round(totalAssets),
      Math.round(totalLiabilities),
      netWorth,
      Math.round(highLiquidityAssets),
      Math.round(investmentAssets),
      Math.round(insuranceAssets),
      Math.round(monthlyIncome),
      totalConsumption,
      savingsRate,
      `自動快照 @ ${parts.ymd}`,
      nowIso
    )
    .run();

  return {
    yearMonth,
    totalAssets: Math.round(totalAssets),
    totalLiabilities: Math.round(totalLiabilities),
    netWorth,
    updated,
  };
}

export async function runMonthlyRecurringAllUsersD1(
  db: D1Database,
  targetYear?: number,
  targetMonth?: number
): Promise<{ userCount: number; totalInserted: number; totalSkipped: number }> {
  const users = await db.prepare('SELECT id FROM users WHERE is_active = 1').all<{ id: string }>();
  let totalInserted = 0;
  let totalSkipped = 0;
  for (const u of users.results) {
    try {
      const res = await runMonthlyRecurringD1(db, u.id, targetYear, targetMonth);
      totalInserted += res.insertedCount;
      totalSkipped += res.skippedCount;
    } catch {
      // Isolate per-user cron errors so other users still complete
    }
  }
  return { userCount: users.results.length, totalInserted, totalSkipped };
}

export async function runMonthEndSnapshotAllUsersD1(
  db: D1Database,
  targetDate = new Date()
): Promise<{ userCount: number }> {
  const users = await db.prepare('SELECT id FROM users WHERE is_active = 1').all<{ id: string }>();
  for (const u of users.results) {
    try {
      await runMonthEndSnapshotD1(db, u.id, targetDate);
    } catch {
      // Isolate per-user cron errors
    }
  }
  return { userCount: users.results.length };
}
