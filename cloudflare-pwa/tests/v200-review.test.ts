/**
 * v2.0.0 (optional shared ledgers) review — regression tests.
 * See docs/reviews/2026-11-27_v2.0.0_review.md.
 */
import { describe, expect, it } from 'vitest';
import { createSharedLedgerInvite, joinSharedLedgerByCode } from '../worker/sharedLedgers';
import { exportFullSnapshot, importFullSnapshot, processSyncRequest } from '../worker/sync';
import { createTestD1 } from './helpers/mockD1';

async function seedUser(db: D1Database, id: string): Promise<void> {
  const now = '2026-01-01T00:00:00.000Z';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, password_salt, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'hash', 'salt', ?, ?)`
    )
    .bind(id, id, id, now, now)
    .run();
}

const assetMut = (id: string, ledgerId: string) => ({
  mutationId: `m_${id}`,
  entity: 'asset',
  op: 'upsert',
  recordId: id,
  baseVersion: 0,
  clientTimestamp: '2026-05-01T00:00:00.000Z',
  payload: {
    updateMode: '手動快照',
    majorType: '資產',
    subCategory: '活存',
    liquidity: '高流動',
    itemName: id,
    quantityOrAmount: 100,
    currency: 'TWD',
    isLinkedSavings: true,
    ledgerId,
  },
});

const cashflowMut = (
  mutationId: string,
  id: string,
  amount: number,
  linkedAccountId: string,
  extra: Record<string, unknown> = {}
) => ({
  mutationId,
  entity: 'cashflow',
  op: 'upsert',
  recordId: id,
  baseVersion: 0,
  clientTimestamp: '2026-05-01T00:00:01.000Z',
  ...extra,
  payload: {
    date: '2026-05-01',
    type: '日常花費',
    category: '餐飲',
    itemName: id,
    amount,
    currency: 'TWD',
    linkedAccountId,
    ledgerId: 'led_home',
  },
});

/** Alice owns led_home (shared ledger, ast_joint) and a private account ast_priv in her default ledger. */
async function setup(opts: { linkPrivateBeforeSharing?: boolean } = {}) {
  const db = createTestD1();
  await seedUser(db, 'alice');
  await seedUser(db, 'bob');
  const init = await processSyncRequest(db, 'alice', { mutations: [] });
  const epoch = init.dataEpoch!;
  const mutations: unknown[] = [
    {
      mutationId: 'm_led',
      entity: 'ledger',
      op: 'upsert',
      recordId: 'led_home',
      baseVersion: 0,
      clientTimestamp: '2026-05-01T00:00:00.000Z',
      payload: { name: '家用', includeInNetWorth: false, sortOrder: 2 },
    },
    assetMut('ast_joint', 'led_home'),
    assetMut('ast_priv', 'default'),
  ];
  // A household-ledger expense paid from a personal account, recorded BEFORE the ledger is shared
  if (opts.linkPrivateBeforeSharing) mutations.push(cashflowMut('m_cf_pre', 'cf_pre', 10, 'ast_priv'));
  const res = await processSyncRequest(
    db,
    'alice',
    { clientEpoch: epoch, refsOrdered: true, mutations: mutations as never },
    { queryBudget: 100 }
  );
  expect(res.rejected).toEqual([]);
  const invite = await createSharedLedgerInvite(db, 'alice', 'led_home', { role: 'editor', expiresInDays: 7 });
  await joinSharedLedgerByCode(db, 'bob', invite.code);
  return { db, epoch };
}

describe('v2.0.0 review — finding 1: SL-4 only checks references changed by the write', () => {
  it('control: an editor cannot link a shared cashflow to the owner’s private account', async () => {
    const { db } = await setup();
    const res = await processSyncRequest(db, 'bob', {
      refsOrdered: true,
      mutations: [cashflowMut('b1', 'cf_bob', 10, 'ast_priv', { sharedLedgerId: 'led_home' })] as never,
    });
    expect(res.ackedMutationIds).toEqual([]);
    expect(res.rejected[0]?.reason).toMatch(/不屬於此共同帳本/);
  });

  it(
    'an editor must not change a shared record that is linked to the owner’s private account (pre-sharing link)',
    async () => {
      const { db } = await setup({ linkPrivateBeforeSharing: true });
      // Bob sees the record (incl. linkedAccountId = ast_priv) and edits only its amount: the unchanged
      // asset reference is not re-checked, so the write is accepted and moves Alice's PRIVATE balance.
      const res = await processSyncRequest(db, 'bob', {
        refsOrdered: true,
        mutations: [
          cashflowMut('b_edit', 'cf_pre', 99999, 'ast_priv', { sharedLedgerId: 'led_home', baseVersion: 1 }),
        ] as never,
      });
      const row = await db.prepare("SELECT amount FROM cashflow_logs WHERE id = 'cf_pre'").first<{ amount: number }>();
      expect(row?.amount).toBe(10);
      expect(res.ackedMutationIds).toEqual([]);
    }
  );

  it('an owner write without the sharedLedgerId hint must not link a shared record to a private account', async () => {
    const { db, epoch } = await setup();
    // e.g. an older client / a device that has not learned yet that led_home is shared
    const res = await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [cashflowMut('a_nohint', 'cf_nohint', 10, 'ast_priv')] as never,
    });
    expect(res.ackedMutationIds).toEqual([]);
  });
});

describe('v2.0.0 review — finding 2: owner replace import of a backup without the shared ledger', () => {
  it('members are told the shared ledger is gone (memberships are not left active on a missing ledger)', async () => {
    const { db } = await setup();
    const backup = await exportFullSnapshot(db, 'alice');
    const preSharing = {
      ...backup,
      ledgers: (backup.ledgers || []).filter((l) => l.id !== 'led_home'),
      assetItems: backup.assetItems.filter((a) => a.id !== 'ast_joint'),
    };
    await importFullSnapshot(db, 'alice', preSharing, 'replace');

    // The ledger and every record in it (including Bob's) are hard-deleted, but both memberships stay active
    const ledger = await db.prepare("SELECT id FROM ledgers WHERE user_id = 'alice' AND id = 'led_home'").first();
    expect(ledger).toBeNull();
    const bob = await processSyncRequest(db, 'bob', {
      sharedCursors: { led_home: { sinceSeq: 0, clientEpoch: 1 } } as never,
      mutations: [],
    });
    // Bob gets neither sharedLedgers nor revokedSharedLedgerIds, so his client keeps the stale cached ledger
    expect(bob.revokedSharedLedgerIds ?? []).toContain('led_home');
  });
});

const deleteMut = (mutationId: string, entity: string, recordId: string, baseVersion: number) => ({
  mutationId,
  entity,
  op: 'delete',
  recordId,
  baseVersion,
  sharedLedgerId: 'led_home',
  clientTimestamp: '2026-05-02T00:00:00.000Z',
});

describe('aa75631 re-review — R1 (fixed): the SL-4 guard on existing references must not block legitimate edits/deletes', () => {
  it('a shared record linked to a since-deleted shared account can still be deleted', async () => {
    const { db, epoch } = await setup();
    const created = await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [cashflowMut('a_cf', 'cf_joint', 20, 'ast_joint', { sharedLedgerId: 'led_home' })] as never,
    });
    expect(created.rejected).toEqual([]);
    // Deleting the account is allowed while records still point at it ...
    const delAcct = await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [deleteMut('a_del_acct', 'asset', 'ast_joint', 1)] as never,
    });
    expect(delAcct.rejected).toEqual([]);
    // ... but afterwards nobody (editor or owner) can delete the record any more: the delete re-checks the
    // existing linked_account_id with `deleted_at IS NULL`.
    const bobDel = await processSyncRequest(db, 'bob', {
      refsOrdered: true,
      mutations: [deleteMut('b_del', 'cashflow', 'cf_joint', 1)] as never,
    });
    expect(bobDel.rejected).toEqual([]);
    expect(bobDel.ackedMutationIds).toEqual(['b_del']);
  });

  it('the owner can delete their own pre-sharing record that is linked to a personal account', async () => {
    const { db, epoch } = await setup({ linkPrivateBeforeSharing: true });
    const res = await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [deleteMut('a_del_pre', 'cashflow', 'cf_pre', 1)] as never,
    });
    expect(res.rejected).toEqual([]);
  });

  it('an editor can still edit a record linked to a since-deleted shared account (keeping the link)', async () => {
    const { db, epoch } = await setup();
    await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [cashflowMut('a_cf', 'cf_joint', 20, 'ast_joint', { sharedLedgerId: 'led_home' })] as never,
    });
    await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [deleteMut('a_del_acct', 'asset', 'ast_joint', 1)] as never,
    });
    const res = await processSyncRequest(db, 'bob', {
      refsOrdered: true,
      mutations: [
        cashflowMut('b_edit', 'cf_joint', 25, 'ast_joint', { sharedLedgerId: 'led_home', baseVersion: 1 }),
      ] as never,
    });
    expect(res.rejected).toEqual([]);
    expect(res.ackedMutationIds).toEqual(['b_edit']);
  });

  it('the owner can edit their own pre-sharing cross-ledger record keeping its link, but not add a new one', async () => {
    const { db, epoch } = await setup({ linkPrivateBeforeSharing: true });
    const keep = await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [cashflowMut('a_keep', 'cf_pre', 12, 'ast_priv', { baseVersion: 1 })] as never,
    });
    expect(keep.rejected).toEqual([]);
    const relink = await processSyncRequest(db, 'alice', {
      clientEpoch: epoch,
      refsOrdered: true,
      mutations: [cashflowMut('a_new', 'cf_new', 5, 'ast_priv')] as never,
    });
    expect(relink.ackedMutationIds).toEqual([]);
  });

  it('control: an editor cannot unlink or re-link a record from the owner’s personal account', async () => {
    const { db } = await setup({ linkPrivateBeforeSharing: true });
    for (const target of [null, 'ast_joint']) {
      const res = await processSyncRequest(db, 'bob', {
        refsOrdered: true,
        mutations: [
          cashflowMut(`b_relink_${target}`, 'cf_pre', 10, target as string, { sharedLedgerId: 'led_home', baseVersion: 1 }),
        ] as never,
      });
      expect(res.ackedMutationIds).toEqual([]);
      expect(res.rejected[0]?.reason).toMatch(/僅帳本擁有者/);
    }
    const row = await db.prepare("SELECT linked_account_id FROM cashflow_logs WHERE id = 'cf_pre'").first<{ linked_account_id: string }>();
    expect(row?.linked_account_id).toBe('ast_priv');
  });

  it('control: an editor still cannot delete a shared record linked to the owner’s personal account', async () => {
    const { db } = await setup({ linkPrivateBeforeSharing: true });
    const res = await processSyncRequest(db, 'bob', {
      refsOrdered: true,
      mutations: [deleteMut('b_del_pre', 'cashflow', 'cf_pre', 1)] as never,
    });
    expect(res.ackedMutationIds).toEqual([]);
  });
});
