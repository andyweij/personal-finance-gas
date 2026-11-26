# SDD：持股觀察清單／昨收漲跌／3D 翻牌卡（v1.6.0）與多帳本隔離管理（v1.7.0）

> 適用範圍：`cloudflare-pwa/`（Offline-First PWA + Cloudflare Workers + D1）  
> 對應資料庫遷移：`migrations/0010_watchlist_and_prev_close.sql`、`migrations/0011_multi_ledger.sql`

---

## 1. 背景與設計目標

### Phase 1（`v1.6.0` / Schema `0010`）：持股觀察清單、昨收價漲跌配色、行情時間與 3D 翻牌卡
1. **觀察清單（Watchlist）**：讓使用者追蹤尚未買入的台美標的，共用自動行情更新機制，但嚴格排除於持股總市值、配置圖表、資產負債頁、整合淨值與月底歷史快照之外；支援一鍵轉為正式持股。
2. **昨收價與今日漲跌配色**：行情同步（TWSE/TPEx MIS、Yahoo Finance v8、Stooq CSV）同步寫入 `previous_close`，自動計算單日漲跌金額、漲跌幅與持股今日預估損益（TWD），並直接沿用 `--stock-pos` / `--stock-neg` CSS Token，完整相容 `intl` / `tw` / `tw_stocks` 三套正負配色。
3. **行情最後更新時間**：在持股總覽卡與各股卡片清楚呈現股價與匯率最後更新時間（沿用 `price_updated_at` 與 `fx_updated_at`）。
4. **單欄大張 3D 翻牌卡**：在持股與觀察清單提供「列表 / 翻牌卡」切換（記憶於 `localStorage['finance_stock_card_mode']`），正面顯示現價、昨收、今日漲跌與市值；點擊翻面顯示均價、含息報酬、配息回本進度、更新時間與操作按鈕。

### Phase 2（`v1.7.0` / Schema `0011`）：多帳本隔離管理（方案 A）
1. **獨立 `ledgers` 實體**：以 `ledgers` 資料表管理多個帳本，內建不可刪除的 `default`（「個人主帳本」，`include_in_net_worth = 1`）。使用者可新增獨立帳本（例如代管帳戶、公帳、副業、旅遊專戶）並設定 `include_in_net_worth = 0`。
2. **全面帳本歸屬與單筆覆寫**：於 `cashflow_logs`、`asset_items`、`recurring_items` 加上 `ledger_id`（預設 `'default'`），並於 `asset_items` 加上 `exclude_from_net_worth` 單筆排除開關。
3. **端到端隔離計算**：
   - 記帳頁、總覽頁、資產負債頁、工具→固定收支頁皆提供帳本切換膠囊與「⚙ 帳本 / + 新帳本」管理視窗。
   - 獨立帳本可建立多項連動活存與一般資產，擁有各自獨立的「預設連動活存帳戶」與「常態收支去重鍵」。
   - 未納入個人總資產的帳本（或單筆排除資產）在 `computeNetWorthSummary`、`filterCashFlowsByLedgerScope` 與 `runMonthEndSnapshotD1` 中均被嚴格排除，絕不污染個人總資產、淨值、負債比、預備金月數與真實儲蓄率。

---

## 2. 資料模型與 Migration

### `0010_watchlist_and_prev_close.sql`
- `asset_items.is_watchlist INTEGER NOT NULL DEFAULT 0`
- `asset_items.previous_close REAL`

### `0011_multi_ledger.sql`
- 新增資料表 `ledgers (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, version, created_at, updated_at, deleted_at)`，主鍵 `(user_id, id)`。
- 為既有使用者自動種子預設帳本 `('default', '個人主帳本', 1, ...)`。
- `cashflow_logs.ledger_id TEXT NOT NULL DEFAULT 'default'` + 索引 `(user_id, ledger_id, date DESC)`。
- `asset_items.ledger_id TEXT NOT NULL DEFAULT 'default'`、`asset_items.exclude_from_net_worth INTEGER NOT NULL DEFAULT 0` + 索引 `(user_id, ledger_id)`。
- `recurring_items.ledger_id TEXT NOT NULL DEFAULT 'default'` + 索引 `(user_id, ledger_id)`。

---

## 3. 核心模組與計算規則

| 模組 | 關鍵函式 / 變更 |
| --- | --- |
| `shared/calculations.ts` | `isWatchlistAsset`、`computeStockDailyMetrics`、`computeWatchlistSummary`、`ensureActiveLedgers`、`isAssetIncludedInNetWorth`、`filterAssetsByLedgerScope`、`filterCashFlowsByLedgerScope`；更新 `computeAllSavingsSummary` 與 `computeNetWorthSummary` 支援帳本範圍過濾 |
| `shared/recurring.ts` | `buildMonthlyDedupKey(ym, type, itemName, ledgerId)`：`default` 維持舊格式向下相容，非預設帳本加上 `${ledgerId}\|\|` 前綴避免跨帳本同名碰撞 |
| `worker/market.ts` | `fetchStockQuote`（TWSE/TPEx MIS `entry.y`、Yahoo 5d K 棒前一日收盤、Stooq 14d CSV 動態 `close` 欄）；`refreshMarketData` 同步寫入 `COALESCE(?, previous_close)` |
| `worker/sync.ts` | `ensureDefaultLedger`、`'ledger'` 實體 CRUD 與刪除防呆（拒絕刪除 `default` 或非空帳本）、`is_default_savings` 改為同 `ledger_id` 內互斥、JSON 備份還原完整包含 `ledgers` 與新欄位 |
| `worker/automation.ts` | `runMonthlyRecurringD1` 依 `ledger_id` 寫入並套用帳本去重鍵；`runMonthEndSnapshotD1` 僅彙總 `isAssetIncludedInNetWorth` 資產與 `include_in_net_worth` 帳本流水 |
| `web/src/ui/stocksTab.ts` | 觀察清單子分頁、一鍵轉持股、今日漲跌徽章、行情更新時間列、單欄 3D 翻牌卡（含 `prefers-reduced-motion` 與正面／背面 `pointer-events` 隔離） |
| `web/src/ui/ledgerUi.ts` | 共用帳本切換膠囊列、多帳本管理與編輯 Modal、安全刪除並可選擇將既有紀錄遷移回個人主帳本 |

---

## 4. 部署與驗證檢查清單

1. 套用遠端 D1 Migration：
   ```bash
   cd cloudflare-pwa && npm run db:migrate:remote
   ```
2. 執行靜態型別檢查、單元／整合測試與前端建置：
   ```bash
   npm run typecheck && npm test && npm run build:web
   ```
3. 部署 Worker 與 PWA 靜態資產：
   ```bash
   npm run deploy
   ```
