import { CASHFLOW_TYPES } from './constants';
import type {
  AllSavingsSummary,
  AssetItem,
  CashFlowLog,
  MonthlyTrendPoint,
  NetWorthSummary,
  PeriodMetrics,
  RecurringItem,
  SavingsAccountSummary,
  SavingsAdjustment,
  SinkingFundItem,
} from './types';

export function isCashFlowIncome(type: string): boolean {
  return type === CASHFLOW_TYPES.FIXED_INCOME || type === CASHFLOW_TYPES.OTHER_INCOME;
}

function isAfterSavingsAnchor(
  recordDate: string,
  recordCreatedAt: string,
  anchorDate?: string | null,
  anchorAt?: string | null
): boolean {
  if (!anchorDate) return true;
  if (recordDate > anchorDate) return true;
  if (recordDate < anchorDate) return false;
  // Same date as anchor: require createdAt >= anchorAt so prior same-day logs are not double-deducted
  if (!anchorAt) return true;
  return recordCreatedAt >= anchorAt;
}

export function computeSavingsAccountSummary(
  account: AssetItem,
  logs: CashFlowLog[],
  adjustments: SavingsAdjustment[],
  usdTwdRate: number
): SavingsAccountSummary {
  const baseBalanceTwd = computeAssetTwdValue(account, usdTwdRate);

  let adjustmentsTotalTwd = 0;
  let adjustmentCount = 0;
  for (const adj of adjustments) {
    if (adj.deletedAt || adj.accountId !== account.id) continue;
    if (!isAfterSavingsAnchor(adj.date, adj.createdAt, account.balanceAnchorDate, account.balanceAnchorAt)) {
      continue;
    }
    const twd =
      account.currency === 'USD' ? Math.round(adj.amount * usdTwdRate) : Math.round(adj.twdAmount);
    adjustmentsTotalTwd += twd;
    adjustmentCount++;
  }

  let cashflowNetTwd = 0;
  let linkedLogCount = 0;
  for (const log of logs) {
    if (log.deletedAt || log.linkedAccountId !== account.id) continue;
    if (!isAfterSavingsAnchor(log.date, log.createdAt, account.balanceAnchorDate, account.balanceAnchorAt)) {
      continue;
    }
    cashflowNetTwd += isCashFlowIncome(log.type) ? log.twdAmount : -log.twdAmount;
    linkedLogCount++;
  }

  return {
    account,
    baseBalanceTwd,
    adjustmentsTotalTwd: Math.round(adjustmentsTotalTwd),
    cashflowNetTwd: Math.round(cashflowNetTwd),
    linkedLogCount,
    adjustmentCount,
    currentBalanceTwd: Math.round(baseBalanceTwd + adjustmentsTotalTwd + cashflowNetTwd),
  };
}

export function computeAllSavingsSummary(
  assets: AssetItem[],
  logs: CashFlowLog[],
  adjustments: SavingsAdjustment[],
  usdTwdRate: number
): AllSavingsSummary {
  const linkedAccounts = assets.filter((a) => !a.deletedAt && a.isLinkedSavings);
  const accounts = linkedAccounts.map((acc) =>
    computeSavingsAccountSummary(acc, logs, adjustments, usdTwdRate)
  );
  const totalSavingsTwd = accounts.reduce((sum, a) => sum + a.currentBalanceTwd, 0);
  const explicitDefault = linkedAccounts.find((a) => a.isDefaultSavings);
  const defaultAccountId = explicitDefault?.id ?? linkedAccounts[0]?.id ?? null;

  return {
    accounts,
    totalSavingsTwd: Math.round(totalSavingsTwd),
    defaultAccountId,
  };
}

export function computeAssetEffectiveTwdValue(
  item: AssetItem,
  usdTwdRate: number,
  logs: CashFlowLog[] = [],
  adjustments: SavingsAdjustment[] = []
): number {
  if (item.isLinkedSavings) {
    return computeSavingsAccountSummary(item, logs, adjustments, usdTwdRate).currentBalanceTwd;
  }
  return computeAssetTwdValue(item, usdTwdRate);
}

export function computeRecurringMonthlyTwd(item: RecurringItem, usdTwdRate: number): number {
  if (item.status !== '啟用' || item.cycle === '一次性') return 0;
  const rate = item.currency === 'USD' ? usdTwdRate : 1;
  let mult = 0;
  if (item.cycle === '月繳') {
    mult = 1;
  } else if (item.cycle === '年繳') {
    mult = 1 / 12;
  } else if (item.cycle === '特定月份') {
    const monthsCount = item.billingSpec
      ? item.billingSpec.split(/[,、，/\s]+/).filter(Boolean).length
      : 0;
    mult = monthsCount / 12;
  }
  return Math.round(item.amount * rate * mult);
}

export function computeSinkingMonthlyReserve(item: SinkingFundItem): number {
  if (item.status !== '啟用') return 0;
  const months = Math.max(1, Math.round(item.months || 12));
  return Math.round(item.totalAmount / months);
}

export function computeAssetTwdValue(item: AssetItem, usdTwdRate: number): number {
  const rate = item.currency === 'USD' ? usdTwdRate : 1;
  const price = item.ticker ? item.unitPrice : item.unitPrice || 1;
  return Math.round(item.quantityOrAmount * price * rate);
}

export function aggregatePeriodMetrics(
  logs: CashFlowLog[],
  sinkingReserve: number,
  useSinkingInConsumption: boolean
): PeriodMetrics {
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
    if (l.deletedAt) continue;
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

export function computeMonthlyTrend(logs: CashFlowLog[], year: number): MonthlyTrendPoint[] {
  const byYm = new Map<string, CashFlowLog[]>();
  const prefix = `${year}-`;
  for (const l of logs) {
    if (l.deletedAt || !l.yearMonth.startsWith(prefix)) continue;
    const arr = byYm.get(l.yearMonth);
    if (arr) arr.push(l);
    else byYm.set(l.yearMonth, [l]);
  }

  const trend: MonthlyTrendPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const mLogs = byYm.get(ym) || [];
    let income = 0;
    let fixedSub = 0;
    let daily = 0;
    let taxLarge = 0;
    let investment = 0;
    for (const l of mLogs) {
      if (l.type === CASHFLOW_TYPES.FIXED_INCOME || l.type === CASHFLOW_TYPES.OTHER_INCOME) {
        income += l.twdAmount;
      } else if (l.type === CASHFLOW_TYPES.FIXED_EXPENSE || l.type === CASHFLOW_TYPES.SUBSCRIPTION) {
        fixedSub += l.twdAmount;
      } else if (l.type === CASHFLOW_TYPES.DAILY_EXPENSE) {
        daily += l.twdAmount;
      } else if (l.type === CASHFLOW_TYPES.TAX_LARGE) {
        taxLarge += l.twdAmount;
      } else if (l.type === CASHFLOW_TYPES.INVESTMENT) {
        investment += l.twdAmount;
      }
    }
    const netCashFlow = Math.round(income - fixedSub - daily - taxLarge - investment);
    trend.push({
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
  return trend;
}

export function computeNetWorthSummary(
  assets: AssetItem[],
  usdTwdRate: number,
  monthlyTotalConsumption: number,
  logs: CashFlowLog[] = [],
  adjustments: SavingsAdjustment[] = []
): NetWorthSummary {
  let totalAssets = 0;
  let totalLiabilities = 0;
  let highLiquidityAssets = 0;
  let stockValue = 0;
  let cashUsdValue = 0;
  let fundStructuredValue = 0;
  let insuranceValue = 0;

  for (const a of assets) {
    if (a.deletedAt) continue;
    const twdValue = computeAssetEffectiveTwdValue(a, usdTwdRate, logs, adjustments);
    if (a.majorType === '資產') {
      totalAssets += twdValue;
      if (a.liquidity === '高流動' || a.isLinkedSavings) highLiquidityAssets += twdValue;
      if (a.subCategory === '台股') stockValue += twdValue;
      else if (a.subCategory === '活存' || a.subCategory === '美金' || a.subCategory === '定存/現金' || a.isLinkedSavings) {
        cashUsdValue += twdValue;
      } else if (a.subCategory === '中信基金' || a.subCategory === '結構性商品') {
        fundStructuredValue += twdValue;
      } else if (a.subCategory === '保單(保價金)') {
        insuranceValue += twdValue;
      }
    } else if (a.majorType === '負債') {
      totalLiabilities += twdValue;
    }
  }

  const otherAssetsValue = Math.max(
    0,
    Math.round(totalAssets - stockValue - cashUsdValue - fundStructuredValue - insuranceValue)
  );
  const netWorth = Math.round(totalAssets - totalLiabilities);
  const debtRatio = totalAssets > 0 ? Math.round((totalLiabilities / totalAssets) * 1000) / 10 : 0;
  const emergencyMonths =
    monthlyTotalConsumption > 0 ? Math.round((highLiquidityAssets / monthlyTotalConsumption) * 10) / 10 : 0;

  return {
    totalAssets: Math.round(totalAssets),
    totalLiabilities: Math.round(totalLiabilities),
    netWorth,
    debtRatio,
    highLiquidityAssets: Math.round(highLiquidityAssets),
    emergencyMonths,
    stockValue: Math.round(stockValue),
    cashUsdValue: Math.round(cashUsdValue),
    fundStructuredValue: Math.round(fundStructuredValue),
    insuranceValue: Math.round(insuranceValue),
    otherAssetsValue,
  };
}

export function computeSinkingYtdSpent(
  logs: CashFlowLog[],
  year: number,
  itemName: string
): number {
  const prefix = `${year}-`;
  let total = 0;
  for (const l of logs) {
    if (
      !l.deletedAt &&
      l.yearMonth.startsWith(prefix) &&
      l.type === CASHFLOW_TYPES.TAX_LARGE &&
      l.itemName === itemName
    ) {
      total += l.twdAmount;
    }
  }
  return Math.round(total);
}
