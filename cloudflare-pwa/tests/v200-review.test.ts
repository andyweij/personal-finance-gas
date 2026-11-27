/**
 * v2.0.0 (optional shared ledgers) review — repro tests.
 * `it.fails` marks a defect that still exists; flip it to `it` once fixed.
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

  it.fails(
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

  it.fails('an owner write without the sharedLedgerId hint must not link a shared record to a private account', async () => {
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
  it.fails('members are told the shared ledger is gone (memberships are not left active on a missing ledger)', async () => {
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
