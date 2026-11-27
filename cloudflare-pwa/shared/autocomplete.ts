import { getEffectiveLedgerId } from './calculations';
import { DEFAULT_LEDGER_ID } from './constants';
import { todayInTimeZone } from './dates';
import type { AssetItem, CashFlowLog, Ledger, QuickEntryTemplate } from './types';

export interface ResolvedQuickTemplate {
  ledgerId: string;
  linkedAccountId: string | null;
  fallbackLedger: boolean;
  fallbackAccount: boolean;
}

/**
 * Safely resolves a template's ledger & linked savings account against currently active records.
 * If the referenced ledger or account was deleted (or belongs to another ledger), gracefully falls
 * back so submitting never fails server-side referential integrity guards.
 */
export function resolveQuickTemplateForEntry(
  template: QuickEntryTemplate,
  activeLedgerId: string,
  ledgers: Ledger[],
  assets: AssetItem[]
): ResolvedQuickTemplate {
  const activeLedgers = (ledgers || []).filter((l) => !l.deletedAt);
  const desiredLedger = String(template.ledgerId || '').trim() || activeLedgerId || DEFAULT_LEDGER_ID;
  const ledgerExists =
    desiredLedger === DEFAULT_LEDGER_ID || activeLedgers.some((l) => l.id === desiredLedger);

  const ledgerId = ledgerExists ? desiredLedger : activeLedgerId || DEFAULT_LEDGER_ID;
  const fallbackLedger = !ledgerExists;

  const ledgerSavings = (assets || []).filter(
    (a) => !a.deletedAt && a.isLinkedSavings && getEffectiveLedgerId(a) === ledgerId
  );
  const defaultSavingsId =
    ledgerSavings.find((a) => a.isDefaultSavings)?.id ?? ledgerSavings[0]?.id ?? null;

  const desiredAcc = String(template.linkedAccountId || '').trim();
  if (!desiredAcc) {
    return { ledgerId, linkedAccountId: null, fallbackLedger, fallbackAccount: false };
  }

  // v1.15.0 review finding 5: a template bound to a credit card of this ledger keeps charging that card
  const accExists =
    ledgerSavings.some((a) => a.id === desiredAcc) ||
    (assets || []).some(
      (a) => !a.deletedAt && a.isCreditCard && a.id === desiredAcc && getEffectiveLedgerId(a) === ledgerId
    );
  if (accExists) {
    return { ledgerId, linkedAccountId: desiredAcc, fallbackLedger, fallbackAccount: false };
  }

  return {
    ledgerId,
    linkedAccountId: defaultSavingsId,
    fallbackLedger,
    fallbackAccount: true,
  };
}

export interface AutocompleteSuggestion {
  itemName: string;
  category: string;
  type: string;
  suggestedAmount: number;
  currency: string;
  count: number;
  lastDate: string;
  score: number;
}

export interface AutocompleteOptions {
  query: string;
  type?: string;
  activeLedgerId?: string;
  todayYmd?: string;
  limit?: number;
}

function daysBetweenYmd(olderYmd: string, newerYmd: string): number {
  const a = Date.parse(`${olderYmd}T00:00:00Z`);
  const b = Date.parse(`${newerYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 365;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Ranks past itemName entries by frequency + recency decay + active ledger/type affinity.
 * Uses plain lowercased substring checks (zero RegExp → ReDoS-proof).
 */
export function buildAutocompleteSuggestions(
  logs: CashFlowLog[],
  opts: AutocompleteOptions
): AutocompleteSuggestion[] {
  const q = String(opts.query ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const todayYmd = opts.todayYmd || todayInTimeZone();
  const activeLedgerId = opts.activeLedgerId || DEFAULT_LEDGER_ID;

  interface Bucket {
    itemName: string;
    lastDate: string;
    lastCreatedAt: string;
    suggestedAmount: number;
    currency: string;
    type: string;
    count: number;
    score: number;
    categoryCounts: Map<string, number>;
  }

  const buckets = new Map<string, Bucket>();

  for (const log of logs || []) {
    if (!log || log.deletedAt) continue;
    if (opts.type && log.type !== opts.type) continue;
    const rawName = String(log.itemName || '').trim();
    if (!rawName) continue;
    const lowerName = rawName.toLowerCase();
    if (q && !lowerName.includes(q)) continue;

    const daysAgo = daysBetweenYmd(log.date, todayYmd);
    const recencyWeight = 1 / (1 + daysAgo / 45);
    const ledgerBoost = getEffectiveLedgerId(log) === activeLedgerId ? 2 : 0.7;
    const matchBoost = q ? (lowerName.startsWith(q) ? 2 : 1) : 1;
    const contribution = recencyWeight * ledgerBoost * matchBoost;

    let b = buckets.get(lowerName);
    if (!b) {
      b = {
        itemName: rawName,
        lastDate: log.date,
        lastCreatedAt: log.createdAt || '',
        suggestedAmount: Number(log.amount || 0),
        currency: log.currency || 'TWD',
        type: log.type,
        count: 0,
        score: 0,
        categoryCounts: new Map(),
      };
      buckets.set(lowerName, b);
    }

    b.count += 1;
    b.score += contribution;
    b.categoryCounts.set(log.category, (b.categoryCounts.get(log.category) || 0) + 1);

    // Track most recent casing, amount, currency & type
    if (log.date > b.lastDate || (log.date === b.lastDate && (log.createdAt || '') >= b.lastCreatedAt)) {
      b.itemName = rawName;
      b.lastDate = log.date;
      b.lastCreatedAt = log.createdAt || '';
      b.suggestedAmount = Number(log.amount || 0);
      b.currency = log.currency || 'TWD';
      b.type = log.type;
    }
  }

  const results: AutocompleteSuggestion[] = [];
  for (const b of buckets.values()) {
    let topCategory = '其他';
    let topCatCount = -1;
    for (const [cat, cnt] of b.categoryCounts.entries()) {
      if (cnt > topCatCount) {
        topCatCount = cnt;
        topCategory = cat;
      }
    }
    results.push({
      itemName: b.itemName,
      category: topCategory,
      type: b.type,
      suggestedAmount: b.suggestedAmount,
      currency: b.currency,
      count: b.count,
      lastDate: b.lastDate,
      score: b.score,
    });
  }

  results.sort(
    (a, b) => b.score - a.score || b.count - a.count || b.lastDate.localeCompare(a.lastDate)
  );
  return results.slice(0, limit);
}
