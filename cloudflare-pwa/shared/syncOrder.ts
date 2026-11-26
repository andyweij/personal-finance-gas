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
  for (const field of ['linkedAccountId', 'accountId', 'assetId']) {
    const v = typeof p[field] === 'string' ? (p[field] as string).trim() : '';
    if (v && !(mut.entity === 'asset' && v === mut.recordId)) keys.push(`asset:${v}`);
  }
  return keys;
}

function keyOf(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null;
  const mut = m as Partial<SyncMutation>;
  return typeof mut.entity === 'string' && typeof mut.recordId === 'string' ? `${mut.entity}:${mut.recordId}` : null;
}

/**
 * Stable dependency order: every pending upsert of a record that another mutation references is moved in front of
 * the referencing mutation (together with the earlier mutations of that same record, so a record's own mutations
 * never change order). Everything else keeps its position. Cycles are broken by keeping the original order.
 * Works on untrusted input (the server runs it on request bodies): non-object entries are passed through.
 */
export function orderMutationsByDependencies<T>(list: T[]): T[] {
  const byKey = new Map<string, number[]>();
  list.forEach((m, i) => {
    const k = keyOf(m);
    if (!k) return;
    const arr = byKey.get(k) || [];
    arr.push(i);
    byKey.set(k, arr);
  });
  const out: T[] = [];
  const done = new Set<number>();
  const visiting = new Set<number>();
  const visit = (i: number) => {
    if (done.has(i) || visiting.has(i)) return;
    visiting.add(i);
    const m = list[i];
    const k = keyOf(m);
    // earlier mutations of the same record first
    if (k) for (const j of byKey.get(k) || []) if (j < i) visit(j);
    for (const ref of mutationReferenceKeys(m)) {
      for (const j of byKey.get(ref) || []) {
        if (j === i) continue;
        const dep = list[j] as Partial<SyncMutation>;
        if (dep && dep.op === 'upsert') visit(j);
      }
    }
    visiting.delete(i);
    done.add(i);
    out.push(m);
  };
  for (let i = 0; i < list.length; i++) visit(i);
  return out;
}
