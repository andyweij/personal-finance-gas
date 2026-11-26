# v1.8.12～v1.8.16 上線後審查

- **對象**：正式環境 main `876b14a`（v1.8.16），審查範圍 `2ffcbdb~1..ddbd6ca`
- **前提**：已套用 migration 0014～0017 並部署；Cloudflare 免費方案；資料量很小（asset_items 56、cashflow_logs 37、recurring_items 25、ledgers 3、networth_history 1）
- **方式**：唯讀審查，沒有修改產品程式碼。重現測試以新檔放在 `tests/`；仍存在的 bug 用 `it.fails` 標記，整套測試維持通過。
- **日期**：2026-11-26

## 結論

**沒有發現正在正式環境造成資料錯誤或遺失、需要立即處理的問題。** 下列項目都已驗證：
- 0017 的重建內容完整。
- 0016 對「已執行期間」的標記正確。
- 舊版排程已入帳的帳號，上線後不會重複入帳。
- 舊客戶端的一般同步正常。

需要處理的問題有兩類：
1. **（中）離線轉帳的特定操作順序會讓整筆轉帳被拒絕並回滾**。新舊客戶端都會發生，已重現（發現 1）。這不是靜默遺失：被拒的內容會留在客戶端的拒絕清單。
2. **（中低）瀏覽器仍快取 v1.8.11 JS 的舊客戶端**，在「第一次同步遇到網路錯誤」等情況下，連動紀錄會被 M3 參照檢查永久拒絕。已重現（發現 2）。

另外：
- 上線後的第一次排程（**台北時間 11/26 23:00**），會替「10 月以前建立、但沒有 11 月自動入帳紀錄或 10 月快照」的帳號補跑，詳見發現 3。這是設計上的行為，但請使用者以 SQL 確認正式資料是否屬於這種情況。
- 免費方案每次呼叫的 CPU 上限是 10 ms。登入用的 PBKDF2 經估算會超過，詳見發現 4。這不是這次發布造成的。

## 驗證指令結果

| 指令 | 結果 |
|---|---|
| `npm ci` | 成功 |
| `npx tsc --noEmit` | 通過（0 錯誤） |
| `npx vitest run` | 審查前：33 個檔案、286 項全數通過。加入本次重現測試後：35 個檔案、291 項全數通過（`it.fails` 2 項如預期失敗） |
| `npm run build:web` | 成功（JS 446 KB／gzip 130 KB） |
| `npm run test:e2e:pwa` | `PWA e2e OK`：`queryCached:false`、`offlineScriptRan:true`、`missingAssetOffline:"network-error"`、`updateBannerShown`／`reloadedAfterConfirm`／`otherTabAskedToReload` 皆為 true |
| `wrangler d1 migrations apply --local`（0001～0017） | 全部套用成功 |
| `wrangler dev --local --test-scheduled`（workerd 實測） | 見下方 |

workerd 實測的內容：
- **同步**：舊客戶端一次送 50 筆，其中 45 筆子紀錄排在新帳本前面。結果分 3 次請求（ack 20／20／10）全部完成，沒有任何一筆被拒絕。
- **排程**：
  - 第一次 `0 15 * * *`：補 10 月快照，補入 11 月常態收支 4 筆，用了 19 次 D1 查詢、3 個對外請求。
  - 第二次 `0 22 * * *`：沒有任何補跑，只用 3 次查詢。
  - 注意：本機 `/__scheduled` 會被 assets 的 SPA fallback 攔走，要改用 `/cdn-cgi/handler/scheduled`。這只影響本機測試，與正式環境無關。

本次新增的重現測試：
- `tests/post-deploy-first-cron.test.ts`：上線路徑的排程模擬，2 項，皆通過。
- `tests/post-deploy-sync-repro.test.ts`：發現 1，`it.fails` 2 項，另有 1 項記錄根因。

## 發現（依嚴重度排序）

### 發現 1（中，已重現）：轉帳群組早於它參照的新帳戶被處理，整筆轉帳被拒絕並回滾

**位置**
- `worker/sync.ts:2847-2862`：在群組**第一個成員**所在的位置，就把整個群組交給 `processGroup`。
- `shared/syncOrder.ts:40-66`：`orderMutationsByDependencies` 只把依賴移到「參照它的那個成員」前面，而不是移到整個群組前面。客戶端 `web/src/sync/syncEngine.ts` 用的是同一支函式。

**觸發條件（正式環境）**
1. 離線時新增活存帳戶 B。
2. 從 A 轉帳到 B（或手續費紀錄參照一個新帳本）。
3. 同步前又動到 B，例如改名、設為預設、校準餘額或拖曳排序。B 的新增因此被合併，移到佇列尾端。

這時：
- 佇列是 `[legA, legB, B]`，排序後是 `[legA, B, legB]`。
- 群組在 legA 的位置執行時 B 還不存在，legB 被 M3 拒絕，legA 跟著一起被拒。
- 有沒有 `atomicGroupId` 都一樣：v1.8.11 舊客戶端沒有這個欄位，但伺服器會依 `transferGroupId` 自動把兩邊歸成一組。
- 一直在線上操作的使用者，每次變更通常會立刻同步，觸發機率低。

**影響**
- 兩邊轉帳都被標為 `rolled_back`，從畫面消失，A、B 的餘額回到轉帳前；B 本身照常建立。
- 原始內容留在拒絕清單，使用者必須手動重新輸入。

**建議修法**
- 首選：在 `orderMutationsByDependencies` 把同一群組（`atomicGroupId`，沒有時用 `transferGroupId`）視為一個節點：先排完所有成員的依賴，再連續輸出所有成員。伺服器和客戶端會一起修好。
- 或者：伺服器在 `processGroup` 之前，先處理群組成員依賴、但還沒處理的 upsert。

**重現**
- `tests/post-deploy-sync-repro.test.ts`：有無 `atomicGroupId` 各 1 項 `it.fails`，另有 1 項記錄排序結果 `['adj-out', 'acc-new2', 'adj-in']`。
- 端到端：v1.8.11 與 v1.8.16 客戶端（LocalFinanceDB＋SyncEngine）對新伺服器，都得到兩筆 `rolled_back`，伺服器上 savings_adjustments 為 0 筆。見附錄 O2。

### 發現 2（中低，已重現；只影響仍在執行 v1.8.11 JS 的分頁）：子紀錄先送出，被 M3 永久拒絕

**位置**
- 舊版 `syncEngine.ts` 的 `selectSyncBatch`：嚴格依佇列前綴，沒有依賴排序。
- 舊版 `localDb` 合併後會取新的 `_seq`。
- 新伺服器的 M3 參照檢查：`worker/sync.ts` 約 554-600 行（`collectChangedRefs`／`refGuardSql`）。

**觸發條件**
1. 舊 JS 在離線時新增帳戶（或帳本、股票標的）。
2. 新增一筆連動它的紀錄。
3. 再編輯該帳戶，帳戶的新增被合併、移到子紀錄後面。
4. 恢復連線後，第一次同步失敗：網路錯誤、逾時、5xx 或 429 都算。舊客戶端下一次只送 1 筆，送出的正好是子紀錄。

另一種觸發方式（推論，未單獨重現）：佇列超過 50 筆，子紀錄在前 50 筆內、被參照的紀錄在第 50 筆之後。

**影響**
- 子紀錄被拒並 `rolled_back`，留在拒絕清單。
- v1.8.11 搭配舊伺服器時沒有這個問題，所以是相容性退步。
- 對照組：
  - 同樣情境但沒有網路錯誤：正常。
  - 新版客戶端遇到網路錯誤：正常，因為它在選批次前會先依依賴排序。

**正式環境風險**
- 只有「部署前就離線、而且累積了上述操作」的舊分頁才會遇到。
- v1.8.14 的 SW 升級後，客戶端會改用新 JS（見發現 5 的升級路徑），風險會隨時間消失。

**建議修法**
- 讓舊分頁盡快更新。
- 或者：M3 遇到「參照的紀錄不存在」，而且這筆是**新建**時，先不回 ack 也不拒絕，讓客戶端下一輪重送。必須設重試上限，避免永遠卡住。

**重現**
- 以 `git archive 2ffcbdb~1` 展開舊版樹，讓舊版 SyncEngine 呼叫新版 `processSyncRequest`。
- 測試原始碼見附錄 O1：拒絕清單為 `[["cashflow","rolled_back","連動的活存帳戶不存在或已刪除…"]]`。
- 這個測試要 import 舊版程式碼，沒有放進 repo。

### 發現 3（設計上的行為；請在正式環境確認）：上線後第一次排程的補跑

**時間**：下一次排程是 `0 15 * * *`，也就是**台北時間 11/26 23:00**。之後每次排程都會執行補跑步驟。

| 條件（每位使用者分開判斷） | 第一次排程的行為 |
|---|---|
| 帳號在 10 月以前建立，且資料庫中**已有**任何 11 月 `source='自動入帳'` 的紀錄（已刪除的也算） | 0016 已標記 `recurring 2026-11 done`，**不補** |
| 帳號在 10 月以前建立，而且**沒有**任何 11 月的自動入帳紀錄 | **補入**「11/1 前就已建立、目前啟用、11 月應入帳」的常態收支，日期記為 `2026-11-01`；連到活存帳戶的項目會改變帳戶餘額 |
| 帳號在 11 月建立 | 不補 |
| 帳號在 10 月以前建立，而且 networth_history **沒有** 2026-10 或更早的列 | **補一筆 2026-10 快照**（日期 10/31）。活存、存轉、交易只計入 10/31 以前的紀錄；**手動資產與股價則是補跑當下的值** |

已驗證：
- 舊版在 11/1 以名稱式去重鍵入帳、10 月已有快照的帳號，從 11/26 一路執行到 12/1 的排程：沒有重複入帳、沒有多補快照，12 月只入帳一次，每次排程都 ≤ 50 次 D1 查詢（`tests/post-deploy-first-cron.test.ts` 第 1 項）。
- 沒有證據的帳號會照上表補跑（第 2 項，workerd 實測結果相同）。

**風險**：如果使用者 11 月的常態收支是**自己手動記錄**的（`source` 不是「自動入帳」），補跑會造成重複。

**確認方式**：見文末「建議使用者在正式環境手動確認的項目」第 1 項。要在 23:00 之前做。

### 發現 4（不是這次發布造成的；需要觀察）：免費方案 10 ms CPU 上限

官方文件寫明：免費方案每次呼叫的 CPU 上限是 10 ms，HTTP 與 Cron 都一樣。超過時整個呼叫被終止（Error 1102，`exceededCpu`），程式無法以 try/catch 攔截。

在 Node 中的粗略量測（與 Workers 使用相近的 V8 與 BoringSSL；`wrangler dev --local` 不會強制或回報 CPU 上限，所以無法在 workerd 精確量測）：

| 項目 | 量測值 | 備註 |
|---|---|---|
| PBKDF2 100,000 次（`worker/auth.ts:23`） | 約 18 ms | 登入、註冊、重設、變更密碼，以及未知帳號的假驗證都會執行。自第一版（cb1e03e）就是 100,000 次 |
| 同步 20 筆新增 | 暖機後 4～5 ms，首次 11 ms | 含行程內 SQLite 的時間，真實 D1 的 CPU 會更低 |
| 完整拉取（56 筆資產） | 約 2 ms | |
| 月底快照 | 2～7 ms，首次 18 ms | 首次含 JIT 暖機 |
| 月底那次排程（報價全部失敗） | 約 12.5 ms | 含 SQLite 的時間 |

建議：
- 在 Cloudflare 後台 Workers → Metrics／Logs 查看是否出現 `Exceeded CPU Time Limits`。
- 如果登入出現：把 PBKDF2 降到例如 10,000～20,000 次，並在登入成功時以新的次數重新雜湊。
- 如果排程出現：把排程拆開，例如入帳與快照用一個 cron、報價用另一個 cron。

### 發現 5（中，已知，已重現）：從舊版 SW 升級時可能離線白畫面

**觸發條件**
1. 部署後使用者連線開過一次 app，但新版 SW 沒有裝成（例如很快關掉）。
2. 之後離線開啟。

**原因**：舊版 SW（快取優先＋背景更新）已經把**新版 HTML** 存進 `finance-pwa-v31` 快取，卻沒有新版的 hashed JS，bundle 沒有執行。

**影響與處理**
- 連線後重新整理即可恢復，並會出現更新提示。
- 這與 v1.8.14 變更說明一致；新版程式碼修不到舊 SW 的行為。
- 建議提醒使用者：升級後先連線開啟一次。

Playwright 實測（舊版 build 切換到新版 build）：

| 情境 | 結果 |
|---|---|
| 連線、單分頁 | 重新整理後出現更新提示；確認後重新載入，舊快取被刪除；之後離線開啟正常 |
| 新 SW 已裝好，關閉所有分頁後離線重開 | 正常 |
| 新 SW 沒裝成，離線重開 | 白畫面（即本項） |

### 發現 6（低）：其他 SW 與客戶端項目

| 項目 | 位置 | 說明 | 重現 |
|---|---|---|---|
| install 不檢查 HTML 與 assets 是否同一版 | `web/public/sw.js` install、`vite.config.ts` `swPrecachePlugin` | 部署傳播期間 `/sw.js` 與 `/` 若來自不同版本，會快取到舊 HTML＋新 assets，之後離線開啟會白畫面。建議：建置時把 index.html 引用的路徑注入 sw.js，install 時驗證，不一致就讓安裝失敗 | 推測 |
| 舊分頁不會被通知 | 舊版 main.ts 沒有 `controllerchange` 處理 | 一個分頁確認更新後，另一個舊分頁繼續跑舊 JS，沒有提示（會連帶遇到發現 2） | 已重現 |
| 第一次安裝的分頁收不到「已在其他分頁啟用」提示 | `web/src/main.ts:124`、`:133` | `hadControllerAtLoad` 只在載入時記錄一次 | 推測 |
| 提示顯示中又有更新時，要按兩次 | `web/src/main.ts:84` | 按鈕仍綁著已經 redundant 的 worker；不會卡住 | 推測 |
| 群組內成員提前寫入冪等紀錄 | `worker/sync.ts:752` 附近（`recordIdempotencyOnly`） | 刪除時伺服器已無該列、或 LWW 判定不需寫入時，冪等紀錄在群組 batch 之外寫入；之後群組失敗，客戶端會多一次 resync | 推測 |
| 舊客戶端遇到群組衝突的行為改變 | M4 | 轉帳一邊有版本衝突時，兩邊都回 `rejected`（以前是 `conflict`），舊客戶端失去「保留本機版本」的選項 | 程式碼確認（設計取捨） |
| CSV 匯入會去掉使用者原本自己輸入的開頭 `'` | `shared/csv.ts` `parseCsvRows` | 例如 `'-12` 匯出再匯入後變成 `-12` | 已重現（極低） |
| 登入畫面蓋在 modal 上時按 Esc，會關掉底下的 modal | modal 鍵盤處理 | 優先順序沒有包含 `authScreen` | 推測（極低） |
| 報價時間的「今日」仍用裝置本地時區 | `web/src/ui/stocksTab.ts:101-117` | 只是顯示不一致 | 資訊 |

## 確認沒有問題的項目

### Migration 0017
在本機以 node:sqlite 建立兩個資料庫：一個只套用到 0016，另一個再套用 0017，比對 `sqlite_master`，以及每張表的 `table_xinfo`、`index_list`／`index_xinfo`、`foreign_key_list`：
- 唯一差異是 12 張表的 `user_id` 預設值由 `'owner'` 變為無，以及索引的建立順序。
- 欄位型別、NOT NULL、其他預設值、主鍵、UNIQUE、外鍵（無）都相同。
- 兩個 partial index 的 WHERE 條件完全相同：`idx_cashflow_recurring_dedup … WHERE recurring_dedup_key IS NOT NULL AND deleted_at IS NULL`，以及 `idx_savings_adj_user_transfer … WHERE transfer_group_id IS NOT NULL`。
- 沒有 trigger 或 view。
- 每張表的每個欄位都填入非預設值後套用 0017，24 張表的資料逐列相同。
- 程式碼中所有寫入這 12 張表的 INSERT／UPSERT／`INSERT OR REPLACE` 都明確帶 `user_id`；`ON CONFLICT` 目標（主鍵與 `idx_cashflow_recurring_dedup`）都仍存在。

### 0016 與排程
- 0016 只把「本月已有自動入帳（含已刪除）」標為 `recurring done`，把「上月以前已有快照」標為 `snapshot done`。正式環境在 11/26 套用，期間是 2026-11／2026-10，正確。
- M5 新舊去重鍵相容：舊版以名稱式鍵寫入的入帳，手動重跑時會依名稱、類型、帳本比對，且優先比對同金額。
- 12/1 的順序：11/30 23:00 的月底快照會標記 done；12/1 06:00 的排程補跑就會完成 12 月入帳（比 08:00 早）；08:00 的排程不會重複。
- `quote_checked_at` 為 NULL 的資產排在最前面，各資產會依序輪替。
- 清理排程：只刪除過期的 session／challenge、1 天前的 rate limit、30 天前用過或過期的邀請與重設連結、90 天前的冪等紀錄、365 天前的安全事件。這段不是本範圍的修改。

### D1 查詢的計算方式（H5）
以 Cloudflare 官方文件原始碼（cloudflare-docs repo 的 production 分支；`developers.cloudflare.com` 被本環境的網路政策擋下）確認：
- D1 Limits 原文：「The Queries per Worker invocation limit is an exception: a `db.batch()` call counts as a single query against it, not one query per statement.」**H5「一次 batch 算一次查詢」的假設成立。** 但 batch 中的每個語句仍各自受 100 KB 長度與 100 個參數的限制，整個 batch 也受 30 秒時限。
- 免費方案的查詢數，文件之間不一致：
  - D1 Limits 寫 50。
  - Workers Limits 與 2026-02-11 changelog 寫「50 external／1,000 to Cloudflare services」。
- 程式以 50 設計，是安全的一方。超過時的錯誤是 `Too many API requests by single Worker invocation`。
- `d1Budget.ts` 的計數方式（prepared＋batch 呼叫數−batch 內的語句數）只會高估。

### 同步（舊客戶端與資料正確性）
- **部分 ack**：舊客戶端一次送 50 筆，伺服器處理 20 筆。沒處理的不會被拒、也不算衝突；整批重送時，已處理的靠冪等直接 ack。70 筆的測試全部寫入，沒有拒絕、衝突或隔離。
- **同一請求內**：子紀錄排在新帳本前面、或帳本排在第 50 筆，伺服器都會重排並全部接受（workerd 也實測過）。
- **舊客戶端的轉帳**：建立（兩邊＋手續費）與成對刪除都正常；單邊、或兩邊被拆到兩個請求，也照舊逐筆套用。
- **M4**：群組 batch 的 guard 鏈正確；預算不會把群組拆開；新客戶端會把整個群組放進同一批；不會跨群組合併。
- **M6／M7**：以整個 unit 為單位隔離；同一紀錄的後續修改與同群組成員都會被暫停；400／413 只在讀取探測與寫入探測都成功時才視為單筆問題。
- **M8**：USD 活存以原幣加總，最後只用目前匯率換算一次。匯率為 30、32、35 時原幣餘額都不變。
  - 設計上的後果（不是 bug）：連到 USD 帳戶的 TWD 流水，會以目前匯率折回 USD。
  - 拆出來的各項分別四捨五入，加總可能和總額差 1 元。

### 第 5 組
- **表單重複送出防護**：25 處都會在 `finally` 解鎖，錯誤之後可以再送出；同時連按兩次只會執行一次。
- **modal**：
  - 組字中（IME）按 Esc 不會關閉。
  - 計算機開著時，Esc 只關計算機。
  - Tab／Shift+Tab 共 45 次，焦點都沒有離開 modal。
- **日期**：「今天」與日期預設值使用 APP_TIMEZONE；時區名稱無效時改用 Asia/Taipei。
- **捨入與顯示**：`roundTo(1.005,2)=1.01`，不會出現 -0。
- **CSV 匯出**：會替可能被當成公式的內容加前綴；自己的匯出再匯入可以還原。
- **toast**：只對錯誤訊息去重。

## 建議使用者在正式環境手動確認的項目

1. **在台北時間 11/26 23:00 前**，確認首次排程會補跑哪些帳號：

   ```sql
   -- 會被補入 11 月常態收支的使用者（應該為空，或確認這些使用者 11 月確實還沒有記錄常態收支）
   SELECT u.id, u.created_at,
          (SELECT COUNT(*) FROM recurring_items r WHERE r.user_id = u.id AND r.status = '啟用' AND r.deleted_at IS NULL AND r.created_at < '2026-10-31T16:00:00Z') AS items
   FROM users u
   WHERE u.is_active = 1 AND u.created_at < '2026-10-31T16:00:00Z'
     AND NOT EXISTS (SELECT 1 FROM automation_runs a WHERE a.user_id = u.id AND a.kind = 'recurring' AND a.period = '2026-11' AND a.status = 'done');
   -- 會被補 10 月快照的使用者
   SELECT u.id FROM users u
   WHERE u.is_active = 1 AND u.created_at < '2026-10-31T16:00:00Z'
     AND NOT EXISTS (SELECT 1 FROM automation_runs a WHERE a.user_id = u.id AND a.kind = 'snapshot' AND a.period = '2026-10' AND a.status = 'done');
   ```

   用 `npx wrangler d1 execute finance-db --remote --command "…"` 執行。
   - 如果有不該補的使用者，可以先手動插入 `automation_runs` 的 `done` 列，例如：

     ```sql
     INSERT OR IGNORE INTO automation_runs VALUES ('<user_id>', 'recurring', '2026-11', 'done', 'manual', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
     ```
   - 也可以接受補跑，之後再刪除多餘的紀錄。
2. **23:00 排程後**：
   - 在 Workers Logs 搜尋 `[cron]`，確認各步驟 `ok:true`，以及 `d1Queries`、`subrequests` 都 ≤ 50。
   - 執行 `SELECT * FROM automation_runs ORDER BY updated_at DESC`。
3. 在 Workers Metrics 中確認沒有 `Exceeded CPU Time Limits`／Error 1102，特別是登入與排程（發現 4）。
4. 每台裝置連線開啟一次 app，看到「有新版本」提示後按下更新；確認離線開啟正常（發現 5）。
5. 在升級完成前，避免在離線狀態下「新增帳戶 → 轉帳到該帳戶 → 再編輯該帳戶」。如果已經發生，到同步問題清單查看被拒的轉帳並重新輸入（發現 1、2）。
6. 確認 11/30 23:00 的月底快照與 12/1 的入帳各只產生一次（`automation_runs` 中 `snapshot 2026-11` 與 `recurring 2026-12` 為 done）。

## 附錄：舊客戶端重現（O1／O2）

做法：
1. `git archive 2ffcbdb~1 cloudflare-pwa | tar -x -C <dir>/old`，並在該目錄安裝依賴。
2. 在舊版樹的 `tests/` 放入以下測試，讓 v1.8.11 的 `LocalFinanceDB`／`SyncEngine` 呼叫 v1.8.16 的 `processSyncRequest` 與 migrations。
3. 兩項都通過，也就是 bug 確實存在。

把 import 換成新版 `web/src` 後：O1 不會重現，O2 仍會重現。

```ts
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LocalFinanceDB } from '../web/src/db/localDb'; // v1.8.11
import { SyncEngine } from '../web/src/sync/syncEngine'; // v1.8.11
import { processSyncRequest } from '<repo>/cloudflare-pwa/worker/sync'; // v1.8.16
import { createTestD1 } from '<repo>/cloudflare-pwa/tests/helpers/mockD1';

const acc = (name: string, qty = 100000) => ({
  itemName: name, majorType: '資產', updateMode: '手動快照', subCategory: '活存', liquidity: '高流動',
  quantityOrAmount: qty, currency: 'TWD', unitPrice: 1, isLinkedSavings: true,
  balanceAnchorDate: '2026-11-01', balanceAnchorAt: '2026-11-01T00:00:00.000Z',
});
function setup() {
  const db = createTestD1();
  let online = true;
  let failNext = false;
  const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (failNext && body.mutations?.length > 0) { failNext = false; throw new TypeError('Failed to fetch'); }
    return new Response(JSON.stringify(await processSyncRequest(db, 'owner', body)), { status: 200 });
  }) as typeof fetch;
  const engine = new SyncEngine(new LocalFinanceDB(`old-${crypto.randomUUID()}`), {
    fetchImpl, isOnline: () => online, retryBaseDelayMs: 60_000, requestLock: async (_n, fn) => fn(),
  });
  return { db, engine, setOnline: (v: boolean) => { online = v; }, armNetworkFailure: () => { failNext = true; } };
}
const drain = async (e: SyncEngine, k = 6) => { for (let i = 0; i < k; i++) await e.syncNow(); };

describe('v1.8.11 client vs v1.8.16 server', () => {
  it('O1：離線新增帳戶＋連動流水＋改名，第一次同步遇到網路錯誤 → 流水被拒並回滾', async () => {
    const t = setup(); await t.engine.init(); t.setOnline(false);
    const b = await t.engine.saveAsset(acc('新活存'));
    const cf = await t.engine.addCashFlow({ date: '2026-11-26', type: '日常花費', category: '餐飲', itemName: '午餐', amount: 120, currency: 'TWD', linkedAccountId: b.id } as never);
    await t.engine.saveAsset({ ...acc('新活存(改名)'), id: b.id });
    t.setOnline(true); t.armNetworkFailure(); await t.engine.syncNow(); await drain(t.engine);
    expect(await t.db.prepare('SELECT id FROM cashflow_logs WHERE id = ?').bind(cf.id).first()).toBeNull();
    expect(t.engine.getRejections().some((r) => r.entity === 'cashflow')).toBe(true);
  });
  it('O2：離線新增帳戶 B、轉帳到 B、再改名 B → 整筆轉帳被拒並回滾', async () => {
    const t = setup(); await t.engine.init();
    const a = await t.engine.saveAsset(acc('A')); await drain(t.engine, 2); t.setOnline(false);
    const b = await t.engine.saveAsset(acc('B', 0));
    await t.engine.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, date: '2026-11-26', amount: 500, fee: 0 } as never);
    await t.engine.saveAsset({ ...acc('B(改名)', 0), id: b.id });
    t.setOnline(true); await drain(t.engine);
    expect(Number((await t.db.prepare('SELECT COUNT(*) AS n FROM savings_adjustments').first<{ n: number }>())?.n)).toBe(0);
  });
});
```
