/**
 * v2.1.0：攤提與預備金加上期間（migration 0026）。
 * 修正前每筆攤提只有「總額 ÷ 月數」與啟用開關，沒有開始與結束月份：
 *   1. 短期（如 3 個月）攤提沒手動停用就會一直計入；
 *   2. 總覽回看過去月份時，用的是「現在」啟用中的項目。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregatePeriodMetrics,
  computeOverviewBreakdownGroups,
  computeSinkingMonthlyReserve,
  computeSinkingReserveForMonth,
  computeSinkingReserveForYear,
  getSinkingSchedule,
} from '../shared/calculations';
import type { SinkingFundItem } from '../shared/types';
import { validateSinkingInput } from '../shared/validation';
import { runMonthEndSnapshotD1 } from '../worker/automation';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

function item(extra: Partial<SinkingFundItem> = {}): SinkingFundItem {
  return {
    id: 'sf-1',
    itemName: '牙齒矯正',
    category: '其他',
    totalAmount: 24000,
    months: 3,
    dueNote: '',
    status: '啟用',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('攤提排程：共用計算', () => {
  it('一次性：只在開始月 ～ 開始月 + 月數 − 1 計入，期滿自動結束', () => {
    const sf = item({ startYm: '2026-10' });
    expect(getSinkingSchedule(sf, '2026-09').state).toBe('upcoming');
    expect(getSinkingSchedule(sf, '2026-10')).toMatchObject({ state: 'active', periodIndex: 1, cycleEndYm: '2026-12' });
    expect(getSinkingSchedule(sf, '2026-12')).toMatchObject({ state: 'active', periodIndex: 3 });
    expect(getSinkingSchedule(sf, '2027-01').state).toBe('ended');

    expect(computeSinkingMonthlyReserve(sf, '2026-09')).toBe(0);
    expect(computeSinkingMonthlyReserve(sf, '2026-10')).toBe(8000);
    expect(computeSinkingMonthlyReserve(sf, '2026-12')).toBe(8000);
    expect(computeSinkingMonthlyReserve(sf, '2027-01')).toBe(0);
    expect(computeSinkingMonthlyReserve(sf, '2030-05')).toBe(0);
  });

  it('跨年度的期間正確換算', () => {
    const sf = item({ startYm: '2026-11', months: 4, totalAmount: 40000 });
    expect(getSinkingSchedule(sf, '2027-02')).toMatchObject({ state: 'active', periodIndex: 4, cycleEndYm: '2027-02' });
    expect(getSinkingSchedule(sf, '2027-03').state).toBe('ended');
  });

  it('每年重複：每 12 個月從開始月重新起算，每輪只計入前「月數」個月', () => {
    const insurance = item({ itemName: '保費', startYm: '2026-03', months: 6, totalAmount: 30000, repeatYearly: true });
    expect(getSinkingSchedule(insurance, '2026-08')).toMatchObject({ state: 'active', periodIndex: 6 });
    expect(getSinkingSchedule(insurance, '2026-09')).toMatchObject({ state: 'off_cycle', nextStartYm: '2027-03' });
    expect(getSinkingSchedule(insurance, '2027-03')).toMatchObject({ state: 'active', periodIndex: 1, cycleStartYm: '2027-03' });
    expect(computeSinkingMonthlyReserve(insurance, '2026-12')).toBe(0);
    expect(computeSinkingMonthlyReserve(insurance, '2028-05')).toBe(5000);

    const tax = item({ itemName: '所得稅', startYm: '2026-06', months: 12, totalAmount: 36000, repeatYearly: true });
    for (const ym of ['2026-06', '2027-05', '2027-06', '2031-01']) {
      expect(computeSinkingMonthlyReserve(tax, ym)).toBe(3000);
    }
    expect(computeSinkingMonthlyReserve(tax, '2026-05')).toBe(0);
  });

  it('舊項目（沒有開始月份）維持原行為：啟用即每月計入', () => {
    const legacy = item({ months: 12, totalAmount: 60000 });
    expect(getSinkingSchedule(legacy, '2026-11').state).toBe('unscheduled');
    expect(computeSinkingMonthlyReserve(legacy, '2020-01')).toBe(5000);
    expect(computeSinkingMonthlyReserve(legacy, '2035-12')).toBe(5000);
    expect(computeSinkingMonthlyReserve(legacy)).toBe(5000);
  });

  it('停用或已刪除的項目一律不計入', () => {
    expect(computeSinkingMonthlyReserve(item({ startYm: '2026-10', status: '停用' }), '2026-10')).toBe(0);
    expect(computeSinkingMonthlyReserve(item({ startYm: '2026-10', deletedAt: '2026-10-05T00:00:00Z' }), '2026-10')).toBe(0);
    expect(getSinkingSchedule(item({ status: '停用' }), '2026-10').state).toBe('disabled');
  });

  it('月份合計與年度合計依各月期間分別計算', () => {
    const items = [
      item({ id: 'a', startYm: '2026-10', months: 3, totalAmount: 24000 }),
      item({ id: 'b', itemName: '旅遊', startYm: '2027-01', months: 6, totalAmount: 60000 }),
      item({ id: 'c', itemName: '所得稅', startYm: '2026-06', months: 12, totalAmount: 36000, repeatYearly: true }),
    ];
    expect(computeSinkingReserveForMonth(items, '2026-12')).toBe(8000 + 3000);
    expect(computeSinkingReserveForMonth(items, '2027-01')).toBe(10000 + 3000);
    // 2026：所得稅 6～12 月共 7 期 + 矯正 3 期
    expect(computeSinkingReserveForYear(items, 2026)).toBe(7 * 3000 + 3 * 8000);
  });

  it('總覽大項統計：只列出檢視月份在期間內的攤提', () => {
    const items = [
      item({ id: 'a', startYm: '2026-10', months: 3, totalAmount: 24000 }),
      item({ id: 'b', itemName: '所得稅', months: 12, totalAmount: 36000 }),
    ];
    const ym = '2027-02';
    const monthly = aggregatePeriodMetrics([], computeSinkingReserveForMonth(items, ym), true);
    const yearly = aggregatePeriodMetrics([], 0, false);
    const groups = computeOverviewBreakdownGroups([], [], items, monthly, yearly, ym);
    const sinking = groups.find((g) => g.key === 'sinking_tax');
    expect(sinking?.monthlyAmount).toBe(3000);
    expect(sinking?.children.map((c) => c.label)).toEqual(['所得稅']);
    expect(monthly.totalConsumption).toBe(3000);
  });
});

describe('攤提排程：驗證', () => {
  const base = { itemName: '矯正', totalAmount: 24000, months: 3 };

  it('預設為舊行為：沒有開始月份、不重複、先存後付', () => {
    expect(validateSinkingInput(base)).toMatchObject({ startYm: null, repeatYearly: false, fundKind: 'save_first' });
  });

  it('接受 YYYY-MM 與兩種類型；拒絕格式錯誤', () => {
    expect(validateSinkingInput({ ...base, startYm: '2026-10', fundKind: 'amortize' })).toMatchObject({
      startYm: '2026-10',
      fundKind: 'amortize',
    });
    for (const bad of ['2026/10', '2026-13', '26-10', '2026-1']) {
      expect(() => validateSinkingInput({ ...base, startYm: bad })).toThrow(/開始月份/);
    }
    expect(() => validateSinkingInput({ ...base, fundKind: 'other' })).toThrow(/攤提類型/);
  });

  it('每年重複需要開始月份，且每輪最多 12 個月', () => {
    expect(() => validateSinkingInput({ ...base, repeatYearly: true })).toThrow(/開始月份/);
    expect(() => validateSinkingInput({ ...base, months: 24, startYm: '2026-01', repeatYearly: true })).toThrow(/12 個月/);
    expect(validateSinkingInput({ ...base, months: 12, startYm: '2026-01', repeatYearly: true }).repeatYearly).toBe(true);
  });
});

function sinkingPayload(extra: Record<string, unknown> = {}) {
  return {
    itemName: '牙齒矯正',
    category: '其他',
    totalAmount: 24000,
    months: 3,
    dueNote: '',
    status: '啟用',
    note: '',
    ...extra,
  };
}

async function upsertSinking(db: D1Database, recordId: string, payload: Record<string, unknown>, baseVersion: number | null = null) {
  return processSyncRequest(db, UID, {
    sinceSeq: 0,
    clientEpoch: 1,
    refsOrdered: true,
    mutations: [
      {
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'upsert',
        recordId,
        clientTimestamp: new Date().toISOString(),
        baseVersion,
        payload,
      },
    ] as never,
  });
}

async function rowOf(db: D1Database, id: string) {
  return db
    .prepare('SELECT * FROM sinking_fund_items WHERE user_id = ? AND id = ?')
    .bind(UID, id)
    .first<Record<string, unknown>>();
}

describe('攤提排程：伺服器同步', () => {
  it('寫入並在拉取時帶回開始月份、每年重複與類型', async () => {
    const db = createTestD1();
    const res = await upsertSinking(db, 'sf-1', sinkingPayload({ startYm: '2026-10', repeatYearly: false, fundKind: 'amortize' }));
    expect(res.rejected || []).toEqual([]);
    expect(await rowOf(db, 'sf-1')).toMatchObject({ start_ym: '2026-10', repeat_yearly: 0, fund_kind: 'amortize' });

    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    const got = (pull.delta.sinkingItems || []).find((s) => s.id === 'sf-1');
    expect(got).toMatchObject({ startYm: '2026-10', repeatYearly: false, fundKind: 'amortize' });
  });

  it('舊版客戶端（payload 沒有排程欄位）編輯時保留原排程', async () => {
    const db = createTestD1();
    await upsertSinking(db, 'sf-1', sinkingPayload({ startYm: '2026-06', months: 12, repeatYearly: true }));
    const res = await upsertSinking(db, 'sf-1', sinkingPayload({ months: 12, totalAmount: 30000 }), 1);
    expect(res.rejected || []).toEqual([]);
    expect(await rowOf(db, 'sf-1')).toMatchObject({ start_ym: '2026-06', repeat_yearly: 1, total_amount: 30000 });
  });

  it('可以清除開始月份，回到不限期間', async () => {
    const db = createTestD1();
    await upsertSinking(db, 'sf-1', sinkingPayload({ startYm: '2026-10' }));
    await upsertSinking(db, 'sf-1', sinkingPayload({ startYm: null, repeatYearly: false }), 1);
    expect((await rowOf(db, 'sf-1'))?.start_ym).toBeNull();
  });

  it('備份匯出再匯入保留排程', async () => {
    const db = createTestD1();
    await upsertSinking(db, 'sf-1', sinkingPayload({ startYm: '2026-10', fundKind: 'amortize' }));
    const snapshot = await exportFullSnapshot(db, UID);
    const db2 = createTestD1();
    await importFullSnapshot(db2, UID, snapshot, 'replace');
    expect(await rowOf(db2, 'sf-1')).toMatchObject({ start_ym: '2026-10', fund_kind: 'amortize' });
  });

  it('月底快照只計入當月在期間內的攤提', async () => {
    const db = createTestD1();
    await upsertSinking(db, 'sf-short', sinkingPayload({ startYm: '2026-08', months: 3 }));
    await upsertSinking(db, 'sf-legacy', sinkingPayload({ itemName: '所得稅', totalAmount: 36000, months: 12 }));
    // 2026-11 時矯正（8～10 月）已結束，只剩所得稅 3,000
    await runMonthEndSnapshotD1(db, UID, new Date('2026-11-30T15:00:00Z'));
    const snap = await db
      .prepare('SELECT monthly_consumption FROM networth_history WHERE user_id = ? AND year_month = ?')
      .bind(UID, '2026-11')
      .first<{ monthly_consumption: number }>();
    expect(snap?.monthly_consumption).toBe(3000);
  });
});

describe('攤提排程：尚未套用 migration 0026', () => {
  it('有排程的項目明確拒絕（不靜默遺失）；沒有排程的照常寫入', async () => {
    const db = createTestD1({ stopBefore: '0026' });
    const rejected = await upsertSinking(db, 'sf-1', sinkingPayload({ startYm: '2026-10' }));
    expect(rejected.rejected?.[0]?.reason).toMatch(/開始月份/);

    const ok = await upsertSinking(db, 'sf-2', sinkingPayload());
    expect(ok.rejected || []).toEqual([]);
    expect(ok.ackedMutationIds?.length).toBe(1);

    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] });
    expect((pull.delta.sinkingItems || []).find((s) => s.id === 'sf-2')).toMatchObject({ startYm: null, repeatYearly: false });

    const upd = await upsertSinking(db, 'sf-2', sinkingPayload({ startYm: '2026-10' }), 1);
    expect(upd.rejected?.[0]?.reason).toMatch(/開始月份/);
  });

  it('匯入：含排程時失敗並提示遷移；全部沒有排程時可匯入', async () => {
    const src = createTestD1();
    await upsertSinking(src, 'sf-1', sinkingPayload({ startYm: '2026-10' }));
    const withSchedule = await exportFullSnapshot(src, UID);

    const old = createTestD1({ stopBefore: '0026' });
    await expect(importFullSnapshot(old, UID, withSchedule, 'replace')).rejects.toThrow(/0026/);

    const plain = {
      ...withSchedule,
      sinkingItems: (withSchedule.sinkingItems || []).map((s) => ({ ...s, startYm: null, repeatYearly: false, fundKind: 'save_first' as const })),
    };
    await importFullSnapshot(old, UID, plain, 'replace');
    expect(await rowOf(old, 'sf-1')).toBeTruthy();
  });
});
