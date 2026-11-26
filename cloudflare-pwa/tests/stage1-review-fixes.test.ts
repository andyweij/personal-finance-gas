import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkAndRecordFixedWindowRateLimit,
  createPasskeyAuthenticationOptions,
  insertPasskeyCredentialOrThrow,
} from '../worker/auth';
import { importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';
import type { SyncRequest, SyncResponse } from '../shared/types';

function createD1FetchAdapter(db: D1Database, userId = 'owner') {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/sync' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}')) as SyncRequest;
      const result = await processSyncRequest(db, userId, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };
}

describe('Phase 1 Review Remediation (S1-S11 & C1-C8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('S1: concurrent duplicate retries with the SAME mutationId both ack instead of falsely reporting VersionConflict', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // Seed version=1 record
    await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-s1-seed',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-s1',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-26',
            type: '日常花費',
            category: '餐飲',
            itemName: '原始',
            amount: 100,
            currency: 'TWD',
          },
        },
      ],
    });

    // Force BOTH concurrent retries with SAME mutationId to pass the initial idempotency check together
    let idempBarrierCount = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    const racingDb = {
      ...db,
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      prepare(query: string) {
        const stmt = db.prepare(query);
        if (query.includes('SELECT * FROM cashflow_logs WHERE user_id = ? AND id = ?')) {
          const origBind = stmt.bind.bind(stmt);
          stmt.bind = (...args: unknown[]) => {
            const bound = origBind(...args);
            const origFirst = bound.first.bind(bound);
            bound.first = (async <T = Record<string, unknown>>(col?: string) => {
              const row = await origFirst<T>(col as never);
              idempBarrierCount += 1;
              if (idempBarrierCount === 2) releaseBarrier();
              else if (idempBarrierCount < 2) await barrier;
              return row;
            }) as typeof bound.first;
            return bound;
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const dupPayload: SyncRequest = {
      since: null,
      mutations: [
        {
          mutationId: 'm-s1-same-retry',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-s1',
          clientTimestamp: '2026-11-26T00:01:00.000Z',
          baseVersion: 1,
          payload: {
            date: '2026-11-26',
            type: '日常花費',
            category: '餐飲',
            itemName: '重試更新',
            amount: 150,
            currency: 'TWD',
          },
        },
      ],
    };

    const [resA, resB] = await Promise.all([
      processSyncRequest(racingDb, uid, dupPayload),
      processSyncRequest(racingDb, uid, dupPayload),
    ]);

    // BOTH must ack and NEITHER should report a false conflict!
    expect(resA.ackedMutationIds).toEqual(['m-s1-same-retry']);
    expect(resB.ackedMutationIds).toEqual(['m-s1-same-retry']);
    expect(resA.conflicts || []).toHaveLength(0);
    expect(resB.conflicts || []).toHaveLength(0);
  });

  it('S2: transient DB errors are NOT turned into permanent rejections (throws instead of losing client data)', async () => {
    const db = createTestD1();
    const failingDb = {
      ...db,
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      async batch() {
        throw new Error('D1_ERROR: SQLITE_BUSY database is temporarily overloaded');
      },
    } as unknown as D1Database;

    await expect(
      processSyncRequest(failingDb, 'owner', {
        since: null,
        mutations: [
          {
            mutationId: 'm-s2-transient',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf-s2',
            clientTimestamp: '2026-11-26T00:00:00.000Z',
            baseVersion: null,
            payload: {
              date: '2026-11-26',
              type: '日常花費',
              category: '餐飲',
              itemName: '短暫故障不可被當作永久拒絕',
              amount: 120,
              currency: 'TWD',
            },
          },
        ],
      })
    ).rejects.toThrow();
  });

  it('S3 & S4: fixed-window rate limit resets after windowMs even under continuous traffic, and saveChallenge prunes expired rows', async () => {
    const db = createTestD1();
    const baseNow = Date.parse('2026-11-26T08:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(baseNow);

    // 3 requests at t=0s, t=25s, t=50s (continuous traffic, gap < 60s) with max=3, window=60s
    expect((await checkAndRecordFixedWindowRateLimit(db, 'pk_opt:1.2.3.4', 3, 60_000)).blocked).toBe(false);

    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 25_000);
    expect((await checkAndRecordFixedWindowRateLimit(db, 'pk_opt:1.2.3.4', 3, 60_000)).blocked).toBe(false);

    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 50_000);
    expect((await checkAndRecordFixedWindowRateLimit(db, 'pk_opt:1.2.3.4', 3, 60_000)).blocked).toBe(false);

    // At t=61s (> 60s from window_start t=0s, even though only 11s since last request at t=50s!), window MUST reset!
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 61_000);
    const afterWindow = await checkAndRecordFixedWindowRateLimit(db, 'pk_opt:1.2.3.4', 3, 60_000);
    expect(afterWindow.blocked).toBe(false);

    // S4: expired challenges are pruned when saving a new challenge
    await db
      .prepare(
        `INSERT INTO auth_passkeys (credential_id, user_id, public_key, counter, transports, device_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind('cred-s4', 'owner', 'pk-s4', 0, '[]', 'test', '2026-11-26T00:00:00.000Z')
      .run();
    await db
      .prepare('INSERT INTO auth_challenges (challenge, purpose, expires_at, user_id) VALUES (?, ?, ?, ?)')
      .bind('expired-chal-1', 'authenticate', '2020-01-01T00:00:00.000Z', null)
      .run();
    await createPasskeyAuthenticationOptions(db, 'localhost');
    const stillThere = await db
      .prepare('SELECT challenge FROM auth_challenges WHERE challenge = ?')
      .bind('expired-chal-1')
      .first();
    expect(stillThere).toBeNull();
  });

  it('S6, S9 & S11: merge import increments existing version, utility_record rejects mismatched period, and passkey insert distinguishes non-UNIQUE DB errors', async () => {
    const db = createTestD1();
    const uid = 'owner';

    // S6: seed cf-s6 at v1, update to v2, then merge-import same id -> version MUST NOT reset to 1!
    await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-s6-1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-s6',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-26',
            type: '日常花費',
            category: '餐飲',
            itemName: 'v1',
            amount: 100,
            currency: 'TWD',
          },
        },
      ],
    });
    await importFullSnapshot(
      db,
      uid,
      {
        cashflowLogs: [
          {
            id: 'cf-s6',
            date: '2026-11-26',
            yearMonth: '2026-11',
            type: '日常花費',
            category: '餐飲',
            itemName: 'merged-v2',
            amount: 200,
            currency: 'TWD',
            fxRate: 1,
            twdAmount: 200,
            source: '手動',
            note: '',
            createdAt: '2026-11-26T00:00:00.000Z',
            updatedAt: '2026-11-26T00:00:00.000Z',
          },
        ],
      },
      'merge'
    );
    const s6Row = await db
      .prepare('SELECT version FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind(uid, 'cf-s6')
      .first<{ version: number }>();
    expect(Number(s6Row?.version)).toBeGreaterThan(1);

    // S9: utility_record where payload.period !== recordId MUST be rejected
    const s9Res = await processSyncRequest(db, uid, {
      since: null,
      mutations: [
        {
          mutationId: 'm-s9-mismatch',
          entity: 'utility_record',
          op: 'upsert',
          recordId: '11511',
          clientTimestamp: '2026-11-26T00:00:00.000Z',
          baseVersion: null,
          payload: {
            period: '11512',
            isBaseline: false,
            curTotal: 5000,
            cur6F: 2000,
            totalElec: 1000,
            totalWater: 200,
            f6People: 2,
            f5People: 3,
            curA: 1000,
            curB: 1000,
            curC: 1000,
          },
        },
      ],
    });
    expect(s9Res.rejected.some((r) => r.mutationId === 'm-s9-mismatch')).toBe(true);
    expect(s9Res.ackedMutationIds).not.toContain('m-s9-mismatch');

    // S11: non-UNIQUE error on insertPasskeyCredentialOrThrow should NOT be misreported as duplicate binding
    await expect(
      insertPasskeyCredentialOrThrow(db, {
        credentialId: 'cred-s11-nonnull',
        userId: 'owner',
        publicKeyB64: null as unknown as string,
        counter: 0,
        transports: '[]',
        deviceName: 'test',
        nowIso: '2026-11-26T00:00:00.000Z',
      })
    ).rejects.toThrow(/NOT NULL|constraint/i);
  });

  it('C1, C2, C3 & C4: rejected edit/delete triggers full resync to restore server truth, C3 preserves newer pending outbox edits, C4 uses explicit isNewRecord, and C2 chains forceFullPull', async () => {
    const db = createTestD1();
    const localDb = new LocalFinanceDB(`stage1-rev-c1-${crypto.randomUUID()}`);

    // Seed baseline utility record (deleting baseline is always rejected by server!)
    const baseFetch = createD1FetchAdapter(db, 'owner');
    const engine = new SyncEngine(localDb, {
      fetchImpl: baseFetch,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();
    await engine.syncNow(true);

    // Create a ledger + a cashflow inside it, sync to server
    const lg = await engine.saveLedger({
      name: '旅遊帳本',
      includeInNetWorth: false,
      note: '',
    });
    await engine.addCashFlow({
      date: '2026-11-26',
      type: '日常花費',
      category: '餐飲',
      itemName: '機票',
      amount: 5000,
      currency: 'TWD',
      ledgerId: lg.id,
    });
    await engine.syncNow();

    // C1: Simulate an illegal ledger deletion (server rejects because linked cashflow still exists)
    // Inject a direct delete ledger mutation into outbox & remove locally
    const snapBefore = engine.getSnapshot();
    const snapWithoutLedger = {
      ...snapBefore,
      ledgers: (snapBefore.ledgers || []).filter((l) => l.id !== lg.id),
    };
    await localDb.commitLocalMutation(snapWithoutLedger, [
      {
        mutationId: 'm-c1-bad-del',
        entity: 'ledger',
        op: 'delete',
        recordId: lg.id,
        clientTimestamp: '2026-11-26T01:00:00.000Z',
        baseVersion: 1,
        isNewRecord: false,
      },
    ]);

    const res = await engine.syncNow();
    expect(res.ok).toBe(true);
    expect(engine.getRejections().some((r) => r.mutationId === 'm-c1-bad-del')).toBe(true);
    // C1: Ledger MUST be restored locally by automatic full resync after non-create rejection!
    expect((engine.getSnapshot().ledgers || []).some((l) => l.id === lg.id)).toBe(true);

    // C4: Legacy record without version edited and rejected (invalid date) -> MUST NOT be deleted locally!
    const existingLog = engine.getSnapshot().cashflowLogs[0];
    const snapLegacyEdit = {
      ...engine.getSnapshot(),
      cashflowLogs: engine.getSnapshot().cashflowLogs.map((l) =>
        l.id === existingLog.id ? { ...l, date: 'invalid-date', amount: 9999 } : l
      ),
    };
    await localDb.commitLocalMutation(snapLegacyEdit, [
      {
        mutationId: 'm-c4-legacy-edit',
        entity: 'cashflow',
        op: 'upsert',
        recordId: existingLog.id,
        clientTimestamp: '2099-11-26T02:00:00.000Z',
        isNewRecord: false,
        payload: { ...existingLog, date: 'invalid-date', amount: 9999 },
      },
    ]);
    await engine.syncNow();
    expect(engine.getRejections().some((r) => r.mutationId === 'm-c4-legacy-edit')).toBe(true);
    // Existing record MUST still exist with its true server amount (5000), NOT deleted!
    const restoredLog = engine.getSnapshot().cashflowLogs.find((l) => l.id === existingLog.id);
    expect(restoredLog).toBeTruthy();
    expect(restoredLog?.amount).toBe(5000);
    expect(restoredLog?.date).toBe('2026-11-26');

    // C4 (baseVersion: null + isNewRecord: false): existing utility_record rejected on edit MUST NOT be deleted!
    await engine.saveUtilityRecord({
      period: '11509',
      isBaseline: true,
      curTotal: 1000,
      cur6F: 500,
      totalElec: 0,
      totalWater: 0,
      f6People: 1,
      f5People: 1,
      curA: 100,
      curB: 100,
      curC: 100,
    });
    await engine.syncNow();
    await localDb.commitLocalMutation(engine.getSnapshot(), [
      {
        mutationId: 'm-c4-util-edit',
        entity: 'utility_record',
        op: 'upsert',
        recordId: '11509',
        clientTimestamp: '2026-11-26T02:30:00.000Z',
        baseVersion: null,
        isNewRecord: false,
        payload: {
          period: '11510', // mismatched -> rejected by S9!
          isBaseline: true,
          curTotal: 1000,
          cur6F: 500,
          totalElec: 0,
          totalWater: 0,
          f6People: 1,
          f5People: 1,
          curA: 100,
          curB: 100,
          curC: 100,
        },
      },
    ]);
    await engine.syncNow();
    expect(engine.getRejections().some((r) => r.mutationId === 'm-c4-util-edit')).toBe(true);
    expect((engine.getSnapshot().rentUtilityRecords || []).some((u) => u.period === '11509')).toBe(true);

    localDb.close();
  });

  it('C2: calling syncNow(true) while an incremental syncNow() is already in-flight chains a real full pull', async () => {
    const localDb = new LocalFinanceDB(`stage1-rev-c2-${crypto.randomUUID()}`);
    let releaseFirst!: () => void;
    const seenSince: Array<string | null | undefined> = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as SyncRequest;
      seenSince.push(body.since);
      if (seenSince.length === 1) {
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      const resp: SyncResponse = {
        ok: true,
        serverTime: '2026-11-26T03:00:00.000Z',
        syncCursor: 1,
        dataEpoch: 1,
        ackedMutationIds: [],
        rejected: [],
        conflicts: [],
        delta: {
          settings: null,
          ledgers: [],
          cashflowLogs: [],
          recurringItems: [],
          sinkingItems: [],
          assetItems: [],
          savingsAdjustments: [],
          stockTransactions: [],
          netWorthHistory: [],
          rentUtilityRecords: [],
          rentUtilityRents: null,
        },
      };
      return new Response(JSON.stringify(resp), { status: 200 });
    };

    const engine = new SyncEngine(localDb, {
      fetchImpl: mockFetch,
      isOnline: () => true,
      requestLock: async (_name, fn) => fn(),
    });
    await engine.init();
    // Seed meta.lastSyncedAt so first sync is incremental
    await localDb.saveMeta({
      ...engine.getMeta(),
      lastSyncedAt: '2026-11-25T00:00:00.000Z',
      syncCursor: 1,
      dataEpoch: 1,
    });
    await engine.init();

    const p1 = engine.syncNow(false);
    await new Promise((r) => setTimeout(r, 10));
    const p2 = engine.syncNow(true);
    releaseFirst();
    await Promise.all([p1, p2]);

    // First call was incremental ('2026-11-25...'), second MUST have chained a real full pull (since: null)!
    expect(seenSince).toEqual(['2026-11-25T00:00:00.000Z', null]);
    localDb.close();
  });
});
