import { todayInTimeZone } from './dates';
import { roundTo } from './format';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID, DEFAULT_LEDGER_NAME, STOCK_TX_TYPES } from './constants';
import type {
  AllSavingsSummary,
  AssetItem,
  CashFlowLog,
  Ledger,
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
  WatchlistItemSummary,
  WatchlistSummary,
} from './types';

export function getEffectiveLedgerId(item?: { ledgerId?: string | null } | null): string {
  const s = String(item?.ledgerId ?? '').trim();
  return s || DEFAULT_LEDGER_ID;
}

export function ensureActiveLedgers(ledgers?: Ledger[] | null): Ledger[] {
  const active = (ledgers || [])
    .filter((l) => !l.deletedAt)
    .slice()
    .sort(compareBySortOrder);
  if (active.some((l) => l.id === DEFAULT_LEDGER_ID)) {
    return active;
  }
  const fallbackDefault: Ledger = {
    id: DEFAULT_LEDGER_ID,
    name: DEFAULT_LEDGER_NAME,
    includeInNetWorth: true,
    monthlyDailyBudget: null,
    note: '預設個人帳本（納入總資產與淨值統計）',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
  return [fallbackDefault, ...active];
}

export function isLedgerIncludedInNetWorth(ledgerId: string, ledgers?: Ledger[] | null): boolean {
  const lid = String(ledgerId || DEFAULT_LEDGER_ID).trim() || DEFAULT_LEDGER_ID;
  if (!ledgers || ledgers.length === 0) {
    return lid === DEFAULT_LEDGER_ID;
  }
  const found = ledgers.find((l) => !l.deletedAt && l.id === lid);
  if (!found) {
    return lid === DEFAULT_LEDGER_ID;
  }
  return Boolean(found.includeInNetWorth);
}

export function isAssetIncludedInNetWorth(asset: AssetItem, ledgers?: Ledger[] | null): boolean {
  if (asset.deletedAt || asset.isWatchlist || asset.excludeFromNetWorth) {
    return false;
  }
  return isLedgerIncludedInNetWorth(getEffectiveLedgerId(asset), ledgers);
}

export function filterAssetsByLedgerScope(
  assets: AssetItem[],
  scope: 'net_worth' | 'all' | string,
  ledgers?: Ledger[] | null
): AssetItem[] {
  const active = (assets || []).filter((a) => !a.deletedAt && !a.isWatchlist);
  if (scope === 'all') return active;
  if (scope === 'net_worth') {
    return active.filter((a) => isAssetIncludedInNetWorth(a, ledgers));
  }
  const target = String(scope || DEFAULT_LEDGER_ID).trim() || DEFAULT_LEDGER_ID;
  return active.filter((a) => getEffectiveLedgerId(a) === target);
}

export function filterCashFlowsByLedgerScope(
  logs: CashFlowLog[],
  scope: 'net_worth' | 'all' | string,
  ledgers?: Ledger[] | null
): CashFlowLog[] {
  const active = (logs || []).filter((l) => !l.deletedAt);
  if (scope === 'all') return active;
  if (scope === 'net_worth') {
    return active.filter((l) => isLedgerIncludedInNetWorth(getEffectiveLedgerId(l), ledgers));
  }
  const target = String(scope || DEFAULT_LEDGER_ID).trim() || DEFAULT_LEDGER_ID;
  return active.filter((l) => getEffectiveLedgerId(l) === target);
}

export function compareBySortOrder<T extends { sortOrder?: number; createdAt: string; id: string }>(
  a: T,
  b: T
): number {
  const oa = a.sortOrder ?? 0;
  const ob = b.sortOrder ?? 0;
  if (oa !== ob) return oa - ob;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Reorder a visible subset of items (e.g. stocks, a filtered recurring category, or one asset section)
 * within the full list while preserving the relative slots of items outside the subset.
 * Returns the full reordered list (with normalized 1-based sortOrder) and only the items whose sortOrder changed.
 */
export function applySubsetReorder<T extends { id: string; sortOrder?: number; createdAt: string; deletedAt?: string | null }>(
  allItems: T[],
  orderedSubsetIds: string[]
): { nextItems: T[]; changedItems: T[] } {
  const active = allItems.filter((item) => !item.deletedAt).slice().sort(compareBySortOrder);
  const deleted = allItems.filter((item) => Boolean(item.deletedAt));

  const byId = new Map(active.map((item) => [item.id, item]));
  const subsetIdSet = new Set<string>();
  const orderedSubset: T[] = [];
  for (const id of orderedSubsetIds) {
    if (subsetIdSet.has(id)) continue;
    const found = byId.get(id);
    if (found) {
      subsetIdSet.add(id);
      orderedSubset.push(found);
    }
  }

  if (orderedSubset.length < 2) {
    return { nextItems: [...active, ...deleted], changedItems: [] };
  }

  // Find the exact slot positions occupied by the subset in the currently sorted full list
  const slotIndices: number[] = [];
  active.forEach((item, idx) => {
    if (subsetIdSet.has(item.id)) {
      slotIndices.push(idx);
    }
  });

  const reorderedActive = active.slice();
  slotIndices.forEach((slotIdx, i) => {
    reorderedActive[slotIdx] = orderedSubset[i];
  });

  const changedItems: T[] = [];
  const normalizedActive = reorderedActive.map((item, idx) => {
    const nextOrder = idx + 1;
    if ((item.sortOrder ?? 0) !== nextOrder) {
      const updated = { ...item, sortOrder: nextOrder };
      changedItems.push(updated);
      return updated;
    }
    return item;
  });

  return {
    nextItems: [...normalizedActive, ...deleted],
    changedItems,
  };
}

function getTodayYmdLocal(): string {
  return todayInTimeZone(); // v1.8.15: "today" is the APP_TIMEZONE date, like the server
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
  // v1.8.15: amounts are kept in the loan's currency precision (USD cents, TWD whole dollars)
  const dp = loanCurrencyDecimals(item.currency);
  const money = (n: number) => roundTo(n, dp);
  const baseBalance = Math.max(0, money(item.quantityOrAmount * (item.unitPrice || 1)));
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
    const interest = money(bal * monthlyRate);
    const principal =
      monthlyPayment <= interest ? 0 : Math.min(bal, money(monthlyPayment - interest));
    bal = Math.max(0, money(bal - principal));
    totalPaidInterest += interest;
    totalPaidPrincipal += principal;
    elapsedPeriods++;
    curDate = nextBillingDateAfter(curDate, billingDay);
  }

  const nextPaymentDate = bal > 0 ? curDate : null;
  const nextInterest = bal > 0 ? money(bal * monthlyRate) : 0;
  const isInterestOnly = bal > 0 && monthlyPayment <= nextInterest;
  const nextPrincipal =
    bal > 0 ? (isInterestOnly ? 0 : Math.min(bal, money(monthlyPayment - nextInterest))) : 0;

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
        const interest = money(simBal * monthlyRate);
        if (monthlyPayment <= interest) {
          remainingPeriods = null;
          estimatedPayoffYm = null;
          break;
        }
        const principal = Math.min(simBal, money(monthlyPayment - interest));
        simBal = Math.max(0, money(simBal - principal));
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
    currentBalance: money(bal),
    currentBalanceTwd: Math.round(bal * fxRate),
    elapsedPeriods,
    totalPaidInterest: money(totalPaidInterest),
    totalPaidPrincipal: money(totalPaidPrincipal),
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
  const money = (n: number) => roundTo(n, loanCurrencyDecimals(item.currency));

  const entries: LoanScheduleEntry[] = [];
  let bal = summary.currentBalance;
  let payDate = summary.nextPaymentDate;

  for (let i = 1; i <= limit && bal > 0; i++) {
    const interest = money(bal * monthlyRate);
    if (monthlyPayment <= interest) break;
    const principal = Math.min(bal, money(monthlyPayment - interest));
    const payment = money(principal + interest);
    bal = Math.max(0, money(bal - principal));
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

  // v1.8.15: search the same 0–50% range that loan validation accepts
  let lo = 0;
  let hi = LOAN_MAX_ANNUAL_RATE_PERCENT / 100;
  if (calcPayment(hi) < monthlyPayment) {
    throw new Error(`依月付金推算的年利率超過 ${LOAN_MAX_ANNUAL_RATE_PERCENT}%，請確認月付金、申貸日與年限。`);
  }
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
  // M8 (v1.8.12): a non-TWD account is summed in its own currency and converted ONCE at the current rate, so the
  // balance never drifts with the exchange rate each entry happened to be recorded at.
  const isForeign = account.currency === 'USD';
  const rate = isForeign ? usdTwdRate : 1;
  const price = account.ticker ? account.unitPrice : account.unitPrice || 1;
  const baseNative = isForeign ? account.quantityOrAmount * price : 0;
  const baseBalanceTwd = computeAssetTwdValue(account, usdTwdRate);

  let adjustmentsTotalTwd = 0;
  let adjustmentsNative = 0;
  let adjustmentCount = 0;
  for (const adj of adjustments) {
    if (adj.deletedAt || adj.accountId !== account.id) continue;
    if (!isAfterSavingsAnchor(adj.date, adj.createdAt, account.balanceAnchorDate, account.balanceAnchorAt)) {
      continue;
    }
    if (isForeign) {
      adjustmentsNative += Number(adj.amount) || 0;
    } else {
      adjustmentsTotalTwd += Math.round(adj.twdAmount);
    }
    adjustmentCount++;
  }

  let cashflowNetTwd = 0;
  let cashflowNative = 0;
  let linkedLogCount = 0;
  for (const log of logs) {
    if (log.deletedAt || log.linkedAccountId !== account.id) continue;
    if (!isAfterSavingsAnchor(log.date, log.createdAt, account.balanceAnchorDate, account.balanceAnchorAt)) {
      continue;
    }
    const sign = isCashFlowIncome(log.type) ? 1 : -1;
    if (isForeign) {
      // Same-currency entries use their own amount; an entry in another currency has no rate to the account's
      // currency other than the current one.
      const native =
        log.currency === account.currency ? Number(log.amount) || 0 : (Number(log.twdAmount) || 0) / (rate || 1);
      cashflowNative += sign * native;
    } else {
      cashflowNetTwd += sign * log.twdAmount;
    }
    linkedLogCount++;
  }

  if (isForeign) {
    const nativeTotal = round2(baseNative + adjustmentsNative + cashflowNative);
    return {
      account,
      baseBalanceTwd,
      adjustmentsTotalTwd: Math.round(adjustmentsNative * rate),
      cashflowNetTwd: Math.round(cashflowNative * rate),
      linkedLogCount,
      adjustmentCount,
      currentBalanceNative: nativeTotal,
      currentBalanceTwd: Math.round(nativeTotal * rate),
    };
  }

  const currentBalanceTwd = Math.round(baseBalanceTwd + adjustmentsTotalTwd + cashflowNetTwd);
  return {
    account,
    baseBalanceTwd,
    adjustmentsTotalTwd: Math.round(adjustmentsTotalTwd),
    cashflowNetTwd: Math.round(cashflowNetTwd),
    linkedLogCount,
    adjustmentCount,
    currentBalanceNative: currentBalanceTwd,
    currentBalanceTwd,
  };
}

export function isTransferableAccount(item: AssetItem): boolean {
  if (item.deletedAt || item.isWatchlist) return false;
  if (item.majorType !== '資產') return false;
  if (item.isLinkedSavings) return true;
  if (isStockAsset(item)) return false;
  return !String(item.ticker || '').trim() && Number(item.unitPrice) === 1;
}

export function computeAllSavingsSummary(
  assets: AssetItem[],
  logs: CashFlowLog[],
  adjustments: SavingsAdjustment[],
  usdTwdRate: number,
  ledgerId?: string
): AllSavingsSummary {
  const linkedAccounts = assets
    .filter((a) => {
      if (a.deletedAt || !a.isLinkedSavings || a.isWatchlist) return false;
      if (ledgerId) return getEffectiveLedgerId(a) === ledgerId;
      return true;
    })
    .slice()
    .sort(compareBySortOrder);
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

export function isWatchlistAsset(item: AssetItem): boolean {
  return Boolean(!item.deletedAt && item.isWatchlist);
}

export function isStockAsset(item: AssetItem): boolean {
  if (item.deletedAt || item.isLinkedSavings || item.isWatchlist || item.majorType !== '資產') {
    return false;
  }
  return (
    item.subCategory === '台股' ||
    item.subCategory === '美股/ETF' ||
    Boolean(item.ticker && item.ticker.trim())
  );
}

function round2(n: number): number {
  return roundTo(n, 2); // v1.8.15: decimal rounding (1.005 → 1.01)
}

/** v1.8.15: decimals a loan is tracked in (USD cents, TWD whole dollars) */
function loanCurrencyDecimals(currency: string): number {
  return currency === 'USD' ? 2 : 0;
}

/** v1.8.15: upper bound of a loan's annual rate (validation and the implied-rate solver use the same value) */
export const LOAN_MAX_ANNUAL_RATE_PERCENT = 50;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeStockDailyMetrics(
  marketPrice: number,
  previousClose?: number | null
): { previousClose: number | null; dailyChange: number | null; dailyChangePct: number | null } {
  const prev =
    previousClose !== undefined && previousClose !== null && Number.isFinite(Number(previousClose))
      ? Number(previousClose)
      : null;
  if (prev === null || prev <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { previousClose: prev && prev > 0 ? prev : null, dailyChange: null, dailyChangePct: null };
  }
  const dailyChange = round4(marketPrice - prev);
  const dailyChangePct = round2((dailyChange / prev) * 100);
  return { previousClose: prev, dailyChange, dailyChangePct };
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
      // v1.8.15: a sell of more shares than held (e.g. after editing an earlier buy) only realizes the proceeds
      // of the shares that actually existed, so realized P&L and cost stay consistent
      const proceeds = tx.shares > 0 && sold < tx.shares ? (tx.totalAmount * sold) / tx.shares : tx.totalAmount;
      shares = Math.max(0, shares - sold);
      if (hasCostBasis) {
        costBasis = shares > 0 ? Math.max(0, costBasis - removedCost) : 0;
        realizedPnl += proceeds - removedCost;
      }
    } else if (tx.txType === STOCK_TX_TYPES.CASH_DIVIDEND) {
      cumulativeCashDividends += tx.totalAmount;
    }
  }

  const currentShares = round4(shares);
  const marketPrice = Number(asset.unitPrice || 0);
  const { previousClose, dailyChange, dailyChangePct } = computeStockDailyMetrics(
    marketPrice,
    asset.previousClose
  );
  const dailyPnl = dailyChange !== null ? round2(dailyChange * currentShares) : null;
  const dailyPnlTwd = dailyPnl !== null ? Math.round(dailyPnl * fxRate) : null;
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
    previousClose,
    dailyChange,
    dailyChangePct,
    dailyPnl,
    dailyPnlTwd,
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
  const stockAssets = (assets || [])
    .filter((a) => isStockAsset(a))
    .slice()
    .sort(compareBySortOrder);
  const positions = stockAssets.map((a) =>
    computeStockPositionSummary(a, stockTransactions || [], usdTwdRate)
  );

  let totalMarketValueTwd = 0;
  let totalDailyPnlSum = 0;
  let totalPrevMarketValueTwd = 0;
  let hasAnyDailyChange = false;
  let latestPriceUpdatedAt: string | null = null;
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
    if (p.asset.priceUpdatedAt && (!latestPriceUpdatedAt || p.asset.priceUpdatedAt > latestPriceUpdatedAt)) {
      latestPriceUpdatedAt = p.asset.priceUpdatedAt;
    }
    if (p.dailyPnlTwd !== null && p.previousClose !== null && p.currentShares > 0) {
      hasAnyDailyChange = true;
      totalDailyPnlSum += p.dailyPnlTwd;
      totalPrevMarketValueTwd += Math.round(p.previousClose * p.currentShares * p.fxRate);
    }
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

  const totalDailyPnlTwd = hasAnyDailyChange ? Math.round(totalDailyPnlSum) : null;
  const totalDailyChangePct =
    hasAnyDailyChange && totalPrevMarketValueTwd > 0
      ? round2((totalDailyPnlSum / totalPrevMarketValueTwd) * 100)
      : null;

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
    totalDailyPnlTwd,
    totalDailyChangePct,
    latestPriceUpdatedAt,
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

export function computeWatchlistSummary(assets: AssetItem[]): WatchlistSummary {
  const watchAssets = (assets || [])
    .filter((a) => isWatchlistAsset(a))
    .slice()
    .sort(compareBySortOrder);

  let latestPriceUpdatedAt: string | null = null;
  const items: WatchlistItemSummary[] = watchAssets.map((asset) => {
    const marketPrice = Number(asset.unitPrice || 0);
    const { previousClose, dailyChange, dailyChangePct } = computeStockDailyMetrics(
      marketPrice,
      asset.previousClose
    );
    const ts = asset.priceUpdatedAt || null;
    if (ts && (!latestPriceUpdatedAt || ts > latestPriceUpdatedAt)) {
      latestPriceUpdatedAt = ts;
    }
    return {
      asset,
      marketPrice,
      previousClose,
      dailyChange,
      dailyChangePct,
      priceUpdatedAt: ts,
    };
  });

  return { items, latestPriceUpdatedAt };
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
      else otherIncome += amt;
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

function buildCategoryChildren(
  monthLogs: CashFlowLog[],
  yearLogs: CashFlowLog[],
  targetType: string
): Array<{ label: string; monthlyAmount: number; yearlyAmount: number }> {
  const map = new Map<string, { monthly: number; yearly: number }>();
  for (const l of yearLogs) {
    if (l.deletedAt || l.type !== targetType) continue;
    const key = l.category || l.itemName || '其他';
    const cur = map.get(key) || { monthly: 0, yearly: 0 };
    cur.yearly += l.twdAmount;
    map.set(key, cur);
  }
  for (const l of monthLogs) {
    if (l.deletedAt || l.type !== targetType) continue;
    const key = l.category || l.itemName || '其他';
    const cur = map.get(key) || { monthly: 0, yearly: 0 };
    cur.monthly += l.twdAmount;
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([label, v]) => ({
      label,
      monthlyAmount: Math.round(v.monthly),
      yearlyAmount: Math.round(v.yearly),
    }))
    .sort((a, b) => b.yearlyAmount - a.yearlyAmount || b.monthlyAmount - a.monthlyAmount || a.label.localeCompare(b.label));
}

export function computeOverviewBreakdownGroups(
  monthLogs: CashFlowLog[],
  yearLogs: CashFlowLog[],
  sinkingItems: SinkingFundItem[],
  monthly: PeriodMetrics,
  yearly: PeriodMetrics
): Array<{
  key: string;
  label: string;
  monthlyAmount: number;
  yearlyAmount: number;
  isTotal?: boolean;
  children: Array<{ label: string; monthlyAmount: number; yearlyAmount: number }>;
}> {
  const sumByType = (logs: CashFlowLog[], type: string): number =>
    Math.round(logs.filter((l) => !l.deletedAt && l.type === type).reduce((s, l) => s + l.twdAmount, 0));

  // Build sinking/tax breakdown combining active sinking items (monthly reserve) + actual YTD tax/large logs
  const sinkingChildrenMap = new Map<string, { monthly: number; yearly: number }>();
  const activeSinking = (sinkingItems || [])
    .filter((s) => !s.deletedAt && s.status === '啟用')
    .slice()
    .sort(compareBySortOrder);
  for (const sf of activeSinking) {
    const reserve = computeSinkingMonthlyReserve(sf);
    const cur = sinkingChildrenMap.get(sf.itemName) || { monthly: 0, yearly: 0 };
    cur.monthly += reserve;
    sinkingChildrenMap.set(sf.itemName, cur);
  }
  for (const l of yearLogs) {
    if (l.deletedAt || l.type !== CASHFLOW_TYPES.TAX_LARGE) continue;
    // Match an active sinking item by name if possible, else group by category
    const matched = activeSinking.find((sf) => l.itemName.includes(sf.itemName));
    const key = matched ? matched.itemName : l.category || l.itemName || '其他稅金/大額';
    const cur = sinkingChildrenMap.get(key) || { monthly: 0, yearly: 0 };
    cur.yearly += l.twdAmount;
    sinkingChildrenMap.set(key, cur);
  }
  const sinkingChildren = Array.from(sinkingChildrenMap.entries())
    .map(([label, v]) => ({
      label,
      monthlyAmount: Math.round(v.monthly),
      yearlyAmount: Math.round(v.yearly),
    }))
    .sort((a, b) => b.yearlyAmount - a.yearlyAmount || b.monthlyAmount - a.monthlyAmount);

  return [
    {
      key: 'fixed_income',
      label: '固定收入',
      monthlyAmount: sumByType(monthLogs, CASHFLOW_TYPES.FIXED_INCOME),
      yearlyAmount: sumByType(yearLogs, CASHFLOW_TYPES.FIXED_INCOME),
      children: buildCategoryChildren(monthLogs, yearLogs, CASHFLOW_TYPES.FIXED_INCOME),
    },
    {
      key: 'other_income',
      label: '其他收入',
      monthlyAmount: sumByType(monthLogs, CASHFLOW_TYPES.OTHER_INCOME),
      yearlyAmount: sumByType(yearLogs, CASHFLOW_TYPES.OTHER_INCOME),
      children: buildCategoryChildren(monthLogs, yearLogs, CASHFLOW_TYPES.OTHER_INCOME),
    },
    {
      key: 'fixed_expense',
      label: '固定支出',
      monthlyAmount: monthly.fixedExpense,
      yearlyAmount: yearly.fixedExpense,
      children: buildCategoryChildren(monthLogs, yearLogs, CASHFLOW_TYPES.FIXED_EXPENSE),
    },
    {
      key: 'subscription',
      label: '訂閱扣款',
      monthlyAmount: monthly.subscription,
      yearlyAmount: yearly.subscription,
      children: buildCategoryChildren(monthLogs, yearLogs, CASHFLOW_TYPES.SUBSCRIPTION),
    },
    {
      key: 'daily_expense',
      label: '日常花費',
      monthlyAmount: monthly.dailyExpense,
      yearlyAmount: yearly.dailyExpense,
      children: buildCategoryChildren(monthLogs, yearLogs, CASHFLOW_TYPES.DAILY_EXPENSE),
    },
    {
      key: 'sinking_tax',
      label: '稅金攤提(月) / 實支(年)',
      monthlyAmount: monthly.sinkingReserve,
      yearlyAmount: yearly.taxLargeActual,
      children: sinkingChildren,
    },
    {
      key: 'investment',
      label: '投資流出',
      monthlyAmount: monthly.investment,
      yearlyAmount: yearly.investment,
      children: buildCategoryChildren(monthLogs, yearLogs, CASHFLOW_TYPES.INVESTMENT),
    },
    {
      key: 'total_savings',
      label: '總儲蓄（投資＋結餘）',
      monthlyAmount: monthly.totalSavings,
      yearlyAmount: yearly.totalSavings,
      isTotal: true,
      children: [],
    },
  ];
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
  asOfDate = getTodayYmdLocal(),
  ledgers?: Ledger[] | null,
  ledgerScope: 'net_worth' | 'all' | string = 'net_worth'
): NetWorthSummary {
  let totalAssets = 0;
  let totalLiabilities = 0;
  let highLiquidityAssets = 0;
  let stockValue = 0;
  let cashUsdValue = 0;
  let fundStructuredValue = 0;
  let insuranceValue = 0;

  const scopedAssets =
    ledgerScope === 'all'
      ? (assets || []).filter((a) => !a.deletedAt && !a.isWatchlist)
      : ledgerScope === 'net_worth'
        ? (assets || []).filter((a) => isAssetIncludedInNetWorth(a, ledgers))
        : (assets || []).filter(
            (a) => !a.deletedAt && !a.isWatchlist && getEffectiveLedgerId(a) === ledgerScope
          );

  for (const a of scopedAssets) {
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
