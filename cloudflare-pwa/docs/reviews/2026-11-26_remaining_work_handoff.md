# 剩餘修正工作交接（第 2～5 組）

> 本文件是交接給另一個工作階段的完整工作說明。接手者請**從頭到尾依本文件執行**，除非遇到「必須停下來詢問」的情況（見第 2 節），否則請自行判斷、持續修正到全部完成，再回報。

## 0. 背景

- 專案：`cloudflare-pwa/`（Cloudflare Worker + Hono + D1，離線優先 PWA，IndexedDB 本機資料）。根目錄的 GAS 版**不在範圍內，不要修改**。
- 目前版本：v1.8.11（commit `a0c9ab1` 起），安全修正（第 1 組）已完成，在 PR andyweij/personal-finance-gas#7（尚未合併）。
- 必讀文件（依序）：
  1. [`2026-11-26_full_review_v1.8.10.md`](./2026-11-26_full_review_v1.8.10.md)：整體審查，所有項目的詳細說明、位置與修正方向（本文件的編號沿用它）
  2. [`2026-11-26_v1.8.11_changes.md`](./2026-11-26_v1.8.11_changes.md)：第 1 組做了什麼、有哪些行為變更
  3. [`2026-11-26_v1.8.10_changes.md`](./2026-11-26_v1.8.10_changes.md)、[`2026-11-26_v1.8.9_changes.md`](./2026-11-26_v1.8.9_changes.md)：同步引擎近期的設計決策（毒丸隔離、寫入健康檢查、快照版本號等），**不要推翻這些設計**
  4. [`2026-11-26_acceptance_tests.md`](./2026-11-26_acceptance_tests.md)：驗收測試的做法

## 1. 分支與提交

- 從 `claude/dazzling-maxwell-k8kt8l` 的最新 commit 開始，在新分支 **`claude/remaining-review-fixes`** 上工作並推送。
- 若 PR #7 在你工作期間被合併進 `main`：把 `origin/main` merge 進你的分支即可（不要 rebase、不要 force push）。
- **不要自行開 PR**；完成後回報，由使用者決定。
- 每一組完成就提交並推送一次（可以拆成多個 commit），格式：`fix(cloudflare-pwa): vX.Y.Z <摘要>`，結尾加上系統提供的 attribution。
- 版本：每組遞增一次 patch 版本（第 2 組 v1.8.12、第 3 組 v1.8.13…），同步更新 `package.json`、`web/src/version.ts`（`APP_VERSION`、`SW_CACHE_VERSION`、`VERSION_HIGHLIGHTS`、有 migration 時的 `DB_SCHEMA_VERSION`）、`web/public/sw.js`、`docs/DATABASE_SCHEMA.md`。
- Migration 從 **`0016`** 開始編號；不要修改既有 migration；必須相容已部署的舊資料與舊版客戶端。

## 2. 何時停下來詢問（其餘一律自行決定）

只有以下情況才停下來，用 `send_message` 傳訊息給 session `session_01WASwB8zsU3qQZkFDaScKvD` 說明並等待：

1. 修正需要**無法回復、會刪除或改寫使用者既有資料**的 migration，且找不到相容做法。
2. 需要外部憑證、付費服務或目前網路無法連到的資源，且沒有合理替代方案。
3. 修正會**大幅改變使用者可見的行為**（例如移除功能、改變資料的計算口徑導致歷史數字改變），而且有兩種以上同樣合理的選擇。

其他情況：選擇**保守、相容、不遺失資料**的做法，並在修正紀錄中寫明理由與替代方案。遇到審查描述與程式碼不符時，以程式碼為準，在紀錄中說明。

## 3. 工作方法（每一項都要遵守）

1. **先寫會失敗的測試**，再修正；修正後測試通過。
2. **確認測試真的能抓到問題**：把該項的程式修改暫時還原（例如 `git stash push -- worker web/src shared`）執行新測試，確認會失敗，再還原回來。
3. 不得刪除、跳過或弱化既有測試的斷言。若既有測試的預期因設計變更而必須更新，在修正紀錄中逐一說明理由。
4. 每組結束前執行（於 `cloudflare-pwa/`）：`npx tsc --noEmit`、`npx vitest run`、`npm run build:web`，全部通過才提交。
5. **每組完成後做一次獨立審查**：用 Agent 工具啟動一個 general-purpose agent，只給它 diff 與本文件該組的需求，請它以加嚴情境（並行、離線、多分頁、舊版客戶端、真實 D1 / workerd 行為差異）找問題並寫臨時測試重現。修正它找到的實質問題後再提交。
   - 前一輪的教訓：Node 測試環境與 workerd 行為不同（例如沒有 body 的 POST，在 workerd 中 `req.body` 不是 null）。涉及 Request / D1 行為時，可在臨時目錄用 `npx wrangler dev --local` 實際驗證。
6. 每組寫一份修正紀錄 `docs/reviews/2026-11-26_vX.Y.Z_changes.md`（繁體中文，格式參考 `2026-11-26_v1.8.11_changes.md`）：已修正表格、獨立審查結果、行為變更、仍未處理、部署步驟。

## 4. 工作內容

詳細說明、位置與修正方向見 `2026-11-26_full_review_v1.8.10.md` 的同編號項目。以下是範圍與驗收條件。

### 第 2 組：資料正確性（v1.8.12）

| 編號 | 驗收條件 |
|---|---|
| M6 | 一筆**編輯 / 刪除**被隔離（quarantine）時，同一筆尚未送出的後續編輯比照 R6 處理（移出佇列、以 `held_after_reject` 保存、完整重抓還原），伺服器上不會出現被隔離的值 |
| M7 | 400 / 413 也必須搭配「純拉取＋寫入健康檢查成功」才視為單筆問題；整個請求層級的 400 / 413（純拉取也失敗）不得隔離任何資料，只退避重試 |
| M3 | 伺服器寫入 cashflow、savings_adjustment、stock_transaction、asset 等時，參照的 `ledgerId`、`linkedAccountId`、`accountId`、`assetId` 必須存在於同一使用者且未刪除，否則 `RejectError`（以寫入語句的 `WHERE EXISTS` 或同一 batch 內檢查，避免 TOCTOU）；`default` 帳本永遠視為存在；匯入路徑也要檢查。注意舊資料可能已有懸空參照：不要讓既有紀錄的「只改備註」之類編輯因此被拒（只檢查本次有變更的參照欄位，或對既有值放行），並在紀錄中說明 |
| M4 | 帳戶互轉的兩邊必須一起成立或一起失敗（建議：伺服器在同一 batch 寫入同一 `transfer_group_id` 的兩筆，或新增 `transfer` entity；客戶端兩筆放在同一批且不可拆開）；建立、編輯、刪除都要涵蓋；舊版客戶端送來的單邊 mutation 要有合理處理 |
| M5 | 常態入帳的去重鍵改為 `recurring_item.id + yearMonth`（同名同類型的兩個項目都要入帳）；寫入改 `ON CONFLICT DO NOTHING`，並行執行不會中斷、不會重複；既有資料以舊鍵入帳過的月份不得重複入帳（相容舊的 `recurring_dedup_key`） |
| M8 | USD（或任何非 TWD）活存帳戶的餘額以帳戶原幣加總後再一次換算；歷史匯率變動不會讓餘額漂移 |
| M14 | 手動入帳 API 驗證 `year`、`month`：整數、`month` 1～12、年份合理範圍，否則 400 |
| M9 | 其他分頁變更 PIN / 生物辨識 / passkeys 後，本分頁的 `ctx.state` 會同步更新；登入與啟動流程不會把舊值寫回 |

### 第 3 組：資源上限與排程（v1.8.13）

| 編號 | 驗收條件 |
|---|---|
| H5 | 先以 Cloudflare 官方文件確認 Workers 免費 / 付費方案的 D1 查詢數與對外請求數上限（用 WebSearch / web-fetch agent；若無法取得，以「每次呼叫 50 次 D1 查詢、50 個對外請求」的保守值設計），把確認結果寫進修正紀錄。之後：`ensure*` 系列在單次請求內只執行一次（或只在登入 / 建立帳號時）、游標與 epoch 讀取合併、移除重複查詢；新增**查詢次數斷言測試**（以計數的 D1 包裝），確保 0 筆 mutation 的同步與 N 筆 mutation 的同步都在上限內；依上限調整 `MAX_SYNC_MUTATIONS` 與客戶端 `maxBatchSize`（兩者一致） |
| H6 | 每月 1 號先執行常態入帳，再更新報價；每個排程步驟各自 try/catch 並 `console.error`；新增 `automation_runs`（使用者、種類、期間、狀態）表，排程啟動時補跑錯過的入帳與月底快照；報價更新分批，單次執行的對外請求數不超過上限（例如依使用者或標的分段到多次執行，或在剩餘額度不足時停止並留待下次）；所有對外請求加 `AbortSignal.timeout` |
| M13 | 匯入端點使用與 `/api/sync` 相同的串流大小限制；欄位型別錯誤回 400；大型匯入分塊寫入且不會留下半套資料（例如分塊完成後才遞增 `data_epoch`，或先寫暫存再切換）；CSV 匯入使用確定性 ID（正規化列內容的雜湊），重複匯入不會產生重複資料；CSV 列補上 `ledger_id` |
| 月底快照 | 活存、持股計算加上快照日期上限（未來日期的紀錄不計入）；預備金依帳本過濾；時區改讀 `APP_TIMEZONE`（`Intl.DateTimeFormat`），不再寫死 +8 |

### 第 4 組：PWA（v1.8.14）

| 編號 | 驗收條件 |
|---|---|
| M12 | 預快取清單由建置產生（vite-plugin-pwa / Workbox，或自寫建置步驟把 hash 後的資源清單與 build hash 寫入 `sw.js`），不再手動改 `CACHE_VERSION`；安裝後首次離線啟動能正常顯示；只有導覽請求（`mode === 'navigate'`）才 fallback 到 `index.html`；含查詢字串的網址（`?reset=`、`?invite=`）不寫入快取；有新版本時顯示「有更新」提示，使用者確認後才 `SKIP_WAITING`。若可行，用 Playwright（環境已預裝 Chromium）做「安裝 → 離線 → 重新開啟」的端對端驗證；不可行則寫明原因並以單元測試涵蓋 `sw.js` 邏輯 |

### 第 5 組：低優先（v1.8.15）

依 `full_review_v1.8.10.md`「三、低優先」逐項處理，至少包含：

- 儲存時停用按鈕或加進行中旗標，連點不會建立兩筆（記帳表單與各 modal）
- CSV 匯出防公式注入（`= + - @` 開頭加 `'`），水電 CSV 正確跳脫
- 「今天」統一為 `APP_TIMEZONE` 的日期（單一 helper），匯出檔名、管理畫面日期依台北時間顯示
- 數字顯示：不出現 `-NT$ 0`、`-0.0%`
- iOS 下載：延後 revoke object URL
- 無障礙：modal 支援 Esc 關閉、焦點移入與還原；toast 加 `role="status" aria-live="polite"`；移除 viewport 的 `maximum-scale=1`
- 金額與計算：統一的十進位捨入 helper；USD 貸款利息保留小數；隱含利率求解範圍與驗證上限一致；賣超持股時拒絕或正確處理
- 同步細節：`StaleSnapshotError` 多次重試並以中文訊息呈現；批次選取與標記已送出在同一交易；`bumpSnapshotRev` 在交易完成時才更新記憶體版本；`patchAuthMeta` 無 meta 時在同一交易寫入；`destroy()` 等待佇列清空後才關閉資料庫；`computeStatus` 有拒絕紀錄時不隱藏離線 / 待同步；`singleItemSuccessStreak` 隨 `poisonSearchActive` 重置；`commitAndMaybeSync` 不重複顯示錯誤
- B7：新 migration 重建租戶資料表移除 `user_id DEFAULT 'owner'`（若 SQLite 重建表格風險過高或會影響既有資料，改為加 CHECK 或在程式層集中檢查，並在紀錄說明）
- 效能：只渲染目前分頁，其他分頁標記 dirty；跨分頁重新載入加 debounce

### 不在本次範圍（只寫設計提案，不實作）

以下屬於需要重新設計、或風險高的大型重構。請在最後寫一份 `docs/reviews/2026-11-26_design_proposals.md`，分別說明問題、可選方案、取捨與建議，**不要實作**：

- B5：PIN 改由伺服器驗證，離線解鎖改用每台裝置的驗證資料或以 PIN 衍生金鑰加密本機資料
- 本機資料加密（IndexedDB）
- 讓管理員也無法讀取成員資料（客戶端加密）
- 架構重構：`worker/sync.ts` 的 entity registry、拆分 `stocksTab.ts` / `assetsTab.ts`、IndexedDB 依 entity 分 store

## 5. 完成後回報

全部完成（或遇到第 2 節的情況）時，用 `send_message` 傳給 session `session_01WASwB8zsU3qQZkFDaScKvD`，以**繁體中文**說明：

1. 每一項的狀態（已修 / 部分 / 跳過＋理由），對應 commit
2. 最終的 `tsc`、`vitest`（檔案數 / 測試數）、`build:web` 結果
3. 各組獨立審查發現了什麼、如何處理
4. 新增的 migration 與部署步驟
5. 所有行為變更
6. 仍未解決或需要使用者決定的事項
7. 推送的分支名稱與最後一個 commit
