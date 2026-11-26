# SDD：資料版本標記（樂觀鎖 `version`）與離線同步衝突解決機制

> 適用範圍：`cloudflare-pwa/`（不動根目錄 GAS 專案）
> 目標：根治多裝置離線編輯同一筆資料時的「靜默覆蓋（Lost Update）」、「靜默丟棄」與「裝置時鐘偏移」問題，透過伺服器單調遞增版號（`version`）精準偵測衝突，並提供清楚的差異對照與一鍵決策介面。

---

## 1. 核心設計原則

1. **不同筆資料維持 0ms 自動合併**：兩台裝置分別新增不同流水帳、修改不同資產，照常全自動無感同步。
2. **伺服器統一發放 `version` 與 `updated_at`**：
   - 9 張可同步資料表全面加入 `version INTEGER NOT NULL DEFAULT 1`。
   - 每次在 D1 寫入成功，伺服器自動執行 `version = version + 1`，並以 `serverTime` 作為 `updated_at`，**徹底消除跨裝置時鐘誤差**。
3. **樂觀鎖防覆蓋（Optimistic Locking）**：
   - 前端送出修改／刪除時，於 `SyncMutation` 附帶當時看到的 `baseVersion`。
   - 同步時若 `D1.version !== mutation.baseVersion`，伺服器**拒絕覆蓋**，將該筆移入 `SyncResponse.conflicts`（附上本機與雲端完整資料），**同批次其他無衝突帳目照常完成同步，不卡住佇列**。
4. **離線多次編輯自動合併（Outbox Coalescing）**：
   - 在離線期間連續修改同一筆紀錄多次，Outbox 會自動整併為單一 Mutation 並保留最初的伺服器 `baseVersion`（若離線新建後又立刻刪除，則直接互相抵銷）。
5. **衝突持久化與可視化處理**：
   - 未解決的衝突會持久化於 IndexedDB（關閉 App 不會遺失），頂部狀態膠囊顯示 **`⚠ 衝突 (N)`**。
   - 點擊開啟「同步衝突處理」彈窗，以**欄位差異表**呈現本機離線版 vs 雲端最新版，提供兩顆一鍵按鈕：
     - **採用雲端最新版**（直接套用雲端資料並解除衝突）
     - **保留本機離線版**（以雲端最新 `serverVersion` 重新送出，強制升版覆蓋雲端）
6. **完全向下相容**：若舊快取前端尚未帶 `baseVersion`，Worker 自動降級回原本時間戳記比對並同步遞增版號，升級過程零中斷。

---

## 2. D1 Migration（`migrations/0006_optimistic_versioning.sql`）

為全部 9 張可同步資料表補上 `version` 欄位（既有資料自動預設為 `1`）：

```sql
-- 0006_optimistic_versioning.sql: Server-managed optimistic locking version column
ALTER TABLE app_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cashflow_logs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recurring_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sinking_fund_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE asset_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE savings_adjustments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stock_transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rent_utility_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rent_utility_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

---

## 3. 共用型別擴充（`shared/types.ts`）

1. 所有 9 種同步資料介面新增選填 `version?: number;`（`AppSettings`、`CashFlowLog`、`RecurringItem`、`SinkingFundItem`、`AssetItem`、`SavingsAdjustment`、`StockTransaction`、`RentUtilityRecord`、`RentUtilityRents`）。
2. `SyncMutation` 新增：
   ```ts
   baseVersion?: number | null; // null/0 = 新建紀錄；>= 1 = 基於伺服器第 N 版修改或刪除
   ```
3. 新增 `SyncConflict` 與擴充 `SyncResponse`：
   ```ts
   export interface SyncConflict {
     mutationId: string;
     entity: SyncEntity;
     op: SyncOp;
     recordId: string;
     baseVersion: number;
     serverVersion: number;
     clientPayload?: Record<string, unknown>;
     serverRecord: Record<string, unknown> | null;
     detectedAt: string;
   }

   export interface SyncResponse {
     ok: boolean;
     serverTime: string;
     ackedMutationIds: string[];
     rejected: Array<{ mutationId: string; reason: string }>;
     conflicts?: SyncConflict[];
     delta: SyncDelta;
   }
   ```

---

## 4. Worker 同步協定升級（`worker/sync.ts`）

針對每一筆 `SyncMutation`：
1. 先依 `entity` + `recordId` 查詢 D1 目前該筆紀錄（含 `version` 與完整欄位）。
2. **版號比對邏輯**：
   - 若 D1 尚無此筆：
     - `upsert`：寫入 `version = 1`、`updated_at = serverTime`。
     - `delete`：無需寫入（直接視為成功 ack）。
   - 若 D1 已有此筆（現有版號 `v_server`）：
     - 若 `mutation.baseVersion !== undefined && mutation.baseVersion !== null`：
       - `mutation.baseVersion !== v_server` → 拋出內部 `VersionConflictError`，由 `processSyncRequest` 攔截並推入 `conflicts[]`（不覆蓋 D1、不寫入 `sync_idempotency`，並保留完整 `serverRecord` 回傳給前端對照）。
       - `mutation.baseVersion === v_server` → 執行寫入並將 `version = v_server + 1`、`updated_at = serverTime`。
     - 若 `mutation.baseVersion === undefined`（舊版相容）→ 維持 `isNewerOrEqual` 並升版 `v_server + 1`。
3. 針對 `settings` / `utility_rents` 單列設定表（`id = 1`），同樣套用 `baseVersion` 比對與 `version = version + 1`。
4. **額外保護**：`importFullSnapshot` 匯入時同步重置 `version = 1`，避免還原備份後版號異常。

---

## 5. 前端離線引擎與衝突解決（`localDb.ts`、`syncEngine.ts`、`conflictUi.ts`）

### 5.1 IndexedDB 擴充（`web/src/db/localDb.ts`）
- 在既有 `kv` store 新增 `'conflicts'` 鍵值存取（`getConflicts()` / `saveConflicts()`），不需升級 IndexedDB Schema Version，100% 無痛相容舊快取。
- 新增 `coalesceOutbox(incomingMutations)`：
  - 若 Outbox 已有同 `(entity, recordId)` 的待上傳變更：
    - `upsert(baseVersion=null) + delete` → 兩筆直接互相抵銷移除。
    - `upsert(baseVersion=X) + upsert` → 保留原 `baseVersion=X`，更新為最新 `payload` 與新 `mutationId`。
    - `upsert(baseVersion=X) + delete` → 保留原 `baseVersion=X`，改為 `op: 'delete'`。

### 5.2 SyncEngine 升級（`web/src/sync/syncEngine.ts`）
- 每個本地寫入方法（`saveAsset`、`saveRecurring`、`saveSinking`、`saveBudgetSettings`、`deleteCashFlow`、`saveUtilityRecord`、`saveStockTransaction` 等）皆自動填入 `baseVersion: existing ? (existing.version ?? 1) : null`。
- `SyncStateKind` 新增 `'conflict'`；`SyncStatus` 新增 `conflictCount: number`。
- `performSync` 收到 `data.conflicts` 時：
  - 將衝突的 `mutationId` 從 Outbox 移除並寫入持久化 `conflicts` 陣列（依 `entity + recordId` 去重，保留最新衝突）。
  - `mergeDelta` 合併時，若本機與雲端皆有 `version`，優先保留高版號紀錄。
- 新增兩個衝突處理 API：
  - `resolveConflictKeepServer(mutationId: string)`: 移除該筆衝突，將 `conflict.serverRecord` 直接套回本機快照。
  - `resolveConflictKeepLocal(mutationId: string)`: 移除該筆衝突，將原 `clientPayload` / `op` 以 `baseVersion = conflict.serverVersion` 重新排入 Outbox 並觸發同步。

### 5.3 前端衝突解決 UI（`web/src/ui/conflictUi.ts` + `main.ts`）
- 頂部同步膠囊（`#syncStatusPill`）：
  - 當 `status.conflictCount > 0` 時顯示琥珀／紅色警戒樣式 **`⚠ 衝突 (N)`**。
  - 點擊膠囊直接打開「**同步衝突處理**」彈窗（不再靜默重試）。
- 衝突彈窗內容：
  - 逐筆列出衝突項目（類別標籤、名稱、版號 `本機基於 vX vs 雲端 vY`）。
  - 自動比對本機與雲端欄位，**只列出有差異的欄位**（中文化欄位名稱：如「餘額／數量」、「年利率」、「備註」、「金額」、「狀態」等），若為刪除衝突則清楚標示「本機離線刪除此筆，但雲端已更新」。
  - 每筆提供「**採用雲端最新版**」與「**保留本機離線版**」兩顆按鈕，全部處理完自動關閉並同步。

---

## 6. TDD 測試規劃（先寫測試，再實作）

新增 **`tests/sync-versioning.test.ts`**：
1. **正常遞增與時鐘偏移免疫**：連續同步 3 次驗證 `version` 為 `1 → 2 → 3`，且即使裝置時鐘倒退 1 小時，正確 `baseVersion` 仍可正常更新不被誤丟棄。
2. **離線覆蓋防護（Conflict Detection）**：裝置 A 先線上更新資產 `v1 → v2`；裝置 B 離線基於 `v1` 編輯同一筆並同時新增另一筆新流水帳 → 同步後新流水帳成功寫入（acked），資產更新被攔截進 `conflicts[]`（`baseVersion: 1, serverVersion: 2`），D1 資料不被靜默覆蓋。
3. **衝突解決（保留本機 / 採用雲端）**：透過 `SyncEngine` 端到端測試 `resolveConflictKeepLocal`（成功升成 `v3`）與 `resolveConflictKeepServer`（恢復雲端 `v2` 且清空衝突）。
4. **Outbox 離線多次編輯整併**：同一筆 `v2` 紀錄離線連續改 2 次，Outbox 只留 1 筆且 `baseVersion` 維持 `2`；離線新建後立即刪除會互相抵銷為 0 筆。
5. **舊版相容性**：未帶 `baseVersion` 的 mutation 仍能安全寫入並正確升版。

---

## 7. 交付與升級提醒

- 新增 `migrations/0006_optimistic_versioning.sql`（部署前需跑 `npm run db:migrate:remote`）。
- Service Worker 快取版本升至 `finance-pwa-v9`。
- 不修改根目錄任何 GAS 檔案。

---

## 8. 演進補遺（v1.8.1～v1.8.2 同步正確性與安全性強化）

1. **原子條件式樂觀鎖與冪等批次（v1.8.1）**：所有寫入改為 `UPDATE ... WHERE user_id = ? AND <pk> = ? AND version = ?` 與 `INSERT ... ON CONFLICT DO NOTHING`，並與 `sync_idempotency`（搭配 `WHERE changes() > 0`）合併於單一 `db.batch()` 原子執行；未知 `entity`/`op` 白名單拒絕並於前端 `kv['rejections']` 呈現。
2. **In-Flight Rebase 與先存後改（v1.8.2）**：`LocalFinanceDB.commitLocalMutation` 排除同步中（in-flight）異動避免合併／誤抵銷，回應後針對所有實體自動 rebase 最新 `version`；所有 CRUD 改為先持久化 IndexedDB 成功後才更新記憶體快照。
3. **單調遞增 `change_seq` 與 `data_epoch`（`0013_sync_cursor_epoch_and_auto_fx.sql`）**：新增 `user_sync_state` 維護每使用者遞增 `change_seq`（增量同步以 `sinceSeq` 查 `change_seq > sinceSeq AND change_seq <= maxSeq`，向下相容舊 `since`）與 `data_epoch`（`replace` 覆蓋匯入自動遞增，強制其他裝置完整重載）；`updated_at` 一律寫入伺服器時間，舊版無 `baseVersion` 客戶端由 `sync_lww_timestamps` 維持 LWW 相容。
4. **跨帳號防護與傳輸強健性（v1.8.2）**：同步請求帶 `X-Expected-User`（帳號不符回 `409` 立即停止同步）並透過 `BroadcastChannel` 跨分頁同步帳號切換；支援 `AbortController`（20 秒逾時）、指數退避＋隨機抖動、單批 50 筆分批同步（伺服器上限 200 筆 / 2 MB）與 `navigator.locks` 跨分頁互斥；市價與匯率更新同步遞增 `version` 與 `change_seq`，並支援 `auto_fx_enabled` 讓手動匯率不被排程覆蓋。
