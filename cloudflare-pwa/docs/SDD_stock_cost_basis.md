# Feature SDD：持股成本、移動平均加碼／賣出與配息降成本 (`cloudflare-pwa/`)

- **版本**：v1.0
- **目標專案**：`cloudflare-pwa/`（離線優先 PWA + Cloudflare Workers + D1）
- **核心目標**：重組底部 5 分頁為 `記帳 ｜ 總覽 ｜ 資產 ｜ 持股 ｜ 工具`，新增專屬「**持股**」管理頁，支援期初平均成本、後續加碼累算、部分賣出（移動平均法＋已實現損益）、現金配息扣除未回本成本直到歸零（並保留超額回收）、股票配股稀釋均價、單價／總額雙模式切換，以及與流水帳／活存連動。

---

## 1. 核心會計公式（純推導計算、可刪改不漂移）

為確保離線編輯、刪除誤記異動與跨裝置同步時股數與成本永不漂移，所有持股數據皆由 `shared/calculations.ts` 的 `computeStockPositionSummary()` 依「**期初基準（`asset_items.quantity_or_amount` ＋ `asset_items.cost_basis`）＋ 時序異動明細（`stock_transactions`）**」確定性推導：

1. **買入加碼（`buy`）**：
   - `股數 += shares`
   - `原始持有成本 += totalAmount`（含手續費，底層一律存精確總成本，避免零股循環小數誤差）
2. **股票配股（`stock_dividend`）**：
   - `股數 += shares`
   - `原始持有成本` 維持不變（避免重複計算獲利），`每股原始均價 = 原始持有成本 ÷ 股數` 自動稀釋
3. **賣出減碼（`sell`，移動平均成本法）**：
   - `移除成本 = 當時每股均價 × 賣出股數`
   - `剩餘股數 -= 賣出股數`、`剩餘原始持有成本 -= 移除成本`（剩餘每股均價維持不變）
   - `已實現損益 += 實拿淨額 - 移除成本`
4. **現金配息（`cash_dividend`，扣成本直到歸零）**：
   - `累計現金配息 += totalAmount`
   - **並存雙視角指標**：
     - **帳面價差（不含息）**：`未實現價差 = 目前市值 - 原始持有成本`、`價差報酬率 = 未實現價差 ÷ 原始持有成本`
     - **配息降成本（含息）**：
       - `尚未回本成本 = max(0, 原始持有成本 - 累計現金配息)`（領滿即歸零顯示 `NT$ 0`）
       - `超額回收現金 = max(0, 累計現金配息 - 原始持有成本)`（不截斷遺失）
       - `含息總淨利 = 未實現價差 + 累計現金配息 + 已實現損益`
       - `含息總報酬率 = 含息總淨利 ÷ 歷史總投入成本`（永不除以 0）

---

## 2. 資料庫 Migration（`migrations/0004_stock_cost_basis.sql`）

```sql
ALTER TABLE asset_items ADD COLUMN cost_basis REAL;

CREATE TABLE IF NOT EXISTS stock_transactions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  date TEXT NOT NULL,
  tx_type TEXT NOT NULL,          -- buy | sell | cash_dividend | stock_dividend
  shares REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  linked_cashflow_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

上線前執行：
```bash
npm run db:migrate:remote
```

---

## 3. UI 導覽重組（方案 B）

- **底部 5 分頁**：`記帳` ｜ `總覽` ｜ `資產` ｜ `持股` ｜ `工具`
- **`持股` 頁**：
  - 頂部總覽卡片提供 **`單價 (39)` ｜ `總額 (39,000)`** 雙模式即時切換（持久化於 `localStorage`）
  - 並存顯示「帳面價差淨利（不含息）」與「含息總淨利（扣配息後）」＋ 整體配息回本進度條
  - 每檔持股卡片支援：`+ 加碼`、`配息/配股`、`賣出`、`明細 / 設成本`
  - 輸入表單支援單價／總額雙向即時換算預覽，並內建 5 倍異常單位防呆警告與可選「同步寫入流水帳並連動活存帳戶」
- **`工具` 頁**：整合低頻管理工具為頂部 3 分段切換：**`固定收支`** ｜ **`稅金分攤`** ｜ **`水電分攤`**
