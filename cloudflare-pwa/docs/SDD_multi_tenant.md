# SDD：多租戶家庭版架構與嚴格資料隔離機制（方案 A：單一 D1 邏輯隔離）

> 適用範圍：`cloudflare-pwa/`（不動根目錄 GAS 專案）
> 目標：在維持 **Cloudflare 免費額度**的前提下，支援自己與家人使用同一組部署網址，實現 **100% 獨立帳本隔離**、**一次性邀請碼註冊**、**管理員無法知情的密碼重置**，並兼顧**免重打帳密的極簡登入與解鎖體驗**。

---

## 1. 登入與日常解鎖體驗設計（解決「不想每次都輸入帳密」）

多租戶後，日常體驗分為三層，**平常使用幾乎零打字**：

| 使用情境 | 實際操作 | 技術機制 |
| :--- | :--- | :--- |
| **99% 日常打開 App** | 直接進帳本，或**刷一下 Face ID / 點 4～6 碼 PIN** | 延續現有 **30 天滑動續期 `pf_session` Cookie**（每次使用自動延展 30 天）＋原本的離線 Face ID / PIN 鎖屏，完全不用重新輸入帳密。 |
| **Session 過期或新分頁登入（已綁 Passkey）** | 點「**使用 Face ID / Passkey 登入**」→ 刷臉一秒進入 | 升級為 **WebAuthn Discoverable Credential（`residentKey: 'required'`）**，Passkey 本身即綁定 `user_id`，**不需輸入帳號也不用輸入密碼**，伺服器依 `credential_id` 自動辨識是哪位家人。 |
| **使用密碼登入（未綁 Passkey 或換裝置）** | 帳號欄已自動帶入上次帳號，**只需輸入主密碼** | 登入成功後在該裝置 `localStorage` 僅記錄 `{ username, displayName }`（絕不存密碼），畫面顯示「以 `andy` 繼續登入」，旁邊提供「切換帳號」按鈕。 |

---

## 2. 資料庫架構升級（`migrations/0007_multi_tenant.sql`）

### 2.1 新增帳號、邀請碼與密碼重置表

1. **`users`**（取代單筆 `auth_owner`）：
   - `id TEXT PRIMARY KEY`（既有擁有者遷移固定為 `'owner'`，新成員為 `crypto.randomUUID()`）
   - `username TEXT NOT NULL UNIQUE COLLATE NOCASE`（不分大小寫唯一帳號；既有擁有者預設為 `'admin'`，後續可於設定自行修改）
   - `display_name TEXT NOT NULL DEFAULT ''`
   - `role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'))`
   - `password_hash TEXT NOT NULL`、`password_salt TEXT NOT NULL`
   - `pin_enabled INTEGER NOT NULL DEFAULT 0`、`pin_hash TEXT`、`pin_salt TEXT`
   - `show_utility_tab INTEGER NOT NULL DEFAULT 0`（`admin` 預設 `1`，新註冊 `member` 預設 `0`，後續可由設定開關）
   - `is_active INTEGER NOT NULL DEFAULT 1`
   - `created_at TEXT NOT NULL`、`updated_at TEXT NOT NULL`、`last_login_at TEXT`
2. **`auth_invites`**（一次性邀請碼）：
   - `id TEXT PRIMARY KEY`
   - `code_hash TEXT NOT NULL UNIQUE`（僅存高熵邀請碼之 SHA-256 雜湊，不存明文）
   - `note TEXT NOT NULL DEFAULT ''`（例如「給媽媽」、「給太太」）
   - `created_by TEXT NOT NULL`、`expires_at TEXT NOT NULL`
   - `used_by TEXT`、`used_at TEXT`、`revoked_at TEXT`、`created_at TEXT NOT NULL`
3. **`auth_password_resets`**（管理員零知情一次性重置碼）：
   - `id TEXT PRIMARY KEY`
   - `target_user_id TEXT NOT NULL`
   - `token_hash TEXT NOT NULL UNIQUE`（僅存 SHA-256 雜湊）
   - `created_by TEXT NOT NULL`、`expires_at TEXT NOT NULL`
   - `used_at TEXT`、`created_at TEXT NOT NULL`

### 2.2 既有認證表與業務表全面隔離（含複合主鍵防 IDOR 覆蓋）

- **既有資料無損遷移**：
  - `auth_owner (id = 1)` 自動匯入 `users`（`id = 'owner'`, `username = 'admin'`, `role = 'admin'`, `show_utility_tab = 1`，保留原本密碼雜湊與 PIN）。
  - 既有所有財務表、5F/6F 水電資料、`auth_passkeys`、`auth_sessions` 全部歸屬至 `user_id = 'owner'`。
  - **新註冊的家人帳本與水電表皆為 100% 空白**，看不到任何既有的 5F/6F 抄表資料。
- **複合主鍵（引擎級防跨戶覆蓋）**：
  - 為了徹底杜絕「即使有人猜到或重用他人 UUID / 備份檔，也無法在 SQLite 層級覆蓋他人資料」，所有 11 張租戶資料表全面改為以 `user_id` 領頭的主鍵：
    - `app_settings` → `PRIMARY KEY (user_id)`
    - `rent_utility_settings` → `PRIMARY KEY (user_id)`
    - `cashflow_logs` → `PRIMARY KEY (user_id, id)` + `UNIQUE (user_id, recurring_dedup_key) WHERE recurring_dedup_key IS NOT NULL AND deleted_at IS NULL`
    - `recurring_items` → `PRIMARY KEY (user_id, id)`
    - `sinking_fund_items` → `PRIMARY KEY (user_id, id)`
    - `asset_items` → `PRIMARY KEY (user_id, id)`
    - `savings_adjustments` → `PRIMARY KEY (user_id, id)`
    - `stock_transactions` → `PRIMARY KEY (user_id, id)`
    - `networth_history` → `PRIMARY KEY (user_id, year_month)`
    - `rent_utility_records` → `PRIMARY KEY (user_id, period)`
    - `sync_idempotency` → `PRIMARY KEY (user_id, mutation_id)`
  - `auth_passkeys`、`auth_sessions` 加入 `user_id TEXT NOT NULL DEFAULT 'owner'` 與索引；`auth_challenges` 加入 `user_id TEXT`。

---

## 3. 安全邊界與零知情流程

### 3.1 嚴格租戶隔離護欄
1. **單一身分來源**：受保護 API 統一透過 `requireAuth` 中介層由 `pf_session` Cookie 查出 `auth_sessions JOIN users`（並驗證 `users.is_active = 1`），將 `AuthUser` 注入 Hono Context，**完全無視前端傳來的任何 `userId`**。
2. **強制帶入 `userId`**：`sync.ts`、`automation.ts`、`market.ts` 所有讀寫函式皆強制要求 `userId: string`（經 `assertUserId()` 驗證非空），每條 SQL 必帶 `WHERE user_id = ?`。
3. **管理員權限最小化**：`/api/admin/*` 嚴格檢查 `role === 'admin'`，且僅操作 `users`、`auth_invites`、`auth_password_resets`，**不提供任何查閱、同步或匯出他人財務資料的 API**。
4. **防未登入資訊洩漏**：未登入時 `GET /api/auth/status` 僅回傳 `{ initialized, authenticated: false }`，不回傳任何使用者的帳號、PIN 狀態或 Passkey 清單。

### 3.2 一次性邀請碼註冊流程
1. Admin 在「設定 → 家庭成員管理」點「產生邀請碼」（預設 7 天有效），Worker 產生 128-bit 隨機碼（格式如 `INV-XXXX-XXXX-XXXX`），僅存 SHA-256 雜湊入 `auth_invites`，回傳一次性的邀請碼與專屬註冊連結（`/?invite=...`）。
2. 家人點擊連結或於登入頁切換「邀請碼註冊」→ 輸入邀請碼、自訂帳號、顯示名稱、自訂主密碼（≥ 8 碼）。
3. Worker 檢查帳號未重複後，以**原子條件更新**核銷邀請碼：
   ```sql
   UPDATE auth_invites
   SET used_by = ?, used_at = ?
   WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
   ```
   若影響筆數不為 1 立即拒絕，保證同一邀請碼絕不可能被註冊兩次。成功後建立帳號、預設 `app_settings` 與 Session Cookie 自動登入。

### 3.3 忘記密碼：管理員零知情重置流程
1. 家人忘記密碼 → 通知 Admin。
2. Admin 在「家庭成員管理」對該成員點「產生一次性密碼重置碼」（預設 30 分鐘有效），Worker 產生高熵隨機碼（格式如 `RST-XXXX-XXXX-XXXX`），僅存 SHA-256 雜湊入 `auth_password_resets`，提供一鍵複製連結（`/?reset=...&user=...`）。
3. 家人打開連結或登入頁「重設密碼」→ 輸入帳號、重置碼與**自己設定的新密碼**。
4. Worker 原子核銷重置碼後：以新 salt 計算 PBKDF2-SHA256 寫入 `users`、**撤銷該成員全部舊 `auth_sessions`**、清除登入限速。
5. **全程保護**：Admin 看不到舊密碼也看不到新密碼，重置碼用完即作廢。

---

## 4. Cron 排程與行情多租戶化

- **行情更新（`worker/market.ts`）**：
  - 手動點擊「更新行情」（`POST /api/market/refresh`）：只更新當前登入者的匯率與自動更新持股，不碰也不回傳他人標的。
  - 每日 23:00 Cron：先對所有啟用使用者的自動更新 `ticker` 做 `DISTINCT` 去重，每檔股票只打一次 TWSE/Yahoo API，再批次更新對應 `asset_items` 與各使用者 `app_settings.usd_twd_rate`。
- **自動化入帳 & 月底快照（`worker/automation.ts`）**：
  - Cron 查詢 `SELECT id FROM users WHERE is_active = 1`，逐一獨立執行 `runMonthlyRecurringD1(db, userId)` 與 `runMonthEndSnapshotD1(db, userId)`，單一使用者異常不影響其他人。

---

## 5. 前端離線隔離與介面調整

1. **IndexedDB 按人切庫（`web/src/db/localDb.ts`）**：
   - DB 名稱改為 `personal-finance-pwa:${userId}`。
   - 登入或切換帳號時開啟對應使用者的專屬 IndexedDB，登出時重置記憶體快照與鎖屏狀態，徹底杜絕共用裝置跨帳號資料殘留或 Outbox 錯送。
2. **收租水電分頁權限與開關**：
   - `users.show_utility_tab` 預設：`admin = 1`、`member = 0`。
   - 前端依 `authStatus.user.showUtilityTab` 動態顯示／隱藏底部「水電」分頁；使用者可在「設定 → 介面顯示」隨時自行開關（`PATCH /api/auth/profile`），Admin 亦可於成員管理切換。
3. **家庭成員管理面板（僅 `role === 'admin'` 可見）**：
   - 位於「設定」分頁內，支援：
     - 檢視成員列表（帳號、顯示名稱、角色、啟用狀態、最後登入時間）
     - 產生／作廢一次性邀請碼（附一鍵複製註冊連結）
     - 為忘記密碼的成員產生一次性重置碼（附一鍵複製重置連結）
     - 停用／啟用帳號（停用立即強制登出該帳號所有裝置）
4. **Service Worker**：快取版本升級至 `finance-pwa-v10`。

---

## 6. TDD 測試規劃（先寫測試，再實作）

新增 **`tests/multi-tenant.test.ts`**（並確保既有 10 支測試全部更新通過）：
1. **無損遷移**：模擬既有單租戶資料套用 `0007_multi_tenant.sql`，驗證 `auth_owner` 自動升級為 `admin`（`show_utility_tab = 1`），舊密碼、Passkey 與全部財務／水電資料完好保留。
2. **邀請碼註冊安全**：有效邀請碼註冊成功後立即失效（二次註冊 400）；過期碼、已作廢碼被拒；新成員預設 `role = 'member'`、`show_utility_tab = 0`，且帳本與水電完全空白。
3. **零知情密碼重置**：Admin 產生重置碼 → 成員用重置碼自設新密碼 → 舊密碼無法登入、舊 Session 立即 401、重置碼二次使用被拒；一般成員呼叫 `/api/admin/*` 回 403。
4. **跨租戶嚴格隔離滲透測試**：
   - User A 與 User B 使用**完全相同的 `recordId`、`period`、`yearMonth`、`mutationId`** 寫入與同步，驗證互不覆蓋、互不可見、互不觸發版本衝突。
   - User B 嘗試刪除 User A 紀錄、匯出快照、手動更新行情、使用 User A 的 Passkey，驗證 100% 隔離。
   - Admin 呼叫 `/api/sync`、`/api/export` 也只能看到自己的資料。
5. **Discoverable Passkey 無帳號登入**：User A 與 User B 各自綁定 Passkey，不提供 `username` 直接完成 Passkey 驗證並精準登入對應帳本。
6. **多租戶 Cron 排程**：User A 與 User B 皆設定同名「薪資」固定收支，每月 1 號自動入帳各自成功不撞唯一索引；月底淨值快照各自獨立寫入。
7. **前端 IndexedDB 按人隔離**：同環境切換 `LocalFinanceDB(userA)` 與 `LocalFinanceDB(userB)`，快照、Outbox、衝突清單完全互不干擾。
