/**
 * 手機端快速記帳 Web App 後端 API (webapp.ts)
 * 透過 doGet + HtmlService 提供 Mobile-First 記帳介面，並以 LockService 保護併發寫入。
 */

interface RecentEntryDto {
  date: string;
  type: string;
  category: string;
  itemName: string;
  amount: number;
  currency: string;
  twdAmount: number;
  source: string;
  note: string;
}

interface MonthlyBudgetSummaryDto {
  yearMonth: string;
  monthlyDailySpent: number;
  monthlyDailyBudget: number;
  remainingBudget: number;
  budgetUsagePct: number;
  monthlyIncome: number;
  monthlyInvestment: number;
}

interface WebAppInitDataDto {
  todayYmd: string;
  currentYearMonth: string;
  usdTwdRate: number;
  categories: Record<string, string[]>;
  summary: MonthlyBudgetSummaryDto;
  recentEntries: RecentEntryDto[];
}

interface SubmitExpenseResultDto {
  ok: boolean;
  message: string;
  savedEntry: RecentEntryDto;
  summary: MonthlyBudgetSummaryDto;
  recentEntries: RecentEntryDto[];
}

/**
 * Web App HTTP GET 入口
 */
function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('快速記帳 | 個人現金流')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 取得 Web App 初始資料（匯率、當月預算進度、預設分類、最近 5 筆紀錄）
 */
function getWebAppInitData(): WebAppInitDataDto {
  const ss = getActiveSpreadsheetOrThrow();
  const now = new Date();
  const currentYearMonth = formatYearMonth(now);
  const usdTwdRate = getLiveUsdTwdRate(ss);

  return {
    todayYmd: formatDateYmd(now),
    currentYearMonth,
    usdTwdRate,
    categories: WEBAPP_CATEGORY_MAP,
    summary: computeCurrentMonthSummary(ss, currentYearMonth, usdTwdRate),
    recentEntries: fetchRecentCashFlowEntries(ss, 5, usdTwdRate),
  };
}

/**
 * 接收手機表單送出並寫入 CashFlow_Log
 */
function submitExpense(payload: WebAppExpensePayload): SubmitExpenseResultDto {
  if (!payload || typeof payload !== 'object') {
    throw new Error('請求格式無效，請重新整理頁面後再試。');
  }

  const parsedDate = parseLocalDate(String(payload.date || ''));
  const type = String(payload.type || '').trim();
  const category = String(payload.category || '').trim() || '其他';
  const itemName = String(payload.itemName || '').trim() || category;
  const amount = Number(payload.amount);
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const note = String(payload.note || '').trim().slice(0, 200);

  if (ALL_CASHFLOW_TYPES.indexOf(type) === -1) {
    throw new Error(`不支援的收支類型：${type}`);
  }
  if (isNaN(amount) || !isFinite(amount) || amount <= 0) {
    throw new Error('請輸入大於 0 的有效金額。');
  }
  if (CURRENCIES.indexOf(currency) === -1) {
    throw new Error(`不支援的幣別：${currency}`);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('系統忙碌中，請稍候 2 秒再試。');
  }

  try {
    const ss = getActiveSpreadsheetOrThrow();
    const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
    const usdTwdRate = getLiveUsdTwdRate(ss);
    const fxRate = currency === 'USD' ? usdTwdRate : 1;
    const twdAmount = Math.round(amount * fxRate);

    const cleanName = itemName.slice(0, 80);
    appendCashFlowRows(logSheet, [
      {
        date: parsedDate,
        type,
        category,
        itemName: cleanName,
        amount,
        currency,
        fxRate,
        source: '手機記帳',
        note,
      },
    ]);

    let addedRecurring = false;
    if (payload.makeRecurring && RECURRING_CASHFLOW_TYPES.indexOf(type) !== -1) {
      const configSheet = ss.getSheetByName(SHEET_NAMES.RECURRING_CONFIG);
      if (configSheet) {
        const nextRow = findLastDataRowInColumn(configSheet, 1) + 1;
        configSheet
          .getRange(nextRow, 1, 1, 8)
          .setValues([[cleanName, category, type, amount, currency, '月繳', '', '啟用']]);
        configSheet
          .getRange(nextRow, 10)
          .setValue(note ? `[手機加入每月常態] ${note}` : '手機記帳加入每月常態');
        addedRecurring = true;
      }
    }

    SpreadsheetApp.flush();

    const currentYearMonth = formatYearMonth(new Date());
    const savedEntry: RecentEntryDto = {
      date: formatDateYmd(parsedDate),
      type,
      category,
      itemName: cleanName,
      amount,
      currency,
      twdAmount,
      source: '手機記帳',
      note,
    };

    const recurringHint = addedRecurring ? '（已同步加入每月固定入帳）' : '';
    return {
      ok: true,
      message: `已成功記帳：${savedEntry.itemName} (NT$ ${twdAmount.toLocaleString()})${recurringHint}`,
      savedEntry,
      summary: computeCurrentMonthSummary(ss, currentYearMonth, usdTwdRate),
      recentEntries: fetchRecentCashFlowEntries(ss, 5, usdTwdRate),
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 計算當月日常消費預算進度與收支快覽
 */
function computeCurrentMonthSummary(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  targetYearMonth: string,
  usdTwdRate: number
): MonthlyBudgetSummaryDto {
  const dashboard = ss.getSheetByName(SHEET_NAMES.DASHBOARD);
  const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);

  const monthlyDailyBudget = dashboard
    ? toSafeNumber(dashboard.getRange('B3').getValue(), DEFAULT_MONTHLY_DAILY_BUDGET)
    : DEFAULT_MONTHLY_DAILY_BUDGET;

  let monthlyDailySpent = 0;
  let monthlyIncome = 0;
  let monthlyInvestment = 0;

  const lastRow = findLastDataRowInColumn(logSheet, 1);
  if (lastRow >= 2) {
    const rows = logSheet.getRange(2, 1, lastRow - 1, 9).getValues();
    for (const row of rows) {
      const rowDate = row[0];
      const ym = rowDate instanceof Date ? formatYearMonth(rowDate) : String(row[1] || '').trim();
      if (ym !== targetYearMonth) continue;

      const type = String(row[2] || '').trim();
      const rawAmt = toSafeNumber(row[5], 0);
      const curr = String(row[6] || 'TWD').trim().toUpperCase();
      const lockedRate = toSafeNumber(row[8], curr === 'USD' ? usdTwdRate : 1);
      const twdFromFormula = toSafeNumber(row[7], NaN);
      const twdAmt = !isNaN(twdFromFormula)
        ? twdFromFormula
        : Math.round(rawAmt * (curr === 'USD' ? lockedRate : 1));

      if (type === CASHFLOW_TYPES.DAILY_EXPENSE) {
        monthlyDailySpent += twdAmt;
      } else if (type === CASHFLOW_TYPES.FIXED_INCOME || type === CASHFLOW_TYPES.OTHER_INCOME) {
        monthlyIncome += twdAmt;
      } else if (type === CASHFLOW_TYPES.INVESTMENT) {
        monthlyInvestment += twdAmt;
      }
    }
  }

  const remainingBudget = Math.round(monthlyDailyBudget - monthlyDailySpent);
  const budgetUsagePct =
    monthlyDailyBudget > 0 ? Math.round((monthlyDailySpent / monthlyDailyBudget) * 1000) / 10 : 0;

  return {
    yearMonth: targetYearMonth,
    monthlyDailySpent: Math.round(monthlyDailySpent),
    monthlyDailyBudget: Math.round(monthlyDailyBudget),
    remainingBudget,
    budgetUsagePct,
    monthlyIncome: Math.round(monthlyIncome),
    monthlyInvestment: Math.round(monthlyInvestment),
  };
}

/**
 * 讀取最近 N 筆 CashFlow_Log 紀錄（由新到舊）
 */
function fetchRecentCashFlowEntries(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  limit: number,
  usdTwdRate: number
): RecentEntryDto[] {
  const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
  const lastRow = findLastDataRowInColumn(logSheet, 1);
  if (lastRow < 2) {
    return [];
  }

  const count = Math.min(limit, lastRow - 1);
  const startRow = lastRow - count + 1;
  const rows = logSheet.getRange(startRow, 1, count, 11).getValues();

  const entries: RecentEntryDto[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const d = row[0] instanceof Date ? formatDateYmd(row[0]) : String(row[0] || '');
    const amount = toSafeNumber(row[5], 0);
    const currency = String(row[6] || 'TWD').trim().toUpperCase();
    const rate = toSafeNumber(row[8], currency === 'USD' ? usdTwdRate : 1);
    const twdFormula = toSafeNumber(row[7], NaN);
    const twdAmount = !isNaN(twdFormula) ? Math.round(twdFormula) : Math.round(amount * rate);

    entries.push({
      date: d,
      type: String(row[2] || ''),
      category: String(row[3] || ''),
      itemName: String(row[4] || ''),
      amount,
      currency,
      twdAmount,
      source: String(row[9] || ''),
      note: String(row[10] || ''),
    });
  }
  return entries;
}
