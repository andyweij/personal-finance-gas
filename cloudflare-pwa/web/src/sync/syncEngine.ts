import { todayInTimeZone } from '../../../shared/dates';
import { mutationReferenceKeys, orderMutationsByDependencies } from '../../../shared/syncOrder';
import {
  applySubsetReorder,
  compareBySortOrder,
  computeStockPositionSummary,
  ensureActiveLedgers,
  getEffectiveLedgerId,
  isTransferableAccount,
} from '../../../shared/calculations';
import {
  CASHFLOW_TYPES,
  DEFAULT_LEDGER_ID,
  RECURRING_CASHFLOW_TYPES,
  STOCK_TX_TYPES,
  SYNC_MAX_MUTATIONS_PER_REQUEST,
} from '../../../shared/constants';
import {
  sortUtilityRecords,
  validateUtilityRecordInput,
  validateUtilityRentsInput,
  type UtilityRecordInputPayload,
} from '../../../shared/rentUtility';
import type {
  AppSettings,
  AssetItem,
  CashFlowLog,
  FinanceSnapshot,
  Ledger,
  PnlColorScheme,
  RecurringItem,
  RentUtilityRecord,
  RentUtilityRents,
  SavingsAdjustment,
  SinkingFundItem,
  StockTransaction,
  SyncConflict,
  SyncDelta,
  SyncMutation,
  SyncRejection,
  SyncResponse,
} from '../../../shared/types';
import {
  normalizeCustomStockCategories,
  normalizeLedgerId,
  normalizePnlColorScheme,
  normalizeStockCategory,
  validateAccountTransferInput,
  validateAssetInput,
  validateCashFlowInput,
  validateLedgerInput,
  validateRecurringInput,
  validateSavingsAdjustmentInput,
  validateSinkingInput,
  validateStockTransactionInput,
  type AccountTransferInputPayload,
  type AssetInputPayload,
  type CashFlowInputPayload,
  type LedgerInputPayload,
  type RecurringInputPayload,
  type SavingsAdjustmentInputPayload,
  type SinkingInputPayload,
  type StockTransactionInputPayload,
} from '../../../shared/validation';
import {
  createDefaultLedger,
  createEmptySnapshot,
  StaleSnapshotError,
  type LocalFinanceDB,
  type LocalMeta,
} from '../db/localDb';
import { createCrossTabChannel, type CrossTabChannel } from './crossTab';

export type SyncStateKind = 'synced' | 'syncing' | 'pending' | 'offline' | 'auth_required' | 'conflict';

export interface SyncStatus {
  state: SyncStateKind;
  pendingCount: number;
  conflictCount?: number;
  rejectedCount?: number;
  frozenOutboxCount?: number;
  lastSyncedAt: string | null;
  lastError?: string;
}

export interface SyncResult {
  ok: boolean;
  authRequired?: boolean;
  accountMismatch?: boolean;
  epochMismatch?: boolean;
  error?: string;
}

export interface SyncEngineOptions {
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  expectedUserId?: string;
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  maxBatchSize?: number;
  maxPoisonRetries?: number;
  requestLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  onStatusChange?: (status: SyncStatus) => void;
  onSnapshotChange?: (snapshot: FinanceSnapshot) => void;
  onAuthRequired?: () => void;
  onAccountMismatch?: (info: { error: string; expectedUserId?: string; actualUserId?: string }) => void;
  onError?: (message: string) => void;
}

/**
 * Fallback cross-tab mutex using localStorage TTL lease when Web Locks API
 * (navigator.locks) is unavailable (e.g., older iOS Safari < 15.4).
 */
/** P2-C7: another tab holds the sync lease; this sync is skipped and retried later. */
class SyncLockBusyError extends Error {
  constructor() {
    super('另一個分頁正在同步，稍後將自動重試');
    this.name = 'SyncLockBusyError';
  }
}

async function withLocalStorageLease<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  if (typeof localStorage === 'undefined') {
    return fn();
  }
  const key = `pf_lock:${lockName}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ttlMs = 30_000;
  const maxWaitMs = 15_000;
  const settleMs = 60;
  const deadline = Date.now() + maxWaitMs;

  const readLease = (): { token?: string; expiresAt?: number } | null => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { token?: string; expiresAt?: number }) : null;
  };

  // P2-C7: localStorage has no compare-and-set. Write our token, wait a moment so a competing tab's write
  // (which overwrites ours) becomes visible, then confirm the lease is still ours.
  const tryAcquire = async (): Promise<boolean> => {
    try {
      const current = readLease();
      if (current && typeof current.expiresAt === 'number' && current.expiresAt > Date.now() && current.token !== token) {
        return false;
      }
      localStorage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + ttlMs }));
      await new Promise((r) => setTimeout(r, settleMs));
      return readLease()?.token === token;
    } catch {
      // Storage unavailable (e.g. private mode quota): no cross-tab coordination is possible
      return true;
    }
  };

  let acquired = await tryAcquire();
  while (!acquired && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 60)));
    acquired = await tryAcquire();
  }
  if (!acquired) {
    // Never run without the lease: two tabs sending the same outbox concurrently causes self-conflicts
    throw new SyncLockBusyError();
  }

  const renewTimer = setInterval(() => {
    try {
      const cur = JSON.parse(localStorage.getItem(key) || '{}') as { token?: string };
      if (cur.token === token) {
        localStorage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + ttlMs }));
      }
    } catch {
      // Ignore storage errors
    }
  }, 10_000);

  try {
    return await fn();
  } finally {
    clearInterval(renewTimer);
    try {
      const cur = JSON.parse(localStorage.getItem(key) || '{}') as { token?: string };
      if (cur.token === token) {
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage errors
    }
  }
}

function isIncomingPreferred(
  existing: { updatedAt: string; version?: number } | undefined,
  incoming: { updatedAt: string; version?: number }
): boolean {
  if (!existing) return true;
  if (incoming.version !== undefined && existing.version !== undefined) {
    if (incoming.version !== existing.version) {
      return incoming.version > existing.version;
    }
  } else if (incoming.version !== undefined && existing.version === undefined) {
    return true;
  }
  return incoming.updatedAt >= existing.updatedAt;
}

function mergeById<T extends { id: string; deletedAt?: string | null; updatedAt: string; version?: number }>(
  current: T[],
  incoming: T[]
): T[] {
  const map = new Map<string, T>();
  for (const item of current) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    if (item.deletedAt) {
      map.delete(item.id);
    } else {
      const existing = map.get(item.id);
      if (isIncomingPreferred(existing, item)) {
        map.set(item.id, item);
      }
    }
  }
  return Array.from(map.values());
}

function mergeUtilityRecords(
  current: RentUtilityRecord[],
  incoming: RentUtilityRecord[]
): RentUtilityRecord[] {
  const map = new Map<string, RentUtilityRecord>();
  for (const item of current) {
    map.set(item.period, item);
  }
  for (const item of incoming) {
    if (item.deletedAt) {
      map.delete(item.period);
    } else {
      const existing = map.get(item.period);
      if (isIncomingPreferred(existing, item)) {
        map.set(item.period, item);
      }
    }
  }
  return sortUtilityRecords(Array.from(map.values()));
}

/** v1.8.15: cross-tab reload debounce */
const CROSS_TAB_RELOAD_DEBOUNCE_MS = 150;

export class SyncEngine {
  private snapshot: FinanceSnapshot = createEmptySnapshot();
  private meta: LocalMeta = {
    lastSyncedAt: null,
    syncCursor: null,
    dataEpoch: null,
    pinEnabled: false,
    pinSalt: null,
    pinHash: null,
  };
  private conflicts: SyncConflict[] = [];
  private rejections: SyncRejection[] = [];
  private frozenOutbox: SyncMutation[] = [];
  private status: SyncStatus = {
    state: 'synced',
    pendingCount: 0,
    conflictCount: 0,
    rejectedCount: 0,
    frozenOutboxCount: 0,
    lastSyncedAt: null,
  };
  private syncingPromise: Promise<SyncResult> | null = null;
  private readonly inFlightMutationIds = new Set<string>();
  private stateChain: Promise<void> = Promise.resolve();
  private expectedUserId: string | undefined;
  private accountMismatchHalted = false;
  private consecutiveFailures = 0;
  private poisonSearchActive = false;
  /** R-3: consecutive single-item successes while in poison-search mode; resets batching after a streak. */
  private singleItemSuccessStreak = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private dbChannel: CrossTabChannel | null = null;
  /** P2-C10: request of the sync pass in flight, aborted by destroy() */
  private activeSyncController: AbortController | null = null;
  private destroyed = false;

  private readonly fetchImpl: typeof fetch;
  private readonly isOnline: () => boolean;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxBatchSize: number;
  private crossTabReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxPoisonRetries: number;
  private readonly requestLockImpl: <T>(name: string, fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly db: LocalFinanceDB,
    private readonly opts: SyncEngineOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl || ((input, init) => fetch(input, init));
    this.isOnline =
      opts.isOnline ||
      (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
    this.expectedUserId = opts.expectedUserId;
    this.requestTimeoutMs = Math.max(20, opts.requestTimeoutMs ?? 20_000);
    this.retryBaseDelayMs = Math.max(50, opts.retryBaseDelayMs ?? 2_000);
    // H5: never more than the server processes per request (D1 query budget)
    this.maxBatchSize = Math.max(1, Math.min(SYNC_MAX_MUTATIONS_PER_REQUEST, opts.maxBatchSize ?? SYNC_MAX_MUTATIONS_PER_REQUEST));
    this.maxPoisonRetries = Math.max(2, Math.min(20, opts.maxPoisonRetries ?? 5));
    this.requestLockImpl =
      opts.requestLock ||
      (async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const navLocks =
          typeof navigator !== 'undefined'
            ? (navigator as unknown as {
                locks?: { request?: <R>(lockName: string, cb: () => Promise<R>) => Promise<R> };
              }).locks
            : undefined;
        if (navLocks && typeof navLocks.request === 'function') {
          return navLocks.request(name, fn);
        }
        return withLocalStorageLease(name, fn);
      });

    // BroadcastChannel, or localStorage storage events on browsers without it (Safari < 15.4)
    this.dbChannel = createCrossTabChannel(`personal-finance-db:${this.db.getDbName()}`);
    if (this.dbChannel) {
      this.dbChannel.onmessage = (data: unknown) => {
        const msg = data as { type?: string; senderId?: string } | null;
        if (!msg || msg.senderId === this.instanceId || this.destroyed) return;
        if (msg.type === 'snapshot_changed') {
          // v1.8.15: a burst of writes in another tab (e.g. a sync applying many batches) reloads once
          if (this.crossTabReloadTimer !== null) clearTimeout(this.crossTabReloadTimer);
          this.crossTabReloadTimer = setTimeout(() => {
            this.crossTabReloadTimer = null;
            // Reload may race with init/destroy; errors here must not become unhandled rejections
            void this.reloadFromIndexedDb().catch(() => undefined);
          }, CROSS_TAB_RELOAD_DEBOUNCE_MS);
        }
      };
    }

    // P2-C3: Serialize all local CRUD & meta mutators through the shared Promise-chain mutex
    // so concurrent saves never read the same stale this.snapshot and overwrite each other.
    const serializedMethods = [
      'updateLocalPinCache',
      'updateLocalBiometricCache',
      'updateLocalPasskeysCache',
      'saveLedger',
      'deleteLedger',
      'addCashFlow',
      'deleteCashFlow',
      'saveBudgetSettings',
      'saveFxSettings',
      'savePnlColorScheme',
      'saveCustomStockCategories',
      'saveRecurring',
      'reorderRecurring',
      'deleteRecurring',
      'saveSinking',
      'reorderSinking',
      'deleteSinking',
      'saveAsset',
      'updateAssetStockCategory',
      'reorderAssets',
      'reconcileLoanBalance',
      'reconcileSavingsAccount',
      'addSavingsAdjustment',
      'deleteSavingsAdjustment',
      'transferBetweenAccounts',
      'addStockTransaction',
      'deleteStockTransaction',
      'deleteAsset',
      'saveUtilityRecord',
      'deleteUtilityRecord',
      'saveUtilityRents',
    ] as const;

    const self = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const methodName of serializedMethods) {
      const orig = self[methodName].bind(this);
      self[methodName] = (...args: unknown[]) =>
        this.runSerialized(async () => {
          // P2-C6: another tab wrote the snapshot after this tab last read it. Reload and recompute the edit
          // on top of the latest data instead of overwriting it (nothing was written: the commit aborted).
          // v1.8.15: retry a few times (busy tabs), then fail with a message the user can act on.
          for (let attempt = 0; ; attempt++) {
            try {
              return await orig(...args);
            } catch (err) {
              if (!(err instanceof StaleSnapshotError)) throw err;
              if (attempt >= 2) {
                throw new Error('其他分頁正在同時修改資料，這次變更尚未儲存，請再試一次。');
              }
              await this.reloadStateUnlocked();
            }
          }
        });
    }
  }

  /**
   * P2-C3 & P2-C5: Promise-chain mutex serializing all local CRUD mutations and
   * sync-response application steps so overlapping edits never overwrite each other.
   */
  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.stateChain;
    let release!: () => void;
    this.stateChain = new Promise<void>((r) => {
      release = r;
    });
    return prev
      .catch(() => {})
      .then(fn)
      .finally(() => release());
  }

  private broadcastDbChanged(): void {
    if (this.destroyed || !this.dbChannel) return;
    try {
      this.dbChannel.postMessage({ type: 'snapshot_changed', senderId: this.instanceId });
    } catch {
      // Ignore closed channel errors
    }
  }

  async reloadFromIndexedDb(): Promise<void> {
    if (this.destroyed) return;
    await this.runSerialized(() => this.reloadStateUnlocked());
  }

  /** Reloads in-memory state from IndexedDB. Caller must already hold the runSerialized lock. */
  private async reloadStateUnlocked(): Promise<void> {
    if (this.destroyed) return;
    this.snapshot = await this.db.getSnapshot();
    this.meta = await this.db.getMeta();
    this.conflicts = await this.db.getConflicts();
    this.rejections = await this.db.getRejections();
    this.frozenOutbox = await this.db.getFrozenOutbox();
    const outbox = await this.db.getOutbox();
    this.emitSnapshot();
    this.updateStatus(this.computeStatus(outbox.length));
  }

  setExpectedUserId(userId?: string): void {
    this.expectedUserId = userId;
    this.accountMismatchHalted = false;
  }

  haltForAccountMismatch(): void {
    this.accountMismatchHalted = true;
    this.clearScheduledRetry();
  }

  /**
   * Stops the engine. v1.8.15: returns a promise that settles once already-queued local operations have finished,
   * so a caller that closes the database afterwards (account switch) never makes them fail with
   * "LocalFinanceDB is not open".
   */
  destroy(): Promise<void> {
    this.destroyed = true;
    if (this.crossTabReloadTimer !== null) {
      clearTimeout(this.crossTabReloadTimer);
      this.crossTabReloadTimer = null;
    }
    // P2-C10: stop an in-flight sync so it does not keep working against a database that is being closed
    try {
      this.activeSyncController?.abort();
    } catch {
      // ignore
    }
    this.activeSyncController = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.dbChannel) {
      try {
        this.dbChannel.close();
      } catch {
        // Ignore close errors
      }
      this.dbChannel = null;
    }
    return this.stateChain.catch(() => undefined);
  }

  /**
   * H3: stop syncing and permanently delete this account's local data (logout on a possibly shared device).
   * Waits for queued local operations first so nothing writes to the database while it is being deleted.
   */
  async wipeLocalData(): Promise<'deleted' | 'blocked'> {
    await this.destroy();
    return this.db.deleteDatabase();
  }

  async init(): Promise<void> {
    await this.db.open();
    await this.runSerialized(async () => {
      this.snapshot = await this.db.getSnapshot();
      this.meta = await this.db.getMeta();
      this.conflicts = await this.db.getConflicts();
      this.rejections = await this.db.getRejections();
      this.frozenOutbox = await this.db.getFrozenOutbox();
      const outbox = await this.db.getOutbox();
      this.updateStatus(this.computeStatus(outbox.length));
    });
  }

  getSnapshot(): FinanceSnapshot {
    return this.snapshot;
  }

  getMeta(): LocalMeta {
    return this.meta;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getConflicts(): SyncConflict[] {
    return this.conflicts.slice();
  }

  getRejections(): SyncRejection[] {
    return this.rejections.slice();
  }

  getFrozenOutbox(): SyncMutation[] {
    return this.frozenOutbox.slice();
  }

  async discardFrozenOutbox(): Promise<void> {
    await this.runSerialized(async () => {
      await this.db.saveFrozenOutbox([]);
      this.frozenOutbox = [];
      const outbox = await this.db.getOutbox();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(outbox.length));
    });
  }

  private annotateFrozenMutation(item: SyncMutation, restoredSnap: FinanceSnapshot): SyncMutation {
    const existing = this.findRecordInSnapshot(restoredSnap, item.entity, item.recordId);
    return {
      ...item,
      frozenBaselineExisted: Boolean(existing),
      frozenBaselineVersion: existing ? (existing.version ?? null) : null,
      frozenBaselineUpdatedAt: existing?.updatedAt ?? null,
    };
  }

  async reapplyFrozenOutbox(): Promise<SyncResult & { appliedCount?: number; skippedCount?: number }> {
    let appliedCount = 0;
    let skippedCount = 0;
    await this.runSerialized(async () => {
      const nowIso = new Date().toISOString();
      const txRes = await this.db.reapplyFrozenOutboxTx((freshSnap, freshFrozen, freshOutbox) => {
        const liveOutboxKeys = new Set(freshOutbox.map((m) => `${m.entity}:${m.recordId}`));
        let nextSnap = freshSnap;
        const mutationsToEnqueue: SyncMutation[] = [];
        const skippedRejections: SyncRejection[] = [];
        let applied = 0;
        let skipped = 0;
        // V3: A skipped pre-restore edit is kept as a reviewable rejection (with its payload), never silently dropped.
        const keepSkipped = (m: SyncMutation, reason: string) => {
          skipped += 1;
          skippedRejections.push({
            mutationId: m.mutationId,
            entity: m.entity,
            op: m.op,
            recordId: m.recordId,
            isNewRecord: m.op === 'upsert' && !this.findRecordInSnapshot(freshSnap, m.entity, m.recordId),
            resolutionStatus: 'skipped_newer',
            reason,
            ...(m.payload ? { clientPayload: m.payload } : {}),
            rejectedAt: nowIso,
          });
        };

        // M4: decide first, then skip a frozen transfer as a whole if any of its parts cannot be re-applied
        const decideSkip = (m: SyncMutation): string | null => {
          const key = `${m.entity}:${m.recordId}`;
          // N3: Never overwrite a record that has a newer pending edit in the live outbox
          if (liveOutboxKeys.has(key)) {
            return '此紀錄在雲端還原後已有尚未同步的較新編輯，未套用還原前的這筆編輯';
          }

          // N3: Compare against the post-restore baseline captured when this mutation was frozen.
          // If the record was created, modified, or deleted AFTER freeze (and synced), skip reapplying
          // the stale pre-restore edit so newer post-freeze changes are never clobbered.
          const currentInFresh = this.findRecordInSnapshot(freshSnap, m.entity, m.recordId);
          if (m.frozenBaselineExisted !== undefined) {
            const currentExisted = Boolean(currentInFresh);
            if (currentExisted !== m.frozenBaselineExisted) {
              return currentExisted
                  ? '此紀錄在雲端還原後已被重新建立，未套用還原前的這筆編輯'
                  : '此紀錄在雲端還原後已被刪除，未套用還原前的這筆編輯';
            }
            if (currentExisted) {
              const currentVersion = currentInFresh?.version ?? null;
              const currentUpdatedAt = currentInFresh?.updatedAt ?? null;
              if (
                (m.frozenBaselineVersion !== undefined && currentVersion !== m.frozenBaselineVersion) ||
                (m.frozenBaselineUpdatedAt !== undefined && currentUpdatedAt !== m.frozenBaselineUpdatedAt)
              ) {
                return '此紀錄在雲端還原後已有較新的版本，未套用還原前的這筆編輯';
              }
            }
          } else if (
            // R-6: Items frozen by v1.8.6 or earlier carry no baseline. Fall back to timestamps: if the current
            // record was updated after this edit was made, the edit is older and must not overwrite it.
            currentInFresh?.updatedAt &&
            m.clientTimestamp &&
            currentInFresh.updatedAt > m.clientTimestamp
          ) {
            // Restored rows get a fresh updated_at, so this conservatively skips most legacy items; the edit is
            // kept in the list (with its payload) for the user to review and re-enter if still wanted.
            return '此筆為舊版本凍結的編輯，無法判斷雲端還原後是否已有較新版本，為避免覆蓋已暫不套用；如仍需要請參考內容手動重新輸入';
          }

          return null;
        };
        const skipReasons = new Map<string, string>();
        for (const m of freshFrozen) {
          const reason = decideSkip(m);
          if (reason) skipReasons.set(m.mutationId, reason);
        }
        const skippedGroups = new Set(
          freshFrozen.filter((m) => m.atomicGroupId && skipReasons.has(m.mutationId)).map((m) => m.atomicGroupId!)
        );
        for (const m of freshFrozen) {
          if (m.atomicGroupId && skippedGroups.has(m.atomicGroupId) && !skipReasons.has(m.mutationId)) {
            skipReasons.set(m.mutationId, '同一筆轉帳的另一部分無法重新套用，為避免只成立一邊，整筆轉帳一併略過');
          }
        }

        for (const m of freshFrozen) {
          const skipReason = skipReasons.get(m.mutationId);
          if (skipReason) {
            keepSkipped(m, skipReason);
            continue;
          }
          const existingInNext = this.findRecordInSnapshot(nextSnap, m.entity, m.recordId);
          const freshMut: SyncMutation = {
            mutationId: crypto.randomUUID(),
            entity: m.entity,
            op: m.op,
            recordId: m.recordId,
            clientTimestamp: nowIso,
            baseVersion: existingInNext?.version ?? null,
            isNewRecord: m.op === 'upsert' && !existingInNext,
            ...(m.payload ? { payload: { ...m.payload, updatedAt: nowIso } } : {}),
            ...(m.atomicGroupId ? { atomicGroupId: m.atomicGroupId } : {}),
          };
          if (freshMut.op === 'delete') {
            nextSnap = this.removeRecordFromSnapshot(nextSnap, freshMut.entity, freshMut.recordId);
          } else if (freshMut.payload) {
            nextSnap = this.applyRecordToSnapshot(
              nextSnap,
              freshMut.entity,
              freshMut.recordId,
              freshMut.payload,
              false
            );
          }
          mutationsToEnqueue.push(freshMut);
          applied += 1;
        }

        return {
          nextSnapshot: nextSnap,
          mutationsToEnqueue,
          appliedCount: applied,
          skippedCount: skipped,
          skippedRejections,
        };
      }, this.inFlightMutationIds);

      appliedCount = txRes.appliedCount;
      skippedCount = txRes.skippedCount;
      this.snapshot = txRes.snapshot;
      if (txRes.rejections) {
        this.rejections = txRes.rejections;
      }
      this.frozenOutbox = [];
      this.emitSnapshot();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(txRes.remainingOutboxCount));
    });

    if (appliedCount > 0 && this.isOnline()) {
      const syncRes = await this.syncNow();
      return { ...syncRes, appliedCount, skippedCount };
    }
    return { ok: true, appliedCount, skippedCount };
  }

  private findRecordInSnapshot(
    snap: FinanceSnapshot,
    entity: string,
    recordId: string
  ): { version?: number; updatedAt?: string } | null {
    switch (entity) {
      case 'settings':
        return snap.settings
          ? { version: snap.settings.version, updatedAt: snap.settings.updatedAt }
          : null;
      case 'utility_rents':
        return snap.rentUtilityRents
          ? { version: snap.rentUtilityRents.version, updatedAt: snap.rentUtilityRents.updatedAt }
          : null;
      case 'ledger':
        return (snap.ledgers || []).find((l) => l.id === recordId) || null;
      case 'cashflow':
        return snap.cashflowLogs.find((c) => c.id === recordId) || null;
      case 'recurring':
        return snap.recurringItems.find((r) => r.id === recordId) || null;
      case 'sinking':
        return snap.sinkingItems.find((s) => s.id === recordId) || null;
      case 'asset':
        return snap.assetItems.find((a) => a.id === recordId) || null;
      case 'savings_adjustment':
        return (snap.savingsAdjustments || []).find((a) => a.id === recordId) || null;
      case 'stock_tx':
        return (snap.stockTransactions || []).find((t) => t.id === recordId) || null;
      case 'utility_record':
        return (snap.rentUtilityRecords || []).find((u) => u.period === recordId) || null;
      default:
        return null;
    }
  }

  async dismissRejection(mutationId: string): Promise<void> {
    await this.runSerialized(async () => {
      const nextRejections = this.rejections.filter((r) => r.mutationId !== mutationId);
      await this.db.saveRejections(nextRejections);
      this.rejections = nextRejections;
      const outbox = await this.db.getOutbox();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(outbox.length));
    });
  }

  async clearRejections(): Promise<void> {
    await this.runSerialized(async () => {
      const nextRejections: SyncRejection[] = [];
      await this.db.saveRejections(nextRejections);
      this.rejections = nextRejections;
      const outbox = await this.db.getOutbox();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(outbox.length));
    });
  }

  /** v1.8.15: the single-item success streak always restarts when isolation mode is entered or left */
  private setPoisonSearch(active: boolean): void {
    if (this.poisonSearchActive !== active) this.singleItemSuccessStreak = 0;
    this.poisonSearchActive = active;
  }

  private computeStatus(pendingCount: number, lastError?: string): SyncStatus {
    const conflictCount = this.conflicts.length;
    const rejectedCount = this.rejections.length;
    const frozenOutboxCount = this.frozenOutbox.length;
    // v1.8.15: only items that need a decision (conflicts, frozen edits) take over the state; rejections are
    // reported through rejectedCount and no longer hide "offline" / "pending"
    const state: SyncStateKind =
      conflictCount > 0 || frozenOutboxCount > 0
        ? 'conflict'
        : !this.isOnline()
          ? 'offline'
          : pendingCount > 0
            ? 'pending'
            : 'synced';
    return {
      state,
      pendingCount,
      conflictCount,
      rejectedCount,
      frozenOutboxCount,
      lastSyncedAt: this.meta.lastSyncedAt,
      ...(lastError ? { lastError } : {}),
    };
  }

  async updateLocalPinCache(pinEnabled: boolean, pinSalt: string | null, pinHash: string | null): Promise<void> {
    await this.applyAuthMetaPatch({ pinEnabled, pinSalt, pinHash });
  }

  /** P2-C6: patch only the lock-screen fields in the stored meta and tell other tabs to reload. */
  private async applyAuthMetaPatch(patch: Partial<LocalMeta>): Promise<void> {
    // v1.8.15: when no meta is stored yet, patchAuthMeta creates it (from this.meta) in the same transaction
    const merged = await this.db.patchAuthMeta(patch, this.meta);
    if (merged) {
      // M9: take every lock-screen field from the stored meta (another tab may have changed the ones not patched)
      this.meta = {
        ...this.meta,
        pinEnabled: merged.pinEnabled,
        pinSalt: merged.pinSalt,
        pinHash: merged.pinHash,
        biometricLockEnabled: merged.biometricLockEnabled,
        passkeys: merged.passkeys,
        ...patch,
      };
    } else {
      // No stored meta yet (first run): write the full meta once
      const nextMeta: LocalMeta = { ...this.meta, ...patch };
      await this.db.saveMeta(nextMeta);
      this.meta = nextMeta;
    }
    this.broadcastDbChanged();
  }

  /**
   * M9: refresh only the cached passkey list (login / startup). The Face ID lock toggle is a per-device choice that
   * may have been changed in another tab, so it is never written from a possibly stale in-memory copy.
   */
  async updateLocalPasskeysCache(passkeys: LocalMeta['passkeys']): Promise<void> {
    await this.applyAuthMetaPatch({ passkeys: passkeys || [] });
  }

  async updateLocalBiometricCache(
    biometricLockEnabled: boolean,
    passkeys?: LocalMeta['passkeys']
  ): Promise<void> {
    await this.applyAuthMetaPatch({
      biometricLockEnabled,
      ...(passkeys !== undefined ? { passkeys } : {}),
    });
  }

  private updateStatus(next: SyncStatus): void {
    this.status = next;
    this.opts.onStatusChange?.(next);
  }

  private emitSnapshot(): void {
    this.opts.onSnapshotChange?.(this.snapshot);
  }

  private sortCashFlows(logs: CashFlowLog[]): CashFlowLog[] {
    return logs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  /* ==================== Local Optimistic CRUD (0ms) ==================== */

  async saveLedger(payload: LedgerInputPayload & { id?: string }): Promise<Ledger> {
    const v = validateLedgerInput(payload);
    const nowIso = new Date().toISOString();
    const id = payload.id ? normalizeLedgerId(payload.id) : crypto.randomUUID();
    const currentLedgers = ensureActiveLedgers(this.snapshot.ledgers);
    const existing = currentLedgers.find((l) => l.id === id);
    const includeInNetWorth = id === DEFAULT_LEDGER_ID ? true : v.includeInNetWorth;
    const sortOrder =
      payload.sortOrder !== undefined
        ? v.sortOrder
        : existing
          ? existing.sortOrder ?? 0
          : this.nextSortOrderFor(currentLedgers);

    const ledger: Ledger = {
      id,
      name: v.name,
      includeInNetWorth,
      monthlyDailyBudget: v.monthlyDailyBudget,
      note: v.note,
      sortOrder,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      ...(existing?.version !== undefined ? { version: existing.version } : {}),
    };

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      ledgers: mergeById(currentLedgers, [ledger]).sort(compareBySortOrder),
    };

    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'ledger',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
        isNewRecord: !existing,
        payload: { ...ledger },
      },
    ]);
    return ledger;
  }

  async deleteLedger(
    id: string,
    opts?: { migrateToLedgerId?: string }
  ): Promise<{ migratedCount: number }> {
    const lid = normalizeLedgerId(id);
    if (lid === DEFAULT_LEDGER_ID) {
      throw new Error('不可刪除預設個人主帳本。');
    }
    const nowIso = new Date().toISOString();
    const currentLedgers = ensureActiveLedgers(this.snapshot.ledgers);
    const existing = currentLedgers.find((l) => l.id === lid);
    if (!existing) return { migratedCount: 0 };

    const matchingLogs = this.snapshot.cashflowLogs.filter(
      (l) => !l.deletedAt && getEffectiveLedgerId(l) === lid
    );
    const matchingAssets = this.snapshot.assetItems.filter(
      (a) => !a.deletedAt && getEffectiveLedgerId(a) === lid
    );
    const matchingRecurring = this.snapshot.recurringItems.filter(
      (r) => !r.deletedAt && getEffectiveLedgerId(r) === lid
    );
    const totalLinked = matchingLogs.length + matchingAssets.length + matchingRecurring.length;

    const mutations: SyncMutation[] = [];
    let nextLogs = this.snapshot.cashflowLogs;
    let nextAssets = this.snapshot.assetItems;
    let nextRecurring = this.snapshot.recurringItems;

    if (totalLinked > 0) {
      if (!opts?.migrateToLedgerId) {
        throw new Error(
          `此帳本仍有 ${totalLinked} 筆關聯紀錄（${matchingAssets.length} 資產、${matchingLogs.length} 流水帳、${matchingRecurring.length} 固定收支），請先轉移或清除後再刪除。`
        );
      }
      const targetLedgerId = normalizeLedgerId(opts.migrateToLedgerId);
      if (targetLedgerId === lid) {
        throw new Error('轉移目標帳本不可為即將刪除的帳本。');
      }

      nextLogs = this.snapshot.cashflowLogs.map((l) => {
        if (!l.deletedAt && getEffectiveLedgerId(l) === lid) {
          const updated: CashFlowLog = { ...l, ledgerId: targetLedgerId, updatedAt: nowIso };
          mutations.push({
            mutationId: crypto.randomUUID(),
            entity: 'cashflow',
            op: 'upsert',
            recordId: updated.id,
            clientTimestamp: nowIso,
            baseVersion: l.version ?? null,
            isNewRecord: false,
            payload: { ...updated },
          });
          return updated;
        }
        return l;
      });

      nextAssets = this.snapshot.assetItems.map((a) => {
        if (!a.deletedAt && getEffectiveLedgerId(a) === lid) {
          const updated: AssetItem = {
            ...a,
            ledgerId: targetLedgerId,
            isDefaultSavings: false,
            updatedAt: nowIso,
          };
          mutations.push({
            mutationId: crypto.randomUUID(),
            entity: 'asset',
            op: 'upsert',
            recordId: updated.id,
            clientTimestamp: nowIso,
            baseVersion: a.version ?? null,
            isNewRecord: false,
            payload: { ...updated },
          });
          return updated;
        }
        return a;
      });

      nextRecurring = this.snapshot.recurringItems.map((r) => {
        if (!r.deletedAt && getEffectiveLedgerId(r) === lid) {
          const updated: RecurringItem = { ...r, ledgerId: targetLedgerId, updatedAt: nowIso };
          mutations.push({
            mutationId: crypto.randomUUID(),
            entity: 'recurring',
            op: 'upsert',
            recordId: updated.id,
            clientTimestamp: nowIso,
            baseVersion: r.version ?? null,
            isNewRecord: false,
            payload: { ...updated },
          });
          return updated;
        }
        return r;
      });
    }

    mutations.push({
      mutationId: crypto.randomUUID(),
      entity: 'ledger',
      op: 'delete',
      recordId: lid,
      clientTimestamp: nowIso,
      baseVersion: existing.version ?? null,
      isNewRecord: false,
    });

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      ledgers: currentLedgers.filter((l) => l.id !== lid),
      cashflowLogs: nextLogs,
      assetItems: nextAssets,
      recurringItems: nextRecurring,
    };

    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return { migratedCount: totalLinked };
  }

  async addCashFlow(payload: CashFlowInputPayload): Promise<CashFlowLog> {
    const validated = validateCashFlowInput(payload, this.snapshot.settings.usdTwdRate);
    const nowIso = new Date().toISOString();
    const id = crypto.randomUUID();
    const record: CashFlowLog = {
      id,
      ...validated,
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    };

    const mutations: SyncMutation[] = [
      {
        mutationId: crypto.randomUUID(),
        entity: 'cashflow',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...record },
      },
    ];

    let nextRecurring = this.snapshot.recurringItems;
    if (payload.makeRecurring && RECURRING_CASHFLOW_TYPES.includes(record.type)) {
      const recId = crypto.randomUUID();
      const recItem: RecurringItem = {
        id: recId,
        itemName: record.itemName,
        category: record.category,
        type: record.type,
        amount: record.amount,
        currency: record.currency,
        cycle: '月繳',
        billingSpec: '',
        status: '啟用',
        note: record.note ? `[手機加入每月常態] ${record.note}` : '手機記帳加入每月常態',
        linkedAccountId: record.linkedAccountId,
        ledgerId: record.ledgerId,
        sortOrder: this.nextSortOrderFor(nextRecurring),
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      nextRecurring = [...nextRecurring, recItem].sort(compareBySortOrder);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId: recId,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...recItem },
      });
    }

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      cashflowLogs: this.sortCashFlows([record, ...this.snapshot.cashflowLogs]),
      recurringItems: nextRecurring,
    };

    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return record;
  }

  private nextSortOrderFor<T extends { sortOrder?: number; deletedAt?: string | null }>(items: T[]): number {
    const active = items.filter((i) => !i.deletedAt);
    if (!active.length) return 1;
    const maxOrder = active.reduce((max, i) => Math.max(max, i.sortOrder ?? 0), 0);
    return maxOrder > 0 ? maxOrder + 1 : active.length + 1;
  }

  async deleteCashFlow(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.cashflowLogs.find((l) => l.id === id);
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      cashflowLogs: this.snapshot.cashflowLogs.filter((l) => l.id !== id),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'cashflow',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
      },
    ]);
  }

  async saveBudgetSettings(monthlyDailyBudget: number, emergencyTargetMonths: number): Promise<void> {
    const budget = Math.round(Number(monthlyDailyBudget));
    const months = Math.round(Number(emergencyTargetMonths));
    if (Number.isNaN(budget) || budget < 0) throw new Error('請輸入有效的每月預算上限。');
    if (Number.isNaN(months) || months < 1 || months > 60) {
      throw new Error('緊急預備金目標月數需介於 1～60 個月。');
    }
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.settings.version;
    const nextSettings: AppSettings = {
      ...this.snapshot.settings,
      monthlyDailyBudget: budget,
      emergencyTargetMonths: months,
      updatedAt: nowIso,
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      settings: nextSettings,
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'settings',
        op: 'upsert',
        recordId: '1',
        clientTimestamp: nowIso,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...nextSettings },
      },
    ]);
  }

  async saveFxSettings(usdTwdRate: number, autoFxEnabled: boolean): Promise<void> {
    const rate = Number(usdTwdRate);
    if (!Number.isFinite(rate) || rate <= 10 || rate >= 100) {
      throw new Error('請輸入有效的 USD/TWD 匯率（介於 10～100）。');
    }
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.settings.version;
    const nextSettings: AppSettings = {
      ...this.snapshot.settings,
      usdTwdRate: Math.round(rate * 1000) / 1000,
      autoFxEnabled: Boolean(autoFxEnabled),
      updatedAt: nowIso,
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      settings: nextSettings,
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'settings',
        op: 'upsert',
        recordId: '1',
        clientTimestamp: nowIso,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...nextSettings },
      },
    ]);
  }

  async savePnlColorScheme(scheme: PnlColorScheme): Promise<PnlColorScheme> {
    const normalized = normalizePnlColorScheme(scheme);
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.settings.version;
    const nextSettings: AppSettings = {
      ...this.snapshot.settings,
      pnlColorScheme: normalized,
      updatedAt: nowIso,
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      settings: nextSettings,
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'settings',
        op: 'upsert',
        recordId: '1',
        clientTimestamp: nowIso,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...nextSettings },
      },
    ]);
    return normalized;
  }

  async saveCustomStockCategories(categories: string[]): Promise<string[]> {
    const normalized = normalizeCustomStockCategories(categories);
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.settings.version;
    const nextSettings: AppSettings = {
      ...this.snapshot.settings,
      customStockCategories: normalized,
      updatedAt: nowIso,
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      settings: nextSettings,
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'settings',
        op: 'upsert',
        recordId: '1',
        clientTimestamp: nowIso,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...nextSettings },
      },
    ]);
    return normalized;
  }

  async saveRecurring(payload: RecurringInputPayload & { id?: string }): Promise<RecurringItem> {
    const v = validateRecurringInput(payload);
    const nowIso = new Date().toISOString();
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.recurringItems.find((r) => r.id === id);
    const sortOrder =
      payload.sortOrder !== undefined
        ? v.sortOrder
        : existing
          ? existing.sortOrder ?? 0
          : this.nextSortOrderFor(this.snapshot.recurringItems);
    const item: RecurringItem = {
      id,
      ...v,
      sortOrder,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      ...(existing?.version !== undefined ? { version: existing.version } : {}),
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      recurringItems: mergeById(this.snapshot.recurringItems, [item]).sort(compareBySortOrder),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
        isNewRecord: !existing,
        payload: { ...item },
      },
    ]);
    return item;
  }

  async reorderRecurring(orderedSubsetIds: string[]): Promise<number> {
    const { nextItems, changedItems } = applySubsetReorder(
      this.snapshot.recurringItems,
      orderedSubsetIds
    );
    if (!changedItems.length) return 0;
    const nowIso = new Date().toISOString();
    const changedIdSet = new Set(changedItems.map((i) => i.id));
    const stampedItems = nextItems.map((item) =>
      changedIdSet.has(item.id) ? { ...item, updatedAt: nowIso } : item
    );
    const mutations: SyncMutation[] = stampedItems
      .filter((item) => changedIdSet.has(item.id))
      .map((item) => ({
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId: item.id,
        clientTimestamp: nowIso,
        baseVersion: item.version ?? null,
        isNewRecord: false,
        payload: { ...item },
      }));
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      recurringItems: stampedItems,
    };
    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return mutations.length;
  }

  async deleteRecurring(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.recurringItems.find((r) => r.id === id);
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      recurringItems: this.snapshot.recurringItems.filter((r) => r.id !== id),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
      },
    ]);
  }

  async saveSinking(payload: SinkingInputPayload & { id?: string }): Promise<SinkingFundItem> {
    const v = validateSinkingInput(payload);
    const nowIso = new Date().toISOString();
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.sinkingItems.find((s) => s.id === id);
    const sortOrder =
      payload.sortOrder !== undefined
        ? v.sortOrder
        : existing
          ? existing.sortOrder ?? 0
          : this.nextSortOrderFor(this.snapshot.sinkingItems);
    const item: SinkingFundItem = {
      id,
      ...v,
      sortOrder,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      ...(existing?.version !== undefined ? { version: existing.version } : {}),
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      sinkingItems: mergeById(this.snapshot.sinkingItems, [item]).sort(compareBySortOrder),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
        isNewRecord: !existing,
        payload: { ...item },
      },
    ]);
    return item;
  }

  async reorderSinking(orderedSubsetIds: string[]): Promise<number> {
    const { nextItems, changedItems } = applySubsetReorder(
      this.snapshot.sinkingItems,
      orderedSubsetIds
    );
    if (!changedItems.length) return 0;
    const nowIso = new Date().toISOString();
    const changedIdSet = new Set(changedItems.map((i) => i.id));
    const stampedItems = nextItems.map((item) =>
      changedIdSet.has(item.id) ? { ...item, updatedAt: nowIso } : item
    );
    const mutations: SyncMutation[] = stampedItems
      .filter((item) => changedIdSet.has(item.id))
      .map((item) => ({
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'upsert',
        recordId: item.id,
        clientTimestamp: nowIso,
        baseVersion: item.version ?? null,
        isNewRecord: false,
        payload: { ...item },
      }));
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      sinkingItems: stampedItems,
    };
    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return mutations.length;
  }

  async deleteSinking(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.sinkingItems.find((s) => s.id === id);
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      sinkingItems: this.snapshot.sinkingItems.filter((s) => s.id !== id),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
      },
    ]);
  }

  async saveAsset(payload: AssetInputPayload & { id?: string }): Promise<AssetItem> {
    return this.saveAssetInner(payload);
  }

  private async saveAssetInner(payload: AssetInputPayload & { id?: string }): Promise<AssetItem> {
    const v = validateAssetInput(payload);
    const nowIso = new Date().toISOString();
    const todayYmd = todayInTimeZone(); // review (v1.8.15): APP_TIMEZONE date, not UTC
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.assetItems.find((a) => a.id === id);

    // If this is the first linked savings account in this ledger, auto-promote as default for this ledger
    const targetLedgerId = v.ledgerId;
    const otherSavings = this.snapshot.assetItems.filter(
      (a) =>
        !a.deletedAt &&
        a.isLinkedSavings &&
        a.id !== id &&
        getEffectiveLedgerId(a) === targetLedgerId
    );
    const isDefaultSavings = v.isLinkedSavings
      ? v.isDefaultSavings || otherSavings.length === 0
      : false;

    const balanceAnchorDate =
      v.isLinkedSavings || v.isAmortizingLoan
        ? v.balanceAnchorDate ?? existing?.balanceAnchorDate ?? todayYmd
        : v.balanceAnchorDate ?? null;
    const balanceAnchorAt = v.isLinkedSavings
      ? v.balanceAnchorAt ?? existing?.balanceAnchorAt ?? nowIso
      : null;
    const sortOrder =
      payload.sortOrder !== undefined
        ? v.sortOrder
        : existing
          ? existing.sortOrder ?? 0
          : this.nextSortOrderFor(this.snapshot.assetItems);

    const tickerChanged = Boolean(
      existing && (existing.ticker || '').trim().toUpperCase() !== v.ticker.trim().toUpperCase()
    );
    // Q8 / F5: Only replacing the ticker with ANOTHER NON-EMPTY ticker on an auto-updated asset invalidates the old
    // quote. Clearing the ticker (the holding simply stops auto-updating) must keep the existing price.
    const tickerReplaced = tickerChanged && v.updateMode === '自動更新' && v.ticker.trim() !== '';
    const isPendingQuoteAsset = v.updateMode === '自動更新' && v.ticker.trim() !== '';
    const resolvedUnitPrice =
      payload.unitPrice !== undefined
        ? v.unitPrice
        : tickerReplaced
          ? 0
          : existing?.unitPrice ?? (v.isWatchlist || isPendingQuoteAsset ? 0 : 1);
    const priceChangedLocally =
      Boolean(existing) && payload.unitPrice !== undefined && resolvedUnitPrice !== existing!.unitPrice;
    const resolvedPreviousClose =
      payload.previousClose !== undefined
        ? v.previousClose
        : tickerReplaced
          ? null
          : priceChangedLocally
            ? null
            : existing?.previousClose ?? null;
    const resolvedPriceUpdatedAt = tickerReplaced ? null : (existing?.priceUpdatedAt ?? null);

    const item: AssetItem = {
      id,
      ...v,
      unitPrice: resolvedUnitPrice,
      previousClose: resolvedPreviousClose,
      costBasis:
        v.isWatchlist
          ? null
          : payload.costBasis !== undefined
            ? v.costBasis
            : existing?.costBasis ?? null,
      stockCategory:
        payload.stockCategory !== undefined ? v.stockCategory : existing?.stockCategory ?? '',
      isWatchlist: v.isWatchlist,
      ledgerId: targetLedgerId,
      excludeFromNetWorth:
        payload.excludeFromNetWorth !== undefined
          ? v.excludeFromNetWorth
          : existing?.excludeFromNetWorth ?? false,
      priceUpdatedAt: resolvedPriceUpdatedAt,
      balanceAnchorDate,
      balanceAnchorAt,
      isDefaultSavings,
      sortOrder,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      ...(existing?.version !== undefined ? { version: existing.version } : {}),
    };

    const updatedAssets = this.snapshot.assetItems.map((a) =>
      isDefaultSavings &&
      a.id !== id &&
      a.isDefaultSavings &&
      getEffectiveLedgerId(a) === targetLedgerId
        ? { ...a, isDefaultSavings: false, updatedAt: nowIso }
        : a
    );
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      assetItems: mergeById(updatedAssets, [item]).sort(compareBySortOrder),
    };

    const mutationPayload: Record<string, unknown> = { ...item };
    if (existing && v.updateMode === '自動更新' && !tickerReplaced) {
      // F4: Even when manualPriceOverride is true (e.g. editing ONLY previousClose),
      // omit unitPrice when caller did not explicitly provide it so server live quote is never clobbered.
      if (payload.unitPrice === undefined) {
        delete mutationPayload.unitPrice;
      }
      if (payload.previousClose === undefined && !priceChangedLocally) {
        delete mutationPayload.previousClose;
      }
    }
    if (payload.manualPriceOverride) {
      mutationPayload.manualPriceOverride = true;
    }

    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
        isNewRecord: !existing,
        payload: mutationPayload,
      },
    ]);
    return item;
  }

  async updateAssetStockCategory(assetId: string, stockCategory: string): Promise<AssetItem> {
    const existing = this.snapshot.assetItems.find((a) => a.id === assetId && !a.deletedAt);
    if (!existing) throw new Error('找不到該持股項目。');
    const normalized = normalizeStockCategory(stockCategory);
    if ((existing.stockCategory || '') === normalized) {
      return existing;
    }
    const nowIso = new Date().toISOString();
    const updated: AssetItem = {
      ...existing,
      stockCategory: normalized,
      updatedAt: nowIso,
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      assetItems: mergeById(this.snapshot.assetItems, [updated]).sort(compareBySortOrder),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: assetId,
        clientTimestamp: nowIso,
        baseVersion: existing.version ?? null,
        isNewRecord: false,
        payload: { ...updated },
      },
    ]);
    return updated;
  }

  async reorderAssets(orderedSubsetIds: string[]): Promise<number> {
    const { nextItems, changedItems } = applySubsetReorder(
      this.snapshot.assetItems,
      orderedSubsetIds
    );
    if (!changedItems.length) return 0;
    const nowIso = new Date().toISOString();
    const changedIdSet = new Set(changedItems.map((i) => i.id));
    const stampedItems = nextItems.map((item) =>
      changedIdSet.has(item.id) ? { ...item, updatedAt: nowIso } : item
    );
    const mutations: SyncMutation[] = stampedItems
      .filter((item) => changedIdSet.has(item.id))
      .map((item) => ({
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: item.id,
        clientTimestamp: nowIso,
        baseVersion: item.version ?? null,
        isNewRecord: false,
        payload: { ...item },
      }));
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      assetItems: stampedItems,
    };
    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return mutations.length;
  }

  async reconcileLoanBalance(
    assetId: string,
    actualBalance: number,
    anchorDate?: string,
    opts?: {
      annualRate?: number;
      monthlyPayment?: number;
      billingDay?: number;
      disableAutoAmortize?: boolean;
    }
  ): Promise<AssetItem> {
    const existing = this.snapshot.assetItems.find((a) => a.id === assetId && !a.deletedAt);
    if (!existing) throw new Error('找不到指定的負債項目。');
    const ymd =
      anchorDate ||
      todayInTimeZone();
    const keepAuto = opts?.disableAutoAmortize ? false : Boolean(existing.isAmortizingLoan);
    return this.saveAssetInner({
      ...existing,
      id: existing.id,
      quantityOrAmount: actualBalance,
      balanceAnchorDate: ymd,
      isAmortizingLoan: keepAuto,
      loanAnnualRate: opts?.annualRate !== undefined ? opts.annualRate : existing.loanAnnualRate,
      loanMonthlyPayment:
        opts?.monthlyPayment !== undefined ? opts.monthlyPayment : existing.loanMonthlyPayment,
      loanBillingDay: opts?.billingDay !== undefined ? opts.billingDay : existing.loanBillingDay,
    });
  }

  async reconcileSavingsAccount(accountId: string, actualBalance: number, anchorDate?: string): Promise<AssetItem> {
    const existing = this.snapshot.assetItems.find((a) => a.id === accountId && !a.deletedAt);
    if (!existing) throw new Error('找不到指定的活存帳戶。');
    const nowIso = new Date().toISOString();
    const ymd = anchorDate || todayInTimeZone();
    return this.saveAssetInner({
      ...existing,
      id: existing.id,
      quantityOrAmount: actualBalance,
      isLinkedSavings: true,
      balanceAnchorDate: ymd,
      balanceAnchorAt: nowIso,
    });
  }

  async addSavingsAdjustment(payload: SavingsAdjustmentInputPayload): Promise<SavingsAdjustment> {
    const account = this.snapshot.assetItems.find((a) => a.id === payload.accountId && !a.deletedAt);
    const currency = payload.currency || account?.currency || 'TWD';
    const v = validateSavingsAdjustmentInput(
      { ...payload, currency },
      this.snapshot.settings.usdTwdRate
    );
    const nowIso = new Date().toISOString();
    const id = crypto.randomUUID();
    const adj: SavingsAdjustment = {
      id,
      ...v,
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      savingsAdjustments: [adj, ...this.snapshot.savingsAdjustments].sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      ),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'savings_adjustment',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...adj, currency },
      },
    ]);
    return adj;
  }

  async deleteSavingsAdjustment(id: string, deletePairedTransfer = false): Promise<{ deletedCount: number }> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.savingsAdjustments.find((a) => a.id === id);
    const targets: SavingsAdjustment[] = existing ? [existing] : [];

    if (deletePairedTransfer && existing?.transferGroupId) {
      const siblings = this.snapshot.savingsAdjustments.filter(
        (a) => !a.deletedAt && a.id !== existing.id && a.transferGroupId === existing.transferGroupId
      );
      targets.push(...siblings);
    }

    const deleteIds = new Set(targets.map((t) => t.id));
    if (deleteIds.size === 0) deleteIds.add(id);

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      savingsAdjustments: this.snapshot.savingsAdjustments.filter((a) => !deleteIds.has(a.id)),
    };

    const mutationsShareTransfer = deletePairedTransfer && targets.length > 1;
    const mutations: SyncMutation[] = (targets.length > 0 ? targets : [{ id, version: undefined }]).map(
      (t) => ({
        mutationId: crypto.randomUUID(),
        entity: 'savings_adjustment',
        op: 'delete',
        recordId: t.id,
        clientTimestamp: nowIso,
        baseVersion: t.version ?? null,
        isNewRecord: false,
        // M4: deleting both sides of a transfer is all-or-nothing
        ...(mutationsShareTransfer && existing?.transferGroupId ? { atomicGroupId: existing.transferGroupId } : {}),
      })
    );
    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return { deletedCount: mutations.length };
  }

  async transferBetweenAccounts(payload: AccountTransferInputPayload): Promise<{
    transferGroupId: string;
    fromAdjustment: SavingsAdjustment | null;
    toAdjustment: SavingsAdjustment | null;
    feeCashflow: CashFlowLog | null;
    fromAmount: number;
    toAmount: number;
    fee: number;
  }> {
    const v = validateAccountTransferInput(payload);
    const fromAcc = this.snapshot.assetItems.find((a) => a.id === v.fromAccountId && !a.deletedAt);
    const toAcc = this.snapshot.assetItems.find((a) => a.id === v.toAccountId && !a.deletedAt);
    if (!fromAcc || !toAcc) {
      throw new Error('找不到指定的轉出或轉入帳戶。');
    }
    if (!isTransferableAccount(fromAcc) || !isTransferableAccount(toAcc)) {
      throw new Error('僅支援活存與定存／現金等帳戶間轉帳（股票請使用持股頁買賣功能）。');
    }

    const rate = this.snapshot.settings.usdTwdRate || 32.5;
    let toAmount: number;
    if (fromAcc.currency === toAcc.currency) {
      toAmount = v.amount;
    } else if (v.targetAmount !== null) {
      toAmount = v.targetAmount;
    } else if (fromAcc.currency === 'TWD' && toAcc.currency === 'USD') {
      toAmount = Math.round((v.amount / rate) * 100) / 100;
    } else {
      toAmount = Math.round(v.amount * rate);
    }

    if (!fromAcc.isLinkedSavings) {
      const nextFromQty = Math.round((fromAcc.quantityOrAmount - v.amount - v.fee) * 100) / 100;
      if (nextFromQty < 0) {
        throw new Error(
          `轉出金額與手續費合計超過「${fromAcc.itemName}」目前餘額（${fromAcc.quantityOrAmount.toLocaleString('zh-TW')} ${fromAcc.currency}）。`
        );
      }
    }

    const nowIso = new Date().toISOString();
    const transferGroupId = crypto.randomUUID();
    const mutations: SyncMutation[] = [];
    const newAdjustments: SavingsAdjustment[] = [];
    const updatedAssets: AssetItem[] = [];
    let fromAdjustment: SavingsAdjustment | null = null;
    let toAdjustment: SavingsAdjustment | null = null;
    let feeCashflow: CashFlowLog | null = null;

    // 1. Deduct from source account (A)
    if (fromAcc.isLinkedSavings) {
      const adjId = crypto.randomUUID();
      const validatedAdj = validateSavingsAdjustmentInput(
        {
          accountId: fromAcc.id,
          date: v.date,
          amount: -v.amount,
          currency: fromAcc.currency,
          note: `轉帳至 ${toAcc.itemName}${v.note ? ' · ' + v.note : ''}`,
          transferGroupId,
        },
        rate
      );
      fromAdjustment = {
        id: adjId,
        ...validatedAdj,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      newAdjustments.push(fromAdjustment);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'savings_adjustment',
        op: 'upsert',
        recordId: adjId,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...fromAdjustment, currency: fromAcc.currency },
      });
    } else {
      const nextFromQty = Math.round((fromAcc.quantityOrAmount - v.amount - v.fee) * 100) / 100;
      const updatedFrom: AssetItem = {
        ...fromAcc,
        quantityOrAmount: nextFromQty,
        updatedAt: nowIso,
      };
      updatedAssets.push(updatedFrom);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: updatedFrom.id,
        clientTimestamp: nowIso,
        baseVersion: fromAcc.version ?? null,
        isNewRecord: false,
        payload: { ...updatedFrom },
      });
    }

    // 2. Credit to target account (B)
    if (toAcc.isLinkedSavings) {
      const adjId = crypto.randomUUID();
      const validatedAdj = validateSavingsAdjustmentInput(
        {
          accountId: toAcc.id,
          date: v.date,
          amount: toAmount,
          currency: toAcc.currency,
          note: `轉帳自 ${fromAcc.itemName}${v.note ? ' · ' + v.note : ''}`,
          transferGroupId,
        },
        rate
      );
      toAdjustment = {
        id: adjId,
        ...validatedAdj,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      newAdjustments.push(toAdjustment);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'savings_adjustment',
        op: 'upsert',
        recordId: adjId,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...toAdjustment, currency: toAcc.currency },
      });
    } else {
      const nextToQty = Math.round((toAcc.quantityOrAmount + toAmount) * 100) / 100;
      const updatedTo: AssetItem = {
        ...toAcc,
        quantityOrAmount: nextToQty,
        updatedAt: nowIso,
      };
      updatedAssets.push(updatedTo);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: updatedTo.id,
        clientTimestamp: nowIso,
        baseVersion: toAcc.version ?? null,
        isNewRecord: false,
        payload: { ...updatedTo },
      });
    }

    // 3. Optional transfer fee (recorded in source account's ledger; linked to source savings if applicable)
    if (v.fee > 0) {
      const cfId = crypto.randomUUID();
      const validatedCf = validateCashFlowInput(
        {
          date: v.date,
          type: CASHFLOW_TYPES.DAILY_EXPENSE,
          category: '其他',
          itemName: `轉帳手續費 (${fromAcc.itemName} → ${toAcc.itemName})`,
          amount: v.fee,
          currency: fromAcc.currency,
          source: '手機記帳',
          note: v.note ? `[轉帳手續費] ${v.note}` : '[轉帳手續費]',
          linkedAccountId: fromAcc.isLinkedSavings ? fromAcc.id : null,
          ledgerId: getEffectiveLedgerId(fromAcc),
        },
        rate
      );
      feeCashflow = {
        id: cfId,
        ...validatedCf,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'cashflow',
        op: 'upsert',
        recordId: cfId,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...feeCashflow },
      });
    }

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      assetItems:
        updatedAssets.length > 0
          ? mergeById(this.snapshot.assetItems, updatedAssets).sort(compareBySortOrder)
          : this.snapshot.assetItems,
      savingsAdjustments:
        newAdjustments.length > 0
          ? [...newAdjustments, ...this.snapshot.savingsAdjustments].sort(
              (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
            )
          : this.snapshot.savingsAdjustments,
      cashflowLogs: feeCashflow
        ? this.sortCashFlows([feeCashflow, ...this.snapshot.cashflowLogs])
        : this.snapshot.cashflowLogs,
    };

    // M4: every leg (and the fee) of a transfer is applied by the server all-or-nothing and sent in one batch
    const groupedMutations = mutations.map((m) => ({ ...m, atomicGroupId: transferGroupId }));
    await this.commitAndMaybeSync(nextSnapshot, groupedMutations);
    return {
      transferGroupId,
      fromAdjustment,
      toAdjustment,
      feeCashflow,
      fromAmount: v.amount,
      toAmount,
      fee: v.fee,
    };
  }

  async addStockTransaction(
    payload: StockTransactionInputPayload & {
      syncToCashflow?: boolean;
      linkedAccountId?: string | null;
    }
  ): Promise<{ tx: StockTransaction; cashflow: CashFlowLog | null }> {
    const asset = this.snapshot.assetItems.find((a) => a.id === payload.assetId && !a.deletedAt);
    if (!asset) throw new Error('找不到對應的持股項目。');
    const v = validateStockTransactionInput(payload);
    if (v.txType === STOCK_TX_TYPES.SELL) {
      // v1.8.15: refuse to sell more shares than currently held
      const held = computeStockPositionSummary(asset, this.snapshot.stockTransactions || [], 1).currentShares;
      if (v.shares > held + 1e-9) {
        throw new Error(`賣出股數 (${v.shares}) 超過目前持有股數 (${held})。`);
      }
    }
    const nowIso = new Date().toISOString();
    const txId = crypto.randomUUID();
    const mutations: SyncMutation[] = [];

    let createdCashflow: CashFlowLog | null = null;
    if (payload.syncToCashflow && v.totalAmount > 0 && v.txType !== STOCK_TX_TYPES.STOCK_DIVIDEND) {
      const cfId = crypto.randomUUID();
      const cfType =
        v.txType === STOCK_TX_TYPES.BUY ? CASHFLOW_TYPES.INVESTMENT : CASHFLOW_TYPES.OTHER_INCOME;
      const cfCategory =
        v.txType === STOCK_TX_TYPES.BUY
          ? asset.subCategory === '美股/ETF'
            ? '美股/ETF'
            : '台股投資'
          : v.txType === STOCK_TX_TYPES.CASH_DIVIDEND
            ? '股息/配息'
            : '其他';
      const cfItemName =
        v.txType === STOCK_TX_TYPES.BUY
          ? `${asset.itemName} 加碼 ${v.shares}股`
          : v.txType === STOCK_TX_TYPES.CASH_DIVIDEND
            ? `${asset.itemName} 現金配息`
            : `${asset.itemName} 賣出 ${v.shares}股`;

      const linkedAcc = payload.linkedAccountId
        ? this.snapshot.assetItems.find((a) => !a.deletedAt && a.id === payload.linkedAccountId)
        : undefined;
      const cfLedgerId = linkedAcc?.ledgerId || asset.ledgerId || DEFAULT_LEDGER_ID;

      const validatedCf = validateCashFlowInput(
        {
          date: v.date,
          type: cfType,
          category: cfCategory,
          itemName: cfItemName,
          amount: v.totalAmount,
          currency: asset.currency,
          source: '手機記帳',
          note: v.note ? `[持股連動] ${v.note}` : '[持股連動]',
          linkedAccountId: payload.linkedAccountId || null,
          ledgerId: cfLedgerId,
        },
        this.snapshot.settings.usdTwdRate
      );

      createdCashflow = {
        id: cfId,
        ...validatedCf,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'cashflow',
        op: 'upsert',
        recordId: cfId,
        clientTimestamp: nowIso,
        baseVersion: null,
        isNewRecord: true,
        payload: { ...createdCashflow },
      });
    }

    const tx: StockTransaction = {
      id: txId,
      ...v,
      linkedCashflowId: createdCashflow ? createdCashflow.id : v.linkedCashflowId,
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    };

    mutations.push({
      mutationId: crypto.randomUUID(),
      entity: 'stock_tx',
      op: 'upsert',
      recordId: txId,
      clientTimestamp: nowIso,
      baseVersion: null,
      isNewRecord: true,
      payload: { ...tx },
    });

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      cashflowLogs: createdCashflow
        ? this.sortCashFlows([createdCashflow, ...this.snapshot.cashflowLogs])
        : this.snapshot.cashflowLogs,
      stockTransactions: [tx, ...(this.snapshot.stockTransactions || [])].sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      ),
    };

    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return { tx, cashflow: createdCashflow };
  }

  async deleteStockTransaction(id: string, deleteLinkedCashflow = false): Promise<void> {
    const nowIso = new Date().toISOString();
    const target = (this.snapshot.stockTransactions || []).find((t) => t.id === id);
    const mutations: SyncMutation[] = [
      {
        mutationId: crypto.randomUUID(),
        entity: 'stock_tx',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: target?.version ?? null,
      },
    ];

    let nextLogs = this.snapshot.cashflowLogs;
    if (deleteLinkedCashflow && target?.linkedCashflowId) {
      const linkedCf = nextLogs.find((l) => l.id === target.linkedCashflowId);
      nextLogs = nextLogs.filter((l) => l.id !== target.linkedCashflowId);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'cashflow',
        op: 'delete',
        recordId: target.linkedCashflowId,
        clientTimestamp: nowIso,
        baseVersion: linkedCf?.version ?? null,
      });
    }

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      cashflowLogs: nextLogs,
      stockTransactions: (this.snapshot.stockTransactions || []).filter((t) => t.id !== id),
    };
    await this.commitAndMaybeSync(nextSnapshot, mutations);
  }

  async deleteAsset(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.assetItems.find((a) => a.id === id);
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      assetItems: this.snapshot.assetItems.filter((a) => a.id !== id),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
      },
    ]);
  }

  async saveUtilityRecord(payload: UtilityRecordInputPayload): Promise<RentUtilityRecord> {
    const v = validateUtilityRecordInput(payload);
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.rentUtilityRecords.find((r) => r.period === v.period);
    const record: RentUtilityRecord = {
      ...v,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      ...(existing?.version !== undefined ? { version: existing.version } : {}),
    };

    const updates: RentUtilityRecord[] = [record];
    const mutations: SyncMutation[] = [];

    // 若更新的是第一期非起點紀錄，且使用者有微調上期度數，同步更新起點表底
    const sorted = sortUtilityRecords(this.snapshot.rentUtilityRecords);
    const baseline = sorted.find((r) => r.isBaseline);
    const firstNonBase = sorted.find((r) => !r.isBaseline);
    if (
      baseline &&
      (!firstNonBase || firstNonBase.period === v.period) &&
      payload.prevTotal !== undefined &&
      Number.isFinite(Number(payload.prevTotal))
    ) {
      const updatedBaseline: RentUtilityRecord = {
        ...baseline,
        curTotal: Math.round(Number(payload.prevTotal)),
        cur6F: Math.round(Number(payload.prev6F ?? baseline.cur6F)),
        curA: Math.round(Number(payload.prevA ?? baseline.curA)),
        curB: Math.round(Number(payload.prevB ?? baseline.curB)),
        curC: Math.round(Number(payload.prevC ?? baseline.curC)),
        updatedAt: nowIso,
        deletedAt: null,
      };
      updates.push(updatedBaseline);
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'utility_record',
        op: 'upsert',
        recordId: updatedBaseline.period,
        clientTimestamp: nowIso,
        baseVersion: baseline.version ?? null,
        isNewRecord: false,
        payload: { ...updatedBaseline },
      });
    }

    mutations.push({
      mutationId: crypto.randomUUID(),
      entity: 'utility_record',
      op: 'upsert',
      recordId: record.period,
      clientTimestamp: nowIso,
      baseVersion: existing?.version ?? null,
      isNewRecord: !existing,
      payload: { ...record },
    });

    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      rentUtilityRecords: mergeUtilityRecords(this.snapshot.rentUtilityRecords, updates),
    };
    await this.commitAndMaybeSync(nextSnapshot, mutations);
    return record;
  }

  async deleteUtilityRecord(period: string): Promise<void> {
    const clean = String(period || '').trim();
    const target = this.snapshot.rentUtilityRecords.find((r) => r.period === clean);
    if (!target || target.isBaseline) {
      throw new Error('無法刪除起始表底或不存在的期別。');
    }
    const nowIso = new Date().toISOString();
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      rentUtilityRecords: this.snapshot.rentUtilityRecords.filter((r) => r.period !== clean),
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'utility_record',
        op: 'delete',
        recordId: clean,
        clientTimestamp: nowIso,
        baseVersion: target.version ?? null,
      },
    ]);
  }

  async saveUtilityRents(rents: Partial<RentUtilityRents>): Promise<RentUtilityRents> {
    const v = validateUtilityRentsInput(rents);
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.rentUtilityRents.version;
    const nextRents: RentUtilityRents = {
      ...v,
      updatedAt: nowIso,
      ...(baseVersion !== undefined ? { version: baseVersion } : {}),
    };
    const nextSnapshot: FinanceSnapshot = {
      ...this.snapshot,
      rentUtilityRents: nextRents,
    };
    await this.commitAndMaybeSync(nextSnapshot, [
      {
        mutationId: crypto.randomUUID(),
        entity: 'utility_rents',
        op: 'upsert',
        recordId: '1',
        clientTimestamp: nowIso,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...nextRents },
      },
    ]);
    return nextRents;
  }

  private async commitAndMaybeSync(
    nextSnapshot: FinanceSnapshot,
    mutations: SyncMutation[]
  ): Promise<void> {
    const normalizedMutations = mutations.map((m) =>
      m.isNewRecord !== undefined
        ? m
        : {
            ...m,
            isNewRecord:
              m.op === 'upsert' &&
              m.entity !== 'settings' &&
              m.entity !== 'utility_rents' &&
              (m.baseVersion === null || m.baseVersion === 0),
          }
    );
    try {
      await this.db.commitLocalMutation(nextSnapshot, normalizedMutations, this.inFlightMutationIds);
    } catch (err) {
      if (err instanceof StaleSnapshotError) throw err; // handled by the serialized wrapper (reload + retry)
      const msg = err instanceof Error ? err.message : '本機儲存失敗，變更未寫入';
      // v1.8.15: the caller usually shows the same error again — showToast drops a toast whose text is already
      // part of the visible one, so the user sees it once
      this.opts.onError?.(msg);
      throw err;
    }
    this.snapshot = nextSnapshot;
    const outbox = await this.db.getOutbox();
    this.emitSnapshot();
    this.broadcastDbChanged();
    this.updateStatus(this.computeStatus(outbox.length));
  }

  /* ==================== Conflict Resolution ==================== */

  private applyRecordToSnapshot(
    baseSnapshot: FinanceSnapshot,
    entity: SyncConflict['entity'],
    recordId: string,
    record: Record<string, unknown> | null,
    isDelete: boolean
  ): FinanceSnapshot {
    if (entity === 'settings') {
      if (record) return { ...baseSnapshot, settings: record as unknown as AppSettings };
      return baseSnapshot;
    }
    if (entity === 'ledger') {
      const current = ensureActiveLedgers(baseSnapshot.ledgers);
      const filtered = current.filter((l) => l.id !== recordId);
      const next =
        !isDelete && record && !record.deletedAt
          ? [...filtered, record as unknown as Ledger]
          : filtered;
      return { ...baseSnapshot, ledgers: ensureActiveLedgers(next) };
    }
    if (entity === 'utility_rents') {
      if (record) return { ...baseSnapshot, rentUtilityRents: record as unknown as RentUtilityRents };
      return baseSnapshot;
    }
    if (entity === 'cashflow') {
      const filtered = baseSnapshot.cashflowLogs.filter((l) => l.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [record as unknown as CashFlowLog, ...filtered] : filtered;
      return { ...baseSnapshot, cashflowLogs: this.sortCashFlows(next) };
    }
    if (entity === 'recurring') {
      const filtered = baseSnapshot.recurringItems.filter((r) => r.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as RecurringItem] : filtered;
      return { ...baseSnapshot, recurringItems: next.sort(compareBySortOrder) };
    }
    if (entity === 'sinking') {
      const filtered = baseSnapshot.sinkingItems.filter((s) => s.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as SinkingFundItem] : filtered;
      return { ...baseSnapshot, sinkingItems: next.sort(compareBySortOrder) };
    }
    if (entity === 'asset') {
      const existing = baseSnapshot.assetItems.find((a) => a.id === recordId);
      const filtered = baseSnapshot.assetItems.filter((a) => a.id !== recordId);
      if (!isDelete && record && !record.deletedAt) {
        const definedRecord: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(record)) {
          if (v !== undefined) definedRecord[k] = v;
        }
        const mergedAsset = (existing ? { ...existing, ...definedRecord } : definedRecord) as unknown as AssetItem;
        return { ...baseSnapshot, assetItems: [...filtered, mergedAsset].sort(compareBySortOrder) };
      }
      return { ...baseSnapshot, assetItems: filtered.sort(compareBySortOrder) };
    }
    if (entity === 'savings_adjustment') {
      const filtered = baseSnapshot.savingsAdjustments.filter((a) => a.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [record as unknown as SavingsAdjustment, ...filtered] : filtered;
      return {
        ...baseSnapshot,
        savingsAdjustments: next.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
      };
    }
    if (entity === 'stock_tx') {
      const filtered = (baseSnapshot.stockTransactions || []).filter((t) => t.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [record as unknown as StockTransaction, ...filtered] : filtered;
      return {
        ...baseSnapshot,
        stockTransactions: next.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
      };
    }
    if (entity === 'utility_record') {
      const filtered = baseSnapshot.rentUtilityRecords.filter((r) => r.period !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as RentUtilityRecord] : filtered;
      return { ...baseSnapshot, rentUtilityRecords: sortUtilityRecords(next) };
    }
    return baseSnapshot;
  }

  private findRecordInDelta(
    delta: SyncDelta,
    entity: SyncMutation['entity'],
    recordId: string
  ): { record: Record<string, unknown>; version?: number } | null {
    switch (entity) {
      case 'settings':
        return delta.settings
          ? { record: delta.settings as unknown as Record<string, unknown>, version: delta.settings.version }
          : null;
      case 'utility_rents':
        return delta.rentUtilityRents
          ? {
              record: delta.rentUtilityRents as unknown as Record<string, unknown>,
              version: delta.rentUtilityRents.version,
            }
          : null;
      case 'ledger': {
        const found = (delta.ledgers || []).find((l) => l.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'cashflow': {
        const found = (delta.cashflowLogs || []).find((l) => l.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'recurring': {
        const found = (delta.recurringItems || []).find((r) => r.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'sinking': {
        const found = (delta.sinkingItems || []).find((s) => s.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'asset': {
        const found = (delta.assetItems || []).find((a) => a.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'savings_adjustment': {
        const found = (delta.savingsAdjustments || []).find((a) => a.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'stock_tx': {
        const found = (delta.stockTransactions || []).find((t) => t.id === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      case 'utility_record': {
        const found = (delta.rentUtilityRecords || []).find((u) => u.period === recordId);
        return found ? { record: found as unknown as Record<string, unknown>, version: found.version } : null;
      }
      default:
        return null;
    }
  }

  async resolveConflictKeepServer(mutationId: string): Promise<void> {
    await this.runSerialized(async () => {
      const conflict = this.conflicts.find((c) => c.mutationId === mutationId);
      if (!conflict) return;

      const nextConflicts = this.conflicts.filter((c) => c.mutationId !== mutationId);
      const nextSnapshot = this.applyRecordToSnapshot(
        this.snapshot,
        conflict.entity,
        conflict.recordId,
        conflict.serverRecord,
        !conflict.serverRecord || Boolean(conflict.serverRecord.deletedAt)
      );
      // P2-C9: Single atomic IndexedDB transaction for snapshot + conflicts
      await this.db.resolveConflictKeepServerTx(nextSnapshot, nextConflicts);
      this.snapshot = nextSnapshot;
      this.conflicts = nextConflicts;
      const outbox = await this.db.getOutbox();
      this.emitSnapshot();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(outbox.length));
    });
  }

  async resolveConflictKeepLocal(mutationId: string): Promise<SyncResult> {
    let resolved = false;
    await this.runSerialized(async () => {
      const conflict = this.conflicts.find((c) => c.mutationId === mutationId);
      if (!conflict) return;

      const nowIso = new Date().toISOString();
      const nextConflicts = this.conflicts.filter((c) => c.mutationId !== mutationId);

      const payloadWithVersion: Record<string, unknown> | undefined = conflict.clientPayload
        ? { ...conflict.clientPayload, updatedAt: nowIso, version: conflict.serverVersion }
        : undefined;

      // F1: Preserve server's latest live quote fields in the local snapshot when clientPayload
      // omitted unitPrice/previousClose/priceUpdatedAt, while keeping retryMutation minimal for server upload.
      let snapshotPayload: Record<string, unknown> | null = payloadWithVersion || null;
      if (
        conflict.entity === 'asset' &&
        conflict.op !== 'delete' &&
        payloadWithVersion &&
        conflict.serverRecord
      ) {
        const srv = conflict.serverRecord;
        snapshotPayload = {
          ...payloadWithVersion,
          ...(payloadWithVersion.unitPrice === undefined && srv.unitPrice !== undefined
            ? { unitPrice: srv.unitPrice }
            : {}),
          ...(payloadWithVersion.previousClose === undefined && srv.previousClose !== undefined
            ? { previousClose: srv.previousClose }
            : {}),
          ...(payloadWithVersion.priceUpdatedAt === undefined && srv.priceUpdatedAt !== undefined
            ? { priceUpdatedAt: srv.priceUpdatedAt }
            : {}),
        };
      }

      const nextSnapshot = this.applyRecordToSnapshot(
        this.snapshot,
        conflict.entity,
        conflict.recordId,
        snapshotPayload,
        conflict.op === 'delete'
      );

      const retryMutation: SyncMutation = {
        mutationId: crypto.randomUUID(),
        entity: conflict.entity,
        op: conflict.op,
        recordId: conflict.recordId,
        clientTimestamp: nowIso,
        baseVersion: conflict.serverVersion,
        isNewRecord: false,
        ...(payloadWithVersion ? { payload: payloadWithVersion } : {}),
      };

      // P2-C9: Single atomic IndexedDB transaction for snapshot + conflicts + outbox
      await this.db.resolveConflictKeepLocalTx(
        nextSnapshot,
        nextConflicts,
        retryMutation,
        this.inFlightMutationIds
      );
      this.snapshot = nextSnapshot;
      this.conflicts = nextConflicts;
      resolved = true;
      const outbox = await this.db.getOutbox();
      this.emitSnapshot();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(outbox.length));
    });

    if (resolved && this.isOnline()) {
      return this.syncNow();
    }
    return { ok: true };
  }

  /* ==================== Bidirectional Sync ==================== */

  private clearScheduledRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(overrideDelayMs?: number): void {
    if (this.accountMismatchHalted || this.destroyed) return;
    this.clearScheduledRetry();
    let delayMs: number;
    if (overrideDelayMs !== undefined) {
      delayMs = overrideDelayMs;
    } else {
      const exp = Math.min(60_000, this.retryBaseDelayMs * Math.pow(2, Math.max(0, this.consecutiveFailures - 1)));
      const jitter = 0.75 + Math.random() * 0.5;
      delayMs = Math.round(exp * jitter);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.isOnline() && !this.accountMismatchHalted && !this.destroyed) {
        void this.syncNow();
      }
    }, delayMs);
  }

  private syncingIsFullPull = false;

  async syncNow(forceFullPull = false): Promise<SyncResult> {
    if (this.accountMismatchHalted) {
      return {
        ok: false,
        accountMismatch: true,
        error: '目前瀏覽器登入帳號已變更，已停止同步以避免跨帳號寫入。請重新整理或切換帳號。',
      };
    }
    if (this.syncingPromise) {
      if (forceFullPull && !this.syncingIsFullPull) {
        // C2: Wait for in-flight incremental sync, then execute a real full pull
        await this.syncingPromise.catch(() => {});
        return this.syncNow(true);
      }
      return this.syncingPromise;
    }

    this.clearScheduledRetry();
    this.syncingIsFullPull = forceFullPull;
    this.syncingPromise = this.requestLockImpl(`personal-finance-sync:${this.db.getDbName()}`, () =>
      this.performSync(forceFullPull)
    )
      .catch((err: unknown): SyncResult => {
        if (err instanceof SyncLockBusyError) {
          this.scheduleRetry(5_000);
          return { ok: false, error: err.message };
        }
        throw err;
      })
      .finally(() => {
        this.syncingPromise = null;
        this.syncingIsFullPull = false;
      });
    return this.syncingPromise;
  }

  private isExpectedAckedVersion(ackedParent: SyncMutation, serverVersion: number): boolean {
    if (ackedParent.baseVersion === null || ackedParent.baseVersion === 0) {
      return serverVersion === 1;
    }
    if (typeof ackedParent.baseVersion === 'number') {
      return serverVersion === ackedParent.baseVersion + 1;
    }
    // Settings / utility_rents / legacy without baseVersion: parent itself was just acked
    return true;
  }

  private parseRetryAfterMs(headerVal: string | null): number | undefined {
    if (!headerVal) return undefined;
    const trimmed = headerVal.trim();
    if (!trimmed) return undefined;
    const sec = Number(trimmed);
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.max(200, Math.min(60_000, Math.round(sec * 1000)));
    }
    const ts = Date.parse(trimmed);
    if (Number.isFinite(ts)) {
      return Math.max(200, Math.min(60_000, ts - Date.now()));
    }
    return undefined;
  }

  private overlayPendingOutboxOnSnapshot(
    baseSnapshot: FinanceSnapshot,
    pendingList: SyncMutation[]
  ): FinanceSnapshot {
    let merged = baseSnapshot;
    for (const pendingMut of pendingList) {
      if (pendingMut.entity === 'settings' && pendingMut.payload) {
        const p = pendingMut.payload as Partial<AppSettings>;
        merged = {
          ...merged,
          settings: {
            ...merged.settings,
            ...(p.monthlyDailyBudget !== undefined ? { monthlyDailyBudget: p.monthlyDailyBudget } : {}),
            ...(p.emergencyTargetMonths !== undefined ? { emergencyTargetMonths: p.emergencyTargetMonths } : {}),
            ...(p.usdTwdRate !== undefined ? { usdTwdRate: p.usdTwdRate } : {}),
            ...(p.autoFxEnabled !== undefined ? { autoFxEnabled: p.autoFxEnabled } : {}),
            ...(p.pnlColorScheme !== undefined ? { pnlColorScheme: p.pnlColorScheme } : {}),
            ...(p.customStockCategories !== undefined ? { customStockCategories: p.customStockCategories } : {}),
          },
        };
      } else if (pendingMut.op === 'delete') {
        merged = this.removeRecordFromSnapshot(merged, pendingMut.entity, pendingMut.recordId);
      } else if (pendingMut.op === 'upsert' && pendingMut.payload) {
        merged = this.applyRecordToSnapshot(
          merged,
          pendingMut.entity,
          pendingMut.recordId,
          pendingMut.payload,
          false
        );
      }
    }
    return merged;
  }

  /**
   * Q4 / N1: Select up to `maxCount` mutations with at most ONE mutation per `entity:recordId`
   * in a single HTTP batch, so an already-sent (`sentAt`) mutation and a subsequent edit for
   * the same record are never sent together and cause a self-conflict.
   */
  private selectSyncBatch(outbox: SyncMutation[], maxCount: number): SyncMutation[] {
    return this.selectSyncUnits(outbox, maxCount).batch;
  }

  /**
   * M4: the outbox is consumed in units. A unit is one mutation, or — when it belongs to an atomic group — the run of
   * the outbox from it up to the last member of its group (transitively), so a group is never split across requests.
   * `maxCount` counts mutations, but the first unit is always taken whole (single-item isolation sends one unit).
   */
  private selectSyncUnits(
    rawOutbox: SyncMutation[],
    maxCount: number
  ): { batch: SyncMutation[]; unitCount: number } {
    // Review R-A: send records before the mutations that reference them (coalescing moves an edited record to
    // the end of the queue; with the M3 reference guards a linked cashflow would otherwise be rejected)
    const outbox = orderMutationsByDependencies(rawOutbox);
    const lastIndexOfGroup = new Map<string, number>();
    outbox.forEach((m, i) => {
      if (m.atomicGroupId) lastIndexOfGroup.set(m.atomicGroupId, i);
    });
    const selected: SyncMutation[] = [];
    const seenKeys = new Set<string>();
    let unitCount = 0;
    let i = 0;
    while (i < outbox.length) {
      let end = i;
      for (let j = i; j <= end; j++) {
        const g = outbox[j].atomicGroupId;
        if (g) end = Math.max(end, lastIndexOfGroup.get(g) ?? j);
      }
      let unit = outbox.slice(i, end + 1);
      if (maxCount === 1 && unit.length > 1) {
        // Review R-B: while isolating a poison pill, send only the atomic group(s) — plus any item in the span a
        // member references — so an unrelated item between the members is not quarantined with the transfer.
        const groups = new Set(unit.filter((m) => m.atomicGroupId).map((m) => m.atomicGroupId!));
        const memberRefs = new Set(
          unit.filter((m) => m.atomicGroupId && groups.has(m.atomicGroupId)).flatMap((m) => mutationReferenceKeys(m))
        );
        unit = unit.filter(
          (m) =>
            (m.atomicGroupId && groups.has(m.atomicGroupId)) ||
            (m.op === 'upsert' && memberRefs.has(`${m.entity}:${m.recordId}`))
        );
      }
      const unitKeys: string[] = [];
      let dupAt = -1;
      for (let k = 0; k < unit.length; k++) {
        const key = `${unit[k].entity}:${unit[k].recordId}`;
        // V2: Stop at the first duplicate key so every batch is a strict prefix of the outbox.
        if (seenKeys.has(key) || unitKeys.includes(key)) {
          dupAt = k;
          break;
        }
        unitKeys.push(key);
      }
      if (dupAt >= 0) {
        if (selected.length === 0 && dupAt > 0) {
          // Pathological: a duplicate key inside the first unit. Send the prefix up to it rather than stall.
          selected.push(...unit.slice(0, dupAt));
          unitCount += 1;
        }
        break;
      }
      if (selected.length > 0 && selected.length + unit.length > maxCount) break;
      selected.push(...unit);
      unitKeys.forEach((k) => seenKeys.add(k));
      unitCount += 1;
      i = end + 1;
      if (selected.length >= maxCount) break;
    }
    return { batch: selected, unitCount };
  }

  /**
   * R2 & Q1: Best-effort read-only pull when an outbox batch fails with 5xx/400/413.
   * Ensures server-side changes still download AND acts as a server health probe:
   * if `mutations: []` ALSO fails (returns `{ ok: false }`), the failure is a global server outage
   * rather than an item-specific poison-pill mutation.
   */
  private async tryReadOnlyPull(
    reqSince: string | null,
    reqSinceSeq: number | null,
    reqClientEpoch: number | null,
    forceFullPull = false,
    writeProbe = false
  ): Promise<{ ok: boolean; epochFrozen: boolean; writeProbeOk: boolean }> {
    if (!this.isOnline()) return { ok: false, epochFrozen: false, writeProbeOk: false };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, 15_000));
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.expectedUserId) {
        headers['x-expected-user'] = this.expectedUserId;
      }
      const res = await this.fetchImpl('/api/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          since: reqSince,
          sinceSeq: reqSinceSeq,
          clientEpoch: reqClientEpoch,
          mutations: [],
          ...(writeProbe ? { writeProbe: true } : {}),
        }),
      });
      if (!res.ok) return { ok: false, epochFrozen: false, writeProbeOk: false };
      const data = (await res.json()) as SyncResponse;
      let epochFrozen = false;
      await this.runSerialized(async () => {
        const currentOutbox = await this.db.getOutbox();
        const nextMeta: LocalMeta = {
          ...this.meta,
          lastSyncedAt: data.serverTime,
          ...(typeof data.syncCursor === 'number' ? { syncCursor: data.syncCursor } : {}),
          ...(typeof data.dataEpoch === 'number' ? { dataEpoch: data.dataEpoch } : {}),
        };
        const epochChanged =
          typeof this.meta.dataEpoch === 'number' &&
          typeof data.dataEpoch === 'number' &&
          this.meta.dataEpoch !== data.dataEpoch;
        if ((Boolean(data.epochMismatch) || epochChanged) && currentOutbox.length > 0) {
          nextMeta.pendingFullResync = false;
          const restoredSnap = this.mergeDelta(this.snapshot, data.delta, true);
          const mergedFrozen = await this.db.freezeOutboxAndApplySnapshot(
            restoredSnap,
            nextMeta,
            this.conflicts,
            this.rejections,
            { annotateItem: (item) => this.annotateFrozenMutation(item, restoredSnap) }
          );
          this.snapshot = restoredSnap;
          this.meta = nextMeta;
          this.frozenOutbox = mergedFrozen;
          this.emitSnapshot();
          this.broadcastDbChanged();
          this.updateStatus(this.computeStatus(0));
          epochFrozen = true;
          return;
        }
        const applyAsFull = forceFullPull || Boolean(data.fullResyncRequired) || epochChanged;
        if (applyAsFull) {
          nextMeta.pendingFullResync = false;
        }
        const baseMerged = this.mergeDelta(this.snapshot, data.delta, applyAsFull);
        const overlaid = this.overlayPendingOutboxOnSnapshot(baseMerged, currentOutbox);
        await this.db.acknowledgeOutboxAndSave([], overlaid, nextMeta);
        this.snapshot = overlaid;
        this.meta = nextMeta;
        this.emitSnapshot();
        this.broadcastDbChanged();
      });
      return { ok: true, epochFrozen, writeProbeOk: data.writeProbeOk === true };
    } catch {
      // Best-effort read-only pull; ignore secondary errors
      return { ok: false, epochFrozen: false, writeProbeOk: false };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async performSync(forceFullPull: boolean): Promise<SyncResult> {
    // Re-read fresh state from IndexedDB after acquiring the cross-tab lock
    let initialOutboxCount = 0;
    await this.runSerialized(async () => {
      this.snapshot = await this.db.getSnapshot();
      this.meta = await this.db.getMeta();
      this.conflicts = await this.db.getConflicts();
      this.rejections = await this.db.getRejections();
      this.frozenOutbox = await this.db.getFrozenOutbox();
      initialOutboxCount = (await this.db.getOutbox()).length;
    });

    if (!this.isOnline()) {
      this.updateStatus(this.computeStatus(initialOutboxCount));
      return { ok: false, error: '目前處於離線模式' };
    }

    // R3: Honor persisted pendingFullResync even across page reload when outbox is empty
    let fullPullPass = forceFullPull || (Boolean(this.meta.pendingFullResync) && initialOutboxCount === 0);
    const maxPasses = 20;
    let quarantinedInThisSync = false;

    for (let pass = 0; pass < maxPasses; pass++) {
      if (this.destroyed) return { ok: false, error: '同步已停止（帳號已切換或頁面已關閉）' };
      let outbox: SyncMutation[] = [];
      let batch: SyncMutation[] = [];
      let batchUnitCount = 0;
      let hadMoreBatches = false;
      let reqSince: string | null = null;
      let reqSinceSeq: number | null = null;
      let reqClientEpoch: number | null = null;

      await this.runSerialized(async () => {
        // R2 & Q1: Shrink batch size to 1 after a failure or while isolating a poison-pill mutation
        const effectiveBatchSize =
          this.consecutiveFailures >= 1 || this.poisonSearchActive ? 1 : this.maxBatchSize;
        // Q4 / N1 & V2: strict queue prefix, at most one mutation per entity:recordId per HTTP batch
        // v1.8.15: select the batch and mark it sent in ONE IndexedDB transaction, so another tab cannot
        // coalesce / cancel a selected mutation in between
        const sentAtIso = new Date().toISOString();
        const taken = await this.db.takeOutboxBatch((list) => {
          const selection = this.selectSyncUnits(list, effectiveBatchSize);
          batchUnitCount = selection.unitCount;
          return selection.batch.map((m) => m.mutationId);
        }, sentAtIso);
        outbox = taken.outbox;
        batch = taken.batch;
        hadMoreBatches = outbox.length > batch.length;
        // P2-C2: Persist sentAt & attempts to IndexedDB BEFORE sending HTTP request so timeout/reload never coalesces sent mutations
        if (batch.length > 0) {
          for (const m of batch) {
            this.inFlightMutationIds.add(m.mutationId);
          }
        }
        reqSince = fullPullPass ? null : this.meta.lastSyncedAt;
        reqSinceSeq = fullPullPass ? null : (this.meta.syncCursor ?? null);
        // Q5 / N4: Always transmit known dataEpoch even during fullPullPass so stale-epoch mutations are caught
        reqClientEpoch = this.meta.dataEpoch ?? null;
      });

      this.updateStatus({
        state: 'syncing',
        pendingCount: outbox.length,
        conflictCount: this.conflicts.length,
        rejectedCount: this.rejections.length,
        frozenOutboxCount: this.frozenOutbox.length,
        lastSyncedAt: this.meta.lastSyncedAt,
      });

      const controller = new AbortController();
      this.activeSyncController = controller;
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.expectedUserId) {
          headers['x-expected-user'] = this.expectedUserId;
        }

        const res = await this.fetchImpl('/api/sync', {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            since: reqSince,
            sinceSeq: reqSinceSeq,
            clientEpoch: reqClientEpoch,
            mutations: batch,
            refsOrdered: true,
          }),
        });

        if (res.status === 401) {
          this.updateStatus({
            state: 'auth_required',
            pendingCount: outbox.length,
            conflictCount: this.conflicts.length,
            rejectedCount: this.rejections.length,
            frozenOutboxCount: this.frozenOutbox.length,
            lastSyncedAt: this.meta.lastSyncedAt,
            lastError: '登入逾時，請重新驗證以同步待上傳資料',
          });
          this.opts.onAuthRequired?.();
          return { ok: false, authRequired: true };
        }

        if (res.status === 409) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
            expectedUserId?: string;
            actualUserId?: string;
          };
          const msg =
            errBody.error ||
            '目前瀏覽器登入帳號已變更，已停止同步以避免跨帳號寫入。請重新整理或切換帳號。';
          this.accountMismatchHalted = true;
          this.clearScheduledRetry();
          this.updateStatus({
            state: 'auth_required',
            pendingCount: outbox.length,
            conflictCount: this.conflicts.length,
            rejectedCount: this.rejections.length,
            frozenOutboxCount: this.frozenOutbox.length,
            lastSyncedAt: this.meta.lastSyncedAt,
            lastError: msg,
          });
          this.opts.onAccountMismatch?.({
            error: msg,
            expectedUserId: errBody.expectedUserId,
            actualUserId: errBody.actualUserId,
          });
          return { ok: false, accountMismatch: true, error: msg };
        }

        if (res.status === 429) {
          // P2-C8: Respect Retry-After header on rate limit instead of dropping retries
          const retryDelayMs = this.parseRetryAfterMs(res.headers.get('retry-after'));
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          const msg = errBody.error || '同步請求過於頻繁，稍後將自動重試';
          const latestOutbox = await this.db.getOutbox();
          this.updateStatus(this.computeStatus(latestOutbox.length, msg));
          if (this.isOnline()) {
            this.consecutiveFailures += 1;
            this.scheduleRetry(retryDelayMs);
          }
          return { ok: false, error: msg };
        }

        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          const statusErr = new Error(errBody.error || `同步失敗 (${res.status})`) as Error & {
            httpStatus?: number;
          };
          statusErr.httpStatus = res.status;
          throw statusErr;
        }

        const data = (await res.json()) as SyncResponse;
        this.consecutiveFailures = 0;

        let passOutcome: {
          epochFrozen: boolean;
          needsFullResyncAfterRejection: boolean;
          applyAsFull: boolean;
          madeForwardProgress: boolean;
          remainingOutboxCount: number;
        } = {
          epochFrozen: false,
          needsFullResyncAfterRejection: false,
          applyAsFull: false,
          madeForwardProgress: false,
          remainingOutboxCount: 0,
        };

        // P2-C3 & P2-C5: Apply sync response, rebase, and persist inside the same serialized state mutex
        await this.runSerialized(async () => {
          const incomingConflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
          let nextConflicts = this.conflicts;
          if (incomingConflicts.length > 0) {
            const byKey = new Map<string, SyncConflict>();
            for (const c of this.conflicts) {
              byKey.set(`${c.entity}:${c.recordId}`, c);
            }
            for (const c of incomingConflicts) {
              byKey.set(`${c.entity}:${c.recordId}`, c);
            }
            nextConflicts = Array.from(byKey.values());
          }

          const incomingRejected = Array.isArray(data.rejected) ? data.rejected : [];
          const ackedSet = new Set(data.ackedMutationIds || []);
          const batchById = new Map(batch.map((m) => [m.mutationId, m]));
          const outboxIdsToClear = [
            ...(data.ackedMutationIds || []),
            ...incomingConflicts.map((c) => c.mutationId),
            ...incomingRejected.map((r) => r.mutationId),
          ];
          const clearedSet = new Set(outboxIdsToClear);
          const batchIdSet = new Set(batch.map((m) => m.mutationId));
          const currentOutbox = await this.db.getOutbox();

          const nextMeta: LocalMeta = {
            ...this.meta,
            lastSyncedAt: data.serverTime,
            ...(typeof data.syncCursor === 'number' ? { syncCursor: data.syncCursor } : {}),
            ...(typeof data.dataEpoch === 'number' ? { dataEpoch: data.dataEpoch } : {}),
          };

          const epochChanged =
            typeof this.meta.dataEpoch === 'number' &&
            typeof data.dataEpoch === 'number' &&
            this.meta.dataEpoch !== data.dataEpoch;
          const isEpochMismatch = Boolean(data.epochMismatch) || epochChanged;

          // P2-C4 & N3: When epoch changed (backup replace import on another device) and outbox has un-acked mutations,
          // freeze un-acked outbox items with their post-restore baseline instead of discarding or blindly applying them.
          const unackedOutbox = currentOutbox.filter((m) => !clearedSet.has(m.mutationId));
          if (isEpochMismatch && unackedOutbox.length > 0) {
            nextMeta.pendingFullResync = false;
            const restoredSnap = this.mergeDelta(this.snapshot, data.delta, true);
            const mergedFrozen = await this.db.freezeOutboxAndApplySnapshot(
              restoredSnap,
              nextMeta,
              nextConflicts,
              this.rejections,
              {
                excludeMutationIds: clearedSet,
                annotateItem: (item) => this.annotateFrozenMutation(item, restoredSnap),
              }
            );
            this.snapshot = restoredSnap;
            this.meta = nextMeta;
            this.conflicts = nextConflicts;
            this.frozenOutbox = mergedFrozen;
            this.setPoisonSearch(false);
            this.emitSnapshot();
            this.broadcastDbChanged();
            this.updateStatus(this.computeStatus(0));
            passOutcome = {
              epochFrozen: true,
              needsFullResyncAfterRejection: false,
              applyAsFull: true,
              madeForwardProgress: true,
              remainingOutboxCount: 0,
            };
            return;
          }

          const applyAsFull = fullPullPass || Boolean(data.fullResyncRequired) || epochChanged;

          // P2-C1 & Q4/R7: Track which records had a mutation acked in this batch
          const ackedParentByKey = new Map<string, SyncMutation>();
          const ackedKeys = new Set<string>();
          for (const m of batch) {
            if (ackedSet.has(m.mutationId)) {
              const key = `${m.entity}:${m.recordId}`;
              ackedParentByKey.set(key, m);
              ackedKeys.add(key);
            }
          }

          const rejectedCreatesToRollback: Array<{ entity: string; recordId: string }> = [];
          let needsFullResyncAfterRejection = false;
          let nextRejections = this.rejections;
          if (incomingRejected.length > 0) {
            const byMutId = new Map<string, SyncRejection>(this.rejections.map((r) => [r.mutationId, r]));
            const rejectedAt = data.serverTime || new Date().toISOString();
            for (const r of incomingRejected) {
              const orig = batchById.get(r.mutationId);
              const isCreate = orig
                ? orig.isNewRecord !== undefined
                  ? orig.isNewRecord
                  : orig.op === 'upsert' && (orig.baseVersion === null || orig.baseVersion === 0)
                : false;

              let preservedPayload = orig?.payload;

              if (orig && isCreate) {
                const key = `${orig.entity}:${orig.recordId}`;
                // Q4 / R7: Never roll back a record or clear dependent edits if another mutation for
                // the same record was already acked in this same batch.
                if (!ackedKeys.has(key)) {
                  // R7: Clear any dependent pending edits for this failed create so the record cannot resurrect
                  const dependentPending = currentOutbox.filter(
                    (m) =>
                      !clearedSet.has(m.mutationId) &&
                      !batchIdSet.has(m.mutationId) &&
                      `${m.entity}:${m.recordId}` === key
                  );
                  for (const dep of dependentPending) {
                    outboxIdsToClear.push(dep.mutationId);
                    clearedSet.add(dep.mutationId);
                    if (dep.op === 'upsert' && dep.payload) {
                      preservedPayload = dep.payload;
                    }
                  }
                  // Review R-D: queued members of any atomic group touched here are held as a whole
                  const groupExtras = this.collectHeldClosure(
                    [orig, ...dependentPending],
                    currentOutbox,
                    new Set([...clearedSet, ...batchIdSet])
                  );
                  for (const dep of groupExtras) {
                    outboxIdsToClear.push(dep.mutationId);
                    clearedSet.add(dep.mutationId);
                    byMutId.set(dep.mutationId, this.heldGroupRejection(dep, rejectedAt));
                  }
                  if (groupExtras.length > 0 && !applyAsFull) needsFullResyncAfterRejection = true;
                  rejectedCreatesToRollback.push({ entity: orig.entity, recordId: orig.recordId });
                }
                byMutId.set(r.mutationId, {
                  mutationId: r.mutationId,
                  entity: orig.entity,
                  op: orig.op,
                  recordId: orig.recordId,
                  isNewRecord: true,
                  resolutionStatus: ackedKeys.has(key) ? 'restored' : 'rolled_back',
                  reason: r.reason || '伺服器拒絕此筆異動',
                  clientPayload: preservedPayload,
                  rejectedAt,
                });
              } else {
                // R3 & R6: Always mark pendingFullResync when a non-create edit/delete is rejected
                // (even if another pending edit exists for that key) unless this pass already fetched a full snapshot
                if (!applyAsFull) {
                  needsFullResyncAfterRejection = true;
                }
                // R6: queued later edits of the same record were built on top of the rejected local value, so
                // sending them could write the rejected value to the server. Hold them for review instead.
                if (orig) {
                  const key = `${orig.entity}:${orig.recordId}`;
                  if (!ackedKeys.has(key)) {
                    const followUps = currentOutbox.filter(
                      (m) =>
                        !clearedSet.has(m.mutationId) &&
                        !batchIdSet.has(m.mutationId) &&
                        `${m.entity}:${m.recordId}` === key
                    );
                    for (const dep of followUps) {
                      outboxIdsToClear.push(dep.mutationId);
                      clearedSet.add(dep.mutationId);
                      byMutId.set(dep.mutationId, {
                        mutationId: dep.mutationId,
                        entity: dep.entity,
                        op: dep.op,
                        recordId: dep.recordId,
                        isNewRecord: false,
                        resolutionStatus: 'held_after_reject',
                        reason: '前一筆編輯遭伺服器拒絕，這筆後續編輯包含遭拒的內容，已暫停送出並還原雲端資料；如仍需要請參考內容重新輸入',
                        ...(dep.payload ? { clientPayload: dep.payload } : {}),
                        rejectedAt,
                      });
                    }
                    // Review R-D: the held follow-ups' atomic groups are held as a whole
                    const groupExtras = this.collectHeldClosure(
                      [orig, ...followUps],
                      currentOutbox,
                      new Set([...clearedSet, ...batchIdSet])
                    );
                    for (const dep of groupExtras) {
                      outboxIdsToClear.push(dep.mutationId);
                      clearedSet.add(dep.mutationId);
                      byMutId.set(dep.mutationId, this.heldGroupRejection(dep, rejectedAt));
                    }
                    if (followUps.length > 0 || groupExtras.length > 0) needsFullResyncAfterRejection = true;
                  }
                }
                byMutId.set(r.mutationId, {
                  mutationId: r.mutationId,
                  entity: orig?.entity || 'unknown',
                  op: orig?.op || 'upsert',
                  recordId: orig?.recordId || r.mutationId,
                  isNewRecord: false,
                  resolutionStatus: applyAsFull ? 'restored' : 'pending_resync',
                  reason: r.reason || '伺服器拒絕此筆異動',
                  clientPayload: preservedPayload,
                  rejectedAt,
                });
              }
            }
            nextRejections = Array.from(byMutId.values());
          }

          if (needsFullResyncAfterRejection && !applyAsFull) {
            nextMeta.pendingFullResync = true;
          } else if (applyAsFull) {
            nextMeta.pendingFullResync = false;
            if (nextRejections.some((r) => r.resolutionStatus === 'pending_resync')) {
              nextRejections = nextRejections.map((r) =>
                r.resolutionStatus === 'pending_resync' ? { ...r, resolutionStatus: 'restored' } : r
              );
            }
          }

          let merged = this.mergeDelta(this.snapshot, data.delta, applyAsFull);
          for (const rb of rejectedCreatesToRollback) {
            merged = this.removeRecordFromSnapshot(merged, rb.entity, rb.recordId);
          }

          const rebasedMutations: Array<{ oldMutationId: string; replacement: SyncMutation }> = [];

          for (const pendingMut of currentOutbox) {
            if (clearedSet.has(pendingMut.mutationId)) continue;
            if (batchIdSet.has(pendingMut.mutationId)) continue;

            const key = `${pendingMut.entity}:${pendingMut.recordId}`;
            const serverHit = this.findRecordInDelta(data.delta, pendingMut.entity, pendingMut.recordId);
            const ackedParent = ackedParentByKey.get(key);
            const effectiveServerVersion =
              serverHit?.version !== undefined
                ? serverHit.version
                : ackedParent
                  ? this.findRecordInSnapshot(merged, pendingMut.entity, pendingMut.recordId)?.version
                  : undefined;
            // P2-C1, P2-C2 & Q4/N1: Only rebase baseVersion when our OWN earlier mutation for this record
            // was acked, effectiveServerVersion matches the expected post-ack version, and pendingMut was never sent yet.
            const canRebaseVersion = Boolean(
              ackedParent &&
                !pendingMut.sentAt &&
                effectiveServerVersion !== undefined &&
                this.isExpectedAckedVersion(ackedParent, effectiveServerVersion)
            );

            if (pendingMut.entity === 'settings' && pendingMut.payload) {
              const p = pendingMut.payload as Partial<AppSettings>;
              const rebasedSettings: AppSettings = {
                ...merged.settings,
                ...(p.monthlyDailyBudget !== undefined ? { monthlyDailyBudget: p.monthlyDailyBudget } : {}),
                ...(p.emergencyTargetMonths !== undefined ? { emergencyTargetMonths: p.emergencyTargetMonths } : {}),
                ...(p.usdTwdRate !== undefined ? { usdTwdRate: p.usdTwdRate } : {}),
                ...(p.autoFxEnabled !== undefined ? { autoFxEnabled: p.autoFxEnabled } : {}),
                ...(p.pnlColorScheme !== undefined ? { pnlColorScheme: p.pnlColorScheme } : {}),
                ...(p.customStockCategories !== undefined ? { customStockCategories: p.customStockCategories } : {}),
              };
              merged = { ...merged, settings: rebasedSettings };
              if (canRebaseVersion && effectiveServerVersion !== undefined) {
                rebasedMutations.push({
                  oldMutationId: pendingMut.mutationId,
                  replacement: {
                    ...pendingMut,
                    mutationId: crypto.randomUUID(),
                    baseVersion: effectiveServerVersion,
                    payload: { ...rebasedSettings },
                  },
                });
              }
              continue;
            }

            if (pendingMut.op === 'delete') {
              merged = this.removeRecordFromSnapshot(merged, pendingMut.entity, pendingMut.recordId);
              if (canRebaseVersion && effectiveServerVersion !== undefined) {
                rebasedMutations.push({
                  oldMutationId: pendingMut.mutationId,
                  replacement: {
                    ...pendingMut,
                    mutationId: crypto.randomUUID(),
                    baseVersion: effectiveServerVersion,
                  },
                });
              }
            } else if (pendingMut.op === 'upsert' && pendingMut.payload) {
              const nextVersion = canRebaseVersion ? effectiveServerVersion : undefined;
              const overlaidPayload: Record<string, unknown> = {
                ...pendingMut.payload,
                ...(nextVersion !== undefined ? { version: nextVersion } : {}),
              };
              merged = this.applyRecordToSnapshot(
                merged,
                pendingMut.entity,
                pendingMut.recordId,
                overlaidPayload,
                false
              );
              if (nextVersion !== undefined) {
                rebasedMutations.push({
                  oldMutationId: pendingMut.mutationId,
                  replacement: {
                    ...pendingMut,
                    mutationId: crypto.randomUUID(),
                    baseVersion: nextVersion,
                    isNewRecord: false,
                    payload: overlaidPayload,
                  },
                });
              }
            }
          }

          await this.db.acknowledgeOutboxAndSave(
            outboxIdsToClear,
            merged,
            nextMeta,
            nextConflicts,
            nextRejections,
            rebasedMutations
          );

          this.snapshot = merged;
          this.meta = nextMeta;
          this.conflicts = nextConflicts;
          this.rejections = nextRejections;

          const remainingOutbox = await this.db.getOutbox();
          if (remainingOutbox.length === 0) {
            this.setPoisonSearch(false);
          }
          this.emitSnapshot();
          this.broadcastDbChanged();
          this.updateStatus(this.computeStatus(remainingOutbox.length));

          passOutcome = {
            epochFrozen: false,
            needsFullResyncAfterRejection,
            applyAsFull,
            madeForwardProgress: outboxIdsToClear.length > 0,
            remainingOutboxCount: remainingOutbox.length,
          };
        });

        if (passOutcome.epochFrozen) {
          return { ok: true, epochMismatch: true };
        }

        // R-3: Leave single-item isolation mode after a streak of healthy single-item writes
        if (batchUnitCount === 1 && this.poisonSearchActive && passOutcome.madeForwardProgress) {
          this.singleItemSuccessStreak += 1;
          if (this.singleItemSuccessStreak >= 5) {
            this.setPoisonSearch(false);
            this.singleItemSuccessStreak = 0;
          }
        }

        // R6: Drain remaining outbox batches first, then perform ONE consolidated full pull if pendingFullResync is set
        if (hadMoreBatches && passOutcome.remainingOutboxCount > 0 && passOutcome.madeForwardProgress) {
          fullPullPass = false;
          continue;
        }

        if (
          this.meta.pendingFullResync &&
          !passOutcome.applyAsFull &&
          (passOutcome.remainingOutboxCount === 0 || passOutcome.needsFullResyncAfterRejection)
        ) {
          fullPullPass = true;
          continue;
        }
        fullPullPass = false;

        // P2-C8: If we sent mutations and server cleared 0 of them while outbox is non-empty, treat as no-progress failure and retry
        if (batch.length > 0 && !passOutcome.madeForwardProgress && passOutcome.remainingOutboxCount > 0) {
          const msg = '伺服器暫未確認待同步異動，稍後將自動重試';
          this.updateStatus(this.computeStatus(passOutcome.remainingOutboxCount, msg));
          if (this.isOnline()) {
            this.consecutiveFailures += 1;
            this.scheduleRetry();
          }
          return { ok: false, error: msg };
        }

        if (passOutcome.remainingOutboxCount > 0 && passOutcome.madeForwardProgress) {
          this.scheduleRetry(250);
        }
        return { ok: true };
      } catch (err) {
        if (this.destroyed) {
          // P2-C10: aborted by destroy(); the database may already be closed — do nothing further
          return { ok: false, error: '同步已停止（帳號已切換或頁面已關閉）' };
        }
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        const httpStatus = (err as { httpStatus?: number })?.httpStatus;
        const msg = isAbort
          ? `同步逾時（超過 ${Math.round(this.requestTimeoutMs / 1000)} 秒），稍後將自動重試`
          : err instanceof Error
            ? err.message
            : '網路同步失敗';

        const isServerOrPayloadFailure =
          httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 400 || httpStatus === 413);

        if (isServerOrPayloadFailure && batch.length > 0) {
          // Q1 & R2: First run a read-only pull (`mutations: []`).
          // 1) Downloads server changes so outbox failures never block pulls.
          // 2) Probes server health: if `mutations: []` ALSO fails (global server outage),
          //    we MUST NOT increment poison retryCount or quarantine healthy mutations!
          // V1: The pull also asks the server for a harmless write (writeProbe). Only a successful write proves
          // the write path is healthy; a successful read alone does not (e.g. D1 write outage / quota).
          const pullRes = await this.tryReadOnlyPull(reqSince, reqSinceSeq, reqClientEpoch, fullPullPass, true);
          if (pullRes.epochFrozen) {
            return { ok: true, epochMismatch: true };
          }

          // M7: 400 / 413 are only item-specific when the read-only pull AND the write probe succeed. A request-level
          // 400 / 413 (Worker regression, WAF, version skew) also fails the bare pull, so nothing is quarantined —
          // we only back off and retry.
          const isItemSpecificFailure = Boolean(pullRes.ok && pullRes.writeProbeOk);

          if (isItemSpecificFailure) {
            this.singleItemSuccessStreak = 0;
            if (batchUnitCount > 1) {
              // Server is healthy (or rejected payload size/format), so a specific mutation in this batch is poison.
              // Switch to single-item isolation mode without penalizing innocent items in the batch.
              this.setPoisonSearch(true);
            } else {
              // M4: a single unit may be an atomic group (e.g. both legs of a transfer) — it is isolated as a whole
              const updatedBatch = await this.db.incrementOutboxRetryCounts(
                batch.map((m) => m.mutationId),
                msg
              );
              const unitRetryCount = Math.max(
                0,
                ...batch.map((m) => updatedBatch.find((u) => u.mutationId === m.mutationId)?.retryCount ?? m.retryCount ?? 0)
              );
              const failedUnit = batch.map((m) => updatedBatch.find((u) => u.mutationId === m.mutationId) || m);
              if (
                failedUnit.length > 0 &&
                unitRetryCount >= this.maxPoisonRetries &&
                !quarantinedInThisSync
              ) {
                // R2 & Q1: Confirmed item-specific poison-pill mutation hit retry ceiling — quarantine it!
                const remainingAfterQuarantine = await this.quarantinePoisonMutations(failedUnit, msg);

                // Q1: Do NOT reset consecutiveFailures to 0 on quarantine (keep backoff & single-item
                // batching until a subsequent mutation actually succeeds), and cap at 1 quarantine per sync.
                quarantinedInThisSync = true;
                this.setPoisonSearch(false);
                if (remainingAfterQuarantine > 0) {
                  fullPullPass = false;
                  continue;
                }
                if (this.meta.pendingFullResync) {
                  fullPullPass = true;
                  continue;
                }
                return { ok: true };
              }
            }
          }
        }

        const latestOutbox = await this.db.getOutbox();
        this.updateStatus(this.computeStatus(latestOutbox.length, msg));

        // Exponential backoff + jitter on 5xx, 429, or network/timeout failures when outbox OR pendingFullResync needs retry
        const isTransient = !httpStatus || httpStatus >= 500 || httpStatus === 429 || isAbort;
        if (
          (isTransient || (isServerOrPayloadFailure && batch.length > 0)) &&
          (latestOutbox.length > 0 || Boolean(this.meta.pendingFullResync)) &&
          this.isOnline()
        ) {
          this.consecutiveFailures += 1;
          this.scheduleRetry();
        }
        return { ok: false, error: msg };
      } finally {
        clearTimeout(timeoutId);
        for (const m of batch) {
          this.inFlightMutationIds.delete(m.mutationId);
        }
      }
    }

    // P2-C8: If maxPasses (20) reached with remaining outbox items or pendingFullResync, schedule continuation retry
    const finalOutbox = await this.db.getOutbox();
    this.updateStatus(this.computeStatus(finalOutbox.length));
    if ((finalOutbox.length > 0 || Boolean(this.meta.pendingFullResync)) && this.isOnline()) {
      this.scheduleRetry(500);
    }
    return { ok: true };
  }

  /**
   * Moves a confirmed poison-pill mutation out of the outbox into the rejection list (keeping its payload).
   * Returns the number of mutations still queued afterwards.
   */
  private async quarantinePoisonMutations(failedUnit: SyncMutation[], msg: string): Promise<number> {
    let remainingAfterQuarantine = 0;
    await this.runSerialized(async () => {
      const currentOutbox = await this.db.getOutbox();
      const unitIds = new Set(failedUnit.map((m) => m.mutationId));
      const idsToRemove: string[] = [];
      let nextSnap = this.snapshot;
      let needsFullResync = false;
      const byMutId = new Map<string, SyncRejection>(this.rejections.map((r) => [r.mutationId, r]));
      const rejectedAt = new Date().toISOString();
      for (const singleFailed of failedUnit) {
        const isCreate =
          singleFailed.isNewRecord !== undefined
            ? singleFailed.isNewRecord
            : singleFailed.op === 'upsert' &&
              (singleFailed.baseVersion === null || singleFailed.baseVersion === 0);
        idsToRemove.push(singleFailed.mutationId);
        let preservedPayload = singleFailed.payload;
        const heldFollowUps: SyncMutation[] = [];
        const key = `${singleFailed.entity}:${singleFailed.recordId}`;
        for (const m of currentOutbox) {
          if (unitIds.has(m.mutationId) || `${m.entity}:${m.recordId}` !== key) continue;
          if (idsToRemove.includes(m.mutationId)) continue;
          idsToRemove.push(m.mutationId);
          if (isCreate) {
            if (m.op === 'upsert' && m.payload) {
              preservedPayload = m.payload;
            }
          } else {
            // M6 (same as R6): later edits of this record were built on top of the quarantined value;
            // sending them would write it to the server. Hold them for review and re-pull the cloud copy.
            heldFollowUps.push(m);
          }
        }
        if (isCreate) {
          nextSnap = this.removeRecordFromSnapshot(nextSnap, singleFailed.entity, singleFailed.recordId);
        } else {
          needsFullResync = true;
        }
        byMutId.set(singleFailed.mutationId, {
          mutationId: singleFailed.mutationId,
          entity: singleFailed.entity,
          op: singleFailed.op,
          recordId: singleFailed.recordId,
          isNewRecord: isCreate,
          resolutionStatus: 'quarantined',
          reason: `多次同步失敗已自動移出待上傳佇列：${msg}`,
          clientPayload: preservedPayload,
          rejectedAt,
        });
        for (const dep of heldFollowUps) {
          byMutId.set(dep.mutationId, {
            mutationId: dep.mutationId,
            entity: dep.entity,
            op: dep.op,
            recordId: dep.recordId,
            isNewRecord: false,
            resolutionStatus: 'held_after_reject',
            reason:
              '前一筆編輯多次同步失敗已移出佇列，這筆後續編輯包含該內容，已暫停送出並還原雲端資料；如仍需要請參考內容重新輸入',
            ...(dep.payload ? { clientPayload: dep.payload } : {}),
            rejectedAt,
          });
        }
      }
      // Review R-D: queued members of any atomic group touched by this quarantine are held as a whole
      const seed = currentOutbox.filter((m) => idsToRemove.includes(m.mutationId));
      const groupExtras = this.collectHeldClosure(
        [...failedUnit, ...seed],
        currentOutbox,
        new Set(idsToRemove)
      );
      for (const dep of groupExtras) {
        idsToRemove.push(dep.mutationId);
        byMutId.set(dep.mutationId, this.heldGroupRejection(dep, rejectedAt));
        needsFullResync = true;
      }
      const nextMeta: LocalMeta = {
        ...this.meta,
        ...(needsFullResync ? { pendingFullResync: true } : {}),
      };
      const nextRejections = Array.from(byMutId.values());
      await this.db.quarantineOutboxMutation(idsToRemove, nextSnap, nextMeta, nextRejections);
      this.snapshot = nextSnap;
      this.meta = nextMeta;
      this.rejections = nextRejections;
      remainingAfterQuarantine = (await this.db.getOutbox()).length;
      this.emitSnapshot();
      this.broadcastDbChanged();
      this.updateStatus(this.computeStatus(remainingAfterQuarantine));
    });
    return remainingAfterQuarantine;
  }

  /**
   * Review R-D (v1.8.12): when mutations are held / rolled back / quarantined, every still-queued member of the
   * same atomic group must go with them (and, transitively, later mutations of any record held that way),
   * otherwise the other leg of a transfer would be sent alone. `seed` items are treated as coming first.
   */
  private collectHeldClosure(seed: SyncMutation[], pool: SyncMutation[], excluded: ReadonlySet<string>): SyncMutation[] {
    const held = new Map<string, { m: SyncMutation; idx: number }>();
    for (const m of seed) held.set(m.mutationId, { m, idx: -1 });
    const extras: SyncMutation[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      pool.forEach((m, idx) => {
        if (excluded.has(m.mutationId) || held.has(m.mutationId)) return;
        const key = `${m.entity}:${m.recordId}`;
        for (const h of held.values()) {
          const sameGroup = Boolean(m.atomicGroupId) && h.m.atomicGroupId === m.atomicGroupId;
          const laterSameRecord = `${h.m.entity}:${h.m.recordId}` === key && h.idx < idx;
          if (sameGroup || laterSameRecord) {
            held.set(m.mutationId, { m, idx });
            extras.push(m);
            changed = true;
            return;
          }
        }
      });
    }
    return extras;
  }

  private heldGroupRejection(dep: SyncMutation, rejectedAt: string): SyncRejection {
    const isCreate =
      dep.isNewRecord !== undefined
        ? dep.isNewRecord
        : dep.op === 'upsert' && (dep.baseVersion === null || dep.baseVersion === 0);
    return {
      mutationId: dep.mutationId,
      entity: dep.entity,
      op: dep.op,
      recordId: dep.recordId,
      isNewRecord: isCreate,
      resolutionStatus: 'held_after_reject',
      reason:
        '同一筆轉帳（或同一筆紀錄）的另一部分未能同步，為避免只成立一邊，這筆已暫停送出並還原雲端資料；如仍需要請參考內容重新輸入',
      ...(dep.payload ? { clientPayload: dep.payload } : {}),
      rejectedAt,
    };
  }

  private removeRecordFromSnapshot(
    snap: FinanceSnapshot,
    entity: string,
    recordId: string
  ): FinanceSnapshot {
    switch (entity) {
      case 'ledger':
        return {
          ...snap,
          ledgers: ensureActiveLedgers((snap.ledgers || []).filter((l) => l.id !== recordId)),
        };
      case 'cashflow':
        return { ...snap, cashflowLogs: snap.cashflowLogs.filter((c) => c.id !== recordId) };
      case 'recurring':
        return { ...snap, recurringItems: snap.recurringItems.filter((r) => r.id !== recordId) };
      case 'sinking':
        return { ...snap, sinkingItems: snap.sinkingItems.filter((s) => s.id !== recordId) };
      case 'asset':
        return { ...snap, assetItems: snap.assetItems.filter((a) => a.id !== recordId) };
      case 'savings_adjustment':
        return {
          ...snap,
          savingsAdjustments: (snap.savingsAdjustments || []).filter((a) => a.id !== recordId),
        };
      case 'stock_tx':
        return {
          ...snap,
          stockTransactions: (snap.stockTransactions || []).filter((t) => t.id !== recordId),
        };
      case 'utility_record':
        return {
          ...snap,
          rentUtilityRecords: (snap.rentUtilityRecords || []).filter((u) => u.period !== recordId),
        };
      default:
        return snap;
    }
  }

  private mergeDelta(current: FinanceSnapshot, delta: SyncDelta, isFull: boolean): FinanceSnapshot {
    const incomingLedgers = Array.isArray(delta.ledgers) ? delta.ledgers : [];
    const incomingUtilityRecords = Array.isArray(delta.rentUtilityRecords) ? delta.rentUtilityRecords : [];
    const incomingUtilityRents = delta.rentUtilityRents || current.rentUtilityRents;
    const incomingAdjs = delta.savingsAdjustments || [];
    const incomingStockTxs = delta.stockTransactions || [];
    if (isFull) {
      const fullLedgers = ensureActiveLedgers(
        incomingLedgers.length > 0 ? incomingLedgers.filter((l) => !l.deletedAt) : [createDefaultLedger()]
      );
      return {
        settings: delta.settings || current.settings,
        ledgers: fullLedgers,
        cashflowLogs: this.sortCashFlows(delta.cashflowLogs.filter((l) => !l.deletedAt)),
        recurringItems: delta.recurringItems.filter((r) => !r.deletedAt).sort(compareBySortOrder),
        sinkingItems: delta.sinkingItems.filter((s) => !s.deletedAt).sort(compareBySortOrder),
        assetItems: delta.assetItems.filter((a) => !a.deletedAt).sort(compareBySortOrder),
        savingsAdjustments: incomingAdjs
          .filter((a) => !a.deletedAt)
          .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
        stockTransactions: incomingStockTxs
          .filter((t) => !t.deletedAt)
          .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
        netWorthHistory: delta.netWorthHistory
          .slice()
          .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth)),
        rentUtilityRecords: sortUtilityRecords(incomingUtilityRecords),
        rentUtilityRents: incomingUtilityRents,
      };
    }

    const historyMap = new Map(current.netWorthHistory.map((h) => [h.yearMonth, h]));
    for (const h of delta.netWorthHistory) {
      historyMap.set(h.yearMonth, h);
    }

    const mergedLedgers = ensureActiveLedgers(
      mergeById(ensureActiveLedgers(current.ledgers), incomingLedgers).sort(compareBySortOrder)
    );

    return {
      settings: delta.settings || current.settings,
      ledgers: mergedLedgers,
      cashflowLogs: this.sortCashFlows(mergeById(current.cashflowLogs, delta.cashflowLogs)),
      recurringItems: mergeById(current.recurringItems, delta.recurringItems).sort(compareBySortOrder),
      sinkingItems: mergeById(current.sinkingItems, delta.sinkingItems).sort(compareBySortOrder),
      assetItems: mergeById(current.assetItems, delta.assetItems).sort(compareBySortOrder),
      savingsAdjustments: mergeById(current.savingsAdjustments || [], incomingAdjs).sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      ),
      stockTransactions: mergeById(current.stockTransactions || [], incomingStockTxs).sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      ),
      netWorthHistory: Array.from(historyMap.values()).sort((a, b) =>
        b.yearMonth.localeCompare(a.yearMonth)
      ),
      rentUtilityRecords: mergeUtilityRecords(current.rentUtilityRecords || [], incomingUtilityRecords),
      rentUtilityRents: incomingUtilityRents,
    };
  }
}
