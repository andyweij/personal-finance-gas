/**
 * v1.13.1：固定收支的每月入帳日（post_day，migration 0022）。
 * 自動入帳與「立即入帳本月」產生的流水帳記在入帳日，連動活存的餘額才不會因為入帳日早於活存的基準日而漏算。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { computeSavingsAccountSummary } from '../shared/calculations';
import { normalizeRecurringPostDay, resolveRecurringEntryDate } from '../shared/recurring';
import type { AssetItem, CashFlowLog } from '../shared/types';
import { validateRecurringInput } from '../shared/validation';
import { runMonthlyRecurringD1 } from '../worker/automation';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

function recurringPayload(extra: Record<string, unknown> = {}) {
  return {
    itemName: '薪資',
    category: '薪資',
    type: '固定收入',
    amount: 60000,
    currency: 'TWD',
    cycle: '月繳',
    billingSpec: '',
    status: '啟用',
    note: '',
    ledgerId: 'default',
    ...extra,
  };
}

async function upsertRecurring(
  db: D1Database,
  recordId: string,
  payload: Record<string, unknown>,
  baseVersion: number | null = null
) {
  return processSyncRequest(db, UID, {
    sinceSeq: 0,
    clientEpoch: 1,
    refsOrdered: true,
    mutations: [
      {
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId,
        clientTimestamp: new Date().toISOString(),
        baseVersion,
        payload,
      },
    ] as never,
  });
}

async function postDayOf(db: D1Database, id: string): Promise<number | undefined> {
  const row = await db
    .prepare('SELECT * FROM recurring_items WHERE user_id = ? AND id = ?')
    .bind(UID, id)
    .first<Record<string, unknown>>();
  return row?.post_day === undefined ? undefined : Number(row.post_day);
}

async function autoPostedDates(db: D1Database, ym: string): Promise<Record<string, string>> {
  const rows = await db
    .prepare("SELECT item_name, date FROM cashflow_logs WHERE user_id = ? AND year_month = ? AND source = '自動入帳'")
    .bind(UID, ym)
    .all<{ item_name: string; date: string }>();
  return Object.fromEntries((rows.results || []).map((r) => [r.item_name, r.date]));
}

describe('固定收支入帳日：共用函式', () => {
  it('入帳日期：一般日期、月底調整、閏年', () => {
    expect(resolveRecurringEntryDate('2026-11', 25)).toBe('2026-11-25');
    expect(resolveRecurringEntryDate('2026-11', 31)).toBe('2026-11-30');
    expect(resolveRecurringEntryDate('2026-02', 30)).toBe('2026-02-28');
    expect(resolveRecurringEntryDate('2028-02', 31)).toBe('2028-02-29');
    expect(resolveRecurringEntryDate('2026-12', 31)).toBe('2026-12-31');
  });

  it('缺漏或無效的入帳日視為 1 號（維持 v1.13.0 以前的行為）', () => {
    for (const v of [undefined, null, '', 0, 32, -3, 'abc', Number.NaN]) {
      expect(normalizeRecurringPostDay(v)).toBe(1);
      expect(resolveRecurringEntryDate('2026-11', v)).toBe('2026-11-01');
    }
  });

  it('驗證：接受 1～31 的整數，其餘拒絕；未提供時為 1', () => {
    expect(validateRecurringInput(recurringPayload()).postDay).toBe(1);
    expect(validateRecurringInput(recurringPayload({ postDay: '25' })).postDay).toBe(25);
    expect(validateRecurringInput(recurringPayload({ postDay: 31 })).postDay).toBe(31);
    for (const bad of [0, 32, 1.5, 'x']) {
      expect(() => validateRecurringInput(recurringPayload({ postDay: bad }))).toThrow(/入帳日需為 1～31/);
    }
  });
});

describe('固定收支入帳日：伺服器與自動入帳', () => {
  it('自動入帳的流水帳記在入帳日；未設定的項目仍記在 1 號；31 號在 11 月記在月底', async () => {
    const db = createTestD1();
    await upsertRecurring(db, 'rc-salary', recurringPayload({ postDay: 25 }));
    await upsertRecurring(db, 'rc-rent', recurringPayload({ itemName: '房租', category: '居住', type: '固定支出', amount: 18000 }));
    await upsertRecurring(db, 'rc-card', recurringPayload({ itemName: '卡費', category: '其他', type: '固定支出', amount: 5000, postDay: 31 }));
    expect(await postDayOf(db, 'rc-salary')).toBe(25);
    expect(await postDayOf(db, 'rc-rent')).toBe(1);

    const run = await runMonthlyRecurringD1(db, UID, 2026, 11);
    expect(run.insertedCount).toBe(3);
    expect(await autoPostedDates(db, '2026-11')).toEqual({
      薪資: '2026-11-25',
      房租: '2026-11-01',
      卡費: '2026-11-30',
    });

    // 去重鍵仍是「項目 + 月份」，再跑一次不會重複
    const again = await runMonthlyRecurringD1(db, UID, 2026, 11);
    expect(again.insertedCount).toBe(0);
  });

  it('連動活存：入帳日晚於活存基準日時計入餘額（固定 1 號時會被基準日排除）', async () => {
    const db = createTestD1();
    await upsertRecurring(db, 'rc-salary', recurringPayload({ postDay: 25, linkedAccountId: null }));
    await upsertRecurring(db, 'rc-old', recurringPayload({ itemName: '獎金', category: '獎金', amount: 1000 }));
    await runMonthlyRecurringD1(db, UID, 2026, 11);

    const rows = await db
      .prepare("SELECT * FROM cashflow_logs WHERE user_id = ? AND source = '自動入帳'")
      .bind(UID)
      .all<Record<string, unknown>>();
    const account = {
      id: 'acc-1',
      itemName: '薪轉戶',
      currency: 'TWD',
      quantityOrAmount: 100000,
      unitPrice: 1,
      isLinkedSavings: true,
      balanceAnchorDate: '2026-11-20',
      balanceAnchorAt: '2026-11-20T12:00:00.000Z',
    } as unknown as AssetItem;
    const logs = (rows.results || []).map(
      (r) =>
        ({
          id: String(r.id),
          date: String(r.date),
          type: String(r.type),
          twdAmount: Number(r.twd_amount),
          amount: Number(r.amount),
          currency: String(r.currency),
          linkedAccountId: 'acc-1',
          createdAt: String(r.created_at),
          deletedAt: null,
        }) as unknown as CashFlowLog
    );
    const summary = computeSavingsAccountSummary(account, logs, [], 32);
    // 薪資 11/25 在基準日 11/20 之後 → 計入；獎金 11/01 在基準日之前 → 不計入
    expect(summary.linkedLogCount).toBe(1);
    expect(summary.currentBalanceTwd).toBe(160000);
  });

  it('舊版客戶端（payload 沒有 postDay）編輯時保留原入帳日', async () => {
    const db = createTestD1();
    await upsertRecurring(db, 'rc-salary', recurringPayload({ postDay: 25 }));
    const res = await upsertRecurring(db, 'rc-salary', recurringPayload({ amount: 65000 }), 1);
    expect(res.rejected || []).toEqual([]);
    expect(await postDayOf(db, 'rc-salary')).toBe(25);
    const row = await db.prepare('SELECT amount FROM recurring_items WHERE id = ?').bind('rc-salary').first<{ amount: number }>();
    expect(row?.amount).toBe(65000);
  });

  it('同步拉取時帶回 postDay', async () => {
    const db = createTestD1();
    await upsertRecurring(db, 'rc-salary', recurringPayload({ postDay: 25 }));
    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    const item = (pull.delta.recurringItems || []).find((r) => r.id === 'rc-salary');
    expect(item?.postDay).toBe(25);
  });

  it('備份匯出再匯入保留入帳日', async () => {
    const db = createTestD1();
    await upsertRecurring(db, 'rc-salary', recurringPayload({ postDay: 25 }));
    const snapshot = await exportFullSnapshot(db, UID);
    const db2 = createTestD1();
    await importFullSnapshot(db2, UID, snapshot, 'replace');
    expect(await postDayOf(db2, 'rc-salary')).toBe(25);
  });
});

describe('固定收支入帳日：尚未套用 migration 0022', () => {
  it('非預設入帳日明確拒絕（不靜默遺失）；預設 1 號照常寫入', async () => {
    const db = createTestD1({ stopBefore: '0022' });
    const rejected = await upsertRecurring(db, 'rc-salary', recurringPayload({ postDay: 25 }));
    expect(rejected.rejected?.[0]?.reason).toMatch(/入帳日/);

    const ok = await upsertRecurring(db, 'rc-rent', recurringPayload({ itemName: '房租', type: '固定支出' }));
    expect(ok.rejected || []).toEqual([]);
    expect(ok.ackedMutationIds?.length).toBe(1);

    // 既有項目更新為非預設入帳日同樣被拒
    const upd = await upsertRecurring(db, 'rc-rent', recurringPayload({ itemName: '房租', type: '固定支出', postDay: 5 }), 1);
    expect(upd.rejected?.[0]?.reason).toMatch(/入帳日/);

    // 自動入帳在沒有欄位時仍記在 1 號
    await runMonthlyRecurringD1(db, UID, 2026, 11);
    expect(await autoPostedDates(db, '2026-11')).toEqual({ 房租: '2026-11-01' });
  });

  it('匯入：含非預設入帳日時失敗並提示遷移；全部為 1 號時可匯入', async () => {
    const src = createTestD1();
    await upsertRecurring(src, 'rc-salary', recurringPayload({ postDay: 25 }));
    const withDay = await exportFullSnapshot(src, UID);

    const old = createTestD1({ stopBefore: '0022' });
    await expect(importFullSnapshot(old, UID, withDay, 'replace')).rejects.toThrow(/入帳日/);

    const plain = {
      ...withDay,
      recurringItems: (withDay.recurringItems || []).map((r) => ({ ...r, postDay: 1 })),
    };
    await importFullSnapshot(old, UID, plain, 'replace');
    const row = await old.prepare('SELECT id FROM recurring_items WHERE id = ?').bind('rc-salary').first();
    expect(row).toBeTruthy();
  });
});

describe('固定收支入帳日：用戶端', () => {
  function createEngine(db: D1Database): SyncEngine {
    return new SyncEngine(new LocalFinanceDB(`post-day-${crypto.randomUUID()}`), {
      isOnline: () => true,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify(await processSyncRequest(db, UID, body)), { status: 200 });
      }) as typeof fetch,
    });
  }

  it('只切換啟用狀態（不帶 postDay）時保留入帳日', async () => {
    const db = createTestD1();
    const engine = createEngine(db);
    await engine.init();
    const item = await engine.saveRecurring(recurringPayload({ postDay: 25 }) as never);
    expect(item.postDay).toBe(25);
    const { postDay: _omit, ...withoutDay } = item;
    const toggled = await engine.saveRecurring({ ...withoutDay, status: '停用' } as never);
    expect(toggled.postDay).toBe(25);
    expect((await engine.syncNow(true)).ok).toBe(true);
    expect(await postDayOf(db, item.id)).toBe(25);
  });

  it('從記帳「加入每月常態」建立的項目，入帳日沿用該筆記帳的日期', async () => {
    const db = createTestD1();
    const engine = createEngine(db);
    await engine.init();
    await engine.addCashFlow({
      date: '2026-11-25',
      type: '固定收入',
      category: '薪資',
      itemName: '薪資',
      amount: 60000,
      currency: 'TWD',
      makeRecurring: true,
    } as never);
    const rec = engine.getSnapshot().recurringItems.find((r) => r.itemName === '薪資');
    expect(rec?.postDay).toBe(25);
  });
});
