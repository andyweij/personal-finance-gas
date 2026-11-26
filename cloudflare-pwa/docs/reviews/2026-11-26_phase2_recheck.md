# 第二階段審查複查（commit `bc84c6c`，v1.8.5）

- **對照**：[`2026-11-26_phase2_review.md`](./2026-11-26_phase2_review.md)（P2-S1～S13、P2-C1～C10），並一併確認 [`2026-11-26_phase1_recheck.md`](./2026-11-26_phase1_recheck.md)（R1～R8）與 [`2026-11-26_v1.8.4_prev_close_review.md`](./2026-11-26_v1.8.4_prev_close_review.md)（F1、F4）的遺留項目
- **驗證**：`tsc --noEmit` 通過；`vitest run` 21 檔 / 135 測試全數通過。R1、R2、P2-S2、新回歸 N2 已用臨時測試重現（未加入 repo）。路徑相對於 `cloudflare-pwa/`，行號為 HEAD。

## 總評

第二階段最嚴重的兩項已修好：**P2-C1（rebase 只在自己的 ack 產生該版本時才進行）**與 **P2-C3（單一分頁內以 mutex 序列化所有本機提交與同步套用，未發現死鎖）**。CSV `change_seq`、報價未變不遞增 version、merge 匯入 version、衝突解決原子性也都修好。

但有 **兩個新回歸**（N1 自己的連續編輯產生假衝突、N2 完整重抓的游標讀取順序錯誤），而 **R1（並行重送誤判衝突）與 R2（一筆壞資料卡死同步）仍未修**，兩者都已在連續兩輪審查中重現。F1（本機股價變空）觸發路徑反而變多。

## 判定

### 伺服器端

| 項目 | 判定 | 說明 |
|---|---|---|
| P2-S1 CSV `change_seq` | ✅ | 遞增與所有列在同一個 batch（`worker/index.ts:610-621`）；超大 CSV 可能超過 D1 batch 限制（待確認） |
| P2-S2 epoch 競態 | ⚠️ 部分 | 結束時重讀 epoch；但沒有逐筆 `data_epoch` 條件，舊 epoch 的 mutation 仍會寫入還原後的資料（已重現，N4） |
| P2-S3 暫時性錯誤 vs RejectError | ✅（但 R2 仍在） | |
| P2-S4 報價未變不遞增 version | ✅ | `worker/market.ts:608, 672-673` |
| P2-S5 自動匯率選用 | ⚠️ 部分 | 手動更新報價不再強制更新匯率；但沒有新 migration，既有使用者仍預設開啟（`0013:26` `DEFAULT 1`） |
| P2-S6 / R1 並行重送 | ❌ 未修（已重現） | `VersionConflictError` 分支仍未重查 `sync_idempotency` |
| P2-S7 `utility_record` 鍵 | ✅ 可接受 | 鍵一致，但未 trim / 截斷 |
| P2-S8 merge 匯入 version | ✅ | `ON CONFLICT DO UPDATE ... version + 1`；已軟刪除的列被跳過卻仍計入匯入數 |
| P2-S9 舊版客戶端 replace 後 | ⚠️ 部分 | 回傳完整資料 + `fullResyncRequired`，但舊客戶端的 mutation 仍會寫入還原後資料 |
| P2-S10 passkey 限速器 | ✅ | |
| P2-S11 body 上限 / `X-Expected-User` | ⚠️ 部分 | 先看 Content-Length 並以位元組計算；chunked 無 Content-Length 仍會整個讀入。標頭檢查擴及匯入、報價、自動化，但 PIN、passkey 註冊、個人資料、密碼端點未檢查 |
| P2-S12 `ensure*` seq 0 | ⚠️ 大致完成 | `ensureRentUtilitySettings` 仍為 0（影響小） |
| P2-S13 舊 `since` 游標 | ❌ 依設計保留 | |
| R2 確定性 DB 錯誤 | ❌ 未修（已重現） | |
| R5 原始 DB 錯誤訊息 | ❌ 未修 | `worker/index.ts:396, 577, 774`、`worker/auth.ts:870-875` |

### 客戶端

| 項目 | 判定 | 說明 |
|---|---|---|
| P2-C1 rebase 繞過衝突偵測 | ✅ | `syncEngine.ts:2559-2575`、`isExpectedAckedVersion`（`:2244`）。R4 一併修好 |
| P2-C2 持久化 `sentAt` | ⚠️ 修了但有回歸 | 已送出的列不再合併；但它與後續編輯會在同一批送出 → 假衝突（N1） |
| P2-C3 / R8 mutex | ✅ 單一分頁內 | `syncEngine.ts:298-354`，30 個 CRUD 都包住；fetch 期間不持有鎖、無巢狀呼叫，未發現死鎖。跨分頁仍無保護 |
| P2-C4 epoch 凍結 outbox | ⚠️ 部分 | 凍結與「重新套用」都有，新建可正確重新套用；但較舊的凍結編輯會覆蓋較新的編輯（N3） |
| P2-C5 rebase 在 ack 交易內 | ⚠️ 部分 | 單分頁 mutex 內計算；讀 outbox 與 ack 仍是兩個 IndexedDB 交易 |
| P2-C6 跨分頁 | ⚠️ 部分 | 有 `snapshot_changed` 廣播，但重新載入是非同步的；PIN / 生物辨識的 meta 寫入不廣播 |
| P2-C7 無 `navigator.locks` 的替代鎖 | ⚠️ 部分 | 檢查與設定非原子；等待 15 秒後仍會在沒拿到鎖的情況下執行 |
| P2-C8 重試 | ✅ 大致完成 | 429 + `Retry-After`、無進展退避、達上限後重試；400 / 413 仍不重試 |
| P2-C9 衝突解決原子性 | ✅ | `localDb.ts:390-425` |
| P2-C10 登出廣播、`destroy()` | ⚠️ 部分 | 登出成功才廣播；`destroy()` 不會中止進行中的同步 |
| R3 `pendingFullResync` 持久化 | ❌ 未修 | |
| R6 待送編輯抑制還原 | ❌ 未修 | `syncEngine.ts:2535` |
| R7 被拒新建復活 | ❌ 未修 | `syncEngine.ts:2531`、`conflictUi.ts:362` |
| R2 客戶端毒丸隔離 | ❌ 未修 | `attempts` 有寫入但沒人讀 |
| F1 asset payload 缺價格整筆取代 | ❌ 未修，觸發路徑變多 | 現在每輪同步都會把待送 mutation 的 payload 疊到合併結果上 |
| F4 只改昨收送出舊價格 | ❌ 未動 | `shared/validation.ts:370-374` |
| IndexedDB 升級 | ✅ 不需要 | `sentAt` 只是列上的屬性；既有列視為未送出，安全 |

---

## 需修正（依嚴重度）

### R2. 一筆壞資料永久卡死同步（第三次確認、已重現）— `worker/sync.ts:1522, 2074-2077`；`web/src/sync/syncEngine.ts`
`savings_adjustment` 的 `twdAmount: 'abc'` → NaN → `NOT NULL constraint failed` → 被當成暫時性錯誤 rethrow → 請求永遠回 500。壞的 mutation 卡在 outbox 最前面，拉取也走同一個請求，**這台裝置再也收不到任何資料**。
- 修正（伺服器）：數值欄位用 `Number.isFinite` 驗證；先檢查 `mutationId` / `recordId` / `entity` / `op` / `baseVersion` / `payload` 型別；`SQLITE_CONSTRAINT`、`D1_TYPE_ERROR` 歸類為 `RejectError`（通用訊息）。
- 修正（客戶端）：同一批連續失敗 N 次後改為一次一筆以隔離壞 mutation 並移入拒絕清單；失敗時另送 `mutations: []` 的純拉取請求。
- 測試：加入上述 `twdAmount: 'abc'` 的案例，斷言回應為 rejected 而非 500，且後續 mutation 可正常同步。

### R1. 並行重送仍誤判為衝突（第三次確認、已重現）— `worker/sync.ts:2067-2068`
客戶端 20 秒逾時重試、第一個請求仍在執行時，第二個請求在 `checkVersionOrThrow`（`:474`、`:490`）就拋衝突。create / update / delete 三種都重現。
- 修正：`processSyncRequest` 的 `VersionConflictError` 分支中，再查一次 `sync_idempotency`，存在就 ack。
- 測試：B **在 A commit 之後**才讀取紀錄（現有測試的 barrier 讓兩者都在 A commit 前讀取，所以測不到）。

### N1. 自己的連續編輯產生假衝突（新回歸，已確認）— `web/src/db/localDb.ts:279-316`、`web/src/sync/syncEngine.ts:2300`
同步失敗或逾時後 X 的 mutation 帶有 `sentAt`；之後再編輯 X，新 mutation 使用 snapshot 中舊的 `baseVersion`（新建則為 null）。批次只是取 outbox 前 50 筆（`outbox.slice(0, maxBatchSize)`），兩筆會一起送出：伺服器套用第一筆後，第二筆版本衝突。每次網路不穩或離線都會發生，以前會合併成一筆。
- 修正：每批每個 `entity:recordId` 最多送一筆，後續的等 ack 後再 rebase（它沒有 `sentAt`，可以安全 rebase）；或伺服器在同一請求內串接版本。
- 測試：已送出的列 + 後續編輯在同一批。

### N2. 完整重抓時游標在資料之後才讀（新回歸，已確認、已重現）— `worker/sync.ts:2024-2025`、`:2093-2094`
epoch 不符與請求中途 epoch 改變這兩條路徑，先 `querySyncDelta(full)` 再讀 `ensureUserSyncState`。查詢期間 commit 的寫入，其 seq ≤ 回傳的游標、但不在 snapshot 內 → 下次 `sinceSeq` 也拿不到，直到下次完整重抓才會出現。
- 修正：比照一般路徑（`:2081`），在完整查詢 **之前** 讀取 sync state，並以 `<= maxSeq` 限制查詢。

### F1. 本機股價變空，觸發路徑變多（已確認）— `syncEngine.ts:2027-2031`；觸發於 `:2617-2627`、`:2141-2150`、`:469-477`
asset 分支仍是整筆取代。現在每輪同步都會把待送但未送出的 mutation payload 疊到合併結果上，所以任何對自動更新股票的待送編輯（例如改成本，payload 已刪掉 `unitPrice` / `previousClose`）都會讓本機 `unitPrice` 變成 undefined。「保留我的」與「重新套用」也一樣。
- 修正：asset 套用 payload 時疊加在既有紀錄上（`{ ...serverOrExisting, ...payload }`）。

### N3. 「重新套用」凍結項目會覆蓋較新的編輯 — `syncEngine.ts:460-486`、`localDb.ts:480-496`
凍結後產生的編輯進入一般 outbox，可能已同步；重新套用時較舊的凍結 payload 蓋在 snapshot 上，並合併蓋掉較新的未送出 mutation，較新的編輯靜默遺失。另外重新套用用的是記憶體中的 `this.frozenOutbox`，之後寫入 `frozen_outbox=[]`，其他分頁在此期間凍結的項目會被丟掉。
- 修正：該紀錄若有較新的本機或 outbox 變更，就跳過或詢問；在交易內讀取凍結清單。

### N4. 舊 epoch 的 mutation 寫入還原後的資料（已重現）— `worker/sync.ts:2041-2079`、`:576`
replace 匯入在迴圈中途 commit 時，之後的新建會寫入還原後的資料並被 ack；且 replace 把 version 重設為 1，`baseVersion: 1` 的編輯／刪除也會通過（ABA），靜默覆蓋還原的資料。客戶端也不會看到這些被凍結。舊版客戶端（`since` 路徑、或 service worker 快取的 1.8.2～1.8.4）同樣會把 mutation 套用到還原後資料上。
- 修正：每筆主要寫入加上 `AND (SELECT data_epoch FROM user_sync_state WHERE user_id = ?) = ?`；0 列時檢查 epoch，停止迴圈並回傳 `epochMismatch`，剩下的不 ack。沒有 `clientEpoch` 且 `data_epoch > 1` 時，拒絕或保留其 mutation。

### R3 / R6 / R7. 被拒後還原相關（未修）
- R3：完整重抓的需求只存在記憶體（`syncEngine.ts:2535, 2675`），重抓失敗後被拒的值永久留在畫面上 → 在 ack 交易中持久化 `meta.pendingFullResync`。
- R6：同一筆有待送編輯時不還原（`:2535`）。
- R7：被拒新建因有待送編輯而跳過回滾，該編輯又在伺服器重建紀錄，卡片仍寫「已回滾」（`:2531`、`conflictUi.ts:362`）→ 未 ack 新建的後續編輯標 `isNewRecord: true`，新建被拒時一併移除或暫停，並在 `SyncRejection` 記錄實際動作。

---

## 次要問題

- **F4** 只改昨收時仍送出本機舊價格並帶 `manualPriceOverride`（`shared/validation.ts:370-374`）。
- **P2-S5** 新增 migration 將既有使用者的 `auto_fx_enabled` 設為 0（或依是否曾手動修改匯率推導）。
- **R5** 原始 DB 錯誤訊息以 400 回傳（`worker/index.ts:396, 577, 774`、`worker/auth.ts:874`）→ 非 UNIQUE / 驗證錯誤回通用 5xx。
- epoch 凍結時把已 ack 與已衝突的 mutation 也一起凍結（`localDb.ts:440-470` 讀整個 outbox）→ 排除 `clearedSet`。
- 跨分頁：分頁 B 在 `snapshot_changed` 重新載入完成前提交，會以過時的整份 snapshot 覆蓋 A 已合併的資料 → KV 中放 revision 計數器，在提交交易內比對。
- PIN / meta 跨分頁可能被還原成舊值（`syncEngine.ts:577-594, 2463`，待確認頻率）→ 逐欄位 patch 並廣播。
- 替代鎖非互斥，等待 15 秒後仍會執行（`syncEngine.ts:112-132`）→ 逾時回傳 busy，不要執行。
- Safari < 15.4 沒有 `navigator.locks` 也沒有 BroadcastChannel，完全沒有跨分頁同步 → 以 localStorage `storage` 事件作為 fallback。
- `destroy()` 不中止進行中的同步，切換帳號後舊 engine 對已關閉的 DB 操作，產生未處理的 rejection（`syncEngine.ts:390-404, 2705`）。
- mutex 覆蓋範圍依賴字串清單（`syncEngine.ts:300-331`），新增 CRUD 方法若忘記加入就不會被序列化 → 改用 decorator 或統一入口。
- 400 / 413 仍不重試。
- 報價未變時 `price_updated_at` / `fx_updated_at` 不再前進，「最後更新」時間看起來過時；回應仍把未變的代號列為已更新。
- chunked body 沒有 Content-Length 時仍整個讀入；PIN、passkey 註冊、個人資料、密碼端點未檢查 `X-Expected-User`。
- `ensureRentUtilitySettings` 仍以 `change_seq = 0` 新增。
- merge 匯入跳過已軟刪除的列卻仍計入匯入數，使用者不會被告知。

## 測試缺口

- R1（B 在 A commit 之後讀取）、R2（確定性約束錯誤）、N2（完整重抓期間的寫入）、N4（迴圈中途 replace）。
- N1（已送出列 + 後續編輯同批）、N3（重新套用時有較新編輯、凍結的是既有紀錄的編輯）。
- F1（缺價格的 asset payload 走 rebase / 保留我的 / 重新套用）、F4。
- 跨分頁或同一 DB 上兩個 engine、替代鎖、R3 / R6 / R7、請求中途 epoch 改變且含已 ack 的 id。

## 建議修正順序

1. **R2**（卡死同步）→ **R1**（假衝突）→ **N1**（新回歸、日常就會遇到）→ **N2**（新回歸、漏資料）
2. **F1**（畫面 NaN）→ **N4** → **N3**
3. R3 / R6 / R7 → F4 → P2-S5 → R5 → 其餘

R1、R2 已連續三輪審查未修好，建議要求附上「先失敗、後通過」的重現測試作為驗收條件。
