# Feature SDD：活存帳戶與流水帳即時連動 (`cloudflare-pwa/`)

- **版本**：v1.1 (Draft for Review)
- **目標專案**：`cloudflare-pwa/`（離線優先 PWA + Cloudflare Workers + D1）
- **核心目標**：在資產負債中新增「**活存帳戶**」，支援多帳戶與 N 筆存入紀錄累加、與全部 7 類流水帳（收入 `+`、支出／投資流出 `-`）即時推導連動、在記帳頁 0ms 顯示餘額變化，並透過「起算基準日」避免既有歷史舊帳重複扣款。

---

## 1. 核心會計公式（純推導計算、永不算歪）

為避免離線編輯、刪除誤記帳目或跨裝置同步時造成餘額漂移，活存餘額**不採「直接加減覆寫餘額欄位」**，而是由以下確定性公式在前後端共用核心（`shared/calculations.ts`）即時推導：

$$\text{即時餘額}(A) = \text{基準餘額}(A) + \sum_{\text{存入/轉出調整}} \Delta_{\text{adj}} + \sum_{\text{基準後連動收入}} \text{TWD}_{\text{in}} - \sum_{\text{基準後連動支出與投資}} \text{TWD}_{\text{out}}$$

$$\text{活存總餘額} = \sum_{A \in \text{所有啟用活存帳戶}} \text{即時餘額}(A)$$

### 1.1 連動收支方向規則（全部 7 種收支類型）
| 收支類型 | 對活存餘額影響 |
| --- | --- |
| `固定收入`、`其他收入` | **＋ 增加活存** (`+twdAmount`) |
| `固定支出`、`訂閱扣款`、`日常花費`、`稅金與大額`、`投資流出` | **－ 扣除活存** (`-twdAmount`) |

### 1.2 防歷史舊帳重複扣款（基準日 + 時間戳規則）
每個活存帳戶都保存 `balanceAnchorDate`（`YYYY-MM-DD`，預設今天）與 `balanceAnchorAt`（ISO-8601 時間戳）：
- 僅計入 `linkedAccountId === A.id` 且未軟刪除的流水帳，且滿足：
  1. `log.date > A.balanceAnchorDate`（基準日之後的交易，含日後補記），**或**
  2. `log.date === A.balanceAnchorDate` 且 `log.createdAt >= A.balanceAnchorAt`（基準當日設定／校準之後新增的交易）。
- 既有歷史舊帳（`linkedAccountId = null` 或早於基準時間）完全不會重複扣款。
- **隨時對帳校準**：使用者可在帳戶卡片點「**校準對帳**」直接輸入銀行 App 當下真實餘額，系統將 `quantityOrAmount` 更新為該數值，並把 `balanceAnchorDate` / `balanceAnchorAt` 設為現在，**完全不影響任何歷史流水帳報表**。

### 1.3 支援 N 筆紀錄累加活存（兩種方式皆支援）
1. **多筆活存帳戶累加**：可建立多個活存帳戶（例如 `中信活存 30萬` + `台新活存 20萬`），自動加總成「**活存總餘額 50萬**」。
2. **單一帳戶 N 筆存入／轉出累加（`savings_adjustments`）**：針對任一活存帳戶，可隨時新增 N 筆本金存入（例如：解定存轉入 `+20萬`、現金存入 `+5萬`）或轉出（`-10萬`）紀錄；這些紀錄**只累加／扣除活存本金，不會誤算成月薪收入、不會扭曲真實儲蓄率**，且每筆皆可檢視與刪除。

---

## 2. 資料結構與 D1 Migration（`migrations/0003_savings_linkage.sql`）

完全向下相容既有 `0001_initial.sql`，既有資料零影響：

```sql
-- 1. 擴充 asset_items：標記活存連動帳戶、基準日與預設主帳戶
ALTER TABLE asset_items ADD COLUMN is_linked_savings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_items ADD COLUMN balance_anchor_date TEXT;
ALTER TABLE asset_items ADD COLUMN balance_anchor_at TEXT;
ALTER TABLE asset_items ADD COLUMN is_default_savings INTEGER NOT NULL DEFAULT 0;

-- 2. 擴充 cashflow_logs：記錄連動之活存帳戶 ID（NULL = 不連動）
ALTER TABLE cashflow_logs ADD COLUMN linked_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cashflow_linked_account ON cashflow_logs(linked_account_id);

-- 3. 擴充 recurring_items：每月 1 號自動入帳時亦可自動連動指定活存帳戶
ALTER TABLE recurring_items ADD COLUMN linked_account_id TEXT;

-- 4. 新增 savings_adjustments：活存本金存入 / 轉出累加紀錄（不影響損益報表）
CREATE TABLE IF NOT EXISTS savings_adjustments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,              -- 指向 asset_items.id
  date TEXT NOT NULL,                    -- YYYY-MM-DD
  amount REAL NOT NULL,                  -- 正數=存入累加、負數=轉出扣除（原幣）
  twd_amount INTEGER NOT NULL,           -- 折合台幣整數
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_savings_adj_account ON savings_adjustments(account_id);
CREATE INDEX IF NOT EXISTS idx_savings_adj_updated ON savings_adjustments(updated_at);
```

### 淨資產與緊急預備金自動連動（零重複計算）
- 活存帳戶本身即屬於 `asset_items`（`majorType = '資產'`, `subCategory = '活存'`, `liquidity = '高流動'`）。
- `computeNetWorthSummary()` 與月底自動快照 `runMonthEndSnapshotD1()` 皆改用 `computeAssetEffectiveTwdValue()`：
  - 若為一般資產：沿用 `quantityOrAmount * unitPrice * fxRate`
  - 若為 `isLinkedSavings = true`：直接使用「**即時推導活存餘額**」，並歸入 `highLiquidityAssets` 與資產配置的「**現金 / 美金**」區塊，自動精準反映最新淨資產與緊急預備金月數！

---

## 3. 離線同步協議擴充（`/api/sync`）

- `SyncEntity` 新增 `'savings_adjustment'`。
- `SyncDelta` 與 `FinanceSnapshot` 新增 `savingsAdjustments: SavingsAdjustment[]`。
- `cashflow` / `recurring` / `asset` 的 `upsert` payload 支援上述新欄位，舊資料未帶欄位時自動安全預設（`isLinkedSavings = false`, `linkedAccountId = null`）。
- 全程走現有 IndexedDB Outbox + `sync_idempotency` + LWW 機制，**飛航模式記帳 0ms 扣減活存、連網自動同步 D1**。

---

## 4. 前端 UI / UX 設計

### 4.1 Tab 1「記帳」頁：即時顯示活存餘額與扣款預覽
1. **頂部新增精簡「活存即時餘額條」**（緊接在當月預算卡片下方或整合於頂部資訊區）：
   - 顯示 **活存總餘額**（如 `NT$ 400,000`）與帳戶數量；若有多個活存帳戶，點一下可展開各帳戶即時餘額明細。
2. **快速記帳表單新增「連動活存帳戶」晶片列（Chips）**：
   - 預設自動選中「主活存帳戶」（標示 `★`），旁邊列出其他活存帳戶與 `不連動`（例如刷卡未出帳）。
   - **即時變動預覽**：在輸入金額時，即時顯示預覽文字，例如：
     - 支出 100,000：`中信活存：NT$ 500,000 → NT$ 400,000`
     - 收入 50,000：`中信活存：NT$ 400,000 → NT$ 450,000`
   - 若尚未建立任何活存帳戶，顯示引導按鈕「前往資產頁新增活存帳戶」。

### 4.2 Tab 4「資產負債」頁：專屬「活存帳戶區（即時連動）」
1. 放在最上方（自動更新區之前），區分：
   - **活存帳戶區（即時連動流水帳）**：頂部顯示「活存總餘額」，每筆帳戶卡片顯示即時餘額、基準日、`主帳戶` 標籤，以及 3 個快捷操作：
     - **`+ 存入/轉出`**：新增本金累加／轉出紀錄（並可在彈窗檢視與刪除該帳戶的 N 筆調整紀錄）。
     - **`對帳校準`**：輸入銀行實際餘額，一鍵重設基準餘額與基準時間。
     - **`編輯`**：修改名稱、幣別、設為主帳戶、刪除。
   - **自動更新區（台股 / 美金）**
   - **每月手動快照區（定存 / 基金 / 保單 / 負債）**

### 4.3 Tab 3「固定收支與訂閱」頁
- 編輯固定收支項目時，可選擇 **「自動入帳連動活存帳戶」**（選填，預設帶入主活存帳戶或 `不連動`）。每月 1 號自動入帳產生的流水帳會自動帶入 `linkedAccountId`，讓活存自動加薪水、扣房貸與訂閱！

---

## 5. 測試計畫（Step 3 — TDD 先寫測試再開發）

1. **`tests/savings-linkage.test.ts`（共用計算與驗證測試）**：
   - 多活存帳戶累加（30 萬 + 20 萬 = 50 萬）
   - 單帳戶 N 筆 `savings_adjustments` 累加（+20 萬 + 15 萬 + 15 萬 = 50 萬）
   - 7 類流水帳連動：收入 `+`、日常/固定/訂閱/稅金/投資 `-`（50 萬 - 10 萬 = 40 萬）
   - 刪除流水帳後即時還原回 50 萬
   - 基準日與基準時間戳防重複扣款：早於基準日與同日早於基準時間的舊帳不計入；基準後新帳計入
   - `linkedAccountId = null`（不連動）不影響任何活存帳戶
   - 校準對帳重設基準日後的正確性
   - `computeNetWorthSummary` 使用即時活存餘額計算總資產、高流動資產與緊急預備金月數（無重複計算）
2. **`tests/sync-client.test.ts`（離線同步擴充測試）**：
   - 離線建立活存帳戶 + 追加存入紀錄 + 記一筆 10 萬支出 → 本機 0ms 推導出 40 萬，且全部 mutations 正確進入 Outbox 並同步至伺服器
3. **`tests/api.test.ts`（D1 Migration + `/api/sync` + Cron 自動入帳測試）**：
   - 驗證 `0003_savings_linkage.sql` 可在既有 `0001_initial.sql` 上無痛套用
   - `/api/sync` 同步 `savings_adjustment`、`asset` 活存欄位、`cashflow.linkedAccountId`
   - `runMonthlyRecurringD1` 自動把 `recurring_items.linked_account_id` 寫進產生的 `cashflow_logs`
   - `runMonthEndSnapshotD1` 自動將即時活存餘額（含加減後結果）寫入淨資產快照

---

## 6. 審查確認

若這份設計符合你的預期（特別確認：**① `savings_adjustments` 存入紀錄不影響月收入/儲蓄率**、**② 活存直接整合在資產總額中不重複計算**、**③ 記帳頁直接顯示活存餘額與即時扣款預覽**），請核准或提出調整意見，通過後我立刻進入 **寫測試 → 實作 → 驗證推送**！
