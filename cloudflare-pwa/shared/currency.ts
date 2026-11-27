import { DEFAULT_USD_TWD_RATE } from './constants';
import { roundTo } from './format';

export type SupportedCurrency =
  | 'TWD'
  | 'USD'
  | 'JPY'
  | 'EUR'
  | 'HKD'
  | 'GBP'
  | 'AUD'
  | 'SGD'
  | 'KRW';

export type FxRatesMap = Record<string, number>;

/**
 * Accepts either a legacy numeric USD/TWD rate (keeps all existing callers/tests 100% compatible)
 * OR a multi-currency FX map / AppSettings-like `{ usdTwdRate, fxRates }` object.
 */
export type FxRateSource =
  | number
  | FxRatesMap
  | { usdTwdRate?: number; fxRates?: FxRatesMap | null }
  | null
  | undefined;

export interface CurrencyMeta {
  code: SupportedCurrency;
  label: string;
  symbol: string;
  decimals: 0 | 2;
  defaultTwdRate: number;
  minTwdRate: number;
  maxTwdRate: number;
}

export const CURRENCY_META: Record<SupportedCurrency, CurrencyMeta> = {
  TWD: { code: 'TWD', label: '新台幣', symbol: 'NT$ ', decimals: 0, defaultTwdRate: 1, minTwdRate: 1, maxTwdRate: 1 },
  USD: { code: 'USD', label: '美元', symbol: 'US$', decimals: 2, defaultTwdRate: DEFAULT_USD_TWD_RATE, minTwdRate: 10, maxTwdRate: 100 },
  JPY: { code: 'JPY', label: '日圓', symbol: '¥', decimals: 0, defaultTwdRate: 0.215, minTwdRate: 0.05, maxTwdRate: 1 },
  EUR: { code: 'EUR', label: '歐元', symbol: '€', decimals: 2, defaultTwdRate: 35.0, minTwdRate: 15, maxTwdRate: 120 },
  HKD: { code: 'HKD', label: '港幣', symbol: 'HK$', decimals: 2, defaultTwdRate: 4.18, minTwdRate: 1, maxTwdRate: 15 },
  GBP: { code: 'GBP', label: '英鎊', symbol: '£', decimals: 2, defaultTwdRate: 41.0, minTwdRate: 20, maxTwdRate: 150 },
  AUD: { code: 'AUD', label: '澳幣', symbol: 'A$', decimals: 2, defaultTwdRate: 21.0, minTwdRate: 5, maxTwdRate: 80 },
  SGD: { code: 'SGD', label: '新幣', symbol: 'S$', decimals: 2, defaultTwdRate: 24.0, minTwdRate: 8, maxTwdRate: 80 },
  KRW: { code: 'KRW', label: '韓元', symbol: '₩', decimals: 0, defaultTwdRate: 0.0235, minTwdRate: 0.005, maxTwdRate: 0.2 },
};

export const SUPPORTED_CURRENCY_CODES: SupportedCurrency[] = [
  'TWD',
  'USD',
  'JPY',
  'EUR',
  'HKD',
  'GBP',
  'AUD',
  'SGD',
  'KRW',
];

export const DEFAULT_ENABLED_CURRENCIES: SupportedCurrency[] = ['TWD', 'USD'];

export function isSupportedCurrency(code: unknown): code is SupportedCurrency {
  const c = String(code ?? '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CURRENCY_META, c);
}

export function getCurrencyMeta(code: unknown): CurrencyMeta {
  const c = String(code ?? 'TWD').trim().toUpperCase();
  if (isSupportedCurrency(c)) return CURRENCY_META[c];
  return CURRENCY_META.TWD;
}

export function getCurrencyDecimals(code: unknown): 0 | 2 {
  return getCurrencyMeta(code).decimals;
}

export function getCurrencySymbol(code: unknown): string {
  return getCurrencyMeta(code).symbol;
}

export function isValidFxRateForCurrency(code: unknown, rate: unknown): boolean {
  const c = String(code ?? '').trim().toUpperCase();
  if (!isSupportedCurrency(c)) return false;
  const num = Number(rate);
  if (!Number.isFinite(num) || num <= 0) return false;
  if (c === 'TWD') return num === 1;
  const meta = CURRENCY_META[c];
  return num > meta.minTwdRate && num < meta.maxTwdRate;
}

function roundFxPrecision(rate: number): number {
  return roundTo(rate, rate < 0.1 ? 6 : 4);
}

/**
 * Resolves the TWD conversion rate (1 unit of `currency` = ? TWD) from either a legacy numeric USD/TWD rate
 * or a multi-currency `{ usdTwdRate, fxRates }` / `FxRatesMap` object.
 */
export function resolveFxRate(currency: unknown, fxSource?: FxRateSource): number {
  const c = String(currency ?? 'TWD').trim().toUpperCase();
  if (c === 'TWD' || !isSupportedCurrency(c)) return 1;

  if (typeof fxSource === 'number') {
    if (c === 'USD' && isValidFxRateForCurrency('USD', fxSource)) {
      return fxSource;
    }
    return CURRENCY_META[c].defaultTwdRate;
  }

  if (fxSource && typeof fxSource === 'object') {
    const asSettings = fxSource as { usdTwdRate?: unknown; fxRates?: FxRatesMap | null };
    const map: FxRatesMap | null =
      asSettings.fxRates && typeof asSettings.fxRates === 'object'
        ? asSettings.fxRates
        : ('usdTwdRate' in asSettings ? null : (fxSource as FxRatesMap));

    if (map && isValidFxRateForCurrency(c, map[c])) {
      return Number(map[c]);
    }
    if (c === 'USD' && isValidFxRateForCurrency('USD', asSettings.usdTwdRate)) {
      return Number(asSettings.usdTwdRate);
    }
  }

  return CURRENCY_META[c].defaultTwdRate;
}

/**
 * Given USD-based exchange rates from open.er-api.com (`{ TWD: 32.5, JPY: 150, ... }`),
 * computes cross TWD rates (`1 <currency> = ? TWD`) for every supported foreign currency that passes bounds.
 */
export function computeCrossTwdRatesFromUsdBase(usdBasedRates: Record<string, unknown>): FxRatesMap {
  const out: FxRatesMap = {};
  const usdTwd = Number(usdBasedRates?.TWD);
  if (!isValidFxRateForCurrency('USD', usdTwd)) {
    return out;
  }
  out.USD = roundFxPrecision(usdTwd);

  for (const code of SUPPORTED_CURRENCY_CODES) {
    if (code === 'TWD' || code === 'USD') continue;
    const perUsd = Number(usdBasedRates?.[code]);
    if (!Number.isFinite(perUsd) || perUsd <= 0) continue;
    const twdPerUnit = usdTwd / perUsd;
    if (isValidFxRateForCurrency(code, twdPerUnit)) {
      out[code] = roundFxPrecision(twdPerUnit);
    }
  }
  return out;
}

export function formatCurrencyRaw(amount: number, currency: unknown, masked: boolean): string {
  const meta = getCurrencyMeta(currency);
  if (masked) return `${meta.code} •••`;
  const rounded = roundTo(Number(amount || 0), meta.decimals);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  return (
    sign +
    meta.symbol +
    abs.toLocaleString('zh-TW', { maximumFractionDigits: meta.decimals })
  );
}
