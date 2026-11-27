/**
 * v1.15.0（信用卡帳單週期與分期付款）審查的重現測試（docs/reviews/2026-11-27_v1.15.0_review.md）。
 *
 * it.fails：問題仍存在時本測試「預期失敗」；修好後請改回 it。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../shared/constants';
import { computeCreditCardSummary } from '../shared/creditCard';
import { runMonthlyInstallmentsD1, runScheduledAutomation } from '../worker/automation';
import { processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

const cardPayload = {
  updateMode: '手動快照',
  majorType: '負債',
  subCategory: '信用卡',
  liquidity: '負債',
  itemName: '中信卡',
  quantityOrAmount: 0,
  currency: 'TWD',
  unitPrice: 1,
  isCreditCard: true,
  creditBillingDay: 15,
  creditDueDay: 1,
  creditLimit: 100_000,
  balanceAnchorDate: '2026-11-01',
  ledgerId: DEFAULT_LEDGER_ID,
};

async function seedUser(db: D1Database) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, password_salt, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'x', 'x', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
    )
    .bind(UID, UID, UID)
    .run();
}

const planPayload = (id: string, startYm: string, extra: Record<string, unknown> = {}) => ({
  id,
  ledgerId: DEFAULT_LEDGER_ID,
  cardAccountId: null,
  itemName: '電視',
  category: '家電',
  totalAmount: 6000,
  totalInstallments: 6,
  postedInstallments: 0,
  startYm,
  postDay: 5,
  currency: 'TWD',
  status: 'active',
  note: '',
  ...extra,
});

async function createPlan(db: D1Database, payload: Record<string, unknown>) {
  const res = await processSyncRequest(db, UID, {
    sinceSeq: 0,
    clientEpoch: 1,
    refsOrdered: true,
    mutations: [
      {
        mutationId: crypto.randomUUID(),
        entity: 'installment_plan',
        op: 'upsert',
        recordId: String(payload.id),
        clientTimestamp: new Date().toISOString(),
        baseVersion: null,
        isNewRecord: true,
        payload,
      },
    ],
  } as never);
  expect(res.rejected ?? []).toEqual([]);
}

async function postedSeqs(db: D1Database, planId: string): Promise<number[]> {
  const rows = await db
    .prepare('SELECT installment_seq FROM cashflow_logs WHERE user_id = ? AND installment_plan_id = ? AND deleted_at IS NULL ORDER BY installment_seq')
    .bind(UID, planId)
    .all<{ installment_seq: number }>();
  return (rows.results || []).map((r) => Number(r.installment_seq));
}

const noNetwork = (async () => new Response('offline', { status: 503 })) as never;

describe('發現 1：對帳校準後，當天在校準前的刷卡被重複計入未繳金額', () => {
  it.fails('當天刷卡 1,000、隨即校準未繳為 1,000：未繳應為 1,000', async () => {
    const engine = new SyncEngine(new LocalFinanceDB(`v1150-${crypto.randomUUID()}`), { isOnline: () => false });
    await engine.init();
    const today = '2026-11-27';
    const card = await engine.saveAsset(cardPayload as never);
    await engine.addCashFlow({
      date: today,
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: '刷卡',
      amount: 1000,
      currency: 'TWD',
      linkedAccountId: card.id,
    } as never);
    await engine.reconcileCreditCard(card.id, 1000, today);

    const snap = engine.getSnapshot();
    const fresh = snap.assetItems.find((a) => a.id === card.id)!;
    // 根因：saveAssetInner 只有活存帳戶保留 balanceAnchorAt，信用卡被存成 null，
    // 基準日當天的交易於是全部視為「基準之後」而再計入一次（修正前為 2,000）
    const summary = computeCreditCardSummary(fresh, snap.cashflowLogs, snap.savingsAdjustments || [], [], snap.settings, today);
    expect(summary.currentBalanceNative).toBe(1000);
  });
});

describe('發現 2：分期期數漏入帳', () => {
  it.fails('起始月份在過去（9 月起 6 期、11 月才登記）：截至 12 月應已入帳第 1～4 期', async () => {
    const db = createTestD1();
    await seedUser(db);
    await createPlan(db, planPayload('p-past', '2026-09'));
    await runMonthlyInstallmentsD1(db, UID, 2026, 11);
    await runMonthlyInstallmentsD1(db, UID, 2026, 12);
    // 修正前只入帳 [3, 4]：每次只入「當月那一期」，第 1、2 期永遠不會入帳，posted_installments 卻跳到 4
    expect(await postedSeqs(db, 'p-past')).toEqual([1, 2, 3, 4]);
  });

  it.fails('當月排程已完成後才建立、當月開始的分期（未勾「立即入帳第 1 期」）：第 1 期應在之後的排程入帳', async () => {
    const db = createTestD1();
    await seedUser(db);
    // 已有一筆進行中的分期，所以 11/01 的排程會把本月的 installments 標為完成
    await createPlan(db, planPayload('p-existing', '2026-10'));
    await runScheduledAutomation(db, '0 15 * * *', new Date('2026-11-01T15:00:00.000Z'), { fetchImpl: noNetwork });

    await createPlan(db, planPayload('p-new', '2026-11'));
    await runScheduledAutomation(db, '0 15 * * *', new Date('2026-11-16T15:00:00.000Z'), { fetchImpl: noNetwork });
    await runScheduledAutomation(db, '0 0 1 * *', new Date('2026-12-01T00:00:00.000Z'), { fetchImpl: noNetwork });
    // 修正前只入帳 [2]：11 月的排程已標為完成，新計畫的第 1 期被跳過
    expect(await postedSeqs(db, 'p-new')).toEqual([1, 2]);
  });

  it('對照：當月建立並勾選「立即入帳第 1 期」時，之後逐月入帳不漏期', async () => {
    const db = createTestD1();
    await seedUser(db);
    await createPlan(db, planPayload('p-ok', '2026-11'));
    await runMonthlyInstallmentsD1(db, UID, 2026, 11);
    await runMonthlyInstallmentsD1(db, UID, 2026, 12);
    await runMonthlyInstallmentsD1(db, UID, 2027, 1);
    expect(await postedSeqs(db, 'p-ok')).toEqual([1, 2, 3]);
  });
});
