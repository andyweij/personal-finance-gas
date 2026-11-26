import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { createApp } from '../worker/index';
import {
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  finishPasskeyAuthentication,
  setupInitialAdmin,
} from '../worker/auth';
import { importFullSnapshot, processSyncRequest } from '../worker/sync';
import type { SyncMutation, SyncResponse } from '../shared/types';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createTestD1 } from './helpers/mockD1';

describe('Stage 1 Security & Sync Hardening (1.1 - 1.6)', () => {
  it('1.1 & 1.2: binds passkey auth challenge from clientDataJSON, prevents allowCredentials user enumeration, and rate-limits login/options', async () => {
    const db = createTestD1();
    const admin = await setupInitialAdmin(db, {
      username: 'alice',
      displayName: 'Alice',
      password: 'Password123!',
    });

    // Seed an existing passkey for alice
    await db
      .prepare(
        `INSERT INTO auth_passkeys (credential_id, user_id, public_key, counter, transports, device_name, created_at)
         VALUES (?, ?, ?, 0, '["internal"]', 'iPhone', ?)`
      )
      .bind('cred-alice-1', admin.id, isoBase64URL.fromBuffer(new Uint8Array([1, 2, 3])), new Date().toISOString())
      .run();

    // 1.2: Calling login options with a username MUST NOT leak allowCredentials
    const opts1 = await createPasskeyAuthenticationOptions(db, 'localhost', 'alice');
    expect(opts1.allowCredentials).toBeUndefined();

    // 1.1: Concurrent login options must NOT invalidate the earlier challenge when verifying
    const opts2 = await createPasskeyAuthenticationOptions(db, 'localhost');
    expect(opts1.challenge).not.toBe(opts2.challenge);

    // Build a clientDataJSON referencing opts1.challenge (the older challenge!)
    const clientData1 = isoBase64URL.fromUTF8String(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: opts1.challenge,
        origin: 'http://localhost',
      })
    );

    // Calling finishPasskeyAuthentication with opts1.challenge should consume ONLY opts1.challenge
    // (verification will fail on bogus signature, which is fine — we verify opts1 was consumed and opts2 survived!)
    await expect(
      finishPasskeyAuthentication(db, 'localhost', 'http://localhost', {
        id: 'cred-alice-1',
        rawId: 'cred-alice-1',
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(37)),
          clientDataJSON: clientData1,
          signature: isoBase64URL.fromBuffer(new Uint8Array(64)),
        },
      })
    ).rejects.toThrow();

    // opts1 challenge should now be consumed (deleted), while opts2 challenge MUST still exist!
    const rem1 = await db
      .prepare('SELECT challenge FROM auth_challenges WHERE challenge = ?')
      .bind(opts1.challenge)
      .first();
    const rem2 = await db
      .prepare('SELECT challenge FROM auth_challenges WHERE challenge = ?')
      .bind(opts2.challenge)
      .first();
    expect(rem1).toBeNull();
    expect(rem2).not.toBeNull();

    // 1.1: Rate-limiting on POST /api/auth/passkey/login/options
    const app = createApp();
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await app.request(
        'http://localhost/api/auth/passkey/login/options',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '203.0.113.55',
          },
          body: JSON.stringify({}),
        },
        { DB: db, ASSETS: { fetch: async () => new Response('ok') } as unknown as Fetcher }
      );
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('1.2: prevents overwriting another user passkey with the same credential_id', async () => {
    const db = createTestD1();
    const admin = await setupInitialAdmin(db, {
      username: 'owner1',
      displayName: 'Owner',
      password: 'Password123!',
    });

    await createPasskeyRegistrationOptions(db, admin, 'localhost');
    // Direct check: auth_passkeys should reject duplicate credential_id when using INSERT (not INSERT OR REPLACE)
    // We test via finishPasskeyRegistration helper or inspect that duplicate credential_id cannot overwrite another user
    const nowIso = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO auth_passkeys (credential_id, user_id, public_key, counter, transports, device_name, created_at)
         VALUES ('shared-cred-id', 'victim-user', 'victim-key', 5, '[]', 'Victim Phone', ?)`
      )
      .bind(nowIso)
      .run();

    // Verify helper exported for atomic passkey insert refuses overwriting an existing credential_id
    const { insertPasskeyCredentialOrThrow } = await import('../worker/auth');
    await expect(
      insertPasskeyCredentialOrThrow(db, {
        credentialId: 'shared-cred-id',
        userId: admin.id,
        publicKeyB64: 'attacker-key',
        counter: 0,
        transports: '[]',
        deviceName: 'Attacker',
        nowIso,
      })
    ).rejects.toThrow();

    const victimRow = await db
      .prepare('SELECT user_id, public_key FROM auth_passkeys WHERE credential_id = ?')
      .bind('shared-cred-id')
      .first<{ user_id: string; public_key: string }>();
    expect(victimRow?.user_id).toBe('victim-user');
    expect(victimRow?.public_key).toBe('victim-key');
  });

  it('1.3: enforces atomic conditional optimistic locking when two concurrent updates share the same baseVersion', async () => {
    const db = createTestD1();
    const userId = 'owner';

    // Create initial cashflow record (version = 1)
    const createRes = await processSyncRequest(db, userId, {
      since: null,
      mutations: [
        {
          mutationId: 'm-create-1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-race-1',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '餐飲',
            itemName: '原始午餐',
            amount: 100,
            currency: 'TWD',
          },
        },
      ],
    });
    expect(createRes.ackedMutationIds).toEqual(['m-create-1']);

    // Simulate a true race condition by wrapping db.prepare so both concurrent requests read version=1
    // before either executes its write!
    let selectBarrierCount = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const racingDb = {
      ...db,
      // v1.8.13 (H5): the row read is now prefetched inside a batch — hold that batch at the same barrier
      batch: async (stmts: D1PreparedStatement[]) => {
        const results = await db.batch(stmts);
        const readsRow = stmts.some((st) =>
          String((st as unknown as { query?: string }).query || '').includes(
            'SELECT * FROM cashflow_logs WHERE user_id = ? AND id = ?'
          )
        );
        if (readsRow) {
          selectBarrierCount += 1;
          if (selectBarrierCount === 2) {
            releaseBarrier();
          } else {
            await barrier;
          }
        }
        return results;
      },
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
              selectBarrierCount += 1;
              if (selectBarrierCount === 2) {
                releaseBarrier();
              } else {
                await barrier;
              }
              return row;
            }) as typeof bound.first;
            return bound;
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const reqA = processSyncRequest(racingDb, userId, {
      since: null,
      mutations: [
        {
          mutationId: 'm-race-A',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-race-1',
          clientTimestamp: '2026-11-25T10:01:00.000Z',
          baseVersion: 1,
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '餐飲',
            itemName: '裝置 A 修改',
            amount: 150,
            currency: 'TWD',
          },
        },
      ],
    });

    const reqB = processSyncRequest(racingDb, userId, {
      since: null,
      mutations: [
        {
          mutationId: 'm-race-B',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-race-1',
          clientTimestamp: '2026-11-25T10:01:01.000Z',
          baseVersion: 1,
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '餐飲',
            itemName: '裝置 B 修改',
            amount: 200,
            currency: 'TWD',
          },
        },
      ],
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    const totalAcked = resA.ackedMutationIds.length + resB.ackedMutationIds.length;
    const totalConflicts = (resA.conflicts ?? []).length + (resB.conflicts ?? []).length;

    // Strictly ONE succeeds and ONE gets a VersionConflict (not both succeeding!)
    expect(totalAcked).toBe(1);
    expect(totalConflicts).toBe(1);

    // Also verify 1.4 atomicity: ONLY the winning mutation was recorded in sync_idempotency
    const ackedId = resA.ackedMutationIds[0] || resB.ackedMutationIds[0];
    const loserId = ackedId === 'm-race-A' ? 'm-race-B' : 'm-race-A';
    const winnerIdemp = await db
      .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
      .bind(userId, ackedId)
      .first();
    const loserIdemp = await db
      .prepare('SELECT mutation_id FROM sync_idempotency WHERE user_id = ? AND mutation_id = ?')
      .bind(userId, loserId)
      .first();
    expect(winnerIdemp).toBeTruthy();
    expect(loserIdemp).toBeNull();

    // Concurrent CREATE race (INSERT ... ON CONFLICT DO NOTHING): both see null existing row
    let createBarrierCount = 0;
    let releaseCreateBarrier!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreateBarrier = resolve;
    });
    const racingCreateDb = {
      ...db,
      // v1.8.13 (H5): the row read is now prefetched inside a batch — hold that batch at the same barrier
      batch: async (stmts: D1PreparedStatement[]) => {
        const results = await db.batch(stmts);
        const readsRow = stmts.some((st) =>
          String((st as unknown as { query?: string }).query || '').includes(
            'SELECT * FROM cashflow_logs WHERE user_id = ? AND id = ?'
          )
        );
        if (readsRow) {
          createBarrierCount += 1;
          if (createBarrierCount === 2) {
            releaseCreateBarrier();
          } else if (createBarrierCount < 2) {
            await createBarrier;
          }
        }
        return results;
      },
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
              createBarrierCount += 1;
              if (createBarrierCount === 2) {
                releaseCreateBarrier();
              } else if (createBarrierCount < 2) {
                await createBarrier;
              }
              return row;
            }) as typeof bound.first;
            return bound;
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const [createA, createB] = await Promise.all([
      processSyncRequest(racingCreateDb, userId, {
        since: null,
        mutations: [
          {
            mutationId: 'm-create-race-A',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf-create-race-1',
            clientTimestamp: '2026-11-25T10:02:00.000Z',
            baseVersion: null,
            payload: {
              date: '2026-11-25',
              type: '日常花費',
              category: '餐飲',
              itemName: '併發新建 A',
              amount: 111,
              currency: 'TWD',
            },
          },
        ],
      }),
      processSyncRequest(racingCreateDb, userId, {
        since: null,
        mutations: [
          {
            mutationId: 'm-create-race-B',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf-create-race-1',
            clientTimestamp: '2026-11-25T10:02:01.000Z',
            baseVersion: null,
            payload: {
              date: '2026-11-25',
              type: '日常花費',
              category: '餐飲',
              itemName: '併發新建 B',
              amount: 222,
              currency: 'TWD',
            },
          },
        ],
      }),
    ]);

    expect(createA.ackedMutationIds.length + createB.ackedMutationIds.length).toBe(1);
    expect((createA.conflicts ?? []).length + (createB.conflicts ?? []).length).toBe(1);
  });

  it('1.4: replace import validates all records before modifying DB and leaves existing data intact on failure', async () => {
    const db = createTestD1();
    const userId = 'owner';

    // Seed an existing cashflow log
    await processSyncRequest(db, userId, {
      since: null,
      mutations: [
        {
          mutationId: 'm-seed-1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf-keep-1',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
          baseVersion: null,
          payload: {
            date: '2026-11-25',
            type: '日常花費',
            category: '餐飲',
            itemName: '珍貴既有資料',
            amount: 500,
            currency: 'TWD',
          },
        },
      ],
    });

    // Attempt replace import containing one valid log and one invalid log (negative amount)
    await expect(
      importFullSnapshot(
        db,
        userId,
        {
          cashflowLogs: [
            {
              id: 'good-1',
              date: '2026-11-25',
              yearMonth: '2026-11',
              type: '日常花費',
              category: '餐飲',
              itemName: '有效',
              amount: 100,
              currency: 'TWD',
              fxRate: 1,
              twdAmount: 100,
              source: '匯入',
              note: '',
              createdAt: '2026-11-25T00:00:00.000Z',
              updatedAt: '2026-11-25T00:00:00.000Z',
            },
            {
              id: 'bad-1',
              date: '2026-11-25',
              yearMonth: '2026-11',
              type: '日常花費',
              category: '餐飲',
              itemName: '無效負數',
              amount: -999,
              currency: 'TWD',
              fxRate: 1,
              twdAmount: -999,
              source: '匯入',
              note: '',
              createdAt: '2026-11-25T00:00:00.000Z',
              updatedAt: '2026-11-25T00:00:00.000Z',
            },
          ],
        },
        'replace'
      )
    ).rejects.toThrow();

    // Existing record MUST NOT have been wiped!
    const existing = await db
      .prepare('SELECT item_name FROM cashflow_logs WHERE user_id = ? AND id = ?')
      .bind(userId, 'cf-keep-1')
      .first<{ item_name: string }>();
    expect(existing?.item_name).toBe('珍貴既有資料');
  });

  it('1.6: rejects unknown entity or unknown op instead of silently acking', async () => {
    const db = createTestD1();
    const res = await processSyncRequest(db, 'owner', {
      since: null,
      mutations: [
        {
          mutationId: 'm-unknown-entity',
          entity: 'nonexistent_table' as SyncMutation['entity'],
          op: 'upsert',
          recordId: 'r-1',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
          payload: {},
        },
        {
          mutationId: 'm-unknown-op',
          entity: 'cashflow',
          op: 'truncate' as SyncMutation['op'],
          recordId: 'r-2',
          clientTimestamp: '2026-11-25T10:00:00.000Z',
          payload: {},
        },
      ],
    });

    expect(res.ackedMutationIds).toEqual([]);
    expect(res.rejected).toHaveLength(2);
    expect(res.rejected.map((r) => r.mutationId).sort()).toEqual([
      'm-unknown-entity',
      'm-unknown-op',
    ]);
  });

  it('1.5: SyncEngine removes rejected mutations from outbox, records rejections, and rolls back rejected creates', async () => {
    const localDb = new LocalFinanceDB(`test-rejected-${crypto.randomUUID()}`);
    const engine = new SyncEngine(localDb, {
      isOnline: () => true,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as { mutations: SyncMutation[] };
        const resp: SyncResponse = {
          ok: true,
          serverTime: '2026-11-25T12:00:00.000Z',
          ackedMutationIds: [],
          rejected: body.mutations.map((m) => ({
            mutationId: m.mutationId,
            reason: '伺服器拒絕：資料格式無效',
          })),
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
      }) as typeof fetch,
    });
    await engine.init();

    const created = await engine.addCashFlow({
      date: '2026-11-25',
      type: '日常花費',
      category: '餐飲',
      itemName: '會被拒絕的記帳',
      amount: 120,
      currency: 'TWD',
    });
    expect(engine.getSnapshot().cashflowLogs.some((c) => c.id === created.id)).toBe(true);

    const syncRes = await engine.syncNow();
    expect(syncRes.ok).toBe(true);

    // Rejected mutation MUST be cleared from outbox (no infinite retry loop!)
    expect(await localDb.getOutbox()).toHaveLength(0);
    // Stored in rejections list for UI display
    expect(engine.getRejections()).toHaveLength(1);
    expect(engine.getRejections()[0].reason).toContain('伺服器拒絕');
    // Unpersisted create rolled back from local snapshot
    expect(engine.getSnapshot().cashflowLogs.some((c) => c.id === created.id)).toBe(false);
    // Dismissing rejection clears it
    await engine.dismissRejection(engine.getRejections()[0].mutationId);
    expect(engine.getRejections()).toHaveLength(0);
  });
});
