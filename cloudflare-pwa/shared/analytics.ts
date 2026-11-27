import { STOCK_TX_TYPES } from './constants';
import { resolveFxRate, type FxRateSource } from './currency';
import { roundTo } from './format';
import type {
  AssetItem,
  NetWorthHistory,
  RebalanceTargetKind,
  RebalanceTargetRule,
  StockPortfolioSummary,
  StockTransaction,
} from './types';

export interface NetWorthTrendPoint {
  yearMonth: string;
  snapshotDate: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  highLiquidityAssets: number;
  investmentAssets: number;
  insuranceAssets: number;
  otherAssets: number;
  savingsRate: number;
}

export interface NetWorthTrendSummary {
  points: NetWorthTrendPoint[];
  startNetWorth: number;
  endNetWorth: number;
  deltaAmount: number;
  deltaPct: number | null;
  minNetWorth: number;
  maxNetWorth: number;
  maxTotalAssets: number;
}

export function computeNetWorthTrendSeries(
  history: NetWorthHistory[],
  range: '12m' | 'all' = '12m'
): NetWorthTrendSummary {
  const byYm = new Map<string, NetWorthHistory>();
  for (const h of history || []) {
    if (!h || !h.yearMonth) continue;
    const prev = byYm.get(h.yearMonth);
    if (!prev || String(h.updatedAt || '') >= String(prev.updatedAt || '')) {
      byYm.set(h.yearMonth, h);
    }
  }

  const sorted = Array.from(byYm.values()).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  const sliced = range === '12m' && sorted.length > 12 ? sorted.slice(sorted.length - 12) : sorted;

  const points: NetWorthTrendPoint[] = sliced.map((h) => {
    const totalAssets = roundTo(Number(h.totalAssets || 0), 0);
    const totalLiabilities = roundTo(Number(h.totalLiabilities || 0), 0);
    const netWorth = roundTo(Number(h.netWorth ?? totalAssets - totalLiabilities), 0);
    const highLiquidityAssets = Math.max(0, roundTo(Number(h.highLiquidityAssets || 0), 0));
    const investmentAssets = Math.max(0, roundTo(Number(h.investmentAssets || 0), 0));
    const insuranceAssets = Math.max(0, roundTo(Number(h.insuranceAssets || 0), 0));
    const otherAssets = Math.max(
      0,
      roundTo(totalAssets - highLiquidityAssets - investmentAssets - insuranceAssets, 0)
    );
    return {
      yearMonth: h.yearMonth,
      snapshotDate: h.snapshotDate || `${h.yearMonth}-28`,
      totalAssets,
      totalLiabilities,
      netWorth,
      highLiquidityAssets,
      investmentAssets,
      insuranceAssets,
      otherAssets,
      savingsRate: Number.isFinite(Number(h.savingsRate)) ? Number(h.savingsRate) : 0,
    };
  });

  if (!points.length) {
    return {
      points: [],
      startNetWorth: 0,
      endNetWorth: 0,
      deltaAmount: 0,
      deltaPct: null,
      minNetWorth: 0,
      maxNetWorth: 0,
      maxTotalAssets: 0,
    };
  }

  const startNetWorth = points[0].netWorth;
  const endNetWorth = points[points.length - 1].netWorth;
  const deltaAmount = roundTo(endNetWorth - startNetWorth, 0);
  const deltaPct =
    points.length >= 2 && startNetWorth > 0 ? roundTo((deltaAmount / startNetWorth) * 100, 1) : null;

  let minNetWorth = points[0].netWorth;
  let maxNetWorth = points[0].netWorth;
  let maxTotalAssets = points[0].totalAssets;
  for (const p of points) {
    if (p.netWorth < minNetWorth) minNetWorth = p.netWorth;
    if (p.netWorth > maxNetWorth) maxNetWorth = p.netWorth;
    if (p.totalAssets > maxTotalAssets) maxTotalAssets = p.totalAssets;
  }

  return {
    points,
    startNetWorth,
    endNetWorth,
    deltaAmount,
    deltaPct,
    minNetWorth,
    maxNetWorth,
    maxTotalAssets,
  };
}

export interface DividendDetailItem {
  txId: string;
  assetId: string;
  assetName: string;
  ticker: string;
  date: string;
  currency: string;
  rawAmount: number;
  twdAmount: number;
  note: string;
}

export interface DividendMonthBucket {
  month: number; // 1..12
  yearMonth: string;
  totalTwd: number;
  count: number;
  items: DividendDetailItem[];
}

export interface DividendCalendarSummary {
  year: number;
  availableYears: number[];
  months: DividendMonthBucket[];
  annualTotalTwd: number;
  monthlyAverageTwd: number;
  maxMonthTwd: number;
  peakMonth: number | null;
  expenseCoveragePct: number | null;
  txCount: number;
}

export function computeDividendCalendar(
  assets: AssetItem[],
  transactions: StockTransaction[],
  fxSource: FxRateSource,
  year: number,
  monthlyConsumptionTwd?: number
): DividendCalendarSummary {
  const assetById = new Map<string, AssetItem>();
  for (const a of assets || []) {
    if (!a || a.deletedAt || a.isWatchlist) continue;
    assetById.set(a.id, a);
  }

  const yearSet = new Set<number>();
  const months: DividendMonthBucket[] = Array.from({ length: 12 }, (_, idx) => {
    const m = idx + 1;
    return {
      month: m,
      yearMonth: `${year}-${String(m).padStart(2, '0')}`,
      totalTwd: 0,
      count: 0,
      items: [],
    };
  });

  let txCount = 0;
  for (const tx of transactions || []) {
    if (!tx || tx.deletedAt) continue;
    if (tx.txType !== STOCK_TX_TYPES.CASH_DIVIDEND) continue;
    const rawAmount = Number(tx.totalAmount || 0);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue;
    const asset = assetById.get(tx.assetId);
    if (!asset) continue;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(tx.date || '').trim());
    if (!match) continue;
    const txYear = Number(match[1]);
    const txMonth = Number(match[2]);
    if (txMonth < 1 || txMonth > 12) continue;

    yearSet.add(txYear);
    if (txYear !== year) continue;

    const currency = String(asset.currency || 'TWD').toUpperCase();
    const rate = resolveFxRate(currency, fxSource);
    const twdAmount = roundTo(rawAmount * rate, 0);
    const bucket = months[txMonth - 1];
    bucket.items.push({
      txId: tx.id,
      assetId: asset.id,
      assetName: asset.itemName,
      ticker: asset.ticker || '',
      date: tx.date,
      currency,
      rawAmount,
      twdAmount,
      note: tx.note || '',
    });
    bucket.count += 1;
    txCount += 1;
  }

  let annualRaw = 0;
  let maxMonthTwd = 0;
  let peakMonth: number | null = null;
  for (const bucket of months) {
    bucket.items.sort((a, b) => b.date.localeCompare(a.date) || b.twdAmount - a.twdAmount);
    bucket.totalTwd = roundTo(
      bucket.items.reduce((s, it) => s + it.twdAmount, 0),
      0
    );
    annualRaw += bucket.totalTwd;
    if (bucket.totalTwd > maxMonthTwd) {
      maxMonthTwd = bucket.totalTwd;
      peakMonth = bucket.month;
    }
  }

  const annualTotalTwd = roundTo(annualRaw, 0);
  const monthlyAverageTwd = roundTo(annualTotalTwd / 12, 0);
  const cons = Number(monthlyConsumptionTwd || 0);
  const expenseCoveragePct =
    Number.isFinite(cons) && cons > 0 ? roundTo((monthlyAverageTwd / cons) * 100, 1) : null;

  yearSet.add(year);
  const availableYears = Array.from(yearSet).sort((a, b) => b - a);

  return {
    year,
    availableYears,
    months,
    annualTotalTwd,
    monthlyAverageTwd,
    maxMonthTwd,
    peakMonth,
    expenseCoveragePct,
    txCount,
  };
}

export type RebalanceMode = 'buy_only' | 'full';

export interface RebalanceRow {
  key: string;
  label: string;
  currentValueTwd: number;
  currentPct: number;
  targetPct: number;
  driftPct: number;
  targetValueAfterTwd: number;
  actionTwd: number;
  postValueTwd: number;
  postPct: number;
  isUntargeted: boolean;
}

export interface RebalancePlan {
  mode: RebalanceMode;
  kind: RebalanceTargetKind;
  currentTotalTwd: number;
  newContributionTwd: number;
  projectedTotalTwd: number;
  targetPctSum: number;
  isValidTargets: boolean;
  rows: RebalanceRow[];
  totalBuyTwd: number;
  totalSellTwd: number;
}

/**
 * Largest-remainder integer allocation: rounds `ideals` to integers whose exact sum equals `targetSum`.
 * Preserves sign constraints when all ideals >= 0.
 */
function roundToExactSum(ideals: number[], targetSum: number): number[] {
  const targetInt = roundTo(targetSum, 0);
  const floors = ideals.map((v) => Math.floor(v));
  const fracs = ideals.map((v, i) => ({ i, frac: v - floors[i] }));
  let diff = targetInt - floors.reduce((s, x) => s + x, 0);
  if (diff > 0) {
    fracs.sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < diff && k < fracs.length; k++) {
      floors[fracs[k].i] += 1;
    }
  } else if (diff < 0) {
    fracs.sort((a, b) => a.frac - b.frac || a.i - b.i);
    for (let k = 0; k < -diff && k < fracs.length; k++) {
      floors[fracs[k].i] -= 1;
    }
  }
  return floors.map((v) => (Object.is(v, -0) ? 0 : v));
}

export function computeRebalancePlan(
  portfolio: StockPortfolioSummary,
  rules: RebalanceTargetRule[],
  kind: RebalanceTargetKind,
  newContributionTwd: number,
  mode: RebalanceMode = 'buy_only'
): RebalancePlan {
  const contribution = Math.max(0, roundTo(Number(newContributionTwd || 0), 0));
  const kindRules = (rules || []).filter((r) => r.kind === kind);
  const targetPctSum = roundTo(
    kindRules.reduce((s, r) => s + Number(r.targetPct || 0), 0),
    2
  );
  const isValidTargets = kindRules.length > 0 && Math.abs(targetPctSum - 100) <= 0.01;

  // Aggregate current holdings by key
  const buckets = new Map<
    string,
    { key: string; label: string; currentValueTwd: number; targetPct: number; isUntargeted: boolean }
  >();

  for (const r of kindRules) {
    buckets.set(r.key, {
      key: r.key,
      label: r.label || r.key,
      currentValueTwd: 0,
      targetPct: roundTo(Number(r.targetPct || 0), 2),
      isUntargeted: false,
    });
  }

  for (const pos of portfolio?.positions || []) {
    const val = Math.max(0, roundTo(Number(pos.marketValueTwd || 0), 0));
    const key =
      kind === 'category'
        ? String(pos.asset.stockCategory || '').trim() || '未分類'
        : pos.asset.id;
    const defaultLabel =
      kind === 'category'
        ? key
        : pos.asset.ticker
          ? `${pos.asset.itemName} (${pos.asset.ticker})`
          : pos.asset.itemName;

    // For ticker mode, also match if rule key equals ticker code
    let resolvedKey = key;
    if (kind === 'ticker' && !buckets.has(key) && pos.asset.ticker) {
      const upperTicker = pos.asset.ticker.trim().toUpperCase();
      for (const rk of buckets.keys()) {
        if (rk.trim().toUpperCase() === upperTicker) {
          resolvedKey = rk;
          break;
        }
      }
    }

    const existing = buckets.get(resolvedKey);
    if (existing) {
      existing.currentValueTwd = roundTo(existing.currentValueTwd + val, 0);
    } else {
      buckets.set(resolvedKey, {
        key: resolvedKey,
        label: defaultLabel,
        currentValueTwd: val,
        targetPct: 0,
        isUntargeted: true,
      });
    }
  }

  const list = Array.from(buckets.values());
  const currentTotalTwd = roundTo(
    list.reduce((s, b) => s + b.currentValueTwd, 0),
    0
  );
  const projectedTotalTwd = roundTo(currentTotalTwd + contribution, 0);

  let actions: number[] = list.map(() => 0);

  if (isValidTargets) {
    if (mode === 'full') {
      const ideals = list.map((b) => projectedTotalTwd * (b.targetPct / 100) - b.currentValueTwd);
      actions = roundToExactSum(ideals, contribution);
    } else if (contribution > 0) {
      // buy_only water-fill: never sell overweight buckets; distribute 100% of `contribution` to most-underweight targets
      const activeIndices = new Set<number>();
      list.forEach((b, i) => {
        if (b.targetPct > 0) activeIndices.add(i);
      });

      let impliedTotal = 0;
      while (activeIndices.size > 0) {
        let sumCurrent = 0;
        let sumWeight = 0;
        for (const idx of activeIndices) {
          sumCurrent += list[idx].currentValueTwd;
          sumWeight += list[idx].targetPct / 100;
        }
        if (sumWeight <= 0) break;
        impliedTotal = (sumCurrent + contribution) / sumWeight;

        const overweight: number[] = [];
        for (const idx of activeIndices) {
          const desired = impliedTotal * (list[idx].targetPct / 100);
          if (list[idx].currentValueTwd > desired + 1e-9) {
            overweight.push(idx);
          }
        }
        if (overweight.length === 0) break;
        for (const idx of overweight) activeIndices.delete(idx);
      }

      if (activeIndices.size > 0) {
        const activeArr = Array.from(activeIndices);
        const ideals = activeArr.map((idx) =>
          Math.max(0, impliedTotal * (list[idx].targetPct / 100) - list[idx].currentValueTwd)
        );
        const rounded = roundToExactSum(ideals, contribution);
        activeArr.forEach((idx, pos) => {
          actions[idx] = Math.max(0, rounded[pos]);
        });
      }
    }
  }

  let totalBuyTwd = 0;
  let totalSellTwd = 0;
  const rows: RebalanceRow[] = list.map((b, i) => {
    const actionTwd = actions[i] || 0;
    if (actionTwd > 0) totalBuyTwd += actionTwd;
    else if (actionTwd < 0) totalSellTwd += Math.abs(actionTwd);

    const currentPct = currentTotalTwd > 0 ? roundTo((b.currentValueTwd / currentTotalTwd) * 100, 1) : 0;
    const postValueTwd = roundTo(b.currentValueTwd + actionTwd, 0);
    const postPct = projectedTotalTwd > 0 ? roundTo((postValueTwd / projectedTotalTwd) * 100, 1) : 0;
    const targetValueAfterTwd = roundTo(projectedTotalTwd * (b.targetPct / 100), 0);
    const driftPct = roundTo(currentPct - b.targetPct, 1);

    return {
      key: b.key,
      label: b.label,
      currentValueTwd: b.currentValueTwd,
      currentPct,
      targetPct: b.targetPct,
      driftPct,
      targetValueAfterTwd,
      actionTwd,
      postValueTwd,
      postPct,
      isUntargeted: b.isUntargeted,
    };
  });

  rows.sort((a, b) => {
    if (a.isUntargeted !== b.isUntargeted) return a.isUntargeted ? 1 : -1;
    return b.targetPct - a.targetPct || b.currentValueTwd - a.currentValueTwd;
  });

  return {
    mode,
    kind,
    currentTotalTwd,
    newContributionTwd: contribution,
    projectedTotalTwd,
    targetPctSum,
    isValidTargets,
    rows,
    totalBuyTwd: roundTo(totalBuyTwd, 0),
    totalSellTwd: roundTo(totalSellTwd, 0),
  };
}
