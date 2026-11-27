import { LOAN_MAX_ANNUAL_RATE_PERCENT } from './calculations';
import {
  ALL_CASHFLOW_TYPES,
  ALL_STOCK_TX_TYPES,
  ASSET_MAJOR_TYPES,
  ASSET_UPDATE_MODES,
  BILLING_CYCLES,
  CURRENCIES,
  DEFAULT_LEDGER_ID,
  DEFAULT_PNL_COLOR_SCHEME,
  DEFAULT_STOCK_CATEGORIES,
  FINANCIAL_GOAL_TYPES,
  LIQUIDITY_LEVELS,
  PNL_COLOR_SCHEMES,
  QUICK_ENTRY_TYPES,
  RECURRING_CASHFLOW_TYPES,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  STOCK_TX_TYPES,
  WEBAPP_CATEGORY_MAP,
} from './constants';
import type {
  CustomCategoriesMap,
  FinancialGoalType,
  PnlColorScheme,
  QuickEntryTemplate,
  RebalanceTargetKind,
  RebalanceTargetRule,
  StockTransactionType,
} from './types';
import {
  DEFAULT_ENABLED_CURRENCIES,
  isSupportedCurrency,
  isValidFxRateForCurrency,
  resolveFxRate,
  type FxRatesMap,
  type FxRateSource,
} from './currency';
import { roundTo } from './format';

export interface ParsedLocalDate {
  year: number;
  month: number;
  day: number;
  yearMonth: string;
}

export function toSafeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isNaN(num) || !Number.isFinite(num) ? fallback : num;
}

export function normalizeLedgerId(value: unknown): string {
  const s = String(value ?? '').trim().slice(0, 64);
  return s || DEFAULT_LEDGER_ID;
}

export interface LedgerInputPayload {
  name: string;
  includeInNetWorth?: boolean;
  monthlyDailyBudget?: number | string | null;
  note?: string;
  sortOrder?: number;
}

export function validateLedgerInput(payload: LedgerInputPayload) {
  const name = String(payload.name || '').trim().slice(0, 30);
  if (!name) throw new Error('請輸入帳本名稱。');
  const includeInNetWorth =
    payload.includeInNetWorth !== undefined ? Boolean(payload.includeInNetWorth) : true;
  let monthlyDailyBudget: number | null = null;
  if (
    payload.monthlyDailyBudget !== undefined &&
    payload.monthlyDailyBudget !== null &&
    String(payload.monthlyDailyBudget).trim() !== ''
  ) {
    const parsed = Math.round(Number(payload.monthlyDailyBudget));
    if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error('帳本每月預算需大於等於 0。');
    }
    monthlyDailyBudget = parsed;
  }
  const note = String(payload.note || '').trim().slice(0, 120);
  const sortOrder = normalizeSortOrder(payload.sortOrder, 0);
  return { name, includeInNetWorth, monthlyDailyBudget, note, sortOrder };
}

export function normalizePnlColorScheme(value: unknown): PnlColorScheme {
  const s = String(value || '').trim();
  if ((PNL_COLOR_SCHEMES as readonly string[]).includes(s)) {
    return s as PnlColorScheme;
  }
  return DEFAULT_PNL_COLOR_SCHEME;
}

export function normalizeSortOrder(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Math.round(Number(value));
  if (Number.isNaN(num) || !Number.isFinite(num)) return fallback;
  return Math.max(-1_000_000, Math.min(1_000_000, num));
}

export function normalizeStockCategory(value: unknown): string {
  return String(value || '').trim().slice(0, 24);
}

export function normalizeCustomStockCategories(value: unknown): string[] {
  let rawList: unknown[] = [];
  if (Array.isArray(value)) {
    rawList = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) rawList = parsed;
    } catch {
      rawList = [];
    }
  }
  const defaultSet = new Set(DEFAULT_STOCK_CATEGORIES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    const clean = normalizeStockCategory(item);
    if (!clean || defaultSet.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 30) break;
  }
  return out;
}

export const MAX_REBALANCE_TARGETS_PER_KIND = 100;

function parseRebalanceTargetItems(value: unknown): RebalanceTargetRule[] {
  let rawList: unknown[] = [];
  if (Array.isArray(value)) {
    rawList = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) rawList = parsed;
    } catch {
      rawList = [];
    }
  }
  const seen = new Set<string>();
  const out: RebalanceTargetRule[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const rawKind = String(obj.kind || '').trim();
    if (rawKind !== 'category' && rawKind !== 'ticker') continue;
    const kind = rawKind as RebalanceTargetKind;
    const key = String(obj.key || '').trim().slice(0, 64);
    if (!key) continue;
    const dedupKey = `${kind}:${key}`;
    if (seen.has(dedupKey)) continue;
    const label = String(obj.label || key).trim().slice(0, 40) || key;
    const rawPct = Number(obj.targetPct);
    if (!Number.isFinite(rawPct) || rawPct < 0 || rawPct > 100) continue;
    const targetPct = roundTo(rawPct, 2);
    const id = String(obj.id || dedupKey).trim().slice(0, 64) || dedupKey;
    seen.add(dedupKey);
    out.push({ id, kind, key, label, targetPct });
  }
  return out;
}

export function normalizeRebalanceTargets(value: unknown): RebalanceTargetRule[] {
  const parsed = parseRebalanceTargetItems(value);
  const counts: Record<RebalanceTargetKind, number> = { category: 0, ticker: 0 };
  const out: RebalanceTargetRule[] = [];
  for (const rule of parsed) {
    if (counts[rule.kind] >= MAX_REBALANCE_TARGETS_PER_KIND) continue;
    counts[rule.kind] += 1;
    out.push(rule);
  }
  return out;
}

export function validateRebalanceTargetsForSave(rules: unknown): RebalanceTargetRule[] {
  const parsed = parseRebalanceTargetItems(rules);
  for (const kind of ['category', 'ticker'] as const) {
    const group = parsed.filter((r) => r.kind === kind);
    if (!group.length) continue;
    const kindLabel = kind === 'category' ? '分類目標' : '標的目標';
    if (group.length > MAX_REBALANCE_TARGETS_PER_KIND) {
      throw new Error(
        `${kindLabel}最多可設定 ${MAX_REBALANCE_TARGETS_PER_KIND} 筆（目前為 ${group.length} 筆），請精簡後再儲存。`
      );
    }
    const sum = roundTo(
      group.reduce((s, r) => s + r.targetPct, 0),
      2
    );
    if (Math.abs(sum - 100) > 0.01) {
      throw new Error(`${kindLabel}比例合計需為 100%（目前為 ${sum.toFixed(1)}%）`);
    }
  }
  return normalizeRebalanceTargets(parsed);
}

export function normalizeCustomCategories(value: unknown): CustomCategoriesMap {
  let rawObj: Record<string, unknown> | null = null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    rawObj = value as Record<string, unknown>;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawObj = parsed as Record<string, unknown>;
      }
    } catch {
      rawObj = null;
    }
  }
  if (!rawObj) return {};

  const validTypes = new Set(ALL_CASHFLOW_TYPES);
  const out: CustomCategoriesMap = {};
  for (const [typeKey, rawList] of Object.entries(rawObj)) {
    if (!validTypes.has(typeKey) || !Array.isArray(rawList)) continue;
    const defaults = new Set(WEBAPP_CATEGORY_MAP[typeKey] || []);
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const item of rawList) {
      const name = String(item ?? '').trim().slice(0, 20);
      if (!name || defaults.has(name) || seen.has(name)) continue;
      seen.add(name);
      cleaned.push(name);
      if (cleaned.length >= 30) break;
    }
    if (cleaned.length > 0) {
      out[typeKey] = cleaned;
    }
  }
  return out;
}

export function getEffectiveCategoriesForType(
  type: string,
  customCategories?: CustomCategoriesMap | null
): string[] {
  const defaults = WEBAPP_CATEGORY_MAP[type] || ['其他'];
  const custom = customCategories?.[type] || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...defaults, ...custom]) {
    const clean = String(c || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function normalizeQuickTemplates(value: unknown): QuickEntryTemplate[] {
  let rawList: unknown[] = [];
  if (Array.isArray(value)) {
    rawList = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) rawList = parsed;
    } catch {
      rawList = [];
    }
  }
  const validTypes = new Set(ALL_CASHFLOW_TYPES);
  const validCurrs = new Set(CURRENCIES);
  const explicitIds = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const rawId = String((item as Record<string, unknown>).id ?? '').trim().slice(0, 64);
    if (rawId) explicitIds.add(rawId);
  }
  const seen = new Set<string>();
  const out: QuickEntryTemplate[] = [];
  let autoSeq = 1;

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const label = String(obj.label ?? '').trim().slice(0, 24);
    const type = String(obj.type ?? '').trim();
    const category = String(obj.category ?? '').trim().slice(0, 24);
    if (!label || !validTypes.has(type) || !category) continue;
    let id = String(obj.id ?? '').trim().slice(0, 64);
    if (!id) {
      while (seen.has(`tpl-${autoSeq}`) || explicitIds.has(`tpl-${autoSeq}`)) {
        autoSeq += 1;
      }
      id = `tpl-${autoSeq}`;
      autoSeq += 1;
    }
    if (seen.has(id)) continue;

    let amount: number | null = null;
    if (obj.amount !== null && obj.amount !== undefined && String(obj.amount).trim() !== '') {
      const num = Number(obj.amount);
      if (Number.isFinite(num) && num > 0) {
        amount = roundTo(num, 2);
      }
    }
    const rawCurr = String(obj.currency ?? 'TWD').trim().toUpperCase();
    const currency = validCurrs.has(rawCurr) ? rawCurr : 'TWD';
    const itemName = String(obj.itemName ?? '').trim().slice(0, 80) || category;
    const linkedRaw = String(obj.linkedAccountId ?? '').trim().slice(0, 64);
    const linkedAccountId = linkedRaw || null;
    const ledgerId = normalizeLedgerId(obj.ledgerId);
    const note = String(obj.note ?? '').trim().slice(0, 120);
    const oneClick = Boolean(obj.oneClick) && amount !== null && amount > 0;

    seen.add(id);
    out.push({
      id,
      label,
      type,
      category,
      itemName,
      amount,
      currency,
      linkedAccountId,
      ledgerId,
      note,
      oneClick,
    });
    if (out.length >= 30) break;
  }
  return out;
}

export function validateQuickTemplateInput(raw: Partial<QuickEntryTemplate>): QuickEntryTemplate {
  const label = String(raw.label ?? '').trim().slice(0, 24);
  if (!label) throw new Error('請輸入範本名稱。');
  const type = String(raw.type ?? '').trim();
  if (!QUICK_ENTRY_TYPES.includes(type)) {
    throw new Error(`快速記帳範本不支援「${type}」類型，請改選快速記帳支援的交易類型。`);
  }
  const category = String(raw.category ?? '').trim().slice(0, 24);
  if (!category) throw new Error('請選擇或輸入分類。');

  let amount: number | null = null;
  if (raw.amount !== null && raw.amount !== undefined && String(raw.amount).trim() !== '') {
    const parsed = Number(raw.amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('範本金額必須大於 0，或留空讓記帳時填寫。');
    }
    amount = roundTo(parsed, 2);
  }
  const oneClick = Boolean(raw.oneClick);
  if (oneClick && (amount === null || amount <= 0)) {
    throw new Error('啟用「一鍵直記」必須填寫大於 0 的金額。');
  }
  const rawCurr = String(raw.currency ?? 'TWD').trim().toUpperCase();
  if (!CURRENCIES.includes(rawCurr)) {
    throw new Error(`不支援的幣別：${rawCurr}`);
  }

  return {
    id: String(raw.id ?? '').trim().slice(0, 64) || `tpl-${Date.now().toString(36)}`,
    label,
    type,
    category,
    itemName: String(raw.itemName ?? '').trim().slice(0, 80) || category,
    amount,
    currency: rawCurr,
    linkedAccountId: String(raw.linkedAccountId ?? '').trim().slice(0, 64) || null,
    ledgerId: normalizeLedgerId(raw.ledgerId),
    note: String(raw.note ?? '').trim().slice(0, 120),
    oneClick,
  };
}

export function parseLocalDate(ymd: string): ParsedLocalDate {
  const trimmed = String(ymd || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`日期格式錯誤：${ymd}（應為 YYYY-MM-DD）`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`無效的日期：${ymd}`);
  }
  return {
    year,
    month,
    day,
    yearMonth: `${year}-${String(month).padStart(2, '0')}`,
  };
}

export interface CashFlowInputPayload {
  date: string;
  type: string;
  category?: string;
  itemName?: string;
  amount: number | string;
  currency?: string;
  fxRate?: number;
  source?: string;
  note?: string;
  makeRecurring?: boolean;
  linkedAccountId?: string | null;
  ledgerId?: string;
}

export interface ValidatedCashFlowInput {
  date: string;
  yearMonth: string;
  type: string;
  category: string;
  itemName: string;
  amount: number;
  currency: string;
  fxRate: number;
  twdAmount: number;
  source: string;
  note: string;
  linkedAccountId: string | null;
  ledgerId: string;
}

export function normalizeEnabledCurrencies(value: unknown): string[] {
  let rawList: unknown[] = [];
  if (Array.isArray(value)) {
    rawList = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) rawList = parsed;
    } catch {
      rawList = [];
    }
  }
  const seen = new Set<string>(['TWD']);
  const out: string[] = ['TWD'];
  for (const item of rawList) {
    const code = String(item ?? '').trim().toUpperCase();
    if (!code || seen.has(code) || !isSupportedCurrency(code)) continue;
    seen.add(code);
    out.push(code);
  }
  if (out.length === 1 && rawList.length === 0) {
    return [...DEFAULT_ENABLED_CURRENCIES];
  }
  return out;
}

export function normalizeFxRates(value: unknown, fallbackUsdTwdRate = 32.5): FxRatesMap {
  let rawObj: Record<string, unknown> | null = null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    rawObj = value as Record<string, unknown>;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawObj = parsed as Record<string, unknown>;
      }
    } catch {
      rawObj = null;
    }
  }
  const out: FxRatesMap = {};
  if (isValidFxRateForCurrency('USD', fallbackUsdTwdRate)) {
    out.USD = Number(fallbackUsdTwdRate);
  }
  if (rawObj) {
    for (const [rawCode, rawRate] of Object.entries(rawObj)) {
      const code = String(rawCode || '').trim().toUpperCase();
      if (code === 'TWD' || !isSupportedCurrency(code)) continue;
      const rate = Number(rawRate);
      if (isValidFxRateForCurrency(code, rate)) {
        out[code] = rate;
      }
    }
  }
  // Ensure USD stays synced with fallbackUsdTwdRate if explicit USD was missing
  if (!out.USD && isValidFxRateForCurrency('USD', fallbackUsdTwdRate)) {
    out.USD = Number(fallbackUsdTwdRate);
  }
  return out;
}

export function validateCashFlowInput(
  payload: CashFlowInputPayload,
  fxSource: FxRateSource = 32.5
): ValidatedCashFlowInput {
  if (!payload || typeof payload !== 'object') {
    throw new Error('請求格式無效。');
  }
  const parsedDate = parseLocalDate(String(payload.date || ''));
  const type = String(payload.type || '').trim();
  const category = String(payload.category || '').trim().slice(0, 40) || '其他';
  const itemName = (String(payload.itemName || '').trim() || category).slice(0, 80);
  const amount = Number(payload.amount);
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const sourceRaw = String(payload.source || '手機記帳').trim();
  const source = SOURCE_OPTIONS.includes(sourceRaw) ? sourceRaw : '手機記帳';
  const note = String(payload.note || '').trim().slice(0, 200);
  const linkedAccountId = payload.linkedAccountId ? String(payload.linkedAccountId).trim() : null;
  const ledgerId = normalizeLedgerId(payload.ledgerId);

  if (!ALL_CASHFLOW_TYPES.includes(type)) {
    throw new Error(`不支援的收支類型：${type}`);
  }
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('請輸入大於 0 的有效金額。');
  }
  if (!CURRENCIES.includes(currency)) {
    throw new Error(`不支援的幣別：${currency}`);
  }

  const defaultRate = resolveFxRate(currency, fxSource);
  const explicitFx = toSafeNumber(payload.fxRate, 0);
  const fxRate = currency === 'TWD' ? 1 : explicitFx > 0 ? explicitFx : defaultRate;
  const twdAmount = Math.round(amount * fxRate);

  return {
    date: String(payload.date).trim(),
    yearMonth: parsedDate.yearMonth,
    type,
    category,
    itemName,
    amount,
    currency,
    fxRate,
    twdAmount,
    source,
    note,
    linkedAccountId,
    ledgerId,
  };
}

export interface RecurringInputPayload {
  itemName: string;
  category?: string;
  type: string;
  amount: number | string;
  currency?: string;
  cycle?: string;
  billingSpec?: string;
  /** v1.13.1: day of month (1-31) the auto-posted entry is dated; omitted = 1 */
  postDay?: number | string | null;
  status?: string;
  note?: string;
  linkedAccountId?: string | null;
  ledgerId?: string;
  sortOrder?: number;
}

export function validateRecurringInput(payload: RecurringInputPayload) {
  const itemName = String(payload.itemName || '').trim().slice(0, 80);
  const category = String(payload.category || '').trim().slice(0, 40) || '其他';
  const type = String(payload.type || '').trim();
  const amount = Number(payload.amount);
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const cycle = String(payload.cycle || '月繳').trim();
  const billingSpec = String(payload.billingSpec || '').trim().slice(0, 40);
  const status = String(payload.status || '啟用').trim();
  const note = String(payload.note || '').trim().slice(0, 200);
  const linkedAccountId = payload.linkedAccountId ? String(payload.linkedAccountId).trim() : null;
  const ledgerId = normalizeLedgerId(payload.ledgerId);
  const sortOrder = normalizeSortOrder(payload.sortOrder, 0);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (!RECURRING_CASHFLOW_TYPES.includes(type)) throw new Error(`不支援的收支類型：${type}`);
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) throw new Error('請輸入大於 0 的金額。');
  if (!CURRENCIES.includes(currency)) throw new Error(`不支援的幣別：${currency}`);
  if (!BILLING_CYCLES.includes(cycle)) throw new Error(`不支援的週期：${cycle}`);
  if (!STATUS_OPTIONS.includes(status)) throw new Error(`不支援的狀態：${status}`);

  // v1.13.1: posting day 1-31 (a day the month lacks is posted on its last day)
  let postDay = 1;
  const rawPostDay = payload.postDay;
  if (rawPostDay !== undefined && rawPostDay !== null && String(rawPostDay).trim() !== '') {
    const n = Number(rawPostDay);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error('入帳日需為 1～31 的整數。');
    postDay = n;
  }

  return {
    itemName,
    category,
    type,
    amount,
    currency,
    cycle,
    billingSpec,
    postDay,
    status,
    note,
    linkedAccountId,
    ledgerId,
    sortOrder,
  };
}

export interface SinkingInputPayload {
  itemName: string;
  category?: string;
  totalAmount: number | string;
  months: number | string;
  dueNote?: string;
  status?: string;
  note?: string;
  sortOrder?: number;
}

export function validateSinkingInput(payload: SinkingInputPayload) {
  const itemName = String(payload.itemName || '').trim().slice(0, 80);
  const category = String(payload.category || '').trim().slice(0, 40) || '其他';
  const totalAmount = Math.round(Number(payload.totalAmount));
  const months = Math.round(Number(payload.months));
  const dueNote = String(payload.dueNote || '').trim().slice(0, 40);
  const status = String(payload.status || '啟用').trim();
  const note = String(payload.note || '').trim().slice(0, 200);
  const sortOrder = normalizeSortOrder(payload.sortOrder, 0);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (Number.isNaN(totalAmount) || totalAmount <= 0) throw new Error('請輸入大於 0 的預估總金額。');
  if (Number.isNaN(months) || months < 1 || months > 120) throw new Error('分攤月數需介於 1～120 個月。');
  if (!STATUS_OPTIONS.includes(status)) throw new Error('狀態無效。');

  return { itemName, category, totalAmount, months, dueNote, status, note, sortOrder };
}

export interface AssetInputPayload {
  updateMode?: string;
  majorType?: string;
  subCategory?: string;
  liquidity?: string;
  itemName: string;
  ticker?: string;
  quantityOrAmount: number | string;
  currency?: string;
  unitPrice?: number | string;
  previousClose?: number | string | null;
  costBasis?: number | string | null;
  note?: string;
  isLinkedSavings?: boolean;
  balanceAnchorDate?: string | null;
  balanceAnchorAt?: string | null;
  isDefaultSavings?: boolean;
  isAmortizingLoan?: boolean;
  loanAnnualRate?: number | string | null;
  loanMonthlyPayment?: number | string | null;
  loanBillingDay?: number | string | null;
  stockCategory?: string;
  isWatchlist?: boolean;
  ledgerId?: string;
  excludeFromNetWorth?: boolean;
  sortOrder?: number;
  /** True only when user explicitly modified unitPrice or previousClose in UI; allows overriding server-owned auto-updated quotes. */
  manualPriceOverride?: boolean;
}

/**
 * Resolves price/previousClose fields for stock/watchlist edit forms:
 * - Unchanged price & prevClose on an existing record -> omits both so server-owned auto quotes are preserved.
 * - Manually changed unitPrice without editing previousClose -> clears previousClose to null & marks manualPriceOverride: true.
 * - Explicitly edited previousClose (or new record) -> passes provided values and marks manualPriceOverride: true on existing records.
 */
export function resolveStockModalPriceFields(params: {
  existing: { unitPrice: number; previousClose?: number | null } | null | undefined;
  rawPrice: string;
  rawPrevClose?: string;
  hasPrevCloseInput: boolean;
  defaultNewPrice?: number;
  tickerChanged?: boolean;
  /** Q8: new ticker value; clearing the ticker (empty) never zeroes the existing price. */
  newTicker?: string;
}): {
  unitPrice?: number;
  previousClose?: number | null;
  manualPriceOverride?: boolean;
} {
  const {
    existing,
    rawPrice,
    rawPrevClose = '',
    hasPrevCloseInput,
    defaultNewPrice = 0,
    tickerChanged = false,
    newTicker,
  } = params;
  const trimmedPrice = rawPrice.trim();
  const trimmedPrev = rawPrevClose.trim();
  const parsedPrice = trimmedPrice !== '' ? Number(trimmedPrice) : null;
  const parsedPrev = trimmedPrev !== '' ? Number(trimmedPrev) : null;

  if (!existing) {
    return {
      unitPrice: parsedPrice !== null && Number.isFinite(parsedPrice) ? parsedPrice : defaultNewPrice,
      previousClose: hasPrevCloseInput && parsedPrev !== null && Number.isFinite(parsedPrev) ? parsedPrev : null,
    };
  }

  const existingPrev = existing.previousClose ?? null;
  const priceChanged =
    parsedPrice !== null && Number.isFinite(parsedPrice) && parsedPrice !== existing.unitPrice;
  const prevChanged = hasPrevCloseInput
    ? (parsedPrev !== null && Number.isFinite(parsedPrev) ? parsedPrev : null) !== existingPrev
    : false;

  // F5 / Q8: Ticker REPLACED by another non-empty ticker without explicit new price -> clear old ticker's price & previousClose.
  // Clearing the ticker keeps the existing quote (falls through to the normal "unchanged" handling below).
  const tickerReplaced = tickerChanged && (newTicker === undefined || newTicker.trim() !== '');
  if (tickerReplaced && !priceChanged) {
    return {
      unitPrice: 0,
      previousClose: prevChanged && parsedPrev !== null && Number.isFinite(parsedPrev) ? parsedPrev : null,
    };
  }

  if (!priceChanged && !prevChanged) {
    // Neither price nor previousClose was edited: omit both so server-owned live quotes are untouched
    return {};
  }

  if (priceChanged && !prevChanged) {
    // User manually changed market price without updating previousClose -> clear stale previousClose
    return {
      unitPrice: parsedPrice!,
      previousClose: null,
      manualPriceOverride: true,
    };
  }

  if (!priceChanged && prevChanged) {
    // F4: User ONLY changed previousClose -> omit unitPrice so server's newer live price is preserved!
    return {
      previousClose: parsedPrev !== null && Number.isFinite(parsedPrev) ? parsedPrev : null,
      manualPriceOverride: true,
    };
  }

  return {
    unitPrice: parsedPrice !== null && Number.isFinite(parsedPrice) ? parsedPrice : existing.unitPrice,
    previousClose: parsedPrev !== null && Number.isFinite(parsedPrev) ? parsedPrev : null,
    manualPriceOverride: true,
  };
}

export function validateAssetInput(payload: AssetInputPayload) {
  const isWatchlist = Boolean(payload.isWatchlist);
  const isLinkedSavings = !isWatchlist && Boolean(payload.isLinkedSavings);
  const ticker = isLinkedSavings ? '' : String(payload.ticker || '').trim().toUpperCase().slice(0, 30);
  const updateMode = isLinkedSavings
    ? '手動快照'
    : isWatchlist
      ? ticker
        ? '自動更新'
        : '手動快照'
      : String(payload.updateMode || '手動快照').trim();
  const majorType = isLinkedSavings || isWatchlist ? '資產' : String(payload.majorType || '資產').trim();
  const subCategory = isLinkedSavings
    ? '活存'
    : String(payload.subCategory || (isWatchlist ? '台股' : '其他資產')).trim().slice(0, 40);
  const rawLiquidity = isLinkedSavings || isWatchlist ? '高流動' : String(payload.liquidity || '中流動').trim();
  const liquidity =
    majorType === '負債'
      ? '負債'
      : LIQUIDITY_LEVELS.includes(rawLiquidity)
        ? rawLiquidity
        : '中流動';
  const itemName = String(payload.itemName || '').trim().slice(0, 80);
  const quantityOrAmount = isWatchlist ? 0 : Number(payload.quantityOrAmount);
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const unitPrice = isLinkedSavings
    ? 1
    : payload.unitPrice !== undefined && payload.unitPrice !== ''
      ? Number(payload.unitPrice)
      : isWatchlist
        ? 0
        : 1;
  let previousClose: number | null = null;
  if (
    !isLinkedSavings &&
    payload.previousClose !== undefined &&
    payload.previousClose !== null &&
    String(payload.previousClose).trim() !== ''
  ) {
    const parsedPrev = Number(payload.previousClose);
    if (Number.isNaN(parsedPrev) || !Number.isFinite(parsedPrev) || parsedPrev < 0) {
      throw new Error('昨收價需大於等於 0。');
    }
    previousClose = parsedPrev > 0 ? Math.round(parsedPrev * 10000) / 10000 : null;
  }
  let costBasis: number | null = null;
  if (
    !isLinkedSavings &&
    !isWatchlist &&
    payload.costBasis !== undefined &&
    payload.costBasis !== null &&
    String(payload.costBasis).trim() !== ''
  ) {
    const parsedCost = Number(payload.costBasis);
    if (Number.isNaN(parsedCost) || !Number.isFinite(parsedCost) || parsedCost < 0) {
      throw new Error('期初成本需大於等於 0。');
    }
    costBasis = Math.round(parsedCost * 100) / 100;
  }
  const note = String(payload.note || '').trim().slice(0, 200);
  const balanceAnchorDate = isWatchlist
    ? null
    : payload.balanceAnchorDate
      ? (parseLocalDate(String(payload.balanceAnchorDate)), String(payload.balanceAnchorDate).trim())
      : null;
  const balanceAnchorAt = isWatchlist
    ? null
    : payload.balanceAnchorAt
      ? String(payload.balanceAnchorAt).trim()
      : null;
  const isDefaultSavings = isLinkedSavings && Boolean(payload.isDefaultSavings);
  const stockCategory = isLinkedSavings ? '' : normalizeStockCategory(payload.stockCategory);
  const ledgerId = isWatchlist ? DEFAULT_LEDGER_ID : normalizeLedgerId(payload.ledgerId);
  const excludeFromNetWorth = isWatchlist ? false : Boolean(payload.excludeFromNetWorth);
  const sortOrder = normalizeSortOrder(payload.sortOrder, 0);

  const isAmortizingLoan = !isLinkedSavings && !isWatchlist && majorType === '負債' && Boolean(payload.isAmortizingLoan);
  let loanAnnualRate: number | null = null;
  let loanMonthlyPayment: number | null = null;
  let loanBillingDay: number | null = null;

  if (isAmortizingLoan) {
    const rateNum = Number(payload.loanAnnualRate ?? 0);
    const payNum = Number(payload.loanMonthlyPayment);
    const dayNum = Math.round(Number(payload.loanBillingDay ?? 1));
    if (Number.isNaN(rateNum) || !Number.isFinite(rateNum) || rateNum < 0 || rateNum > LOAN_MAX_ANNUAL_RATE_PERCENT) {
      throw new Error('貸款年利率需介於 0% ～ 50%。');
    }
    if (Number.isNaN(payNum) || !Number.isFinite(payNum) || payNum <= 0) {
      throw new Error('啟用自動還本推算時，請輸入大於 0 的每月月付金。');
    }
    if (Number.isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
      throw new Error('每月扣款日需介於 1 ～ 31 號。');
    }
    loanAnnualRate = Math.round(rateNum * 1000) / 1000;
    loanMonthlyPayment = Math.round(payNum * 100) / 100;
    loanBillingDay = dayNum;
  } else if (majorType === '負債') {
    // Preserve optional numeric fields if provided on a paused/manual loan for easy re-enabling
    if (payload.loanAnnualRate !== undefined && payload.loanAnnualRate !== null && payload.loanAnnualRate !== '') {
      const r = Number(payload.loanAnnualRate);
      if (Number.isFinite(r) && r >= 0 && r <= LOAN_MAX_ANNUAL_RATE_PERCENT) loanAnnualRate = Math.round(r * 1000) / 1000;
    }
    if (
      payload.loanMonthlyPayment !== undefined &&
      payload.loanMonthlyPayment !== null &&
      payload.loanMonthlyPayment !== ''
    ) {
      const p = Number(payload.loanMonthlyPayment);
      if (Number.isFinite(p) && p > 0) loanMonthlyPayment = Math.round(p * 100) / 100;
    }
    if (payload.loanBillingDay !== undefined && payload.loanBillingDay !== null && payload.loanBillingDay !== '') {
      const d = Math.round(Number(payload.loanBillingDay));
      if (Number.isFinite(d) && d >= 1 && d <= 31) loanBillingDay = d;
    }
  }

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (!ASSET_UPDATE_MODES.includes(updateMode)) throw new Error('更新方式無效。');
  if (!ASSET_MAJOR_TYPES.includes(majorType)) throw new Error('大類需為資產或負債。');
  if (Number.isNaN(quantityOrAmount) || !Number.isFinite(quantityOrAmount) || quantityOrAmount < 0) {
    throw new Error('請輸入大於等於 0 的有效數值。');
  }
  if (!CURRENCIES.includes(currency)) throw new Error(`不支援的幣別：${currency}`);
  if (Number.isNaN(unitPrice) || !Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error('單價需大於等於 0。');
  }

  return {
    updateMode,
    majorType,
    subCategory,
    liquidity,
    itemName,
    ticker,
    quantityOrAmount,
    currency,
    unitPrice,
    previousClose,
    costBasis,
    note,
    isLinkedSavings,
    balanceAnchorDate,
    balanceAnchorAt,
    isDefaultSavings,
    isAmortizingLoan,
    loanAnnualRate,
    loanMonthlyPayment,
    loanBillingDay,
    stockCategory,
    isWatchlist,
    ledgerId,
    excludeFromNetWorth,
    sortOrder,
  };
}

export interface SavingsAdjustmentInputPayload {
  accountId: string;
  date: string;
  amount: number | string;
  currency?: string;
  note?: string;
  transferGroupId?: string | null;
}

export function validateSavingsAdjustmentInput(
  payload: SavingsAdjustmentInputPayload,
  fxSource: FxRateSource = 32.5
) {
  const accountId = String(payload.accountId || '').trim();
  if (!accountId) throw new Error('請選擇對應的活存帳戶。');
  parseLocalDate(String(payload.date || ''));
  const amount = Number(payload.amount);
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount === 0) {
    throw new Error('存入或轉出金額不可為 0。');
  }
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const rate = resolveFxRate(currency, fxSource);
  const twdAmount = Math.round(amount * rate);
  const note = String(payload.note || '').trim().slice(0, 200);
  const transferGroupId = payload.transferGroupId ? String(payload.transferGroupId).trim().slice(0, 80) : null;

  return {
    accountId,
    date: String(payload.date).trim(),
    amount,
    twdAmount,
    note,
    transferGroupId,
  };
}

export interface AccountTransferInputPayload {
  fromAccountId: string;
  toAccountId: string;
  date: string;
  amount: number | string;
  targetAmount?: number | string | null;
  fee?: number | string | null;
  note?: string;
}

export function validateAccountTransferInput(payload: AccountTransferInputPayload) {
  const fromAccountId = String(payload.fromAccountId || '').trim();
  const toAccountId = String(payload.toAccountId || '').trim();
  if (!fromAccountId || !toAccountId) {
    throw new Error('請選擇轉出帳戶與轉入帳戶。');
  }
  if (fromAccountId === toAccountId) {
    throw new Error('轉出帳戶與轉入帳戶不可相同。');
  }
  const date = String(payload.date || '').trim();
  parseLocalDate(date);

  const amount = Number(payload.amount);
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('轉帳金額須大於 0。');
  }

  let targetAmount: number | null = null;
  if (
    payload.targetAmount !== undefined &&
    payload.targetAmount !== null &&
    String(payload.targetAmount).trim() !== ''
  ) {
    const parsedTarget = Number(payload.targetAmount);
    if (Number.isNaN(parsedTarget) || !Number.isFinite(parsedTarget) || parsedTarget <= 0) {
      throw new Error('實際入帳金額須大於 0。');
    }
    targetAmount = Math.round(parsedTarget * 100) / 100;
  }

  let fee = 0;
  if (payload.fee !== undefined && payload.fee !== null && String(payload.fee).trim() !== '') {
    const parsedFee = Number(payload.fee);
    if (Number.isNaN(parsedFee) || !Number.isFinite(parsedFee) || parsedFee < 0) {
      throw new Error('轉帳手續費需大於等於 0。');
    }
    fee = Math.round(parsedFee * 100) / 100;
  }

  const note = String(payload.note || '').trim().slice(0, 150);
  return {
    fromAccountId,
    toAccountId,
    date,
    amount: Math.round(amount * 100) / 100,
    targetAmount,
    fee,
    note,
  };
}

export interface StockTransactionInputPayload {
  assetId: string;
  date: string;
  txType: StockTransactionType | string;
  shares?: number | string;
  totalAmount?: number | string;
  fee?: number | string;
  linkedCashflowId?: string | null;
  note?: string;
}

export function validateStockTransactionInput(payload: StockTransactionInputPayload) {
  const assetId = String(payload.assetId || '').trim();
  if (!assetId) throw new Error('請選擇對應的持股標的。');
  parseLocalDate(String(payload.date || ''));

  const txTypeRaw = String(payload.txType || '').trim();
  if (!ALL_STOCK_TX_TYPES.includes(txTypeRaw)) {
    throw new Error(`不支援的持股異動類型：${txTypeRaw}`);
  }
  const txType = txTypeRaw as StockTransactionType;

  const sharesRaw = payload.shares !== undefined && payload.shares !== '' ? Number(payload.shares) : 0;
  const totalAmountRaw =
    payload.totalAmount !== undefined && payload.totalAmount !== '' ? Number(payload.totalAmount) : 0;
  const feeRaw = payload.fee !== undefined && payload.fee !== '' ? Number(payload.fee) : 0;

  if (Number.isNaN(sharesRaw) || !Number.isFinite(sharesRaw) || sharesRaw < 0) {
    throw new Error('股數需大於等於 0。');
  }
  if (Number.isNaN(totalAmountRaw) || !Number.isFinite(totalAmountRaw) || totalAmountRaw < 0) {
    throw new Error('金額需大於等於 0。');
  }
  if (Number.isNaN(feeRaw) || !Number.isFinite(feeRaw) || feeRaw < 0) {
    throw new Error('手續費或扣費需大於等於 0。');
  }

  let shares = sharesRaw;
  let totalAmount = Math.round(totalAmountRaw * 100) / 100;
  const fee = Math.round(feeRaw * 100) / 100;

  if (txType === STOCK_TX_TYPES.BUY || txType === STOCK_TX_TYPES.SELL) {
    if (shares <= 0) throw new Error('買入或賣出股數需大於 0。');
    if (totalAmount <= 0) throw new Error('成交總金額需大於 0。');
  } else if (txType === STOCK_TX_TYPES.CASH_DIVIDEND) {
    shares = 0;
    if (totalAmount <= 0) throw new Error('現金配息金額需大於 0。');
  } else if (txType === STOCK_TX_TYPES.STOCK_DIVIDEND) {
    if (shares <= 0) throw new Error('股票配股股數需大於 0。');
    totalAmount = 0;
  }

  const linkedCashflowId = payload.linkedCashflowId ? String(payload.linkedCashflowId).trim() : null;
  const note = String(payload.note || '').trim().slice(0, 200);

  return {
    assetId,
    date: String(payload.date).trim(),
    txType,
    shares,
    totalAmount,
    fee,
    linkedCashflowId,
    note,
  };
}

export function normalizeLinkedAssetIds(value: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = [];
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const id = String(item ?? '').trim().slice(0, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 50) break;
  }
  return out;
}

export interface FinancialGoalInputPayload {
  name: string;
  goalType?: FinancialGoalType | string;
  targetAmount: number | string;
  currency?: string;
  linkedLedgerId?: string | null;
  linkedAssetIds?: string[] | string;
  currentManualAmount?: number | string;
  expectedAnnualReturnPct?: number | string;
  monthlyContributionOverride?: number | string | null;
  fireSwrPct?: number | string | null;
  targetDate?: string | null;
  sortOrder?: number;
  note?: string;
}

export function validateFinancialGoalInput(payload: FinancialGoalInputPayload) {
  const name = String(payload.name || '').trim().slice(0, 60);
  if (!name) throw new Error('請輸入財務目標名稱。');

  const rawType = String(payload.goalType || 'manual').trim();
  if (!(FINANCIAL_GOAL_TYPES as readonly string[]).includes(rawType)) {
    throw new Error(`不支援的目標類型：${rawType}`);
  }
  const goalType = rawType as FinancialGoalType;

  const targetAmountNum = Number(payload.targetAmount);
  if (Number.isNaN(targetAmountNum) || !Number.isFinite(targetAmountNum) || targetAmountNum <= 0) {
    throw new Error('目標金額須大於 0。');
  }
  const targetAmount = roundTo(targetAmountNum, 2);

  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    throw new Error(`不支援的幣別：${currency}`);
  }

  let linkedLedgerId: string | null = null;
  if (goalType === 'ledger_bucket') {
    const rawLid = String(payload.linkedLedgerId || '').trim();
    if (!rawLid) throw new Error('選擇「特定帳本」目標時，請指定綁定帳本。');
    linkedLedgerId = normalizeLedgerId(rawLid);
  }

  const linkedAssetIds = goalType === 'asset_bucket' ? normalizeLinkedAssetIds(payload.linkedAssetIds) : [];
  if (goalType === 'asset_bucket' && linkedAssetIds.length === 0) {
    throw new Error('選擇「指定資產」目標時，請至少勾選 1 項資產或活存帳戶。');
  }

  const manualNum =
    goalType === 'manual' && payload.currentManualAmount !== undefined && payload.currentManualAmount !== ''
      ? Number(payload.currentManualAmount)
      : 0;
  if (Number.isNaN(manualNum) || !Number.isFinite(manualNum) || manualNum < 0) {
    throw new Error('目前累積金額需大於等於 0。');
  }
  const currentManualAmount = roundTo(manualNum, 2);

  const retRaw =
    payload.expectedAnnualReturnPct !== undefined &&
    payload.expectedAnnualReturnPct !== null &&
    String(payload.expectedAnnualReturnPct).trim() !== ''
      ? Number(payload.expectedAnnualReturnPct)
      : 0;
  if (Number.isNaN(retRaw) || !Number.isFinite(retRaw) || retRaw < 0 || retRaw > 30) {
    throw new Error('預期年化報酬率需介於 0% ～ 30%。');
  }
  const expectedAnnualReturnPct = roundTo(retRaw, 2);

  let monthlyContributionOverride: number | null = null;
  if (
    payload.monthlyContributionOverride !== undefined &&
    payload.monthlyContributionOverride !== null &&
    String(payload.monthlyContributionOverride).trim() !== ''
  ) {
    const mc = Number(payload.monthlyContributionOverride);
    if (Number.isNaN(mc) || !Number.isFinite(mc) || mc < 0) {
      throw new Error('自訂每月投入金額需大於等於 0。');
    }
    monthlyContributionOverride = roundTo(mc, 2);
  }

  let fireSwrPct: number | null = null;
  if (goalType === 'fire') {
    const swrRaw =
      payload.fireSwrPct !== undefined &&
      payload.fireSwrPct !== null &&
      String(payload.fireSwrPct).trim() !== ''
        ? Number(payload.fireSwrPct)
        : 4;
    if (Number.isNaN(swrRaw) || !Number.isFinite(swrRaw) || swrRaw < 1 || swrRaw > 15) {
      throw new Error('FIRE 安全提領率需介於 1% ～ 15%。');
    }
    fireSwrPct = roundTo(swrRaw, 2);
  }

  let targetDate: string | null = null;
  if (payload.targetDate !== undefined && payload.targetDate !== null && String(payload.targetDate).trim() !== '') {
    const ym = String(payload.targetDate).trim();
    const match = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!match) {
      throw new Error('期望達成日期格式錯誤（應為 YYYY-MM）。');
    }
    const y = Number(match[1]);
    const mo = Number(match[2]);
    if (y < 1970 || y > 2200 || mo < 1 || mo > 12) {
      throw new Error('期望達成日期超出有效範圍。');
    }
    targetDate = ym;
  }

  const sortOrder = normalizeSortOrder(payload.sortOrder, 0);
  const note = String(payload.note || '').trim().slice(0, 200);

  return {
    name,
    goalType,
    targetAmount,
    currency,
    linkedLedgerId,
    linkedAssetIds,
    currentManualAmount,
    expectedAnnualReturnPct,
    monthlyContributionOverride,
    fireSwrPct,
    targetDate,
    sortOrder,
    note,
  };
}
