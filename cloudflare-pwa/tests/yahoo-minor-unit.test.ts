/**
 * v1.12.6：Yahoo 對倫敦交易所多以便士（meta.currency = 'GBp' / 'GBX'）報價，持股以英鎊計價，
 * 必須換算成英鎊後再寫入，否則市值被高估 100 倍。分析見 docs/reviews/2026-11-27_v1.12.5_review.md。
 */
import { describe, expect, it } from 'vitest';
import { fetchStockQuote, type FetchLike } from '../worker/market';

const GBP_HINT = { currency: 'GBP' };

/** UTC 時間戳：倫敦日 K 約 08:00 UTC，收盤 16:30 UTC */
function ts(ymd: string, h: number, m = 0): number {
  const [y, mo, d] = ymd.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, h, m) / 1000;
}

function yahoo5d(currency: string | undefined, bars: Array<[string, number]>, price: number, marketDay: string) {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            regularMarketTime: ts(marketDay, 16, 30),
            gmtoffset: 0,
            ...(currency !== undefined ? { currency } : {}),
          },
          timestamp: bars.map(([d]) => ts(d, 8)),
          indicators: { quote: [{ close: bars.map(([, c]) => c) }] },
        },
      ],
    },
  };
}

function mkFetch(json5d: unknown, json1d?: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url: string) => {
    urls.push(url);
    if (url.includes('range=1d')) {
      return new Response(JSON.stringify(json1d ?? { chart: { result: [{ meta: {} }] } }), { status: 200 });
    }
    if (url.includes('finance.yahoo.com')) return new Response(JSON.stringify(json5d), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, urls };
}

describe('Yahoo 以貨幣輔幣單位報價（英國便士）', () => {
  it('GBp：現價與昨收都換算成英鎊（70.24p → £0.7024）', async () => {
    const { fetchImpl, urls } = mkFetch(
      yahoo5d(
        'GBp',
        [
          ['2026-11-25', 69.5],
          ['2026-11-26', 70.1],
          ['2026-11-27', 70.24],
        ],
        70.24,
        '2026-11-27'
      )
    );
    const q = await fetchStockQuote('VOD', fetchImpl, GBP_HINT);
    expect(urls.some((u) => u.includes('VOD.L'))).toBe(true);
    expect(q).toEqual({ price: 0.7024, previousClose: 0.701 });
  });

  it('GBX（大寫寫法）同樣換算；價格 ≥ £1 時保留 2 位小數', async () => {
    const { fetchImpl } = mkFetch(
      yahoo5d(
        'GBX',
        [
          ['2026-11-26', 1230.0],
          ['2026-11-27', 1234.5],
        ],
        1234.5,
        '2026-11-27'
      )
    );
    const q = await fetchStockQuote('SHEL.L', fetchImpl, GBP_HINT);
    expect(q).toEqual({ price: 12.35, previousClose: 12.3 });
  });

  it('昨收改由 range=1d 取得時也以便士計，同樣換算', async () => {
    const { fetchImpl } = mkFetch(
      yahoo5d(
        'GBp',
        [
          ['2026-11-24', 69.0],
          ['2026-11-25', 69.5],
          ['2026-11-27', 70.24],
        ],
        70.24,
        '2026-11-27'
      ),
      { chart: { result: [{ meta: { previousClose: 70.1, regularMarketTime: ts('2026-11-27', 16, 30), gmtoffset: 0 } }] } }
    );
    const q = await fetchStockQuote('VOD', fetchImpl, GBP_HINT);
    expect(q).toEqual({ price: 0.7024, previousClose: 0.701 });
  });

  it('以英鎊（GBP）報價的標的不換算', async () => {
    const { fetchImpl } = mkFetch(
      yahoo5d(
        'GBP',
        [
          ['2026-11-26', 98.5],
          ['2026-11-27', 99.1],
        ],
        99.1,
        '2026-11-27'
      )
    );
    const q = await fetchStockQuote('VUSA.L', fetchImpl, GBP_HINT);
    expect(q).toEqual({ price: 99.1, previousClose: 98.5 });
  });

  it('沒有 meta.currency 或其他幣別時不換算（美股不受影響）', async () => {
    const { fetchImpl } = mkFetch(
      yahoo5d(
        undefined,
        [
          ['2026-11-25', 495.0],
          ['2026-11-26', 500.0],
        ],
        502.0,
        '2026-11-26'
      )
    );
    const q = await fetchStockQuote('VOO', fetchImpl, { subCategory: '美股/ETF', currency: 'USD' });
    expect(q).toEqual({ price: 502, previousClose: 495 });
  });
});
