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

  // 5. Bare Taiwan stock / ETF / Bond ETF numeric code (e.g. 2330, 0050, 00679B, 2881B)
  const hintIsUs = hint?.subCategory === '美股/ETF' || hint?.currency === 'USD';
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

export async function fetchUsdTwdRate(fetchImpl: FetchLike = fetch): Promise<number | null> {
  // Primary: Open Exchange Rates (free, no key required)
  try {
    const res = await fetchImpl('https://open.er-api.com/v6/latest/USD', {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const json = (await res.json()) as { rates?: { TWD?: number } };
      const rate = Number(json?.rates?.TWD);
      if (Number.isFinite(rate) && rate > 10 && rate < 100) {
        return Math.round(rate * 10000) / 10000;
      }
    }
  } catch {
    // Fallback below
  }

  // Fallback: Yahoo Finance TWD=X (query1 -> query2)
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
          return Math.round(rate * 10000) / 10000;
        }
      }
    } catch {
      // Try next host
    }
  }

  return null;
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
        candidate = Number(meta?.previousClose ?? meta?.chartPreviousClose);
      }

      if (Number.isFinite(candidate) && candidate > 0) {
        let prevClose: number | null = null;
        const gmtOffset = Number.isFinite(Number(meta?.gmtoffset)) ? Number(meta?.gmtoffset) : 0;
        const marketTime = Number(meta?.regularMarketTime);

        if (validPairs.length >= 2) {
          const lastPair = validPairs[validPairs.length - 1];
          if (Number.isFinite(marketTime) && marketTime > 0 && lastPair.ts !== null) {
            const marketDay = formatUtcOffsetDateKey(marketTime, gmtOffset);
            const lastBarDay = formatUtcOffsetDateKey(lastPair.ts, gmtOffset);
            prevClose =
              marketDay > lastBarDay
                ? lastPair.close
                : validPairs[validPairs.length - 2].close;
          } else {
            prevClose = validPairs[validPairs.length - 2].close;
          }
        } else if (validPairs.length === 1) {
          const lastPair = validPairs[0];
          if (
            Number.isFinite(marketTime) &&
            marketTime > 0 &&
            lastPair.ts !== null &&
            formatUtcOffsetDateKey(marketTime, gmtOffset) > formatUtcOffsetDateKey(lastPair.ts, gmtOffset)
          ) {
            prevClose = lastPair.close;
          }
        }

        if (prevClose === null) {
          const metaPrev = Number(meta?.previousClose);
          if (Number.isFinite(metaPrev) && metaPrev > 0) {
            prevClose = metaPrev;
          } else if (validPairs.length <= 1) {
            const chartPrev = Number(meta?.chartPreviousClose);
            if (Number.isFinite(chartPrev) && chartPrev > 0) {
              prevClose = chartPrev;
            }
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
    const json = (await res.json()) as { msgArray?: Array<{ z?: string; y?: string }> };
    const entries = json?.msgArray || [];
    for (const entry of entries) {
      const yNum = Number(entry?.y);
      const validY = Number.isFinite(yNum) && yNum > 0 ? roundStockPrice(yNum) : null;
      const zNum = entry?.z && entry.z !== '-' ? Number(entry.z) : NaN;
      const validZ = Number.isFinite(zNum) && zNum > 0 ? roundStockPrice(zNum) : null;
      const price = validZ ?? validY;
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

export async function refreshMarketData(
  db: D1Database,
  fetchImpl: FetchLike = fetch,
  targetUserId?: string
): Promise<{
  usdTwdRate: number;
  fxUpdated: boolean;
  updatedAt: string;
  updatedTickers: Array<{ id: string; ticker: string; price: number; previousClose?: number }>;
  failedTickers: string[];
}> {
  const nowIso = new Date().toISOString();
  let usdTwdRate = 32.5;

  if (targetUserId) {
    const settings = await ensureAppSettings(db, targetUserId);
    usdTwdRate = settings.usdTwdRate;
  }

  let fxUpdated = false;
  const liveFx = await fetchUsdTwdRate(fetchImpl);
  if (liveFx !== null) {
    usdTwdRate = liveFx;
    fxUpdated = true;
    if (targetUserId) {
      await db
        .prepare('UPDATE app_settings SET usd_twd_rate = ?, fx_updated_at = ?, updated_at = ? WHERE user_id = ?')
        .bind(usdTwdRate, nowIso, nowIso, targetUserId)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE app_settings
           SET usd_twd_rate = ?, fx_updated_at = ?, updated_at = ?
           WHERE user_id IN (SELECT id FROM users WHERE is_active = 1)`
        )
        .bind(usdTwdRate, nowIso, nowIso)
        .run();
    }
  }

  const autoAssets = targetUserId
    ? await db
        .prepare(
          `SELECT user_id, id, ticker, sub_category, currency FROM asset_items
           WHERE user_id = ? AND update_mode = '自動更新' AND ticker != '' AND deleted_at IS NULL`
        )
        .bind(targetUserId)
        .all<{ user_id: string; id: string; ticker: string; sub_category?: string; currency?: string }>()
    : await db
        .prepare(
          `SELECT user_id, id, ticker, sub_category, currency FROM asset_items
           WHERE user_id IN (SELECT id FROM users WHERE is_active = 1)
             AND update_mode = '自動更新' AND ticker != '' AND deleted_at IS NULL`
        )
        .all<{ user_id: string; id: string; ticker: string; sub_category?: string; currency?: string }>();

  // Deduplicate quote lookups across users/holdings/watchlist using canonical market:symbol key
  const quoteCache = new Map<string, StockQuoteResult | null>();
  const updatedTickers: Array<{ id: string; ticker: string; price: number; previousClose?: number }> = [];
  const failedTickers: string[] = [];

  for (const item of autoAssets.results) {
    const hint: TickerHint = {
      subCategory: item.sub_category,
      currency: item.currency,
    };
    const norm = normalizeMarketTicker(item.ticker, hint);
    const cacheKey = norm ? `${norm.market}:${norm.yahooSymbol}` : item.ticker.trim().toUpperCase();

    let quote: StockQuoteResult | null;
    if (quoteCache.has(cacheKey)) {
      quote = quoteCache.get(cacheKey) ?? null;
    } else {
      quote = await fetchStockQuote(item.ticker, fetchImpl, hint);
      quoteCache.set(cacheKey, quote);
    }

    if (quote !== null) {
      await db
        .prepare(
          `UPDATE asset_items
           SET unit_price = ?, previous_close = COALESCE(?, previous_close), price_updated_at = ?, updated_at = ?
           WHERE user_id = ? AND id = ?`
        )
        .bind(quote.price, quote.previousClose, nowIso, nowIso, item.user_id, item.id)
        .run();
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

  return { usdTwdRate, fxUpdated, updatedAt: nowIso, updatedTickers, failedTickers };
}
