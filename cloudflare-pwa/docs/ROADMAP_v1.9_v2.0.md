# `cloudflare-pwa` 新功能分階段路線圖（v1.9.0 ～ v2.0.0）

- **範圍限定**：僅修改 `cloudflare-pwa/`（不動根目錄 GAS 專案）。
- **工作準則**：每階段獨立 TDD（先寫測試再實作）、遵守 D1 50 queries/request 免費預算、新建資料表一律無 `DEFAULT 'owner'`、向後相容 Migration（`0018+`）、每階段跑完 `npm run typecheck && npm test && npm run build:web` 全綠才進入下一階段。

## 進度總表

| Phase | 目標版本 | 功能項目 | Migration | 狀態 |
| --- | --- | --- | --- | --- |
| **Phase 1** | `v1.9.0` | 跨月全文搜尋與條件篩選加總（流水帳） | 無 | ✅ 已完成 |
| **Phase 2** | `v1.10.0` | 淨資產歷史走勢圖 ＋ 持股配息月曆 ＋ 資產再平衡試算 | `0018` (`app_settings`) | ✅ 已完成 |
| **Phase 3** | `v1.11.0` | 自訂分類、常用範本與輸入自動補齊 | `0019` (`app_settings`) | ✅ 已完成 |
| **Phase 4** | `v1.12.0` | 多幣別擴充（JPY / EUR / HKD / GBP 等） | `0020` (`app_settings`) | ⬜ 待實作 |
| **Phase 5** | `v1.13.0` | 財務目標與達成日期推估（存錢桶 / FIRE） | `0021` (`financial_goals`) | ⬜ 待實作 |
| **Phase 6** | `v1.14.0` | 代墊款 / 拆帳追蹤 | `0022` (`split_receivables`) | ⬜ 待實作 |
| **Phase 7** | `v1.15.0` | 信用卡帳單週期 & 分期付款管理 | `0023` (`asset_items` + `installment_plans`) | ⬜ 待實作 |
| **Phase 8** | `v1.16.0` | *(建議前置重構)* `sync.ts` Entity Registry 輕量化 | 無 | ⬜ 待實作 |
| **Phase 9** | `v2.0.0` | 選擇性「共同帳本」（需先寫獨立 SDD 與安全審查） | `0024+` | ⬜ 待實作 |

---

## Phase 1（`v1.9.0`）完成紀錄
- **新增模組**：`shared/ledgerSearch.ts`（多詞 AND 搜尋、日期區間與閏年/跨年解析、多帳本範圍隔離、與 `aggregatePeriodMetrics` 口徑一致之彙總、零 RegExp / 零 HTML 拼接高亮切段）
- **介面整合**：`web/index.html`、`web/src/ui/state.ts`、`web/src/ui/logTab.ts`、`web/src/main.ts`、`web/src/styles.css`
- **測試套件**：`tests/ledger-search.test.ts`
- **Migration**：無（0 D1 查詢成本，免執行 `db:migrate:remote`）

## Phase 2（`v1.10.0`）完成紀錄
- **新增 Migration**：`migrations/0018_rebalance_targets.sql`（`app_settings.rebalance_targets_json TEXT NOT NULL DEFAULT '[]'`，向後相容、+0 D1 查詢成本）
- **核心引擎**：`shared/analytics.ts`（淨資產序列與成長計算、年度配息月曆與消費覆蓋率、只買不賣水填法與買賣調倉整數零尾差再平衡演算法）
- **介面模組**：`web/src/ui/networthChart.ts`、`web/src/ui/dividendCalendarUi.ts`、`web/src/ui/rebalanceUi.ts`
- **測試套件**：`tests/analytics-and-rebalance.test.ts`（涵蓋單元、D1 同步、樂觀鎖衝突、JSON 備份還原與 D1 查詢預算檢查）

## Phase 3（`v1.11.0`）完成紀錄
- **新增 Migration**：`migrations/0019_custom_categories_and_templates.sql`（`app_settings` 新增 `custom_categories_json` 與 `quick_templates_json`，向後相容、+0 D1 查詢成本）
- **核心模組**：`shared/autocomplete.ts`（頻率×近期衰減自動補齊排序、範本失效帳本／活存參照安全降級）與 `shared/validation.ts`（自訂分類／範本驗證與上限保護）
- **介面模組**：`web/src/ui/quickTemplatesUi.ts`（常用範本快捷列、⚡一鍵直記、☆存範本、自訂分類管理與項目名稱自動補齊下拉）
- **測試套件**：`tests/categories-and-templates.test.ts`
