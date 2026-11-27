import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_ID } from '../shared/constants';
import type { SyncRequest } from '../shared/types';
import { createApp } from '../worker/index';
import {
  createSharedLedgerInvite,
  joinSharedLedgerByCode,
  listSharedLedgersForUser,
  removeOrLeaveSharedLedger,
  revokeSharedLedgerInvite,
  SHARED_LEDGER_MIGRATION_ERROR,
  updateSharedLedgerMemberRole,
  updateSharedLedgerPreference,
} from '../worker/sharedLedgers';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { createCountingD1, createTestD1 } from './helpers/mockD1';
import { createSession } from '../worker/auth';

async function seedUser(
  db: D1Database,
  id: string,
  username: string,
  displayName: string,
  role: 'admin' | 'member' = 'member'
): Promise<void> {
  const now = '2026-01-01T00:00:00.000Z';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, password_salt, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'hash', 'salt', ?, ?)`
    )
    .bind(id, username, displayName, role, now, now)
    .run();
}

function createApiFetchAdapter(db: D1Database, userId: string): typeof fetch {
  const app = createApp();
  let cookiePromise: Promise<string> | null = null;
  const getCookie = () => {
    if (!cookiePromise) {
      cookiePromise = createSession(db, userId, 'test-device').then((tok) => `pf_session=${tok}`);
    }
    return cookiePromise;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? `https://app.test${input}` : String(input);
    const cookie = await getCookie();
    const headers = new Headers(init?.headers || {});
    headers.set('cookie', cookie);
    headers.set('origin', 'https://app.test');
    const req = new Request(urlStr, {
      ...init,
      headers,
    });
    return app.fetch(req, { DB: db } as never);
  }) as typeof fetch;
}

describe('Phase 9 (v2.0.0) Shared Ledgers — Lifecycle, Attribution, Client Sync & Security', () => {
  it('supports full collaborative lifecycle: invite, join, bidirectional sync, attribution, conflict, preference, and revocation cache purge', async () => {
    const db = createTestD1();
    await seedUser(db, 'alice', 'alice', 'Alice', 'admin');
    await seedUser(db, 'bob', 'bob', 'Bob', 'member');

    // Alice creates a custom ledger + a private account + a joint ledger + joint account
    const aliceInit = await processSyncRequest(db, 'alice', { mutations: [] });
    const aliceEpoch = aliceInit.dataEpoch!;
    const setupRes = await processSyncRequest(
      db,
      'alice',
      {
        clientEpoch: aliceEpoch,
        sinceSeq: aliceInit.syncCursor,
        refsOrdered: true,
        mutations: [
          {
            mutationId: 'a_m1',
            entity: 'ledger',
            op: 'upsert',
            recordId: 'led_home',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:01:00.000Z',
            payload: { name: '家用公費', includeInNetWorth: false, note: '房租與日用品', sortOrder: 2 },
          },
          {
            mutationId: 'a_m2',
            entity: 'asset',
            op: 'upsert',
            recordId: 'ast_joint',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:01:01.000Z',
            payload: {
              updateMode: '手動快照',
              majorType: '資產',
              subCategory: '活存',
              liquidity: '高流動',
              itemName: '共同公費活存',
              quantityOrAmount: 50000,
              currency: 'TWD',
              isLinkedSavings: true,
              isDefaultSavings: true,
              ledgerId: 'led_home',
            },
          },
          {
            mutationId: 'a_m3',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_alice_1',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:01:02.000Z',
            payload: {
              date: '2026-05-01',
              type: '日常花費',
              category: '餐飲',
              itemName: '全聯採買',
              amount: 1200,
              currency: 'TWD',
              linkedAccountId: 'ast_joint',
              ledgerId: 'led_home',
            },
          },
        ],
      },
      { queryBudget: 100 }
    );
    expect(setupRes.rejected).toEqual([]);
    expect(setupRes.ackedMutationIds).toHaveLength(3);

    // Alice invites Bob as editor
    const created = await createSharedLedgerInvite(db, 'alice', 'led_home', {
      role: 'editor',
      note: '給 Bob',
      expiresInDays: 7,
    });
    expect(created.code).toMatch(/^SHL-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);

    // Bob uses SyncEngine + LocalFinanceDB end-to-end
    const bobDb = new LocalFinanceDB(`shared-e2e-bob-${crypto.randomUUID()}`);
    await bobDb.open();
    let bobOnline = true;
    const bobEngine = new SyncEngine(bobDb, {
      fetchImpl: createApiFetchAdapter(db, 'bob'),
      isOnline: () => bobOnline,
      expectedUserId: 'bob',
    });
    await bobEngine.init();
    await bobEngine.syncNow(true);

    const joined = await bobEngine.joinSharedLedger(created.code);
    expect(joined.ledgerId).toBe('led_home');
    expect(joined.role).toBe('editor');

    // Bob sees led_home, ast_joint, and cf_alice_1 attributed to Alice, with includeInNetWorth = false by default
    const bobSnap1 = bobEngine.getSnapshot();
    const bobHomeLedger = bobSnap1.ledgers?.find((l) => l.id === 'led_home');
    expect(bobHomeLedger?.isShared).toBe(true);
    expect(bobHomeLedger?.myRole).toBe('editor');
    expect(bobHomeLedger?.includeInNetWorth).toBe(false);
    expect(bobSnap1.assetItems.some((a) => a.id === 'ast_joint')).toBe(true);
    const seenAliceCf = bobSnap1.cashflowLogs.find((c) => c.id === 'cf_alice_1');
    expect(seenAliceCf?.itemName).toBe('全聯採買');
    expect(seenAliceCf?.updatedByUserId).toBe('alice');
    expect(seenAliceCf?.updatedByName).toBe('Alice');

    const bobBackup = bobEngine.getBackupSnapshot();
    expect(bobBackup.ledgers?.map((ledger) => ledger.id)).toEqual([DEFAULT_LEDGER_ID]);
    expect(bobBackup.assetItems).toEqual([]);
    expect(bobBackup.cashflowLogs).toEqual([]);

    // Bob adds a shared expense via SyncEngine (automatically tagged with sharedLedgerId = 'led_home')
    const bobLog = await bobEngine.addCashFlow({
      date: '2026-05-02',
      type: '日常花費',
      category: '日用品',
      itemName: '衛生紙與清潔劑',
      amount: 680,
      currency: 'TWD',
      linkedAccountId: 'ast_joint',
      ledgerId: 'led_home',
    });
    const bobSyncRes = await bobEngine.syncNow();
    expect(bobSyncRes.ok).toBe(true);
    expect(bobEngine.getRejections()).toEqual([]);

    // Alice pulls incrementally and receives Bob's expense attributed to Bob!
    const alicePull = await processSyncRequest(db, 'alice', {
      sinceSeq: setupRes.syncCursor,
      clientEpoch: aliceEpoch,
      mutations: [],
    });
    const seenBobCf = alicePull.delta.cashflowLogs.find((c) => c.id === bobLog.id);
    expect(seenBobCf?.itemName).toBe('衛生紙與清潔劑');
    expect(seenBobCf?.updatedByUserId).toBe('bob');
    expect(seenBobCf?.updatedByName).toBe('Bob');
    expect(alicePull.sharedLedgers?.find((s) => s.ledgerId === 'led_home')?.memberCount).toBe(2);

    // Optimistic locking conflict between Alice & Bob on cf_alice_1
    const aliceEdit = await processSyncRequest(db, 'alice', {
      sinceSeq: alicePull.syncCursor,
      clientEpoch: aliceEpoch,
      refsOrdered: true,
      mutations: [
        {
          mutationId: 'a_edit_1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf_alice_1',
          baseVersion: 1,
          clientTimestamp: '2026-05-02T10:00:00.000Z',
          payload: {
            date: '2026-05-01',
            type: '日常花費',
            category: '餐飲',
            itemName: '全聯採買（含水果）',
            amount: 1450,
            currency: 'TWD',
            linkedAccountId: 'ast_joint',
            ledgerId: 'led_home',
          },
        },
      ],
    });
    expect(aliceEdit.ackedMutationIds).toEqual(['a_edit_1']);

    const bobStaleEdit = await processSyncRequest(db, 'bob', {
      sinceSeq: 0,
      sharedCursors: bobEngine.getMeta().sharedCursors,
      refsOrdered: true,
      mutations: [
        {
          mutationId: 'b_stale_1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf_alice_1',
          baseVersion: 1,
          sharedLedgerId: 'led_home',
          clientTimestamp: '2026-05-02T10:01:00.000Z',
          payload: {
            date: '2026-05-01',
            type: '日常花費',
            category: '餐飲',
            itemName: '全聯採買（Bob版）',
            amount: 1300,
            currency: 'TWD',
            linkedAccountId: 'ast_joint',
            ledgerId: 'led_home',
          },
        },
      ],
    });
    expect(bobStaleEdit.conflicts).toHaveLength(1);
    expect(bobStaleEdit.conflicts?.[0].serverVersion).toBe(2);

    // Per-member net worth preference: Bob enables includeInNetWorth without affecting Alice
    await bobEngine.updateSharedLedgerPreference('led_home', true);
    expect(bobEngine.getSnapshot().ledgers?.find((l) => l.id === 'led_home')?.includeInNetWorth).toBe(true);
    const aliceList = await listSharedLedgersForUser(db, 'alice');
    expect(aliceList.find((x) => x.ledgerId === 'led_home')?.includeInNetWorth).toBe(false);

    // Owner Alice cannot delete led_home while Bob is still an active member
    const delWhileShared = await processSyncRequest(db, 'alice', {
      sinceSeq: aliceEdit.syncCursor,
      clientEpoch: aliceEpoch,
      mutations: [
        {
          mutationId: 'a_del_shared',
          entity: 'ledger',
          op: 'delete',
          recordId: 'led_home',
          baseVersion: 1,
          clientTimestamp: '2026-05-02T11:00:00.000Z',
        },
      ],
    });
    expect(delWhileShared.rejected).toHaveLength(1);
    expect(delWhileShared.rejected[0].reason).toContain('仍有其他活躍成員');

    bobOnline = false;
    const pendingExpense = await bobEngine.addCashFlow({
      date: '2026-05-03',
      type: '日常花費',
      category: '日用品',
      itemName: '待同步支出',
      amount: 50,
      currency: 'TWD',
      linkedAccountId: 'ast_joint',
      ledgerId: 'led_home',
    });
    const backup = await exportFullSnapshot(db, 'alice');
    await importFullSnapshot(db, 'alice', backup, 'replace');
    bobOnline = true;
    await bobEngine.syncNow(true);
    expect(await bobDb.getOutbox()).toEqual([]);
    expect(await bobDb.getFrozenOutbox()).toEqual([
      expect.objectContaining({ recordId: pendingExpense.id }),
    ]);
    await bobEngine.syncNow();
    expect((await exportFullSnapshot(db, 'alice')).cashflowLogs.map((log) => log.id))
      .not.toContain(pendingExpense.id);

    // Alice removes Bob -> Bob's next sync purges led_home and its rows from IndexedDB!
    await removeOrLeaveSharedLedger(db, 'alice', 'led_home', 'bob');
    await bobEngine.syncNow();
    const bobAfterRevoke = bobEngine.getSnapshot();
    expect(bobAfterRevoke.ledgers?.some((l) => l.id === 'led_home')).toBe(false);
    expect(bobAfterRevoke.cashflowLogs.some((c) => c.ledgerId === 'led_home')).toBe(false);
    expect(bobAfterRevoke.assetItems.some((a) => a.ledgerId === 'led_home')).toBe(false);

    expect(await bobDb.getFrozenOutbox()).toEqual([]);

    await bobEngine.destroy();
    await bobDb.deleteDatabase();
  });

  it('enforces security invariants SL-1 through SL-8 (IDOR, viewer, private-asset ref, anti-smuggling, invite limits, backup isolation)', async () => {
    const db = createTestD1();
    await seedUser(db, 'alice', 'alice', 'Alice', 'member');
    await seedUser(db, 'bob', 'bob', 'Bob', 'member');
    await seedUser(db, 'charlie_admin', 'admin', 'SysAdmin', 'admin');

    // Seed Alice's private account/cashflow + shared ledger/account
    const initA = await processSyncRequest(db, 'alice', { mutations: [] });
    const seedA = await processSyncRequest(
      db,
      'alice',
      {
        clientEpoch: initA.dataEpoch,
        sinceSeq: initA.syncCursor,
        refsOrdered: true,
        mutations: [
          {
            mutationId: 'a_priv_acc',
            entity: 'asset',
            op: 'upsert',
            recordId: 'ast_alice_private',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:00:01.000Z',
            payload: {
              updateMode: '手動快照',
              majorType: '資產',
              subCategory: '活存',
              liquidity: '高流動',
              itemName: 'Alice 私人薪轉',
              quantityOrAmount: 300000,
              currency: 'TWD',
              isLinkedSavings: true,
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
          {
            mutationId: 'a_priv_cf',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_alice_private',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:00:02.000Z',
            payload: {
              date: '2026-05-01',
              type: '日常花費',
              category: '餐飲',
              itemName: '私人消費',
              amount: 500,
              currency: 'TWD',
              linkedAccountId: 'ast_alice_private',
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
          {
            mutationId: 'a_led',
            entity: 'ledger',
            op: 'upsert',
            recordId: 'led_trip',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:00:03.000Z',
            payload: { name: '日本旅遊公費', includeInNetWorth: false, note: '' },
          },
          {
            mutationId: 'a_sh_acc',
            entity: 'asset',
            op: 'upsert',
            recordId: 'ast_trip_pool',
            baseVersion: 0,
            clientTimestamp: '2026-05-01T00:00:04.000Z',
            payload: {
              updateMode: '手動快照',
              majorType: '資產',
              subCategory: '活存',
              liquidity: '高流動',
              itemName: '旅遊公費現金',
              quantityOrAmount: 20000,
              currency: 'TWD',
              isLinkedSavings: true,
              ledgerId: 'led_trip',
            },
          },
        ],
      },
      { queryBudget: 100 }
    );
    expect(seedA.rejected).toEqual([]);

    // SL-1: Cannot share 'default' ledger
    await expect(createSharedLedgerInvite(db, 'alice', DEFAULT_LEDGER_ID)).rejects.toThrow('預設個人主帳本不可開啟共用');

    // SL-6: Invite single-use & revocation
    const revokedInv = await createSharedLedgerInvite(db, 'alice', 'led_trip', { role: 'editor' });
    expect(await revokeSharedLedgerInvite(db, 'alice', 'led_trip', revokedInv.invite.id)).toBe(true);
    await expect(joinSharedLedgerByCode(db, 'bob', revokedInv.code)).rejects.toThrow('邀請碼無效');

    const validInv = await createSharedLedgerInvite(db, 'alice', 'led_trip', { role: 'editor' });
    await joinSharedLedgerByCode(db, 'bob', validInv.code);
    // Single-use: second user cannot redeem the same code
    await expect(joinSharedLedgerByCode(db, 'charlie_admin', validInv.code)).rejects.toThrow('邀請碼無效');

    // SL-1: System admin (not invited) CANNOT see or write to led_trip
    const adminSync = await processSyncRequest(db, 'charlie_admin', {
      mutations: [
        {
          mutationId: 'adm_hack',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf_hack',
          baseVersion: 0,
          sharedLedgerId: 'led_trip',
          clientTimestamp: '2026-05-02T00:00:00.000Z',
          payload: {
            date: '2026-05-02',
            type: '日常花費',
            category: '餐飲',
            itemName: '偷寫',
            amount: 100,
            currency: 'TWD',
            ledgerId: 'led_trip',
          },
        },
      ],
    });
    expect(adminSync.rejected).toHaveLength(1);
    expect(adminSync.rejected[0].reason).toContain('沒有此共同帳本的存取權限');
    expect(adminSync.delta.ledgers?.some((l) => l.id === 'led_trip')).toBe(false);

    // SL-1/SL-3/SL-4/SL-5 attacks by editor Bob
    const bobAttacks = await processSyncRequest(
      db,
      'bob',
      {
        refsOrdered: true,
        mutations: [
          // SL-4: Editor tries to link shared expense to Alice's PRIVATE checking account!
          {
            mutationId: 'atk_priv_acc',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_atk_1',
            baseVersion: 0,
            sharedLedgerId: 'led_trip',
            clientTimestamp: '2026-05-02T01:00:00.000Z',
            payload: {
              date: '2026-05-02',
              type: '日常花費',
              category: '餐飲',
              itemName: '探測私人活存',
              amount: 100,
              currency: 'TWD',
              linkedAccountId: 'ast_alice_private',
              ledgerId: 'led_trip',
            },
          },
          // SL-1: Editor tries to edit Alice's PRIVATE cashflow by guessing its recordId with sharedLedgerId
          {
            mutationId: 'atk_priv_cf_idor',
            entity: 'cashflow',
            op: 'delete',
            recordId: 'cf_alice_private',
            baseVersion: 1,
            sharedLedgerId: 'led_trip',
            clientTimestamp: '2026-05-02T01:00:01.000Z',
          },
          // SL-5: Editor tries to smuggle a shared expense into 'default' ledger
          {
            mutationId: 'atk_smuggle',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_atk_2',
            baseVersion: 0,
            sharedLedgerId: 'led_trip',
            clientTimestamp: '2026-05-02T01:00:02.000Z',
            payload: {
              date: '2026-05-02',
              type: '日常花費',
              category: '餐飲',
              itemName: '走私',
              amount: 100,
              currency: 'TWD',
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
          // SL-3: Editor tries to rename/edit the shared ledger metadata itself (owner-only!)
          {
            mutationId: 'atk_edit_ledger',
            entity: 'ledger',
            op: 'upsert',
            recordId: 'led_trip',
            baseVersion: 1,
            sharedLedgerId: 'led_trip',
            clientTimestamp: '2026-05-02T01:00:03.000Z',
            payload: { name: '篡改帳本名', includeInNetWorth: true, note: '' },
          },
          // SL-5: Mixed atomic group spanning personal + shared ledger
          {
            mutationId: 'atk_mix_1',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_mix_1',
            baseVersion: 0,
            atomicGroupId: 'grp_mixed',
            clientTimestamp: '2026-05-02T01:00:04.000Z',
            payload: {
              date: '2026-05-02',
              type: '日常花費',
              category: '餐飲',
              itemName: '個人',
              amount: 50,
              currency: 'TWD',
              ledgerId: DEFAULT_LEDGER_ID,
            },
          },
          {
            mutationId: 'atk_mix_2',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'cf_mix_2',
            baseVersion: 0,
            atomicGroupId: 'grp_mixed',
            sharedLedgerId: 'led_trip',
            clientTimestamp: '2026-05-02T01:00:04.000Z',
            payload: {
              date: '2026-05-02',
              type: '日常花費',
              category: '餐飲',
              itemName: '共用',
              amount: 50,
              currency: 'TWD',
              ledgerId: 'led_trip',
            },
          },
        ],
      },
      { queryBudget: 100 }
    );
    expect(bobAttacks.ackedMutationIds).toEqual([]);
    expect(bobAttacks.rejected).toHaveLength(6);
    expect(bobAttacks.rejected.find((r) => r.mutationId === 'atk_priv_acc')?.reason).toContain('不屬於此共同帳本');
    expect(bobAttacks.rejected.find((r) => r.mutationId === 'atk_priv_cf_idor')?.reason).toContain('目標紀錄不屬於此共同帳本');
    expect(bobAttacks.rejected.find((r) => r.mutationId === 'atk_smuggle')?.reason).toContain('不可變更所屬帳本');
    expect(bobAttacks.rejected.find((r) => r.mutationId === 'atk_edit_ledger')?.reason).toContain('僅共同帳本擁有者');
    expect(bobAttacks.rejected.find((r) => r.mutationId === 'atk_mix_1')?.reason).toContain('不可跨個人與共同帳本');

    // SL-3: Demote Bob to viewer -> ALL writes rejected
    await updateSharedLedgerMemberRole(db, 'alice', 'led_trip', 'bob', 'viewer');
    const viewerWrite = await processSyncRequest(db, 'bob', {
      refsOrdered: true,
      mutations: [
        {
          mutationId: 'vw_write_1',
          entity: 'cashflow',
          op: 'upsert',
          recordId: 'cf_vw_1',
          baseVersion: 0,
          sharedLedgerId: 'led_trip',
          clientTimestamp: '2026-05-02T02:00:00.000Z',
          payload: {
            date: '2026-05-02',
            type: '日常花費',
            category: '餐飲',
            itemName: '唯讀試寫',
            amount: 100,
            currency: 'TWD',
            linkedAccountId: 'ast_trip_pool',
            ledgerId: 'led_trip',
          },
        },
      ],
    });
    expect(viewerWrite.rejected).toHaveLength(1);
    expect(viewerWrite.rejected[0].reason).toContain('僅檢視');

    // SL-8: Non-owner exportFullSnapshot excludes Alice's led_trip
    const bobExport = await exportFullSnapshot(db, 'bob');
    expect(bobExport.ledgers?.some((l) => l.id === 'led_trip')).toBe(false);
    expect(bobExport.assetItems.some((a) => a.id === 'ast_trip_pool')).toBe(false);

    // SL-8: Owner Alice running 'replace' bumps Alice's epoch -> Bob gets epochMismatch ONLY on led_trip
    const bobBeforeReplace = await processSyncRequest(db, 'bob', { mutations: [] });
    const tripStateBefore = bobBeforeReplace.sharedLedgers?.find((s) => s.ledgerId === 'led_trip');
    expect(tripStateBefore?.dataEpoch).toBe(1);

    const aliceExport = await exportFullSnapshot(db, 'alice');
    await importFullSnapshot(db, 'alice', aliceExport, 'replace');

    const bobAfterReplace = await processSyncRequest(db, 'bob', {
      sinceSeq: bobBeforeReplace.syncCursor,
      clientEpoch: bobBeforeReplace.dataEpoch,
      sharedCursors: {
        led_trip: { sinceSeq: tripStateBefore!.changeSeq, clientEpoch: tripStateBefore!.dataEpoch },
      },
      mutations: [],
    });
    expect(bobAfterReplace.epochMismatch).toBeUndefined(); // Bob's personal epoch unaffected!
    const tripStateAfter = bobAfterReplace.sharedLedgers?.find((s) => s.ledgerId === 'led_trip');
    expect(tripStateAfter?.epochMismatch).toBe(true);
    expect(tripStateAfter?.fullResyncRequired).toBe(true);
    expect(tripStateAfter?.dataEpoch).toBe(2);

    // SL-6: Rate limit on /api/shared-ledgers/join after repeated bad codes
    const bobFetch = createApiFetchAdapter(db, 'bob');
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await bobFetch('/api/shared-ledgers/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-expected-user': 'bob' },
        body: JSON.stringify({ code: `SHL-BAD0-0000-000${i}` }),
      });
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);

    await importFullSnapshot(db, 'alice', {
      ...aliceExport,
      ledgers: aliceExport.ledgers?.filter((ledger) => ledger.id !== 'led_trip'),
      assetItems: aliceExport.assetItems.filter((asset) => asset.ledgerId !== 'led_trip'),
      cashflowLogs: aliceExport.cashflowLogs.filter((log) => log.ledgerId !== 'led_trip'),
    }, 'replace');
    const bobAfterRemoval = await processSyncRequest(db, 'bob', { mutations: [] });
    expect(bobAfterRemoval.revokedSharedLedgerIds).toContain('led_trip');
    expect(bobAfterRemoval.sharedLedgers?.map((ledger) => ledger.ledgerId) || []).not.toContain('led_trip');
  });

  it('degrades gracefully on pre-0025 DB (SL-9) and respects D1 Free Tier 50-query budget', async () => {
    // 1. Pre-0025 DB degradation
    const legacyDb = createTestD1({ stopBefore: '0025_shared_ledgers.sql' });
    await seedUser(legacyDb, 'u_legacy', 'u_legacy', 'Legacy', 'member');
    const legacySync = await processSyncRequest(legacyDb, 'u_legacy', { mutations: [] });
    expect(legacySync.ok).toBe(true);
    expect(legacySync.sharedLedgers).toBeUndefined();

    // Create a custom ledger then try sharing on pre-0025 DB -> clear 0025 migration error
    await processSyncRequest(legacyDb, 'u_legacy', {
      sinceSeq: legacySync.syncCursor,
      clientEpoch: legacySync.dataEpoch,
      mutations: [
        {
          mutationId: 'leg_l1',
          entity: 'ledger',
          op: 'upsert',
          recordId: 'led_pre25',
          baseVersion: 0,
          clientTimestamp: '2026-05-01T00:00:00.000Z',
          payload: { name: '舊庫帳本', includeInNetWorth: false, note: '' },
        },
      ],
    });
    await expect(createSharedLedgerInvite(legacyDb, 'u_legacy', 'led_pre25')).rejects.toThrow(
      SHARED_LEDGER_MIGRATION_ERROR
    );

    // 2. D1 query budget check: 0 shared ledgers vs 3 joined shared ledgers
    const db = createTestD1();
    await seedUser(db, 'solo', 'solo', 'Solo', 'member');
    await seedUser(db, 'owner1', 'owner1', 'Owner1', 'member');
    await seedUser(db, 'member3', 'member3', 'Member3', 'member');

    // Warm baseline for solo, then count empty incremental pull
    const soloWarm = await processSyncRequest(db, 'solo', { mutations: [] });
    const soloCounter = createCountingD1(db);
    await processSyncRequest(soloCounter.db, 'solo', {
      sinceSeq: soloWarm.syncCursor,
      clientEpoch: soloWarm.dataEpoch,
      mutations: [],
    });
    // Exact parity with v1.16.0: 1 ensureSyncBaseline + 1 readDeltaWithState = 2 D1 queries (+0 overhead!)
    expect(soloCounter.count()).toBe(2);

    // Owner1 creates 3 shared ledgers and Member3 joins all 3
    const o1 = await processSyncRequest(db, 'owner1', { mutations: [] });
    await processSyncRequest(
      db,
      'owner1',
      {
        sinceSeq: o1.syncCursor,
        clientEpoch: o1.dataEpoch,
        mutations: ['led_s1', 'led_s2', 'led_s3'].map((id, idx) => ({
          mutationId: `o1_m_${idx}`,
          entity: 'ledger' as const,
          op: 'upsert' as const,
          recordId: id,
          baseVersion: 0,
          clientTimestamp: '2026-05-01T00:00:00.000Z',
          payload: { name: `共同帳本 ${idx + 1}`, includeInNetWorth: false, note: '' },
        })),
      },
      { queryBudget: 100 }
    );
    for (const lid of ['led_s1', 'led_s2', 'led_s3']) {
      const inv = await createSharedLedgerInvite(db, 'owner1', lid, { role: 'editor' });
      await joinSharedLedgerByCode(db, 'member3', inv.code);
    }

    const m3Warm = await processSyncRequest(db, 'member3', { mutations: [] });
    expect(m3Warm.sharedLedgers).toHaveLength(3);
    const cursors = Object.fromEntries(
      (m3Warm.sharedLedgers || []).map((s) => [s.ledgerId, { sinceSeq: s.changeSeq, clientEpoch: s.dataEpoch }])
    );
    const m3Counter = createCountingD1(db);
    const m3Pull = await processSyncRequest(m3Counter.db, 'member3', {
      sinceSeq: m3Warm.syncCursor,
      clientEpoch: m3Warm.dataEpoch,
      sharedCursors: cursors,
      mutations: [],
    });
    expect(m3Pull.ok).toBe(true);
    // 1 baseline + 1 personal delta + 1 shared metadata batch + 1 consolidated shared data batch = 4 D1 queries (<= 50!)
    expect(m3Counter.count()).toBeLessThanOrEqual(5);
  });
});
