import {
  DEFAULT_EMERGENCY_MONTHS,
  DEFAULT_MONTHLY_DAILY_BUDGET,
  DEFAULT_USD_TWD_RATE,
} from '../../../shared/constants';
import type { FinanceSnapshot, SyncMutation } from '../../../shared/types';

const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_OUTBOX = 'outbox';

export function createEmptySnapshot(): FinanceSnapshot {
  return {
    settings: {
      monthlyDailyBudget: DEFAULT_MONTHLY_DAILY_BUDGET,
      emergencyTargetMonths: DEFAULT_EMERGENCY_MONTHS,
      usdTwdRate: DEFAULT_USD_TWD_RATE,
      fxUpdatedAt: null,
      updatedAt: '',
    },
    cashflowLogs: [],
    recurringItems: [],
    sinkingItems: [],
    assetItems: [],
    netWorthHistory: [],
  };
}

export interface LocalMeta {
  lastSyncedAt: string | null;
  pinEnabled: boolean;
  pinSalt: string | null;
  pinHash: string | null;
}

export class LocalFinanceDB {
  private db: IDBDatabase | null = null;

  constructor(private readonly dbName = 'personal-finance-pwa-db') {}

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

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error('LocalFinanceDB is not open');
    return this.db;
  }

  async getSnapshot(): Promise<FinanceSnapshot> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get('snapshot');
      req.onsuccess = () => resolve((req.result as FinanceSnapshot) || createEmptySnapshot());
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
   * 單一 IndexedDB 交易同時更新本機 Snapshot 並加入 Outbox，確保離線寫入具原子性
   */
  async commitLocalMutation(snapshot: FinanceSnapshot, mutations: SyncMutation[]): Promise<void> {
    const db = this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_KV, STORE_OUTBOX], 'readwrite');
      tx.objectStore(STORE_KV).put(snapshot, 'snapshot');
      const outboxStore = tx.objectStore(STORE_OUTBOX);
      for (const mut of mutations) {
        this.outboxSeq += 1;
        outboxStore.put({ ...mut, _seq: this.outboxSeq });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async acknowledgeOutboxAndSave(
    ackedIds: string[],
    snapshot: FinanceSnapshot,
    meta: LocalMeta
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
