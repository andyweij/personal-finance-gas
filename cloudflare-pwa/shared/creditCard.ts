import { CASHFLOW_TYPES } from './constants';
import { getCurrencyDecimals, resolveFxRate, type FxRateSource } from './currency';
import { todayInTimeZone } from './dates';
import { roundTo } from './format';
import type {
  AllCreditCardsSummary,
  AssetItem,
  CashFlowLog,
  CreditCardBillingWindow,
  CreditCardSummary,
  InstallmentPlan,
  SavingsAdjustment,
} from './types';

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function clampedYmd(year: number, month: number, day: number): string {
  const safeDay = Math.min(Math.max(1, Math.round(day)), daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(safeDay)}`;
}

function shiftYearMonth(year: number, month: number, deltaMonths: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + deltaMonths;
  const nextYear = Math.floor(total / 12);
  const nextMonth = ((total % 12) + 12) % 12 + 1;
  return { year: nextYear, month: nextMonth };
}

function addDaysYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function addMonthsToYm(ym: string, offsetMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  const next = shiftYearMonth(y, m, offsetMonths);
  return `${next.year}-${pad2(next.month)}`;
}

export function monthsBetweenYm(startYm: string, targetYm: string): number {
  const [sy, sm] = startYm.split('-').map(Number);
  const [ty, tm] = targetYm.split('-').map(Number);
  return (ty - sy) * 12 + (tm - sm);
}

export function buildInstallmentDedupKey(planId: string, seq: number): string {
  return `inst:${planId}:${seq}`;
}

export function getInstallmentEntryDate(startYm: string, seq: number, postDay = 1): string {
  const ym = addMonthsToYm(startYm, Math.max(0, seq - 1));
  const [y, m] = ym.split('-').map(Number);
  return clampedYmd(y, m, postDay);
}

/**
 * Splits `totalAmount` across `totalInstallments` periods with 100% conservation.
 * Any indivisible remainder is placed on the 1st installment (standard bank billing practice),
 * so periods 2..N have identical monthly amounts.
 */
export function computeInstallmentScheduleAmounts(
  totalAmount: number,
  totalInstallments: number,
  currency = 'TWD'
): number[] {
  const total = Number(totalAmount || 0);
  const n = Math.floor(Number(totalInstallments || 0));
  if (!Number.isFinite(total) || total <= 0 || n <= 0) return [];
  const dec = getCurrencyDecimals(currency);
  const factor = Math.pow(10, dec);
  const totalUnits = Math.round(total * factor);
  const baseUnits = Math.floor(totalUnits / n);
  const rem = totalUnits - baseUnits * n;
  return Array.from({ length: n }, (_, idx) => (idx === 0 ? baseUnits + rem : baseUnits) / factor);
}

export interface InstallmentPlanProgress {
  plan: InstallmentPlan;
  scheduleAmounts: number[];
  firstInstallmentAmount: number;
  regularInstallmentAmount: number;
  postedAmount: number;
  remainingInstallmentsCount: number;
  remainingAmount: number;
  remainingTwd: number;
  endYm: string;
  nextSeq: number | null;
  nextDueYm: string | null;
}

export function computeInstallmentPlanProgress(
  plan: InstallmentPlan,
  fxSource: FxRateSource
): InstallmentPlanProgress {
  const curr = plan.currency || 'TWD';
  const dec = getCurrencyDecimals(curr);
  const rate = resolveFxRate(curr, fxSource);
  const scheduleAmounts = computeInstallmentScheduleAmounts(
    plan.totalAmount,
    plan.totalInstallments,
    curr
  );
  const posted = Math.min(
    plan.totalInstallments,
    Math.max(0, Math.floor(Number(plan.postedInstallments || 0)))
  );
  const isActive = plan.status === 'active';
  const postedAmount = roundTo(
    scheduleAmounts.slice(0, posted).reduce((s, a) => s + a, 0),
    dec
  );
  const remainingInstallmentsCount = isActive ? Math.max(0, plan.totalInstallments - posted) : 0;
  const remainingAmount = isActive
    ? roundTo(scheduleAmounts.slice(posted).reduce((s, a) => s + a, 0), dec)
    : 0;
  const remainingTwd = roundTo(remainingAmount * rate, 0);
  const endYm = addMonthsToYm(plan.startYm, Math.max(0, plan.totalInstallments - 1));
  const nextSeq = isActive && posted < plan.totalInstallments ? posted + 1 : null;
  const nextDueYm = nextSeq ? addMonthsToYm(plan.startYm, nextSeq - 1) : null;

  return {
    plan,
    scheduleAmounts,
    firstInstallmentAmount: scheduleAmounts[0] ?? 0,
    regularInstallmentAmount: scheduleAmounts[1] ?? scheduleAmounts[0] ?? 0,
    postedAmount,
    remainingInstallmentsCount,
    remainingAmount,
    remainingTwd,
    endYm,
    nextSeq,
    nextDueYm,
  };
}

/**
 * Computes both the latest closed (billed) statement window and the current open (unbilled) window
 * for a credit card given `billingDay` (1..31), `dueDay` (1..31), and `asOfDateYmd` (`YYYY-MM-DD`).
 */
export function computeBillingCycleWindow(
  billingDay: number,
  dueDay: number,
  asOfDateYmd = todayInTimeZone()
): CreditCardBillingWindow {
  const bDay = Math.min(31, Math.max(1, Math.round(billingDay || 15)));
  const dDay = Math.min(31, Math.max(1, Math.round(dueDay || 1)));
  const [y, m] = asOfDateYmd.split('-').map(Number);

  const closeThisMonth = clampedYmd(y, m, bDay);
  let statementEnd: string;
  let statementStart: string;
  let unbilledStart: string;
  let unbilledEnd: string;

  if (asOfDateYmd <= closeThisMonth) {
    // Still inside the cycle closing on `closeThisMonth`
    const prev = shiftYearMonth(y, m, -1);
    const prev2 = shiftYearMonth(y, m, -2);
    const prevClose = clampedYmd(prev.year, prev.month, bDay);
    const prev2Close = clampedYmd(prev2.year, prev2.month, bDay);
    statementEnd = prevClose;
    statementStart = addDaysYmd(prev2Close, 1);
    unbilledStart = addDaysYmd(prevClose, 1);
    unbilledEnd = closeThisMonth;
  } else {
    // Past `closeThisMonth`: `closeThisMonth` is now the latest closed statement
    const prev = shiftYearMonth(y, m, -1);
    const next = shiftYearMonth(y, m, 1);
    const prevClose = clampedYmd(prev.year, prev.month, bDay);
    const nextClose = clampedYmd(next.year, next.month, bDay);
    statementEnd = closeThisMonth;
    statementStart = addDaysYmd(prevClose, 1);
    unbilledStart = addDaysYmd(closeThisMonth, 1);
    unbilledEnd = nextClose;
  }

  const [seY, seM] = statementEnd.split('-').map(Number);
  const dueYm = dDay > bDay ? { year: seY, month: seM } : shiftYearMonth(seY, seM, 1);
  const paymentDueDate = clampedYmd(dueYm.year, dueYm.month, dDay);

  return {
    statementStart,
    statementEnd,
    paymentDueDate,
    unbilledStart,
    unbilledEnd,
  };
}

export function isCreditCardAsset(item: AssetItem): boolean {
  return Boolean(!item.deletedAt && !item.isWatchlist && item.isCreditCard);
}

function isAfterAnchor(
  recordDate: string,
  recordCreatedAt: string,
  anchorDate?: string | null,
  anchorAt?: string | null
): boolean {
  if (!anchorDate) return true;
  if (recordDate > anchorDate) return true;
  if (recordDate < anchorDate) return false;
  if (!anchorAt) return true;
  return recordCreatedAt >= anchorAt;
}

function isIncomeLog(type: string): boolean {
  return type === CASHFLOW_TYPES.FIXED_INCOME || type === CASHFLOW_TYPES.OTHER_INCOME;
}

export function computeCreditCardSummary(
  card: AssetItem,
  logs: CashFlowLog[],
  adjustments: SavingsAdjustment[],
  installmentPlans: InstallmentPlan[],
  fxSource: FxRateSource,
  asOfDateYmd = todayInTimeZone()
): CreditCardSummary {
  const curr = String(card.currency || 'TWD').toUpperCase();
  const isForeign = curr !== 'TWD';
  const dec = getCurrencyDecimals(curr);
  const rate = resolveFxRate(curr, fxSource);

  const billingDay = card.creditBillingDay ?? 15;
  const dueDay = card.creditDueDay ?? 1;
  const billingWindow = computeBillingCycleWindow(billingDay, dueDay, asOfDateYmd);

  const baseNative = roundTo(Number(card.quantityOrAmount || 0), dec);
  const baseBalanceTwd = Math.round(baseNative * rate);

  let adjustmentsNative = 0;
  let adjustmentsTwd = 0;
  let adjustmentCount = 0;
  for (const adj of adjustments || []) {
    if (adj.deletedAt || adj.accountId !== card.id) continue;
    if (!isAfterAnchor(adj.date, adj.createdAt, card.balanceAnchorDate, card.balanceAnchorAt)) continue;
    if (isForeign) {
      adjustmentsNative += Number(adj.amount) || 0;
    } else {
      adjustmentsTwd += Math.round(adj.twdAmount);
    }
    adjustmentCount += 1;
  }

  let cashflowChargesNative = 0;
  let cashflowChargesTwd = 0;
  let unbilledChargesTwd = 0;
  let billedCycleChargesTwd = 0;
  let linkedLogCount = 0;

  for (const log of logs || []) {
    if (log.deletedAt || log.linkedAccountId !== card.id) continue;
    if (!isAfterAnchor(log.date, log.createdAt, card.balanceAnchorDate, card.balanceAnchorAt)) continue;
    // Expense increases unpaid liability (+1); refund/cashback income reduces liability (-1)
    const sign = isIncomeLog(log.type) ? -1 : 1;
    const twdDelta = sign * Math.round(Number(log.twdAmount) || 0);
    if (isForeign) {
      const native =
        log.currency === curr ? Number(log.amount) || 0 : (Number(log.twdAmount) || 0) / (rate || 1);
      cashflowChargesNative += sign * native;
    } else {
      cashflowChargesTwd += twdDelta;
    }
    if (log.date > billingWindow.statementEnd) {
      unbilledChargesTwd += twdDelta;
    } else if (log.date >= billingWindow.statementStart && log.date <= billingWindow.statementEnd) {
      billedCycleChargesTwd += twdDelta;
    }
    linkedLogCount += 1;
  }

  const currentBalanceNative = isForeign
    ? roundTo(baseNative + adjustmentsNative + cashflowChargesNative, dec)
    : Math.round(baseBalanceTwd + adjustmentsTwd + cashflowChargesTwd);
  const currentBalanceTwd = isForeign
    ? Math.round(currentBalanceNative * rate)
    : currentBalanceNative;

  const billedUnpaidTwd = Math.max(0, Math.round(currentBalanceTwd - Math.max(0, unbilledChargesTwd)));

  // Active installment plans linked to this card
  let activeInstallmentCount = 0;
  let remainingInstallmentsNative = 0;
  let remainingInstallmentsTwd = 0;
  for (const plan of installmentPlans || []) {
    if (plan.deletedAt || plan.status !== 'active' || plan.cardAccountId !== card.id) continue;
    const prog = computeInstallmentPlanProgress(plan, fxSource);
    if (prog.remainingInstallmentsCount <= 0) continue;
    activeInstallmentCount += 1;
    remainingInstallmentsTwd += prog.remainingTwd;
    remainingInstallmentsNative +=
      (plan.currency || 'TWD') === curr
        ? prog.remainingAmount
        : roundTo(prog.remainingTwd / (rate || 1), dec);
  }
  remainingInstallmentsNative = roundTo(remainingInstallmentsNative, dec);
  remainingInstallmentsTwd = Math.round(remainingInstallmentsTwd);

  const totalExposureTwd = Math.max(0, currentBalanceTwd) + remainingInstallmentsTwd;
  const creditLimit =
    card.creditLimit !== undefined && card.creditLimit !== null && Number(card.creditLimit) > 0
      ? Number(card.creditLimit)
      : null;
  const creditLimitTwd = creditLimit !== null ? Math.round(creditLimit * rate) : null;
  const utilizationPct =
    creditLimitTwd !== null && creditLimitTwd > 0
      ? Math.round((totalExposureTwd / creditLimitTwd) * 1000) / 10
      : null;

  return {
    card,
    baseBalanceTwd,
    adjustmentsTotalTwd: isForeign ? Math.round(adjustmentsNative * rate) : Math.round(adjustmentsTwd),
    cashflowChargesTwd: isForeign ? Math.round(cashflowChargesNative * rate) : Math.round(cashflowChargesTwd),
    currentBalanceNative,
    currentBalanceTwd,
    unbilledChargesTwd: Math.round(unbilledChargesTwd),
    billedCycleChargesTwd: Math.round(billedCycleChargesTwd),
    billedUnpaidTwd,
    activeInstallmentCount,
    remainingInstallmentsNative,
    remainingInstallmentsTwd,
    totalExposureTwd,
    creditLimit,
    creditLimitTwd,
    utilizationPct,
    linkedLogCount,
    adjustmentCount,
    billingWindow,
  };
}

export function computeAllCreditCardsSummary(
  assets: AssetItem[],
  logs: CashFlowLog[],
  adjustments: SavingsAdjustment[],
  installmentPlans: InstallmentPlan[],
  fxSource: FxRateSource,
  ledgerId?: string,
  asOfDateYmd = todayInTimeZone()
): AllCreditCardsSummary {
  const cards = (assets || [])
    .filter((a) => {
      if (!isCreditCardAsset(a)) return false;
      if (ledgerId && ledgerId !== 'all' && ledgerId !== 'net_worth') {
        return (a.ledgerId || 'default') === ledgerId;
      }
      return true;
    })
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt.localeCompare(b.createdAt))
    .map((card) =>
      computeCreditCardSummary(card, logs, adjustments, installmentPlans, fxSource, asOfDateYmd)
    );

  const totalUnpaidTwd = Math.round(
    cards.reduce((sum, c) => sum + Math.max(0, c.currentBalanceTwd), 0)
  );
  const totalRemainingInstallmentsTwd = Math.round(
    cards.reduce((sum, c) => sum + c.remainingInstallmentsTwd, 0)
  );
  const totalExposureTwd = totalUnpaidTwd + totalRemainingInstallmentsTwd;

  return {
    cards,
    totalUnpaidTwd,
    totalRemainingInstallmentsTwd,
    totalExposureTwd,
  };
}

/**
 * v1.15.0 review finding 3: default amount of a card bill payment. The amount is entered in the PAYING account's
 * currency (payCreditCardBill debits it in that currency and converts it to the card's currency for the credit).
 * Due = the statement's billed unpaid amount, or the whole unpaid balance when nothing is billed — in the card's
 * currency — converted to the paying account's currency at the current rates.
 * Returns the paying-currency amount and the card-currency amount it settles (0 when nothing is due).
 */
export function computeDefaultCardPayment(
  summary: Pick<CreditCardSummary, 'billedUnpaidTwd' | 'currentBalanceNative'>,
  cardCurrency: string,
  payingCurrency: string,
  fxSource: FxRateSource
): { payAmount: number; cardCreditAmount: number } {
  const cardCurr = String(cardCurrency || 'TWD').toUpperCase();
  const payCurr = String(payingCurrency || 'TWD').toUpperCase();
  const cardDec = getCurrencyDecimals(cardCurr);
  const cardRate = resolveFxRate(cardCurr, fxSource);
  const unpaidNative = Math.max(0, Number(summary.currentBalanceNative) || 0);
  const billedTwd = Math.max(0, Number(summary.billedUnpaidTwd) || 0);
  const dueNative =
    billedTwd > 0
      ? cardCurr === 'TWD'
        ? Math.min(unpaidNative, billedTwd)
        : Math.min(unpaidNative, roundTo(billedTwd / (cardRate || 1), cardDec))
      : unpaidNative;
  if (dueNative <= 0) return { payAmount: 0, cardCreditAmount: 0 };
  if (payCurr === cardCurr) return { payAmount: roundTo(dueNative, cardDec), cardCreditAmount: roundTo(dueNative, cardDec) };
  const payRate = resolveFxRate(payCurr, fxSource);
  return {
    payAmount: roundTo((dueNative * cardRate) / (payRate || 1), getCurrencyDecimals(payCurr)),
    cardCreditAmount: roundTo(dueNative, cardDec),
  };
}
