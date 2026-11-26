# 驗收測試說明與交接指示

測試檔：[`tests/acceptance-open-items.test.ts`](../../tests/acceptance-open-items.test.ts)
對應審查：[`2026-11-26_v1.8.6_review.md`](./2026-11-26_v1.8.6_review.md)「尚未完成清單」

## 為什麼需要這份測試

前幾輪交接時，修正模型常會漏掉部分工項，或寫出只涵蓋窄情境的測試（例如 R1 連續三輪「測試通過但 bug 仍在」）。這份測試把尚未修正的項目寫成**可執行的驗收條件**，由審查方撰寫並確認能重現 bug，修正方不得修改斷言。

## 運作方式

- 每個 `it.fails(...)` 都是**目前仍存在的 bug**。bug 存在時斷言失敗 → vitest 視為通過，整套測試維持綠燈（目前 23 檔 / 152 測試全數通過）。
- 修好某一項後，該測試會「意外通過」而讓 vitest 報紅 → **把該項的 `it.fails` 改成 `it`**，即為該項的驗收。
- 標示「回歸保護」的測試以一般 `it` 撰寫、目前已通過：修正其他項目時不得讓它們變紅。
- 所有 `it.fails` 測試都已在 v1.8.6（`ddc01db`）上以 `it` 執行，確認是在**預期的斷言**失敗，不是因為測試本身的設定錯誤。

## 測試對照表

| 測試 | 審查編號 | 目前狀態 | 在 v1.8.6 上的失敗訊息 |
|---|---|---|---|
| N2 完整重抓期間的寫入不得遺失 | Q2 / N2 | ✅ v1.8.7 已改為 `it` | `expected false to be true`（snapshot 與下次 delta 都沒有該筆） |
| N4 舊 epoch mutation 不得寫入還原資料 | Q5 / N4 | ✅ v1.8.7 已改為 `it` | `expected { id: 'cf-stale' } to be null` |
| F7 報價更新後離線改成本不得衝突 | Q7 / F7 | ✅ v1.8.8 已改為 `it` | `conflicts` 長度為 1 |
| F8 23:00 不得以美股盤中價覆寫 | Q6 / F8 | ✅ v1.8.8 已改為 `it` | `expected 133 to be 148` |
| Q1 伺服器整體故障不得隔離正常資料 | Q1 | ✅ v1.8.7 已改為 `it` | 2 筆正常資料被移進拒絕清單 |
| N1 重新載入後再編輯不得假衝突 | Q4 / N1 | ✅ v1.8.7 已改為 `it` | `conflicts` 長度為 1 |
| N3 重新套用不得覆蓋較新編輯 | N3 | ✅ v1.8.7 已改為 `it` | `expected 'offline-old' to be 'newer'` |
| Q8 清空代號不得把價格歸零 | Q8 / F5 | ✅ v1.8.8 已改為 `it` | `expected +0 to be 148` |
| R6 被拒值不得寫入伺服器 | Q3 / R6 | 回歸保護（`it`） | 已通過（僅涵蓋欄位驗證型拒絕） |
| F1 邊界 重新套用時價格不得為 NaN | F1 | 回歸保護（`it`） | 已通過 |
| V1 只有寫入路徑故障時不得隔離正常資料 | V1（v1.8.7 審查） | ✅ v1.8.9 已改為 `it` | 5 筆正常資料被隔離 |
| V2 被延後紀錄之後的 mutation 不得插隊 | V2（v1.8.7 審查） | ✅ v1.8.9 已改為 `it` | 刪除帳本被拒（1 筆拒絕） |
| V3 被略過的凍結項目必須保留 | V3（v1.8.7 審查） | ✅ v1.8.9 已改為 `it` | 找不到被略過的編輯 |
| V4 舊 epoch mutation 不得依還原資料被拒絕 | V4（v1.8.7 審查） | ✅ v1.8.9 已改為 `it` | 刪除帳本出現在 `rejected` |

### 未涵蓋（需人工確認）

下列項目無法以單元測試穩定重現或屬於 UI，請依審查文件處理並在回報中說明：

- R6「依伺服器狀態」而非欄位驗證的拒絕情境
- F2 / F3 TWSE MIS 試撮與零成交（需以實際 MIS 資料確認 `ip`、`v` 欄位）
- F6 持股視窗價格改回原值的邊界（DOM 行為）
- 狀態膠囊在有拒絕紀錄時的顯示
- R5 其餘路由回傳原始錯誤訊息（`worker/index.ts` 多處）
- `auth_challenges(expires_at)` 索引、`locked_until` 清理、F10 部署說明、F11

---

## 交接 prompt（可直接貼給修正模型）

```text
請修正 cloudflare-pwa 的未完成審查項目。範圍僅限 cloudflare-pwa/，不要修改根目錄 GAS 版。

先閱讀：
- 最新一份審查文件（目前為 cloudflare-pwa/docs/reviews/2026-11-26_v1.8.7_review.md）及其引用的前一份審查
- cloudflare-pwa/docs/reviews/2026-11-26_acceptance_tests.md（本文件）
- cloudflare-pwa/tests/acceptance-open-items.test.ts

本輪只處理：（依最新審查文件的「建議下一輪交辦」填入，例如 V1、V2、V4、R-1）。

驗收規則（必須遵守）：
1. 每修好一項，把 tests/acceptance-open-items.test.ts 中對應的 `it.fails` 改成 `it`，且該測試必須通過。
2. 不得刪除、跳過或弱化任何斷言，也不得修改測試的情境設定；若認為某個斷言不合理，停下來在回報中說明理由，不要改測試。
3. 標示「回歸保護」的測試與其他既有測試必須維持通過。
4. 完成後執行 `npm run typecheck && npm test`（於 cloudflare-pwa/），全部通過才提交。
5. 一個 commit，格式 `fix(cloudflare-pwa): vX.Y.Z ...`，更新 package.json、web/src/version.ts、web/public/sw.js 的版本。

回報格式（逐項，不可省略任何一項）：
| 編號 | 狀態（已修 / 跳過） | 修改位置 | 對應測試是否已從 it.fails 改為 it | 跳過原因 |
並附上 `npm test` 的最後輸出。
```

第一組完成並複查通過後，再以同樣方式交辦第二組（Q6/F8、Q7/F7、Q3/R6、Q8/F5）。
