import { CASHFLOW_TYPES } from '../shared/constants';
import { computeAssetTwdValue, computeSinkingMonthlyReserve } from '../shared/calculations';
import { buildMonthlyDedupKey, shouldPostRecurringItem } from '../shared/recurring';
import { ensureAppSettings } from './sync';

export function getTaiwanDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  ymd: string;
  yearMonth: string;
} {
  // Asia/Taipei is fixed UTC+8 (no DST)
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
  targetYear?: number,
  targetMonth?: number
): Promise<{
  yearMonth: string;
  insertedCount: number;
  skippedCount: number;
  deactivatedOneTimeCount: number;
  fxRate: number;
}> {
  const settings = await ensureAppSettings(db);
  const nowParts = getTaiwanDateParts(new Date());
  const year = targetYear || nowParts.year;
  const month = targetMonth || nowParts.month;
  const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
  const entryDate = `${yearMonth}-01`;
  const usdRate = settings.usdTwdRate;
  const nowIso = new Date().toISOString();

  // Existing auto-posted keys for this yearMonth
  const existingRows = await db
    .prepare(
      `SELECT type, item_name, recurring_dedup_key
       FROM cashflow_logs
       WHERE year_month = ? AND source = '自動入帳' AND deleted_at IS NULL`
    )
    .bind(yearMonth)
    .all<{ type: string; item_name: string; recurring_dedup_key: string | null }>();

  const existingKeys = new Set<string>();
  for (const r of existingRows.results) {
    existingKeys.add(r.recurring_dedup_key || buildMonthlyDedupKey(yearMonth, r.type, r.item_name));
  }

  const recurringRows = await db
    .prepare(`SELECT * FROM recurring_items WHERE status = '啟用' AND deleted_at IS NULL`)
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
    }>();

  let insertedCount = 0;
  let skippedCount = 0;
  let deactivatedOneTimeCount = 0;

  for (const item of recurringRows.results) {
    if (!item.item_name || !item.type || item.amount <= 0) continue;
    if (!shouldPostRecurringItem(item.cycle, item.billing_spec, year, month)) continue;

    const dedupKey = buildMonthlyDedupKey(yearMonth, item.type, item.item_name);
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
          (id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '自動入帳', ?, ?, ?, ?, NULL)`
      )
      .bind(
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
        .prepare(`UPDATE recurring_items SET status = '停用', note = ?, updated_at = ? WHERE id = ?`)
        .bind(updatedNote, nowIso, item.id)
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
  targetDate = new Date()
): Promise<{
  yearMonth: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  updated: boolean;
}> {
  const settings = await ensureAppSettings(db);
  const parts = getTaiwanDateParts(targetDate);
  const yearMonth = parts.yearMonth;
  const nowIso = new Date().toISOString();

  const assetsRows = await db
    .prepare('SELECT * FROM asset_items WHERE deleted_at IS NULL')
    .all<{
      id: string;
      update_mode: string;
      major_type: string;
      sub_category: string;
      liquidity: string;
      item_name: string;
      ticker: string;
      quantity_or_amount: number;
      currency: string;
      unit_price: number;
      note: string;
      created_at: string;
      updated_at: string;
    }>();

  let totalAssets = 0;
  let totalLiabilities = 0;
  let highLiquidityAssets = 0;
  let investmentAssets = 0;
  let insuranceAssets = 0;

  for (const r of assetsRows.results) {
    const twdValue = computeAssetTwdValue(
      {
        id: r.id,
        updateMode: r.update_mode,
        majorType: r.major_type,
        subCategory: r.sub_category,
        liquidity: r.liquidity,
        itemName: r.item_name,
        ticker: r.ticker,
        quantityOrAmount: r.quantity_or_amount,
        currency: r.currency,
        unitPrice: r.unit_price,
        note: r.note,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
      settings.usdTwdRate
    );
    if (twdValue === 0) continue;
    if (r.major_type === '資產') {
      totalAssets += twdValue;
      if (r.liquidity === '高流動') highLiquidityAssets += twdValue;
      if (r.sub_category === '台股' || r.sub_category === '中信基金' || r.sub_category === '結構性商品') {
        investmentAssets += twdValue;
      }
      if (r.sub_category === '保單(保價金)') insuranceAssets += twdValue;
    } else if (r.major_type === '負債') {
      totalLiabilities += twdValue;
    }
  }

  const netWorth = Math.round(totalAssets - totalLiabilities);

  // Cash flow for snapshot month
  const logRows = await db
    .prepare('SELECT type, twd_amount FROM cashflow_logs WHERE year_month = ? AND deleted_at IS NULL')
    .bind(yearMonth)
    .all<{ type: string; twd_amount: number }>();

  let monthlyIncome = 0;
  let monthlyCoreExpense = 0;
  for (const l of logRows.results) {
    if (l.type === CASHFLOW_TYPES.FIXED_INCOME || l.type === CASHFLOW_TYPES.OTHER_INCOME) {
      monthlyIncome += l.twd_amount;
    } else if (
      l.type === CASHFLOW_TYPES.FIXED_EXPENSE ||
      l.type === CASHFLOW_TYPES.SUBSCRIPTION ||
      l.type === CASHFLOW_TYPES.DAILY_EXPENSE
    ) {
      monthlyCoreExpense += l.twd_amount;
    }
  }

  const sinkingRows = await db
    .prepare(`SELECT total_amount, months, status FROM sinking_fund_items WHERE status = '啟用' AND deleted_at IS NULL`)
    .all<{ total_amount: number; months: number; status: string }>();

  let monthlySinking = 0;
  for (const s of sinkingRows.results) {
    monthlySinking += computeSinkingMonthlyReserve({
      id: '',
      itemName: '',
      category: '',
      totalAmount: s.total_amount,
      months: s.months,
      dueNote: '',
      status: s.status,
      note: '',
      createdAt: '',
      updatedAt: '',
    });
  }

  const totalConsumption = Math.round(monthlyCoreExpense + monthlySinking);
  const savingsRate =
    monthlyIncome > 0 ? Math.round(((monthlyIncome - totalConsumption) / monthlyIncome) * 10000) / 10000 : 0;

  const existing = await db
    .prepare('SELECT year_month FROM networth_history WHERE year_month = ?')
    .bind(yearMonth)
    .first();
  const updated = Boolean(existing);

  await db
    .prepare(
      `INSERT OR REPLACE INTO networth_history
        (year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
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
