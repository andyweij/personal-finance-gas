# 設計審查報告（2026-11-26）

- **審查基準**：commit `9e03fa5`（cloudflare-pwa v1.7.1）；行號以該版本為準。
- **範圍**：`cloudflare-pwa/`（Worker 後端、PWA 前端、shared）為主，附錄記錄根目錄 GAS 版的發現。
- **方式**：靜態閱讀原始碼。標示「已確認」者已對照程式碼驗證；未實際執行重現。
- **對應修正計畫**：[`2026-11-26_fix_plan.md`](./2026-11-26_fix_plan.md)

## 總評

架構方向正確：多租戶查詢皆帶 `user_id` 過濾、具樂觀鎖版本號、Passkey、PBKDF2、登入限速、相當數量的測試，使用者輸入多以 `textContent` 輸出，未見明顯 XSS。主要問題集中在 **同步正確性**、**認證細節** 與 **本機資料保護**。

---

## 一、高優先（錯誤或安全漏洞）

### 後端（Worker）

| # | 問題 | 位置 | 說明 / 失敗情境 | 建議 |
|---|---|---|---|---|
| B1 | Passkey 登入 challenge 未綁定（已確認） | `worker/auth.ts:770-777, 885, 895` | `consumeChallenge('authenticate', null)` 取全站最新一筆並先刪除；併發登入互相失敗，持續呼叫 options 端點可癱瘓所有人的 Passkey 登入 | 由 `clientDataJSON` 取 challenge，`DELETE ... WHERE challenge=? RETURNING` 原子取用；options 端點限速 |
| B2 | Passkey 註冊可覆蓋他人（已確認） | `worker/auth.ts:840-846, 858-870` | `INSERT OR REPLACE` 以 `credential_id` 為鍵，login options 會回傳任一使用者的 credential ID | 一般 `INSERT`，ID 已存在則拒絕；改用 discoverable login |
| B3 | 登入限速可被並行繞過 | `worker/auth.ts:236-281` | 先讀後寫非原子；鍵為 IP+帳號，多 IP 可無限嘗試；`/api/auth/setup` 未限速 | 原子 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`；加 per-username 計數 |
| B4 | 管理員重設密碼等同帳號接管 | `worker/auth.ts:604-676` | 與 `SDD_multi_tenant.md`「管理員看不到成員資料」矛盾 | 稽核紀錄、登入提示、撤銷 Passkey/PIN；修正文件信任模型 |
| B5 | PIN 雜湊與 salt 下發客戶端 | `worker/index.ts:122-124`、`worker/auth.ts:386` | 4–6 位數 PIN 在 PBKDF2-100k 下可離線數秒～數分鐘破解 | 伺服器驗證 + 限速；離線用每裝置 verifier |
| B6 | Session 無限延長、過期資料不清理 | `worker/auth.ts:206-211` | 每次請求延長 30 天且寫入 D1；sessions/challenges/rate_limits/idempotency 無限成長 | 絕對上限、降低刷新頻率、Cron 清理 |
| B7 | 租戶欄位預設 `'owner'` | `migrations/0007`、`0011` | 未來任何漏寫 `user_id` 的 INSERT 會寫進管理員帳號 | 新 migration 移除預設值並加 FK |
| B8 | 樂觀鎖檢查與寫入間有競態（已確認） | `worker/sync.ts:385-442` 及各寫入 | JS 比對版本後無條件寫入；兩裝置同 baseVersion 同時同步會靜默遺失一筆 | `WHERE ... AND version=?` 並檢查 `meta.changes` |
| B9 | 增量同步游標可能永久漏資料 | `worker/sync.ts:1349, 391-393, 1290-1298` | 以請求開始時間為 cursor，交錯請求會跳過；legacy client 以客戶端時間寫 `updated_at` | 伺服器遞增 `change_seq`，或重疊視窗 |
| B10 | 寫入非原子 | `worker/sync.ts:1373-1378, 1433-1445`、`worker/automation.ts:112-150` | mutation 與 idempotency 分開寫；replace 匯入中途失敗留下半套資料 | `db.batch()` |
| B11 | Replace 匯入破壞其他裝置 | `worker/sync.ts:1434-1441, 1456, 1502` | 硬刪除 + version 重設為 1；其他裝置無從得知刪除 | 軟刪除或 `data_epoch` 強制重抓 |
| B12 | 伺服器更新報價未遞增 version | `worker/market.ts:508-521, 562-569` | 客戶端以舊 baseVersion 覆蓋新報價；Cron 覆蓋使用者手動匯率 | `version+1`；報價獨立儲存 |
| B13 | 未知 entity/op 被靜默確認 | `worker/sync.ts:444-1274, 1357-1379` | 新版客戶端對舊版 Worker 時資料遺失；非 delete 的 op 一律當 upsert | 白名單，未知者 rejected |

### 前端（PWA）

| # | 問題 | 位置 | 說明 / 失敗情境 | 建議 |
|---|---|---|---|---|
| F1 | 同步中編輯會與自己衝突（已確認） | `web/src/db/localDb.ts:248-267` | outbox 合併不分辨已送出的 mutation；新增後立刻刪除會死而復生 | 標記 in-flight，不合併；ack 後 rebase |
| F2 | 伺服器 `rejected` 未處理（已確認） | `web/src/sync/syncEngine.ts:1497-1500` | 被拒 mutation 永留 outbox，每次重送 | 移出並顯示「同步失敗」清單 |
| F3 | 登出不清本機資料 | `web/src/ui/securityUi.ts:1109-1116`、`main.ts:354` | 共用裝置下一人可見全部資料 | 登出刪除 IndexedDB；未登入時需驗證 |
| F4 | 鎖定畫面僅為 UI 遮罩 | `web/src/db/localDb.ts:152-188`、`main.ts:295-298` | IndexedDB 明文；devtools 可移除遮罩；離線 WebAuthn 非 ES256 時 fail-open（`offlineWebAuthn.ts:225,235`） | `inert`、背景自動上鎖、fail-closed；如需真保護則加密 snapshot |
| F5 | 多分頁跨帳號寫入 | `web/src/sync/syncEngine.ts:1451-1459` | 分頁 B 改登入後，分頁 A 的 outbox 寫入 B 帳號 | `X-Expected-User` + 409；BroadcastChannel |
| F6 | Service Worker 首次離線啟動白屏（已確認） | `web/public/sw.js` | 只預快取 `/`、`index.html`；任何失敗請求回 index.html；`CACHE_VERSION` 手動 | Workbox / vite-plugin-pwa 產生 precache；僅 navigate fallback |

---

## 二、中度問題

- **金額浮點**：D1 金額欄位為 `REAL`；`round2`（`shared/calculations.ts:514`）對 x.xx5 錯誤；總計由已捨入值相加。
- **USD 儲蓄帳戶混用匯率**：`shared/calculations.ts:426-465` 基礎餘額用今日匯率、連動流水用歷史台幣金額。
- **常態入帳去重鍵為「名稱 + 類型」**：`shared/recurring.ts:52-62`、`worker/automation.ts:98`；改名重複入帳、同名只入一筆。
- **Cron 脆弱**：`worker/index.ts:717-732` 市價更新失敗連帶跳過入帳/快照；`catch {}` 吞錯；錯過不補跑；時區寫死 +8，`APP_TIMEZONE` 未被讀取；手動觸發未驗證 month 範圍。
- **同步/匯入無上限**：每筆 mutation 約 4 次 D1 查詢，大量 outbox 可能超出限制；CSV 用隨機 ID，重複匯入產生重複資料，且漏寫 `ledger_id`、`linked_account_id`。
- **市價更新**：`worker/market.ts:545-579` 序列執行、無逾時、手動端點未限速。
- **參照完整性**：`ledgerId`、`linkedAccountId`、`assetId`、`accountId` 未驗證存在與歸屬。
- **前端無重試/退避/fetch 逾時**：`syncEngine.ts:1425, 1451`；懸置的 fetch 使 `syncingPromise` 永不完成。
- **狀態先改後存**：`syncEngine.ts:271-286` 等，IndexedDB 寫入失敗時 UI 顯示未儲存的資料。
- **多分頁未協調**：無 Web Locks / BroadcastChannel，整份 snapshot 互相覆蓋。
- **安全標頭**：無 CSP；`shared/csv.ts:13-19` 未防公式注入。

## 三、架構與可維護性

- 巨型檔案：`stocksTab.ts` 2927 行、`worker/sync.ts` 1742 行、`syncEngine.ts` 1609 行；各 entity 的 CRUD/merge 邏輯重複約 10 次 → 建議 entity registry。
- 每次變更重繪全部 6 分頁（`main.ts:209-222`），並整份 snapshot 寫入 IndexedDB。
- 無 CI（無 `.github/`）；高風險流程（同步中編輯、多分頁、SW 離線啟動、登出）無測試。
- 無障礙：modal 無焦點管理/Esc、toast 無 `aria-live`。

---

## 附錄：GAS 版（根目錄）發現

> GAS 版不在本次修正計畫範圍，僅供記錄。

1. **每月入帳觸發器參數錯誤（已確認）**：`src/automation.ts:46` trigger 直接呼叫 `runMonthlyRecurring(targetYear?, ...)`，事件物件被當成年份 → Invalid Date。
2. **破壞性函式未受 PIN 保護**：`setupSpreadsheet`、`resetAppPinMenu`、`installTriggers` 等可經 `google.script.run` 直接呼叫。
3. **PIN 無失敗次數限制**：`src/security.ts:110-120`。
4. **排程寫入未加 LockService**；以 `rowIndex` 刪改資料可能誤刪（`src/webapp.ts:694-1040`）。
5. **`XFrameOptionsMode.ALLOWALL`**：`src/webapp.ts:162`。
6. **水電分攤邏輯三份重複且已分歧**：`src/rentUtility.ts`、`cloudflare-pwa/shared/rentUtility.ts`、`web/index.html`。
7. 表頭 `ARRAYFORMULA` 易被手動編輯破壞；去重鍵依名稱；文件與選單編號、分頁數不一致；`src/rentUtility.ts:81-97`、`src/setup.ts:686-687` 內嵌疑似真實資料。
