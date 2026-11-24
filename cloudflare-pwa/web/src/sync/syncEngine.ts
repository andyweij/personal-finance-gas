import { RECURRING_CASHFLOW_TYPES } from '../../../shared/constants';
import type {
  AssetItem,
  CashFlowLog,
  FinanceSnapshot,
  RecurringItem,
  SinkingFundItem,
  SyncDelta,
  SyncMutation,
  SyncResponse,
} from '../../../shared/types';
import {
  validateAssetInput,
  validateCashFlowInput,
  validateRecurringInput,
  validateSinkingInput,
  type AssetInputPayload,
  type CashFlowInputPayload,
  type RecurringInputPayload,
  type SinkingInputPayload,
} from '../../../shared/validation';
import { createEmptySnapshot, type LocalFinanceDB, type LocalMeta } from '../db/localDb';

export type SyncStateKind = 'synced' | 'syncing' | 'pending' | 'offline' | 'auth_required';

export interface SyncStatus {
  state: SyncStateKind;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError?: string;
}

export interface SyncEngineOptions {
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  onStatusChange?: (status: SyncStatus) => void;
  onSnapshotChange?: (snapshot: FinanceSnapshot) => void;
  onAuthRequired?: () => void;
}

function mergeById<T extends { id: string; deletedAt?: string | null; updatedAt: string }>(
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
      if (!existing || item.updatedAt >= existing.updatedAt) {
        map.set(item.id, item);
      }
    }
  }
  return Array.from(map.values());
}

export class SyncEngine {
  private snapshot: FinanceSnapshot = createEmptySnapshot();
  private meta: LocalMeta = {
    lastSyncedAt: null,
    pinEnabled: false,
    pinSalt: null,
    pinHash: null,
  };
  private status: SyncStatus = {
    state: 'synced',
    pendingCount: 0,
    lastSyncedAt: null,
  };
  private syncingPromise: Promise<{ ok: boolean; authRequired?: boolean; error?: string }> | null =
    null;

  private readonly fetchImpl: typeof fetch;
  private readonly isOnline: () => boolean;

  constructor(
    private readonly db: LocalFinanceDB,
    private readonly opts: SyncEngineOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl || ((input, init) => fetch(input, init));
    this.isOnline =
      opts.isOnline ||
      (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
  }

  async init(): Promise<void> {
    await this.db.open();
    this.snapshot = await this.db.getSnapshot();
    this.meta = await this.db.getMeta();
    const outbox = await this.db.getOutbox();
    this.updateStatus({
      state: !this.isOnline() ? 'offline' : outbox.length > 0 ? 'pending' : 'synced',
      pendingCount: outbox.length,
      lastSyncedAt: this.meta.lastSyncedAt,
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

  async updateLocalPinCache(pinEnabled: boolean, pinSalt: string | null, pinHash: string | null): Promise<void> {
    this.meta = { ...this.meta, pinEnabled, pinSalt, pinHash };
    await this.db.saveMeta(this.meta);
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
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      nextRecurring = [...nextRecurring, recItem];
      mutations.push({
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId: recId,
        clientTimestamp: nowIso,
        payload: { ...recItem },
      });
    }

    this.snapshot = {
      ...this.snapshot,
      cashflowLogs: this.sortCashFlows([record, ...this.snapshot.cashflowLogs]),
      recurringItems: nextRecurring,
    };

    await this.commitAndMaybeSync(mutations);
    return record;
  }

  async deleteCashFlow(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.snapshot = {
      ...this.snapshot,
      cashflowLogs: this.snapshot.cashflowLogs.filter((l) => l.id !== id),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'cashflow',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
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
    this.snapshot = {
      ...this.snapshot,
      settings: {
        ...this.snapshot.settings,
        monthlyDailyBudget: budget,
        emergencyTargetMonths: months,
        updatedAt: nowIso,
      },
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'settings',
        op: 'upsert',
        recordId: '1',
        clientTimestamp: nowIso,
        payload: { ...this.snapshot.settings },
      },
    ]);
  }

  async saveRecurring(payload: RecurringInputPayload & { id?: string }): Promise<RecurringItem> {
    const v = validateRecurringInput(payload);
    const nowIso = new Date().toISOString();
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.recurringItems.find((r) => r.id === id);
    const item: RecurringItem = {
      id,
      ...v,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    };
    this.snapshot = {
      ...this.snapshot,
      recurringItems: mergeById(this.snapshot.recurringItems, [item]),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        payload: { ...item },
      },
    ]);
    return item;
  }

  async deleteRecurring(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.snapshot = {
      ...this.snapshot,
      recurringItems: this.snapshot.recurringItems.filter((r) => r.id !== id),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
      },
    ]);
  }

  async saveSinking(payload: SinkingInputPayload & { id?: string }): Promise<SinkingFundItem> {
    const v = validateSinkingInput(payload);
    const nowIso = new Date().toISOString();
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.sinkingItems.find((s) => s.id === id);
    const item: SinkingFundItem = {
      id,
      ...v,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    };
    this.snapshot = {
      ...this.snapshot,
      sinkingItems: mergeById(this.snapshot.sinkingItems, [item]),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        payload: { ...item },
      },
    ]);
    return item;
  }

  async deleteSinking(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.snapshot = {
      ...this.snapshot,
      sinkingItems: this.snapshot.sinkingItems.filter((s) => s.id !== id),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
      },
    ]);
  }

  async saveAsset(payload: AssetInputPayload & { id?: string }): Promise<AssetItem> {
    const v = validateAssetInput(payload);
    const nowIso = new Date().toISOString();
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.assetItems.find((a) => a.id === id);
    const item: AssetItem = {
      id,
      ...v,
      unitPrice: payload.unitPrice !== undefined ? v.unitPrice : existing?.unitPrice ?? 1,
      priceUpdatedAt: existing?.priceUpdatedAt ?? null,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    };
    this.snapshot = {
      ...this.snapshot,
      assetItems: mergeById(this.snapshot.assetItems, [item]),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        payload: { ...item },
      },
    ]);
    return item;
  }

  async deleteAsset(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.snapshot = {
      ...this.snapshot,
      assetItems: this.snapshot.assetItems.filter((a) => a.id !== id),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
      },
    ]);
  }

  private async commitAndMaybeSync(mutations: SyncMutation[]): Promise<void> {
    await this.db.commitLocalMutation(this.snapshot, mutations);
    const outbox = await this.db.getOutbox();
    this.emitSnapshot();
    this.updateStatus({
      state: this.isOnline() ? 'pending' : 'offline',
      pendingCount: outbox.length,
      lastSyncedAt: this.meta.lastSyncedAt,
    });
  }

  /* ==================== Bidirectional Sync ==================== */

  async syncNow(forceFullPull = false): Promise<{ ok: boolean; authRequired?: boolean; error?: string }> {
    if (this.syncingPromise) return this.syncingPromise;

    this.syncingPromise = this.performSync(forceFullPull).finally(() => {
      this.syncingPromise = null;
    });
    return this.syncingPromise;
  }

  private async performSync(
    forceFullPull: boolean
  ): Promise<{ ok: boolean; authRequired?: boolean; error?: string }> {
    const outbox = await this.db.getOutbox();

    if (!this.isOnline()) {
      this.updateStatus({
        state: 'offline',
        pendingCount: outbox.length,
        lastSyncedAt: this.meta.lastSyncedAt,
      });
      return { ok: false, error: '目前處於離線模式' };
    }

    this.updateStatus({
      state: 'syncing',
      pendingCount: outbox.length,
      lastSyncedAt: this.meta.lastSyncedAt,
    });

    try {
      const res = await this.fetchImpl('/api/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          since: forceFullPull ? null : this.meta.lastSyncedAt,
          mutations: outbox,
        }),
      });

      if (res.status === 401) {
        // Keep outbox safely in IndexedDB and notify caller to re-authenticate
        this.updateStatus({
          state: 'auth_required',
          pendingCount: outbox.length,
          lastSyncedAt: this.meta.lastSyncedAt,
          lastError: '登入逾時，請重新驗證以同步待上傳資料',
        });
        this.opts.onAuthRequired?.();
        return { ok: false, authRequired: true };
      }

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `同步失敗 (${res.status})`);
      }

      const data = (await res.json()) as SyncResponse;
      const merged = this.mergeDelta(this.snapshot, data.delta, forceFullPull);
      this.snapshot = merged;
      this.meta = {
        ...this.meta,
        lastSyncedAt: data.serverTime,
      };

      await this.db.acknowledgeOutboxAndSave(data.ackedMutationIds || [], this.snapshot, this.meta);
      const remainingOutbox = await this.db.getOutbox();
      this.emitSnapshot();
      this.updateStatus({
        state: remainingOutbox.length > 0 ? 'pending' : 'synced',
        pendingCount: remainingOutbox.length,
        lastSyncedAt: this.meta.lastSyncedAt,
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '網路同步失敗';
      this.updateStatus({
        state: !this.isOnline() ? 'offline' : 'pending',
        pendingCount: outbox.length,
        lastSyncedAt: this.meta.lastSyncedAt,
        lastError: msg,
      });
      return { ok: false, error: msg };
    }
  }

  private mergeDelta(current: FinanceSnapshot, delta: SyncDelta, isFull: boolean): FinanceSnapshot {
    if (isFull) {
      return {
        settings: delta.settings || current.settings,
        cashflowLogs: this.sortCashFlows(delta.cashflowLogs.filter((l) => !l.deletedAt)),
        recurringItems: delta.recurringItems.filter((r) => !r.deletedAt),
        sinkingItems: delta.sinkingItems.filter((s) => !s.deletedAt),
        assetItems: delta.assetItems.filter((a) => !a.deletedAt),
        netWorthHistory: delta.netWorthHistory
          .slice()
          .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth)),
      };
    }

    const historyMap = new Map(current.netWorthHistory.map((h) => [h.yearMonth, h]));
    for (const h of delta.netWorthHistory) {
      historyMap.set(h.yearMonth, h);
    }

    return {
      settings: delta.settings || current.settings,
      cashflowLogs: this.sortCashFlows(mergeById(current.cashflowLogs, delta.cashflowLogs)),
      recurringItems: mergeById(current.recurringItems, delta.recurringItems),
      sinkingItems: mergeById(current.sinkingItems, delta.sinkingItems),
      assetItems: mergeById(current.assetItems, delta.assetItems),
      netWorthHistory: Array.from(historyMap.values()).sort((a, b) =>
        b.yearMonth.localeCompare(a.yearMonth)
      ),
    };
  }
}
