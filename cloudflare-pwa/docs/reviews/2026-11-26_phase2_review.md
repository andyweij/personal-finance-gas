# 第二階段修正審查（commit `8668253`，v1.8.2）

- **對照規格**：[`2026-11-26_fix_plan.md`](./2026-11-26_fix_plan.md) 第二階段 2.1～2.7，以及 [`2026-11-26_phase1_review.md`](./2026-11-26_phase1_review.md) 的未結項目
- **驗證**：`tsc --noEmit` 通過；`vitest run` 18 檔 / 116 測試全數通過。標「已確認」者已對照程式碼。路徑相對於 `cloudflare-pwa/`，行號為該 commit 之後的檔案。

## 總評

`change_seq` 游標的主路徑設計正確：每位使用者一個計數器（`user_sync_state`），與資料列在同一個 D1 batch 內遞增；讀取時以 `change_seq > sinceSeq AND <= maxSeq` 取差異，不會跳號漏資料。逾時、批次、跨帳號 409、commit-before-mutate 也都有做。

但 **客戶端的 rebase 邏輯會繞過衝突偵測**、**commit-before-mutate 引入了新的遺失更新競態**，且第一階段審查的 S2（資料遺失）、S3、S9、C1、C2 **都還沒修**。

## 各項判定

| 項目 | 判定 | 說明 |
|---|---|---|
| 2.1 同步中編輯不合併進 in-flight | ⚠️ 部分 | 只在單一分頁、記憶體內有效；逾時/重新載入後失效（P2-C2） |
| 2.1 ack 後 rebase | ❌ 有 bug | 只要伺服器 delta 出現該紀錄就 rebase，不管是不是自己的寫入被 ack（P2-C1） |
| 2.2 `change_seq` 游標 | ⚠️ 部分 | 主路徑正確；CSV 匯入路徑會漏資料（P2-S1） |
| 2.2 `updated_at` 改用伺服器時間 | ✅ | |
| 2.3 replace 匯入 / `data_epoch` | ⚠️ 部分 | epoch 有做，但有競態（P2-S2）；outbox 處理不一致（P2-C4）；merge 模式仍把 version 重設為 1 |
| 2.4 報價遞增 version | ⚠️ 完成但有副作用 | 價格沒變也遞增，造成持股/設定編輯頻繁衝突（P2-S4） |
| 2.4 自動匯率為選用 | ❌ 未完成 | `auto_fx_enabled DEFAULT 1`，所有既有使用者預設開啟；手動更新報價時強制更新匯率 |
| 2.5 `X-Expected-User` → 409 | ✅ `/api/sync` | 匯入、報價更新端點未檢查 |
| 2.5 BroadcastChannel | ⚠️ 部分 | 只有切換帳號；登出與 snapshot 變更沒有通知 |
| 2.6 逾時 / 退避 / 批次 / 上限 | ⚠️ 部分 | 20 秒逾時、退避、每批 50 筆、伺服器上限 200 筆 / 2MB 都有；缺「outbox 非空時定期重試」；無 `navigator.locks` 時沒有替代鎖 |
| 2.7 commit-before-mutate | ⚠️ 完成但引入競態 | 所有 CRUD 都已改走 `commitAndMaybeSync`；但並行編輯會互相覆蓋（P2-C3） |

### 第一階段審查未結項目

| 項目 | 狀態 |
|---|---|
| S1 重送 mutation 誤判衝突 | ⚠️ 依序重送已修；**並行**重送（逾時後重試、第一個請求仍在跑）仍回報衝突 |
| S2 暫時性錯誤被當 rejected → 資料遺失 | ❌ 未修（`worker/sync.ts:1939-1947`） |
| S3 限速器視窗不重置 | ❌ 未修（`worker/auth.ts:776`） |
| S6 匯入重設 version 為 1 | ⚠️ replace 模式由 epoch 處理；merge 模式仍有 |
| S9 `utility_record` 鍵不一致 | ❌ 未修（`worker/sync.ts:1605` vs `~1684`） |
| C1 被拒的編輯/刪除不回滾 | ❌ 未修（`syncEngine.ts:2017-2019`） |
| C2 「從雲端重整並清除」 | ❌ 未修（`conflictUi.ts:317-326`） |
| C3 回滾忽略較新的待送編輯 | ⚠️ 行為改變但仍錯：被拒的新建會被 rebase 迴圈重新加回並以新建重送 |
| C4 以 baseVersion 判斷新建 | ❌ 未修 |

---

## 需修正（依嚴重度）

### P2-C1. Rebase 會覆蓋其他裝置的修改、繞過衝突偵測（已確認）— `web/src/sync/syncEngine.ts:2050-2124`
只要伺服器 delta 中出現該紀錄，就把待送 mutation 的 `baseVersion` 改成伺服器版本。
- 情境 A：in-flight 的 U1 因另一台裝置寫了 v4 而衝突；待送的 U2 被 rebase 到 v4，直接覆蓋另一台裝置的資料。
- 情境 B：離線累積超過 50 筆，後面批次尚未送出的 mutation 會被 rebase 到其他裝置的變更上，完全不會產生衝突。
- 報價更新遞增 version 後、以及 settings，也會發生同樣的事。
- 修正：只有當該紀錄的 in-flight mutation 在 `ackedMutationIds` 中、且伺服器版本等於該次 ack 產生的版本時才 rebase；否則保留原 baseVersion，讓伺服器回報衝突。

### P2-C3. commit-before-mutate 造成並行編輯遺失（已確認，新引入的回歸）— `syncEngine.ts:1631-1646`
每個 CRUD 都從 `this.snapshot` 算出 `nextSnapshot`，`await commitLocalMutation` 之後才指派。兩個重疊的儲存（連點、兩個 handler）從同一個基底出發，第二個會覆蓋第一個；第一筆 mutation 還在 outbox，但在 UI 與本機 snapshot 中消失，離線時就一直不見。同步回應處理也有同樣競態：`mergeDelta` 與 `acknowledgeOutboxAndSave` 之間插入的本機儲存，會蓋掉已合併的 delta，而游標已前進。
- 修正：以 promise-chain mutex 序列化所有本機變更與同步套用；或維護一個同步更新的「已提交待寫入」head 作為計算基底。

### P2-S1. CSV 匯入的資料對增量同步不可見（已確認）— `worker/index.ts:583-722`
`bumpSeqForCsv()` 只執行一次，之後每列各自 INSERT，都使用同一個 seq。若另一台裝置在中間同步並把游標存成 N，之後寫入的第 2..k 列（seq 也是 N）永遠不會被拉到。
- 修正：遞增與所有列放在同一個 batch（比照 `automation.ts`），或每列各自搭配遞增。

### P2-S2. epoch 競態：回傳部分 delta 卻帶新 epoch — `worker/sync.ts:1885-1910, 1951-1966`
epoch 只在套用 mutation 前檢查。若另一台裝置在請求進行中完成 replace 匯入，伺服器會回傳 `sinceSeq` 的部分 delta、新的 `dataEpoch`、`fullResyncRequired: false`；客戶端看到 epoch 改變（`syncEngine.ts:2025-2028`），把部分 delta 當完整 snapshot 套用，本機資料縮水成只剩 delta。
- 修正：結束時再讀一次 epoch，與開始時不同就回傳完整資料並設 `fullResyncRequired: true`；更好的做法是每個 mutation batch 加 `data_epoch = ?` 條件。

### P2-S3. S2 仍未修：暫時性錯誤導致資料遺失 — `worker/sync.ts:1939-1947`
（同第一階段審查 S2）D1 失敗等非衝突錯誤仍進 `rejected`，客戶端會把它移出 outbox。
- 修正：只有型別為 `RejectError`（驗證、業務規則、白名單）的錯誤才進 `rejected`；其他錯誤讓整個請求回 5xx 由客戶端重試。

### P2-C2. 「已送出」狀態只存在記憶體 — `syncEngine.ts:173, 2174-2177`；`localDb.ts:294-298`
in-flight 集合在 `finally` 清除（包含逾時中止）。若伺服器其實已 commit M1，但 20 秒逾時觸發、或 App 在同步中重新載入：
- 之後的編輯會合併進 M1、換新 mutationId 但保留舊 baseVersion → 與自己的寫入衝突（伺服器的 mutationId 重送 ack 機制因 ID 被換掉而用不上）。
- 刪除一筆新建已送達伺服器的紀錄會在本機互相抵銷 → 伺服器上仍存在，下次拉取時復活。
- 修正：在 outbox 列上持久化 `sentAt` / `attempts`；曾送出過的列不得合併或抵銷，以原 ID 重送，後續變更另排新 mutation。

### P2-C4. epoch 改變時 outbox 非空會遺失資料 — `worker/sync.ts:1890-1899`；客戶端 `syncEngine.ts:2024-2033`
伺服器只拒絕這一批（最多 50 筆），客戶端把它們移出 outbox 放進拒絕清單，但 UI 沒有「重新套用」功能 → 這 50 筆等同遺失。其餘待送的 mutation 又經 P2-C1 被盲目 rebase 到還原後的資料上，或在下一批以新 epoch 送出並套用。結果：前 50 筆被丟掉、其餘覆蓋還原的資料。
- 修正：epoch 改變時凍結整個 outbox，顯示一次提示：全部捨棄，或以新 epoch 重新套用。伺服器端對這類 mutation 回傳獨立狀態（例如 `requeueAfterResync`），不要放進 `rejected`。

### P2-S4. 報價/匯率沒變也遞增 version — `worker/market.ts:534-540, 591-597`
每天三次排程都會遞增所有自動報價資產與 `app_settings` 的 version。任何離線或同步中的持股編輯、設定（如每日預算）編輯，每次報價更新後都會衝突；使用者選「保留我的」時，payload 中的舊 `unitPrice` / `usdTwdRate` 又會蓋掉新報價。
- 修正：UPDATE 加 `WHERE unit_price IS NOT ? OR previous_close IS NOT ?`（匯率同理）。長期應讓報價欄位不屬於客戶端可寫入的 payload，或在伺服器端合併。

### P2-S5. 自動匯率不是選用（已確認）— `migrations/0013...sql:26`、`worker/index.ts:527`
`auto_fx_enabled INTEGER NOT NULL DEFAULT 1` 讓所有既有使用者預設開啟，曾手動輸入匯率但沒去關開關的人仍會被覆蓋。`/api/market/refresh` 傳 `forceFx: true`，即使關閉自動匯率，按更新報價也會覆蓋。
- 修正：新 migration 將既有使用者設為 0（或依是否曾手動修改推導），並只在開啟時更新匯率。

### P2-S6. 並行重送仍回報衝突（S1 未完全修）— `worker/sync.ts:546-559, 1939`
逾時後重試、第一個請求仍在執行時，兩者都通過前置 idempotency 檢查，第二個條件寫入 0 列 → 回報衝突，客戶端顯示假衝突並清掉 outbox。
- 修正：`changed !== 1` 時與衝突 catch 中，先查 `sync_idempotency`，存在就 ack。

---

## 次要問題

- **P2-C5** Rebase 可能讓舊 mutation 復活（`syncEngine.ts:2051` 讀 outbox 後 await，期間本機合併 P→P'，之後 delete(P) 無效、put 舊 P 回來）→ 在 ack 交易內計算 rebase。
- **P2-C6** 多分頁使用過時 snapshot：分頁 B 用舊的記憶體 snapshot 儲存，覆蓋分頁 A 已合併的資料，且游標已前進 → 廣播 `snapshot_changed` 並從 IndexedDB 重新載入；in-flight 狀態存進 IndexedDB。
- **P2-C7** 沒有 `navigator.locks`（iOS Safari < 15.4）時完全不加鎖（`syncEngine.ts:205-210`）→ IndexedDB/localStorage lease 或 BroadcastChannel 選主。
- **P2-C8** 批次迴圈結束後 outbox 可能卡住：伺服器沒 ack 任何東西時回傳 ok 不重試、20 輪後停止、429 與其他 4xx 永不重試 → outbox 非空時定期重試、429 依 `Retry-After` 退避、「無進展」視為失敗。
- **P2-C9** 衝突解決的寫入非原子（`resolveConflictKeepServer` 分兩個交易、`resolveConflictKeepLocal` 先存衝突再 commit）。
- **P2-C10** 跨帳號：`destroy()` 只清重試計時器；登出不廣播；`accountMismatchHalted` 只在記憶體。
- **P2-S7** S9 未修：`utility_record` 以 `recordId` 查詢、以 `v.period` 寫入 → 不一致即拒絕。
- **P2-S8** merge 匯入仍把 version 重設為 1 且清除 `deleted_at`（ABA、已刪除資料復活）→ `ON CONFLICT DO UPDATE ... version = version + 1`。
- **P2-S9** 舊版客戶端（沒有 `clientEpoch` / `sinceSeq`）在 replace 匯入後永遠收不到被硬刪除的紀錄 → replace 改軟刪除，或 epoch > 1 時拒絕舊的 `since` 路徑。
- **P2-S10** S3 未修：passkey options 限速器視窗不重置。
- **P2-S11** body 上限以 `rawText.length`（UTF-16 字元數）計算，中文內容實際可達約 6MB，且先讀完整個 body 才檢查 → 先看 `Content-Length`，再以 `TextEncoder` 計算位元組。`X-Expected-User` 只檢查 `/api/sync`。
- **P2-S12** `ensureDefaultLedger` / `ensureAppSettings` 以 `change_seq = 0` 新增，目前只影響新使用者，但日後若對已有游標的使用者延遲建立就會不可見。
- **P2-S13** 舊的 `since` 相容路徑仍以請求開始時間當游標（原 2.2 問題），僅在舊版客戶端短期存在時可接受。

## 測試缺口

- 2.1：in-flight 寫入衝突時有待送編輯（P2-C1）、>50 筆未送出 + 其他裝置變更、伺服器已 commit 後逾時再編輯/刪除、同步中重新載入、同一 DB 上第二個 engine。
- 兩個 `addCashFlow` 不等待地並行呼叫（P2-C3）。
- epoch 改變時 outbox 非空（P2-C4）；請求進行中發生 replace 匯入（P2-S2）。
- 逾時測試的 outbox 是空的，未驗證退避與重試排程；缺 5xx、429、jitter、無進展、達上限的測試；鎖一律注入，未測 `navigator.locks` 路徑與 fallback。
- 2.5 只有伺服器測試，客戶端 409 停止、`onAccountMismatch`、BroadcastChannel 未測。
- CSV 匯入的 `change_seq`（P2-S1）。
- C1、C2 仍無測試。

## 建議修正順序

1. **資料遺失類**：P2-S3（S2）→ P2-C1 → P2-C3 → P2-S1 → P2-C4 / P2-S2
2. **假衝突類**：P2-S4、P2-S6、P2-C2
3. **第一階段遺留**：C1、C2、S3、S9
4. 其餘次要問題與測試缺口
