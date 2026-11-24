import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/index';
import { runMonthlyRecurringD1, runMonthEndSnapshotD1 } from '../worker/automation';
import { refreshMarketData, normalizeTaiwanTicker } from '../worker/market';
import { createTestD1 } from './helpers/mockD1';
import { CASHFLOW_TYPES } from '../shared/constants';
import type { WorkerEnv } from '../worker/types';

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = /pf_session=([^;]+)/.exec(setCookie);
  return match ? `pf_session=${match[1]}` : '';
}

describe('Cloudflare Worker API + D1 Integration', () => {
  let db: D1Database;
  let env: WorkerEnv;
  const app = createApp();

  beforeEach(() => {
    db = createTestD1();
    env = {
      DB: db,
      SETUP_SECRET: 'test-bootstrap-secret-123',
      APP_TIMEZONE: 'Asia/Taipei',
    };
  });

  async function setupAndGetCookie(): Promise<string> {
    const res = await app.request(
      'https://finance.example.com/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupSecret: 'test-bootstrap-secret-123',
          password: 'StrongPassword!2026',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const cookie = extractSessionCookie(res);
    expect(cookie).toContain('pf_session=');
    return cookie;
  }

  it('protects first-time setup with SETUP_SECRET and forbids re-initialization', async () => {
    const status0 = await app.request('https://finance.example.com/api/auth/status', {}, env);
    const status0Json = (await status0.json()) as Record<string, unknown>;
    expect(status0Json).toMatchObject({ initialized: false, authenticated: false });
    expect(status0Json.passkeys).toBeUndefined();

    // Wrong setup secret rejected
    const badSetup = await app.request(
      'https://finance.example.com/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupSecret: 'wrong', password: 'StrongPassword!2026' }),
      },
      env
    );
    expect(badSetup.status).toBe(403);

    // Valid setup succeeds and sets secure cookie
    const okSetup = await app.request(
      'https://finance.example.com/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupSecret: 'test-bootstrap-secret-123',
          password: 'StrongPassword!2026',
        }),
      },
      env
    );
    expect(okSetup.status).toBe(200);
    const setCookie = okSetup.headers.get('set-cookie') || '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    // Second setup attempt permanently rejected
    const secondSetup = await app.request(
      'https://finance.example.com/api/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupSecret: 'test-bootstrap-secret-123',
          password: 'AnotherPassword!2026',
        }),
      },
      env
    );
    expect(secondSetup.status).toBe(403);
  });

  it('enforces login rate limiting (429 after 5 failed attempts) and session revocation on logout', async () => {
    const cookie = await setupAndGetCookie();

    // Fail 5 times from same IP
    for (let i = 0; i < 5; i++) {
      const failRes = await app.request(
        'https://finance.example.com/api/auth/login',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '203.0.113.10',
          },
          body: JSON.stringify({ password: 'WrongPassword!' }),
        },
        env
      );
      expect(failRes.status).toBe(401);
    }

    // 6th attempt from same IP is rate limited even with right password
    const lockedRes = await app.request(
      'https://finance.example.com/api/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify({ password: 'StrongPassword!2026' }),
      },
      env
    );
    expect(lockedRes.status).toBe(429);

    // Logout revokes cookie
    const logoutRes = await app.request(
      'https://finance.example.com/api/auth/logout',
      { method: 'POST', headers: { cookie } },
      env
    );
    expect(logoutRes.status).toBe(200);

    const afterLogout = await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mutations: [] }),
      },
      env
    );
    expect(afterLogout.status).toBe(401);
  });

  it('applies /api/sync mutations idempotently, supports LWW and soft deletes', async () => {
    const cookie = await setupAndGetCookie();

    // Unauthenticated sync rejected
    const unauth = await app.request(
      'https://finance.example.com/api/sync',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mutations":[]}' },
      env
    );
    expect(unauth.status).toBe(401);

    const mutationId = 'mut-001';
    const recordId = 'log-uuid-1';
    const payload = {
      mutations: [
        {
          mutationId,
          entity: 'cashflow',
          op: 'upsert',
          recordId,
          clientTimestamp: '2026-11-23T08:00:00.000Z',
          payload: {
            date: '2026-11-23',
            type: CASHFLOW_TYPES.DAILY_EXPENSE,
            category: '餐飲',
            itemName: '牛肉麵',
            amount: 190,
            currency: 'TWD',
            fxRate: 1,
            source: '手機記帳',
            note: '離線同步',
          },
        },
      ],
    };

    const res1 = await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(payload),
      },
      env
    );
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as { ackedMutationIds: string[]; delta: { cashflowLogs: unknown[] } };
    expect(data1.ackedMutationIds).toEqual([mutationId]);
    expect(data1.delta.cashflowLogs).toHaveLength(1);

    // Retry exact same mutationId -> idempotent, still only 1 row
    const res2 = await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(payload),
      },
      env
    );
    expect(res2.status).toBe(200);
    const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM cashflow_logs').first<{ cnt: number }>();
    expect(countRow?.cnt).toBe(1);

    // Stale client update (older timestamp) should NOT overwrite newer server update
    await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: 'mut-002-newer',
              entity: 'cashflow',
              op: 'upsert',
              recordId,
              clientTimestamp: '2026-11-23T10:00:00.000Z',
              payload: {
                date: '2026-11-23',
                type: CASHFLOW_TYPES.DAILY_EXPENSE,
                category: '餐飲',
                itemName: '牛肉麵(新版)',
                amount: 210,
                currency: 'TWD',
                fxRate: 1,
                source: '手機記帳',
                note: '',
              },
            },
          ],
        }),
      },
      env
    );

    await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: 'mut-003-stale',
              entity: 'cashflow',
              op: 'upsert',
              recordId,
              clientTimestamp: '2026-11-23T09:00:00.000Z',
              payload: {
                date: '2026-11-23',
                type: CASHFLOW_TYPES.DAILY_EXPENSE,
                category: '餐飲',
                itemName: '牛肉麵(舊版)',
                amount: 150,
                currency: 'TWD',
                fxRate: 1,
                source: '手機記帳',
                note: '',
              },
            },
          ],
        }),
      },
      env
    );

    const rowAfterLww = await db
      .prepare('SELECT item_name, amount FROM cashflow_logs WHERE id = ?')
      .bind(recordId)
      .first<{ item_name: string; amount: number }>();
    expect(rowAfterLww?.item_name).toBe('牛肉麵(新版)');
    expect(rowAfterLww?.amount).toBe(210);

    // Soft delete works
    const delRes = await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: 'mut-004-del',
              entity: 'cashflow',
              op: 'delete',
              recordId,
              clientTimestamp: '2026-11-23T11:00:00.000Z',
            },
          ],
        }),
      },
      env
    );
    expect(delRes.status).toBe(200);
    const deletedRow = await db
      .prepare('SELECT deleted_at FROM cashflow_logs WHERE id = ?')
      .bind(recordId)
      .first<{ deleted_at: string | null }>();
    expect(deletedRow?.deleted_at).toBeTruthy();
  });

  it('runs monthly recurring idempotently and auto-deactivates one-time items', async () => {
    const nowIso = '2026-11-01T00:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO app_settings (id, monthly_daily_budget, emergency_target_months, usd_twd_rate, updated_at)
         VALUES (1, 45000, 6, 32.5, ?)`
      )
      .bind(nowIso)
      .run();

    await db
      .prepare(
        `INSERT INTO recurring_items (id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, created_at, updated_at)
         VALUES
           ('r1', 'Claude Pro', 'AI訂閱', '訂閱扣款', 20, 'USD', '月繳', '', '啟用', '', ?, ?),
           ('r2', '年終獎金', '獎金', '其他收入', 150000, 'TWD', '一次性', '2026-11', '啟用', '一次性測試', ?, ?),
           ('r3', '已停用訂閱', '影音', '訂閱扣款', 390, 'TWD', '月繳', '', '停用', '', ?, ?)`
      )
      .bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso)
      .run();

    const first = await runMonthlyRecurringD1(db, 2026, 11);
    expect(first.insertedCount).toBe(2);
    expect(first.skippedCount).toBe(0);
    expect(first.deactivatedOneTimeCount).toBe(1);

    // One-time item must now be deactivated
    const oneTime = await db
      .prepare('SELECT status, note FROM recurring_items WHERE id = ?')
      .bind('r2')
      .first<{ status: string; note: string }>();
    expect(oneTime?.status).toBe('停用');
    expect(oneTime?.note).toContain('2026-11');

    // Second run in same month inserts 0 and skips existing
    const second = await runMonthlyRecurringD1(db, 2026, 11);
    expect(second.insertedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
  });

  it('creates and updates month-end net worth snapshot accurately', async () => {
    const nowIso = '2026-11-30T15:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO app_settings (id, monthly_daily_budget, emergency_target_months, usd_twd_rate, updated_at)
         VALUES (1, 45000, 6, 32.0, ?)`
      )
      .bind(nowIso)
      .run();

    await db
      .prepare(
        `INSERT INTO asset_items (id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, note, created_at, updated_at)
         VALUES
           ('a1', '自動更新', '資產', '台股', '高流動', '0050', 'TPE:0050', 1000, 'TWD', 200, '', ?, ?),
           ('a2', '自動更新', '資產', '美金', '高流動', '美金存款', '', 1000, 'USD', 1, '', ?, ?),
           ('l1', '手動快照', '負債', '房貸餘額', '負債', '房貸', '', 50000, 'TWD', 1, '', ?, ?)`
      )
      .bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso)
      .run();

    const snap1 = await runMonthEndSnapshotD1(db, new Date('2026-11-30T15:00:00.000Z'));
    expect(snap1.yearMonth).toBe('2026-11');
    expect(snap1.totalAssets).toBe(232000);
    expect(snap1.totalLiabilities).toBe(50000);
    expect(snap1.netWorth).toBe(182000);
    expect(snap1.updated).toBe(false);

    // Re-running same month updates in place
    const snap2 = await runMonthEndSnapshotD1(db, new Date('2026-11-30T15:05:00.000Z'));
    expect(snap2.updated).toBe(true);
  });

  it('fetches market FX and TW stock prices with fallback and preserves prior values on total failure', async () => {
    expect(normalizeTaiwanTicker('TPE:0050')).toEqual({ code: '0050', yahooSymbol: '0050.TW' });
    expect(normalizeTaiwanTicker('2330.TW')).toEqual({ code: '2330', yahooSymbol: '2330.TW' });

    const nowIso = '2026-11-23T00:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO app_settings (id, monthly_daily_budget, emergency_target_months, usd_twd_rate, updated_at)
         VALUES (1, 45000, 6, 32.1, ?)`
      )
      .bind(nowIso)
      .run();
    await db
      .prepare(
        `INSERT INTO asset_items (id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, note, created_at, updated_at)
         VALUES ('a1', '自動更新', '資產', '台股', '高流動', '0050', 'TPE:0050', 1000, 'TWD', 190, '', ?, ?)`
      )
      .bind(nowIso, nowIso)
      .run();

    // Primary FX succeeds, primary TWSE fails -> falls back to Yahoo Finance
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 32.65 } }), { status: 200 });
      }
      if (url.includes('mis.twse.com.tw')) {
        return new Response('unavailable', { status: 503 });
      }
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response(
          JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 198.5 } }] } }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    });

    const marketRes = await refreshMarketData(db, fetchMock);
    expect(marketRes.usdTwdRate).toBe(32.65);
    expect(marketRes.updatedTickers).toEqual([{ id: 'a1', ticker: 'TPE:0050', price: 198.5 }]);

    // Total failure preserves previous valid values (never overwrites to 0)
    const failingFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const failRes = await refreshMarketData(db, failingFetch);
    expect(failRes.usdTwdRate).toBe(32.65);
    const assetRow = await db.prepare('SELECT unit_price FROM asset_items WHERE id = ?').bind('a1').first<{ unit_price: number }>();
    expect(assetRow?.unit_price).toBe(198.5);
  });

  it('exports and imports JSON backup via authenticated endpoints', async () => {
    const cookie = await setupAndGetCookie();

    const importRes = await app.request(
      'https://finance.example.com/api/import/json',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mode: 'merge',
          data: {
            settings: { monthlyDailyBudget: 52000, emergencyTargetMonths: 9, usdTwdRate: 32.4 },
            cashflowLogs: [
              {
                id: 'imp-1',
                date: '2026-11-15',
                yearMonth: '2026-11',
                type: CASHFLOW_TYPES.DAILY_EXPENSE,
                category: '餐飲',
                itemName: '匯入測試',
                amount: 300,
                currency: 'TWD',
                fxRate: 1,
                twdAmount: 300,
                source: '匯入',
                note: '',
              },
            ],
            recurringItems: [],
            sinkingItems: [],
            assetItems: [],
            netWorthHistory: [],
          },
        }),
      },
      env
    );
    expect(importRes.status).toBe(200);

    const exportRes = await app.request(
      'https://finance.example.com/api/export/json',
      { headers: { cookie } },
      env
    );
    expect(exportRes.status).toBe(200);
    const exported = (await exportRes.json()) as {
      data: { settings: { monthlyDailyBudget: number }; cashflowLogs: Array<{ id: string }> };
    };
    expect(exported.data.settings.monthlyDailyBudget).toBe(52000);
    expect(exported.data.cashflowLogs.some((l) => l.id === 'imp-1')).toBe(true);
  });

  it('auto-detects and imports Recurring_Config and Assets_Liabilities CSVs via /api/import/csv', async () => {
    const cookie = await setupAndGetCookie();

    const recurringCsv = [
      '項目名稱,分類,收支類型,金額,幣別,入帳/扣款週期,生效月份,狀態,月均換算(TWD),備註',
      '本業月薪,薪資,固定收入,"95,000",TWD,月繳,,啟用,"95,000",自動入帳',
      'Claude Pro,AI訂閱,訂閱扣款,20,USD,月繳,,啟用,650,訂閱',
    ].join('\n');

    const recRes = await app.request(
      'https://finance.example.com/api/import/csv',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ csvText: recurringCsv }),
      },
      env
    );
    expect(recRes.status).toBe(200);
    expect(await recRes.json()).toMatchObject({ ok: true, kind: 'recurring', importedCount: 2 });

    const recRows = await db.prepare('SELECT COUNT(*) as cnt FROM recurring_items').first<{ cnt: number }>();
    expect(recRows?.cnt).toBe(2);
  });

  it('syncs 5F & 6F rent utility records and rents via /api/sync and includes them in JSON export', async () => {
    const cookie = await setupAndGetCookie();

    const syncRes = await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: 'ut-mut-1',
              entity: 'utility_record',
              op: 'upsert',
              recordId: '11511',
              clientTimestamp: '2026-11-24T06:00:00.000Z',
              payload: {
                period: '11511',
                isBaseline: false,
                curTotal: 62500,
                cur6F: 8100,
                totalElec: 4200,
                totalWater: 550,
                f6People: 2,
                f5People: 3,
                curA: 260,
                curB: 5950,
                curC: 6460,
              },
            },
            {
              mutationId: 'ut-mut-2',
              entity: 'utility_rents',
              op: 'upsert',
              recordId: '1',
              clientTimestamp: '2026-11-24T06:00:00.000Z',
              payload: { rent6F: 18500, rentA: 9500, rentB: 9000, rentC: 8800 },
            },
          ],
        }),
      },
      env
    );
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as {
      ackedMutationIds: string[];
      delta: {
        rentUtilityRecords: Array<{ period: string }>;
        rentUtilityRents: { rent6F: number } | null;
      };
    };
    expect(syncJson.ackedMutationIds).toEqual(['ut-mut-1', 'ut-mut-2']);
    expect(syncJson.delta.rentUtilityRecords.some((r) => r.period === '11511')).toBe(true);
    expect(syncJson.delta.rentUtilityRents?.rent6F).toBe(18500);

    const exportRes = await app.request(
      'https://finance.example.com/api/export/json',
      { headers: { cookie } },
      env
    );
    expect(exportRes.status).toBe(200);
    const exported = (await exportRes.json()) as {
      data: { rentUtilityRecords: Array<{ period: string }>; rentUtilityRents: { rentA: number } };
    };
    expect(exported.data.rentUtilityRecords.length).toBeGreaterThanOrEqual(8);
    expect(exported.data.rentUtilityRents.rentA).toBe(9500);
  });

  it('syncs linked savings accounts & adjustments, propagates linkedAccountId on recurring, and snapshots live balance', async () => {
    const cookie = await setupAndGetCookie();

    // Sync linked savings account (300k) + deposit adjustment (+200k) + linked expense (-100k) + recurring item linked to account
    const syncRes = await app.request(
      'https://finance.example.com/api/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: 'm-sav-1',
              entity: 'asset',
              op: 'upsert',
              recordId: 'sav-acc-1',
              clientTimestamp: '2026-11-24T04:00:00.000Z',
              payload: {
                updateMode: '手動快照',
                majorType: '資產',
                subCategory: '活存',
                liquidity: '高流動',
                itemName: '中信活存',
                quantityOrAmount: 300000,
                currency: 'TWD',
                unitPrice: 1,
                isLinkedSavings: true,
                balanceAnchorDate: '2026-11-24',
                balanceAnchorAt: '2026-11-24T04:00:00.000Z',
                isDefaultSavings: true,
              },
            },
            {
              mutationId: 'm-adj-1',
              entity: 'savings_adjustment',
              op: 'upsert',
              recordId: 'adj-1',
              clientTimestamp: '2026-11-24T04:10:00.000Z',
              payload: {
                accountId: 'sav-acc-1',
                date: '2026-11-24',
                amount: 200000,
                twdAmount: 200000,
                note: '追加存入',
              },
            },
            {
              mutationId: 'm-cf-1',
              entity: 'cashflow',
              op: 'upsert',
              recordId: 'cf-sav-1',
              clientTimestamp: '2026-11-24T05:00:00.000Z',
              payload: {
                date: '2026-11-24',
                type: CASHFLOW_TYPES.DAILY_EXPENSE,
                category: '餐飲',
                itemName: '刷卡扣款',
                amount: 100000,
                currency: 'TWD',
                fxRate: 1,
                source: '手機記帳',
                linkedAccountId: 'sav-acc-1',
              },
            },
            {
              mutationId: 'm-rec-1',
              entity: 'recurring',
              op: 'upsert',
              recordId: 'rec-sav-1',
              clientTimestamp: '2026-11-24T05:05:00.000Z',
              payload: {
                itemName: '月薪入帳',
                category: '薪資',
                type: CASHFLOW_TYPES.FIXED_INCOME,
                amount: 50000,
                currency: 'TWD',
                cycle: '月繳',
                status: '啟用',
                linkedAccountId: 'sav-acc-1',
              },
            },
          ],
        }),
      },
      env
    );
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as {
      ackedMutationIds: string[];
      delta: { savingsAdjustments: unknown[] };
    };
    expect(syncJson.ackedMutationIds).toHaveLength(4);
    expect(syncJson.delta.savingsAdjustments).toHaveLength(1);

    // Month-end snapshot on 2026-11-30 must capture live balance = 300k + 200k - 100k = 400k
    const snap = await runMonthEndSnapshotD1(db, new Date('2026-11-30T15:00:00.000Z'));
    expect(snap.totalAssets).toBe(400000);
    expect(snap.netWorth).toBe(400000);

    // Next month's recurring run propagates linked_account_id into generated cashflow_logs
    const recRun = await runMonthlyRecurringD1(db, 2026, 12);
    expect(recRun.insertedCount).toBe(1);
    const posted = await db
      .prepare(`SELECT linked_account_id FROM cashflow_logs WHERE year_month = '2026-12' AND source = '自動入帳'`)
      .first<{ linked_account_id: string | null }>();
    expect(posted?.linked_account_id).toBe('sav-acc-1');
  });
});
