import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/index';
import type { WorkerEnv } from '../worker/types';
import {
  runMonthEndSnapshotAllUsersD1,
  runMonthlyRecurringAllUsersD1,
} from '../worker/automation';
import { refreshMarketData } from '../worker/market';
import { LocalFinanceDB } from '../web/src/db/localDb';
import { SyncEngine } from '../web/src/sync/syncEngine';
import { CASHFLOW_TYPES } from '../shared/constants';
import { createTestD1 } from './helpers/mockD1';

const currentDir = dirname(fileURLToPath(import.meta.url));

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0] || '';
}

function makeReq(
  app: ReturnType<typeof createApp>,
  env: WorkerEnv,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown; ip?: string } = {}
) {
  const headers: Record<string, string> = {
    'cf-connecting-ip': options.ip || '10.0.0.1',
  };
  if (options.cookie) headers['cookie'] = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(
    path,
    {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    },
    env
  );
}

describe('Multi-Tenant Family Isolation, Invites & Zero-Knowledge Reset', () => {
  let app: ReturnType<typeof createApp>;
  let env: WorkerEnv;

  beforeEach(() => {
    app = createApp();
    env = {
      DB: createTestD1(),
      SETUP_SECRET: 'test-setup-secret-123',
    };
  });

  async function setupAdminAndInviteMember() {
    const setupRes = await makeReq(app, env, '/api/auth/setup', {
      method: 'POST',
      body: {
        setupSecret: 'test-setup-secret-123',
        username: 'admin',
        displayName: 'Andy',
        password: 'AdminPassword123!',
      },
    });
    expect(setupRes.status).toBe(200);
    const adminCookie = extractCookie(setupRes);

    const inviteRes = await makeReq(app, env, '/api/admin/invites', {
      method: 'POST',
      cookie: adminCookie,
      body: { note: '給媽媽', expiresInDays: 7 },
    });
    expect(inviteRes.status).toBe(200);
    const inviteBody = (await inviteRes.json()) as { inviteCode: string; id: string };
    expect(inviteBody.inviteCode).toBeTruthy();

    const regRes = await makeReq(app, env, '/api/auth/register-invite', {
      method: 'POST',
      ip: '10.0.0.2',
      body: {
        inviteCode: inviteBody.inviteCode,
        username: 'mom',
        displayName: '媽媽',
        password: 'MomPassword123!',
      },
    });
    expect(regRes.status).toBe(200);
    const momCookie = extractCookie(regRes);
    const regBody = (await regRes.json()) as { user: { id: string; username: string; role: string; showUtilityTab: boolean } };

    return { adminCookie, momCookie, inviteCode: inviteBody.inviteCode, momUser: regBody.user };
  }

  it('migrates legacy single-owner DB (0001..0006 -> 0007) without losing credentials or financial data', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const migrationsDir = resolve(currentDir, '../migrations');
    const allFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const preFiles = allFiles.filter((f) => f < '0007_multi_tenant.sql');
    for (const f of preFiles) {
      sqlite.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
    }

    // Seed pre-0007 single-owner credential & records
    sqlite.exec(`
      INSERT INTO auth_owner (id, password_hash, password_salt, pin_enabled, pin_hash, pin_salt, updated_at)
      VALUES (1, 'legacy-hash', 'legacy-salt', 1, 'pin-hash', 'pin-salt', '2026-11-20T00:00:00.000Z');
      INSERT INTO asset_items (id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, note, created_at, updated_at)
      VALUES ('a-legacy', '手動快照', '資產', '銀行活存', '高流動', '中信活存', '', 123456, 'TWD', 1, '舊資料', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
      INSERT INTO auth_passkeys (credential_id, public_key, counter, transports, device_name, created_at)
      VALUES ('cred-legacy', 'pk-legacy', 2, '["internal"]', 'iPhone', '2026-11-20T00:00:00.000Z');
    `);

    // Apply 0007 migration
    sqlite.exec(readFileSync(resolve(migrationsDir, '0007_multi_tenant.sql'), 'utf8'));

    const ownerRow = sqlite.prepare("SELECT * FROM users WHERE id = 'owner'").get() as Record<string, unknown>;
    expect(ownerRow).toBeTruthy();
    expect(ownerRow.username).toBe('admin');
    expect(ownerRow.role).toBe('admin');
    expect(ownerRow.password_hash).toBe('legacy-hash');
    expect(ownerRow.pin_enabled).toBe(1);
    expect(ownerRow.show_utility_tab).toBe(1);

    const assetRow = sqlite.prepare("SELECT * FROM asset_items WHERE id = 'a-legacy'").get() as Record<string, unknown>;
    expect(assetRow.user_id).toBe('owner');
    expect(assetRow.quantity_or_amount).toBe(123456);

    const pkRow = sqlite.prepare("SELECT * FROM auth_passkeys WHERE credential_id = 'cred-legacy'").get() as Record<string, unknown>;
    expect(pkRow.user_id).toBe('owner');

    const utilityRows = sqlite.prepare("SELECT DISTINCT user_id FROM rent_utility_records").all() as Array<{ user_id: string }>;
    expect(utilityRows).toEqual([{ user_id: 'owner' }]);
  });

  it('enforces one-time invite registration, hides utility tab for new members, and leaks no unauthenticated tenant info', async () => {
    const { adminCookie, momCookie, inviteCode, momUser } = await setupAdminAndInviteMember();

    // Unauthenticated status must not expose passkeyCount, pinHash, or user info
    const pubStatus = await makeReq(app, env, '/api/auth/status');
    const pubJson = (await pubStatus.json()) as Record<string, unknown>;
    expect(pubJson.initialized).toBe(true);
    expect(pubJson.authenticated).toBe(false);
    expect(pubJson.user).toBeUndefined();
    expect(pubJson.passkeys).toBeUndefined();
    expect(pubJson.pinHash).toBeUndefined();

    // Invite code cannot be reused after registration
    const reuseRes = await makeReq(app, env, '/api/auth/register-invite', {
      method: 'POST',
      ip: '10.0.0.3',
      body: {
        inviteCode,
        username: 'dad',
        displayName: '爸爸',
        password: 'DadPassword123!',
      },
    });
    expect(reuseRes.status).toBe(400);

    // Revoked invite code cannot be used
    const inv2 = await makeReq(app, env, '/api/admin/invites', {
      method: 'POST',
      cookie: adminCookie,
      body: { note: '撤銷測試' },
    });
    const inv2Body = (await inv2.json()) as { id: string; inviteCode: string };
    const delRes = await makeReq(app, env, `/api/admin/invites/${inv2Body.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(delRes.status).toBe(200);
    const useRevokedRes = await makeReq(app, env, '/api/auth/register-invite', {
      method: 'POST',
      ip: '10.0.0.4',
      body: {
        inviteCode: inv2Body.inviteCode,
        username: 'sis',
        displayName: '妹妹',
        password: 'SisPassword123!',
      },
    });
    expect(useRevokedRes.status).toBe(400);

    // New member defaults: role=member, showUtilityTab=false, empty ledger & empty utility records
    expect(momUser.role).toBe('member');
    expect(momUser.showUtilityTab).toBe(false);

    const momSync = await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: momCookie,
      body: { mutations: [] },
    });
    const momSyncBody = (await momSync.json()) as {
      delta: { assetItems: unknown[]; cashflowLogs: unknown[]; rentUtilityRecords: unknown[] };
    };
    expect(momSyncBody.delta.assetItems).toHaveLength(0);
    expect(momSyncBody.delta.cashflowLogs).toHaveLength(0);
    expect(momSyncBody.delta.rentUtilityRecords).toHaveLength(0);

    // Member can toggle showUtilityTab on via profile API
    const toggleRes = await makeReq(app, env, '/api/auth/profile', {
      method: 'PATCH',
      cookie: momCookie,
      body: { showUtilityTab: true },
    });
    expect(toggleRes.status).toBe(200);
    const momStatus = await makeReq(app, env, '/api/auth/status', { cookie: momCookie });
    const momStatusBody = (await momStatus.json()) as { user: { showUtilityTab: boolean } };
    expect(momStatusBody.user.showUtilityTab).toBe(true);
  });

  it('supports zero-knowledge admin-assisted password reset, revokes old sessions, and blocks non-admin access', async () => {
    const { adminCookie, momCookie, momUser } = await setupAdminAndInviteMember();

    // Non-admin must get 403 on all admin routes
    const forbidUsers = await makeReq(app, env, '/api/admin/users', { cookie: momCookie });
    expect(forbidUsers.status).toBe(403);
    const forbidInvite = await makeReq(app, env, '/api/admin/invites', {
      method: 'POST',
      cookie: momCookie,
      body: { note: '越權' },
    });
    expect(forbidInvite.status).toBe(403);

    // Admin generates one-time reset code for mom
    const resetGen = await makeReq(app, env, `/api/admin/users/${momUser.id}/reset-code`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(resetGen.status).toBe(200);
    const { resetCode } = (await resetGen.json()) as { resetCode: string };
    expect(resetCode).toBeTruthy();

    // Mom resets password herself without admin knowing the new password
    const resetDo = await makeReq(app, env, '/api/auth/reset-password', {
      method: 'POST',
      ip: '10.0.0.5',
      body: {
        username: 'mom',
        resetCode,
        newPassword: 'BrandNewMomPassword999!',
      },
    });
    expect(resetDo.status).toBe(200);

    // Old session cookie MUST be revoked immediately
    const oldSessionSync = await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: momCookie,
      body: { mutations: [] },
    });
    expect(oldSessionSync.status).toBe(401);

    // Old password fails; new password succeeds
    const oldPwdLogin = await makeReq(app, env, '/api/auth/login', {
      method: 'POST',
      ip: '10.0.0.6',
      body: { username: 'mom', password: 'MomPassword123!' },
    });
    expect(oldPwdLogin.status).toBe(401);

    const newPwdLogin = await makeReq(app, env, '/api/auth/login', {
      method: 'POST',
      ip: '10.0.0.6',
      body: { username: 'mom', password: 'BrandNewMomPassword999!' },
    });
    expect(newPwdLogin.status).toBe(200);

    // Reset code cannot be reused
    const reuseReset = await makeReq(app, env, '/api/auth/reset-password', {
      method: 'POST',
      ip: '10.0.0.6',
      body: {
        username: 'mom',
        resetCode,
        newPassword: 'AnotherPassword888!',
      },
    });
    expect(reuseReset.status).toBe(400);
  });

  it('strictly isolates financial records, exports, deletes, market refresh, and admin views across tenants (even with colliding IDs)', async () => {
    const { adminCookie, momCookie, momUser } = await setupAdminAndInviteMember();

    // Both admin and mom write records using IDENTICAL recordId, mutationId, and period!
    const adminWrite = await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        mutations: [
          {
            mutationId: 'same-mut-1',
            entity: 'asset',
            op: 'upsert',
            recordId: 'same-asset-id',
            baseVersion: null,
            clientTimestamp: '2026-11-24T01:00:00.000Z',
            payload: {
              updateMode: '自動更新',
              majorType: '資產',
              subCategory: '台股',
              liquidity: '中流動',
              itemName: 'Admin 秘密台積電',
              ticker: '2330',
              quantityOrAmount: 1000,
              currency: 'TWD',
              unitPrice: 900,
            },
          },
          {
            mutationId: 'same-mut-2',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'same-cf-id',
            baseVersion: null,
            clientTimestamp: '2026-11-24T01:00:00.000Z',
            payload: {
              date: '2026-11-24',
              type: CASHFLOW_TYPES.DAILY_EXPENSE,
              category: '餐飲',
              itemName: 'Admin 午餐',
              amount: 350,
              currency: 'TWD',
            },
          },
        ],
      },
    });
    expect(adminWrite.status).toBe(200);

    const momWrite = await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: momCookie,
      body: {
        mutations: [
          {
            mutationId: 'same-mut-1',
            entity: 'asset',
            op: 'upsert',
            recordId: 'same-asset-id',
            baseVersion: null,
            clientTimestamp: '2026-11-24T02:00:00.000Z',
            payload: {
              updateMode: '自動更新',
              majorType: '資產',
              subCategory: '台股',
              liquidity: '中流動',
              itemName: 'Mom 0050',
              ticker: '0050',
              quantityOrAmount: 500,
              currency: 'TWD',
              unitPrice: 180,
            },
          },
          {
            mutationId: 'same-mut-2',
            entity: 'cashflow',
            op: 'upsert',
            recordId: 'same-cf-id',
            baseVersion: null,
            clientTimestamp: '2026-11-24T02:00:00.000Z',
            payload: {
              date: '2026-11-24',
              type: CASHFLOW_TYPES.DAILY_EXPENSE,
              category: '買菜',
              itemName: 'Mom 買菜',
              amount: 880,
              currency: 'TWD',
            },
          },
        ],
      },
    });
    expect(momWrite.status).toBe(200);
    const momWriteBody = (await momWrite.json()) as { ackedMutationIds: string[]; conflicts?: unknown[] };
    expect(momWriteBody.ackedMutationIds).toEqual(['same-mut-1', 'same-mut-2']);
    expect(momWriteBody.conflicts || []).toHaveLength(0);

    // Export check: Admin only sees Admin data; Mom only sees Mom data
    const adminExport = (
      (await (await makeReq(app, env, '/api/export/json', { cookie: adminCookie })).json()) as {
        data: { assetItems: Array<{ itemName: string }>; cashflowLogs: Array<{ itemName: string }> };
      }
    ).data;
    expect(adminExport.assetItems.map((a) => a.itemName)).toEqual(['Admin 秘密台積電']);
    expect(adminExport.cashflowLogs.map((c) => c.itemName)).toEqual(['Admin 午餐']);

    const momExport = (
      (await (await makeReq(app, env, '/api/export/json', { cookie: momCookie })).json()) as {
        data: { assetItems: Array<{ itemName: string }>; cashflowLogs: Array<{ itemName: string }> };
      }
    ).data;
    expect(momExport.assetItems.map((a) => a.itemName)).toEqual(['Mom 0050']);
    expect(momExport.cashflowLogs.map((c) => c.itemName)).toEqual(['Mom 買菜']);

    // Mom deletes 'same-asset-id' -> Admin's 'same-asset-id' MUST remain intact!
    await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: momCookie,
      body: {
        mutations: [
          {
            mutationId: 'mom-del-1',
            entity: 'asset',
            op: 'delete',
            recordId: 'same-asset-id',
            baseVersion: 1,
            clientTimestamp: '2026-11-24T03:00:00.000Z',
          },
        ],
      },
    });
    const adminExportAfter = (
      (await (await makeReq(app, env, '/api/export/json', { cookie: adminCookie })).json()) as {
        data: { assetItems: Array<{ itemName: string }> };
      }
    ).data;
    expect(adminExportAfter.assetItems.map((a) => a.itemName)).toEqual(['Admin 秘密台積電']);

    // Scoped market refresh for mom must NOT fetch or modify admin's 2330
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('open.er-api.com')) {
        return new Response(JSON.stringify({ rates: { TWD: 31.8 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ msgArray: [{ z: '1050' }] }), { status: 200 });
    });
    const momMarket = await refreshMarketData(env.DB, mockFetch, momUser.id);
    expect(momMarket.updatedTickers).toHaveLength(0);
    const adminAssetAfterMarket = (
      (await (await makeReq(app, env, '/api/export/json', { cookie: adminCookie })).json()) as {
        data: { assetItems: Array<{ unitPrice: number }> };
      }
    ).data;
    expect(adminAssetAfterMarket.assetItems[0].unitPrice).toBe(900);

    // Deactivating mom immediately invalidates her session and blocks login
    const deactivateRes = await makeReq(app, env, `/api/admin/users/${momUser.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { isActive: false },
    });
    expect(deactivateRes.status).toBe(200);
    const blockedSync = await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: momCookie,
      body: { mutations: [] },
    });
    expect(blockedSync.status).toBe(401);
  });

  it('runs monthly recurring and month-end snapshot Cron independently per active user without dedup collisions', async () => {
    const { adminCookie, momCookie } = await setupAdminAndInviteMember();

    // Both users configure a recurring item named '薪資' with different amounts
    await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        mutations: [
          {
            mutationId: 'rec-a-1',
            entity: 'recurring',
            op: 'upsert',
            recordId: 'rec-salary',
            baseVersion: null,
            clientTimestamp: '2026-11-01T00:00:00.000Z',
            payload: {
              itemName: '薪資',
              category: '薪資收入',
              type: CASHFLOW_TYPES.FIXED_INCOME,
              amount: 100000,
              currency: 'TWD',
              cycle: '月繳',
              status: '啟用',
            },
          },
        ],
      },
    });
    await makeReq(app, env, '/api/sync', {
      method: 'POST',
      cookie: momCookie,
      body: {
        mutations: [
          {
            mutationId: 'rec-m-1',
            entity: 'recurring',
            op: 'upsert',
            recordId: 'rec-salary',
            baseVersion: null,
            clientTimestamp: '2026-11-01T00:00:00.000Z',
            payload: {
              itemName: '薪資',
              category: '薪資收入',
              type: CASHFLOW_TYPES.FIXED_INCOME,
              amount: 55000,
              currency: 'TWD',
              cycle: '月繳',
              status: '啟用',
            },
          },
        ],
      },
    });

    const cronRec = await runMonthlyRecurringAllUsersD1(env.DB, 2026, 11);
    expect(cronRec.userCount).toBe(2);
    expect(cronRec.totalInserted).toBe(2);

    const cronSnap = await runMonthEndSnapshotAllUsersD1(env.DB, new Date('2026-11-30T15:00:00.000Z'));
    expect(cronSnap.userCount).toBe(2);

    const adminExp = (
      (await (await makeReq(app, env, '/api/export/json', { cookie: adminCookie })).json()) as {
        data: { cashflowLogs: Array<{ twdAmount: number }>; netWorthHistory: Array<{ monthlyIncome: number }> };
      }
    ).data;
    const momExp = (
      (await (await makeReq(app, env, '/api/export/json', { cookie: momCookie })).json()) as {
        data: { cashflowLogs: Array<{ twdAmount: number }>; netWorthHistory: Array<{ monthlyIncome: number }> };
      }
    ).data;
    expect(adminExp.cashflowLogs.map((l) => l.twdAmount)).toEqual([100000]);
    expect(momExp.cashflowLogs.map((l) => l.twdAmount)).toEqual([55000]);
    expect(adminExp.netWorthHistory[0].monthlyIncome).toBe(100000);
    expect(momExp.netWorthHistory[0].monthlyIncome).toBe(55000);
  });

  it('isolates frontend LocalFinanceDB IndexedDB databases per userId on shared devices', async () => {
    const dbA = new LocalFinanceDB('user-a-test');
    const dbB = new LocalFinanceDB('user-b-test');
    await dbA.open();
    await dbB.open();
    await dbA.clearAll();
    await dbB.clearAll();

    const engineA = new SyncEngine(dbA, { fetchImpl: vi.fn(), isOnline: () => false });
    const engineB = new SyncEngine(dbB, { fetchImpl: vi.fn(), isOnline: () => false });
    await engineA.init();
    await engineB.init();

    await engineA.addCashFlow({
      date: '2026-11-24',
      type: CASHFLOW_TYPES.DAILY_EXPENSE,
      category: '餐飲',
      itemName: 'User A 專屬紀錄',
      amount: 150,
      currency: 'TWD',
    });

    expect(engineA.getSnapshot().cashflowLogs).toHaveLength(1);
    expect(engineB.getSnapshot().cashflowLogs).toHaveLength(0);
    expect(await dbA.getOutbox()).toHaveLength(1);
    expect(await dbB.getOutbox()).toHaveLength(0);

    dbA.close();
    dbB.close();
  });
});
