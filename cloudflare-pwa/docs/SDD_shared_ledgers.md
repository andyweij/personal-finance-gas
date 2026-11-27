# SDD 與安全審查：選擇性共同帳本（Phase 9 / `v2.0.0`）

> **適用範圍**：僅限 `cloudflare-pwa/`（不動根目錄 GAS 專案）
> **前置條件**：已完成 Phase 8（`v1.16.0` `worker/entityRegistry.ts` 重構），現行 `DB_SCHEMA_VERSION = '0024'`
> **目標版本**：`v2.0.0`（Migration `0025_shared_ledgers.sql`）
> **硬性約束**：嚴格維持 Cloudflare Free Tier（每次請求 ≤ 50 次 D1 查詢）、新資料表一律無 `DEFAULT 'owner'`、現有純個人帳本零效能衰退（+0 D1 查詢）、100% 離線優先與樂觀鎖一致性。

---

## 1. 產品定位與核心情境

現有多租戶架構（`v1.2.0` 起）提供「**100% 個人隔離**」：家人共用同一個部署網址，但彼此帳本完全獨立。**選擇性共同帳本（Optional Shared Ledgers）** 在**完全不破壞個人隱私與預設隔離**的前提下，允許使用者主動將特定**非預設帳本**（例如「家用公費」、「日本旅遊基金」、「情侶共同開銷」）分享給同一實例中已註冊的其他成員協作記帳。

### 1.1 核心原則
1. **預設仍為 100% 私有**：個人主帳本（`id = 'default'`）**永遠不可分享**；任何未開啟共用的自訂帳本維持純個人存取。
2. **顯式邀請與最小權限**：透過一次性高熵共用邀請碼（`SHL-XXXX-XXXX-XXXX`）加入，角色分為 `owner`（擁有者）、`editor`（可記帳編輯）、`viewer`（僅檢視）。
3. **不破壞管理員最小權限原則**：即使系統 `role = 'admin'` 的管理員，若未被邀請成為某共同帳本的成員，仍**完全無法透過任何 API 讀取或寫入**該共同帳本。
4. **個人淨值不誤算**：共同帳本對擁有者與新加入成員預設「**不計入個人總資產／淨值**」（`include_in_net_worth = 0`），每位成員可各自獨立決定是否納入自己的淨值視角。
5. **歸屬透明**：共同帳本內的紀錄保留「最後異動者」（`updated_by`），方便成員辨識每筆收支由誰登錄或修改。

---

## 2. 架構方案比較與決策

| 比較面向 | **方案 A：Owner-Anchored 帳本授權層（建議採用）** | 方案 B：獨立 `shared_*` 命名空間重寫全部 11 張表 |
| :--- | :--- | :--- |
| 資料存放位置 | 共同帳本資料沿用既有資料表，以 `user_id = owner_user_id` 與 `ledger_id = sharedLedgerId` 存放；新增 `ledger_members` 與 `ledger_invites` 控制授權與同步 | 重建全部 11 張業務表改以 `namespace_id` 為主鍵，區分個人與共享空間 |
| Migration 風險 | **極低**：僅新增 2 張中繼表 + 少量 nullable `updated_by` 欄位，不動既有資料列與主鍵 | **極高**：需重建全部既有業務表、索引、外鍵邏輯與 47 支測試 |
| 與 Phase 8 `entityRegistry` 相容度 | **100% 複用**：`applyRowEntityMutation` 僅需帶入 `storageUid = owner_user_id` 與 `actorUid = authUser.id` 並掛載原子成員守衛 | 需大幅改寫 `entityRegistry`、`automation.ts`、`market.ts` 與匯出入 |
| 未啟用共用之個人使用者成本 | **+0 D1 查詢**（於既有的 `ensureSyncBaseline` batch 順帶查詢 `ledger_members`） | 每次同步皆多查共享索引 |
| 啟用共用之成員同步成本 | **+1 次 D1 batch**（無論加入 1～5 個共同帳本，全部併入單一 `db.batch()` 查詢） | 每共享空間一次 batch |
| 排程與自動報價 | **零重複入帳**：固定收支、分期自動入帳與持股自動報價天然由 `owner_user_id` 的既有 Cron 統一執行一次 | 需另建共享排程佇列並防止多成員重複觸發 |
| 權限撤銷一致性 | SQL `WHERE` 內嵌原子 `EXISTS (SELECT 1 FROM ledger_members ... revoked_at IS NULL)`，徹底杜絕 TOCTOU 競態 | 同等 |

**結論**：採用 **方案 A（Owner-Anchored 帳本授權層）**，搭配獨立的 per-shared-ledger 游標映射（`sharedCursors`）與嚴格的跨帳本邊界守衛。

---

## 3. 資料模型與 Migration 設計（`migrations/0025_shared_ledgers.sql`）

> 所有新建資料表嚴格遵守 `v1.8.16` 規範：**不使用 `DEFAULT 'owner'`**。

### 3.1 新增資料表

#### 1. `ledger_members`（共同帳本成員與權限表）
```sql
CREATE TABLE IF NOT EXISTS ledger_members (
  ledger_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  member_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  include_in_net_worth INTEGER NOT NULL DEFAULT 0 CHECK (include_in_net_worth IN (0, 1)),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (ledger_id, member_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_members_member_active
  ON ledger_members (member_user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_ledger_members_owner_ledger
  ON ledger_members (owner_user_id, ledger_id, revoked_at);
```

**關鍵設計說明**：
- **全域唯一 `ledger_id`（針對已分享帳本）**：當擁有者將某帳本開啟共用時，伺服器強制檢查 `ledger_id != 'default'`，且該 `ledger_id` 在 `ledger_members` 中尚未被他人使用（若原帳本 ID 為極短舊 ID 或潛在碰撞，亦受 `PRIMARY KEY (ledger_id, member_user_id)` 與 `owner_user_id` 一致性檢查保護）。成員加入前亦檢查其個人 `ledgers` 表無相同 `id`（UUID 實務上零碰撞，但仍顯式防衛）。
- **軟撤銷（`revoked_at`）**：移除成員或成員主動退出時寫入 `revoked_at`，不直接刪除列，以便成員下次同步時能收到 `revokedSharedLedgerIds` 並安全清除本機 IndexedDB 快取。
- **每人獨立 `include_in_net_worth`**：成員於「帳本設定」調整是否納入個人淨值時，僅更新自己在 `ledger_members` 的偏好，互不干擾。
- **人數與帳本數上限（D1 預算防護）**：
  - 單一共同帳本最多 **10 位活躍成員**（`MAX_MEMBERS_PER_SHARED_LEDGER = 10`）。
  - 單一使用者最多加入 **5 個他人分享的共同帳本**（`MAX_JOINED_SHARED_LEDGERS = 5`），確保單次同步 batch 語句數完全可控。

#### 2. `ledger_invites`（一次性共同帳本邀請碼表）
```sql
CREATE TABLE IF NOT EXISTS ledger_invites (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_invites_owner_ledger
  ON ledger_invites (owner_user_id, ledger_id, created_at DESC);
```
- 沿用 `auth_invites` 的安全模式：產生 128-bit 隨機碼 `SHL-XXXX-XXXX-XXXX`，資料庫**僅存 SHA-256 雜湊**（`code_hash`），核銷採用單條原子條件更新：
  ```sql
  UPDATE ledger_invites
  SET used_by = ?, used_at = ?
  WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  ```

### 3.2 既有資料表最小擴充（異動歸屬欄位）
為顯示「誰記了這筆帳」，於可共享的資料列實體表新增可選欄位 `updated_by TEXT`（儲存 `actor_user_id`，未升級 DB 時自動省略、向下相容）：
- `cashflow_logs.updated_by`
- `asset_items.updated_by`
- `recurring_items.updated_by`
- `savings_adjustments.updated_by`
- `split_receivables.updated_by`
- `installment_plans.updated_by`

> 客戶端顯示名稱由 `sync` 回應附帶的 `sharedMembers`（僅含同一共同帳本內成員之 `{ userId, displayName, role }`，絕不洩漏帳號以外的敏感資訊）對照渲染，避免帳號改名時歷史資料名稱過時。

---

## 4. 共同帳本支援的實體範圍與邊界規則

| 實體 (`SyncEntity`) | 是否隨共同帳本同步 | `owner` 權限 | `editor` 權限 | `viewer` 權限 | 說明 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `ledger` | ✅ | 讀寫 / 改名 / 刪除 / 管理成員 | 唯讀 | 唯讀 | 刪除前須先撤銷所有其他成員且無關聯紀錄 |
| `cashflow` | ✅ | CRUD | CRUD | 唯讀 | `ledger_id = sharedLedgerId` |
| `asset` | ✅ | CRUD | CRUD | 唯讀 | 共同活存、共同信用卡等；`ledger_id = sharedLedgerId` |
| `savings_adjustment` | ✅ | CRUD | CRUD | 唯讀 | 僅限 `account_id` 屬於該共同帳本的活存帳戶 |
| `recurring` | ✅ | CRUD | CRUD | 唯讀 | 由擁有者 Cron 自動入帳一次，成員同步取得結果 |
| `split_receivable` | ✅ | CRUD | CRUD | 唯讀 | `ledger_id = sharedLedgerId` |
| `installment_plan` | ✅ | CRUD | CRUD | 唯讀 | 由擁有者 Cron 自動入帳分期 |
| `stock_tx` | ⬜（預設個人） | 僅個人 | — | — | 持股交易與成本計算涉及複雜個人稅務與配息月曆，V1 建議保留個人專屬（見待確認決策） |
| `settings` / `sinking` / `financial_goal` / `networth_history` / `utility_*` | ❌ 永不共享 | 僅個人 | — | — | 個人預算、目標、淨值歷史、水電模組嚴格保持私有 |

### 4.1 跨帳本資料隔離硬規則（Anti-Smuggling Invariants）
1. **禁止跨邊界搬移（No Ledger Boundary Crossing）**：
   - 已存在於個人帳本的紀錄，**不可**透過編輯 `ledgerId` 直接搬入共同帳本；反之亦然。
   - 已存在於共同帳本 A 的紀錄，**不可**改寫 `ledgerId` 搬往共同帳本 B。
   - 伺服器在 `prepareUpsert` 層級嚴格比對 `existing.ledger_id === incoming.ledgerId`（當任一方屬於共同帳本時直接 `RejectError`）。
2. **外鍵參照同域約束（Same-Scope Reference Guard）**：
   - 共同帳本內的 `cashflow.linkedAccountId`、`recurring.linkedAccountId`、`savings_adjustment.accountId`、`split_receivable.sourceAccountId`、`installment_plan.cardAccountId`，其指向的 `asset_items` **必須同時滿足** `user_id = owner_user_id AND ledger_id = sharedLedgerId AND deleted_at IS NULL`。
   - 徹底防止 `editor` 試圖將共同帳本收支連動到 `owner` 的**私人活存或私人信用卡**（防範透過餘額變動探測或篡改擁有者私人資產！）。
3. **原子群組同域約束**：
   - 同一個 `atomicGroupId`（例如帳戶互轉、拆帳、繳卡費）內的所有 mutations 必須屬於**同一個存取域**（全為個人，或全為同一個 `sharedLedgerId`），禁止混搭個人與共同帳本於同一原子群組。

---

## 5. 雙向同步協議與 D1 50-Query 預算證明

### 5.1 協議擴充（100% 向下相容舊客戶端）
- **Request（`SyncRequest`）**：
  - 新增選填 `sharedCursors?: Record<string, { sinceSeq: number; clientEpoch: number }>`（key 為 `ledgerId`）。
  - `SyncMutation` 新增選填 `sharedLedgerId?: string | null`（僅作為路由提示，**伺服器永遠重新查驗 `ledger_members` 以解析 `owner_user_id` 與 `role`**，絕不信任前端傳入的 owner 或 role）。
- **Response（`SyncResponse`）**：
  - 新增選填 `sharedLedgers?: SharedLedgerMeta[]`（每個活躍共同帳本的 `ledgerId`, `ownerUserId`, `ownerDisplayName`, `myRole`, `includeInNetWorth`, `members`, `changeSeq`, `dataEpoch`, `fullResyncRequired?`, `epochMismatch?`）。
  - 新增選填 `revokedSharedLedgerIds?: string[]`（通知客戶端立即清除已遭移除／退出之共同帳本本機快取）。
  - 共同帳本的資料列**直接併入對應的 `delta.*` 陣列**（前端 `FinanceSnapshot` 與全部 UI 計算函式如 `filterCashFlowsByLedgerScope` 幾乎無縫運作！），並以 `ledger.isShared`、`ledger.myRole` 標記區分。

### 5.2 多人並行編輯與樂觀鎖行為
- Alice（owner）與 Bob（editor）同時編輯共同帳本內同一筆 `cf_1`（`version = 1`）：
  1. Alice 先送出 → `UPDATE cashflow_logs SET ..., version = 2, change_seq = NEXT_SEQ(Alice), updated_by = Alice WHERE user_id = Alice AND id = 'cf_1' AND version = 1 AND EPOCH_GUARD(Alice) AND ledger_id = 'led_home'` → 成功（1 row changed）。
  2. Bob 後送出（`baseVersion = 1`）→ `WHERE version = 1` 命中 0 列 → 進入既有的 `VersionConflictError` 流程，回傳 Alice 最新版本（`serverVersion = 2`, `updatedByName = 'Alice'`），Bob 在前端既有衝突解決彈窗選擇「保留伺服器版」或「強制覆蓋」。
- **冪等性隔離**：
  - `sync_idempotency` 永遠記錄於 `actor_user_id`（操作者自己）名下，避免 Bob 與 Alice 的 `mutationId` 互相干擾，且請求開頭的單次 `alreadyApplied` 預查涵蓋全部個人與共享異動。
- **擁有者還原備份（`replace` Epoch 隔離）**：
  - 當擁有者 Alice 執行 `importFullSnapshot(..., 'replace')` 時，Alice 的 `data_epoch` 遞增。
  - Bob 下次同步帶著舊的 `sharedCursors[led_home].clientEpoch` → 伺服器**僅針對 `led_home`** 回報 `epochMismatch: true`（**不影響 Bob 自己的個人帳本同步！**），Bob 客戶端僅凍結 `led_home` 的待送出異動並重抓 `led_home` 全量快照。

### 5.3 D1 查詢預算證明（Free Tier ≤ 50 queries / invocation）

依據 [`worker/d1Budget.ts`](file:///c:/Users/User/Documents/workSpace/personal-finance-gas/cloudflare-pwa/worker/d1Budget.ts) 規則：**每次 `db.batch([...])` 計為 1 次 D1 查詢**。

| 情境 | `requireAuth` | `ensureSyncBaseline` | 預取 + Idempotency | 單筆 Mutation Commit | `readDeltaWithState` | 總 D1 查詢次數 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **無共同帳本（空拉取）** | 2 | 1（含 `ledger_members` 查無結果） | 0 | 0 | 1 | **4 次**（與 `v1.16.0` 完全相同，+0） |
| **加入 3 個共同帳本（空拉取）** | 2 | 1（查出 3 筆 membership） | 0 | 0 | 2（個人 1 batch + 全部 3 個共享帳本合併 1 batch） | **5 次**（僅 +1！） |
| **加入 3 個共同帳本 + 寫入 10 筆共享異動** | 2 | 1 | 1（合併預取） | 10（每筆 1 batch） | 2 | **16 次**（遠低於 50 上限） |

> 即使使用者達到上限 5 個共同帳本，單次 `readDeltaWithState` 的共享 batch 最多約 `5 × 7 = 35` 條 `SELECT` 語句（遠低於 D1 單次 batch 限制），且僅算 **1 次 D1 查詢**。`SYNC_TAIL_QUERY_RESERVE` 由 `3` 微調為 `4` 以預留共享 delta batch。

---

## 6. API 端點規劃（`worker/index.ts` + `worker/sharedLedgers.ts`）

所有端點皆掛載 `requireAuth`、CSRF 同源檢查與 `X-Expected-User` 409 防護：

| Method & Path | 權限 | 功能說明 |
| :--- | :--- | :--- |
| `GET /api/shared-ledgers` | 已登入 | 列出目前使用者擁有或加入的共同帳本清單、成員列表與（僅 owner 可見的）待使用邀請碼 |
| `POST /api/shared-ledgers/:ledgerId/invites` | 僅 `owner` | 為指定非預設帳本產生一次性邀請碼（`SHL-XXXX-XXXX-XXXX`，指定 `role: 'editor' \| 'viewer'`、有效天數預設 7 天、備註）；若帳本尚未啟用共用，原子建立 owner 的 `ledger_members` 紀錄 |
| `DELETE /api/shared-ledgers/:ledgerId/invites/:inviteId` | 僅 `owner` | 作廢尚未使用的共用邀請碼 |
| `POST /api/shared-ledgers/join` | 已登入（限速保護） | 核銷一次性共用邀請碼加入共同帳本（比照登入限速：IP + user 雙重原子限速，防暴力猜碼） |
| `PATCH /api/shared-ledgers/:ledgerId/members/:memberUserId` | 僅 `owner` | 變更成員角色（`editor` ↔ `viewer`，不可降級 `owner` 自己） |
| `DELETE /api/shared-ledgers/:ledgerId/members/:memberUserId` | `owner` 移除他人，或成員移除自己（退出） | 軟撤銷成員資格（寫入 `revoked_at`），並立即使該成員下次同步清除本機快取 |
| `PATCH /api/shared-ledgers/:ledgerId/preferences` | 活躍成員 | 更新個人對該共同帳本的 `includeInNetWorth` 偏好（僅影響自己） |

---

## 7. 安全審查清單（Threat Model & Mitigations）

| 威脅編號 | 攻擊向量 / 風險場景 | 防禦機制（實作強制要求） |
| :--- | :--- | :--- |
| **SL-1 (IDOR / 跨租戶越權)** | 惡意成員偽造 `sharedLedgerId` 或竄改 `ownerUserId` 試圖讀寫他人未共享帳本或 `'default'` 主帳本 | 伺服器**完全無視**前端任何 `ownerUserId` / `role` 宣告；所有讀寫強制透過 `ledger_members WHERE ledger_id = ? AND member_user_id = authUser.id AND revoked_at IS NULL` 解析；`ledger_id === 'default'` 於 API 與 Sync 兩層雙重拒絕。 |
| **SL-2 (撤銷 TOCTOU 競態)** | Owner 移除成員瞬間，該成員同時送出寫入請求 | 每條共享寫入 SQL 的 `WHERE` 子句直接內嵌 `AND EXISTS (SELECT 1 FROM ledger_members WHERE ledger_id = ? AND owner_user_id = ? AND member_user_id = ? AND role IN ('owner', 'editor') AND revoked_at IS NULL)`，單一 D1 交易原子判生死。 |
| **SL-3 (權限提升 Viewer → Editor)** | `viewer` 直接打 `POST /api/sync` 送出 `upsert` / `delete` | Sync 進入點與 SQL `WHERE` 雙重驗證 `role IN ('owner', 'editor')`；對 `ledger` 本身（改名、刪除）進一步限定僅 `role = 'owner'`。 |
| **SL-4 (私人資產探測與連動污染)** | 共同帳本 `editor` 新增一筆收支，將 `linkedAccountId` 指向 `owner` 的**私人活存** ID | 共享寫入的 `refGuardSql` 強制附加 `AND ledger_id = ?`（必須屬於同一共同帳本），禁止任何共享紀錄連動至 `owner` 私人帳本的資產或帳戶。 |
| **SL-5 (跨帳本走私 / Exfiltration)** | 成員將共同帳本紀錄的 `ledgerId` 改為自己的個人帳本，或將私人紀錄搬入共同帳本 | `prepareUpsert` 強制禁止任何紀錄跨越「個人 ↔ 共享」或「共享 A ↔ 共享 B」的 `ledger_id` 變更。 |
| **SL-6 (邀請碼暴力猜解與重放)** | 惡意成員窮舉 `SHL-XXXX-XXXX-XXXX` 加入他人帳本 | 128-bit 密碼學隨機熵（~60+ bits 可讀字元組合）＋ SHA-256 雜湊儲存 ＋ `POST /api/shared-ledgers/join` 套用既有 `checkRateLimit`（IP + 帳號雙限速）＋ 單次原子核銷 `WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`。 |
| **SL-7 (被移除後殘留離線資料)** | 成員被踢出共同帳本，但離線快取仍看得到舊資料或誤送離線編輯 | 下次同步回應 `revokedSharedLedgerIds`，`SyncEngine` 立即從 IndexedDB 刪除該帳本全部快取資料列並隔離其待送異動；同時伺服器端已拒絕該成員任何後續同步寫入。 |
| **SL-8 (個人 JSON 備份覆蓋他人共享資料)** | 成員匯出 JSON 備份帶走他人共同帳本，或匯入個人備份意外覆蓋共同帳本 | 非擁有者的 `exportFullSnapshot` / `importFullSnapshot` **嚴格僅處理自己的個人帳本**（排除加入的他人共同帳本）；擁有者執行 `replace` 還原時遞增 `data_epoch` 並保留或明確提示共同帳本成員將重抓。 |
| **SL-9 (未遷移資料庫降級)** | Worker 先部署但 D1 尚未執行 `0025_shared_ledgers.sql` | 所有 `ledger_members` / `ledger_invites` 與 `updated_by` 查詢皆具備 `no such table` / `no such column` 偵測，未遷移時個人同步照常運作、僅共享操作回報明確的 0025 遷移提示。 |
| **SL-10 (XSS 防護)** | 共同帳本名稱、成員顯示名稱、邀請碼備註或他人填寫的消費品項含惡意 HTML | 所有顯示名稱、帳本徽章、成員清單與異動者標籤一律經 `escapeHtml()` 跳脫，嚴禁未跳脫注入 `innerHTML`。 |

---

## 8. 前端離線與 UI/UX 設計

1. **帳本切換器與識別徽章**：
   - 共同帳本顯示 `🤝` 圖示與角色標示（擁有者／編輯者／僅檢視），與個人帳本一眼區分。
   - 若目前切換至 `viewer` 權限的共同帳本，快速記帳／新增／編輯／刪除按鈕自動隱藏或顯示「唯讀共同帳本」提示橫幅。
2. **「帳本管理」擴充「🤝 成員與共用」管理彈窗**：
   - 個人非預設帳本：提供「開啟共用 / 產生邀請碼」按鈕，選擇角色（編輯者／僅檢視）與有效期限，一鍵複製邀請碼或連結（`/?joinLedger=SHL-...`，比照 `/?invite=` 流程且 Service Worker 不快取含邀請碼 URL）。
   - 「加入共同帳本」入口：輸入邀請碼預覽或直接加入，加入後立即觸發同步載入該共同帳本資料。
   - 成員列表：擁有者可切換成員角色（編輯者 ↔ 僅檢視）或移除成員；成員可調整「是否計入我的總淨值」開關或主動退出。
3. **紀錄歸屬顯示**：
   - 僅於共同帳本視圖下的流水帳列、資產卡片與固定收支列顯示精巧的「`由 <displayName> 記錄`」標籤，個人帳本畫面維持零干擾。
4. **`SyncEngine` & `LocalFinanceDB` 整合**：
   - `LocalMeta` 新增 `sharedCursors` 與 `sharedLedgers` 中繼資料。
   - 寫入共同帳本時自動附帶 `mutation.sharedLedgerId`；收到 `revokedSharedLedgerIds` 時單一 IndexedDB 交易內原子清除該帳本快取與其未送出 outbox（移入 `rejections` 供使用者檢視）。
   - `epochMismatch` 支援**單一共同帳本局部凍結與重抓**，不干擾個人帳本與其他共同帳本。

---

## 9. 分步實作計畫與 TDD 測試矩陣

實作順序嚴格遵循 TDD：

1. **Migration 與共享型別**：`migrations/0025_shared_ledgers.sql`、`shared/types.ts`、`shared/validation.ts`、`shared/constants.ts`。
2. **後端核心與授權引擎**：`worker/sharedLedgers.ts`（邀請碼產生／核銷／作廢、成員角色變更、移除／退出、個人淨值偏好）、`worker/sync.ts`（整合 `entityRegistry` 支援 `storageUid` / `actorUid`、原子成員守衛、同域參照檢查、合併 1-batch 共享 Delta 讀取與 `revokedSharedLedgerIds`）、`worker/index.ts`（掛載 7 個 `/api/shared-ledgers/*` 路由與限速）。
3. **前端同步與介面**：`web/src/db/localDb.ts`、`web/src/sync/syncEngine.ts`、`web/src/ui/sharedLedgerUi.ts`、帳本管理／快速記帳／唯讀守衛／歸屬顯示與 `sw.js`（不快取 `joinLedger` 參數）。
4. **完整測試與滲透測試套件（`tests/shared-ledgers.test.ts`）**：
   - **生命週期測試**：產生邀請碼 → 成員加入 → 雙方同步新增／編輯／刪除 → 樂觀鎖衝突解決 → 顯示 `updatedByName` → 角色切換 → 移除成員與本機快取清除。
   - **安全滲透測試（覆蓋 SL-1 ～ SL-9）**：
     - 拒絕分享 `'default'` 主帳本。
     - `viewer` 嘗試透過 `/api/sync` 寫入／刪除被拒；`editor` 嘗試修改／刪除帳本本身或管理成員被拒。
     - `editor` 嘗試將共同帳本收支連動至 `owner` 私人活存帳戶被拒（SL-4）。
     - 嘗試跨帳本搬移紀錄（個人 ↔ 共享、共享 A ↔ 共享 B）被拒（SL-5）。
     - 成員移除後立即寫入被 SQL 原子守衛拒絕（SL-2）。
     - 系統 `admin` 未受邀時無法讀取或寫入他人共同帳本。
     - 邀請碼過期、作廢、重複使用、暴力猜碼限速 429（SL-6）。
     - 非擁有者 JSON 匯出不含他人共同帳本（SL-8）。
     - 未套用 0025 遷移之資料庫降級測試（SL-9）。
   - **D1 查詢預算測試**：以 `createCountingD1` 驗證無共同帳本使用者 +0 查詢、加入 3 個共同帳本同步遠低於 50 次預算上限。
