import { getCurrencyDecimals, resolveFxRate, type FxRateSource } from './currency';
import { roundTo } from './format';
import type { SplitReceivable } from './types';

export interface SplitReceivableBalanceInfo {
  receivable: SplitReceivable;
  remainingNative: number;
  remainingTwd: number;
  settledTwd: number;
  isOutstanding: boolean;
}

export interface CounterpartySplitSummary {
  counterparty: string;
  outstandingTwd: number;
  openCount: number;
  items: SplitReceivableBalanceInfo[];
}

export interface SplitReceivablesSummary {
  openCount: number;
  partialCount: number;
  settledCount: number;
  writtenOffCount: number;
  totalOutstandingTwd: number;
  byCounterparty: CounterpartySplitSummary[];
  items: SplitReceivableBalanceInfo[];
}

/**
 * Splits `totalAmount` evenly across `headcount` people using currency-appropriate decimals,
 * placing any tiny remainder on the first share (user's share) so the sum is 100% conserved.
 */
export function computeEqualSplitShares(
  totalAmount: number,
  headcount: number,
  currency = 'TWD'
): number[] {
  const total = Number(totalAmount || 0);
  const n = Math.floor(Number(headcount || 0));
  if (!Number.isFinite(total) || total <= 0 || n <= 0) return [];
  const dec = getCurrencyDecimals(currency);
  const factor = Math.pow(10, dec);
  const totalUnits = Math.round(total * factor);
  const baseUnits = Math.floor(totalUnits / n);
  const rem = totalUnits - baseUnits * n;
  return Array.from({ length: n }, (_, idx) => (baseUnits + (idx < rem ? 1 : 0)) / factor);
}

export function computeSplitReceivableBalance(
  rec: SplitReceivable,
  fxSource: FxRateSource
): SplitReceivableBalanceInfo {
  const dec = getCurrencyDecimals(rec.currency || 'TWD');
  const rate =
    rec.currency === 'TWD'
      ? 1
      : Number(rec.fxRate) > 0
        ? Number(rec.fxRate)
        : resolveFxRate(rec.currency || 'TWD', fxSource);
  const isClosed = rec.status === 'settled' || rec.status === 'written_off';
  const remainingNative = isClosed
    ? 0
    : Math.max(0, roundTo(Number(rec.amount || 0) - Number(rec.settledAmount || 0), dec));
  const remainingTwd = roundTo(remainingNative * rate, 0);
  const settledTwd = roundTo(Number(rec.settledAmount || 0) * rate, 0);
  return {
    receivable: rec,
    remainingNative,
    remainingTwd,
    settledTwd,
    isOutstanding: !isClosed && remainingNative > 0,
  };
}

export function computeSplitReceivablesSummary(
  receivables: SplitReceivable[],
  fxSource: FxRateSource,
  ledgerFilterId?: string
): SplitReceivablesSummary {
  const active = (receivables || []).filter((r) => {
    if (!r || r.deletedAt) return false;
    if (ledgerFilterId && ledgerFilterId !== 'all' && ledgerFilterId !== 'net_worth') {
      return (r.ledgerId || 'default') === ledgerFilterId;
    }
    return true;
  });

  const items = active
    .map((r) => computeSplitReceivableBalance(r, fxSource))
    .sort((a, b) => {
      if (a.isOutstanding !== b.isOutstanding) return a.isOutstanding ? -1 : 1;
      return (
        b.receivable.date.localeCompare(a.receivable.date) ||
        b.receivable.createdAt.localeCompare(a.receivable.createdAt)
      );
    });

  let openCount = 0;
  let partialCount = 0;
  let settledCount = 0;
  let writtenOffCount = 0;
  let totalOutstandingTwd = 0;

  const byCpMap = new Map<string, CounterpartySplitSummary>();
  for (const info of items) {
    const st = info.receivable.status;
    if (st === 'open') openCount += 1;
    else if (st === 'partial') partialCount += 1;
    else if (st === 'settled') settledCount += 1;
    else if (st === 'written_off') writtenOffCount += 1;

    if (info.isOutstanding) {
      totalOutstandingTwd += info.remainingTwd;
      const cp = info.receivable.counterparty;
      let grp = byCpMap.get(cp);
      if (!grp) {
        grp = { counterparty: cp, outstandingTwd: 0, openCount: 0, items: [] };
        byCpMap.set(cp, grp);
      }
      grp.outstandingTwd = roundTo(grp.outstandingTwd + info.remainingTwd, 0);
      grp.openCount += 1;
      grp.items.push(info);
    }
  }

  const byCounterparty = Array.from(byCpMap.values()).sort(
    (a, b) => b.outstandingTwd - a.outstandingTwd || a.counterparty.localeCompare(b.counterparty)
  );

  return {
    openCount,
    partialCount,
    settledCount,
    writtenOffCount,
    totalOutstandingTwd: roundTo(totalOutstandingTwd, 0),
    byCounterparty,
    items,
  };
}

export interface MultiCurrencySettlementPreview {
  settledNative: number;
  originalPortionTwd: number;
  estimatedDepositAmount: number;
  actualDepositAmount: number;
  actualDepositTwd: number;
  fxDiffTwd: number;
}

/**
 * Computes settlement deposit preview across same-currency or cross-currency repayments
 * (e.g. advanced JPY in Japan, friend repays TWD into Taiwan savings account).
 */
export function computeSettlementPreview(params: {
  receivable: SplitReceivable;
  settleAmountNative: number;
  depositCurrency: string;
  fxSource: FxRateSource;
  customDepositAmount?: number | null;
}): MultiCurrencySettlementPreview {
  const { receivable, settleAmountNative, depositCurrency, fxSource, customDepositAmount } = params;
  const origCurr = receivable.currency || 'TWD';
  const origDec = getCurrencyDecimals(origCurr);
  const depDec = getCurrencyDecimals(depositCurrency || 'TWD');
  const settledNative = Math.max(0, roundTo(Number(settleAmountNative || 0), origDec));

  const origRate =
    origCurr === 'TWD'
      ? 1
      : Number(receivable.fxRate) > 0
        ? Number(receivable.fxRate)
        : resolveFxRate(origCurr, fxSource);
  const originalPortionTwd = roundTo(settledNative * origRate, 0);

  const curOrigRate = resolveFxRate(origCurr, fxSource);
  const curDepRate = resolveFxRate(depositCurrency || 'TWD', fxSource);
  const estimatedDepositAmount =
    origCurr === depositCurrency
      ? settledNative
      : roundTo((settledNative * curOrigRate) / (curDepRate || 1), depDec);

  const actualDepositAmount =
    customDepositAmount !== undefined && customDepositAmount !== null && Number.isFinite(customDepositAmount) && customDepositAmount > 0
      ? roundTo(customDepositAmount, depDec)
      : estimatedDepositAmount;
  const actualDepositTwd = roundTo(actualDepositAmount * curDepRate, 0);
  const fxDiffTwd = roundTo(actualDepositTwd - originalPortionTwd, 0);

  return {
    settledNative,
    originalPortionTwd,
    estimatedDepositAmount,
    actualDepositAmount,
    actualDepositTwd,
    fxDiffTwd,
  };
}
