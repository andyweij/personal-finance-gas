# 第一階段審查複查（commit `a8c4de1`，v1.8.3）

- **對照**：[`2026-11-26_phase1_review.md`](./2026-11-26_phase1_review.md) 的 S1～S11、C1～C8，並以目前 HEAD `6358b29`（v1.8.4）確認最終狀態
- **驗證**：HEAD 上 `tsc --noEmit` 通過；`vitest run` 20 檔 / 128 測試全數通過。S1、S2 的殘留問題已用臨時測試重現（未加入 repo）。路徑相對於 `cloudflare-pwa/`，行號為 HEAD。

## 總評

伺服器端大多已修好（S3、S4、S6 merge 模式、S9、S10、S11）；S2 方向正確，但引入「毒丸 mutation 卡死整個同步」的回歸。**S1 在實際會發生的並行情境仍未修好**。客戶端 C2 已修好，C1、C3、C4 只修了一部分，其中 C1 的「還原」只存在記憶體。第二階段審查的 P2-C1（rebase 繞過衝突偵測）、P2-C3（並行編輯遺失）**仍未修**，而這次新增的自動完整重抓讓 P2-C1 更常發生。

## 判定

### 伺服器端

| 項目 | 判定 | 說明 |
|---|---|---|
| S1 重送 mutation 誤判衝突 | ⚠️ 部分（已重現） | 只處理寫入時 0 列或 DB 錯誤的情況；常見的並行情境仍回報衝突（R1） |
| S2 暫時性錯誤被當 rejected | ⚠️ 已修但有回歸 | `RejectError` / `runValidation`（`worker/sync.ts:412-426`）；非 RejectError 一律 rethrow → 確定性錯誤卡死同步（R2） |
| S3 限速器視窗 | ✅ | `worker/auth.ts:760-805` 單一原子 upsert ... RETURNING |
| S4 過期 challenge 清理 | ✅ | `worker/auth.ts:745-758`（`expires_at` 無索引，次要） |
| S5 連帶更新用客戶端時間 | ✅ | 先前已改為 `serverTime` |
| S6 匯入重設 version | ✅ merge 模式 / ⚠️ replace 模式 | replace 模式仍從 1 開始，對沒有 `clientEpoch` 的舊客戶端仍有 ABA |
| S9 `utility_record` 鍵不一致 | ✅ | 不一致即拒絕；但寫入用未正規化的 `recordId`（次要） |
| S10 刪除帳本 TOCTOU | ✅ | UPDATE 內 `NOT EXISTS`（`worker/sync.ts:749-753`） |
| S11 passkey `INSERT OR IGNORE` | ✅ | 但其他 DB 錯誤原文以 400 回傳（R5） |

### 客戶端

| 項目 | 判定 | 說明 |
|---|---|---|
| C1 被拒的編輯/刪除不回滾 | ⚠️ 部分 | 改為額外跑一次完整重抓，但需要重抓的標記只存在記憶體（R3）；同一筆有待送編輯時不重抓（R6） |
| C2 「從雲端重整並清除」 | ✅ | 等待結果、成功才清除、失敗顯示錯誤；同步中會等待後再完整重抓 |
| C3 回滾忽略較新的待送編輯 | ⚠️ 部分 | 有待送編輯時跳過回滾，但該編輯會在伺服器重建被拒的紀錄，卡片卻顯示「已回滾」（R7） |
| C4 新建判斷 | ⚠️ 部分 | 多數路徑已加明確的 `isNewRecord`；`syncEngine.ts` 418-462、1264-1324 等路徑仍靠 baseVersion 推斷 |
| C5 被拒內容無法重試 | ⚠️ 部分 | 加了「複製 JSON」，沒有重新套用 |
| C6 部分 entity 無法回滾 | ✅ 間接 | settings / utility_rents 改走完整重抓 |
| C7 狀態膠囊固定為衝突 | ⚠️ 部分 | 視窗內加了「立即同步其餘 N 筆」，但只在待送數 > 0 時出現 |
| C8 UI 說明誇大 | ⚠️ 仍誇大 | 「已回滾／已還原」在重抓失敗、跳過回滾時並不成立 |

### 第二階段遺留

| 項目 | 狀態 |
|---|---|
| P2-C1 rebase 繞過衝突偵測 | ❌ 未修，且自動完整重抓讓它更常觸發（完整 delta 會命中所有紀錄） |
| P2-C3 並行本機編輯遺失 | ❌ 未修，額外的重抓輪次讓競態視窗更大 |

---

## 需修正（依嚴重度）

### R1. S1 並行重送仍回報衝突（已確認、已重現）— `worker/sync.ts:2053-2054`
請求 A、B 帶相同 mutationId，都通過迴圈開頭的 idempotency 檢查；A commit 後，B 讀到已遞增的版本（新建則讀到已存在的列），在 `checkVersionOrThrow`（`:458`、`:474`）就拋出 `VersionConflictError`，根本沒進到新加的 idempotency 判斷。客戶端 20 秒逾時重試時就會遇到。現有測試只在「兩者都在 A commit 前讀取」的窄情境下通過。
- 修正：`processSyncRequest` 的 `VersionConflictError` 分支中，再查一次 `sync_idempotency`，存在就 ack。加入「B 在 A commit 之後才讀取」的測試（update / create / delete 三種）。

### R2. 確定性的非驗證錯誤會永久卡死同步（已確認、已重現）— `worker/sync.ts:2062-2066`、`web/src/sync/syncEngine.ts:2254-2258`
DB 約束或型別錯誤不是 `RejectError`，會讓整個請求回 500。例：`savings_adjustment` 的 `twdAmount: 'abc'` → `Math.round(Number('abc'))` 為 NaN → `NOT NULL constraint failed` → 500。真實 D1 綁定物件型別的 `recordId` 也會丟 `D1_TYPE_ERROR`（mock 不會）。客戶端對 5xx 無限退避重試，壞的 mutation 卡在 outbox 最前面；因為拉取資料走同一個請求，**這台裝置也再也收不到伺服器的任何變更**。
- 修正：
  - 伺服器先檢查 `mutationId`、`recordId`、`entity`、`op`、`baseVersion`、`payload` 的型別；數值欄位用 `Number.isFinite` 驗證。
  - 將 `SQLITE_CONSTRAINT`、`D1_TYPE_ERROR` 歸類為 `RejectError`（回傳通用訊息）。
  - 客戶端：同一批連續失敗 N 次後改為一筆一筆送出以隔離壞的 mutation，並移入拒絕清單；失敗時另送只拉取（`mutations: []`）的請求，讓資料仍能下載。啟用既有但未使用的 `retryCount` / `lastError`。
  - 400 / 413 / 429 目前視為非暫時性且永不重試，也會讓 outbox 卡到使用者手動同步為止。

### R3. 被拒後的「還原」只存在記憶體 — `syncEngine.ts:2074, 2227-2230`
編輯被拒時，ack 會先存下新游標並把 mutation 移出 outbox，再額外跑一輪完整重抓。若這一輪逾時、5xx、分頁被關、或已到第 20 輪上限，之後都是增量同步，本機被拒的值或被刪掉的紀錄永久與伺服器不一致，卡片卻顯示「已還原」。失敗時也只有 outbox 非空才排重試。
- 修正：在 ack 的同一個交易中寫入 `meta.pendingFullResync = true`（或把 `syncCursor` 設為 null），完整套用成功後才清除；`performSync` 開頭看到旗標就先完整重抓。

### R4. 完整重抓讓 P2-C1 更嚴重 — `syncEngine.ts:2139-2203`
完整 delta 中 `findRecordInDelta` 會命中所有紀錄，所以這一批之外的待送 mutation（outbox 超過 50 筆、或請求進行中產生的編輯）全部會被 rebase 到伺服器當前版本。現在被拒的編輯與 C2 按鈕都會自動觸發完整重抓，每次都會靜默跳過衝突偵測、覆蓋其他裝置的修改。
- 修正：同第二階段審查 P2-C1 — 只有當伺服器版本是由這台裝置自己這次被 ack 的寫入所產生時才 rebase，否則保留原 baseVersion。

### R5. 原始 DB 錯誤訊息回傳給客戶端 — `worker/auth.ts:874`、`worker/index.ts:396`
非 UNIQUE 的 DB 錯誤原文以 400 回傳：洩漏內部訊息，且讓暫時性錯誤看起來像永久錯誤。
- 修正：非 UNIQUE 錯誤回傳通用 5xx 訊息。

### R6. 同一筆有待送編輯時不還原 — `syncEngine.ts:2104`
編輯 E1（送出中）被拒、E2 已排隊：不會完整重抓。E2 的 payload 是整筆本機紀錄，仍帶著 E1 被拒的值 → 要嘛 E2 也被拒（之後才重抓），要嘛 E2 把 E1 被拒的值寫進伺服器（拒絕原因與狀態有關、而非欄位驗證時可能發生，待確認）。
- 修正：被拒的編輯一律排完整重抓，再把待送編輯重新套用在重抓結果上；或標記待送編輯讓使用者確認。

### R7. 被拒的新建會復活且標示錯誤 — `syncEngine.ts:2101`、`web/src/db/localDb.ts:294-313`
新建 M1 送出中、使用者又編輯 X → M2 的 `isNewRecord` 為 false、baseVersion 為 null。M1 被拒時因為有待送編輯而跳過回滾；M2 送出後伺服器找不到列就建立 X。結果 X 在本機與伺服器都存在，卡片卻寫「新建遭拒（已回滾）」。另外，待送編輯集合是在 await 之前讀取的（`:2066`），之後才提交的編輯會被漏掉，導致本機刪掉 X、但新編輯之後又在伺服器重建它。
- 修正：該紀錄的 in-flight mutation 是新建時，後續編輯也標 `isNewRecord: true`；新建被拒時，一併移除或暫停該紀錄的待送編輯。在 `SyncRejection` 上記錄實際做了什麼（`rolledBack` / `restored`），卡片文字依此顯示。

### R8. P2-C3 並行本機編輯遺失仍在 — `syncEngine.ts:1666-1692, 2117-2218`
同第二階段審查。額外的重抓輪次讓「合併伺服器回應 → 儲存」之間的視窗出現得更頻繁。
- 修正：以 promise-chain mutex 序列化所有本機提交與同步套用。

---

## 次要問題

- C4 仍使用推斷的路徑：`syncEngine.ts:418-462`、`1264-1324` 呼叫 `commitAndMaybeSync` 時沒帶旗標；升級前已在 outbox 的 settings / utility_rents 會被當成新建（`:2082-2086`）。
- 每次被拒的編輯都多一次完整下載；被拒的編輯分散在多批時，很快就到 20 輪上限，回傳 ok、outbox 仍有資料卻不排重試 → 改為 outbox 清空後統一做一次完整重抓。
- 有拒絕紀錄時狀態膠囊固定顯示衝突，隱藏待送與離線數量；outbox 為空時沒有任何地方能手動拉取。
- C2 的 `ok` 不代表真的還原（到上限也回傳 ok；R7 的新建不會因重抓而消失）。
- epoch 不符時整批被拒，卡片仍承諾回滾／還原。
- 刪除帳本時版本不符且有關聯紀錄，會回傳拒絕而非衝突（語意改變，影響小）。
- `utility_record` 寫入用未正規化的 `recordId`，與匯入使用的 `v.period` 可能不一致。
- `auth_challenges.expires_at` 無索引，每次 options 請求都全表掃描。
- `locked_until` 欄位仍被寫入但已無人讀取。

## 測試缺口

- S1：B 在 A commit 之後才讀取的並行重送（R1）。
- S2：確定性的 DB 約束錯誤（R2）；客戶端對 5xx 的退避與永遠失敗的 mutation。
- C1：完整重抓失敗（R3）；C3：同一筆有待送編輯且之後被拒或被接受（R6、R7）；以 `isNewRecord` 回滾的新建。
- C4 測試是手動注入 `isNewRecord: false`，沒有走實際缺旗標的 CRUD 路徑。
- C2 的 UI 流程（只在成功時清除、失敗顯示錯誤）、複製按鈕、卡片文字。

## 建議修正順序

R2（卡死同步）→ R1 → R4（P2-C1）→ R8（P2-C3）→ R3 → R6、R7 → R5 → 其餘
