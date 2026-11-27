/**
 * 重現測試：台股改走 Yahoo 報價時，昨收可能取到兩天前的收盤，使漲跌方向相反。
 * 分析見 docs/reviews/2026-11-27_prev_close_direction_review.md。
 *
 * it.fails：bug 仍存在時本測試「預期失敗」；修好後請改回 it。
 *
 * 模擬行情：11/25 收 88.90、11/26 收 92.40、11/27（今天）收 91.00 → 今天應為下跌 -1.40。
 * 正確的昨收是 92.40；若無法確認上一個交易日，應回傳 null（畫面顯示「待更新」），不可回傳 88.90。
 */
import { describe, expect, it } from 'vitest';
import { fetchStockQuote, type FetchLike } from '../worker/market';

const TW_HINT = { subCategory: '台股', currency: 'TWD' };
const TODAY = '2026-11-27';

/** Yahoo 台股日 K 的時間戳約為當地 09:00（UTC 01:00） */
function barTs(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 1) / 1000;
}

/** regularMarketTime：當地 13:30（UTC 05:30） */
function marketTs(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 5, 30) / 1000;
}

function yahoo5d(bars: Array<[string, number | null]>, price: number, marketDay: string) {
  return {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: price, regularMarketTime: marketTs(marketDay), gmtoffset: 28800 },
          timestamp: bars.map(([d]) => barTs(d)),
          indicators: { quote: [{ close: bars.map(([, c]) => c) }] },
        },
      ],
    },
  };
}

/**
 * mis：TWSE MIS 回應（null = MIS 失敗，改走 Yahoo）
 * yahoo1dPrev：range=1d 的 meta.previousClose（undefined = 不提供）
 */
function mkFetch(opts: { yahoo?: unknown; mis?: unknown; yahoo1dPrev?: number }): FetchLike {
  return async (url: string) => {
    if (url.includes('mis.twse.com.tw')) {
      return opts.mis ? new Response(JSON.stringify(opts.mis), { status: 200 }) : new Response('unavailable', { status: 503 });
    }
    if (url.includes('range=1d')) {
      const meta =
        opts.yahoo1dPrev !== undefined
          ? { previousClose: opts.yahoo1dPrev, regularMarketTime: marketTs(TODAY), gmtoffset: 28800 }
          : {};
      return new Response(JSON.stringify({ chart: { result: [{ meta }] } }), { status: 200 });
    }
    if (url.includes('range=5d') && opts.yahoo) {
      return new Response(JSON.stringify(opts.yahoo), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

/** 昨收只能是正確的 92.40，或無法確認時的 null；絕不能是兩天前的 88.90 */
function expectSafePreviousClose(q: { price: number; previousClose: number | null } | null) {
  expect(q).not.toBeNull();
  expect(q!.price).toBe(91);
  expect([92.4, null]).toContain(q!.previousClose);
}

describe('昨收漲跌方向：Yahoo 日 K 缺漏時的昨收（2026-11-27 使用者回報）', () => {
  describe('對照組（目前行為正確）', () => {
    it('MIS 正常：昨收取 MIS 的 y', async () => {
      const mis = { msgArray: [{ z: '91.00', y: '92.40', o: '92.00', v: '35000', t: '13:30:00' }] };
      const q = await fetchStockQuote('0050', mkFetch({ mis }), TW_HINT);
      expect(q).toEqual({ price: 91, previousClose: 92.4 });
    });

    it('MIS 收盤後沒有成交價（z 為 -）改走 Yahoo，且 Yahoo 日 K 完整：昨收正確', async () => {
      const mis = { msgArray: [{ z: '-', y: '92.40', o: '92.00', v: '35000', t: '13:30:00', b: '90.95_', a: '91.00_' }] };
      const yahoo = yahoo5d(
        [
          ['2026-11-25', 88.9],
          ['2026-11-26', 92.4],
          [TODAY, 91.0],
        ],
        91.0,
        TODAY
      );
      const q = await fetchStockQuote('0050', mkFetch({ mis, yahoo }), TW_HINT);
      expect(q).toEqual({ price: 91, previousClose: 92.4 });
    });

    it('MIS 失敗、Yahoo 日 K 完整：昨收正確', async () => {
      const yahoo = yahoo5d(
        [
          ['2026-11-25', 88.9],
          ['2026-11-26', 92.4],
          [TODAY, 91.0],
        ],
        91.0,
        TODAY
      );
      const q = await fetchStockQuote('0050', mkFetch({ yahoo }), TW_HINT);
      expect(q).toEqual({ price: 91, previousClose: 92.4 });
    });

    it('週一：上一根 K 棒是上週五，不應被誤判為缺漏', async () => {
      const yahoo = yahoo5d(
        [
          ['2026-11-26', 92.4],
          ['2026-11-27', 91.0],
          ['2026-11-30', 93.0],
        ],
        93.0,
        '2026-11-30'
      );
      const q = await fetchStockQuote('0050', mkFetch({ yahoo }), TW_HINT);
      expect(q).toEqual({ price: 93, previousClose: 91 });
    });
  });

  describe('Bug：昨收取到兩天前的收盤', () => {
    it.fails('Yahoo 缺昨天（11/26）的 K 棒：昨收不應是 11/25 的 88.90', async () => {
      const yahoo = yahoo5d(
        [
          ['2026-11-24', 88.0],
          ['2026-11-25', 88.9],
          [TODAY, 91.0],
        ],
        91.0,
        TODAY
      );
      const q = await fetchStockQuote('0050', mkFetch({ yahoo }), TW_HINT);
      // 目前回傳 previousClose = 88.90 → 顯示 +2.10（+2.36%），實際應為 -1.40
      expectSafePreviousClose(q);
    });

    it.fails('Yahoo 昨天的 K 棒收盤價為 null：昨收不應是 11/25 的 88.90', async () => {
      const yahoo = yahoo5d(
        [
          ['2026-11-25', 88.9],
          ['2026-11-26', null],
          [TODAY, 91.0],
        ],
        91.0,
        TODAY
      );
      const q = await fetchStockQuote('0050', mkFetch({ yahoo }), TW_HINT);
      expectSafePreviousClose(q);
    });

    it.fails('Yahoo 日 K 落後兩天（沒有昨天也沒有今天）：昨收不應是 11/25 的 88.90', async () => {
      const yahoo = yahoo5d(
        [
          ['2026-11-21', 87.5],
          ['2026-11-24', 88.0],
          ['2026-11-25', 88.9],
        ],
        91.0,
        TODAY
      );
      const q = await fetchStockQuote('0050', mkFetch({ yahoo }), TW_HINT);
      expectSafePreviousClose(q);
    });

    it.fails('Yahoo 缺昨天的 K 棒、但 range=1d 提供正確昨收：應採用 range=1d 的 92.40', async () => {
      const yahoo = yahoo5d(
        [
          ['2026-11-24', 88.0],
          ['2026-11-25', 88.9],
          [TODAY, 91.0],
        ],
        91.0,
        TODAY
      );
      const q = await fetchStockQuote('0050', mkFetch({ yahoo, yahoo1dPrev: 92.4 }), TW_HINT);
      expect(q).toEqual({ price: 91, previousClose: 92.4 });
    });
  });
});
