# 個人現金流與資產負債管理系統 — Cloudflare 離線優先 PWA 版

獨立於根目錄 GAS 專案之外的次世代架構，採用 **Local-First PWA + Cloudflare Workers + D1 (SQLite) + Cron Triggers**，解決 GAS 冷啟動延遲與無法離線記帳的痛點，且完全運作於 Cloudflare 免費方案（免綁信用卡、永不休眠）。

> 完整設計規格請參閱 [docs/SDD.md](./docs/SDD.md)、[docs/SDD_savings_linkage.md](./docs/SDD_savings_linkage.md)、[docs/SDD_loan_amortization.md](./docs/SDD_loan_amortization.md)、[docs/SDD_sync_versioning.md](./docs/SDD_sync_versioning.md) 與 [docs/SDD_multi_tenant.md](./docs/SDD_multi_tenant.md)。

---

## 核心特色

- **真正的離線記帳（0ms 回應）＋ 樂觀鎖防覆蓋**：Service Worker 預快取 App Shell，離線秒開秒記帳；伺服器統一發放遞增版號（`version`），多裝置同時編輯同一筆資料時自動攔截靜默覆蓋，並提供欄位差異對照與一鍵決策視窗。
- **多租戶家庭版嚴格資料隔離（維持免費方案）**：
  - 所有財務資料表採 `(user_id, ...)` 複合主鍵與伺服器 Session 綁定隔離，前端 IndexedDB 依使用者切庫（`personal-finance-pwa-db:<userId>`），成員間完全獨立互不可見（連管理員亦無法查閱他人帳目）。
  - **一次性邀請碼註冊**：由管理員發放一次性邀請碼（僅存 SHA-256 雜湊），註冊完成立即永久失效。
  - **管理員零知情密碼重置**：成員忘記密碼時由管理員產生一次性重置碼，成員自行重設新密碼並強制登出舊裝置，管理員全程無法得知對方密碼。
  - **無痛日常解鎖與登入**：30 天滑動續期 Session ＋ 離線 Face ID / PIN 鎖屏；升級 **Discoverable Passkey** 支援免輸入帳號一鍵刷臉登入，本機亦自動記憶上次帳號。
- **活存帳戶與流水帳即時連動**：支援多活存帳戶加總與單帳戶 N 筆存入／轉出累加（不扭曲儲蓄率），記帳頁即時顯示活存餘額與扣減前後預覽，並內建基準生效日與對帳校準機制，避免歷史舊帳重複扣款。
- **貸款自動還本推算＋保留快照更新**：針對房貸／車貸可選填啟用本息均攤自動還本推算（內建「申貸日＋年限反推年利率」小工具與未來攤還試算表），免跑銀行即時掌握預估剩餘本金，並可隨時透過「快照校準」覆蓋或切回純手動快照。
- **0ms 切換月份與報表**：所有帳目鏡像於本機 IndexedDB，切月份、看年度 12 個月趨勢與資產配置圖完全不需等待網路。
- **高強度安全保護**：
  - 首次初始化受 `SETUP_SECRET` Worker Secret 保護，初始化完成後僅能憑管理員發放的一次性邀請碼註冊新成員。
  - 主密碼採用 `PBKDF2-SHA256`（100,000 次迭代 + 隨機 Salt），並內建 D1 登入限速（連續失敗 5 次鎖定 15 分鐘）。
  - 支援 **WebAuthn Passkey（iPhone Face ID / Touch ID / Mac Touch ID）** 免帳號一鍵生物辨識登入。
  - 保留 **本機離線 4～6 位數 PIN 鎖**、**閒置自動上鎖（5/15/30/60 分）** 與 **一鍵金額隱私遮罩**。
- **全自動排程與行情更新**：
  - 每月 1 號 08:00（台灣時間）：依每位啟用成員各自執行常態收支自動入帳，具冪等防重複與一次性自動停用機制。
  - 每日 23:00（台灣時間）：去重查詢 USD/TWD 匯率與台股／美股報價（台股 TWSE/TPEx + Yahoo Finance；美股 Yahoo Finance + Stooq 雙備援），並於當月最後一天為每位成員自動凍結淨資產快照。
  - 每日 06:00（台灣時間，可選配 `0 22 * * *`）：美股夏令／冬令收盤後自動同步最新美股與台股收盤價。
- **無痛資料遷移與自主備份**：支援直接匯入原本 Google Sheets 匯出的 `CashFlow_Log` CSV，以及一鍵下載/還原完整 JSON 備份與 UTF-8 BOM CSV。
- **整合 5F & 6F 房租水電自動分攤（預設僅管理員開啟，可於設定自由開關）**：內建 `11409` 起點表底與 `11411～11509` 歷史抄表紀錄（歸屬首位管理員，新成員預設空白且隱藏分頁），支援滿 10,000/100,000 度歸零換算、一鍵複製 6F/5F LINE 對帳明細、匯出 CSV、0ms 離線抄表與背景同步，以及一鍵將水電帳單／代收水電費寫入個人現金流。

---

## 快速本地開發與測試

```bash
cd cloudflare-pwa
npm install
npm test            # 執行完整單元、離線同步、Worker API + D1 與 PWA 測試
npm run typecheck   # TypeScript 靜態型別檢查
npm run build:web   # 建置前端 PWA 至 dist/web
```

---

## 部署至 Cloudflare（免費方案，免綁信用卡）

### 1. 登入 Cloudflare Wrangler
```bash
npx wrangler login
```

### 2. 建立 D1 雲端資料庫
```bash
npx wrangler d1 create finance-db
```
複製終端機輸出的 `database_id`，接著複製設定範本：
```bash
cp wrangler.toml.example wrangler.toml
```
打開 `wrangler.toml`，將 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 換成剛剛取得的 `database_id`（`wrangler.toml` 已列入 `.gitignore`，不會外洩）。

### 3. 套用資料庫 Schema（Migration）
```bash
npm run db:migrate:remote
```

### 4. 設定首次初始化密鑰 (`SETUP_SECRET`)
為防止剛部署完成時被陌生人搶先初始化，請設定一組只有你知道的密鑰：
```bash
npx wrangler secret put SETUP_SECRET
```

### 5. 建置並部署（前端 PWA + 後端 API + Cron 排程一次完成）
```bash
npm run deploy
```
部署完成後開啟 `https://personal-finance-pwa.<你的子網域>.workers.dev`：
1. 輸入剛剛設定的 `SETUP_SECRET` 與你自訂的主密碼完成初始化。
2. 在 iPhone Safari 開啟該網址 → 底部「分享」→ **「加入主畫面」**。
3. 進入右上角「安全設定」一鍵綁定 **Face ID / Touch ID Passkey**，並可選擇開啟離線 PIN 鎖。

---

## 從原本 Google Sheets 遷移資料（支援全部 5 大分頁自動辨識）

1. 在原本的 Google Sheet 依序切換以下分頁 → **檔案 > 下載 > 逗號分隔值 (.csv)**：
   - `CashFlow_Log`（收支流水帳）
   - `Recurring_Config`（薪資 / 房貸 / 投資 / 訂閱固定扣款）
   - `Annual_Sinking_Fund`（不定期稅金與大額攤提）
   - `Assets_Liabilities`（資產負債表）
   - `NetWorth_History`（每月淨資產歷史快照）
2. 打開新的 PWA → 點右上角 **安全 / 資料中心** 盾牌圖示 → **匯入原 Google Sheets CSV（可多選 5 分頁）**，一次多選剛下載的 `.csv` 檔即可自動辨識並完整匯入至 D1。

---

## 忘記主密碼或 PIN 鎖復原指令

- **一般家庭成員忘記密碼**：請管理員於 App 內「帳號、安全與資料備份 → 家庭成員與邀請碼」產生**一次性密碼重置碼**交給對方自行重設（管理員全程無法得知對方密碼）。
- **管理員本機 PIN 鎖復原**：

```bash
# 僅關閉管理員 App PIN 鎖（保留主密碼與所有帳目）
npx wrangler d1 execute finance-db --remote --command "UPDATE users SET pin_enabled = 0, pin_hash = NULL, pin_salt = NULL WHERE id = 'owner';"
```

---

## 部署前備份與快速回滾（Rollback）

若部署新版本後發現異常，系統具備以下多層回滾與復原保護：

### 1. Worker 程式與前端 PWA 一鍵回滾（約 10 秒生效）
Cloudflare Workers 會保留歷次部署快照（含 Static Assets 與後端 API），可隨時列出並回滾到上一個穩定版本：

```bash
cd cloudflare-pwa

# 查看最近部署版本清單（含 Version ID 與部署時間）
npm run deployments

# 一鍵回滾至上一個版本（或指定 Version ID：npx wrangler rollback <VERSION_ID>）
npm run rollback
```

> **為什麼資料庫升級後仍能安全回滾程式？**
> 本專案所有 D1 Migration（如 `0008`、`0009`）皆採**純向後相容的新增欄位設計**（`ADD COLUMN ... NOT NULL DEFAULT ...`），不會刪除或破壞既有欄位，因此舊版 Worker 直接讀取已升級的 D1 資料庫也能正常運作。

### 2. 部署前建議備份 D1（或 App 內下載 JSON）
重大更新前建議先匯出一份 SQL 備份檔（或於 App 右上角「安全設定 → 下載完整 JSON 備份」）：

```bash
npm run db:backup:remote
```
（會匯出至 `d1-backup.sql`，已列入 `.gitignore` 不會誤提交至 Git）

### 3. D1 Time Travel（資料誤改時間點還原）
若需要把資料庫內容本身還原到特定時間點（免費方案保留最近 7 天、付費方案 30 天）：

```bash
# 查詢某時間點的 bookmark，或直接還原至指定 ISO 時間點
npx wrangler d1 time-travel info finance-db --timestamp="2026-01-01T00:00:00Z"
npx wrangler d1 time-travel restore finance-db --timestamp="2026-01-01T00:00:00Z"
```

