# 設計提案：需要重新設計的項目（不在本次實作範圍）

- **背景**：[`2026-11-26_full_review_v1.8.10.md`](./2026-11-26_full_review_v1.8.10.md) 與交接說明列為「只寫設計提案」的四項。v1.8.11～v1.8.15 已處理其餘項目，本文件說明這四項的問題、可選方案、取捨與建議，**均未實作**。
- 路徑相對於 `cloudflare-pwa/`。

## 建議的先後順序

| 順序 | 項目 | 理由 |
|---|---|---|
| 1 | **B5** PIN 伺服器驗證＋每台裝置的離線驗證資料 | 風險最大，也最便宜：目前 PIN 雜湊存在伺服器回應與 IndexedDB 中，4～6 碼可在數秒內離線暴力破解；修正不需要動到財務資料格式 |
| 2 | **架構重構**（entity registry、IndexedDB 分 store） | 能降低之後所有變更的風險，也是本機加密的前置工作（加密需要逐筆或逐 store 處理） |
| 3 | **本機資料加密** | 依賴 1 的金鑰設計與 2 的儲存結構 |
| 4 | **管理員無法讀取成員資料**（端對端加密） | 成本最高，且會犧牲伺服器端的排程功能；只有在家庭成員之間確實需要彼此保密時才值得做 |

---

## 一、B5：PIN 改由伺服器驗證，離線解鎖改用每台裝置的驗證資料

### 問題

- `GET /api/auth/status` 回傳 `pinSalt`、`pinHash`，客戶端存在 IndexedDB 的 meta 中，以便離線解鎖（`web/src/ui/securityUi.ts` `verifyOfflinePin`）。
- PIN 只有 4～6 位數字（最多 100 萬種組合）。取得 IndexedDB 或 status 回應的人，用一般電腦數秒到數分鐘就能離線窮舉。
- 由於 PIN 是**帳號層級**共用，一台裝置外洩等於所有裝置的 PIN 外洩；PIN 也可能與使用者在其他地方的 PIN 相同。
- v1.8.11 加的「錯誤 5 次鎖定 30 秒」只在 UI 層，無法阻止離線窮舉。

### 可選方案

| 方案 | 做法 | 優點 | 缺點 |
|---|---|---|---|
| A. 只在線上驗證 PIN | PIN 改送伺服器驗證（共用原子限速器，以使用者＋裝置為鍵），伺服器不再下發雜湊 | 最簡單；伺服器端可真正限速 | 離線時無法用 PIN 解鎖，與「離線優先」的定位衝突 |
| B. 每台裝置的離線驗證資料 | 首次在某台裝置設定 / 輸入 PIN 時，以 PBKDF2（高迭代，例如 600k）＋**裝置專屬鹽**算出驗證值，只存在這台裝置；伺服器另存自己的雜湊（線上驗證用），兩者不共用 | 一台裝置外洩不影響其他裝置與伺服器；仍可離線解鎖 | 本機驗證資料仍可被離線窮舉（只是變慢）：100 萬種 × 600k 次迭代，GPU 約需數小時到數天 |
| C. PIN 衍生金鑰加密本機資料（與「本機加密」合併） | PIN → PBKDF2 / Argon2 → 解開一把隨機的資料金鑰（DEK），DEK 用來加密 IndexedDB 內容；「驗證 PIN」等於「能否解開 DEK」 | 本機沒有可直接比對的雜湊；PIN 錯誤就拿不到任何明文 | 4～6 碼的熵太低，離線窮舉 DEK 外層仍然可行；必須搭配 D 才有實質保護 |
| D. 伺服器協助的金鑰（C 的強化） | DEK 的外層金鑰需要「PIN＋伺服器保管的裝置秘密」才能算出（例如伺服器以 HMAC(裝置秘密, PIN) 回應，並負責限速）；離線時改用 Face ID / Passkey 的 PRF 擴充或平台金鑰解開 | 窮舉必須經過伺服器（可限速、可撤銷裝置） | 純離線時只能用生物辨識（WebAuthn PRF）解鎖；PRF 的瀏覽器支援度仍不完整（iOS 18+ / Chrome 132+），需要備援 |

### 建議

- **短期（一個版本內可完成）：B ＋ A 的線上路徑**
  1. 伺服器新增 `POST /api/auth/pin/verify`，以共用原子限速器保護（每使用者＋每裝置 5 次 / 15 分鐘）；`/api/auth/status` **不再回傳** `pinHash`。
  2. 客戶端在**成功線上驗證或設定 PIN 時**，以裝置隨機鹽＋600k 次 PBKDF2-SHA256 產生本機驗證值，存進 IndexedDB（不同於伺服器雜湊）。
  3. 離線解鎖只比對本機驗證值；連續錯誤 10 次清除本機驗證值，之後必須上線或用 Face ID。
  4. 相容：舊版客戶端仍依賴 status 中的 `pinHash`。過渡期一個版本內同時保留（標記 deprecated），之後移除。
  5. Migration：`users` 表新增 `pin_kdf_version`，舊雜湊在下次驗證成功時升級。
- **長期**：與「本機資料加密」一起改為 C＋D，以 WebAuthn PRF 作為離線的主要解鎖方式、PIN 作為線上方式。

### 風險

- PBKDF2 600k 次在舊手機上約需 0.5～1 秒，解鎖會有延遲，需加入「驗證中」狀態。
- 使用者若同時清除本機驗證值又離線，只能等上線或用 Face ID 解鎖，需要清楚的提示文字。

---

## 二、本機資料加密（IndexedDB）

### 問題

- 所有帳目、資產、持股以明文存在 IndexedDB（`web/src/db/localDb.ts`）。鎖定畫面只是 UI 層的遮罩：裝置被取得、瀏覽器設定檔被複製、惡意擴充功能、或 XSS（已由 CSP 降低）都能直接讀取。
- 登出會刪除資料（v1.8.11），但「已登入、鎖定中」的裝置仍是明文。

### 可選方案

| 方案 | 做法 | 取捨 |
|---|---|---|
| A. 整份 snapshot 加密 | 每次寫入時以 AES-GCM（WebCrypto）加密整份 snapshot，金鑰（DEK）不落地明文 | 實作最小；但目前每次編輯都寫整份 snapshot，加密幾 MB 資料在手機上每次 20～80ms，會放大既有的效能問題 |
| B. 逐筆加密＋依 entity 分 store | 每筆紀錄以 DEK 加密成 `{id, iv, ciphertext}`，store 依 entity 分開（見第四節）；索引只保留不敏感的欄位（id、change_seq） | 與增量寫入搭配時成本低；需先完成 IndexedDB 重構；查詢 / 排序只能在解密後於記憶體中進行（目前本來就是全部載入記憶體） |
| C. 不加密，改縮短資料留存 | 鎖定超過一段時間自動清除本機資料，下次解鎖重新下載 | 不需要金鑰管理；但違反離線優先（離線時無法解鎖後檢視） |

### 金鑰管理（A、B 共用）

- 每個帳號、每台裝置產生一把隨機 DEK（AES-256-GCM）。
- DEK 以「金鑰加密金鑰」（KEK）包裝後存在 IndexedDB：
  - KEK 來源 1：WebAuthn PRF（Face ID / Passkey）——建議的主要方式。
  - KEK 來源 2：PIN＋伺服器協助（見 B5 的方案 D）。
  - KEK 來源 3：主密碼（PBKDF2 / Argon2id），作為最後的備援。
- 解鎖後 DEK 只存在記憶體；切到背景超過 N 秒（已有的 30 秒自動上鎖）時從記憶體清除。
- 待送佇列（outbox）、衝突與拒絕清單同樣加密（內含完整 payload）。

### 建議

- 先完成第四節的 IndexedDB 重構，再採用**方案 B**；A 只作為過渡（若重構延後）。
- 先支援 PRF＋主密碼兩種 KEK，PIN 的 KEK 等 B5 的伺服器協助完成後再加入。
- Migration：首次啟動新版時，在解鎖後把明文資料讀出、加密寫回，完成後刪除明文 store；過程中斷時保留明文 store 直到下次完成（不得遺失資料）。

### 風險

- 金鑰遺失（清除瀏覽器資料、PRF 憑證被刪）：本機資料無法解密。由於雲端仍有完整資料，處理方式是刪除本機資料庫後重新下載，但**未同步的待送異動會遺失**，因此 UI 必須在解鎖失敗時先嘗試其他 KEK 來源，並清楚警告。
- Service Worker / 背景同步若需要在未解鎖時寫入（目前沒有），會無法進行。

---

## 三、讓管理員也無法讀取成員資料（客戶端加密）

### 問題

- 信任模型（v1.8.11 已寫入 `docs/SDD_multi_tenant.md`）：管理員可以用重置碼接管成員帳號，系統只能留下稽核紀錄並通知成員；擁有 Cloudflare 帳號與 D1 存取權的人可以直接讀取所有資料。
- 若家庭成員之間需要真正的隱私（例如成年子女的財務），伺服器上就不能有明文。

### 可選方案

| 方案 | 做法 | 取捨 |
|---|---|---|
| A. 維持現狀並強化稽核 | 管理員動作全部記錄並通知成員；限制 D1 存取權 | 成本最低；但對擁有 D1 權限的管理員沒有保護 |
| B. 敏感欄位端對端加密 | 金額、名稱、備註等欄位由客戶端以使用者金鑰加密後才同步；伺服器只看到密文與必要的明文欄位（id、日期、version、change_seq） | 伺服器端的計算全部失效：常態入帳（需金額）、月底快照（需淨值）、報價更新（需代號與股數）、參照完整性檢查以外的驗證、CSV 匯入都必須移到客戶端 |
| C. 全部端對端加密＋伺服器只做儲存與排序 | 伺服器變成「加密的變更紀錄伺服器」 | 改動最大，等於重寫 `worker/sync.ts` 與 `worker/automation.ts`；排程功能改為「下一次開啟 app 時由客戶端補做」 |

### 金鑰與復原

- 使用者金鑰（UK）以主密碼（Argon2id）與 PRF 包裝；伺服器只存包裝後的 UK。
- 管理員重設密碼將**無法**復原資料（這正是目的）。必須提供使用者自行保存的「復原碼」（例如 24 個英文字），遺失即無法復原。
- 多裝置：新裝置以主密碼解開 UK。

### 建議

- 先確認需求：若家庭成員彼此信任，**採用 A**，並把「管理員可接管帳號」清楚寫在註冊畫面（已在文件中）。
- 若確實需要隱私，建議走 **B 的縮小版**：只加密 `item_name`、`note`、`category` 等文字欄位，金額與日期保留明文，讓伺服器排程仍可運作。這樣可防止管理員看到「花在什麼地方」，但仍看得到金額。
- 完整的 C 需要另外的產品決策（失去伺服器排程與自動報價），不建議在目前的架構上進行。

### 風險

- 使用者遺失密碼與復原碼時資料永久遺失，對家用財務 app 是重大的支援負擔。
- 部分加密（B）容易被誤解為「完全私密」，介面文字必須精確。

---

## 四、架構重構

### 4.1 `worker/sync.ts` 的 entity registry

**問題**

- `applySingleMutation` 約 1,500 行，10 種 entity 各自複製「讀取現有列 → 版本檢查 → 驗證 → 組 UPDATE / INSERT → commit」的流程。
- 近期修正（M3 參照檢查、M4 原子群組、H5 預先讀取）都必須在每個 entity 分支重複套用，漏改的風險很高；匯入、匯出、delta 查詢也各有一份欄位清單。

**提案**

- 建立宣告式的 entity registry：

  ```ts
  interface EntityDef<V> {
    entity: SyncEntity;
    table: string;
    key: 'id' | 'period' | 'user';            // 主鍵形式
    columns: Array<{ column: string; field: keyof V; json?: boolean; bool?: boolean }>;
    refs?: Array<{ kind: 'ledger' | 'asset'; field: keyof V; column: string; label: string }>;
    validate(payload: Record<string, unknown>, existing: Row | null, ctx: Ctx): V;
    beforeWrite?(v: V, existing: Row | null, ctx: Ctx): { post?: D1PreparedStatement[] };  // 例如 is_default_savings
    deleteGuard?(...): ...;                   // 例如帳本刪除前的關聯檢查
    map(row: Row): Record<string, unknown>;
  }
  ```
- 從 registry 自動產生：UPDATE / INSERT 語句與綁定順序、`refGuardSql`、預先讀取、delta 查詢與 mapper、匯入的 `json_each` 欄位清單（目前 9 張表手寫，審查需要逐一對齊）。
- 特殊行為（資產的報價欄位由伺服器擁有、帳本刪除檢查、轉帳單邊修改限制）以 hook 表達。

**作法與驗收**

- 先寫「黃金測試」：對每種 entity 的 upsert / delete / conflict / reject，錄下目前產生的 SQL 結果（資料列狀態）；重構後必須完全相同。
- 一次搬一個 entity，每次都跑完整測試與 workerd 煙霧測試。

### 4.2 拆分 `stocksTab.ts`（3,000 行）與 `assetsTab.ts`（1,900 行）

**問題**：渲染、表單、計算預覽、事件處理混在一起；長串 inline style 的 HTML 字串正是 H4 XSS 的成因，也讓 CSP 難以收緊（`style-src 'unsafe-inline'`）。

**提案**

- 依功能拆成模組：
  - `stocks/holdingsList.ts`、`stocks/holdingCard.ts`、`stocks/txModal.ts`、`stocks/dividendModal.ts`、`stocks/watchlist.ts`、`stocks/format.ts`（集中目前 3 套重疊的貨幣格式化）。
  - `assets/savingsList.ts`、`assets/transferModal.ts`、`assets/loanModal.ts`、`assets/reconcileModal.ts`。
- 建立一個極小的 DOM 建構 helper（`h('div', { class }, children)`），只用 `textContent` 插入文字，逐步取代 `innerHTML` 樣板；完成後可把 CSP 的 `style-src` 改為不含 `'unsafe-inline'`（inline style 改為 class）。
- 每個 modal 的「計算預覽」抽成純函式並加上單元測試（目前只能透過 DOM 測）。

### 4.3 IndexedDB 依 entity 分 store

**問題**

- 目前整份 snapshot 存成單一值：每次編輯寫入數 MB，其他分頁整份重讀；`snapshot_rev` 只能做整份的樂觀鎖，任何兩個分頁的寫入都互相衝突（v1.8.15 改為重試 3 次）。

**提案**

- 新的 DB 版本（`LocalFinanceDB` 升級 `onupgradeneeded`）：每個 entity 一個 object store，keyPath 為 `id`（水電為 `period`）；`meta`、`outbox`、`conflicts`、`rejections`、`frozen_outbox` 維持獨立 store。
- 寫入：本機編輯只在同一個交易內 `put` 受影響的紀錄＋outbox；同步回應依 delta 逐筆 `put` / `delete`。
- 跨分頁：廣播「哪些 entity / id 變了」，其他分頁只重讀那些紀錄。
- 樂觀鎖改為逐筆（比對 `updatedAt` / `version`），兩個分頁改不同紀錄不再衝突。
- 記憶體中的 `FinanceSnapshot` 仍保留（UI 不需要改），由 store 組裝。

**Migration**

- `onupgradeneeded` 中讀出舊的 snapshot 值，拆成各 store 寫入，在同一個升級交易完成；舊的 key 保留到下一個版本再刪除，以便降版。
- 多分頁：升級時其他分頁會收到 `versionchange`，必須關閉連線並提示重新整理（v1.8.11 的「被擋住 3 秒」邏輯可沿用）。

### 取捨與建議

- 三項重構互相獨立，但 4.3 是本機加密的前置工作，4.1 能降低伺服器端所有後續變更的風險。
- 建議順序：**4.1 → 4.3 → 4.2**（4.2 可與功能開發並行逐步進行）。
- 每項重構都以「行為完全不變」為驗收條件，不混入功能修改。
