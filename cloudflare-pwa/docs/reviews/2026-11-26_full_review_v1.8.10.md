# 整體審查（v1.8.10，`7407390`）

- **範圍**：`cloudflare-pwa/` 全部（Worker、同步與資料層、UI / 安全 / PWA）；附錄簡述根目錄 GAS 版。
- **方式**：三個審查分頭以全新角度閱讀程式碼，重要項目以臨時測試重現（未加入 repo）。標「已重現」者有測試佐證，標「已確認」者已對照程式碼。
- **驗證**：`tsc --noEmit` 通過；`vitest run` 26 檔 / 174 測試全數通過。另以「嚴格模式」mock D1（遇到 `undefined`、物件、NaN 參數就拋錯，模擬真實 D1）跑完整測試，仍全部通過，沒有隱藏的參數型別問題。
- 路徑相對於 `cloudflare-pwa/`。

## 總評

**同步核心現在很扎實**：`change_seq` 游標、`data_epoch` 防護、樂觀鎖、mutation 與 idempotency 同批寫入、outbox 合併與 rebase、epoch 凍結、毒丸隔離都經得起加嚴測試，這次沒有發現新的正確性問題。

**風險轉移到三個先前沒有處理的區塊**：

1. **認證與本機資料保護**：[`2026-11-26_fix_plan.md`](./2026-11-26_fix_plan.md) 的第三階段（登出清資料、PIN 雜湊下發、限速、session 期限、管理員重設等）**從未交辦或實作**。之前幾輪交辦的都是第一、二階段與後續審查發現的項目。
2. **Cloudflare 免費方案的資源上限**：每次同步的 D1 查詢數、排程的對外請求數，可能超過免費方案的限制（待確認）。
3. **UI 層安全**：新發現一個 stored XSS，加上沒有 CSP。

第四階段（Service Worker）、第五階段大部分（常態入帳去重、排程穩健性、金額精度）、第六階段（架構）也都還沒做。

---

## 一、高優先

### H1. 管理員可以接管任何成員的帳號並讀取資料（已重現，原 B4）— `worker/auth.ts:634-676`、`worker/index.ts:524`
管理員產生成員「媽媽」的重設碼 → 呼叫 `/api/auth/reset-password` → 以媽媽身分登入 → `/api/export/json` 取得她的帳目。這與 `SDD_multi_tenant.md`「管理員看不到成員資料」的說法矛盾。重設也不會留下稽核紀錄、不會通知成員，且成員原有的 Passkey 與 PIN 仍有效（無法藉重設驅逐已註冊 Passkey 的攻擊者）。
- 修正：寫入稽核紀錄；成員下次登入顯示「密碼已被管理員重設」；重設時撤銷該成員的 Passkey 與 PIN；修正文件中的信任模型說明。更好的做法是重設需要成員確認。

### H2. 登入限速可以被繞過（已重現，原 B3）— `worker/auth.ts:236-281`、`worker/index.ts:301-327`
同一 IP 並行 30 次錯誤密碼：30 次都是 401、0 次 429。原因是先讀後寫，所有請求都在記錄失敗之前通過檢查。限速鍵只有 `ip:username`，沒有每個帳號的總計數；IPv6 每個位址都有自己的計數器。不存在的帳號在 PBKDF2 之前就回傳（`auth.ts:322-332`），回應時間可判斷帳號是否存在。
- 修正：驗證前以原子 `INSERT … ON CONFLICT DO UPDATE … RETURNING` 計數；加上每個帳號的計數；IPv6 以 /64 前綴為鍵；不存在的帳號也跑一次 PBKDF2。

### H3. 登出後重新整理，全部帳目直接顯示（已確認，原 F3）— `web/src/ui/securityUi.ts:1116-1124`、`web/src/main.ts:207, 396-408, 439-454`
登出只呼叫 API，不刪除 IndexedDB、不清除記住的帳號。啟動時先開啟記住的使用者資料庫並渲染全部分頁；伺服器回報未登入但有 `lastSyncedAt` 時什麼都不做。共用裝置上：登出 → 重新整理 → 看到全部資料。
- 修正：登出時刪除該使用者的資料庫並清除記住的帳號；伺服器回報未登入時，必須先通過 PIN / Passkey / 密碼才渲染。

### H4. 帳戶互轉預覽有 stored XSS（已確認，新發現）— `web/src/ui/assetsTab.ts:1333-1348`
帳戶名稱 `itemName` 與帳本名稱直接組進 `innerHTML`。`itemName` 只有 trim 與截斷 80 字（`shared/validation.ts:177`），足以放入 `<img src=x onerror=...>`。可經由 CSV 匯入、JSON 還原或另一台裝置同步進來；沒有 CSP，腳本可讀取 IndexedDB 並帶著登入 cookie 呼叫 `/api/*`。
- 修正：改用 `textContent` 建立節點或 `escapeHtml`。其他 `innerHTML` 經檢查只插入常數或格式化數字。

### H5. 每次同步的 D1 查詢數可能超過免費方案上限（待確認，新發現）
以計數的 D1 量測（`requireAuth` 另加 3 次）：

| 每次請求的 mutation 數 | D1 呼叫次數 |
|---|---|
| 0（純拉取） | 23 |
| 10 | 53 |
| 50 | 173 |

`MAX_SYNC_MUTATIONS` 是 200。若免費方案每次呼叫約 50 次查詢的限制適用（請以 Cloudflare 文件確認），10 筆以上就會 5xx；客戶端的單筆隔離會讓同步變得極慢。多數固定成本來自重複：`ensureAppSettings`、`ensureRentUtilitySettings`、`ensureDefaultLedger` 在 `processSyncRequest` 與 `querySyncDelta` 各跑一次（`worker/sync.ts:2238-2243, 2093-2097`），`ensureUserSyncState` 跑 3～4 次，每次請求都更新 session。
- 修正：`ensure*` 只在登入 / 建立帳號時執行或於單次請求內快取；游標與 epoch 合併為單一查詢；session 每天最多更新一次；依方案調低每批上限。

### H6. 所有排程工作擠在同一次執行，且很脆弱（部分原有、部分新發現）— `worker/index.ts:893-919`、`worker/market.ts:616-779`、`worker/automation.ts:315-351`
每月 1 號先更新報價再常態入帳：報價更新中任何 D1 錯誤（每檔的 `db.batch` 沒有保護）會讓當月入帳完全不執行，也不會補跑；月底快照同樣排在報價之後。每位使用者的 `catch {}` 吞掉錯誤沒有 log。**新發現**：免費方案每次執行最多 50 個對外請求，一檔台股最多約 7 個請求（MIS、Yahoo .TW 兩台主機、1d 昨收、.TWO），額度用完後其餘標的默默列入失敗；對外請求仍沒有逾時。
- 修正：入帳先執行；每個步驟各自 try/catch 並 `console.error`；新增 `automation_runs` 表補跑錯過的期間；報價更新分批到多次執行（queue 或依使用者分段）；對外請求加 `AbortSignal.timeout`。

---

## 二、中度

| # | 問題 | 位置 | 說明 / 修正 |
|---|---|---|---|
| M1 | Session 永不過期、每次請求都寫入、沒有清理（已重現，原 B6） | `worker/auth.ts:206-211` | `created_at` 為 2020 年的 session 仍有效；`auth_sessions`、`auth_rate_limits`、`sync_idempotency`、`sync_lww_timestamps`、用過或過期的邀請 / 重設碼都不會被刪除 → 從 `created_at` 起 90 天上限、每天最多延長一次、每日清理排程 |
| M2 | PIN 雜湊下發客戶端（原 B5）；變更密碼與 PIN 沒有限速（新，已重現） | `worker/index.ts:181-182, 429, 487` | 25 次並行錯誤的目前密碼：25 次 400、沒有 429。偷到 session 的人可線上猜主密碼 → 共用原子限速器（以使用者為鍵）；PIN 改由伺服器驗證 |
| M3 | 參照不存在的帳本 / 帳戶 / 資產（已重現，原 3.9） | `worker/sync.ts:989-1007, 1685, 1811, 2733` | 帳本被軟刪除後仍可寫入該帳本的紀錄；`ledgerId: 'NOPE'` 也會被接受。未知帳本不計入淨值（`shared/calculations.ts:50-59`），錢默默從總額消失 → 寫入時以 `WHERE EXISTS` 檢查，否則拒絕 |
| M4 | 帳戶互轉是兩筆獨立的 mutation（新） | `web/src/sync/syncEngine.ts:1688-1760`、`worker/sync.ts` savings_adjustment | 兩邊各自可能被接受、拒絕或衝突 → 只有一邊成立，等於憑空產生或消失金額 → 新增 `transfer` entity，或伺服器檢查成對並同批寫入 |
| M5 | 常態入帳依名稱去重；並行執行會中斷（已重現） | `worker/automation.ts:98-180`、`shared/recurring.ts:52-62` | 兩個同名同類型的項目只入帳一筆；排程與手動按鈕同時執行會 `UNIQUE constraint failed` 中斷，後面的項目都不會入帳 → 以 `recurring_item.id + yearMonth` 為鍵並 `ON CONFLICT DO NOTHING` |
| M6 | 隔離一筆編輯時，後續編輯仍帶著它的值送出（新，已重現） | `syncEngine.ts:3288-3330` | 只有新建被隔離時才會移除同一筆的後續編輯；編輯被隔離時，後續編輯照樣把它的值寫上雲端，使用者卻以為它被隔離了 → 沿用 R6 的處理（`held_after_reject` + 完整重抓） |
| M7 | 整個請求層級的 400 / 413 會隔離正常資料（新，已重現） | `syncEngine.ts:3204-3207` | 400 / 413 一律視為單筆問題，不看純拉取是否也失敗。Worker 回歸、WAF、版本不一致時，每筆資料都會被隔離，新建的還會從畫面消失 → 400 / 413 也要求純拉取成功才算單筆問題 |
| M8 | USD 活存混用匯率（已重現，原中度問題） | `shared/calculations.ts:426-466` | USD 1000 的帳戶、以匯率 32 記一筆 USD 100 支出，以匯率 30 檢視時顯示 26,800 而非 27,000，且每次匯率變動都會漂移 → 以帳戶原幣加總再一次換算 |
| M9 | 其他分頁變更 PIN / 生物辨識後，畫面狀態沒有更新（新） | `web/src/main.ts:214`、`securityUi.ts:147, 505, 526` | 資料庫層已保護，但 `ctx.state` 不會重新整理：鎖定畫面用舊 PIN 驗證；登入與啟動時把舊的生物辨識設定寫回去 → 重新載入時把 `engine.getMeta()` 同步到 `ctx.state` |
| M10 | 頁面沒有安全標頭（原 CSP）；CSRF（新，待確認） | `worker/index.ts:149`、`wrangler.toml.example` | 標頭只加在 `/api/*`；HTML 由 ASSETS 直接提供，沒有 CSP、沒有 `frame-ancestors`（可被嵌入點擊劫持）。沒有路由檢查 `Origin` / `Content-Type`，`c.req.json()` 接受 `text/plain`，跨站表單 POST 到 `/api/auth/login` 可能讓受害者登入攻擊者的帳號（取決於瀏覽器對 SameSite=Strict 的處理） → `web/public/_headers` 加 CSP；所有非 GET 的 `/api/*` 要求 `application/json` 與同源 `Origin` |
| M11 | 離線 WebAuthn 驗證 fail-open；鎖定畫面只是遮罩（原 F4） | `web/src/auth/offlineWebAuthn.ts:225-236`、`securityUi.ts:411-434, 503-537` | 非 ES256 或空公鑰會跳過簽章檢查；遮罩後的內容仍可用 Tab 操作；切到背景不會自動上鎖（iOS 多工畫面露出金額）；PIN 沒有嘗試次數限制；toast 顯示在鎖定畫面之上 |
| M12 | Service Worker 首次離線啟動白屏（原 F6）＋兩個新問題 | `web/public/sw.js` | 仍只預快取 `/` 與 `index.html`。**新**：任何失敗的請求都回 index.html（JS / CSS 拿到 HTML）；含查詢字串的網址（`/?reset=CODE`、`/?invite=CODE`）會被快取到下次改版 → Workbox 產生預快取清單；只有導覽請求 fallback；不快取含查詢字串的網址 |
| M13 | 匯入端點沒有防護（大多為新發現） | `worker/index.ts:709-721`、`worker/sync.ts:3116` | JSON / CSV 匯入沒有大小上限；整份匯入是一個不設上限的 batch；`cashflowLogs: {}` 造成 TypeError 回 500；同一份 CSV 匯入兩次會重複（已重現）；CSV 列沒有 `ledger_id`、`linked_account_id` |
| M14 | 手動入帳 API 不驗證年月（已重現，原 5.3） | `worker/index.ts:614-621`、`worker/automation.ts:48-50` | `{year: 2026, month: 13}` 回 200 並寫入 `2026-13-01`；負數、小數、0 也都接受 |

---

## 三、低優先

- **B7**：租戶欄位仍預設 `'owner'`（含 `auth_sessions`、`auth_passkeys`）；目前所有 INSERT 都有帶 `user_id`，屬潛在風險。
- **月底快照**：活存與持股計算沒有日期上限，未來日期的紀錄會被計入；預備金沒有依帳本過濾；時區寫死 +8、`APP_TIMEZONE` 未被讀取；錯過一次排程該月就沒有快照。
- **snapshot_rev 只保護 `commitLocalMutation`**：ack、凍結、純拉取、隔離、衝突解決仍以記憶體副本整份寫入；被覆蓋的 outbox 編輯會在下次同步回來，但只存在於 snapshot 或旁支清單的變更（例如已解決的衝突、已清除的拒絕紀錄）可能被還原。時間窗很小。
- **第二次 `StaleSnapshotError`** 會以英文訊息顯示給使用者（只重試一次）。
- **批次選取與標記已送出是兩個交易**，其他分頁在中間合併或抵銷時，已刪除的新建可能被送出而復活（待確認）。
- `bumpSnapshotRev` 在交易完成前就更新記憶體中的版本號；`reapplyFrozenOutboxTx` 在凍結清單為空時不讀版本號 → 偶發一次不必要的重新載入。
- `patchAuthMeta` 在尚未有 meta 時的 fallback 不在同一個交易內，可能被其他分頁建立的預設值蓋掉。
- **效能**：每次編輯都整份寫入 snapshot；其他分頁整份重讀並重繪 6 個分頁；同步每一輪整份讀寫並重新排序。資料量大時手機上每次寫入都是數 MB 的複製 → 依 entity 分 store、增量寫入、跨分頁重新載入加 debounce。
- **切換帳號**：`destroy()` 後立刻 `close()`，已排隊的操作會遇到「LocalFinanceDB is not open」而顯示誤導的錯誤 → `destroy()` 先等待佇列清空。
- **localStorage 替代鎖**在背景分頁計時器被節流時可能過期（僅限沒有 `navigator.locks` 的瀏覽器）。
- `computeStatus` 有任何拒絕紀錄時仍回傳 `conflict`；`singleItemSuccessStreak` 未隨 `poisonSearchActive` 一起重置；`clearAll`、`saveSnapshot` 是沒有用到的程式碼；`commitAndMaybeSync` 同時呼叫 `onError` 又拋錯，畫面顯示兩次 toast。
- **金額與計算**：`round2` 為浮點數捨入；貸款利息捨入到整數（USD 貸款每期遺失小數）；`solveImpliedLoanAnnualRate` 上限 30% 但驗證允許 50%；賣出股數超過持有時，已實現損益與成本不一致（待確認驗證是否擋下）。
- **重複送出**：記帳表單儲存時沒有停用按鈕，iOS 連點會建立兩筆（多個 modal 也一樣）。
- **CSV 公式注入**：`shared/csv.ts:13-19` 未處理 `= + - @` 開頭；`shared/rentUtility.ts:240-247` 水電 CSV 完全沒有跳脫。
- **日期**：匯出檔名用 UTC 日期（台北 08:00 前是昨天）；管理畫面以 `.slice(0,10)` 顯示 UTC 日期；「今天」用裝置時間且重複寫了 4 份，與伺服器的台北時間不一致 → 統一的 `todayInTz(APP_TIMEZONE)`。
- **iOS 下載**：`downloadTextFile` 在 `click()` 後立刻 revoke（待確認）。
- **數字顯示**：`-NT$ 0`、`-0.0%`；遮罩模式仍顯示漲跌方向。
- **無障礙**：modal 沒有 Esc / 焦點管理；toast 沒有 `aria-live`；viewport `maximum-scale=1` 阻止縮放。
- **每次變更重繪全部 6 個分頁**。
- **維護性**：`worker/sync.ts` 3,132 行、約 10 組複製貼上的 entity CRUD；`stocksTab.ts` 3,057 行、`assetsTab.ts` 1,918 行；3 套重疊的貨幣格式化函式；長串 inline style 的 HTML 字串正是 H4 容易產生的原因。
- **測試盲點**：mock D1 沒有查詢數、對外請求數、batch 大小的限制；沒有測試涵蓋查詢預算、排程失敗順序、session、限速並行。

## 經確認沒有退步的項目

Passkey challenge 以值原子取用、Passkey 不可覆蓋、游標上限、idempotency 同批寫入、報價更新不遞增 version、`requireAuth` 檢查 `X-Expected-User`、同步請求串流限制大小；淨值、儲蓄率、貸款攤還日期、平均成本法持股計算未發現錯誤；伺服器端刪除帳本前會檢查關聯紀錄。

---

## 附錄：GAS 版（根目錄）

自設計審查以來沒有任何變更，附錄所列問題全部仍在：每月觸發器把事件物件當成年份（`src/automation.ts:47`）、`XFrameOptionsMode.ALLOWALL`（`src/webapp.ts:162`）、PIN 沒有嘗試次數限制、破壞性函式可經 `google.script.run` 直接呼叫、沒有 LockService 且以列號刪改、水電邏輯重複且已分歧；`web/index.html` 有 30 處 `innerHTML` 未審查。**實質上是凍結的舊版**：建議不要再給新使用者部署，資料匯入 PWA 後即可退役。

---

## 建議修正順序

1. **安全（優先）**：H4 XSS → M10 CSP / 安全標頭 → H3 登出清資料 → H2 登入限速 → M2 變更密碼 / PIN 限速 → M11 WebAuthn fail-open 與鎖定畫面 → H1 管理員重設 → M1 session
2. **資料正確性**：M6、M7（同步隔離）→ M3 參照完整性 → M4 轉帳原子性 → M5 常態入帳去重 → M8 USD 匯率 → M14 年月驗證
3. **資源上限與排程**：先以 Cloudflare 文件確認 H5 的限制 → H5 查詢數 → H6 排程拆分與補跑 → M13 匯入防護
4. **PWA**：M12 Service Worker
5. **低優先與架構**：其餘項目；架構重構（entity registry、拆分大型模組）建議在功能穩定後另外規劃
