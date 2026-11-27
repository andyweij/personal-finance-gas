import { computeCrossTwdRatesFromUsdBase, type FxRatesMap } from '../shared/currency';
import { normalizeFxRates } from '../shared/validation';
import { ensureAppSettings } from './sync';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type StockMarket = 'TW' | 'US';

export interface TickerHint {
  subCategory?: string | null;
  currency?: string | null;
}

export interface NormalizedMarketTicker {
  market: StockMarket;
  code: string;
  yahooSymbol: string;
  yahooFallbackSymbol?: string;
  stooqSymbol?: string;
  twseExchange?: 'tse' | 'otc';
}

const MARKET_USER_AGENT = 'Mozilla/5.0 (compatible; PersonalFinancePWA/1.5)';

const US_EXCHANGE_PREFIX_RE = /^(?:US|NASDAQ|NYSE|NYSEARCA|ARCA|AMEX|BATS|CBOE|OTCMKTS|OTCBB):(.+)$/;
const TW_TSE_PREFIX_RE = /^(?:TPE|TWSE|TW):([A-Z0-9]+)$/;
const TW_OTC_PREFIX_RE = /^(?:TPEX|TWO|OTC):([A-Z0-9]+)$/;
const TW_NUMERIC_CODE_RE = /^\d{4,6}[A-Z]?$/;

function roundStockPrice(price: number): number {
  if (price < 1) {
    return Math.round(price * 10000) / 10000;
  }
  return Math.round(price * 100) / 100;
}

/**
 * Normalizes both Taiwan (TWSE / TPEx) and US (NYSE / NASDAQ / ARCA / AMEX) tickers
 * into canonical Yahoo Finance + Stooq / TWSE symbols.
 */
export function normalizeMarketTicker(
  rawTicker: string,
  hint?: TickerHint
): NormalizedMarketTicker | null {
  const cleaned = String(rawTicker || '').trim().toUpperCase();
  if (!cleaned) return null;

  // 1. Explicit Taiwan exchange prefixes
  const tseMatch = TW_TSE_PREFIX_RE.exec(cleaned);
  if (tseMatch) {
    const code = tseMatch[1];
    return {
      market: 'TW',
      code,
      yahooSymbol: `${code}.TW`,
      yahooFallbackSymbol: `${code}.TWO`,
      twseExchange: 'tse',
    };
  }

  const otcMatch = TW_OTC_PREFIX_RE.exec(cleaned);
  if (otcMatch) {
    const code = otcMatch[1];
    return {
      market: 'TW',
      code,
      yahooSymbol: `${code}.TWO`,
      yahooFallbackSymbol: `${code}.TW`,
      twseExchange: 'otc',
    };
  }

  // 2. Explicit Taiwan suffixes (.TW / .TWO)
  const twSuffixMatch = /^([A-Z0-9]+)\.(TW|TWO)$/.exec(cleaned);
  if (twSuffixMatch) {
    const code = twSuffixMatch[1];
    const isOtc = twSuffixMatch[2] === 'TWO';
    return {
      market: 'TW',
      code,
      yahooSymbol: cleaned,
      yahooFallbackSymbol: isOtc ? `${code}.TW` : `${code}.TWO`,
      twseExchange: isOtc ? 'otc' : 'tse',
    };
  }

  // 3. Explicit US exchange prefixes (NASDAQ:AAPL, NYSE:BRK.B, NYSEARCA:VOO, US:NVDA, etc.)
  const usPrefixMatch = US_EXCHANGE_PREFIX_RE.exec(cleaned);
  if (usPrefixMatch) {
    const code = usPrefixMatch[1].replace(/\.US$/, '').trim();
    if (!code) return null;
    const yahooSymbol = code.replace(/\./g, '-');
    return {
      market: 'US',
      code,
      yahooSymbol,
      stooqSymbol: `${yahooSymbol.toLowerCase()}.us`,
    };
  }

  // 4. Explicit .US suffix (AAPL.US, BRK.B.US, BRK-B.US)
  const usSuffixMatch = /^([A-Z0-9.\-]+)\.US$/.exec(cleaned);
  if (usSuffixMatch) {
    const code = usSuffixMatch[1];
    const yahooSymbol = code.replace(/\./g, '-');
    return {
      market: 'US',
      code,
      yahooSymbol,
      stooqSymbol: `${yahooSymbol.toLowerCase()}.us`,
    };
  }

  // 5. Bare numeric ticker: route non-TWD/USD currencies to their international Yahoo suffix (never misroute to TWSE)
  const hintCurrency = String(hint?.currency || '').trim().toUpperCase();
  const hintIsUs = hint?.subCategory === '美股/ETF' || hintCurrency === 'USD';
  const NON_TW_YAHOO_SUFFIX: Record<string, string> = {
    HKD: '.HK',
    JPY: '.T',
    KRW: '.KS',
    SGD: '.SI',
    AUD: '.AX',
    GBP: '.L',
    EUR: '.DE',
  };
  if (hintCurrency && NON_TW_YAHOO_SUFFIX[hintCurrency] && !cleaned.includes('.') && !cleaned.includes(':')) {
    const suffix = NON_TW_YAHOO_SUFFIX[hintCurrency];
    return {
      market: 'US',
      code: cleaned,
      yahooSymbol: `${cleaned}${suffix}`,
    };
  }
  if (!hintIsUs && TW_NUMERIC_CODE_RE.test(cleaned)) {
    return {
      market: 'TW',
      code: cleaned,
      yahooSymbol: `${cleaned}.TW`,
      yahooFallbackSymbol: `${cleaned}.TWO`,
    };
  }

  // 6. US stock / ETF ticker (e.g. VOO, NVDA, AAPL, QQQ, TSM, BRK.B, BRK-B, JPM-PC)
  if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(cleaned) || hintIsUs) {
    const yahooSymbol = cleaned.replace(/\./g, '-');
    return {
      market: 'US',
      code: cleaned,
      yahooSymbol,
      stooqSymbol: `${yahooSymbol.toLowerCase()}.us`,
    };
  }

  return {
    market: 'TW',
    code: cleaned,
    yahooSymbol: cleaned,
  };
}

/**
 * Legacy helper retained for backwards compatibility with existing callers and tests.
 */
export function normalizeTaiwanTicker(rawTicker: string): { code: string; yahooSymbol: string } | null {
  const norm = normalizeMarketTicker(rawTicker);
  if (!norm) return null;
  return { code: norm.code, yahooSymbol: norm.yahooSymbol };
}

export async function fetchAllTwdFxRates(fetchImpl: FetchLike = fetch): Promise<FxRatesMap | null> {
  // Primary: Open Exchange Rates (free, 1 single request returns ALL supported currencies)
  try {
    const res = await fetchImpl('https://open.er-api.com/v6/latest/USD', {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const json = (await res.json()) as { rates?: Record<string, unknown> };
      if (json?.rates && typeof json.rates === 'object') {
        const computed = computeCrossTwdRatesFromUsdBase(json.rates);
        if (computed.USD) {
          return computed;
        }
      }
    }
  } catch {
    // Fallback below
  }

  // Fallback: Yahoo Finance TWD=X for USD/TWD
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetchImpl(`https://${host}/v8/finance/chart/TWD=X?interval=1d&range=5d`, {
        headers: { Accept: 'application/json', 'User-Agent': MARKET_USER_AGENT },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> };
        };
        const meta = json?.chart?.result?.[0]?.meta;
        const rate = Number(meta?.regularMarketPrice ?? meta?.previousClose);
        if (Number.isFinite(rate) && rate > 10 && rate < 100) {
          return { USD: Math.round(rate * 10000) / 10000 };
        }
      }
    } catch {
      // Try next host
    }
  }

  return null;
}

export async function fetchUsdTwdRate(fetchImpl: FetchLike = fetch): Promise<number | null> {
  const rates = await fetchAllTwdFxRates(fetchImpl);
  return rates?.USD ?? null;
}

export interface StockQuoteResult {
  price: number;
  previousClose: number | null;
}

function formatUtcOffsetDateKey(epochSec: number, gmtOffsetSec: number): string {
  const shifted = new Date((epochSec + gmtOffsetSec) * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * v1.12.1: the weekday before `ymd` (YYYY-MM-DD), skipping Saturday and Sunday. Exchange holidays are not known
 * here, so a bar after a holiday does not match; callers then ask range=1d instead of guessing.
 */
function previousWeekdayKey(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  do {
    dt.setUTCDate(dt.getUTCDate() - 1);
  } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.toISOString().slice(0, 10);
}

async function fetchYahoo1dPreviousClose(
  host: string,
  symbol: string,
  fetchImpl: FetchLike,
  expectedMarketDay?: string | null
): Promise<number | null> {
  try {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': MARKET_USER_AGENT },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            previousClose?: number;
            chartPreviousClose?: number;
            regularMarketTime?: number;
            gmtoffset?: number;
          };
        }>;
      };
    };
    const meta = json?.chart?.result?.[0]?.meta;
    // F11: the extra request may land after the session rolled over. Its previous close only pairs with the
    // 5d price when both describe the same trading day; otherwise return null rather than mismatch them.
    if (expectedMarketDay) {
      const t = Number(meta?.regularMarketTime);
      const off = Number.isFinite(Number(meta?.gmtoffset)) ? Number(meta?.gmtoffset) : 0;
      if (Number.isFinite(t) && t > 0 && formatUtcOffsetDateKey(t, off) !== expectedMarketDay) {
        return null;
      }
    }
    // On range=1d, both meta.previousClose and meta.chartPreviousClose represent the previous trading day's close
    const candidate = Number(meta?.previousClose ?? meta?.chartPreviousClose);
    if (Number.isFinite(candidate) && candidate > 0) {
      return roundStockPrice(candidate);
    }
  } catch {
    // Ignore 1d fallback failure
  }
  return null;
}

async function fetchYahooChartQuote(
  symbol: string,
  fetchImpl: FetchLike
): Promise<StockQuoteResult | null> {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const yfUrl = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const res = await fetchImpl(yfUrl, {
        headers: { Accept: 'application/json', 'User-Agent': MARKET_USER_AGENT },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        chart?: {
          result?: Array<{
            meta?: {
              regularMarketPrice?: number;
              regularMarketTime?: number;
              gmtoffset?: number;
              chartPreviousClose?: number;
              previousClose?: number;
            };
            timestamp?: Array<number | null>;
            indicators?: {
              quote?: Array<{ close?: Array<number | null> }>;
            };
          }>;
        };
      };
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      const timestamps = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const validPairs: Array<{ ts: number | null; close: number }> = [];
      for (let i = 0; i < closes.length; i++) {
        const val = Number(closes[i]);
        if (Number.isFinite(val) && val > 0) {
          const tsVal = Number(timestamps[i]);
          validPairs.push({ ts: Number.isFinite(tsVal) ? tsVal : null, close: val });
        }
      }

      let candidate = Number(meta?.regularMarketPrice);
      if (!Number.isFinite(candidate) || candidate <= 0) {
        if (validPairs.length > 0) {
          candidate = validPairs[validPairs.length - 1].close;
        }
      }
      if (!Number.isFinite(candidate) || candidate <= 0) {
        // Never use range=5d chartPreviousClose (~1 week ago) as current price
        candidate = Number(meta?.previousClose);
      }

      if (Number.isFinite(candidate) && candidate > 0) {
        let prevClose: number | null = null;
        let prevBarTs: number | null = null;
        const gmtOffset = Number.isFinite(Number(meta?.gmtoffset)) ? Number(meta?.gmtoffset) : 0;
        const marketTime = Number(meta?.regularMarketTime);
        const marketDay =
          Number.isFinite(marketTime) && marketTime > 0 ? formatUtcOffsetDateKey(marketTime, gmtOffset) : null;

        if (validPairs.length >= 2) {
          const lastPair = validPairs[validPairs.length - 1];
          if (marketDay !== null && lastPair.ts !== null) {
            const lastBarDay = formatUtcOffsetDateKey(lastPair.ts, gmtOffset);
            const prevPair = marketDay > lastBarDay ? lastPair : validPairs[validPairs.length - 2];
            prevClose = prevPair.close;
            prevBarTs = prevPair.ts;
          } else {
            prevClose = validPairs[validPairs.length - 2].close;
          }
        } else if (validPairs.length === 1) {
          const lastPair = validPairs[0];
          if (
            marketDay !== null &&
            lastPair.ts !== null &&
            marketDay > formatUtcOffsetDateKey(lastPair.ts, gmtOffset)
          ) {
            prevClose = lastPair.close;
            prevBarTs = lastPair.ts;
          }
        }

        // v1.12.1 (2026-11-27 report): the bar taken as the previous close must be the previous trading day of the
        // quote. A missing bar, a null close (filtered out above) or lagging daily bars otherwise yield the close
        // of two or more days ago, which can flip the sign of the daily change. Unverified → ask range=1d / null.
        if (prevClose !== null && marketDay !== null && prevBarTs !== null) {
          const prevBarDay = formatUtcOffsetDateKey(prevBarTs, gmtOffset);
          const expectedPrevDay = previousWeekdayKey(marketDay);
          if (prevBarDay !== expectedPrevDay) {
            console.warn(
              `[market] ${symbol}: previous-close bar ${prevBarDay} is not the trading day before ${marketDay} (expected ${expectedPrevDay}); verifying with range=1d`
            );
            prevClose = null;
          }
        }

        if (prevClose === null) {
          const metaPrev = Number(meta?.previousClose);
          if (Number.isFinite(metaPrev) && metaPrev > 0) {
            prevClose = metaPrev;
          } else {
            // Do NOT use range=5d meta.chartPreviousClose (that is ~1 week prior to the chart window).
            // Query range=1d where meta.previousClose / chartPreviousClose is the true previous trading day's close.
            const expectedDay =
              Number.isFinite(marketTime) && marketTime > 0 ? formatUtcOffsetDateKey(marketTime, gmtOffset) : null;
            prevClose = await fetchYahoo1dPreviousClose(host, symbol, fetchImpl, expectedDay);
          }
        }

        return {
          price: roundStockPrice(candidate),
          previousClose: prevClose !== null && prevClose > 0 ? roundStockPrice(prevClose) : null,
        };
      }
    } catch {
      // Try next Yahoo host
    }
  }
  return null;
}

/**
 * Free no-API-key fallback for US equities & ETFs via Stooq CSV endpoint.
 * Tries daily history (last 14 days) first to obtain both close & previousClose,
 * then falls back to latest single-row quote (/q/l/).
 */
async function fetchStooqUsQuote(
  stooqSymbol: string,
  fetchImpl: FetchLike
): Promise<StockQuoteResult | null> {
  // 1. Try compact daily history for latest 2 trading days
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const histUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${fmt(from)}&d2=${fmt(now)}&i=d`;
    const res = await fetchImpl(histUrl, {
      headers: { Accept: 'text/csv,text/plain,*/*', 'User-Agent': MARKET_USER_AGENT },
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length >= 2) {
        const headerCols = lines[0].split(',').map((h) => h.trim().toLowerCase());
        const closeIdx = headerCols.indexOf('close');
        if (closeIdx >= 0) {
          const closes: number[] = [];
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length > closeIdx) {
              const c = Number(cols[closeIdx]);
              if (Number.isFinite(c) && c > 0) {
                closes.push(c);
              }
            }
          }
          if (closes.length >= 1) {
            const latest = closes[closes.length - 1];
            const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
            return {
              price: roundStockPrice(latest),
              previousClose: prev !== null ? roundStockPrice(prev) : null,
            };
          }
        }
      }
    }
  } catch {
    // Fall through to single-row quote
  }

  // 2. Fallback: latest single-row quote Format: Symbol,Date,Time,Open,High,Low,Close,Volume
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetchImpl(url, {
      headers: { Accept: 'text/csv,text/plain,*/*', 'User-Agent': MARKET_USER_AGENT },
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return null;
    const cols = lines[1].split(',');
    if (cols.length < 7) return null;
    const close = Number(cols[6]);
    if (Number.isFinite(close) && close > 0) {
      return { price: roundStockPrice(close), previousClose: null };
    }
  } catch {
    // Ignore fallback failure
  }
  return null;
}

function parseFirstMisBookPrice(raw?: string): number | null {
  if (!raw || raw === '-') return null;
  for (const part of String(raw).split('_')) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '-') continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) {
      return roundStockPrice(n);
    }
  }
  return null;
}

async function fetchTwseMisQuote(
  code: string,
  preferredExchange: 'tse' | 'otc' | undefined,
  fetchImpl: FetchLike
): Promise<StockQuoteResult | null> {
  const exCh =
    preferredExchange === 'tse'
      ? `tse_${code}.tw`
      : preferredExchange === 'otc'
        ? `otc_${code}.tw`
        : `tse_${code}.tw|otc_${code}.tw`;
  try {
    const twseUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;
    const res = await fetchImpl(twseUrl, {
      headers: { Accept: 'application/json', 'User-Agent': MARKET_USER_AGENT },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      msgArray?: Array<{
        z?: string;
        y?: string;
        b?: string;
        a?: string;
        o?: string;
        t?: string;
        v?: string;
        ip?: string;
      }>;
    };
    const entries = json?.msgArray || [];
    for (const entry of entries) {
      // F2: Skip delayed open/close auction snapshots (ip='4' 暫緩收盤, ip='5' 暫緩開盤) -> fall back to Yahoo
      const ipStr = typeof entry?.ip === 'string' ? entry.ip.trim() : '';
      if (ipStr === '4' || ipStr === '5') {
        continue;
      }

      // F2: Skip pre-market trial matching before 09:00:00 (speculative bid/ask) -> fall back to Yahoo
      const tStr = typeof entry?.t === 'string' ? entry.t.trim() : '';
      const hasValidTime = /^\d{2}:\d{2}:\d{2}$/.test(tStr);
      if (hasValidTime && tStr < '09:00:00') {
        continue;
      }

      const yNum = Number(entry?.y);
      const validY = Number.isFinite(yNum) && yNum > 0 ? roundStockPrice(yNum) : null;

      // 1. Latest trade price z
      const zNum = entry?.z && entry.z !== '-' ? Number(entry.z) : NaN;
      const validZ = Number.isFinite(zNum) && zNum > 0 ? roundStockPrice(zNum) : null;

      // Opening price o
      const oNum = entry?.o && entry.o !== '-' ? Number(entry.o) : NaN;
      const validO = Number.isFinite(oNum) && oNum > 0 ? roundStockPrice(oNum) : null;

      // F3: Check cumulative daily volume v when neither z nor o traded today
      const rawV = entry?.v !== undefined && entry.v !== null ? String(entry.v).trim() : undefined;
      const isZeroVolume =
        rawV !== undefined &&
        (rawV === '-' || rawV === '' || (Number.isFinite(Number(rawV)) && Number(rawV) === 0));

      if (validZ === null && isZeroVolume && validO === null) {
        // Confirmed post-close zero-volume trading day: flat close at previousClose y (0% change)
        if (hasValidTime && tStr >= '13:30:00' && validY !== null) {
          return {
            price: validY,
            previousClose: validY,
          };
        }
        // Intraday with zero trades so far: do not fabricate a price from resting quotes -> let Yahoo take over
        continue;
      }

      let price: number | null = validZ;

      // F2/F3: From the closing call auction (13:25) onwards, resting bid/ask are trial or leftover quotes, not
      // traded prices. Without a trade price, let Yahoo (daily close) take over instead of writing a midpoint.
      if (price === null && hasValidTime && tStr >= '13:25:00') {
        continue;
      }

      // 2. When z === '-' (e.g., 5s snapshot without trade), try best bid/ask (b / a)
      if (price === null) {
        const bestBid = parseFirstMisBookPrice(entry?.b);
        const bestAsk = parseFirstMisBookPrice(entry?.a);
        if (bestBid !== null && bestAsk !== null) {
          price = roundStockPrice((bestBid + bestAsk) / 2);
        } else {
          price = bestBid ?? bestAsk;
        }
      }

      // 3. Fallback to opening price o
      if (price === null && validO !== null) {
        price = validO;
      }

      // 4. Never fall back to previousClose y as live price — return null so Yahoo Finance takes over
      if (price !== null && price > 0) {
        return {
          price,
          previousClose: validY,
        };
      }
    }
  } catch {
    // Fall through to Yahoo Finance
  }
  return null;
}

export async function fetchStockQuote(
  rawTicker: string,
  fetchImpl: FetchLike = fetch,
  hint?: TickerHint
): Promise<StockQuoteResult | null> {
  const norm = normalizeMarketTicker(rawTicker, hint);
  if (!norm) return null;

  if (norm.market === 'US') {
    const yfQuote = await fetchYahooChartQuote(norm.yahooSymbol, fetchImpl);
    if (yfQuote !== null) return yfQuote;
    if (norm.stooqSymbol) {
      return fetchStooqUsQuote(norm.stooqSymbol, fetchImpl);
    }
    return null;
  }

  // Taiwan market: Primary TWSE/TPEx MIS -> Fallback Yahoo Finance (.TW / .TWO)
  if (TW_NUMERIC_CODE_RE.test(norm.code)) {
    const twseQuote = await fetchTwseMisQuote(norm.code, norm.twseExchange, fetchImpl);
    if (twseQuote !== null) return twseQuote;
    // v1.12.1: record the fallback so a wrong quote can be traced to its source in Workers Logs
    console.warn(`[market] ${norm.code}: TWSE MIS returned no usable quote; falling back to Yahoo Finance`);
  }

  const yfPrimary = await fetchYahooChartQuote(norm.yahooSymbol, fetchImpl);
  if (yfPrimary !== null) return yfPrimary;

  if (norm.yahooFallbackSymbol && norm.yahooFallbackSymbol !== norm.yahooSymbol) {
    const yfFallback = await fetchYahooChartQuote(norm.yahooFallbackSymbol, fetchImpl);
    if (yfFallback !== null) return yfFallback;
  }

  return null;
}

export async function fetchUsStockPrice(
  rawTicker: string,
  fetchImpl: FetchLike = fetch
): Promise<number | null> {
  const quote = await fetchStockQuote(rawTicker, fetchImpl, {
    currency: 'USD',
    subCategory: '美股/ETF',
  });
  return quote ? quote.price : null;
}

export async function fetchStockPrice(
  rawTicker: string,
  fetchImpl: FetchLike = fetch,
  hint?: TickerHint
): Promise<number | null> {
  const quote = await fetchStockQuote(rawTicker, fetchImpl, hint);
  return quote ? quote.price : null;
}

/**
 * Legacy helper retained for backwards compatibility. Supports both TW and US tickers.
 */
export async function fetchTaiwanStockPrice(
  rawTicker: string,
  fetchImpl: FetchLike = fetch
): Promise<number | null> {
  return fetchStockPrice(rawTicker, fetchImpl);
}

/**
 * H6 (v1.8.13): outbound requests of one Worker invocation are capped (Workers Free: 50 external subrequests).
 * The returned fetch counts requests, adds an AbortSignal timeout to every request, and refuses (throws) once the
 * budget is used up; callers already treat a failed request as "no quote".
 */
export const MARKET_FETCH_TIMEOUT_MS = 8000;
/** Most requests one quote lookup can make (TW: MIS + Yahoo hosts + 1d previous-close + .TWO fallback). */
export const MAX_FETCHES_PER_QUOTE = 8;
/** Most requests the FX lookup can make (open.er-api + two Yahoo hosts). */
export const MAX_FETCHES_FOR_FX = 3;

export interface FetchBudget {
  fetch: FetchLike;
  used(): number;
  remaining(): number;
}

export function createBudgetedFetch(
  fetchImpl: FetchLike | typeof fetch,
  limit: number,
  timeoutMs = MARKET_FETCH_TIMEOUT_MS
): FetchBudget {
  let used = 0;
  const budgeted: FetchLike = async (input, init) => {
    if (used >= limit) throw new Error('subrequest budget exhausted for this invocation');
    used += 1;
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
    return (fetchImpl as FetchLike)(input, { ...(init || {}), signal });
  };
  return { fetch: budgeted, used: () => used, remaining: () => Math.max(0, limit - used) };
}

export async function refreshMarketData(
  db: D1Database,
  fetchImpl: FetchLike = fetch,
  targetUserId?: string,
  opts?: {
    forceFx?: boolean;
    marketScope?: 'all' | 'tw' | 'us';
    assetIds?: string[];
    /** H6: stop before a quote lookup that might not fit the remaining subrequests */
    fetchBudget?: { remaining(): number };
    /** H6: stop before the next D1 write when the per-invocation D1 query budget is nearly used */
    shouldStop?: () => boolean;
  }
): Promise<{
  usdTwdRate: number;
  fxUpdated: boolean;
  updatedAt: string;
  updatedTickers: Array<{ id: string; ticker: string; price: number; previousClose?: number }>;
  failedTickers: string[];
  /** H6: auto-updated assets left for the next run because the budget ran out */
  deferredCount?: number;
}> {
  const nowIso = new Date().toISOString();
  const marketScope = opts?.marketScope ?? 'all';
  let usdTwdRate = 32.5;
  let targetAutoFx = true;

  if (targetUserId) {
    const settings = await ensureAppSettings(db, targetUserId);
    usdTwdRate = settings.usdTwdRate;
    targetAutoFx = settings.autoFxEnabled !== false;
  }

  let fxUpdated = false;
  // Q8: a targeted refresh (specific asset ids, e.g. right after a ticker replacement) only needs the quotes.
  const assetIdFilter =
    targetUserId && Array.isArray(opts?.assetIds) && opts!.assetIds.length > 0 ? new Set(opts!.assetIds) : null;
  const shouldFetchFx = assetIdFilter
    ? Boolean(opts?.forceFx)
    : targetUserId
      ? targetAutoFx || Boolean(opts?.forceFx)
      : true;
  const fxFits = !opts?.fetchBudget || opts.fetchBudget.remaining() >= MAX_FETCHES_FOR_FX;
  const liveFxMap = shouldFetchFx && fxFits ? await fetchAllTwdFxRates(fetchImpl) : null;
  const liveFx = liveFxMap?.USD ?? null;
  if (liveFx !== null && liveFxMap) {
    usdTwdRate = liveFx;
    fxUpdated = true;
    const fxRows: Array<{ user_id: string; fx_rates_json?: string | null; hasFxCol: boolean }> = [];
    if (targetUserId) {
      const row = await db
        .prepare('SELECT * FROM app_settings WHERE user_id = ?')
        .bind(targetUserId)
        .first<Record<string, unknown>>();
      fxRows.push({
        user_id: targetUserId,
        fx_rates_json: (row?.fx_rates_json as string | null) ?? null,
        hasFxCol: row ? 'fx_rates_json' in row : false,
      });
    } else {
      const eligible = await db
        .prepare(
          `SELECT a.* FROM app_settings a
           INNER JOIN users u ON u.id = a.user_id
           WHERE u.is_active = 1 AND COALESCE(a.auto_fx_enabled, 1) = 1`
        )
        .all<Record<string, unknown>>();
      for (const r of eligible.results) {
        fxRows.push({
          user_id: String(r.user_id),
          fx_rates_json: (r.fx_rates_json as string | null) ?? null,
          hasFxCol: 'fx_rates_json' in r,
        });
      }
    }

    for (const row of fxRows) {
      if (opts?.shouldStop?.()) break;
      const uid = row.user_id;
      if (row.hasFxCol) {
        const mergedRates = normalizeFxRates(
          { ...normalizeFxRates(row.fx_rates_json, usdTwdRate), ...liveFxMap, USD: usdTwdRate },
          usdTwdRate
        );
        const mergedJson = JSON.stringify(mergedRates);
        await db.batch([
          db
            .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
            .bind(uid, nowIso),
          db
            .prepare(
              `UPDATE app_settings
               SET usd_twd_rate = ?, fx_rates_json = ?, fx_updated_at = ?, updated_at = ?, version = version + 1,
                   change_seq = COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0) + 1
               WHERE user_id = ? AND (usd_twd_rate IS NOT ? OR fx_rates_json IS NOT ? OR fx_updated_at IS NULL)`
            )
            .bind(usdTwdRate, mergedJson, nowIso, nowIso, uid, uid, usdTwdRate, mergedJson),
          db
            .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
            .bind(nowIso, uid),
        ]);
      } else {
        await db.batch([
          db
            .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
            .bind(uid, nowIso),
          db
            .prepare(
              `UPDATE app_settings
               SET usd_twd_rate = ?, fx_updated_at = ?, updated_at = ?, version = version + 1,
                   change_seq = COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0) + 1
               WHERE user_id = ? AND (usd_twd_rate IS NOT ? OR fx_updated_at IS NULL)`
            )
            .bind(usdTwdRate, nowIso, nowIso, uid, uid, usdTwdRate),
          db
            .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
            .bind(nowIso, uid),
        ]);
      }
    }
  }

  const autoAssets = targetUserId
    ? await db
        .prepare(
          `SELECT user_id, id, ticker, sub_category, currency FROM asset_items
           WHERE user_id = ? AND update_mode = '自動更新' AND ticker != '' AND deleted_at IS NULL
           ORDER BY quote_checked_at IS NOT NULL, quote_checked_at ASC, rowid ASC`
        )
        .bind(targetUserId)
        .all<{ user_id: string; id: string; ticker: string; sub_category?: string; currency?: string }>()
    : await db
        .prepare(
          `SELECT user_id, id, ticker, sub_category, currency FROM asset_items
           WHERE user_id IN (SELECT id FROM users WHERE is_active = 1)
             AND update_mode = '自動更新' AND ticker != '' AND deleted_at IS NULL
           ORDER BY quote_checked_at IS NOT NULL, quote_checked_at ASC, rowid ASC`
        )
        .all<{ user_id: string; id: string; ticker: string; sub_category?: string; currency?: string }>();

  // Deduplicate quote lookups across users/holdings/watchlist using canonical market:symbol key
  const quoteCache = new Map<string, StockQuoteResult | null>();
  const updatedTickers: Array<{ id: string; ticker: string; price: number; previousClose?: number }> = [];
  const failedTickers: string[] = [];
  let deferredCount = 0;
  let stopped = false;
  const attempted = new Map<string, string[]>(); // user_id -> asset ids looked up in this run

  for (const item of autoAssets.results) {
    if (stopped) {
      deferredCount += 1;
      continue;
    }
    if (assetIdFilter && !assetIdFilter.has(item.id)) {
      continue;
    }
    const hint: TickerHint = {
      subCategory: item.sub_category,
      currency: item.currency,
    };
    const norm = normalizeMarketTicker(item.ticker, hint);
    if (marketScope === 'us' && norm?.market !== 'US') {
      continue;
    }
    if (marketScope === 'tw' && norm?.market !== 'TW') {
      continue;
    }
    const cacheKey = norm ? `${norm.market}:${norm.yahooSymbol}` : item.ticker.trim().toUpperCase();

    let quote: StockQuoteResult | null;
    if (quoteCache.has(cacheKey)) {
      quote = quoteCache.get(cacheKey) ?? null;
    } else {
      if (opts?.fetchBudget && opts.fetchBudget.remaining() < MAX_FETCHES_PER_QUOTE) {
        // H6: not enough subrequests left for a full lookup — leave this (and the rest) for the next run
        stopped = true;
        deferredCount += 1;
        continue;
      }
      quote = await fetchStockQuote(item.ticker, fetchImpl, hint);
      quoteCache.set(cacheKey, quote);
    }

    attempted.set(item.user_id, [...(attempted.get(item.user_id) || []), item.id]);

    if (quote !== null) {
      if (opts?.shouldStop?.()) {
        stopped = true;
        deferredCount += 1;
        continue;
      }
      await db.batch([
        db
          .prepare('INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch, updated_at) VALUES (?, 0, 1, ?)')
          .bind(item.user_id, nowIso),
        db
          .prepare(
            // Q7 / F7: unit_price / previous_close / price_updated_at are server-owned quote fields.
            // Do NOT bump `version` here: version is the optimistic lock for USER edits, and bumping it on every
            // scheduled quote refresh made any offline edit (cost basis, note…) of an auto-updated holding conflict.
            // Pulls are driven by change_seq, so clients still receive the new quote. User edits that omit the
            // quote fields (F4) never overwrite them on the server.
            `UPDATE asset_items
             SET unit_price = ?, previous_close = ?, price_updated_at = ?, updated_at = ?,
                 change_seq = COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0) + 1
             WHERE user_id = ? AND id = ?
               AND (unit_price IS NOT ? OR previous_close IS NOT ? OR price_updated_at IS NULL)`
          )
          .bind(
            quote.price,
            quote.previousClose,
            nowIso,
            nowIso,
            item.user_id,
            item.user_id,
            item.id,
            quote.price,
            quote.previousClose
          ),
        db
          .prepare('UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0')
          .bind(nowIso, item.user_id),
      ]);
      updatedTickers.push({
        id: item.id,
        ticker: item.ticker,
        price: quote.price,
        ...(quote.previousClose !== null ? { previousClose: quote.previousClose } : {}),
      });
    } else {
      failedTickers.push(item.ticker);
    }
  }

  // v1.8.13 review: stamp every attempted asset (success or failure) in ONE batch so the next run starts with the
  // ones not tried for the longest time
  if (attempted.size > 0) {
    const stamps: D1PreparedStatement[] = [];
    for (const [uid, ids] of attempted) {
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        stamps.push(
          db
            .prepare(
              `UPDATE asset_items SET quote_checked_at = ? WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
            )
            .bind(nowIso, uid, ...chunk)
        );
      }
    }
    try {
      await db.batch(stamps);
    } catch (err) {
      console.error('[market] quote rotation stamp failed:', err);
    }
  }

  return { usdTwdRate, fxUpdated, updatedAt: nowIso, updatedTickers, failedTickers, deferredCount };
}
