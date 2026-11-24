import { ensureAppSettings } from './sync';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function normalizeTaiwanTicker(rawTicker: string): { code: string; yahooSymbol: string } | null {
  const cleaned = String(rawTicker || '').trim().toUpperCase();
  if (!cleaned) return null;

  const tpeMatch = /^TPE:([A-Z0-9]+)$/.exec(cleaned);
  if (tpeMatch) {
    return { code: tpeMatch[1], yahooSymbol: `${tpeMatch[1]}.TW` };
  }

  const twMatch = /^([A-Z0-9]+)\.(TW|TWO)$/.exec(cleaned);
  if (twMatch) {
    return { code: twMatch[1], yahooSymbol: cleaned };
  }

  if (/^\d{4,6}[A-Z]?$/.test(cleaned)) {
    return { code: cleaned, yahooSymbol: `${cleaned}.TW` };
  }

  return { code: cleaned, yahooSymbol: cleaned };
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

  // Fallback: Yahoo Finance TWD=X
  try {
    const res = await fetchImpl('https://query1.finance.yahoo.com/v8/finance/chart/TWD=X?interval=1d&range=1d', {
      headers: { Accept: 'application/json', 'User-Agent': 'personal-finance-pwa/1.0' },
    });
    if (res.ok) {
      const json = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
      const rate = Number(json?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (Number.isFinite(rate) && rate > 10 && rate < 100) {
        return Math.round(rate * 10000) / 10000;
      }
    }
  } catch {
    // Preserve previous value
  }

  return null;
}

export async function fetchTaiwanStockPrice(
  rawTicker: string,
  fetchImpl: FetchLike = fetch
): Promise<number | null> {
  const norm = normalizeTaiwanTicker(rawTicker);
  if (!norm) return null;

  // Primary: TWSE MIS real-time / last close API (for TW stock codes)
  if (/^\d{4,6}[A-Z]?$/.test(norm.code)) {
    try {
      const twseUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${norm.code}.tw&json=1&delay=0`;
      const res = await fetchImpl(twseUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'personal-finance-pwa/1.0' },
      });
      if (res.ok) {
        const json = (await res.json()) as { msgArray?: Array<{ z?: string; y?: string }> };
        const entry = json?.msgArray?.[0];
        const price = Number(entry?.z && entry.z !== '-' ? entry.z : entry?.y);
        if (Number.isFinite(price) && price > 0) {
          return Math.round(price * 100) / 100;
        }
      }
    } catch {
      // Fall through to Yahoo Finance
    }
  }

  // Fallback: Yahoo Finance Chart API
  try {
    const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(norm.yahooSymbol)}?interval=1d&range=1d`;
    const res = await fetchImpl(yfUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'personal-finance-pwa/1.0' },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> };
      };
      const meta = json?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice ?? meta?.previousClose);
      if (Number.isFinite(price) && price > 0) {
        return Math.round(price * 100) / 100;
      }
    }
  } catch {
    // Preserve previous value
  }

  return null;
}

export async function refreshMarketData(
  db: D1Database,
  fetchImpl: FetchLike = fetch
): Promise<{
  usdTwdRate: number;
  fxUpdated: boolean;
  updatedTickers: Array<{ id: string; ticker: string; price: number }>;
  failedTickers: string[];
}> {
  const settings = await ensureAppSettings(db);
  const nowIso = new Date().toISOString();

  let usdTwdRate = settings.usdTwdRate;
  let fxUpdated = false;
  const liveFx = await fetchUsdTwdRate(fetchImpl);
  if (liveFx !== null) {
    usdTwdRate = liveFx;
    fxUpdated = true;
    await db
      .prepare('UPDATE app_settings SET usd_twd_rate = ?, fx_updated_at = ?, updated_at = ? WHERE id = 1')
      .bind(usdTwdRate, nowIso, nowIso)
      .run();
  }

  const autoAssets = await db
    .prepare(
      `SELECT id, ticker FROM asset_items
       WHERE update_mode = '自動更新' AND ticker != '' AND deleted_at IS NULL`
    )
    .all<{ id: string; ticker: string }>();

  const updatedTickers: Array<{ id: string; ticker: string; price: number }> = [];
  const failedTickers: string[] = [];

  for (const item of autoAssets.results) {
    const price = await fetchTaiwanStockPrice(item.ticker, fetchImpl);
    if (price !== null) {
      await db
        .prepare('UPDATE asset_items SET unit_price = ?, price_updated_at = ?, updated_at = ? WHERE id = ?')
        .bind(price, nowIso, nowIso, item.id)
        .run();
      updatedTickers.push({ id: item.id, ticker: item.ticker, price });
    } else {
      failedTickers.push(item.ticker);
    }
  }

  return { usdTwdRate, fxUpdated, updatedTickers, failedTickers };
}
