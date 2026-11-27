import {
  aggregatePeriodMetrics,
  computeAssetEffectiveTwdValue,
  computeNetWorthSummary,
  filterCashFlowsByLedgerScope,
} from './calculations';
import { resolveFxRate, type FxRateSource } from './currency';
import { todayInTimeZone } from './dates';
import { roundTo } from './format';
import type {
  AssetItem,
  CashFlowLog,
  FinancialGoal,
  Ledger,
  SavingsAdjustment,
  StockTransaction,
} from './types';

export const GOAL_MAX_PROJECTION_MONTHS = 1200; // 100 years safety cap

export interface TrailingMonthlyMetrics {
  monthsCount: number;
  avgMonthlyIncomeTwd: number;
  avgMonthlyConsumptionTwd: number;
  avgMonthlySavingsTwd: number;
  annualizedConsumptionTwd: number;
}

export interface GoalProjectionResult {
  status: 'achieved' | 'projected' | 'unreachable';
  months: number | null;
}

export interface FinancialGoalProgress {
  goal: FinancialGoal;
  targetAmountTwd: number;
  currentAmountTwd: number;
  remainingTwd: number;
  progressPct: number;
  monthlyContributionTwd: number;
  isAutoContribution: boolean;
  projectionStatus: 'achieved' | 'projected' | 'unreachable';
  monthsToTarget: number | null;
  estimatedAchieveYm: string | null;
  targetDateMonthsRemaining: number | null;
  requiredMonthlyTwd: number | null;
  isOnTrack: boolean | null;
  suggestedFireTargetTwd: number | null;
  missingReferenceWarning: string | null;
}

export interface GoalEvaluationContext {
  assetItems: AssetItem[];
  cashflowLogs: CashFlowLog[];
  savingsAdjustments: SavingsAdjustment[];
  stockTransactions: StockTransaction[];
  ledgers: Ledger[];
  fxSource: FxRateSource;
  referenceDateYmd?: string;
}

function parseYmIndex(ym: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return y * 12 + (mo - 1);
}

export function addMonthsToYearMonth(baseYm: string, addMonths: number): string | null {
  const idx = parseYmIndex(baseYm);
  if (idx === null || !Number.isFinite(addMonths)) return null;
  const next = idx + Math.max(0, Math.round(addMonths));
  const y = Math.floor(next / 12);
  const mo = (next % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`;
}

export function monthsBetweenYearMonths(fromYm: string, toYm: string): number | null {
  const a = parseYmIndex(fromYm);
  const b = parseYmIndex(toYm);
  if (a === null || b === null) return null;
  return b - a;
}

/**
 * Estimates trailing 12-month average monthly savings & consumption across net-worth-included ledgers.
 */
export function estimateTrailingMonthlyMetrics(
  cashflowLogs: CashFlowLog[],
  ledgers: Ledger[],
  referenceDateYmd?: string
): TrailingMonthlyMetrics {
  const refYmd = (referenceDateYmd || todayInTimeZone()).trim();
  const refYm = refYmd.slice(0, 7);
  const refIdx = parseYmIndex(refYm);
  const scopedLogs = filterCashFlowsByLedgerScope(cashflowLogs || [], 'net_worth', ledgers || []);

  const validLogs = scopedLogs.filter((l) => {
    if (!l || l.deletedAt || !l.yearMonth) return false;
    if (refIdx === null) return true;
    const lIdx = parseYmIndex(l.yearMonth);
    return lIdx !== null && lIdx <= refIdx && lIdx > refIdx - 12;
  });

  const distinctYms = new Set(validLogs.map((l) => l.yearMonth));
  const monthsCount = distinctYms.size;
  if (monthsCount === 0) {
    return {
      monthsCount: 0,
      avgMonthlyIncomeTwd: 0,
      avgMonthlyConsumptionTwd: 0,
      avgMonthlySavingsTwd: 0,
      annualizedConsumptionTwd: 0,
    };
  }

  const metrics = aggregatePeriodMetrics(validLogs, 0, false);
  const avgMonthlyIncomeTwd = roundTo(metrics.totalIncome / monthsCount, 0);
  const avgMonthlyConsumptionTwd = roundTo(metrics.totalConsumption / monthsCount, 0);
  const avgMonthlySavingsTwd = roundTo((metrics.totalIncome - metrics.totalConsumption) / monthsCount, 0);
  const annualizedConsumptionTwd = roundTo(avgMonthlyConsumptionTwd * 12, 0);

  return {
    monthsCount,
    avgMonthlyIncomeTwd,
    avgMonthlyConsumptionTwd,
    avgMonthlySavingsTwd,
    annualizedConsumptionTwd,
  };
}

/**
 * Computes months needed to reach `targetAmount` from `currentAmount` with `monthlyContribution`
 * and `annualReturnPct` (0..30%), using exact monthly compounding with linear r=0 fallback.
 * Never divides by 0, never produces NaN/Infinity, and caps at `maxMonths` (default 100 years).
 */
export function projectMonthsToTarget(
  currentAmount: number,
  targetAmount: number,
  monthlyContribution: number,
  annualReturnPct: number,
  maxMonths = GOAL_MAX_PROJECTION_MONTHS
): GoalProjectionResult {
  const cur = Number(currentAmount || 0);
  const target = Number(targetAmount || 0);
  const contrib = Number(monthlyContribution || 0);
  const annualPct = Math.max(0, Number(annualReturnPct || 0));

  if (!Number.isFinite(cur) || !Number.isFinite(target) || target <= 0) {
    return { status: 'unreachable', months: null };
  }
  if (cur >= target) {
    return { status: 'achieved', months: 0 };
  }

  const monthlyRate = annualPct / 100 / 12;
  if (monthlyRate <= 0) {
    if (!Number.isFinite(contrib) || contrib <= 0) {
      return { status: 'unreachable', months: null };
    }
    const months = Math.ceil((target - cur) / contrib);
    if (!Number.isFinite(months) || months > maxMonths) {
      return { status: 'unreachable', months: null };
    }
    return { status: 'projected', months };
  }

  let bal = cur;
  for (let m = 1; m <= maxMonths; m++) {
    const next = bal * (1 + monthlyRate) + contrib;
    if (!Number.isFinite(next)) return { status: 'unreachable', months: null };
    if (next >= target - 1e-6) {
      return { status: 'projected', months: m };
    }
    // If balance is not increasing (e.g. negative starting balance or negative contribution dominates), never reaches target
    if (next <= bal + 1e-9 && next < target) {
      return { status: 'unreachable', months: null };
    }
    bal = next;
  }

  return { status: 'unreachable', months: null };
}

/**
 * Computes the required monthly contribution to reach `targetAmount` in `monthsRemaining` months
 * given `currentAmount` and `annualReturnPct`. Returns null if `monthsRemaining <= 0`.
 */
export function computeRequiredMonthlyContribution(
  currentAmount: number,
  targetAmount: number,
  monthsRemaining: number,
  annualReturnPct: number
): number | null {
  const cur = Number(currentAmount || 0);
  const target = Number(targetAmount || 0);
  const n = Math.floor(Number(monthsRemaining));
  const annualPct = Math.max(0, Number(annualReturnPct || 0));

  if (!Number.isFinite(cur) || !Number.isFinite(target) || target <= 0) return null;
  if (cur >= target) return 0;
  if (!Number.isFinite(n) || n <= 0) return null;

  const r = annualPct / 100 / 12;
  if (r <= 0) {
    return Math.max(0, Math.ceil((target - cur) / n));
  }

  const compoundFactor = Math.pow(1 + r, n);
  if (!Number.isFinite(compoundFactor) || compoundFactor <= 1) {
    return Math.max(0, Math.ceil((target - cur) / n));
  }
  const fvCurrent = cur * compoundFactor;
  const gap = target - fvCurrent;
  if (gap <= 0) return 0;
  const pmt = (gap * r) / (compoundFactor - 1);
  return Number.isFinite(pmt) ? Math.max(0, Math.ceil(pmt)) : null;
}

/**
 * Computes suggested FIRE target amount in TWD using the Safe Withdrawal Rate rule (e.g. 4% -> 25x annual expenses).
 */
export function computeSuggestedFireTargetTwd(
  annualizedConsumptionTwd: number,
  fireSwrPct = 4
): number | null {
  const annual = Number(annualizedConsumptionTwd || 0);
  const swr = Number(fireSwrPct || 4);
  if (!Number.isFinite(annual) || annual <= 0 || !Number.isFinite(swr) || swr <= 0) {
    return null;
  }
  return roundTo(annual / (swr / 100), 0);
}

/**
 * Evaluates a single financial goal's current value, progress, estimated achievement date, and required monthly savings.
 */
export function evaluateFinancialGoal(
  goal: FinancialGoal,
  ctx: GoalEvaluationContext,
  cachedTrailing?: TrailingMonthlyMetrics
): FinancialGoalProgress {
  const refYmd = (ctx.referenceDateYmd || todayInTimeZone()).trim();
  const refYm = refYmd.slice(0, 7);
  const trailing =
    cachedTrailing || estimateTrailingMonthlyMetrics(ctx.cashflowLogs, ctx.ledgers, refYmd);

  const fxRate = resolveFxRate(goal.currency || 'TWD', ctx.fxSource);
  const targetAmountTwd = roundTo(Number(goal.targetAmount || 0) * fxRate, 0);

  let currentAmountTwd = 0;
  let missingReferenceWarning: string | null = null;

  if (goal.goalType === 'net_worth' || goal.goalType === 'fire') {
    const nw = computeNetWorthSummary(
      ctx.assetItems,
      ctx.fxSource,
      0,
      ctx.cashflowLogs,
      ctx.savingsAdjustments,
      ctx.stockTransactions,
      undefined,
      ctx.ledgers,
      'net_worth'
    );
    currentAmountTwd = roundTo(nw.netWorth, 0);
  } else if (goal.goalType === 'ledger_bucket') {
    const lid = String(goal.linkedLedgerId || '').trim();
    const activeLedgers = (ctx.ledgers || []).filter((l) => !l.deletedAt);
    const ledgerExists = lid === 'default' || activeLedgers.some((l) => l.id === lid);
    if (!lid || !ledgerExists) {
      currentAmountTwd = 0;
      missingReferenceWarning = '綁定的帳本不存在或已刪除，請編輯目標重新選擇。';
    } else {
      const nw = computeNetWorthSummary(
        ctx.assetItems,
        ctx.fxSource,
        0,
        ctx.cashflowLogs,
        ctx.savingsAdjustments,
        ctx.stockTransactions,
        undefined,
        ctx.ledgers,
        lid
      );
      currentAmountTwd = roundTo(nw.netWorth, 0);
    }
  } else if (goal.goalType === 'asset_bucket') {
    const activeAssetById = new Map<string, AssetItem>();
    for (const a of ctx.assetItems || []) {
      if (!a || a.deletedAt || a.isWatchlist) continue;
      activeAssetById.set(a.id, a);
    }
    let sum = 0;
    let missingCount = 0;
    for (const aid of goal.linkedAssetIds || []) {
      const asset = activeAssetById.get(aid);
      if (!asset) {
        missingCount += 1;
        continue;
      }
      const val = computeAssetEffectiveTwdValue(
        asset,
        ctx.fxSource,
        ctx.cashflowLogs,
        ctx.savingsAdjustments,
        ctx.stockTransactions
      );
      sum += asset.majorType === '負債' ? -val : val;
    }
    currentAmountTwd = roundTo(sum, 0);
    if (missingCount > 0) {
      missingReferenceWarning = `有 ${missingCount} 筆綁定資產已刪除或不存在，已自動略過。`;
    }
  } else {
    // manual
    currentAmountTwd = roundTo(Number(goal.currentManualAmount || 0) * fxRate, 0);
  }

  const remainingTwd = Math.max(0, roundTo(targetAmountTwd - currentAmountTwd, 0));
  const rawPct = targetAmountTwd > 0 ? (currentAmountTwd / targetAmountTwd) * 100 : 0;
  const progressPct = roundTo(Math.max(0, Math.min(100, rawPct)), 1);

  const isAutoContribution =
    goal.monthlyContributionOverride === null || goal.monthlyContributionOverride === undefined;
  const monthlyContributionTwd = isAutoContribution
    ? trailing.avgMonthlySavingsTwd
    : roundTo(Number(goal.monthlyContributionOverride || 0) * fxRate, 0);

  const proj = projectMonthsToTarget(
    currentAmountTwd,
    targetAmountTwd,
    monthlyContributionTwd,
    goal.expectedAnnualReturnPct || 0
  );
  const estimatedAchieveYm =
    proj.status === 'achieved'
      ? refYm
      : proj.status === 'projected' && proj.months !== null
        ? addMonthsToYearMonth(refYm, proj.months)
        : null;

  const targetDateMonthsRemaining = goal.targetDate
    ? monthsBetweenYearMonths(refYm, goal.targetDate)
    : null;
  const requiredMonthlyTwd =
    targetDateMonthsRemaining !== null
      ? computeRequiredMonthlyContribution(
          currentAmountTwd,
          targetAmountTwd,
          targetDateMonthsRemaining,
          goal.expectedAnnualReturnPct || 0
        )
      : null;

  let isOnTrack: boolean | null = null;
  if (goal.targetDate) {
    if (proj.status === 'achieved') {
      isOnTrack = true;
    } else if (requiredMonthlyTwd !== null) {
      isOnTrack = monthlyContributionTwd >= requiredMonthlyTwd;
    } else {
      isOnTrack = false;
    }
  }

  const suggestedFireTargetTwd =
    goal.goalType === 'fire'
      ? computeSuggestedFireTargetTwd(trailing.annualizedConsumptionTwd, goal.fireSwrPct ?? 4)
      : null;

  return {
    goal,
    targetAmountTwd,
    currentAmountTwd,
    remainingTwd,
    progressPct,
    monthlyContributionTwd,
    isAutoContribution,
    projectionStatus: proj.status,
    monthsToTarget: proj.months,
    estimatedAchieveYm,
    targetDateMonthsRemaining,
    requiredMonthlyTwd,
    isOnTrack,
    suggestedFireTargetTwd,
    missingReferenceWarning,
  };
}
