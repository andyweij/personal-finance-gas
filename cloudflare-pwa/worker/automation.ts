import { CASHFLOW_TYPES } from '../shared/constants';
import {
  computeAssetEffectiveTwdValue,
  computeSinkingMonthlyReserve,
  getEffectiveLedgerId,
  isAssetIncludedInNetWorth,
  isLedgerIncludedInNetWorth,
} from '../shared/calculations';
import { buildMonthlyDedupKey, buildRecurringItemMonthKey, shouldPostRecurringItem } from '../shared/recurring';
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

/**
 * M14 (v1.8.12): validates an explicitly requested posting period. Both values must be given together, as
 * integers, with month 1–12 and a plausible year; omitting both means "the current Taipei month".
 */
export function validateRecurringPeriod(
  year: unknown,
  month: unknown
): { ok: true; year?: number; month?: number } | { ok: false; error: string } {
  const hasYear = year !== undefined && year !== null;
  const hasMonth = month !== undefined && month !== null;
  if (!hasYear && !hasMonth) return { ok: true };
  if (!hasYear || !hasMonth) return { ok: false, error: '請同時指定入帳的年份與月份。' };
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, error: '入帳年份需為 2000～2100 之間的整數。' };
  }
  if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: '入帳月份需為 1～12 之間的整數。' };
  }
  return { ok: true, year, month };
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
  const period = validateRecurringPeriod(targetYear, targetMonth);
  if (!period.ok) throw new Error(period.error);
  const settings = await ensureAppSettings(db, uid);
  const nowParts = getTaiwanDateParts(new Date());
  const year = targetYear || nowParts.year;
  const month = targetMonth || nowParts.month;
  const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
  const entryDate = `${yearMonth}-01`;
  const usdRate = settings.usdTwdRate;
  const nowIso = new Date().toISOString();

  // R-5: Capture the data epoch together with the reads below. Every insert is guarded by it, so a replace
  // import landing mid-run can never receive entries generated from the pre-restore recurring items.
  await db
    .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
    .bind(uid, nowIso)
    .run();
  const epochRow = await db
    .prepare('SELECT data_epoch FROM user_sync_state WHERE user_id = ?')
    .bind(uid)
    .first<{ data_epoch: number }>();
  const expectedEpoch = Number(epochRow?.data_epoch ?? 1);
  const epochGuard = '(SELECT data_epoch FROM user_sync_state WHERE user_id = ?) = ?';
  const epochChanged = async (): Promise<boolean> => {
    const row = await db
      .prepare('SELECT data_epoch FROM user_sync_state WHERE user_id = ?')
      .bind(uid)
      .first<{ data_epoch: number }>();
    return Number(row?.data_epoch ?? 1) !== expectedEpoch;
  };

  const existingRows = await db
    .prepare(
      `SELECT type, item_name, amount, currency, recurring_dedup_key, ledger_id
       FROM cashflow_logs
       WHERE user_id = ? AND year_month = ? AND source = '自動入帳' AND deleted_at IS NULL`
    )
    .bind(uid, yearMonth)
    .all<{
      type: string;
      item_name: string;
      amount: number;
      currency: string;
      recurring_dedup_key: string | null;
      ledger_id?: string | null;
    }>();

  // M5: new rows are keyed by recurring item id + month. Rows posted before v1.8.12 (or restored from a backup
  // without a key) carry the legacy name-based key: each such row counts as "already posted" for exactly one
  // matching item, preferring an item with the same amount and currency.
  const existingKeys = new Set<string>();
  const legacyRows: Array<{ key: string; amount: number; currency: string; consumed: boolean }> = [];
  for (const r of existingRows.results) {
    const key = r.recurring_dedup_key || '';
    if (key.startsWith('rec:')) {
      existingKeys.add(key);
    } else {
      legacyRows.push({
        key: key || buildMonthlyDedupKey(yearMonth, r.type, r.item_name, r.ledger_id || 'default'),
        amount: Number(r.amount),
        currency: String(r.currency || 'TWD'),
        consumed: false,
      });
    }
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

  const dueItems = recurringRows.results.filter(
    (item) =>
      item.item_name &&
      item.type &&
      item.amount > 0 &&
      shouldPostRecurringItem(item.cycle, item.billing_spec, year, month)
  );
  const legacyCovered = new Set<string>();
  const legacyKeyOf = (item: (typeof dueItems)[number]) =>
    buildMonthlyDedupKey(yearMonth, item.type, item.item_name, String(item.ledger_id || 'default').trim() || 'default');
  // Pass 1: exact matches (same amount & currency) consume legacy rows first; pass 2: any remaining same-key item
  for (const exact of [true, false]) {
    for (const item of dueItems) {
      if (legacyCovered.has(item.id) || existingKeys.has(buildRecurringItemMonthKey(item.id, yearMonth))) continue;
      const lk = legacyKeyOf(item);
      const row = legacyRows.find(
        (r) =>
          !r.consumed &&
          r.key === lk &&
          (!exact || (r.amount === Number(item.amount) && r.currency === String(item.currency || 'TWD')))
      );
      if (row) {
        row.consumed = true;
        legacyCovered.add(item.id);
      }
    }
  }

  for (const item of dueItems) {
    const ledgerId = String(item.ledger_id || 'default').trim() || 'default';
    const dedupKey = buildRecurringItemMonthKey(item.id, yearMonth);
    if (existingKeys.has(dedupKey) || legacyCovered.has(item.id)) {
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

    const ensureSyncStmt = db
      .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
      .bind(uid, nowIso);
    const bumpSyncStmt = db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ?')
      .bind(nowIso, uid);

    const insertStmt = db
      .prepare(
        `INSERT INTO cashflow_logs
          (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, linked_account_id, ledger_id, created_at, updated_at, deleted_at, version, change_seq)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '自動入帳', ?, ?, ?, ?, ?, ?, NULL, 1, COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0)
         WHERE ${epochGuard}
         ON CONFLICT DO NOTHING`
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
        nowIso,
        uid,
        uid,
        expectedEpoch
      );

    if (item.cycle === '一次性') {
      const suffix = `[已一次性入帳 ${yearMonth}]`;
      const updatedNote = item.note ? `${item.note} ${suffix}` : suffix;
      const deactivateStmt = db
        .prepare(
          `UPDATE recurring_items SET status = '停用', note = ?, updated_at = ?, version = version + 1,
              change_seq = COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0)
           WHERE user_id = ? AND id = ? AND ${epochGuard} AND changes() > 0`
        )
        .bind(updatedNote, nowIso, uid, uid, item.id, uid, expectedEpoch);
      const results = await db.batch([ensureSyncStmt, bumpSyncStmt, insertStmt, deactivateStmt]);
      if (Number(results[2]?.meta?.changes ?? 0) === 0) {
        if (await epochChanged()) break; // R-5: epoch changed — stop this run
        skippedCount++; // M5: a concurrent run posted it first (ON CONFLICT DO NOTHING)
        existingKeys.add(dedupKey);
        continue;
      }
      deactivatedOneTimeCount++;
    } else {
      const results = await db.batch([ensureSyncStmt, bumpSyncStmt, insertStmt]);
      if (Number(results[2]?.meta?.changes ?? 0) === 0) {
        if (await epochChanged()) break; // R-5: epoch changed — stop this run
        skippedCount++; // M5: a concurrent run posted it first (ON CONFLICT DO NOTHING)
        existingKeys.add(dedupKey);
        continue;
      }
    }

    existingKeys.add(dedupKey);
    insertedCount++;
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

  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
      .bind(uid, nowIso),
    db
      .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ?')
      .bind(nowIso, uid),
    db
      .prepare(
        `INSERT OR REPLACE INTO networth_history
          (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0))`
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
        nowIso,
        uid
      ),
  ]);

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
