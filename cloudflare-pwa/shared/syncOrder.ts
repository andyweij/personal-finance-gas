import type { SyncMutation } from './types';

/**
 * v1.8.12 (review R-A): references a mutation's payload makes to other synced records. With the M3 reference
 * guards the server rejects a write whose ledger / account does not exist yet, so a record must be created
 * before anything that points at it is sent.
 */
export function mutationReferenceKeys(m: unknown): string[] {
  if (!m || typeof m !== 'object') return [];
  const mut = m as Partial<SyncMutation>;
  if (mut.op !== 'upsert' || !mut.payload || typeof mut.payload !== 'object') return [];
  const p = mut.payload as Record<string, unknown>;
  const keys: string[] = [];
  const ledgerId = typeof p.ledgerId === 'string' ? p.ledgerId.trim() : '';
  if (ledgerId && ledgerId !== 'default' && mut.entity !== 'ledger') keys.push(`ledger:${ledgerId}`);
  const linkedLedgerId = typeof p.linkedLedgerId === 'string' ? p.linkedLedgerId.trim() : '';
  if (linkedLedgerId && linkedLedgerId !== 'default' && mut.entity !== 'ledger') {
    keys.push(`ledger:${linkedLedgerId}`);
  }
  for (const field of ['linkedAccountId', 'accountId', 'assetId', 'sourceAccountId', 'cardAccountId']) {
    const v = typeof p[field] === 'string' ? (p[field] as string).trim() : '';
    if (v && !(mut.entity === 'asset' && v === mut.recordId)) keys.push(`asset:${v}`);
  }
  if (Array.isArray(p.linkedAssetIds)) {
    for (const rawId of p.linkedAssetIds) {
      const v = typeof rawId === 'string' ? rawId.trim() : '';
      if (v && !(mut.entity === 'asset' && v === mut.recordId)) keys.push(`asset:${v}`);
    }
  }
  return keys;
}

function keyOf(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null;
  const mut = m as Partial<SyncMutation>;
  return typeof mut.entity === 'string' && typeof mut.recordId === 'string' ? `${mut.entity}:${mut.recordId}` : null;
}

/**
 * The atomic unit a mutation belongs to (null = applied on its own). An explicit `atomicGroupId` (v1.8.12+ clients)
 * wins; legacy clients still get atomicity for the two savings legs of a transfer: savings_adjustment upserts that
 * share `payload.transferGroupId` form an implicit group. The server applies every member of a group together.
 */
export function atomicGroupKeyOf(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null;
  const mut = m as Partial<SyncMutation>;
  if (typeof mut.atomicGroupId === 'string' && mut.atomicGroupId.trim()) return `g:${mut.atomicGroupId}`;
  const p = mut.payload as Record<string, unknown> | undefined;
  if (
    mut.entity === 'savings_adjustment' &&
    mut.op === 'upsert' &&
    p &&
    typeof p === 'object' &&
    typeof p.transferGroupId === 'string' &&
    p.transferGroupId
  ) {
    return `legacy-transfer:${p.transferGroupId}`;
  }
  return null;
}

/**
 * Stable dependency order: the first pending upsert of a record that another mutation references is moved in front
 * of the referencing mutation (together with the earlier mutations of that same record, so a record's own mutations
 * never change order; its later edits keep their position). Everything else keeps its position. Cycles are broken by
 * keeping the original order.
 *
 * Post-deploy review fix (v1.8.17): an atomic group (see atomicGroupKeyOf) is one node — the dependencies of ALL
 * its members are placed first and the members are then emitted together. The server applies a whole group at
 * the position of its first member, so a record referenced only by a later member (e.g. a new account that is the
 * target of a transfer, queued after both legs) must come before the group, not between its members.
 *
 * Works on untrusted input (the server runs it on request bodies): non-object entries are passed through.
 */
export function orderMutationsByDependencies<T>(list: T[]): T[] {
  const byKey = new Map<string, number[]>();
  const groupOf = new Map<number, string>();
  const groupMembers = new Map<string, number[]>();
  list.forEach((m, i) => {
    const k = keyOf(m);
    if (k) {
      const arr = byKey.get(k) || [];
      arr.push(i);
      byKey.set(k, arr);
    }
    const g = atomicGroupKeyOf(m);
    if (g) {
      groupOf.set(i, g);
      const members = groupMembers.get(g) || [];
      members.push(i);
      groupMembers.set(g, members);
    }
  });
  const out: T[] = [];
  const done = new Set<number>();
  const visiting = new Set<number>();
  const visitDeps = (i: number) => {
    const m = list[i];
    const k = keyOf(m);
    // earlier mutations of the same record first
    if (k) for (const j of byKey.get(k) || []) if (j < i) visit(j);
    for (const ref of mutationReferenceKeys(m)) {
      // v1.8.17 review finding 1: only the referenced record's FIRST pending upsert has to come first (it creates or
      // restores the record; its earlier mutations follow it via the rule above). Pulling its later edits as well
      // could put such an edit before the record's own create when that create is a member of the group currently
      // being visited (still in `visiting`, so the "earlier mutations first" rule skipped it).
      for (const j of byKey.get(ref) || []) {
        if (j === i) continue;
        const dep = list[j] as Partial<SyncMutation>;
        if (dep && dep.op === 'upsert') {
          visit(j);
          break;
        }
      }
    }
  };
  const visit = (i: number) => {
    if (done.has(i) || visiting.has(i)) return;
    const g = groupOf.get(i);
    const members = g ? groupMembers.get(g) || [i] : [i];
    for (const j of members) visiting.add(j);
    for (const j of members) visitDeps(j);
    for (const j of members) {
      visiting.delete(j);
      if (done.has(j)) continue;
      done.add(j);
      out.push(list[j]);
    }
  };
  for (let i = 0; i < list.length; i++) visit(i);
  return out;
}
