import { CASHFLOW_TYPES, STOCK_TX_TYPES } from './constants';
import type {
  AllSavingsSummary,
  AssetItem,
  CashFlowLog,
  LoanAmortizationSummary,
  LoanScheduleEntry,
  MonthlyTrendPoint,
  NetWorthSummary,
  PeriodMetrics,
  RecurringItem,
  SavingsAccountSummary,
  SavingsAdjustment,
  SinkingFundItem,
  StockPortfolioSummary,
  StockPositionSummary,
  StockTransaction,
} from './types';

function getTodayYmdLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function makeClampedYmd(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const maxDay = new Date(year, month, 0).getDate();
  const safeDay = Math.min(Math.max(1, Math.round(day)), maxDay);
  return `${year}-${pad(month)}-${pad(safeDay)}`;
}

function parseYmdParts(ymd: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function nextBillingDateAfter(ymd: string, billingDay: number): string {
  const parts = parseYmdParts(ymd);
  if (!parts) return ymd;
  const sameMonth = makeClampedYmd(parts.year, parts.month, billingDay);
  if (sameMonth > ymd) return sameMonth;
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  return makeClampedYmd(nextYear, nextMonth, billingDay);
}

export function computeLoanAmortizationSummary(
  item: AssetItem,
  usdTwdRate: number,
  asOfDate = getTodayYmdLocal()
): LoanAmortizationSummary {
  const baseBalance = Math.max(0, Math.round(item.quantityOrAmount * (item.unitPrice || 1)));
  const fxRate = item.currency === 'USD' ? usdTwdRate : 1;

  if (
    !item.isAmortizingLoan ||
    item.majorType !== '負債' ||
    !item.balanceAnchorDate ||
    !item.loanMonthlyPayment ||
    item.loanMonthlyPayment <= 0
  ) {
    return {
      baseBalance,
      currentBalance: baseBalance,
      currentBalanceTwd: Math.round(baseBalance * fxRate),
      elapsedPeriods: 0,
      totalPaidInterest: 0,
      totalPaidPrincipal: 0,
      nextPaymentDate: null,
      nextInterest: 0,
      nextPrincipal: 0,
      remainingPeriods: null,
      estimatedPayoffYm: null,
      isInterestOnly: false,
    };
  }

  const billingDay = Math.min(31, Math.max(1, Math.round(item.loanBillingDay || 1)));
  const annualRate = Math.max(0, Number(item.loanAnnualRate ?? 0));
  const monthlyRate = annualRate / 100 / 12;
  const monthlyPayment = Number(item.loanMonthlyPayment);

  let bal = baseBalance;
  let elapsedPeriods = 0;
  let totalPaidInterest = 0;
  let totalPaidPrincipal = 0;
  let curDate = nextBillingDateAfter(item.balanceAnchorDate, billingDay);

  while (curDate <= asOfDate && bal > 0 && elapsedPeriods < 1200) {
    const interest = Math.round(bal * monthlyRate);
    const principal =
      monthlyPayment <= interest ? 0 : Math.min(bal, Math.round(monthlyPayment - interest));
    bal = Math.max(0, bal - principal);
    totalPaidInterest += interest;
    totalPaidPrincipal += principal;
    elapsedPeriods++;
    curDate = nextBillingDateAfter(curDate, billingDay);
  }

  const nextPaymentDate = bal > 0 ? curDate : null;
  const nextInterest = bal > 0 ? Math.round(bal * monthlyRate) : 0;
  const isInterestOnly = bal > 0 && monthlyPayment <= nextInterest;
  const nextPrincipal =
    bal > 0 ? (isInterestOnly ? 0 : Math.min(bal, Math.round(monthlyPayment - nextInterest))) : 0;

  let remainingPeriods: number | null = 0;
  let estimatedPayoffYm: string | null = null;

  if (bal > 0) {
    if (isInterestOnly) {
      remainingPeriods = null;
      estimatedPayoffYm = null;
    } else {
      let simBal = bal;
      let simDate = curDate;
      let count = 0;
      let lastDate = curDate;
      while (simBal > 0 && count < 1200) {
        const interest = Math.round(simBal * monthlyRate);
        if (monthlyPayment <= interest) {
          remainingPeriods = null;
          estimatedPayoffYm = null;
          break;
        }
        const principal = Math.min(simBal, Math.round(monthlyPayment - interest));
        simBal = Math.max(0, simBal - principal);
        lastDate = simDate;
        count++;
        simDate = nextBillingDateAfter(simDate, billingDay);
      }
      if (simBal === 0) {
        remainingPeriods = count;
        estimatedPayoffYm = lastDate.slice(0, 7);
      }
    }
  }

  return {
    baseBalance,
    currentBalance: Math.round(bal),
    currentBalanceTwd: Math.round(bal * fxRate),
    elapsedPeriods,
    totalPaidInterest: Math.round(totalPaidInterest),
    totalPaidPrincipal: Math.round(totalPaidPrincipal),
    nextPaymentDate,
    nextInterest,
    nextPrincipal,
    remainingPeriods,
    estimatedPayoffYm,
    isInterestOnly,
  };
}

export function computeLoanAmortizationSchedule(
  item: AssetItem,
  asOfDate = getTodayYmdLocal(),
  maxPeriods = 12
): LoanScheduleEntry[] {
  const summary = computeLoanAmortizationSummary(item, 1, asOfDate);
  if (
    !item.isAmortizingLoan ||
    summary.currentBalance <= 0 ||
    !summary.nextPaymentDate ||
    summary.isInterestOnly ||
    !item.loanMonthlyPayment
  ) {
    return [];
  }

  const billingDay = Math.min(31, Math.max(1, Math.round(item.loanBillingDay || 1)));
  const monthlyRate = Math.max(0, Number(item.loanAnnualRate ?? 0)) / 100 / 12;
  const monthlyPayment = Number(item.loanMonthlyPayment);
  const limit = Math.min(600, Math.max(1, Math.round(maxPeriods)));

  const entries: LoanScheduleEntry[] = [];
  let bal = summary.currentBalance;
  let payDate = summary.nextPaymentDate;

  for (let i = 1; i <= limit && bal > 0; i++) {
    const interest = Math.round(bal * monthlyRate);
    if (monthlyPayment <= interest) break;
    const principal = Math.min(bal, Math.round(monthlyPayment - interest));
    const payment = principal + interest;
    bal = Math.max(0, bal - principal);
    entries.push({
      periodIndex: i,
      paymentDate: payDate,
      payment,
      interest,
      principal,
      remainingBalance: bal,
    });
    payDate = nextBillingDateAfter(payDate, billingDay);
  }
  return entries;
}

export function solveImpliedLoanAnnualRate(params: {
  baseBalance: number;
  anchorDate: string;
  loanStartDate: string;
  loanTermYears: number;
  monthlyPayment: number;
  billingDay?: number;
}): { annualRate: number; remainingPeriods: number } {
  const { baseBalance, anchorDate, loanStartDate, loanTermYears, monthlyPayment } = params;
  const startParts = parseYmdParts(loanStartDate);
  const anchorParts = parseYmdParts(anchorDate);
  if (!startParts || !anchorParts) {
    throw new Error('請輸入有效的申貸日與基準日（YYYY-MM-DD）。');
  }
  if (!Number.isFinite(baseBalance) || baseBalance <= 0) {
    throw new Error('基準餘額需大於 0。');
  }
  if (!Number.isFinite(loanTermYears) || loanTermYears < 1 || loanTermYears > 50) {
    throw new Error('貸款年限需介於 1 ～ 50 年。');
  }
  if (!Number.isFinite(monthlyPayment) || monthlyPayment <= 0) {
    throw new Error('每月月付金需大於 0。');
  }

  const billingDay = Math.min(31, Math.max(1, Math.round(params.billingDay || startParts.day)));
  const endDate = makeClampedYmd(startParts.year + Math.round(loanTermYears), startParts.month, billingDay);

  let remainingPeriods = 0;
  let curDate = nextBillingDateAfter(anchorDate, billingDay);
  while (curDate <= endDate && remainingPeriods < 1200) {
    remainingPeriods++;
    curDate = nextBillingDateAfter(curDate, billingDay);
  }
  if (remainingPeriods <= 0) {
    throw new Error('基準日已超過貸款到期日，請確認申貸日與年限。');
  }

  if (monthlyPayment * remainingPeriods <= baseBalance) {
    return { annualRate: 0, remainingPeriods };
  }

  const calcPayment = (annualRateDecimal: number): number => {
    const r = annualRateDecimal / 12;
    if (r === 0) return baseBalance / remainingPeriods;
    const factor = Math.pow(1 + r, remainingPeriods);
    return (baseBalance * (r * factor)) / (factor - 1);
  };

  let lo = 0;
  let hi = 0.3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (calcPayment(mid) < monthlyPayment) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const annualRate = Math.round(((lo + hi) / 2) * 100000) / 1000;
  return { annualRate, remainingPeriods };
}

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

export function isStockAsset(item: AssetItem): boolean {
  if (item.deletedAt || item.isLinkedSavings || item.majorType !== '資產') return false;
  return (
    item.subCategory === '台股' ||
    item.subCategory === '美股/ETF' ||
    Boolean(item.ticker && item.ticker.trim())
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeStockPositionSummary(
  asset: AssetItem,
  stockTransactions: StockTransaction[],
  usdTwdRate: number
): StockPositionSummary {
  const fxRate = asset.currency === 'USD' ? usdTwdRate : 1;
  const baselineShares = Math.max(0, Number(asset.quantityOrAmount || 0));
  const baselineHasCost = asset.costBasis !== null && asset.costBasis !== undefined;
  const baselineCostBasis = baselineHasCost ? Math.max(0, Number(asset.costBasis)) : 0;

  const txs = (stockTransactions || [])
    .filter((tx) => !tx.deletedAt && tx.assetId === asset.id)
    .slice()
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
    );

  const hasBuyTx = txs.some((tx) => tx.txType === STOCK_TX_TYPES.BUY);
  const hasCostBasis = baselineHasCost || (baselineShares === 0 && hasBuyTx);

  let shares = baselineShares;
  let costBasis = baselineCostBasis;
  let totalInvestedAllTime = baselineCostBasis;
  let cumulativeCashDividends = 0;
  let cumulativeStockDividendShares = 0;
  let realizedPnl = 0;

  for (const tx of txs) {
    if (tx.txType === STOCK_TX_TYPES.BUY) {
      shares += tx.shares;
      if (hasCostBasis) {
        costBasis += tx.totalAmount;
        totalInvestedAllTime += tx.totalAmount;
      }
    } else if (tx.txType === STOCK_TX_TYPES.STOCK_DIVIDEND) {
      shares += tx.shares;
      cumulativeStockDividendShares += tx.shares;
    } else if (tx.txType === STOCK_TX_TYPES.SELL) {
      const sold = Math.min(tx.shares, shares);
      const avgBefore = shares > 0 ? costBasis / shares : 0;
      const removedCost = hasCostBasis ? avgBefore * sold : 0;
      shares = Math.max(0, shares - sold);
      if (hasCostBasis) {
        costBasis = shares > 0 ? Math.max(0, costBasis - removedCost) : 0;
        realizedPnl += tx.totalAmount - removedCost;
      }
    } else if (tx.txType === STOCK_TX_TYPES.CASH_DIVIDEND) {
      cumulativeCashDividends += tx.totalAmount;
    }
  }

  const currentShares = round4(shares);
  const marketPrice = Number(asset.unitPrice || 0);
  const marketValue = round2(currentShares * marketPrice);
  const marketValueTwd = Math.round(marketValue * fxRate);

  const activeCostBasis = hasCostBasis ? round2(costBasis) : 0;
  const costBasisTwd = Math.round(activeCostBasis * fxRate);
  const avgCostPerShare = hasCostBasis && currentShares > 0 ? round4(activeCostBasis / currentShares) : 0;

  const unrealizedPnl = hasCostBasis ? round2(marketValue - activeCostBasis) : 0;
  const unrealizedPnlTwd = Math.round(unrealizedPnl * fxRate);
  const unrealizedRoiPct =
    hasCostBasis && activeCostBasis > 0 ? round1((unrealizedPnl / activeCostBasis) * 100) : 0;

  const cashDivRounded = round2(cumulativeCashDividends);
  const cashDivTwd = Math.round(cashDivRounded * fxRate);
  const realizedRounded = hasCostBasis ? round2(realizedPnl) : 0;
  const realizedTwd = Math.round(realizedRounded * fxRate);

  const unrecoveredCost = hasCostBasis ? round2(Math.max(0, activeCostBasis - cashDivRounded)) : 0;
  const unrecoveredCostTwd = Math.round(unrecoveredCost * fxRate);
  const unrecoveredCostPerShare =
    hasCostBasis && currentShares > 0 ? round4(unrecoveredCost / currentShares) : 0;
  const excessRecoveredCash = hasCostBasis
    ? round2(Math.max(0, cashDivRounded - activeCostBasis))
    : 0;
  const excessRecoveredCashTwd = Math.round(excessRecoveredCash * fxRate);

  const costRecoveryPct = !hasCostBasis
    ? 0
    : activeCostBasis > 0
      ? Math.min(100, round1((cashDivRounded / activeCostBasis) * 100))
      : cashDivRounded > 0
        ? 100
        : 0;
  const isCostRecovered =
    hasCostBasis &&
    ((activeCostBasis > 0 && cashDivRounded >= activeCostBasis) ||
      (activeCostBasis === 0 && cashDivRounded > 0));

  const totalReturnPnl = hasCostBasis
    ? round2(unrealizedPnl + cashDivRounded + realizedRounded)
    : 0;
  const totalReturnPnlTwd = Math.round(totalReturnPnl * fxRate);
  const roiDenominator = totalInvestedAllTime > 0 ? totalInvestedAllTime : activeCostBasis;
  const totalReturnRoiPct =
    hasCostBasis && roiDenominator > 0 ? round1((totalReturnPnl / roiDenominator) * 100) : 0;

  return {
    asset,
    fxRate,
    hasCostBasis,
    baselineShares,
    baselineCostBasis,
    currentShares,
    marketPrice,
    marketValue,
    marketValueTwd,
    costBasis: activeCostBasis,
    costBasisTwd,
    avgCostPerShare,
    unrealizedPnl,
    unrealizedPnlTwd,
    unrealizedRoiPct,
    cumulativeCashDividends: cashDivRounded,
    cumulativeCashDividendsTwd: cashDivTwd,
    cumulativeStockDividendShares: round4(cumulativeStockDividendShares),
    realizedPnl: realizedRounded,
    realizedPnlTwd: realizedTwd,
    unrecoveredCost,
    unrecoveredCostTwd,
    unrecoveredCostPerShare,
    excessRecoveredCash,
    excessRecoveredCashTwd,
    costRecoveryPct,
    isCostRecovered,
    totalReturnPnl,
    totalReturnPnlTwd,
    totalReturnRoiPct,
    totalInvestedAllTime: round2(totalInvestedAllTime),
    transactionCount: txs.length,
  };
}

export function computeStockPortfolioSummary(
  assets: AssetItem[],
  stockTransactions: StockTransaction[],
  usdTwdRate: number
): StockPortfolioSummary {
  const stockAssets = (assets || []).filter((a) => isStockAsset(a));
  const positions = stockAssets.map((a) =>
    computeStockPositionSummary(a, stockTransactions || [], usdTwdRate)
  );

  let totalMarketValueTwd = 0;
  let totalCostBasisTwd = 0;
  let totalUnrealizedPnlTwd = 0;
  let totalCashDividendsTwd = 0;
  let totalRealizedPnlTwd = 0;
  let totalUnrecoveredCostTwd = 0;
  let totalExcessRecoveredCashTwd = 0;
  let totalReturnPnlTwd = 0;
  let totalInvestedAllTimeTwd = 0;
  let hasAnyCostBasis = false;

  for (const p of positions) {
    totalMarketValueTwd += p.marketValueTwd;
    totalCashDividendsTwd += p.cumulativeCashDividendsTwd;
    if (p.hasCostBasis) {
      hasAnyCostBasis = true;
      totalCostBasisTwd += p.costBasisTwd;
      totalUnrealizedPnlTwd += p.unrealizedPnlTwd;
      totalRealizedPnlTwd += p.realizedPnlTwd;
      totalUnrecoveredCostTwd += p.unrecoveredCostTwd;
      totalExcessRecoveredCashTwd += p.excessRecoveredCashTwd;
      totalReturnPnlTwd += p.totalReturnPnlTwd;
      totalInvestedAllTimeTwd += Math.round(p.totalInvestedAllTime * p.fxRate);
    }
  }

  const totalUnrealizedRoiPct =
    totalCostBasisTwd > 0 ? round1((totalUnrealizedPnlTwd / totalCostBasisTwd) * 100) : 0;
  const overallCostRecoveryPct =
    totalCostBasisTwd > 0
      ? Math.min(100, round1((totalCashDividendsTwd / totalCostBasisTwd) * 100))
      : hasAnyCostBasis && totalCashDividendsTwd > 0
        ? 100
        : 0;
  const roiDenom = totalInvestedAllTimeTwd > 0 ? totalInvestedAllTimeTwd : totalCostBasisTwd;
  const totalReturnRoiPct = roiDenom > 0 ? round1((totalReturnPnlTwd / roiDenom) * 100) : 0;

  return {
    positions,
    totalMarketValueTwd: Math.round(totalMarketValueTwd),
    totalCostBasisTwd: Math.round(totalCostBasisTwd),
    totalUnrealizedPnlTwd: Math.round(totalUnrealizedPnlTwd),
    totalUnrealizedRoiPct,
    totalCashDividendsTwd: Math.round(totalCashDividendsTwd),
    totalRealizedPnlTwd: Math.round(totalRealizedPnlTwd),
    totalUnrecoveredCostTwd: Math.round(totalUnrecoveredCostTwd),
    totalExcessRecoveredCashTwd: Math.round(totalExcessRecoveredCashTwd),
    overallCostRecoveryPct,
    totalReturnPnlTwd: Math.round(totalReturnPnlTwd),
    totalReturnRoiPct,
    hasAnyCostBasis,
  };
}

export function computeAssetEffectiveShares(
  item: AssetItem,
  stockTransactions: StockTransaction[] = []
): number {
  if (!stockTransactions.length || !isStockAsset(item)) {
    return item.quantityOrAmount;
  }
  return computeStockPositionSummary(item, stockTransactions, 1).currentShares;
}

export function computeAssetEffectiveTwdValue(
  item: AssetItem,
  usdTwdRate: number,
  logs: CashFlowLog[] = [],
  adjustments: SavingsAdjustment[] = [],
  stockTransactions: StockTransaction[] = [],
  asOfDate = getTodayYmdLocal()
): number {
  if (item.isLinkedSavings) {
    return computeSavingsAccountSummary(item, logs, adjustments, usdTwdRate).currentBalanceTwd;
  }
  if (stockTransactions.length > 0 && isStockAsset(item)) {
    return computeStockPositionSummary(item, stockTransactions, usdTwdRate).marketValueTwd;
  }
  if (item.majorType === '負債' && item.isAmortizingLoan) {
    return computeLoanAmortizationSummary(item, usdTwdRate, asOfDate).currentBalanceTwd;
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
  adjustments: SavingsAdjustment[] = [],
  stockTransactions: StockTransaction[] = [],
  asOfDate = getTodayYmdLocal()
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
    const twdValue = computeAssetEffectiveTwdValue(a, usdTwdRate, logs, adjustments, stockTransactions, asOfDate);
    if (a.majorType === '資產') {
      totalAssets += twdValue;
      if (a.liquidity === '高流動' || a.isLinkedSavings) highLiquidityAssets += twdValue;
      if (a.subCategory === '台股' || a.subCategory === '美股/ETF') stockValue += twdValue;
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
