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
      fxUpdatedAt: null,
      pnlColorScheme: DEFAULT_PNL_COLOR_SCHEME,
      customStockCategories: [],
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
  };
}

export interface LocalMeta {
  lastSyncedAt: string | null;
  pinEnabled: boolean;
  pinSalt: string | null;
  pinHash: string | null;
  biometricLockEnabled?: boolean;
  passkeys?: CachedPasskeyDto[];
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async saveSnapshot(snapshot: FinanceSnapshot): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(snapshot, 'snapshot');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
      tx.objectStore(STORE_KV).put(meta, 'meta');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
    });
  }

  private outboxSeq = 0;

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

  /**
   * 單一 IndexedDB 交易同時更新本機 Snapshot 並加入 Outbox，並自動整併同一筆紀錄的離線多次修改
   * （保留最初的伺服器 baseVersion；新建未同步後立即刪除則互相抵銷）
   */
  async commitLocalMutation(snapshot: FinanceSnapshot, mutations: SyncMutation[]): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      tx.objectStore(STORE_KV).put(snapshot, 'snapshot');
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      const getAllReq = outboxStore.getAll();

      getAllReq.onsuccess = () => {
        const existingList = (getAllReq.result as Array<SyncMutation & { _seq?: number }>) || [];
        const byKey = new Map<string, SyncMutation & { _seq?: number }>();
        for (const item of existingList) {
          byKey.set(`${item.entity}:${item.recordId}`, item);
        }

        for (const mut of mutations) {
          const key = `${mut.entity}:${mut.recordId}`;
          const prev = byKey.get(key);
          if (prev) {
            outboxStore.delete(prev.mutationId);
            const prevIsNewUnsynced = prev.op === 'upsert' && (prev.baseVersion === null || prev.baseVersion === 0);
            if (prevIsNewUnsynced && mut.op === 'delete') {
              // Brand-new offline record deleted before ever syncing -> cancel out completely
              byKey.delete(key);
              continue;
            }
            // Coalesce while preserving the original server baseVersion
            this.outboxSeq += 1;
            const coalesced: SyncMutation & { _seq: number } = {
              ...mut,
              baseVersion: prev.baseVersion !== undefined ? prev.baseVersion : mut.baseVersion,
              _seq: this.outboxSeq,
            };
            outboxStore.put(coalesced);
            byKey.set(key, coalesced);
          } else {
            this.outboxSeq += 1;
            const record = { ...mut, _seq: this.outboxSeq };
            outboxStore.put(record);
            byKey.set(key, record);
          }
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async acknowledgeOutboxAndSave(
    ackedIds: string[],
    snapshot: FinanceSnapshot,
    meta: LocalMeta,
    conflicts?: SyncConflict[],
    rejections?: SyncRejection[]
  ): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      for (const id of ackedIds) {
        outboxStore.delete(id);
      }
      const kv = tx.objectStore(STORE_KV);
      kv.put(snapshot, 'snapshot');
      kv.put(meta, 'meta');
      if (conflicts !== undefined) {
        kv.put(conflicts, 'conflicts');
      }
      if (rejections !== undefined) {
        kv.put(rejections, 'rejections');
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
    });
  }
}
