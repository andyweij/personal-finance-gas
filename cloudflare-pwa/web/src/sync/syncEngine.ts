import { applySubsetReorder, compareBySortOrder } from '../../../shared/calculations';
import { CASHFLOW_TYPES, RECURRING_CASHFLOW_TYPES, STOCK_TX_TYPES } from '../../../shared/constants';
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
  SyncResponse,
} from '../../../shared/types';
import {
  normalizeCustomStockCategories,
  normalizePnlColorScheme,
  normalizeStockCategory,
  validateAssetInput,
  validateCashFlowInput,
  validateRecurringInput,
  validateSavingsAdjustmentInput,
  validateSinkingInput,
  validateStockTransactionInput,
  type AssetInputPayload,
  type CashFlowInputPayload,
  type RecurringInputPayload,
  type SavingsAdjustmentInputPayload,
  type SinkingInputPayload,
  type StockTransactionInputPayload,
} from '../../../shared/validation';
import { createEmptySnapshot, type LocalFinanceDB, type LocalMeta } from '../db/localDb';

export type SyncStateKind = 'synced' | 'syncing' | 'pending' | 'offline' | 'auth_required' | 'conflict';

export interface SyncStatus {
  state: SyncStateKind;
  pendingCount: number;
  conflictCount?: number;
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

export class SyncEngine {
  private snapshot: FinanceSnapshot = createEmptySnapshot();
  private meta: LocalMeta = {
    lastSyncedAt: null,
    pinEnabled: false,
    pinSalt: null,
    pinHash: null,
  };
  private conflicts: SyncConflict[] = [];
  private status: SyncStatus = {
    state: 'synced',
    pendingCount: 0,
    conflictCount: 0,
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
    this.conflicts = await this.db.getConflicts();
    const outbox = await this.db.getOutbox();
    this.updateStatus(this.computeStatus(outbox.length));
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

  private computeStatus(pendingCount: number, lastError?: string): SyncStatus {
    const conflictCount = this.conflicts.length;
    const state: SyncStateKind =
      conflictCount > 0
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
      lastSyncedAt: this.meta.lastSyncedAt,
      ...(lastError ? { lastError } : {}),
    };
  }

  async updateLocalPinCache(pinEnabled: boolean, pinSalt: string | null, pinHash: string | null): Promise<void> {
    this.meta = { ...this.meta, pinEnabled, pinSalt, pinHash };
    await this.db.saveMeta(this.meta);
  }

  async updateLocalBiometricCache(
    biometricLockEnabled: boolean,
    passkeys?: LocalMeta['passkeys']
  ): Promise<void> {
    this.meta = {
      ...this.meta,
      biometricLockEnabled,
      ...(passkeys !== undefined ? { passkeys } : {}),
    };
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
        baseVersion: null,
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

  private nextSortOrderFor<T extends { sortOrder?: number; deletedAt?: string | null }>(items: T[]): number {
    const active = items.filter((i) => !i.deletedAt);
    if (!active.length) return 1;
    const maxOrder = active.reduce((max, i) => Math.max(max, i.sortOrder ?? 0), 0);
    return maxOrder > 0 ? maxOrder + 1 : active.length + 1;
  }

  async deleteCashFlow(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.cashflowLogs.find((l) => l.id === id);
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
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...this.snapshot.settings },
      },
    ]);
  }

  async savePnlColorScheme(scheme: PnlColorScheme): Promise<PnlColorScheme> {
    const normalized = normalizePnlColorScheme(scheme);
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.settings.version;
    this.snapshot = {
      ...this.snapshot,
      settings: {
        ...this.snapshot.settings,
        pnlColorScheme: normalized,
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
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...this.snapshot.settings },
      },
    ]);
    return normalized;
  }

  async saveCustomStockCategories(categories: string[]): Promise<string[]> {
    const normalized = normalizeCustomStockCategories(categories);
    const nowIso = new Date().toISOString();
    const baseVersion = this.snapshot.settings.version;
    this.snapshot = {
      ...this.snapshot,
      settings: {
        ...this.snapshot.settings,
        customStockCategories: normalized,
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
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        payload: { ...this.snapshot.settings },
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
    this.snapshot = {
      ...this.snapshot,
      recurringItems: mergeById(this.snapshot.recurringItems, [item]).sort(compareBySortOrder),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'recurring',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
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
        payload: { ...item },
      }));
    this.snapshot = {
      ...this.snapshot,
      recurringItems: stampedItems,
    };
    await this.commitAndMaybeSync(mutations);
    return mutations.length;
  }

  async deleteRecurring(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.recurringItems.find((r) => r.id === id);
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
    this.snapshot = {
      ...this.snapshot,
      sinkingItems: mergeById(this.snapshot.sinkingItems, [item]).sort(compareBySortOrder),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'sinking',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
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
        payload: { ...item },
      }));
    this.snapshot = {
      ...this.snapshot,
      sinkingItems: stampedItems,
    };
    await this.commitAndMaybeSync(mutations);
    return mutations.length;
  }

  async deleteSinking(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.sinkingItems.find((s) => s.id === id);
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
        baseVersion: existing?.version ?? null,
      },
    ]);
  }

  async saveAsset(payload: AssetInputPayload & { id?: string }): Promise<AssetItem> {
    const v = validateAssetInput(payload);
    const nowIso = new Date().toISOString();
    const todayYmd = nowIso.slice(0, 10);
    const id = payload.id || crypto.randomUUID();
    const existing = this.snapshot.assetItems.find((a) => a.id === id);

    // If this is the first linked savings account, auto-promote as default
    const otherSavings = this.snapshot.assetItems.filter(
      (a) => !a.deletedAt && a.isLinkedSavings && a.id !== id
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

    const item: AssetItem = {
      id,
      ...v,
      unitPrice: payload.unitPrice !== undefined ? v.unitPrice : existing?.unitPrice ?? 1,
      costBasis: payload.costBasis !== undefined ? v.costBasis : existing?.costBasis ?? null,
      stockCategory:
        payload.stockCategory !== undefined ? v.stockCategory : existing?.stockCategory ?? '',
      priceUpdatedAt: existing?.priceUpdatedAt ?? null,
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
      isDefaultSavings && a.id !== id && a.isDefaultSavings
        ? { ...a, isDefaultSavings: false, updatedAt: nowIso }
        : a
    );
    this.snapshot = {
      ...this.snapshot,
      assetItems: mergeById(updatedAssets, [item]).sort(compareBySortOrder),
    };

    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
        payload: { ...item },
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
    this.snapshot = {
      ...this.snapshot,
      assetItems: mergeById(this.snapshot.assetItems, [updated]).sort(compareBySortOrder),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'asset',
        op: 'upsert',
        recordId: assetId,
        clientTimestamp: nowIso,
        baseVersion: existing.version ?? null,
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
        payload: { ...item },
      }));
    this.snapshot = {
      ...this.snapshot,
      assetItems: stampedItems,
    };
    await this.commitAndMaybeSync(mutations);
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
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    const keepAuto = opts?.disableAutoAmortize ? false : Boolean(existing.isAmortizingLoan);
    return this.saveAsset({
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
    const ymd = anchorDate || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    return this.saveAsset({
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
    this.snapshot = {
      ...this.snapshot,
      savingsAdjustments: [adj, ...this.snapshot.savingsAdjustments].sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      ),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'savings_adjustment',
        op: 'upsert',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: null,
        payload: { ...adj, currency },
      },
    ]);
    return adj;
  }

  async deleteSavingsAdjustment(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.savingsAdjustments.find((a) => a.id === id);
    this.snapshot = {
      ...this.snapshot,
      savingsAdjustments: this.snapshot.savingsAdjustments.filter((a) => a.id !== id),
    };
    await this.commitAndMaybeSync([
      {
        mutationId: crypto.randomUUID(),
        entity: 'savings_adjustment',
        op: 'delete',
        recordId: id,
        clientTimestamp: nowIso,
        baseVersion: existing?.version ?? null,
      },
    ]);
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
      payload: { ...tx },
    });

    this.snapshot = {
      ...this.snapshot,
      cashflowLogs: createdCashflow
        ? this.sortCashFlows([createdCashflow, ...this.snapshot.cashflowLogs])
        : this.snapshot.cashflowLogs,
      stockTransactions: [tx, ...(this.snapshot.stockTransactions || [])].sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      ),
    };

    await this.commitAndMaybeSync(mutations);
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

    this.snapshot = {
      ...this.snapshot,
      cashflowLogs: nextLogs,
      stockTransactions: (this.snapshot.stockTransactions || []).filter((t) => t.id !== id),
    };
    await this.commitAndMaybeSync(mutations);
  }

  async deleteAsset(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = this.snapshot.assetItems.find((a) => a.id === id);
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
      payload: { ...record },
    });

    this.snapshot = {
      ...this.snapshot,
      rentUtilityRecords: mergeUtilityRecords(this.snapshot.rentUtilityRecords, updates),
    };
    await this.commitAndMaybeSync(mutations);
    return record;
  }

  async deleteUtilityRecord(period: string): Promise<void> {
    const clean = String(period || '').trim();
    const target = this.snapshot.rentUtilityRecords.find((r) => r.period === clean);
    if (!target || target.isBaseline) {
      throw new Error('無法刪除起始表底或不存在的期別。');
    }
    const nowIso = new Date().toISOString();
    this.snapshot = {
      ...this.snapshot,
      rentUtilityRecords: this.snapshot.rentUtilityRecords.filter((r) => r.period !== clean),
    };
    await this.commitAndMaybeSync([
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
    this.snapshot = {
      ...this.snapshot,
      rentUtilityRents: nextRents,
    };
    await this.commitAndMaybeSync([
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

  private async commitAndMaybeSync(mutations: SyncMutation[]): Promise<void> {
    await this.db.commitLocalMutation(this.snapshot, mutations);
    const outbox = await this.db.getOutbox();
    this.emitSnapshot();
    this.updateStatus(this.computeStatus(outbox.length));
  }

  /* ==================== Conflict Resolution ==================== */

  private applyRecordToSnapshot(
    entity: SyncConflict['entity'],
    recordId: string,
    record: Record<string, unknown> | null,
    isDelete: boolean
  ): void {
    if (entity === 'settings') {
      if (record) this.snapshot = { ...this.snapshot, settings: record as unknown as AppSettings };
      return;
    }
    if (entity === 'utility_rents') {
      if (record) this.snapshot = { ...this.snapshot, rentUtilityRents: record as unknown as RentUtilityRents };
      return;
    }
    if (entity === 'cashflow') {
      const filtered = this.snapshot.cashflowLogs.filter((l) => l.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [record as unknown as CashFlowLog, ...filtered] : filtered;
      this.snapshot = { ...this.snapshot, cashflowLogs: this.sortCashFlows(next) };
      return;
    }
    if (entity === 'recurring') {
      const filtered = this.snapshot.recurringItems.filter((r) => r.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as RecurringItem] : filtered;
      this.snapshot = { ...this.snapshot, recurringItems: next.sort(compareBySortOrder) };
      return;
    }
    if (entity === 'sinking') {
      const filtered = this.snapshot.sinkingItems.filter((s) => s.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as SinkingFundItem] : filtered;
      this.snapshot = { ...this.snapshot, sinkingItems: next.sort(compareBySortOrder) };
      return;
    }
    if (entity === 'asset') {
      const filtered = this.snapshot.assetItems.filter((a) => a.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as AssetItem] : filtered;
      this.snapshot = { ...this.snapshot, assetItems: next.sort(compareBySortOrder) };
      return;
    }
    if (entity === 'savings_adjustment') {
      const filtered = this.snapshot.savingsAdjustments.filter((a) => a.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [record as unknown as SavingsAdjustment, ...filtered] : filtered;
      this.snapshot = {
        ...this.snapshot,
        savingsAdjustments: next.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
      };
      return;
    }
    if (entity === 'stock_tx') {
      const filtered = (this.snapshot.stockTransactions || []).filter((t) => t.id !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [record as unknown as StockTransaction, ...filtered] : filtered;
      this.snapshot = {
        ...this.snapshot,
        stockTransactions: next.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
      };
      return;
    }
    if (entity === 'utility_record') {
      const filtered = this.snapshot.rentUtilityRecords.filter((r) => r.period !== recordId);
      const next = !isDelete && record && !record.deletedAt ? [...filtered, record as unknown as RentUtilityRecord] : filtered;
      this.snapshot = { ...this.snapshot, rentUtilityRecords: sortUtilityRecords(next) };
    }
  }

  async resolveConflictKeepServer(mutationId: string): Promise<void> {
    const conflict = this.conflicts.find((c) => c.mutationId === mutationId);
    if (!conflict) return;

    this.conflicts = this.conflicts.filter((c) => c.mutationId !== mutationId);
    this.applyRecordToSnapshot(
      conflict.entity,
      conflict.recordId,
      conflict.serverRecord,
      !conflict.serverRecord || Boolean(conflict.serverRecord.deletedAt)
    );
    await this.db.saveSnapshot(this.snapshot);
    await this.db.saveConflicts(this.conflicts);
    const outbox = await this.db.getOutbox();
    this.emitSnapshot();
    this.updateStatus(this.computeStatus(outbox.length));
  }

  async resolveConflictKeepLocal(
    mutationId: string
  ): Promise<{ ok: boolean; authRequired?: boolean; error?: string }> {
    const conflict = this.conflicts.find((c) => c.mutationId === mutationId);
    if (!conflict) return { ok: true };

    const nowIso = new Date().toISOString();
    this.conflicts = this.conflicts.filter((c) => c.mutationId !== mutationId);

    const payloadWithVersion = conflict.clientPayload
      ? { ...conflict.clientPayload, updatedAt: nowIso, version: conflict.serverVersion }
      : undefined;

    this.applyRecordToSnapshot(
      conflict.entity,
      conflict.recordId,
      payloadWithVersion || null,
      conflict.op === 'delete'
    );

    const retryMutation: SyncMutation = {
      mutationId: crypto.randomUUID(),
      entity: conflict.entity,
      op: conflict.op,
      recordId: conflict.recordId,
      clientTimestamp: nowIso,
      baseVersion: conflict.serverVersion,
      ...(payloadWithVersion ? { payload: payloadWithVersion } : {}),
    };

    await this.db.saveConflicts(this.conflicts);
    await this.commitAndMaybeSync([retryMutation]);

    if (this.isOnline()) {
      return this.syncNow();
    }
    return { ok: true };
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
      this.updateStatus(this.computeStatus(outbox.length));
      return { ok: false, error: '目前處於離線模式' };
    }

    this.updateStatus({
      state: 'syncing',
      pendingCount: outbox.length,
      conflictCount: this.conflicts.length,
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
        this.updateStatus({
          state: 'auth_required',
          pendingCount: outbox.length,
          conflictCount: this.conflicts.length,
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
      const incomingConflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      if (incomingConflicts.length > 0) {
        const byKey = new Map<string, SyncConflict>();
        for (const c of this.conflicts) {
          byKey.set(`${c.entity}:${c.recordId}`, c);
        }
        for (const c of incomingConflicts) {
          byKey.set(`${c.entity}:${c.recordId}`, c);
        }
        this.conflicts = Array.from(byKey.values());
      }

      const merged = this.mergeDelta(this.snapshot, data.delta, forceFullPull);
      this.snapshot = merged;
      this.meta = {
        ...this.meta,
        lastSyncedAt: data.serverTime,
      };

      const outboxIdsToClear = [
        ...(data.ackedMutationIds || []),
        ...incomingConflicts.map((c) => c.mutationId),
      ];
      await this.db.acknowledgeOutboxAndSave(outboxIdsToClear, this.snapshot, this.meta, this.conflicts);
      const remainingOutbox = await this.db.getOutbox();
      this.emitSnapshot();
      this.updateStatus(this.computeStatus(remainingOutbox.length));
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '網路同步失敗';
      this.updateStatus(this.computeStatus(outbox.length, msg));
      return { ok: false, error: msg };
    }
  }

  private mergeDelta(current: FinanceSnapshot, delta: SyncDelta, isFull: boolean): FinanceSnapshot {
    const incomingUtilityRecords = Array.isArray(delta.rentUtilityRecords) ? delta.rentUtilityRecords : [];
    const incomingUtilityRents = delta.rentUtilityRents || current.rentUtilityRents;
    const incomingAdjs = delta.savingsAdjustments || [];
    const incomingStockTxs = delta.stockTransactions || [];
    if (isFull) {
      return {
        settings: delta.settings || current.settings,
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

    return {
      settings: delta.settings || current.settings,
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
