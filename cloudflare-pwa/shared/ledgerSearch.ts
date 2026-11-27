import { filterCashFlowsByLedgerScope, isCashFlowIncome } from './calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from './constants';
import { previousYearMonth, todayInTimeZone } from './dates';
import { roundTo } from './format';
import type { CashFlowLog, Ledger } from './types';

export type LedgerDatePreset = 'month' | '3m' | 'year' | 'all' | 'custom';

export interface LedgerSearchFilter {
  query: string;
  datePreset: LedgerDatePreset;
  anchorYm?: string;
  dateFrom?: string;
  dateTo?: string;
  types?: string[];
  category?: string;
  /** Empty = all; '__none__' = unlinked (linkedAccountId null/empty); otherwise specific asset id */
  linkedAccountId?: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  ledgerScope: 'net_worth' | 'all' | string;
}

export interface LedgerSearchSummary {
  count: number;
  totalIncome: number;
  totalExpense: number;
  totalInvestment: number;
  totalOutflow: number;
  netCashFlow: number;
  savingsTotal: number;
  hasActiveFilter: boolean;
  effectiveDateRange: { from: string | null; to: string | null };
  swappedDateRange: boolean;
}

export interface LedgerSearchResult {
  items: CashFlowLog[];
  summary: LedgerSearchSummary;
  tokens: string[];
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const YM_RE = /^\d{4}-\d{2}$/;

function lastDayOfMonthYmd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(lastDay).padStart(2, '0')}`;
}

export function tokenizeSearchQuery(query: string): string[] {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s\u3000]+/)) {
    const token = part.trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function resolveDatePresetRange(
  preset: LedgerDatePreset,
  anchorYm?: string,
  customFrom?: string,
  customTo?: string
): { from: string | null; to: string | null; swapped: boolean } {
  const safeYm = anchorYm && YM_RE.test(anchorYm.trim()) ? anchorYm.trim() : todayInTimeZone().slice(0, 7);

  if (preset === 'all') {
    return { from: null, to: null, swapped: false };
  }
  if (preset === 'month') {
    return {
      from: `${safeYm}-01`,
      to: lastDayOfMonthYmd(safeYm),
      swapped: false,
    };
  }
  if (preset === '3m') {
    const startYm = previousYearMonth(previousYearMonth(safeYm));
    return {
      from: `${startYm}-01`,
      to: lastDayOfMonthYmd(safeYm),
      swapped: false,
    };
  }
  if (preset === 'year') {
    const year = safeYm.slice(0, 4);
    return {
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      swapped: false,
    };
  }

  // custom
  const rawFrom = String(customFrom ?? '').trim();
  const rawTo = String(customTo ?? '').trim();
  const from = YMD_RE.test(rawFrom) ? rawFrom : null;
  const to = YMD_RE.test(rawTo) ? rawTo : null;
  if (from && to && from > to) {
    return { from: to, to: from, swapped: true };
  }
  return { from, to, swapped: false };
}

function isFiniteAmount(val: number | null | undefined): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

export function isLedgerSearchActive(
  filter: LedgerSearchFilter,
  activeLedgerId: string = DEFAULT_LEDGER_ID
): boolean {
  if (tokenizeSearchQuery(filter.query).length > 0) return true;
  if (filter.datePreset !== 'month') return true;
  if (filter.types && filter.types.length > 0) return true;
  if (String(filter.category ?? '').trim() !== '') return true;
  if (String(filter.linkedAccountId ?? '').trim() !== '') return true;
  if (isFiniteAmount(filter.minAmount)) return true;
  if (isFiniteAmount(filter.maxAmount)) return true;
  const scope = String(filter.ledgerScope || activeLedgerId).trim() || activeLedgerId;
  if (scope !== activeLedgerId) return true;
  return false;
}

export function searchCashFlowLogs(
  logs: CashFlowLog[],
  filter: LedgerSearchFilter,
  ledgers?: Ledger[] | null,
  activeLedgerId: string = DEFAULT_LEDGER_ID
): LedgerSearchResult {
  const scope = String(filter.ledgerScope || activeLedgerId).trim() || activeLedgerId;
  const scoped = filterCashFlowsByLedgerScope(logs, scope, ledgers);
  const tokens = tokenizeSearchQuery(filter.query);
  const { from, to, swapped } = resolveDatePresetRange(
    filter.datePreset,
    filter.anchorYm,
    filter.dateFrom,
    filter.dateTo
  );

  const typeSet = filter.types && filter.types.length > 0 ? new Set(filter.types) : null;
  const category = String(filter.category ?? '').trim();
  const linkedAccountId = String(filter.linkedAccountId ?? '').trim();

  let minAmt = isFiniteAmount(filter.minAmount) ? filter.minAmount : null;
  let maxAmt = isFiniteAmount(filter.maxAmount) ? filter.maxAmount : null;
  if (minAmt !== null && maxAmt !== null && minAmt > maxAmt) {
    const tmp = minAmt;
    minAmt = maxAmt;
    maxAmt = tmp;
  }

  const matched: CashFlowLog[] = [];
  for (const item of scoped) {
    if (from && item.date < from) continue;
    if (to && item.date > to) continue;
    if (typeSet && !typeSet.has(item.type)) continue;
    if (category && item.category !== category) continue;
    if (linkedAccountId) {
      if (linkedAccountId === '__none__') {
        if (item.linkedAccountId) continue;
      } else if (item.linkedAccountId !== linkedAccountId) {
        continue;
      }
    }
    const amt = Number(item.twdAmount || 0);
    if (minAmt !== null && amt < minAmt) continue;
    if (maxAmt !== null && amt > maxAmt) continue;

    if (tokens.length > 0) {
      const haystack = `${item.itemName}\n${item.note}\n${item.category}\n${item.type}\n${item.date}`.toLowerCase();
      let allMatch = true;
      for (const tok of tokens) {
        if (!haystack.includes(tok)) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;
    }

    matched.push(item);
  }

  matched.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return b.id.localeCompare(a.id);
  });

  let rawIncome = 0;
  let rawExpense = 0;
  let rawInvestment = 0;
  for (const item of matched) {
    const amt = Number(item.twdAmount || 0);
    if (isCashFlowIncome(item.type)) {
      rawIncome += amt;
    } else if (item.type === CASHFLOW_TYPES.INVESTMENT) {
      rawInvestment += amt;
    } else {
      rawExpense += amt;
    }
  }

  const totalIncome = roundTo(rawIncome, 0);
  const totalExpense = roundTo(rawExpense, 0);
  const totalInvestment = roundTo(rawInvestment, 0);
  const totalOutflow = roundTo(rawExpense + rawInvestment, 0);
  const netCashFlow = roundTo(rawIncome - rawExpense - rawInvestment, 0);
  const savingsTotal = roundTo(rawIncome - rawExpense, 0);

  return {
    items: matched,
    tokens,
    summary: {
      count: matched.length,
      totalIncome,
      totalExpense,
      totalInvestment,
      totalOutflow,
      netCashFlow,
      savingsTotal,
      hasActiveFilter: isLedgerSearchActive(filter, activeLedgerId),
      effectiveDateRange: { from, to },
      swappedDateRange: swapped,
    },
  };
}

export function collectAvailableCategories(
  logs: CashFlowLog[],
  ledgerScope: 'net_worth' | 'all' | string,
  ledgers?: Ledger[] | null
): string[] {
  const scoped = filterCashFlowsByLedgerScope(logs, ledgerScope, ledgers);
  const set = new Set<string>();
  for (const item of scoped) {
    const c = String(item.category || '').trim();
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

/**
 * Splits `text` into literal matched/unmatched segments for XSS-safe highlighting via DOM `textContent`
 * (zero RegExp, zero HTML concatenation).
 */
export function splitHighlightSegments(text: string, tokens: string[]): HighlightSegment[] {
  const src = String(text ?? '');
  if (!src || !tokens.length) {
    return src ? [{ text: src, match: false }] : [];
  }

  const lower = src.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const rawTok of tokens) {
    const tok = rawTok.toLowerCase();
    if (!tok) continue;
    let pos = 0;
    while (pos < lower.length) {
      const idx = lower.indexOf(tok, pos);
      if (idx === -1) break;
      ranges.push([idx, idx + tok.length]);
      pos = idx + tok.length;
    }
  }

  if (!ranges.length) {
    return [{ text: src, match: false }];
  }

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const last = merged[merged.length - 1];
    if (start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      out.push({ text: src.slice(cursor, start), match: false });
    }
    out.push({ text: src.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < src.length) {
    out.push({ text: src.slice(cursor), match: false });
  }
  return out;
}
