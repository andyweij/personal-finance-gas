# 個人現金流與資產負債管理系統 — Cloudflare 離線優先 PWA 版

獨立於根目錄 GAS 專案之外的次世代架構，採用 **Local-First PWA + Cloudflare Workers + D1 (SQLite) + Cron Triggers**，解決 GAS 冷啟動延遲與無法離線記帳的痛點，且完全運作於 Cloudflare 免費方案（免綁信用卡、永不休眠）。

> 完整設計規格請參閱 [docs/SDD.md](./docs/SDD.md)、[docs/SDD_savings_linkage.md](./docs/SDD_savings_linkage.md) 與 [docs/SDD_loan_amortization.md](./docs/SDD_loan_amortization.md)。

---

## 核心特色

- **真正的離線記帳（0ms 回應）**：Service Worker 預快取 App Shell，沒網路（捷運、地下室、飛航模式）點開 iPhone 主畫面圖示照樣秒開、秒記帳，資料安全寫入本機 IndexedDB 佇列，恢復網路或切回 App 立即背景同步。
- **活存帳戶與流水帳即時連動**：支援多活存帳戶加總與單帳戶 N 筆存入／轉出累加（不扭曲儲蓄率），記帳頁即時顯示活存餘額與扣減前後預覽，並內建基準生效日與對帳校準機制，避免歷史舊帳重複扣款。
- **貸款自動還本推算＋保留快照更新**：針對房貸／車貸可選填啟用本息均攤自動還本推算（內建「申貸日＋年限反推年利率」小工具與未來攤還試算表），免跑銀行即時掌握預估剩餘本金，並可隨時透過「快照校準」覆蓋或切回純手動快照。
- **0ms 切換月份與報表**：所有帳目鏡像於本機 IndexedDB，切月份、看年度 12 個月趨勢與資產配置圖完全不需等待網路。
- **高強度單人安全保護**：
  - 首次初始化受 `SETUP_SECRET` Worker Secret 保護，初始化完成後永久鎖死註冊端點。
  - 主密碼採用 `PBKDF2-SHA256`（100,000 次迭代 + 隨機 Salt），並內建 D1 登入限速（連續失敗 5 次鎖定 15 分鐘）。
  - 支援 **WebAuthn Passkey（iPhone Face ID / Touch ID / Mac Touch ID）** 一鍵生物辨識登入。
  - 保留 **本機離線 4～6 位數 PIN 鎖**、**閒置自動上鎖（5/15/30/60 分）** 與 **一鍵金額隱私遮罩**。
- **全自動排程與行情更新**：
  - 每月 1 號 08:00（台灣時間）：自動依週期（月繳/年繳/特定月份/一次性）將常態收支寫入流水帳，具冪等防重複與一次性自動停用機制。
  - 每日 23:00（台灣時間）：自動更新 USD/TWD 匯率與台股報價（TWSE + Yahoo Finance 雙備援），並於當月最後一天自動凍結淨資產快照。
- **無痛資料遷移與自主備份**：支援直接匯入原本 Google Sheets 匯出的 `CashFlow_Log` CSV，以及一鍵下載/還原完整 JSON 備份與 UTF-8 BOM CSV。
- **整合 5F & 6F 房租水電自動分攤（第 5 分頁，離線可用）**：內建 `11409` 起點表底與 `11411～11509` 歷史抄表紀錄（透過 `0002_rent_utility.sql` 自動建立 D1 資料表），支援滿 10,000/100,000 度歸零換算、一鍵複製 6F/5F LINE 對帳明細、匯出 CSV、0ms 離線抄表與背景同步，以及一鍵將水電帳單／代收水電費寫入個人現金流。

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

```bash
# 僅關閉 App PIN 鎖（保留主密碼與所有帳目）
npx wrangler d1 execute finance-db --remote --command "UPDATE auth_owner SET pin_enabled = 0, pin_hash = NULL, pin_salt = NULL WHERE id = 1;"

# 重設主密碼（清除後可重新用 SETUP_SECRET 設定新密碼，所有帳目資料完全保留）
npx wrangler d1 execute finance-db --remote --command "DELETE FROM auth_owner; DELETE FROM auth_sessions;"
```
