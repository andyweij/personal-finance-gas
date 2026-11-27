/**
 * v1.8.17 審查的重現測試（docs/reviews/2026-11-27_v1.8.17_review.md）。
 *
 * 發現 1、2 已修正：原本以 it.fails 標記的項目已改為 it。
 * 「寬鬆路徑的範圍」記錄目前（設計上）的行為，作為之後調整時的對照。
 */
import { describe, expect, it } from 'vitest';
import { orderMutationsByDependencies } from '../shared/syncOrder';
import { filterCashFlowsByLedgerScope } from '../shared/calculations';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

const UID = 'owner';

const cashflow = (extra: Record<string, unknown>) => ({
  date: '2026-11-26',
  type: '日常花費',
  category: '餐飲',
  itemName: '午餐',
  amount: 100,
  currency: 'TWD',
  ...extra,
});

const savingsAccount = (name: string) => ({
  itemName: name,
  majorType: '資產',
  updateMode: '手動快照',
  subCategory: '活存',
  liquidity: '高流動',
  quantityOrAmount: 1000,
  currency: 'TWD',
  unitPrice: 1,
  isLinkedSavings: true,
});

/** refsOrdered 省略時即 v1.8.11 舊客戶端的請求（走寬鬆的 M3 檢查） */
async function send(
  db: D1Database,
  uid: string,
  mutations: Array<{ entity: string; recordId: string; payload: Record<string, unknown> }>,
  refsOrdered = false
) {
  return processSyncRequest(db, uid, {
    sinceSeq: 0,
    clientEpoch: 1,
    ...(refsOrdered ? { refsOrdered: true } : {}),
    mutations: mutations.map((m) => ({
      mutationId: crypto.randomUUID(),
      clientTimestamp: new Date().toISOString(),
      baseVersion: null,
      op: 'upsert',
      ...m,
    })),
  } as never);
}

type Mut = { id: number; entity: string; op: string; recordId: string; payload: Record<string, unknown>; atomicGroupId?: string };

describe('發現 1（已修正）：依賴排序不可讓同一筆紀錄的後續異動排到它自己的新增之前', () => {
  // 最小反例（修正前隨機測試 3000 組中有 301 組違反；v1.8.16 的排序在同一輸入下正確）。
  // 群組 g 的成員參照帳戶 A0，而 A0 的新增也在群組 g 內、之後還有一筆群組外的編輯。
  const input: Mut[] = [
    { id: 0, entity: 'savings_adjustment', op: 'upsert', recordId: 'S0', payload: { accountId: 'A0' }, atomicGroupId: 'g' },
    { id: 1, entity: 'asset', op: 'upsert', recordId: 'A0', payload: {}, atomicGroupId: 'g' },
    { id: 2, entity: 'asset', op: 'upsert', recordId: 'A0', payload: {} },
  ];

  it('同一筆紀錄（asset:A0）的異動應維持原本的先後順序', () => {
    const out = orderMutationsByDependencies(input).map((m) => m.id);
    // 修正前輸出 [2, 0, 1]：A0 的編輯（2）排在 A0 的新增（1）之前
    expect(out.indexOf(1)).toBeLessThan(out.indexOf(2));
  });

  it('輸出仍是輸入的排列，群組成員仍連續（不變條件的其他部分成立）', () => {
    const out = orderMutationsByDependencies(input).map((m) => m.id);
    expect([...out].sort()).toEqual([0, 1, 2]);
    expect(Math.abs(out.indexOf(0) - out.indexOf(1))).toBe(1);
  });

  it('隨機佇列（5000 組）：輸出為排列、群組連續、同一筆紀錄的異動順序不變、無群組時依賴排在前面', () => {
    // 與實際客戶端一致的前提：一筆紀錄最多屬於一個群組（轉帳的所有異動共用同一個群組 id）；
    // 它可以先有群組內的異動、之後再有群組外的單獨編輯（例如帳戶因轉帳進入群組，之後被改名）。
    // 修正前在同一組產生方式下有 54 次違反「同一筆紀錄的異動順序不變」，修正後為 0。
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (prefix: string, n: number) => `${prefix}${Math.floor(rand() * n)}`;
    for (let t = 0; t < 5000; t++) {
      const recordGroup = new Map<string, string | null>();
      const leftGroup = new Set<string>();
      const group = (rec: string, p: number) => {
        if (!recordGroup.has(rec)) recordGroup.set(rec, rand() < p ? pick('g', 3) : null);
        const g = recordGroup.get(rec);
        if (!g || leftGroup.has(rec)) return {};
        if (rand() < 0.35) {
          leftGroup.add(rec);
          return {};
        }
        return { atomicGroupId: g };
      };
      const n = 1 + Math.floor(rand() * 25);
      const list: Mut[] = [];
      for (let i = 0; i < n; i++) {
        const kind = rand();
        if (kind < 0.3) {
          const r = pick('A', 4);
          list.push({ id: i, entity: 'asset', op: rand() < 0.85 ? 'upsert' : 'delete', recordId: r, payload: {}, ...group(`asset:${r}`, 0.15) });
        } else if (kind < 0.4) {
          list.push({ id: i, entity: 'ledger', op: 'upsert', recordId: pick('L', 2), payload: {} });
        } else if (kind < 0.7) {
          const r = pick('S', 6);
          list.push({ id: i, entity: 'savings_adjustment', op: 'upsert', recordId: r, payload: { accountId: pick('A', 4) }, ...group(`adj:${r}`, 0.4) });
        } else {
          const r = pick('C', 6);
          list.push({
            id: i,
            entity: 'cashflow',
            op: 'upsert',
            recordId: r,
            payload: { linkedAccountId: rand() < 0.6 ? pick('A', 4) : null, ledgerId: rand() < 0.5 ? pick('L', 2) : 'default' },
            ...group(`cf:${r}`, 0.2),
          });
        }
      }
      const out = orderMutationsByDependencies(list);
      const pos = new Map(out.map((m, i) => [m.id, i]));
      expect(out.map((m) => m.id).sort((a, b) => a - b)).toEqual(list.map((m) => m.id));

      const byRecord = new Map<string, number[]>();
      for (const m of list) byRecord.set(`${m.entity}:${m.recordId}`, [...(byRecord.get(`${m.entity}:${m.recordId}`) || []), m.id]);
      for (const ids of byRecord.values()) {
        for (let i = 1; i < ids.length; i++) expect(pos.get(ids[i - 1])!).toBeLessThan(pos.get(ids[i])!);
      }

      const groups = new Map<string, number[]>();
      out.forEach((m, i) => {
        if (m.atomicGroupId) groups.set(m.atomicGroupId, [...(groups.get(m.atomicGroupId) || []), i]);
      });
      for (const idx of groups.values()) expect(idx[idx.length - 1] - idx[0]).toBe(idx.length - 1);

      // 沒有群組時不會有循環（帳戶 payload 不參照其他紀錄）：被參照紀錄的第一筆 upsert 排在參照者之前
      if (groups.size === 0) {
        for (const m of list) {
          for (const ref of [m.payload.accountId, m.payload.linkedAccountId].filter(Boolean)) {
            const first = list.find((d) => d !== m && d.op === 'upsert' && d.entity === 'asset' && d.recordId === ref);
            if (first) expect(pos.get(first.id)!).toBeLessThan(pos.get(m.id)!);
          }
          if (m.payload.ledgerId && m.payload.ledgerId !== 'default') {
            const first = list.find((d) => d.op === 'upsert' && d.entity === 'ledger' && d.recordId === m.payload.ledgerId);
            if (first) expect(pos.get(first.id)!).toBeLessThan(pos.get(m.id)!);
          }
        }
      }
    }
  });
});

describe('發現 2（已修正）：寬鬆路徑接受的懸空帳本參照，不可讓使用者自己的備份無法再匯入', () => {
  it('不帶 refsOrdered 時，指向從未存在之帳本的流水帳被接受，且在淨值與預設帳本檢視中都看不到', async () => {
    const db = createTestD1();
    const lenient = await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ ledgerId: 'ghost-ledger' }) }]);
    expect(lenient.rejected ?? []).toEqual([]);

    const strict = await send(db, UID, [{ entity: 'cashflow', recordId: 'c2', payload: cashflow({ ledgerId: 'ghost-ledger' }) }], true);
    expect(strict.rejected?.length).toBe(1);

    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never);
    const logs = pull.delta.cashflowLogs || [];
    expect(filterCashFlowsByLedgerScope(logs, 'net_worth', pull.delta.ledgers)).toHaveLength(0);
    expect(filterCashFlowsByLedgerScope(logs, 'default', pull.delta.ledgers)).toHaveLength(0);
    expect(filterCashFlowsByLedgerScope(logs, 'all', pull.delta.ledgers)).toHaveLength(1);
  });

  it('使用者匯出的備份能以取代模式匯回；紀錄歸到重建的「復原的帳本」，不計入淨資產（總額與匯出前相同）', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ ledgerId: 'ghost-ledger' }) }]);
    const backup = await exportFullSnapshot(db, UID);
    // 修正前拋出「匯入資料中有 1 筆紀錄指向不存在的帳本…」
    const res = await importFullSnapshot(db, UID, backup, 'replace');
    expect(res.recoveredLedgers).toBe(1);

    const epoch = (await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never)).dataEpoch;
    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: epoch, mutations: [] } as never);
    const ledger = (pull.delta.ledgers || []).find((l) => l.id === 'ghost-ledger');
    expect(ledger?.name).toMatch(/復原的帳本/);
    expect(ledger?.includeInNetWorth).toBe(false);
    const logs = pull.delta.cashflowLogs || [];
    expect(filterCashFlowsByLedgerScope(logs, 'ghost-ledger', pull.delta.ledgers)).toHaveLength(1);
    expect(filterCashFlowsByLedgerScope(logs, 'net_worth', pull.delta.ledgers)).toHaveLength(0);
  });

  it('合併模式：不存在的帳本 id 剛好是已刪除的帳本時，改用新 id 重建（已刪除的帳本不會被復活）', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'ledger', recordId: 'old-ledger', payload: { name: '舊帳本', includeInNetWorth: true } }], true);
    const v = await db.prepare('SELECT version FROM ledgers WHERE id = ?').bind('old-ledger').first<{ version: number }>();
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      refsOrdered: true,
      mutations: [
        { mutationId: crypto.randomUUID(), clientTimestamp: 'x', baseVersion: v?.version, entity: 'ledger', op: 'delete', recordId: 'old-ledger', payload: {} },
      ],
    } as never);

    const res = await importFullSnapshot(db, UID, { cashflowLogs: [{ ...cashflow({ ledgerId: 'old-ledger' }), id: 'imp-1' } as never] }, 'merge');
    expect(res.recoveredLedgers).toBe(1);
    const row = await db
      .prepare('SELECT c.ledger_id, l.name, l.deleted_at, l.include_in_net_worth FROM cashflow_logs c JOIN ledgers l ON l.user_id = c.user_id AND l.id = c.ledger_id WHERE c.id = ?')
      .bind('imp-1')
      .first<{ ledger_id: string; name: string; deleted_at: string | null; include_in_net_worth: number }>();
    expect(row?.ledger_id).not.toBe('old-ledger');
    expect(row?.name).toMatch(/復原的帳本/);
    expect(row?.deleted_at).toBeNull();
    expect(row?.include_in_net_worth).toBe(0);
    const old = await db.prepare('SELECT deleted_at FROM ledgers WHERE id = ?').bind('old-ledger').first<{ deleted_at: string | null }>();
    expect(old?.deleted_at).not.toBeNull();
  });

  it('沒有懸空參照的一般匯入不會重建帳本', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({}) }], true);
    const res = await importFullSnapshot(db, UID, await exportFullSnapshot(db, UID), 'replace');
    expect(res.recoveredLedgers).toBe(0);
  });
});

describe('寬鬆路徑的範圍（記錄目前行為）', () => {
  it('指向「其他使用者」的帳戶 id 會被當成從未存在而接受；不會讀到或改到對方資料', async () => {
    const db = createTestD1();
    await send(db, 'bob', [{ entity: 'asset', recordId: 'bob-acc', payload: savingsAccount('Bob 的帳戶') }], true);
    const res = await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ linkedAccountId: 'bob-acc' }) }]);
    expect(res.rejected ?? []).toEqual([]);

    const pull = await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never);
    expect((pull.delta.assetItems || []).some((a) => a.id === 'bob-acc')).toBe(false);
    const bobRow = await db
      .prepare('SELECT item_name FROM asset_items WHERE user_id = ? AND id = ?')
      .bind('bob', 'bob-acc')
      .first<{ item_name: string }>();
    expect(bobRow?.item_name).toBe('Bob 的帳戶');
  });

  it('寬鬆檢查不限新紀錄：把既有流水帳改成指向不存在的帳戶也會被接受', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({}) }], true);
    const row = await db.prepare('SELECT version FROM cashflow_logs WHERE id = ?').bind('c1').first<{ version: number }>();
    const res = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      mutations: [
        {
          mutationId: crypto.randomUUID(),
          clientTimestamp: new Date().toISOString(),
          baseVersion: row?.version,
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'c1',
          payload: cashflow({ linkedAccountId: 'never-existed' }),
        },
      ],
    } as never);
    expect(res.rejected ?? []).toEqual([]);
  });

  it('指向已刪除的帳戶仍拒絕；但取代模式匯入會清掉已刪除的紀錄，之後同一請求就被接受', async () => {
    const db = createTestD1();
    await send(db, UID, [{ entity: 'asset', recordId: 'acc-x', payload: savingsAccount('X') }], true);
    const v = await db.prepare('SELECT version FROM asset_items WHERE id = ?').bind('acc-x').first<{ version: number }>();
    await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: 1,
      refsOrdered: true,
      mutations: [
        { mutationId: crypto.randomUUID(), clientTimestamp: 'x', baseVersion: v?.version, entity: 'asset', op: 'delete', recordId: 'acc-x', payload: {} },
      ],
    } as never);

    const before = await send(db, UID, [{ entity: 'cashflow', recordId: 'c1', payload: cashflow({ linkedAccountId: 'acc-x' }) }]);
    expect(before.rejected?.length).toBe(1);

    await importFullSnapshot(db, UID, await exportFullSnapshot(db, UID), 'replace');
    const epoch = (await processSyncRequest(db, UID, { sinceSeq: 0, clientEpoch: 1, mutations: [] } as never)).dataEpoch;
    const after = await processSyncRequest(db, UID, {
      sinceSeq: 0,
      clientEpoch: epoch,
      mutations: [
        { mutationId: crypto.randomUUID(), clientTimestamp: 'x', baseVersion: null, entity: 'cashflow', op: 'upsert', recordId: 'c2', payload: cashflow({ linkedAccountId: 'acc-x' }) },
      ],
    } as never);
    expect(after.rejected ?? []).toEqual([]);
  });
});
