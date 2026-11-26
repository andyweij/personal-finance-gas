# 第一階段修正審查（commit `6c0b194`，v1.8.1）

- **對照規格**：[`2026-11-26_fix_plan.md`](./2026-11-26_fix_plan.md) 第一階段 1.1～1.6
- **驗證**：`npm ci`、`tsc --noEmit` 通過；`vitest run` 17 檔 / 108 測試全數通過。發現 S1 已用臨時測試重現（未加入 repo）。標「已確認」者已對照程式碼。

## 各項判定

| 項目 | 判定 | 說明 |
|---|---|---|
| 1.1 Passkey challenge 綁定 + options 限速 | ✅ 完成，限速器有 bug | `auth.ts:796-831` 從 clientDataJSON 取 challenge 並以 `DELETE ... RETURNING` 原子取用；限速器見 S3 |
| 1.2 Passkey 不可覆蓋、discoverable login | ✅ 完成 | `INSERT OR IGNORE` + `changes!==1` 拋錯；不再依 username 回傳 allowCredentials |
| 1.3 條件式 UPDATE / `ON CONFLICT DO NOTHING` | ⚠️ 完成但有 bug | 所有寫入皆帶 `version=?` 條件；重送同一 mutation 會被誤判為衝突（S1） |
| 1.4 原子性 batch | ✅ 完成 | mutation + idempotency 同一 batch；匯入先完整驗證再單一 batch |
| 1.5 處理 `rejected` | ⚠️ 部分 | 移出 outbox、持久化、UI 顯示皆有；但只回滾「新建」，編輯/刪除被拒後本機永久與伺服器不一致（C1）；伺服器把暫時性錯誤也當 rejected（S2） |
| 1.6 entity/op 白名單 | ✅ 完成 | `sync.ts:445-458`，在 idempotency 檢查前套用 |

---

## 需修正（依嚴重度）

### S1. 重送的 mutation 被回報為衝突而非 ack（已確認、已重現）— `worker/sync.ts:488-504`
兩個請求帶相同 mutationId 時都可通過 idempotency 檢查；第一個成功後，第二個的條件寫入 changes=0，`commitAtomicMutation` 直接拋 `VersionConflictError`，只有 catch 路徑（`:506-512`）才查 `sync_idempotency`。
- 情境：客戶端逾時重試、或兩分頁共用 outbox → 使用者看到「與自己已成功的寫入衝突」。
- 修正：`changed !== 1` 時先查 `sync_idempotency`，存在即視為成功。加測試。

### S2. 暫時性錯誤被當成永久拒絕 → 資料遺失（已確認）— `worker/sync.ts:1734-1739`
所有非衝突錯誤（含 D1 過載、逾時）都進 `rejected`；而新版客戶端收到 rejected 會移出 outbox 並回滾新建。D1 短暫失敗就會丟掉使用者資料。
- 修正：定義 `RejectError`（驗證、業務規則、白名單），只有它進 `rejected`；其他錯誤不 ack、不 reject，讓客戶端重試（或回 5xx）。`reason` 也只回傳經整理的訊息，不要直接回 `err.message`。

### C1. 被拒的編輯/刪除不回滾（已確認）— `web/src/sync/syncEngine.ts:1765-1775`
只有 `baseVersion` 為 null/0 的 upsert 會回滾。編輯被拒 → 本機保留被拒的值；刪除被拒 → 本機消失但伺服器仍在。增量同步不會帶回（伺服器端沒變），按「清除此通知」後完全無線索。
- 修正：非新建的 rejection 觸發下次完整重抓，或保存編輯前的伺服器紀錄以還原。

### S3. options 限速器視窗永不重置（已確認）— `worker/auth.ts:776-791`
以 `updated_at` 判斷視窗過期，但每次請求都更新 `updated_at`，只有靜默 60 秒才重置；持續有流量的共用 NAT IP 最終會被鎖住。且讀後寫非原子。
- 修正：另存 `window_start`，或單一原子 `UPDATE ... SET count = CASE WHEN 過期 THEN 1 ELSE count+1 END ... RETURNING`。

### C2. 「從雲端重整並清除」可能靜默失敗（已確認）— `web/src/ui/conflictUi.ts:316-326`
先清除通知再同步，不檢查 `syncNow(true)` 結果，一律顯示成功；同步進行中時 `syncNow` 回傳既有 promise，根本不會完整重抓。
- 修正：await 結果，`ok` 才清除；同步中則排入完整重抓。

### C3. 回滾時忽略仍在 outbox 的較新編輯 — `syncEngine.ts:1765-1775`
新建 X（M1）送出中又編輯 X（合併成 M2，仍是 baseVersion null）；M1 被拒 → X 從本機移除但 M2 仍在 outbox，下次成功後 X 又出現，留下過時的拒絕通知。
- 修正：回滾前檢查 outbox 是否有同 `entity:recordId` 的待送 mutation。

### C4. 以 baseVersion 推斷「是否新建」不可靠（待確認）— `syncEngine.ts:1765`
多處以 `x.version ?? null` 設 baseVersion，舊資料無 version 欄位時會被當成新建；若被拒就會刪掉伺服器上存在的紀錄。
- 修正：mutation 上明確標記「本機新建、尚未 ack」。

---

## 次要問題

- **S4** 過期 challenge 從不刪除，公開 options 端點使 `auth_challenges` 持續成長 → `saveChallenge` 時順便 `DELETE WHERE expires_at <= ?`。
- **S5** 預設儲蓄帳戶的連帶更新使用 `check.writeTs`（legacy client 為客戶端時間，`sync.ts:1168-1178`），可能讓其他裝置增量同步漏掉 → 改用 `serverTime`。
- **S6** 匯入把所有 version 重設為 1（`sync.ts:1934` 等），造成樂觀鎖 ABA 漏洞：持有舊 `baseVersion: 1` 的客戶端可覆蓋 → 既有 id 應 `version + 1`。（既有問題，但削弱 1.3）
- **S7** replace 匯入仍硬刪除，其他裝置不知道刪除（屬第二階段 2.3）。
- **S8** 大型匯入單一 batch 可能超過 D1 限制而永遠無法成功（待確認）→ 刪除後分塊插入或暫存表。
- **S9** `utility_record` 以 `recordId` 查詢、卻以 `v.period` 寫入（`sync.ts:1515` vs `:1573, 1597`），兩者不同時會誤判衝突或寫到別的期別 → 統一鍵，不一致即拒絕。
- **S10** 刪除帳本前的關聯檢查在 batch 外（`sync.ts:621-637`），仍有 TOCTOU → UPDATE 內加 `NOT EXISTS`。
- **S11** `INSERT OR IGNORE` 會把 NOT NULL/CHECK 錯誤也誤報為「憑證已綁定」→ 改一般 INSERT 並捕捉 UNIQUE 錯誤。
- **S12** 沒有 baseVersion 的舊客戶端現在可能收到衝突（以前是後寫者勝），需寫入 release notes。
- **C5** 被拒項目無法重試或複製內容（`clientPayload` 已存但未使用）。
- **C6** `removeRecordFromSnapshot` 不處理 `settings`、`utility_rents`。
- **C7** 有任何 rejection 時狀態膠囊固定為 conflict，點擊只開視窗、無法手動同步；`syncing`/`auth_required` 狀態缺 `rejectedCount`。
- **C8** UI 說明只提到新建已回滾，未告知編輯/刪除沒有回滾。
- **Doc** `docs/DATABASE_SCHEMA.md` 標頭仍寫 v1.8.0。

## 測試缺口

- 相同 mutationId 的並行重送（S1）、batch 中途語句失敗的回滾、成功的 Passkey 登入、`finishPasskeyRegistration` 整體流程、限速視窗重置（S3）。
- 客戶端：被拒的編輯/刪除、同步中合併後被拒、ack/衝突/拒絕混合回應、重新載入後拒絕清單仍在、`clearRejections`、重整按鈕行為。
- mock D1 差異：`bind()` 回傳 `this`（真 D1 回傳新 statement）、`run()` 對 RETURNING 回傳空陣列。

## 建議修正順序

S2（資料遺失）→ S1 → C1 → S3 → C2、C3 → 其餘。S1、S2、S3 改動都很小。
