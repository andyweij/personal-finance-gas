import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { displaySign, escapeCsvCell, formatPercent, roundTo } from '../shared/format';

describe('v1.8.15 rounding and display', () => {
  it('roundTo rounds the decimal value half away from zero', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundTo(1e-7, 2)).toBe(0);
    expect(Object.is(roundTo(-0.001, 2), -0)).toBe(false);
    expect(roundTo(123456789.125, 2)).toBe(123456789.13);
  });

  it('never shows -0 for values that round to zero', async () => {
    expect(formatPercent(-0.04)).toBe('0.0%');
    expect(formatPercent(-0.05)).toBe('-0.1%');
    expect(formatPercent(12.34, 1, true)).toBe('+12.3%');
    expect(displaySign(-0.4)).toBe(0);
    const { fmtMoney } = await import('../web/src/ui/helpers');
    expect(fmtMoney(-0.4, false)).toBe('NT$ 0');
    expect(fmtMoney(-0.6, false)).toBe('-NT$ 1');
  });
});

describe('v1.8.15 CSV export', () => {
  it('escapes formula-looking text cells but keeps numbers numeric', () => {
    expect(escapeCsvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(escapeCsvCell('+1')).toBe('+1'); // numeric text stays a number (review follow-up)
    expect(escapeCsvCell('+cmd')).toBe("'+cmd");
    expect(escapeCsvCell('-cmd')).toBe("'-cmd");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell(-100)).toBe('-100');
    expect(escapeCsvCell('午餐')).toBe('午餐');
  });

  it('the cashflow CSV export neutralises formulas in names and notes', async () => {
    const { exportCashFlowCsv } = await import('../shared/csv');
    const csv = exportCashFlowCsv([
      {
        id: 'x',
        date: '2026-11-26',
        yearMonth: '2026-11',
        type: '日常花費',
        category: '餐飲',
        itemName: '=1+1',
        amount: 100,
        currency: 'TWD',
        fxRate: 1,
        twdAmount: 100,
        source: '手機記帳',
        note: '@evil',
        createdAt: '2026-11-26T00:00:00.000Z',
        updatedAt: '2026-11-26T00:00:00.000Z',
      } as never,
    ]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@evil");
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
  });

  it('the utility CSV escapes its cells', async () => {
    const { buildUtilityCsv } = await import('../shared/rentUtility');
    const rec = {
      period: '=cmd',
      isBaseline: false,
      prevTotal: 0, curTotal: 10, prev6F: 0, cur6F: 5, totalElec: 100, totalWater: 50, f6People: 1, f5People: 1,
      prevA: 0, curA: 1, prevB: 0, curB: 1, prevC: 0, curC: 1,
    };
    const csv = buildUtilityCsv([rec as never]);
    expect(csv).toContain("'=cmd");
  });
});

describe('v1.8.15 amounts and calculations', () => {
  const loan = (currency: string, balance: number) => ({
    id: 'loan',
    updateMode: '手動快照',
    majorType: '負債',
    subCategory: '房貸',
    liquidity: '低流動',
    itemName: '貸款',
    ticker: '',
    quantityOrAmount: balance,
    currency,
    unitPrice: 1,
    note: '',
    isAmortizingLoan: true,
    loanAnnualRate: 3.3,
    loanMonthlyPayment: 1234.56,
    loanBillingDay: 5,
    balanceAnchorDate: '2026-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('a USD loan keeps cents in interest and principal; a TWD loan stays in whole dollars', async () => {
    const { computeLoanAmortizationSummary, computeLoanAmortizationSchedule } = await import('../shared/calculations');
    const usd = computeLoanAmortizationSummary(loan('USD', 100000.55) as never, 30, '2026-01-20');
    // one period: interest = 100000.55 * 0.033 / 12 = 275.0015… → 275.00; principal = 1234.56 - 275.00
    expect(usd.elapsedPeriods).toBe(1);
    expect(usd.totalPaidInterest).toBeCloseTo(275, 2);
    expect(usd.currentBalance).toBeCloseTo(100000.55 - (1234.56 - 275), 2);
    const sched = computeLoanAmortizationSchedule(loan('USD', 100000.55) as never, '2026-01-01', 2);
    expect(sched[0].principal).toBeCloseTo(1234.56 - sched[0].interest, 2);
    expect(Number.isInteger(sched[0].principal)).toBe(false); // cents kept
    const twd = computeLoanAmortizationSummary(loan('TWD', 1000000) as never, 1, '2026-01-20');
    expect(Number.isInteger(twd.totalPaidInterest)).toBe(true);
  });

  it('the implied-rate solver covers the same 0–50% range as validation and refuses beyond it', async () => {
    const { solveImpliedLoanAnnualRate } = await import('../shared/calculations');
    // a payment that implies ~40% a year — above the old 30% search cap
    const base = { baseBalance: 100000, anchorDate: '2026-01-01', loanStartDate: '2026-01-01', loanTermYears: 5, billingDay: 1 };
    const r = 0.4 / 12;
    const n = 60;
    const payment = (100000 * r * (1 + r) ** n) / ((1 + r) ** n - 1);
    const solved = solveImpliedLoanAnnualRate({ ...base, monthlyPayment: payment });
    expect(Math.abs(solved.annualRate - 40)).toBeLessThan(1);
    expect(() => solveImpliedLoanAnnualRate({ ...base, monthlyPayment: 10000 })).toThrow(/50%/);
  });

  it('selling more than held: proceeds are booked pro rata to the shares actually held, and the engine refuses it', async () => {
    const { computeStockPositionSummary } = await import('../shared/calculations');
    const asset = {
      id: 's1', updateMode: '手動快照', majorType: '資產', subCategory: '台股', liquidity: '中流動', itemName: '台積電',
      ticker: '2330', quantityOrAmount: 10, currency: 'TWD', unitPrice: 100, costBasis: 1000, note: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const sell = { id: 't1', assetId: 's1', date: '2026-02-01', txType: 'sell', shares: 20, totalAmount: 2400, fee: 0, note: '', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' };
    const pos = computeStockPositionSummary(asset as never, [sell as never], 1);
    // only 10 shares existed: proceeds 2400 × 10/20 = 1200, cost 1000 → realized 200 (not 1400)
    expect(pos.currentShares).toBe(0);
    expect(pos.realizedPnl).toBe(200);

    const { LocalFinanceDB } = await import('../web/src/db/localDb');
    const { SyncEngine } = await import('../web/src/sync/syncEngine');
    const engine = new SyncEngine(new LocalFinanceDB(`v1815-sell-${crypto.randomUUID()}`), { isOnline: () => false, requestLock: async (_n, fn) => fn() });
    await engine.init();
    const a = await engine.saveAsset({ ...asset, id: undefined } as never);
    await expect(engine.addStockTransaction({ assetId: a.id, date: '2026-02-01', txType: 'sell', shares: 11, totalAmount: 1100, fee: 0 } as never)).rejects.toThrow(/超過/);
    engine.destroy();
  });
});

describe('v1.8.15 sync engine details', () => {
  const cf = (name: string) => ({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: name, amount: 10, currency: 'TWD' });
  const offline = (async () => new Response('{}', { status: 503 })) as typeof fetch;

  async function engineFor(name = `v1815-${crypto.randomUUID()}`, extra: Record<string, unknown> = {}) {
    const { LocalFinanceDB, StaleSnapshotError } = await import('../web/src/db/localDb');
    const { SyncEngine } = await import('../web/src/sync/syncEngine');
    const db = new LocalFinanceDB(name);
    const engine = new SyncEngine(db, { fetchImpl: offline, isOnline: () => false, requestLock: async (_n, fn) => fn(), ...extra });
    await engine.init();
    return { db, engine, StaleSnapshotError };
  }

  it('a snapshot that keeps changing in another tab is retried, then reported in Chinese', async () => {
    const { db, engine, StaleSnapshotError } = await engineFor();
    let calls = 0;
    const orig = db.commitLocalMutation.bind(db);
    (db as unknown as { commitLocalMutation: typeof db.commitLocalMutation }).commitLocalMutation = (async (...args: Parameters<typeof orig>) => {
      calls += 1;
      if (calls <= 5) throw new StaleSnapshotError();
      return orig(...args);
    }) as typeof db.commitLocalMutation;
    await expect(engine.addCashFlow(cf('a'))).rejects.toThrow(/其他分頁/);
    expect(calls).toBe(3);
    await engine.addCashFlow(cf('b')); // calls 4, 5 stale → 6 ok
    expect(engine.getSnapshot().cashflowLogs.map((c) => c.itemName)).toEqual(['b']);
    engine.destroy();
    db.close();
  });

  it('batch selection and marking as sent happen in one IndexedDB transaction', async () => {
    const { db, engine } = await engineFor();
    await engine.addCashFlow(cf('a'));
    await engine.addCashFlow(cf('b'));
    const res = await db.takeOutboxBatch((list) => [list[0].mutationId], '2026-11-26T00:00:00.000Z');
    expect(res.batch).toHaveLength(1);
    expect(res.batch[0].sentAt).toBe('2026-11-26T00:00:00.000Z');
    const stored = await db.getOutbox();
    expect(stored.filter((m) => m.sentAt).map((m) => m.mutationId)).toEqual([res.batch[0].mutationId]);
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../web/src/sync/syncEngine.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/takeOutboxBatch/);
    expect(src).not.toMatch(/markOutboxBatchSent\(/);
    engine.destroy();
    db.close();
  });

  it('the in-memory snapshot revision only moves when the write completes', async () => {
    const { db, engine } = await engineFor();
    const before = (db as unknown as { lastSnapshotRev: number }).lastSnapshotRev;
    const idb = (db as unknown as { getDb(): IDBDatabase }).getDb();
    await new Promise<void>((resolve) => {
      const tx = idb.transaction(['kv'], 'readwrite');
      const kv = tx.objectStore('kv');
      (db as unknown as { bumpSnapshotRev(kv: IDBObjectStore): void }).bumpSnapshotRev(kv);
      const probe = kv.get('snapshot_rev');
      probe.onsuccess = () => tx.abort();
      tx.onabort = () => resolve();
    });
    expect((db as unknown as { lastSnapshotRev: number }).lastSnapshotRev).toBe(before);
    engine.destroy();
    db.close();
  });

  it('a lock-setting patch before any meta exists is written in the same transaction', async () => {
    const { LocalFinanceDB } = await import('../web/src/db/localDb');
    const db = new LocalFinanceDB(`v1815-meta-${crypto.randomUUID()}`);
    await db.open();
    const fallback = { ...(await db.getMeta()), lastSyncedAt: null };
    const merged = await db.patchAuthMeta({ pinEnabled: true, pinSalt: 's', pinHash: 'h' }, fallback as never);
    expect(merged?.pinEnabled).toBe(true);
    expect((await db.getMeta()).pinHash).toBe('h');
    db.close();
  });

  it('destroy() resolves after queued local work, so closing the database right after does not break it', async () => {
    const { db, engine } = await engineFor();
    const pending = engine.addCashFlow(cf('queued'));
    await engine.destroy();
    db.close();
    await expect(pending).resolves.toBeTruthy();
  });

  it('rejections no longer hide "offline" / "pending"', async () => {
    const { db, engine } = await engineFor();
    await engine.addCashFlow(cf('a'));
    (engine as unknown as { rejections: unknown[] }).rejections = [{ mutationId: 'x', entity: 'cashflow', op: 'upsert', recordId: 'r', reason: 'x', rejectedAt: 'x' }];
    const status = (engine as unknown as { computeStatus(n: number): { state: string; rejectedCount: number } }).computeStatus(1);
    expect(status.state).toBe('offline');
    expect(status.rejectedCount).toBe(1);
    engine.destroy();
    db.close();
  });

  it('isolation mode and its success streak always change together', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../web/src/sync/syncEngine.ts', import.meta.url), 'utf8');
    expect(src.match(/this\.poisonSearchActive = (true|false)/g) || []).toHaveLength(0);
  });
});

describe('v1.8.15 UI / performance details', () => {
  it('a burst of writes in another tab reloads this tab once (debounced)', async () => {
    const { LocalFinanceDB } = await import('../web/src/db/localDb');
    const { SyncEngine } = await import('../web/src/sync/syncEngine');
    const name = `v1815-debounce-${crypto.randomUUID()}`;
    const offline = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const a = new SyncEngine(new LocalFinanceDB(name), { fetchImpl: offline, isOnline: () => false, requestLock: async (_n, fn) => fn() });
    let snapshots = 0;
    const b = new SyncEngine(new LocalFinanceDB(name), { fetchImpl: offline, isOnline: () => false, requestLock: async (_n, fn) => fn(), onSnapshotChange: () => void (snapshots += 1) });
    await a.init();
    await b.init();
    snapshots = 0;
    for (let i = 0; i < 5; i++) await a.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: `n${i}`, amount: 1, currency: 'TWD' });
    await new Promise((r) => setTimeout(r, 400));
    expect(snapshots).toBe(1);
    expect(b.getSnapshot().cashflowLogs).toHaveLength(5);
    a.destroy();
    b.destroy();
  });

  it('only the visible tab is rendered on a data change; other tabs render when opened', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
    const renderAll = main.slice(main.indexOf('renderAll: () => {'), main.indexOf('scheduleSync: () => {'));
    expect(renderAll).not.toMatch(/renderOverviewTab\(ctx\)|renderStocksTab\(ctx\)/);
    expect(renderAll).toMatch(/renderTabIfDirty\(ctx\.state\.activeTab\)/);
    expect(main).toMatch(/ctx\.state\.activeTab = tab;\s*renderTabIfDirty\(tab\)/);
  });

  it('double submit: a second submit while the first save runs is ignored', async () => {
    const { bindSubmit } = await import('../web/src/ui/helpers');
    const form = new EventTarget() as EventTarget & { dataset: Record<string, string>; querySelectorAll: () => unknown[] };
    form.dataset = {};
    form.querySelectorAll = () => [];
    let runs = 0;
    let release!: () => void;
    bindSubmit(form as unknown as HTMLElement, async (e) => {
      e.preventDefault();
      runs += 1;
      await new Promise<void>((r) => (release = r));
    });
    const submit = () => form.dispatchEvent(Object.assign(new Event('submit', { cancelable: true })));
    submit();
    submit();
    submit();
    expect(runs).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    submit();
    expect(runs).toBe(2);
    release();
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../web/src/ui/', import.meta.url);
    // every form handler goes through bindSubmit (helpers.ts itself holds the one raw listener)
    const sources = [
      ...readdirSync(dir).filter((f) => f !== 'helpers.ts').map((f) => readFileSync(new URL(f, dir), 'utf8')),
      readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8'),
    ];
    for (const src of sources) expect(src).not.toMatch(/\.addEventListener\('submit', /);
  });

  it('accessibility: no maximum-scale, toast is a polite live region, modal closes on Esc and restores focus', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/maximum-scale/);
    expect(html).toMatch(/id="toast" role="status" aria-live="polite"/);
    const helpers = readFileSync(new URL('../web/src/ui/helpers.ts', import.meta.url), 'utf8');
    expect(helpers).toMatch(/e\.key === 'Escape'/);
    expect(helpers).toMatch(/modalReturnFocus/);
  });

  it('"today" is the APP_TIMEZONE date (Asia/Taipei), not the device or UTC date', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-30T20:00:00.000Z')); // 2026-12-01 04:00 in Taipei
    const { getTodayYmd } = await import('../web/src/ui/logTab');
    const { todayInTimeZone, ymdInTimeZone } = await import('../shared/dates');
    expect(todayInTimeZone()).toBe('2026-12-01');
    expect(getTodayYmd()).toBe('2026-12-01');
    expect(ymdInTimeZone('2026-11-30T20:00:00.000Z')).toBe('2026-12-01');
    vi.useRealTimers();
  });

  it('iOS download: the object URL is revoked later, not right after click()', async () => {
    const { readFileSync } = await import('node:fs');
    const helpers = readFileSync(new URL('../web/src/ui/helpers.ts', import.meta.url), 'utf8');
    const fn = helpers.slice(helpers.indexOf('export function downloadTextFile'));
    expect(fn).toMatch(/setTimeout\(\(\) => URL\.revokeObjectURL\(url\), \d+/);
  });
});

describe('v1.8.15 B7 tenant column', () => {
  it('every INSERT into a table whose user_id still defaults to \'owner\' names user_id explicitly', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const migDir = new URL('../migrations/', import.meta.url);
    const tables = new Set<string>();
    for (const f of readdirSync(migDir).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(new URL(f, migDir), 'utf8');
      for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
        if (/user_id TEXT NOT NULL DEFAULT 'owner'/.test(m[2])) tables.add(m[1].replace(/_(new|v2)$/, ''));
      }
      for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'/g)) tables.add(m[1]);
    }
    expect(tables.size).toBeGreaterThanOrEqual(10);
    const workerDir = new URL('../worker/', import.meta.url);
    const offenders: string[] = [];
    let checked = 0;
    for (const f of readdirSync(workerDir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, workerDir), 'utf8');
      for (const m of src.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*(\(([^)]*)\))?/gi)) {
        if (!tables.has(m[1])) continue;
        checked += 1;
        const cols = (m[3] || '').split(',').map((c) => c.trim());
        if (!cols.includes('user_id')) offenders.push(`${f}: INSERT INTO ${m[1]} (${m[3] ?? '— no column list —'})`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(offenders).toEqual([]);
    // v1.16.0: row-entity INSERTs are generated centrally by worker/entityRegistry.ts; verify those also name user_id
    const { SYNC_ENTITY_METAS, buildRowUpsertSql, buildChunkedImportSql } = await import('../worker/entityRegistry');
    for (const meta of SYNC_ENTITY_METAS.filter((m) => m.kind === 'row')) {
      const keyCol = meta.keyColumn as 'id' | 'period';
      const ins = buildRowUpsertSql({
        table: meta.table,
        keyColumn: keyCol,
        isUpdate: false,
        uid: 'u1',
        recordId: 'r1',
        columns: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        writeTs: '2026-01-01T00:00:00.000Z',
        nextVersion: 1,
        expectedEpoch: 1,
      });
      expect(ins.sql).toMatch(new RegExp(`INSERT INTO ${meta.table}\\s*\\(\\s*user_id,`, 'i'));
      const imp = buildChunkedImportSql({ table: meta.table, keyColumn: keyCol, jsonColumns: [keyCol, 'created_at', 'updated_at'] });
      expect(imp).toMatch(new RegExp(`INSERT INTO ${meta.table}\\s*\\(\\s*user_id,`, 'i'));
    }
  });
});

describe('v1.8.15 review follow-ups', () => {
  it('the app\'s own CSV export re-imports unchanged, and numeric text is never prefixed', async () => {
    const { exportCashFlowCsv, parseCashFlowCsv } = await import('../shared/csv');
    const { escapeCsvCell } = await import('../shared/format');
    expect(escapeCsvCell('-12.00')).toBe('-12.00');
    expect(escapeCsvCell('+3')).toBe('+3');
    const log = {
      id: 'x', date: '2026-11-26', yearMonth: '2026-11', type: '日常花費', category: '餐飲', itemName: '-午餐',
      amount: 100, currency: 'TWD', fxRate: 1, twdAmount: 100, source: '手機記帳', note: '@小明 +1',
      createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z',
    };
    const csv = exportCashFlowCsv([log as never]);
    expect(csv).toContain("'-午餐");
    const back = parseCashFlowCsv(csv)[0];
    expect(back.itemName).toBe('-午餐');
    expect(back.note).toBe('@小明 +1');
  });

  it('fmtNum / fmtRaw never show "-0"', async () => {
    const { fmtNum, fmtRaw } = await import('../web/src/ui/helpers');
    expect(fmtNum(-0.4)).toBe('0');
    expect(fmtRaw(-0.004, 'USD', false)).toBe('US$0');
  });

  it('modal Esc / Tab handling yields to the calculator, the lock screen and IME composition; touch devices do not auto-focus inputs; only errors are de-duplicated', async () => {
    const { readFileSync } = await import('node:fs');
    const h = readFileSync(new URL('../web/src/ui/helpers.ts', import.meta.url), 'utf8');
    const keys = h.slice(h.indexOf('function bindModalKeys'), h.indexOf('export function openModal'));
    expect(keys).toMatch(/e\.isComposing/);
    expect(keys).toMatch(/calcBackdrop/);
    expect(keys).toMatch(/lockScreen/);
    expect(keys.indexOf('calcBackdrop')).toBeLessThan(keys.indexOf("e.key === 'Escape'"));
    expect(h).toMatch(/pointer: coarse/);
    expect(h).toMatch(/variant === 'error' && lastToast/);
  });

  it('asset anchors and the initial month use the APP_TIMEZONE date', async () => {
    const { readFileSync } = await import('node:fs');
    const eng = readFileSync(new URL('../web/src/sync/syncEngine.ts', import.meta.url), 'utf8');
    expect(eng).not.toMatch(/nowIso\.slice\(0, 10\)/);
    const main = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/selectedYear: now\.getFullYear\(\)/);
  });
});
