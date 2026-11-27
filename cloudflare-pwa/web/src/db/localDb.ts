import {
  DEFAULT_EMERGENCY_MONTHS,
  DEFAULT_LEDGER_ID,
  DEFAULT_LEDGER_NAME,
  DEFAULT_MONTHLY_DAILY_BUDGET,
  DEFAULT_PNL_COLOR_SCHEME,
  DEFAULT_USD_TWD_RATE,
} from '../../../shared/constants';
import { DEFAULT_UTILITY_RENTS } from '../../../shared/rentUtility';
import type {
  CachedPasskeyDto,
  FinanceSnapshot,
  Ledger,
  SharedLedgerCursor,
  SharedLedgerSyncState,
  SyncConflict,
  SyncMutation,
  SyncRejection,
} from '../../../shared/types';

const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_OUTBOX = 'outbox';

export function createDefaultLedger(): Ledger {
  return {
    id: DEFAULT_LEDGER_ID,
    name: DEFAULT_LEDGER_NAME,
    includeInNetWorth: true,
    monthlyDailyBudget: null,
    note: '預設個人帳本（納入總資產與淨值統計）',
    sortOrder: 1,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
}

export function createEmptySnapshot(): FinanceSnapshot {
  return {
    settings: {
      monthlyDailyBudget: DEFAULT_MONTHLY_DAILY_BUDGET,
      emergencyTargetMonths: DEFAULT_EMERGENCY_MONTHS,
      usdTwdRate: DEFAULT_USD_TWD_RATE,
      enabledCurrencies: ['TWD', 'USD'],
      fxRates: { USD: DEFAULT_USD_TWD_RATE },
      autoFxEnabled: true,
      fxUpdatedAt: null,
      pnlColorScheme: DEFAULT_PNL_COLOR_SCHEME,
      customStockCategories: [],
      rebalanceTargets: [],
      customCategories: {},
      quickTemplates: [],
      updatedAt: '',
    },
    ledgers: [createDefaultLedger()],
    cashflowLogs: [],
    recurringItems: [],
    sinkingItems: [],
    assetItems: [],
    savingsAdjustments: [],
    stockTransactions: [],
    netWorthHistory: [],
    rentUtilityRecords: [],
    rentUtilityRents: { ...DEFAULT_UTILITY_RENTS },
    financialGoals: [],
    splitReceivables: [],
    installmentPlans: [],
  };
}

export interface LocalMeta {
  lastSyncedAt: string | null;
  syncCursor?: number | null;
  dataEpoch?: number | null;
  pendingFullResync?: boolean;
  /** Phase 9 (v2.0.0): per-shared-ledger cursors & active shared metadata */
  sharedCursors?: Record<string, SharedLedgerCursor>;
  sharedLedgers?: SharedLedgerSyncState[];
  pinEnabled: boolean;
  pinSalt: string | null;
  pinHash: string | null;
  biometricLockEnabled?: boolean;
  passkeys?: CachedPasskeyDto[];
}

/**
 * P2-C6: Lock-screen fields owned by updateLocalPinCache / updateLocalBiometricCache. Every other meta write
 * keeps the stored values of these fields, so a tab holding a stale in-memory meta (e.g. while syncing)
 * can never revert a PIN or biometric change made in another tab.
 */
const AUTH_META_FIELDS = ['pinEnabled', 'pinSalt', 'pinHash', 'biometricLockEnabled', 'passkeys'] as const;
type AuthMetaPatch = Partial<Pick<LocalMeta, (typeof AUTH_META_FIELDS)[number]>>;

function pickAuthMeta(meta: Partial<LocalMeta>): AuthMetaPatch {
  const out: Record<string, unknown> = {};
  for (const k of AUTH_META_FIELDS) {
    if (k in meta) out[k] = (meta as Record<string, unknown>)[k];
  }
  return out as AuthMetaPatch;
}

/**
 * P2-C6: Thrown by commitLocalMutation when another tab wrote the snapshot after this tab last read it.
 * The engine reloads from IndexedDB and recomputes the edit instead of overwriting the other tab's data.
 */
export class StaleSnapshotError extends Error {
  constructor() {
    super('其他分頁剛更新了本機資料');
    this.name = 'StaleSnapshotError';
  }
}

export class LocalFinanceDB {
  private db: IDBDatabase | null = null;

  static dbNameForUser(userId?: string | null): string {
    const cleaned = String(userId || '').trim();
    if (!cleaned || cleaned === 'owner') {
      return 'personal-finance-pwa-db';
    }
    return `personal-finance-pwa-db:${cleaned}`;
  }

  constructor(private readonly dbName = 'personal-finance-pwa-db') {}

  getDbName(): string {
    return this.dbName;
  }

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) {
          db.createObjectStore(STORE_KV);
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'mutationId' });
          outbox.createIndex('clientTimestamp', 'clientTimestamp', { unique: false });
        }
      };
      req.onsuccess = () => {
        const opened = req.result;
        // H3: let another tab delete this database on logout instead of being blocked by our open handle
        opened.onversionchange = () => {
          opened.close();
          if (this.db === opened) this.db = null;
        };
        resolve(opened);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** H3: close and permanently delete this account's local database (used on logout). */
  /**
   * Returns 'blocked' when another tab (e.g. one still running an older version) keeps the database open for
   * more than 3 s; the delete stays queued and completes once that tab closes.
   */
  async deleteDatabase(): Promise<'deleted' | 'blocked'> {
    this.close();
    return new Promise<'deleted' | 'blocked'>((resolve, reject) => {
      let settled = false;
      const req = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess = () => {
        settled = true;
        resolve('deleted');
      };
      req.onerror = () => {
        settled = true;
        reject(req.error);
      };
      req.onblocked = () => {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve('blocked');
          }
        }, 3000);
      };
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error('LocalFinanceDB is not open');
    return this.db;
  }

  async getSnapshot(): Promise<FinanceSnapshot> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      // P2-C6: read the revision first so it is known before the snapshot request resolves
      const revReq = tx.objectStore(STORE_KV).get('snapshot_rev');
      revReq.onsuccess = () => {
        this.lastSnapshotRev = Number(revReq.result) || 0;
      };
      const req = tx.objectStore(STORE_KV).get('snapshot');
      req.onsuccess = () => {
        const raw = req.result as Partial<FinanceSnapshot> | undefined;
        if (!raw) {
          resolve(createEmptySnapshot());
          return;
        }
        const empty = createEmptySnapshot();
        const rawLedgers = Array.isArray(raw.ledgers) && raw.ledgers.length > 0 ? raw.ledgers : empty.ledgers;
        resolve({
          ...empty,
          ...raw,
          settings: raw.settings
            ? {
                ...empty.settings,
                ...raw.settings,
                customStockCategories: Array.isArray(raw.settings.customStockCategories)
                  ? raw.settings.customStockCategories
                  : [],
                rebalanceTargets: Array.isArray(raw.settings.rebalanceTargets)
                  ? raw.settings.rebalanceTargets
                  : [],
                customCategories:
                  raw.settings.customCategories &&
                  typeof raw.settings.customCategories === 'object' &&
                  !Array.isArray(raw.settings.customCategories)
                    ? raw.settings.customCategories
                    : {},
                quickTemplates: Array.isArray(raw.settings.quickTemplates)
                  ? raw.settings.quickTemplates
                  : [],
                enabledCurrencies: Array.isArray(raw.settings.enabledCurrencies)
                  ? raw.settings.enabledCurrencies
                  : ['TWD', 'USD'],
                fxRates:
                  raw.settings.fxRates &&
                  typeof raw.settings.fxRates === 'object' &&
                  !Array.isArray(raw.settings.fxRates)
                    ? raw.settings.fxRates
                    : { USD: Number(raw.settings.usdTwdRate || DEFAULT_USD_TWD_RATE) },
              }
            : empty.settings,
          ledgers: rawLedgers,
          cashflowLogs: Array.isArray(raw.cashflowLogs) ? raw.cashflowLogs : [],
          recurringItems: Array.isArray(raw.recurringItems) ? raw.recurringItems : [],
          sinkingItems: Array.isArray(raw.sinkingItems) ? raw.sinkingItems : [],
          assetItems: Array.isArray(raw.assetItems) ? raw.assetItems : [],
          savingsAdjustments: Array.isArray(raw.savingsAdjustments) ? raw.savingsAdjustments : [],
          stockTransactions: Array.isArray(raw.stockTransactions) ? raw.stockTransactions : [],
          netWorthHistory: Array.isArray(raw.netWorthHistory) ? raw.netWorthHistory : [],
          rentUtilityRecords: Array.isArray(raw.rentUtilityRecords) ? raw.rentUtilityRecords : [],
          rentUtilityRents: raw.rentUtilityRents || empty.rentUtilityRents,
          financialGoals: Array.isArray(raw.financialGoals) ? raw.financialGoals : [],
          splitReceivables: Array.isArray(raw.splitReceivables) ? raw.splitReceivables : [],
          installmentPlans: Array.isArray(raw.installmentPlans) ? raw.installmentPlans : [],
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async saveSnapshot(snapshot: FinanceSnapshot): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      {
        const kvSnap = tx.objectStore(STORE_KV);
        kvSnap.put(snapshot, 'snapshot');
        this.bumpSnapshotRev(kvSnap);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async getMeta(): Promise<LocalMeta> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get('meta');
      req.onsuccess = () =>
        resolve(
          (req.result as LocalMeta) || {
            lastSyncedAt: null,
            pinEnabled: false,
            pinSalt: null,
            pinHash: null,
          }
        );
      req.onerror = () => reject(req.error);
    });
  }

  async saveMeta(meta: LocalMeta): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      this.putMetaKeepingAuth(tx.objectStore(STORE_KV), meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async getConflicts(): Promise<SyncConflict[]> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get('conflicts');
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as SyncConflict[]) : []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveConflicts(conflicts: SyncConflict[]): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(conflicts, 'conflicts');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async getRejections(): Promise<SyncRejection[]> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get('rejections');
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as SyncRejection[]) : []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveRejections(rejections: SyncRejection[]): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(rejections, 'rejections');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  private outboxSeq = 0;
  /** P2-C6: snapshot revision this instance last read or wrote (stored under KV key 'snapshot_rev'). */
  private lastSnapshotRev = 0;

  /** P2-C6: write meta but keep the stored lock-screen fields (see AUTH_META_FIELDS). */
  private putMetaKeepingAuth(kv: IDBObjectStore, meta: LocalMeta): void {
    const req = kv.get('meta');
    req.onsuccess = () => {
      const stored = req.result as LocalMeta | undefined;
      kv.put(stored ? { ...meta, ...pickAuthMeta(stored) } : meta, 'meta');
    };
  }

  /** P2-C6: update only the lock-screen fields, merged into the stored meta (cursor etc. untouched). */
  async patchAuthMeta(patch: AuthMetaPatch, fallbackMeta?: LocalMeta): Promise<LocalMeta | null> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      let merged: LocalMeta | null = null;
      const req = kv.get('meta');
      req.onsuccess = () => {
        const stored = req.result as LocalMeta | undefined;
        if (!stored && !fallbackMeta) return;
        // v1.8.15: no stored meta yet → create it here, inside the same transaction (no separate write that
        // could overwrite defaults another tab created meanwhile)
        merged = { ...(stored ?? fallbackMeta!), ...patch };
        kv.put(merged, 'meta');
      };
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  private bumpSnapshotRev(kv: IDBObjectStore): void {
    const req = kv.get('snapshot_rev');
    req.onsuccess = () => {
      const next = (Number(req.result) || 0) + 1;
      kv.put(next, 'snapshot_rev');
      // v1.8.15: the in-memory revision only moves once the write is durable (an aborted transaction keeps it)
      kv.transaction.addEventListener('complete', () => {
        this.lastSnapshotRev = next;
      });
    };
  }

  /** v1.8.15: remember the stored revision once this transaction completes (state was read, not written). */
  private adoptSnapshotRev(kv: IDBObjectStore): void {
    const req = kv.get('snapshot_rev');
    req.onsuccess = () => {
      const cur = Number(req.result) || 0;
      kv.transaction.addEventListener('complete', () => {
        this.lastSnapshotRev = cur;
      });
    };
  }

  /**
   * v1.8.15: reads the outbox, lets `select` pick the batch, and marks the picked mutations as sent — all in ONE
   * readwrite transaction (another tab cannot coalesce or cancel a picked mutation in between).
   */
  async takeOutboxBatch(
    select: (outbox: SyncMutation[]) => string[],
    sentAtIso: string
  ): Promise<{ outbox: SyncMutation[]; batch: SyncMutation[] }> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = tx.objectStore(STORE_OUTBOX);
      let outbox: SyncMutation[] = [];
      let batch: SyncMutation[] = [];
      let failure: unknown = null;
      const req = store.getAll();
      req.onsuccess = () => {
        const list = ((req.result as Array<SyncMutation & { _seq?: number }>) || []).slice();
        list.sort((a, b) => a.clientTimestamp.localeCompare(b.clientTimestamp) || (a._seq ?? 0) - (b._seq ?? 0));
        outbox = list.map(({ _seq: _ignored, ...rest }) => rest);
        let ids: string[];
        try {
          ids = select(outbox);
        } catch (err) {
          failure = err;
          try {
            tx.abort();
          } catch {
            /* already aborted */
          }
          return;
        }
        const idSet = new Set(ids);
        const byId = new Map(outbox.map((m) => [m.mutationId, m]));
        batch = ids.map((id) => byId.get(id)).filter((m): m is SyncMutation => Boolean(m));
        for (const item of list) {
          if (!idSet.has(item.mutationId)) continue;
          store.put({ ...item, sentAt: item.sentAt || sentAtIso, attempts: (item.attempts ?? 0) + 1 });
        }
        batch = batch.map((m) => ({ ...m, sentAt: m.sentAt || sentAtIso, attempts: (m.attempts ?? 0) + 1 }));
      };
      tx.oncomplete = () => resolve({ outbox, batch });
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async getOutbox(): Promise<SyncMutation[]> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OUTBOX, 'readonly');
      const req = tx.objectStore(STORE_OUTBOX).getAll();
      req.onsuccess = () => {
        const list = (req.result as Array<SyncMutation & { _seq?: number }>) || [];
        list.sort(
          (a, b) =>
            a.clientTimestamp.localeCompare(b.clientTimestamp) || (a._seq ?? 0) - (b._seq ?? 0)
        );
        resolve(list.map(({ _seq: _ignored, ...rest }) => rest));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getFrozenOutbox(): Promise<SyncMutation[]> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get('frozen_outbox');
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as SyncMutation[]) : []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveFrozenOutbox(items: SyncMutation[]): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(items, 'frozen_outbox');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async markOutboxBatchSent(mutationIds: string[], sentAtIso: string): Promise<void> {
    if (mutationIds.length === 0) return;
    const idSet = new Set(mutationIds);
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = tx.objectStore(STORE_OUTBOX);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as Array<SyncMutation & { _seq?: number }>) || [];
        for (const item of list) {
          if (idSet.has(item.mutationId)) {
            store.put({
              ...item,
              sentAt: item.sentAt || sentAtIso,
              attempts: (item.attempts ?? 0) + 1,
            });
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async incrementOutboxRetryCounts(
    mutationIds: string[],
    lastError: string
  ): Promise<SyncMutation[]> {
    if (mutationIds.length === 0) return [];
    const idSet = new Set(mutationIds);
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const updated: SyncMutation[] = [];
      const tx = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = tx.objectStore(STORE_OUTBOX);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as Array<SyncMutation & { _seq?: number }>) || [];
        for (const item of list) {
          if (idSet.has(item.mutationId)) {
            const next = {
              ...item,
              retryCount: (item.retryCount ?? 0) + 1,
              lastError: lastError.slice(0, 240),
            };
            store.put(next);
            const { _seq: _ignored, ...clean } = next;
            updated.push(clean);
          }
        }
      };
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async quarantineOutboxMutation(
    mutationIdsToRemove: string[],
    snapshot: FinanceSnapshot,
    meta: LocalMeta,
    rejections: SyncRejection[]
  ): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      for (const id of mutationIdsToRemove) {
        outboxStore.delete(id);
      }
      const kv = tx.objectStore(STORE_KV);
      kv.put(snapshot, 'snapshot');
      this.bumpSnapshotRev(kv);
      this.putMetaKeepingAuth(kv, meta);
      kv.put(rejections, 'rejections');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  private applyMutationsToOutboxStore(
    outboxStore: IDBObjectStore,
    existingList: Array<SyncMutation & { _seq?: number }>,
    mutations: SyncMutation[],
    inFlightIds?: ReadonlySet<string>
  ): void {
    const byKey = new Map<string, SyncMutation & { _seq?: number }>();
    const lockedKeys = new Set<string>();
    const lockedNewRecordKeys = new Set<string>();
    for (const item of existingList) {
      const k = `${item.entity}:${item.recordId}`;
      // P2-C2: Once a mutation has ever been sent (persisted sentAt) or is in-flight,
      // it MUST NOT be coalesced or cancelled by later edits/deletes.
      const isImmutable = Boolean(item.sentAt) || Boolean(inFlightIds && inFlightIds.has(item.mutationId));
      if (isImmutable) {
        lockedKeys.add(k);
        const itemIsNew =
          item.op === 'upsert' &&
          (item.isNewRecord !== undefined
            ? item.isNewRecord
            : item.baseVersion === null || item.baseVersion === 0);
        if (itemIsNew) {
          lockedNewRecordKeys.add(k);
        }
      } else {
        byKey.set(k, item);
      }
    }

    for (const mut of mutations) {
      const key = `${mut.entity}:${mut.recordId}`;
      let prev = byKey.get(key);
      // M4 / review R-C: never coalesce across atomic groups (including grouped ↔ ungrouped). A merged mutation
      // would carry the other edit into the group (an offline-created account would be rolled back together with
      // a rejected transfer from it) — keep both; the batch selector sends them one after the other and the ack
      // rebases the later one.
      if (prev && (prev.atomicGroupId || undefined) !== (mut.atomicGroupId || undefined)) {
        prev = undefined;
      }
      if (prev) {
        outboxStore.delete(prev.mutationId);
        const prevIsNewUnsynced =
          prev.op === 'upsert' &&
          (prev.isNewRecord !== undefined
            ? prev.isNewRecord
            : prev.baseVersion === null || prev.baseVersion === 0);
        if (prevIsNewUnsynced && mut.op === 'delete' && !lockedKeys.has(key)) {
          // Brand-new offline record deleted before ever being sent -> cancel out completely
          byKey.delete(key);
          continue;
        }
        // Coalesce while preserving the original server baseVersion and isNewRecord marker
        this.outboxSeq += 1;
        const coalesced: SyncMutation & { _seq: number } = {
          ...mut,
          baseVersion: prev.baseVersion !== undefined ? prev.baseVersion : mut.baseVersion,
          ...(prev.isNewRecord !== undefined
            ? { isNewRecord: prev.isNewRecord }
            : lockedNewRecordKeys.has(key) && mut.op === 'upsert'
              ? { isNewRecord: true }
              : mut.isNewRecord !== undefined
                ? { isNewRecord: mut.isNewRecord }
                : {}),
          _seq: this.outboxSeq,
        };
        outboxStore.put(coalesced);
        byKey.set(key, coalesced);
      } else {
        this.outboxSeq += 1;
        // R7: If an immutable/in-flight create exists for this key, mark dependent follow-up upsert as isNewRecord: true
        const record: SyncMutation & { _seq: number } = {
          ...mut,
          ...(lockedNewRecordKeys.has(key) && mut.op === 'upsert' && mut.isNewRecord === undefined
            ? { isNewRecord: true }
            : {}),
          _seq: this.outboxSeq,
        };
        outboxStore.put(record);
        byKey.set(key, record);
      }
    }
  }

  /**
   * 單一 IndexedDB 交易同時更新本機 Snapshot 並加入 Outbox，並自動整併同一筆紀錄的離線多次修改
   * （保留最初的伺服器 baseVersion；曾送出過的 sentAt / in-flight mutation 絕不合併或抵銷；
   * 僅在新建尚未送出時，新建後立即刪除才會互相抵銷）
   */
  async commitLocalMutation(
    snapshot: FinanceSnapshot,
    mutations: SyncMutation[],
    inFlightIds?: ReadonlySet<string>
  ): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      let stale = false;
      let newRev = this.lastSnapshotRev;
      // P2-C6: only write if no other tab changed the snapshot since this tab last read/wrote it
      const revReq = kv.get('snapshot_rev');
      revReq.onsuccess = () => {
        const cur = Number(revReq.result) || 0;
        if (cur !== this.lastSnapshotRev) {
          stale = true;
          try {
            tx.abort();
          } catch {
            /* already aborted */
          }
          return;
        }
        newRev = cur + 1;
        kv.put(snapshot, 'snapshot');
        kv.put(newRev, 'snapshot_rev');
        const getAllReq = outboxStore.getAll();
        getAllReq.onsuccess = () => {
          const existingList = (getAllReq.result as Array<SyncMutation & { _seq?: number }>) || [];
          this.applyMutationsToOutboxStore(outboxStore, existingList, mutations, inFlightIds);
        };
      };

      tx.oncomplete = () => {
        this.lastSnapshotRev = newRev;
        resolve();
      };
      tx.onerror = () => reject(stale ? new StaleSnapshotError() : tx.error);
      tx.onabort = () =>
        reject(stale ? new StaleSnapshotError() : tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async resolveConflictKeepServerTx(
    snapshot: FinanceSnapshot,
    conflicts: SyncConflict[]
  ): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      kv.put(snapshot, 'snapshot');
      this.bumpSnapshotRev(kv);
      kv.put(conflicts, 'conflicts');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async resolveConflictKeepLocalTx(
    snapshot: FinanceSnapshot,
    conflicts: SyncConflict[],
    retryMutation: SyncMutation,
    inFlightIds?: ReadonlySet<string>
  ): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      kv.put(snapshot, 'snapshot');
      this.bumpSnapshotRev(kv);
      kv.put(conflicts, 'conflicts');
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      const getAllReq = outboxStore.getAll();
      getAllReq.onsuccess = () => {
        const existingList = (getAllReq.result as Array<SyncMutation & { _seq?: number }>) || [];
        this.applyMutationsToOutboxStore(outboxStore, existingList, [retryMutation], inFlightIds);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async freezeOutboxAndApplySnapshot(
    snapshot: FinanceSnapshot,
    meta: LocalMeta,
    conflicts?: SyncConflict[],
    rejections?: SyncRejection[],
    options?: {
      excludeMutationIds?: Iterable<string>;
      annotateItem?: (item: SyncMutation) => SyncMutation;
      retainFrozen?: (item: SyncMutation) => boolean;
    }
  ): Promise<SyncMutation[]> {
    const db = this.getDb();
    const excludeSet = options?.excludeMutationIds ? new Set(options.excludeMutationIds) : null;
    const annotateItem = options?.annotateItem;
    return new Promise((resolve, reject) => {
      let mergedFrozen: SyncMutation[] = [];
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      const frozenReq = kv.get('frozen_outbox');
      const outboxReq = outboxStore.getAll();

      let existingFrozen: SyncMutation[] | null = null;
      let existingOutbox: Array<SyncMutation & { _seq?: number }> | null = null;

      const tryFinalize = () => {
        if (existingFrozen === null || existingOutbox === null) return;
        existingOutbox.sort(
          (a, b) =>
            a.clientTimestamp.localeCompare(b.clientTimestamp) || (a._seq ?? 0) - (b._seq ?? 0)
        );
        const byId = new Map<string, SyncMutation>();
        for (const f of existingFrozen) {
          if (!options?.retainFrozen || options.retainFrozen(f)) byId.set(f.mutationId, f);
        }
        for (const item of existingOutbox) {
          if (excludeSet && excludeSet.has(item.mutationId)) continue;
          const { _seq: _ignored, ...rest } = item;
          byId.set(rest.mutationId, annotateItem ? annotateItem(rest) : rest);
        }
        mergedFrozen = Array.from(byId.values());
        outboxStore.clear();
        kv.put(mergedFrozen, 'frozen_outbox');
        kv.put(snapshot, 'snapshot');
        this.bumpSnapshotRev(kv);
        this.putMetaKeepingAuth(kv, meta);
        if (conflicts !== undefined) kv.put(conflicts, 'conflicts');
        if (rejections !== undefined) kv.put(rejections, 'rejections');
      };

      frozenReq.onsuccess = () => {
        existingFrozen = Array.isArray(frozenReq.result) ? (frozenReq.result as SyncMutation[]) : [];
        tryFinalize();
      };
      outboxReq.onsuccess = () => {
        existingOutbox = (outboxReq.result as Array<SyncMutation & { _seq?: number }>) || [];
        tryFinalize();
      };

      tx.oncomplete = () => resolve(mergedFrozen);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async reapplyFrozenOutboxTx(
    transform: (
      freshSnapshot: FinanceSnapshot,
      freshFrozen: SyncMutation[],
      freshOutbox: SyncMutation[]
    ) => {
      nextSnapshot: FinanceSnapshot;
      mutationsToEnqueue: SyncMutation[];
      appliedCount: number;
      skippedCount: number;
      /** V3: frozen mutations skipped because the record changed after the freeze — kept for the user to review. */
      skippedRejections?: SyncRejection[];
    },
    inFlightIds?: ReadonlySet<string>
  ): Promise<{
    snapshot: FinanceSnapshot;
    appliedCount: number;
    skippedCount: number;
    remainingOutboxCount: number;
    rejections: SyncRejection[] | null;
  }> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      const outboxStore = tx.objectStore(STORE_OUTBOX);

      const snapReq = kv.get('snapshot');
      const frozenReq = kv.get('frozen_outbox');
      const outboxReq = outboxStore.getAll();
      const rejectionsReq = kv.get('rejections');

      let snapLoaded = false;
      let frozenLoaded = false;
      let outboxLoaded = false;
      let rejectionsLoaded = false;
      let existingRejections: SyncRejection[] = [];
      let resultRejections: SyncRejection[] | null = null;
      let rawSnap: FinanceSnapshot | undefined;
      let freshFrozen: SyncMutation[] = [];
      let existingList: Array<SyncMutation & { _seq?: number }> = [];

      let resultSnapshot: FinanceSnapshot = createEmptySnapshot();
      let appliedCount = 0;
      let skippedCount = 0;
      let remainingOutboxCount = 0;
      let failure: unknown = null;

      const tryFinalize = () => {
        if (!snapLoaded || !frozenLoaded || !outboxLoaded || !rejectionsLoaded) return;
        const freshSnapshot = rawSnap
          ? {
              ...createEmptySnapshot(),
              ...rawSnap,
              settings: { ...createEmptySnapshot().settings, ...(rawSnap.settings || {}) },
              rentUtilityRents: {
                ...createEmptySnapshot().rentUtilityRents,
                ...(rawSnap.rentUtilityRents || {}),
              },
            }
          : createEmptySnapshot();

        existingList.sort(
          (a, b) =>
            a.clientTimestamp.localeCompare(b.clientTimestamp) || (a._seq ?? 0) - (b._seq ?? 0)
        );
        const cleanOutbox: SyncMutation[] = existingList.map((item) => {
          const { _seq: _ignored, ...rest } = item;
          return rest;
        });

        if (freshFrozen.length === 0) {
          resultSnapshot = freshSnapshot;
          remainingOutboxCount = cleanOutbox.length;
          // v1.8.15: the engine adopts this snapshot, so it must also adopt its revision (no spurious reload)
          this.adoptSnapshotRev(kv);
          return;
        }

        let transformed: ReturnType<typeof transform>;
        try {
          transformed = transform(freshSnapshot, freshFrozen, cleanOutbox);
        } catch (err) {
          // R-1: An exception inside an IndexedDB callback would abort the transaction without settling
          // this promise, deadlocking the engine's serialized lock. Abort explicitly and reject.
          failure = err;
          try {
            tx.abort();
          } catch {
            /* already aborted */
          }
          return;
        }
        resultSnapshot = transformed.nextSnapshot;
        appliedCount = transformed.appliedCount;
        skippedCount = transformed.skippedCount;

        kv.put(transformed.nextSnapshot, 'snapshot');
        this.bumpSnapshotRev(kv);
        kv.put([], 'frozen_outbox');
        if (transformed.skippedRejections && transformed.skippedRejections.length > 0) {
          const byId = new Map(existingRejections.map((r) => [r.mutationId, r]));
          for (const r of transformed.skippedRejections) byId.set(r.mutationId, r);
          resultRejections = Array.from(byId.values());
          kv.put(resultRejections, 'rejections');
        }
        if (transformed.mutationsToEnqueue.length > 0) {
          this.applyMutationsToOutboxStore(
            outboxStore,
            existingList,
            transformed.mutationsToEnqueue,
            inFlightIds
          );
        }
        const countReq = outboxStore.count();
        countReq.onsuccess = () => {
          remainingOutboxCount = Number(countReq.result || 0);
        };
      };

      snapReq.onsuccess = () => {
        rawSnap = snapReq.result as FinanceSnapshot | undefined;
        snapLoaded = true;
        tryFinalize();
      };
      frozenReq.onsuccess = () => {
        freshFrozen = Array.isArray(frozenReq.result) ? (frozenReq.result as SyncMutation[]) : [];
        frozenLoaded = true;
        tryFinalize();
      };
      outboxReq.onsuccess = () => {
        existingList = (outboxReq.result as Array<SyncMutation & { _seq?: number }>) || [];
        outboxLoaded = true;
        tryFinalize();
      };
      rejectionsReq.onsuccess = () => {
        existingRejections = Array.isArray(rejectionsReq.result) ? (rejectionsReq.result as SyncRejection[]) : [];
        rejectionsLoaded = true;
        tryFinalize();
      };

      tx.oncomplete = () =>
        resolve({
          snapshot: resultSnapshot,
          appliedCount,
          skippedCount,
          remainingOutboxCount,
          rejections: resultRejections,
        });
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async acknowledgeOutboxAndSave(
    ackedIds: string[],
    snapshot: FinanceSnapshot,
    meta: LocalMeta,
    conflicts?: SyncConflict[],
    rejections?: SyncRejection[],
    rebasedMutations?: Array<{ oldMutationId: string; replacement: SyncMutation }>,
    frozenOutbox?: SyncMutation[]
  ): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      for (const id of ackedIds) {
        outboxStore.delete(id);
      }
      if (rebasedMutations && rebasedMutations.length > 0) {
        for (const item of rebasedMutations) {
          // V2: Keep the original queue position (_seq) so a rebased mutation never moves behind mutations
          // that were queued after it (e.g. "move records out of ledger" must stay before "delete ledger").
          // P2-C5: If the old mutation is gone (coalesced/removed by another tab meanwhile), do not resurrect it.
          const getReq = outboxStore.get(item.oldMutationId);
          getReq.onsuccess = () => {
            const old = getReq.result as (SyncMutation & { _seq?: number }) | undefined;
            if (!old) return;
            outboxStore.delete(item.oldMutationId);
            let seq = old._seq;
            if (seq === undefined) {
              this.outboxSeq += 1;
              seq = this.outboxSeq;
            }
            outboxStore.put({ ...item.replacement, _seq: seq });
          };
        }
      }
      const kv = tx.objectStore(STORE_KV);
      kv.put(snapshot, 'snapshot');
      if (frozenOutbox !== undefined) kv.put(frozenOutbox, 'frozen_outbox');
      this.bumpSnapshotRev(kv);
      this.putMetaKeepingAuth(kv, meta);
      if (conflicts !== undefined) {
        kv.put(conflicts, 'conflicts');
      }
      if (rejections !== undefined) {
        kv.put(rejections, 'rejections');
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async clearAll(): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      tx.objectStore(STORE_KV).clear();
      tx.objectStore(STORE_OUTBOX).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
