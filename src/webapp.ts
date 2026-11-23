/**
 * 全功能手機端個人財務 Web App 後端 API (webapp.ts)
 * 提供 4 大分頁完整讀寫能力：
 * 1. 快速記帳 + 流水帳查詢與刪除
 * 2. 月度 / 年度儀表板、大項分類（投資/存款/收支）統計、12 個月趨勢與預算設定
 * 3. 常態收支與訂閱（薪資/房貸/訂閱/其他收入 4 種週期）與不定期分攤月數直接管理
 * 4. 資產負債即時更新與一鍵月底淨資產快照
 * 所有 API 皆受 assertAuthorized(token) 與 LockService 保護。
 */

interface CashFlowLogDto {
  rowIndex: number;
  date: string;
  yearMonth: string;
  type: string;
  category: string;
  itemName: string;
  amount: number;
  currency: string;
  twdAmount: number;
  source: string;
  note: string;
}

interface RecurringItemDto {
  rowIndex: number;
  itemName: string;
  category: string;
  type: string;
  amount: number;
  currency: string;
  cycle: string;
  billingSpec: string;
  status: string;
  monthlyTwd: number;
  note: string;
}

interface SinkingFundItemDto {
  rowIndex: number;
  itemName: string;
  category: string;
  totalAmount: number;
  months: number;
  dueNote: string;
  monthlyReserve: number;
  status: string;
  ytdSpent: number;
  note: string;
}

interface AssetItemDto {
  rowIndex: number;
  updateMode: string;
  majorType: string;
  subCategory: string;
  liquidity: string;
  itemName: string;
  ticker: string;
  quantityOrAmount: number;
  currency: string;
  unitPrice: number;
  twdValue: number;
  note: string;
}

interface NetWorthHistoryDto {
  date: string;
  yearMonth: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  savingsRate: number;
}

interface MonthlyTrendPointDto {
  month: number;
  ym: string;
  income: number;
  fixedSub: number;
  daily: number;
  taxLarge: number;
  investment: number;
  netCashFlow: number;
  totalSavings: number;
}

interface PeriodMetricsDto {
  totalIncome: number;
  fixedExpense: number;
  subscription: number;
  dailyExpense: number;
  sinkingReserve: number;
  taxLargeActual: number;
  totalConsumption: number;
  investment: number;
  freeCashFlow: number;
  totalSavings: number;
  savingsRate: number;
  // 大項細分
  investmentStock: number;
  investmentFund: number;
  investmentOther: number;
  salary: number;
  rentIncome: number;
  otherIncome: number;
  mortgage: number;
  carLoan: number;
}

interface AppBundleDto {
  meta: {
    todayYmd: string;
    selectedYear: number;
    selectedMonth: number;
    selectedYearMonth: string;
    usdTwdRate: number;
    monthlyDailyBudget: number;
    emergencyTargetMonths: number;
    pinEnabled: boolean;
    categories: Record<string, string[]>;
    assetSubCategories: string[];
    sinkingCategories: string[];
    availableYears: number[];
  };
  dashboard: {
    monthly: PeriodMetricsDto;
    yearly: PeriodMetricsDto;
    budgetUsagePct: number;
    remainingBudget: number;
    emergencyMonths: number;
    highLiquidityAssets: number;
    netWorth: {
      totalAssets: number;
      totalLiabilities: number;
      netWorth: number;
      debtRatio: number;
      stockValue: number;
      cashUsdValue: number;
      fundStructuredValue: number;
      insuranceValue: number;
      otherAssetsValue: number;
    };
    monthlyTrend: MonthlyTrendPointDto[];
  };
  monthlyLogs: CashFlowLogDto[];
  recentLogs: CashFlowLogDto[];
  recurringItems: RecurringItemDto[];
  sinkingItems: SinkingFundItemDto[];
  assetItems: AssetItemDto[];
  netWorthHistory: NetWorthHistoryDto[];
}

/**
 * Web App HTTP GET 入口
 */
function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('財務管家')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 一次性讀取 4 大分頁完整資料（支援切換查詢年份/月份）
 */
function getAppBundle(
  token?: string,
  targetYear?: number,
  targetMonth?: number
): AppBundleDto {
  assertAuthorized(token);
  const ss = getActiveSpreadsheetOrThrow();
  return buildAppBundleInternal(ss, targetYear, targetMonth);
}

/**
 * 內部建置完整 AppBundle（供查詢與寫入後即時回傳使用）
 */
function buildAppBundleInternal(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  targetYear?: number,
  targetMonth?: number
): AppBundleDto {
  const now = new Date();
  const selectedYear = targetYear && targetYear >= 2000 && targetYear <= 2100 ? Math.floor(targetYear) : now.getFullYear();
  const selectedMonth = targetMonth && targetMonth >= 1 && targetMonth <= 12 ? Math.floor(targetMonth) : now.getMonth() + 1;
  const selectedYearMonth = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;

  const usdTwdRate = getLiveUsdTwdRate(ss);
  const dashboardSheet = ss.getSheetByName(SHEET_NAMES.DASHBOARD);
  const monthlyDailyBudget = dashboardSheet
    ? toSafeNumber(dashboardSheet.getRange('B3').getValue(), DEFAULT_MONTHLY_DAILY_BUDGET)
    : DEFAULT_MONTHLY_DAILY_BUDGET;
  const emergencyTargetMonths = dashboardSheet
    ? toSafeNumber(dashboardSheet.getRange('F3').getValue(), DEFAULT_EMERGENCY_MONTHS)
    : DEFAULT_EMERGENCY_MONTHS;

  const sinkingItems = readSinkingFundItems(ss);
  const monthlySinkingTotal = sinkingItems.reduce((sum, item) => sum + item.monthlyReserve, 0);

  const recurringItems = readRecurringItems(ss, usdTwdRate);
  const assetItems = readAssetItems(ss, usdTwdRate);
  const netWorthHistory = readNetWorthHistory(ss, 12);

  // 讀取全部 CashFlow_Log 計算當月、年度、12 個月趨勢與最近 15 筆紀錄
  const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
  const lastLogRow = findLastDataRowInColumn(logSheet, 1);
  const allLogs: CashFlowLogDto[] = [];
  const yearSet = new Set<number>([now.getFullYear(), selectedYear]);

  if (lastLogRow >= 2) {
    const rawLogs = logSheet.getRange(2, 1, lastLogRow - 1, 11).getValues();
    for (let i = 0; i < rawLogs.length; i++) {
      const row = rawLogs[i];
      const dateVal = row[0];
      if (!dateVal) continue;
      const dateStr = dateVal instanceof Date ? formatDateYmd(dateVal) : String(dateVal).trim();
      const ym = dateVal instanceof Date ? formatYearMonth(dateVal) : String(row[1] || dateStr.slice(0, 7)).trim();
      const yr = Number(ym.slice(0, 4));
      if (!isNaN(yr) && yr >= 2000 && yr <= 2100) yearSet.add(yr);

      const amount = toSafeNumber(row[5], 0);
      const currency = String(row[6] || 'TWD').trim().toUpperCase();
      const fxRate = toSafeNumber(row[8], currency === 'USD' ? usdTwdRate : 1);
      const twdFromCol = toSafeNumber(row[7], NaN);
      const twdAmount = !isNaN(twdFromCol) ? Math.round(twdFromCol) : Math.round(amount * (currency === 'USD' ? fxRate : 1));

      allLogs.push({
        rowIndex: i + 2,
        date: dateStr,
        yearMonth: ym,
        type: String(row[2] || '').trim(),
        category: String(row[3] || '').trim(),
        itemName: String(row[4] || '').trim(),
        amount,
        currency,
        twdAmount,
        source: String(row[9] || '').trim(),
        note: String(row[10] || '').trim(),
      });
    }
  }

  const monthlyLogs = allLogs.filter((l) => l.yearMonth === selectedYearMonth);
  const yearlyLogs = allLogs.filter((l) => l.yearMonth.startsWith(`${selectedYear}-`));

  const monthly = aggregatePeriodMetrics(monthlyLogs, monthlySinkingTotal, true);
  const yearly = aggregatePeriodMetrics(yearlyLogs, monthlySinkingTotal * 12, false);

  // 12 個月趨勢陣列
  const monthlyTrend: MonthlyTrendPointDto[] = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${selectedYear}-${String(m).padStart(2, '0')}`;
    const mLogs = yearlyLogs.filter((l) => l.yearMonth === ym);
    let income = 0;
    let fixedSub = 0;
    let daily = 0;
    let taxLarge = 0;
    let investment = 0;
    for (const l of mLogs) {
      if (l.type === CASHFLOW_TYPES.FIXED_INCOME || l.type === CASHFLOW_TYPES.OTHER_INCOME) income += l.twdAmount;
      else if (l.type === CASHFLOW_TYPES.FIXED_EXPENSE || l.type === CASHFLOW_TYPES.SUBSCRIPTION) fixedSub += l.twdAmount;
      else if (l.type === CASHFLOW_TYPES.DAILY_EXPENSE) daily += l.twdAmount;
      else if (l.type === CASHFLOW_TYPES.TAX_LARGE) taxLarge += l.twdAmount;
      else if (l.type === CASHFLOW_TYPES.INVESTMENT) investment += l.twdAmount;
    }
    const netCashFlow = Math.round(income - fixedSub - daily - taxLarge - investment);
    monthlyTrend.push({
      month: m,
      ym,
      income: Math.round(income),
      fixedSub: Math.round(fixedSub),
      daily: Math.round(daily),
      taxLarge: Math.round(taxLarge),
      investment: Math.round(investment),
      netCashFlow,
      totalSavings: Math.round(investment + netCashFlow),
    });
  }

  // 資產負債彙總
  let totalAssets = 0;
  let totalLiabilities = 0;
  let highLiquidityAssets = 0;
  let stockValue = 0;
  let cashUsdValue = 0;
  let fundStructuredValue = 0;
  let insuranceValue = 0;

  for (const a of assetItems) {
    if (a.majorType === '資產') {
      totalAssets += a.twdValue;
      if (a.liquidity === '高流動') highLiquidityAssets += a.twdValue;
      if (a.subCategory === '台股') stockValue += a.twdValue;
      else if (a.subCategory === '美金' || a.subCategory === '定存/現金') cashUsdValue += a.twdValue;
      else if (a.subCategory === '中信基金' || a.subCategory === '結構性商品') fundStructuredValue += a.twdValue;
      else if (a.subCategory === '保單(保價金)') insuranceValue += a.twdValue;
    } else if (a.majorType === '負債') {
      totalLiabilities += a.twdValue;
    }
  }

  const otherAssetsValue = Math.max(
    0,
    Math.round(totalAssets - stockValue - cashUsdValue - fundStructuredValue - insuranceValue)
  );
  const netWorth = Math.round(totalAssets - totalLiabilities);
  const debtRatio = totalAssets > 0 ? Math.round((totalLiabilities / totalAssets) * 1000) / 10 : 0;
  const remainingBudget = Math.round(monthlyDailyBudget - monthly.dailyExpense);
  const budgetUsagePct = monthlyDailyBudget > 0 ? Math.round((monthly.dailyExpense / monthlyDailyBudget) * 1000) / 10 : 0;
  const emergencyMonths =
    monthly.totalConsumption > 0 ? Math.round((highLiquidityAssets / monthly.totalConsumption) * 10) / 10 : 0;

  // 當月完整流水帳（依日期新→舊，同日依列號新→舊）供 10 筆分頁列表與日曆模式使用
  const sortLogsDesc = (a: CashFlowLogDto, b: CashFlowLogDto): number =>
    b.date.localeCompare(a.date) || b.rowIndex - a.rowIndex;
  const sortedMonthlyLogs = monthlyLogs.slice().sort(sortLogsDesc);
  const recentLogs = allLogs.slice().sort(sortLogsDesc).slice(0, 100);
  const availableYears = Array.from(yearSet).sort((a, b) => b - a);

  return {
    meta: {
      todayYmd: formatDateYmd(now),
      selectedYear,
      selectedMonth,
      selectedYearMonth,
      usdTwdRate,
      monthlyDailyBudget: Math.round(monthlyDailyBudget),
      emergencyTargetMonths: Math.round(emergencyTargetMonths),
      pinEnabled: isAppPinEnabled(),
      categories: WEBAPP_CATEGORY_MAP,
      assetSubCategories: ASSET_SUB_CATEGORIES,
      sinkingCategories: SINKING_FUND_CATEGORIES,
      availableYears,
    },
    dashboard: {
      monthly,
      yearly,
      budgetUsagePct,
      remainingBudget,
      emergencyMonths,
      highLiquidityAssets: Math.round(highLiquidityAssets),
      netWorth: {
        totalAssets: Math.round(totalAssets),
        totalLiabilities: Math.round(totalLiabilities),
        netWorth,
        debtRatio,
        stockValue: Math.round(stockValue),
        cashUsdValue: Math.round(cashUsdValue),
        fundStructuredValue: Math.round(fundStructuredValue),
        insuranceValue: Math.round(insuranceValue),
        otherAssetsValue,
      },
      monthlyTrend,
    },
    monthlyLogs: sortedMonthlyLogs,
    recentLogs,
    recurringItems,
    sinkingItems,
    assetItems,
    netWorthHistory,
  };
}

function aggregatePeriodMetrics(
  logs: CashFlowLogDto[],
  sinkingReserve: number,
  useSinkingInConsumption: boolean
): PeriodMetricsDto {
  let totalIncome = 0;
  let fixedExpense = 0;
  let subscription = 0;
  let dailyExpense = 0;
  let taxLargeActual = 0;
  let investment = 0;
  let investmentStock = 0;
  let investmentFund = 0;
  let salary = 0;
  let rentIncome = 0;
  let otherIncome = 0;
  let mortgage = 0;
  let carLoan = 0;

  for (const l of logs) {
    const amt = l.twdAmount;
    if (l.type === CASHFLOW_TYPES.FIXED_INCOME) {
      totalIncome += amt;
      if (l.category === '薪資') salary += amt;
      else if (l.category === '房租收入') rentIncome += amt;
    } else if (l.type === CASHFLOW_TYPES.OTHER_INCOME) {
      totalIncome += amt;
      otherIncome += amt;
    } else if (l.type === CASHFLOW_TYPES.FIXED_EXPENSE) {
      fixedExpense += amt;
      if (l.category === '房貸') mortgage += amt;
      else if (l.category === '車貸') carLoan += amt;
    } else if (l.type === CASHFLOW_TYPES.SUBSCRIPTION) {
      subscription += amt;
    } else if (l.type === CASHFLOW_TYPES.DAILY_EXPENSE) {
      dailyExpense += amt;
    } else if (l.type === CASHFLOW_TYPES.TAX_LARGE) {
      taxLargeActual += amt;
    } else if (l.type === CASHFLOW_TYPES.INVESTMENT) {
      investment += amt;
      if (l.category === '台股投資' || l.category === '台股加碼') investmentStock += amt;
      else if (l.category === '中信基金' || l.category === '中信基金加碼') investmentFund += amt;
    }
  }

  const taxComponent = useSinkingInConsumption ? sinkingReserve : taxLargeActual;
  const totalConsumption = Math.round(fixedExpense + subscription + dailyExpense + taxComponent);
  const freeCashFlow = Math.round(totalIncome - totalConsumption - investment);
  const totalSavings = Math.round(investment + freeCashFlow);
  const savingsRate = totalIncome > 0 ? Math.round((totalSavings / totalIncome) * 1000) / 10 : 0;
  const investmentOther = Math.max(0, Math.round(investment - investmentStock - investmentFund));

  return {
    totalIncome: Math.round(totalIncome),
    fixedExpense: Math.round(fixedExpense),
    subscription: Math.round(subscription),
    dailyExpense: Math.round(dailyExpense),
    sinkingReserve: Math.round(sinkingReserve),
    taxLargeActual: Math.round(taxLargeActual),
    totalConsumption,
    investment: Math.round(investment),
    freeCashFlow,
    totalSavings,
    savingsRate,
    investmentStock: Math.round(investmentStock),
    investmentFund: Math.round(investmentFund),
    investmentOther,
    salary: Math.round(salary),
    rentIncome: Math.round(rentIncome),
    otherIncome: Math.round(otherIncome),
    mortgage: Math.round(mortgage),
    carLoan: Math.round(carLoan),
  };
}

function readRecurringItems(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  usdTwdRate: number
): RecurringItemDto[] {
  const sheet = getSheetOrThrow(ss, SHEET_NAMES.RECURRING_CONFIG);
  const lastRow = findLastDataRowInColumn(sheet, 1);
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const items: RecurringItemDto[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const itemName = String(r[0] || '').trim();
    if (!itemName) continue;
    const amount = toSafeNumber(r[3], 0);
    const currency = String(r[4] || 'TWD').trim().toUpperCase();
    const cycle = String(r[5] || '月繳').trim();
    const billingSpec = String(r[6] === null || r[6] === undefined ? '' : r[6]).trim();
    const status = String(r[7] || '停用').trim();
    const monthlyFromFormula = toSafeNumber(r[8], NaN);

    let monthlyTwd = 0;
    if (!isNaN(monthlyFromFormula)) {
      monthlyTwd = Math.round(monthlyFromFormula);
    } else if (status === '啟用' && cycle !== '一次性') {
      const rate = currency === 'USD' ? usdTwdRate : 1;
      const mult =
        cycle === '月繳'
          ? 1
          : cycle === '年繳'
            ? 1 / 12
            : billingSpec
              ? billingSpec.split(/[,、，/\s]+/).filter(Boolean).length / 12
              : 0;
      monthlyTwd = Math.round(amount * rate * mult);
    }

    items.push({
      rowIndex: i + 2,
      itemName,
      category: String(r[1] || '其他').trim(),
      type: String(r[2] || CASHFLOW_TYPES.SUBSCRIPTION).trim(),
      amount,
      currency,
      cycle,
      billingSpec,
      status,
      monthlyTwd,
      note: String(r[9] || '').trim(),
    });
  }
  return items;
}

function readSinkingFundItems(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): SinkingFundItemDto[] {
  const sheet = getSheetOrThrow(ss, SHEET_NAMES.SINKING_FUND);
  const lastRow = findLastDataRowInColumn(sheet, 1);
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const items: SinkingFundItemDto[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const itemName = String(r[0] || '').trim();
    if (!itemName) continue;
    const totalAmount = toSafeNumber(r[2], 0);
    const months = Math.max(1, Math.round(toSafeNumber(r[3], 12)));
    const status = String(r[6] || '啟用').trim();
    const monthlyReserve = status === '啟用' ? Math.round(totalAmount / months) : 0;

    items.push({
      rowIndex: i + 2,
      itemName,
      category: String(r[1] || '其他').trim(),
      totalAmount: Math.round(totalAmount),
      months,
      dueNote: String(r[4] || '').trim(),
      monthlyReserve,
      status,
      ytdSpent: Math.round(toSafeNumber(r[7], 0)),
      note: String(r[9] || '').trim(),
    });
  }
  return items;
}

function readAssetItems(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  usdTwdRate: number
): AssetItemDto[] {
  const sheet = getSheetOrThrow(ss, SHEET_NAMES.ASSETS_LIABILITIES);
  const lastRow = findLastDataRowInColumn(sheet, 5);
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const items: AssetItemDto[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const itemName = String(r[4] || '').trim();
    if (!itemName) continue;
    const quantityOrAmount = toSafeNumber(r[6], 0);
    const currency = String(r[7] || 'TWD').trim().toUpperCase();
    const unitPrice = toSafeNumber(r[8], 1);
    const twdFromCol = toSafeNumber(r[9], NaN);
    const twdValue = !isNaN(twdFromCol)
      ? Math.round(twdFromCol)
      : Math.round(quantityOrAmount * unitPrice * (currency === 'USD' ? usdTwdRate : 1));

    items.push({
      rowIndex: i + 2,
      updateMode: String(r[0] || '手動快照').trim(),
      majorType: String(r[1] || '資產').trim(),
      subCategory: String(r[2] || '其他資產').trim(),
      liquidity: String(r[3] || '中流動').trim(),
      itemName,
      ticker: String(r[5] || '').trim(),
      quantityOrAmount,
      currency,
      unitPrice,
      twdValue,
      note: String(r[10] || '').trim(),
    });
  }
  return items;
}

function readNetWorthHistory(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  limit: number
): NetWorthHistoryDto[] {
  const sheet = ss.getSheetByName(SHEET_NAMES.NETWORTH_HISTORY);
  if (!sheet) return [];
  const lastRow = findLastDataRowInColumn(sheet, 2);
  if (lastRow < 2) return [];

  const count = Math.min(limit, lastRow - 1);
  const startRow = lastRow - count + 1;
  const rows = sheet.getRange(startRow, 1, count, 11).getValues();
  const result: NetWorthHistoryDto[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const ym = String(r[1] || '').trim();
    if (!ym) continue;
    result.push({
      date: r[0] instanceof Date ? formatDateYmd(r[0]) : String(r[0] || ''),
      yearMonth: ym,
      totalAssets: Math.round(toSafeNumber(r[2], 0)),
      totalLiabilities: Math.round(toSafeNumber(r[3], 0)),
      netWorth: Math.round(toSafeNumber(r[4], 0)),
      savingsRate: Math.round(toSafeNumber(r[10], 0) * 1000) / 10,
    });
  }
  return result;
}

/**
 * 內部共用：取得腳本鎖執行寫入，並回傳最新 AppBundle
 */
function withScriptLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('系統忙碌中，請稍候 2 秒再試。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * 1. 新增收支流水帳（手機記帳）
 */
function submitExpense(
  payload: WebAppExpensePayload,
  token?: string,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);

  if (!payload || typeof payload !== 'object') {
    throw new Error('請求格式無效，請重新整理頁面後再試。');
  }

  const parsedDate = parseLocalDate(String(payload.date || ''));
  const type = String(payload.type || '').trim();
  const category = String(payload.category || '').trim() || '其他';
  const itemName = (String(payload.itemName || '').trim() || category).slice(0, 80);
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

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
    const usdTwdRate = getLiveUsdTwdRate(ss);
    const fxRate = currency === 'USD' ? usdTwdRate : 1;
    const twdAmount = Math.round(amount * fxRate);

    appendCashFlowRows(logSheet, [
      {
        date: parsedDate,
        type,
        category,
        itemName,
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
          .setValues([[itemName, category, type, amount, currency, '月繳', '', '啟用']]);
        configSheet
          .getRange(nextRow, 10)
          .setValue(note ? `[手機加入每月常態] ${note}` : '手機記帳加入每月常態');
        addedRecurring = true;
      }
    }

    SpreadsheetApp.flush();
    const recurringHint = addedRecurring ? '（已同步加入每月固定入帳）' : '';
    return {
      ok: true,
      message: `已成功記帳：${itemName} (NT$ ${twdAmount.toLocaleString()})${recurringHint}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 2. 刪除一筆誤記的 CashFlow_Log 流水帳
 */
function deleteCashFlowEntry(
  token: string,
  rowIndex: number,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  const idx = Math.floor(Number(rowIndex));
  if (isNaN(idx) || idx < 2) {
    throw new Error('無效的紀錄列號。');
  }

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
    const lastRow = findLastDataRowInColumn(logSheet, 1);
    if (idx > lastRow) {
      throw new Error('找不到該筆紀錄（可能已被刪除）。');
    }
    const deletedName = String(logSheet.getRange(idx, 5).getValue() || '紀錄');
    logSheet.deleteRow(idx);
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: `已刪除：${deletedName}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 3. 更新每月日常消費預算上限與緊急預備金目標月數
 */
function saveBudgetSettings(
  token: string,
  settings: { monthlyDailyBudget: number; emergencyTargetMonths: number },
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  const budget = Math.round(Number(settings.monthlyDailyBudget));
  const months = Math.round(Number(settings.emergencyTargetMonths));
  if (isNaN(budget) || budget < 0) throw new Error('請輸入有效的每月預算上限。');
  if (isNaN(months) || months < 1 || months > 60) throw new Error('緊急預備金目標月數需介於 1～60 個月。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const dash = getSheetOrThrow(ss, SHEET_NAMES.DASHBOARD);
    dash.getRange('B3').setValue(budget);
    dash.getRange('F3').setValue(months);
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: `已更新預算上限 NT$ ${budget.toLocaleString()}、預備金目標 ${months} 個月`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 4. 新增或編輯 Recurring_Config（薪資 / 房貸 / 訂閱 / 定期定額 / 其他收入）
 */
function saveRecurringItem(
  token: string,
  item: {
    rowIndex?: number;
    itemName: string;
    category: string;
    type: string;
    amount: number;
    currency: string;
    cycle: string;
    billingSpec?: string;
    status: string;
    note?: string;
  },
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);

  const itemName = String(item.itemName || '').trim().slice(0, 80);
  const category = String(item.category || '').trim().slice(0, 40) || '其他';
  const type = String(item.type || '').trim();
  const amount = Number(item.amount);
  const currency = String(item.currency || 'TWD').trim().toUpperCase();
  const cycle = String(item.cycle || '月繳').trim();
  const billingSpec = String(item.billingSpec || '').trim().slice(0, 40);
  const status = String(item.status || '啟用').trim();
  const note = String(item.note || '').trim().slice(0, 200);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (RECURRING_CASHFLOW_TYPES.indexOf(type) === -1) throw new Error(`不支援的收支類型：${type}`);
  if (isNaN(amount) || !isFinite(amount) || amount <= 0) throw new Error('請輸入大於 0 的金額。');
  if (CURRENCIES.indexOf(currency) === -1) throw new Error(`不支援的幣別：${currency}`);
  if (BILLING_CYCLES.indexOf(cycle) === -1) throw new Error(`不支援的週期：${cycle}`);
  if (STATUS_OPTIONS.indexOf(status) === -1) throw new Error(`不支援的狀態：${status}`);

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.RECURRING_CONFIG);
    const rowIdx = item.rowIndex && item.rowIndex >= 2 ? Math.floor(item.rowIndex) : findLastDataRowInColumn(sheet, 1) + 1;

    sheet.getRange(rowIdx, 7).setNumberFormat('@');
    sheet.getRange(rowIdx, 1, 1, 8).setValues([[itemName, category, type, amount, currency, cycle, billingSpec, status]]);
    sheet.getRange(rowIdx, 10).setValue(note);
    SpreadsheetApp.flush();

    return {
      ok: true,
      message: `${item.rowIndex ? '已更新' : '已新增'}：${itemName}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 5. 一鍵切換 Recurring_Config 啟用/停用開關
 */
function toggleRecurringStatus(
  token: string,
  rowIndex: number,
  nextStatus: string,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  if (STATUS_OPTIONS.indexOf(nextStatus) === -1) throw new Error('狀態無效。');
  const idx = Math.floor(Number(rowIndex));
  if (isNaN(idx) || idx < 2) throw new Error('無效列號。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.RECURRING_CONFIG);
    const name = String(sheet.getRange(idx, 1).getValue() || '項目');
    sheet.getRange(idx, 8).setValue(nextStatus);
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: `${name} 已設為「${nextStatus}」`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 6. 刪除 Recurring_Config 項目（不影響歷史帳目）
 */
function deleteRecurringItem(
  token: string,
  rowIndex: number,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  const idx = Math.floor(Number(rowIndex));
  if (isNaN(idx) || idx < 2) throw new Error('無效列號。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.RECURRING_CONFIG);
    const name = String(sheet.getRange(idx, 1).getValue() || '項目');
    sheet.deleteRow(idx);
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: `已刪除固定項目：${name}（歷史帳目不受影響）`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 7. 新增或編輯 Annual_Sinking_Fund（支援自訂分攤月數）
 */
function saveSinkingFundItem(
  token: string,
  item: {
    rowIndex?: number;
    itemName: string;
    category: string;
    totalAmount: number;
    months: number;
    dueNote?: string;
    status: string;
    note?: string;
  },
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);

  const itemName = String(item.itemName || '').trim().slice(0, 80);
  const category = String(item.category || '').trim().slice(0, 40) || '其他';
  const totalAmount = Math.round(Number(item.totalAmount));
  const months = Math.round(Number(item.months));
  const dueNote = String(item.dueNote || '').trim().slice(0, 40);
  const status = String(item.status || '啟用').trim();
  const note = String(item.note || '').trim().slice(0, 200);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (isNaN(totalAmount) || totalAmount <= 0) throw new Error('請輸入大於 0 的預估總金額。');
  if (isNaN(months) || months < 1 || months > 120) throw new Error('分攤月數需介於 1～120 個月。');
  if (STATUS_OPTIONS.indexOf(status) === -1) throw new Error('狀態無效。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.SINKING_FUND);
    const r = item.rowIndex && item.rowIndex >= 2 ? Math.floor(item.rowIndex) : findLastDataRowInColumn(sheet, 1) + 1;

    sheet.getRange(r, 1, 1, 5).setValues([[itemName, category, totalAmount, months, dueNote]]);
    sheet.getRange(r, 6).setFormula(`=IF(C${r}="","",IF(G${r}<>"啟用",0,ROUND(C${r}/IF(D${r}="",12,D${r}),0)))`);
    sheet.getRange(r, 7).setValue(status);
    sheet
      .getRange(r, 8)
      .setFormula(
        `=IF(A${r}="","",SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,">="&DATE(Dashboard!$B$2,1,1),CashFlow_Log!$A$2:$A,"<="&DATE(Dashboard!$B$2,12,31),CashFlow_Log!$C$2:$C,"稅金與大額",CashFlow_Log!$E$2:$E,A${r}))`
      );
    sheet.getRange(r, 9).setFormula(`=IF(A${r}="","",C${r}-H${r})`);
    sheet.getRange(r, 10).setValue(note);
    SpreadsheetApp.flush();

    return {
      ok: true,
      message: `${item.rowIndex ? '已更新' : '已新增'}攤提：${itemName}（分 ${months} 個月，每月 NT$ ${Math.round(totalAmount / months).toLocaleString()}）`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 8. 刪除 Annual_Sinking_Fund 項目
 */
function deleteSinkingFundItem(
  token: string,
  rowIndex: number,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  const idx = Math.floor(Number(rowIndex));
  if (isNaN(idx) || idx < 2) throw new Error('無效列號。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.SINKING_FUND);
    const name = String(sheet.getRange(idx, 1).getValue() || '攤提項目');
    sheet.deleteRow(idx);
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: `已刪除攤提項目：${name}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 9. 新增或更新 Assets_Liabilities 項目（台股股數 / 美金 / 定存 / 基金 / 保單 / 房車貸餘額）
 */
function saveAssetItem(
  token: string,
  item: {
    rowIndex?: number;
    updateMode: string;
    majorType: string;
    subCategory: string;
    liquidity: string;
    itemName: string;
    ticker?: string;
    quantityOrAmount: number;
    currency: string;
    note?: string;
  },
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);

  const updateMode = String(item.updateMode || '手動快照').trim();
  const majorType = String(item.majorType || '資產').trim();
  const subCategory = String(item.subCategory || '其他資產').trim();
  const liquidity = majorType === '負債' ? '負債' : String(item.liquidity || '中流動').trim();
  const itemName = String(item.itemName || '').trim().slice(0, 80);
  const ticker = String(item.ticker || '').trim().toUpperCase().slice(0, 30);
  const quantityOrAmount = Number(item.quantityOrAmount);
  const currency = String(item.currency || 'TWD').trim().toUpperCase();
  const note = String(item.note || '').trim().slice(0, 200);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (ASSET_UPDATE_MODES.indexOf(updateMode) === -1) throw new Error('更新方式無效。');
  if (ASSET_MAJOR_TYPES.indexOf(majorType) === -1) throw new Error('大類需為資產或負債。');
  if (isNaN(quantityOrAmount) || !isFinite(quantityOrAmount) || quantityOrAmount < 0) {
    throw new Error('請輸入大於等於 0 的有效數值。');
  }
  if (CURRENCIES.indexOf(currency) === -1) throw new Error('幣別僅支援 TWD / USD。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.ASSETS_LIABILITIES);
    const r = item.rowIndex && item.rowIndex >= 2 ? Math.floor(item.rowIndex) : findLastDataRowInColumn(sheet, 5) + 1;

    sheet
      .getRange(r, 1, 1, 8)
      .setValues([[updateMode, majorType, subCategory, liquidity, itemName, ticker, quantityOrAmount, currency]]);
    sheet
      .getRange(r, 9)
      .setFormula(`=IF(E${r}="","",IF(F${r}<>"",IFERROR(GOOGLEFINANCE(F${r},"price"),0),1))`);
    sheet
      .getRange(r, 10)
      .setFormula(`=IF(E${r}="","",ROUND(G${r}*I${r}*IF(H${r}="USD",Dashboard!$F$2,1),0))`);
    const stampedNote = note || `UI 更新 @ ${formatDateYmd(new Date())}`;
    sheet.getRange(r, 11).setValue(stampedNote);
    SpreadsheetApp.flush();

    return {
      ok: true,
      message: `${item.rowIndex ? '已更新' : '已新增'}：${itemName}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 10. 刪除 Assets_Liabilities 項目
 */
function deleteAssetItem(
  token: string,
  rowIndex: number,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  const idx = Math.floor(Number(rowIndex));
  if (isNaN(idx) || idx < 2) throw new Error('無效列號。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = getSheetOrThrow(ss, SHEET_NAMES.ASSETS_LIABILITIES);
    const name = String(sheet.getRange(idx, 5).getValue() || '資產項目');
    sheet.deleteRow(idx);
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: `已刪除：${name}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}

/**
 * 11. 從 UI 手動觸發常態收支入帳（支援指定查詢月份）
 */
function runRecurringFromUi(
  token: string,
  year: number,
  month: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  return withScriptLock(() => {
    const res = runMonthlyRecurring(year, month);
    const ss = getActiveSpreadsheetOrThrow();
    return {
      ok: true,
      message: `${res.yearMonth} 入帳完成：新增 ${res.insertedCount} 筆，略過重複 ${res.skippedCount} 筆`,
      bundle: buildAppBundleInternal(ss, year, month),
    };
  });
}

/**
 * 12. 從 UI 一鍵記錄本月淨資產快照
 */
function runSnapshotFromUi(
  token: string,
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  return withScriptLock(() => {
    const res = runMonthEndNetWorthSnapshot();
    const ss = getActiveSpreadsheetOrThrow();
    return {
      ok: true,
      message: `${res.yearMonth} 淨資產快照${res.updated ? '已更新' : '已建立'}：NT$ ${res.netWorth.toLocaleString()}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}
