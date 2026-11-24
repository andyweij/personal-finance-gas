import {
  ALL_CASHFLOW_TYPES,
  ALL_STOCK_TX_TYPES,
  ASSET_MAJOR_TYPES,
  ASSET_UPDATE_MODES,
  BILLING_CYCLES,
  CURRENCIES,
  LIQUIDITY_LEVELS,
  RECURRING_CASHFLOW_TYPES,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  STOCK_TX_TYPES,
} from './constants';
import type { StockTransactionType } from './types';

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
}

export function validateCashFlowInput(
  payload: CashFlowInputPayload,
  defaultUsdTwdRate = 32.5
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

  if (!ALL_CASHFLOW_TYPES.includes(type)) {
    throw new Error(`不支援的收支類型：${type}`);
  }
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('請輸入大於 0 的有效金額。');
  }
  if (!CURRENCIES.includes(currency)) {
    throw new Error(`不支援的幣別：${currency}`);
  }

  const fxRate =
    currency === 'USD'
      ? toSafeNumber(payload.fxRate, defaultUsdTwdRate) > 0
        ? toSafeNumber(payload.fxRate, defaultUsdTwdRate)
        : defaultUsdTwdRate
      : 1;
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
  status?: string;
  note?: string;
  linkedAccountId?: string | null;
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

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (!RECURRING_CASHFLOW_TYPES.includes(type)) throw new Error(`不支援的收支類型：${type}`);
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) throw new Error('請輸入大於 0 的金額。');
  if (!CURRENCIES.includes(currency)) throw new Error(`不支援的幣別：${currency}`);
  if (!BILLING_CYCLES.includes(cycle)) throw new Error(`不支援的週期：${cycle}`);
  if (!STATUS_OPTIONS.includes(status)) throw new Error(`不支援的狀態：${status}`);

  return { itemName, category, type, amount, currency, cycle, billingSpec, status, note, linkedAccountId };
}

export interface SinkingInputPayload {
  itemName: string;
  category?: string;
  totalAmount: number | string;
  months: number | string;
  dueNote?: string;
  status?: string;
  note?: string;
}

export function validateSinkingInput(payload: SinkingInputPayload) {
  const itemName = String(payload.itemName || '').trim().slice(0, 80);
  const category = String(payload.category || '').trim().slice(0, 40) || '其他';
  const totalAmount = Math.round(Number(payload.totalAmount));
  const months = Math.round(Number(payload.months));
  const dueNote = String(payload.dueNote || '').trim().slice(0, 40);
  const status = String(payload.status || '啟用').trim();
  const note = String(payload.note || '').trim().slice(0, 200);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (Number.isNaN(totalAmount) || totalAmount <= 0) throw new Error('請輸入大於 0 的預估總金額。');
  if (Number.isNaN(months) || months < 1 || months > 120) throw new Error('分攤月數需介於 1～120 個月。');
  if (!STATUS_OPTIONS.includes(status)) throw new Error('狀態無效。');

  return { itemName, category, totalAmount, months, dueNote, status, note };
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
  costBasis?: number | string | null;
  note?: string;
  isLinkedSavings?: boolean;
  balanceAnchorDate?: string | null;
  balanceAnchorAt?: string | null;
  isDefaultSavings?: boolean;
}

export function validateAssetInput(payload: AssetInputPayload) {
  const isLinkedSavings = Boolean(payload.isLinkedSavings);
  const updateMode = isLinkedSavings ? '手動快照' : String(payload.updateMode || '手動快照').trim();
  const majorType = isLinkedSavings ? '資產' : String(payload.majorType || '資產').trim();
  const subCategory = isLinkedSavings
    ? '活存'
    : String(payload.subCategory || '其他資產').trim().slice(0, 40);
  const rawLiquidity = isLinkedSavings ? '高流動' : String(payload.liquidity || '中流動').trim();
  const liquidity =
    majorType === '負債'
      ? '負債'
      : LIQUIDITY_LEVELS.includes(rawLiquidity)
        ? rawLiquidity
        : '中流動';
  const itemName = String(payload.itemName || '').trim().slice(0, 80);
  const ticker = isLinkedSavings ? '' : String(payload.ticker || '').trim().toUpperCase().slice(0, 30);
  const quantityOrAmount = Number(payload.quantityOrAmount);
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const unitPrice = isLinkedSavings ? 1 : payload.unitPrice !== undefined ? Number(payload.unitPrice) : 1;
  let costBasis: number | null = null;
  if (!isLinkedSavings && payload.costBasis !== undefined && payload.costBasis !== null && String(payload.costBasis).trim() !== '') {
    const parsedCost = Number(payload.costBasis);
    if (Number.isNaN(parsedCost) || !Number.isFinite(parsedCost) || parsedCost < 0) {
      throw new Error('期初成本需大於等於 0。');
    }
    costBasis = Math.round(parsedCost * 100) / 100;
  }
  const note = String(payload.note || '').trim().slice(0, 200);
  const balanceAnchorDate = payload.balanceAnchorDate
    ? (parseLocalDate(String(payload.balanceAnchorDate)), String(payload.balanceAnchorDate).trim())
    : null;
  const balanceAnchorAt = payload.balanceAnchorAt ? String(payload.balanceAnchorAt).trim() : null;
  const isDefaultSavings = isLinkedSavings && Boolean(payload.isDefaultSavings);

  if (!itemName) throw new Error('請輸入項目名稱。');
  if (!ASSET_UPDATE_MODES.includes(updateMode)) throw new Error('更新方式無效。');
  if (!ASSET_MAJOR_TYPES.includes(majorType)) throw new Error('大類需為資產或負債。');
  if (Number.isNaN(quantityOrAmount) || !Number.isFinite(quantityOrAmount) || quantityOrAmount < 0) {
    throw new Error('請輸入大於等於 0 的有效數值。');
  }
  if (!CURRENCIES.includes(currency)) throw new Error('幣別僅支援 TWD / USD。');
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
    costBasis,
    note,
    isLinkedSavings,
    balanceAnchorDate,
    balanceAnchorAt,
    isDefaultSavings,
  };
}

export interface SavingsAdjustmentInputPayload {
  accountId: string;
  date: string;
  amount: number | string;
  currency?: string;
  note?: string;
}

export function validateSavingsAdjustmentInput(
  payload: SavingsAdjustmentInputPayload,
  usdTwdRate = 32.5
) {
  const accountId = String(payload.accountId || '').trim();
  if (!accountId) throw new Error('請選擇對應的活存帳戶。');
  parseLocalDate(String(payload.date || ''));
  const amount = Number(payload.amount);
  if (Number.isNaN(amount) || !Number.isFinite(amount) || amount === 0) {
    throw new Error('存入或轉出金額不可為 0。');
  }
  const currency = String(payload.currency || 'TWD').trim().toUpperCase();
  const rate = currency === 'USD' ? usdTwdRate : 1;
  const twdAmount = Math.round(amount * rate);
  const note = String(payload.note || '').trim().slice(0, 200);

  return {
    accountId,
    date: String(payload.date).trim(),
    amount,
    twdAmount,
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
