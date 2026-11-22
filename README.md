# 個人現金流與資產負債管理系統 (Google Sheets + GAS + clasp)

以 **Google Sheets** 作為底層資料庫與視覺化儀表板、**Google Apps Script (TypeScript)** 實作自動化入帳與月底快照、搭配 **Mobile-First Web App** 進行手機快速記帳，並透過官方 `@google/clasp` 進行本地開發與 Git 版本控管。

---

## 一、核心功能特色

1. **最高優先級：現金流監控（月度 / 年度）**
   - 清楚區分 **總收入**、**固定支出與負債（房貸/車貸）**、**常態性訂閱扣款**、**日常花費**、**年度稅金/大額月攤提** 與 **投資流出（強制儲蓄：台股/中信基金）**。
   - **真實儲蓄率計算**：將台股與中信基金定期定額獨立於消費性支出之外，避免低估真實儲蓄率。
   - **常態性與排程收支動態開關**：支援 TWD / USD 雙幣別、`月繳 / 年繳 / 特定月份（如 3,6,9,12）/ 一次性` 與 `啟用/停用` 開關；一次性項目入帳後自動停用，停用或調整金額皆不影響歷史流水帳（歷史帳目鎖定入帳當下匯率）。
   - **不定期稅金與大額自訂月數攤提機制**：於 `Annual_Sinking_Fund` 可自由控制「分攤月數」（預設 12 個月，亦可設定 3、6、24 個月），自動算出每月應提撥預備金，避免單月現金流失真。
   - **大項統計與單一項目 12 個月查詢器**：在 `Dashboard` 可單獨檢視投資大項（台股、中信基金）、存款與總儲蓄、收支大項的當月／年度累計數字，並透過互動式下拉選單檢視任意單一項目 1～12 月明細。
2. **次要核心：整合資產負債表與淨資產歷史追蹤**
   - 統一換算新台幣 (TWD)，計算 `總資產 － 總負債 ＝ 淨資產`。
   - 台股（`GOOGLEFINANCE("TPE:0050", "price")`）與美金（`GOOGLEFINANCE("CURRENCY:USDTWD")`）自動更新；定存、中信基金、結構性商品、保單保價金與房/車貸餘額區分為「手動快照區」。
   - 自動計算「緊急預備金可支撐月數」（高流動資產 ÷ 每月消費性總支出）。
3. **全自動化排程與全功能 4 分頁 Web App（含安全鎖）**
   - **每月 1 號 08:00**：自動讀取 `Recurring_Config` 中狀態為 `啟用` 的項目寫入 `CashFlow_Log`（具防重複入帳機制）。
   - **每月月底 23:00**：精準偵測當月最後一天（含 28/29/30/31 日），自動凍結當月總資產、總負債、淨資產與儲蓄率快照寫入 `NetWorth_History`。
   - **4 分頁全功能 Web App UI**：支援加入 iOS / Android 手機主畫面，直接在介面完成「快速記帳與刪除」、「月度/年度總覽與投資/存款大項統計」、「薪資/房貸/訂閱開關與不定期分攤月數調整」、「資產負債更新與月底快照」。
   - **雙重隱私與安全保護**：支援可選 **4～6 位數 App PIN 鎖**（後端隨機 Salt + SHA-256 雜湊驗證，閒置 15 分鐘自動鎖定，可由 Google Sheet 選單一鍵重設）與 **一鍵金額隱私遮罩 (`👁️/🙈`)**。

---

## 二、專案目錄結構

```text
personal-finance-gas/
├── appsscript.json          # GAS 設定檔（V8 引擎、Asia/Taipei 時區、Web App 權限）
├── .clasp.json.example      # clasp 綁定設定範例（正式 .clasp.json 已列入 .gitignore）
├── .claspignore             # clasp 上傳忽略規則（僅推送 dist/）
├── .gitignore               # Git 忽略規則
├── package.json             # 專案依賴與自動化指令
├── tsconfig.json            # TypeScript 編譯設定（輸出 GAS 相容無模組 JS 至 dist/）
├── scripts/
│   └── build.mjs            # 編譯 src/*.ts 並複製 web/index.html 與 appsscript.json 至 dist/
├── src/
│   ├── config.ts            # 分頁名稱、下拉選項、分類對照表與視覺色票常數
│   ├── utils.ts             # 日期格式化、即時匯率讀取、防覆蓋 ARRAYFORMULA 安全寫入工具
│   ├── setup.ts             # setupSpreadsheet() 一鍵建置 6 分頁/公式/格式/圖表與 onOpen() 選單
│   ├── automation.ts        # 每月常態入帳、月底淨資產快照、排程 Trigger 安裝與管理
│   └── webapp.ts            # doGet() 與手機記帳後端 API（含 LockService 併發鎖）
├── web/
│   └── index.html           # Mobile-First 快速記帳介面（支援深淺色模式與加入主畫面）
└── tests/
    └── logic.test.mjs       # 建置產物與核心邏輯單元測試
```

---

## 三、Google Sheets 6 大分頁說明

| 分頁名稱 | 用途 | 核心機制 |
| --- | --- | --- |
| `Dashboard` | 年度/月度現金流與資產儀表板 | 可切換年份/月份、超支警示燈號、儲蓄率、緊急預備金月數、12 個月趨勢表與柱狀圖 |
| `CashFlow_Log` | 實際發生之收支流水帳 | 表頭 `ARRAYFORMULA` 自動計算「年月」與「台幣金額」，支援鎖定歷史入帳匯率 |
| `Recurring_Config` | 常態性收支與訂閱管理表 | 支援 `月繳/年繳`、`TWD/USD`、`啟用/停用` 開關與即時月均台幣換算 |
| `Annual_Sinking_Fund` | 不定期稅金與年度大額月攤提表 | 自動計算每月應提撥預備金，並比對本年度實際繳納進度 |
| `Assets_Liabilities` | 整合資產負債表（存量快照） | 區分「自動更新」（台股/美金）與「手動快照」（定存/基金/結構商品/保單/貸款） |
| `NetWorth_History` | 每月淨資產歷史紀錄 | 每月月底自動寫入純數值快照，並內嵌總資產/負債/淨資產趨勢折線圖 |

---

## 四、本地端初始化與部署步驟

### 步驟 1：安裝依賴並檢查環境
確認本地已安裝 Node.js (v18+)：

```bash
cd personal-finance-gas
npm install
npm run typecheck
npm run build
```

### 步驟 2：啟用 Google Apps Script API 並登入 clasp
1. 前往 [Google Apps Script 設定頁](https://script.google.com/home/usersettings)，開啟 **Google Apps Script API**。
2. 在終端機執行登入（會開啟瀏覽器進行 Google 帳號授權）：

```bash
npx clasp login
```

### 步驟 3：建立並綁定新的 Google Sheets 專案

**方式 A（推薦）：透過 clasp 直接建立全新的 Google Sheet 與綁定腳本**

```bash
npx clasp create --type sheets --title "個人現金流與資產負債管理系統" --rootDir dist
```

> 執行後會在專案根目錄產生 `.clasp.json`（已納入 `.gitignore`，不會外洩您的 `scriptId`），請確認其內容如下：
> ```json
> {
>   "scriptId": "您的_SCRIPT_ID",
>   "rootDir": "dist"
> }
> ```

**方式 B：綁定至既有的 Google Sheet**
1. 開啟既有的 Google Sheet -> 上方選單 **擴充功能 > Apps Script** -> 左側 **專案設定** 複製 **指令碼 ID (`scriptId`)**。
2. 複製 `.clasp.json.example` 為 `.clasp.json` 並填入該 `scriptId`。

### 步驟 4：編譯並推送程式碼至 Google Apps Script

```bash
npm run push
```

若系統詢問是否覆寫遠端 `appsscript.json`，請輸入 `y` 確認。

### 步驟 5：執行一鍵初始化與授權 Google Sheets 權限
1. 開啟剛剛建立的 Google Sheet（可從 Google Drive 找到「個人現金流與資產負債管理系統」，或執行 `npx clasp open` 開啟 Apps Script 編輯器）。
2. 重新整理 Google Sheet，上方工具列會出現自訂選單 **`💰 個人財務系統`**。
3. 點擊 **`💰 個人財務系統 > 1. 一鍵初始化所有分頁與公式`**。
4. **首次執行授權流程（Google 未驗證應用程式提示）**：
   - 點選「繼續」並選擇您的 Google 帳號。
   - 若出現「Google 尚未驗證這個應用程式」畫面，點擊左下角 **「進階」** -> **「前往『個人現金流與資產負債管理系統』（不安全）」** -> 點擊 **「允許」**。
   - 授權完成後再點一次初始化即可自動建置全部 6 個分頁與範例資料！
5. 接著點擊 **`💰 個人財務系統 > 4. 安裝 / 重設每月排程觸發器`**，完成每月 1 號自動入帳與月底自動快照排程。

### 步驟 6：部署手機端快速記帳 Web App

**方式 A：透過 CLI 部署**
```bash
npm run deploy
```

**方式 B：透過 Apps Script 編輯器部署（推薦首次設定，便於直接取得 URL）**
1. 執行 `npx clasp open` 開啟 Apps Script 編輯器。
2. 點擊右上角 **「部署」 > 「新增部署作業」**。
3. 類型選擇 **「網頁應用程式」**。
4. 設定：
   - **執行身分**：`我`（您的帳號）
   - **誰可以存取**：`只有我自己`（確保個人財務隱私安全；手機瀏覽器登入同一個 Google 帳號即可開啟）
5. 點擊 **「部署」**，複製產生的 `https://script.google.com/macros/s/.../exec` 網址。
6. **加入手機主畫面**：
   - **iOS (Safari)**：開啟網址 -> 點擊底部「分享」圖示 -> **「加入主畫面」**。
   - **Android (Chrome)**：開啟網址 -> 點擊右上角選單 -> **「加到主畫面」**。

---

## 五、日常與月底維護 SOP

- **每日（手機 Web App）**：隨手記錄日常花費、不定期稅金或額外收入，即時確認本月日常預算剩餘額度。
- **隨時調整訂閱 (`Recurring_Config`)**：新增或停用 Google AI Pro、Claude 等訂閱時，僅需切換 `狀態` 為 `啟用/停用`，下月 1 號自動生效且不破壞歷史帳目。
- **每月月底（約 5 分鐘）**：打開 `Assets_Liabilities`，更新標記為「手動快照」的定存、中信基金、結構性商品、保單保價金、房貸/車貸餘額；系統會於月底 23:00 自動寫入 `NetWorth_History`（亦可手動點選單「立即記錄本月淨資產快照」）。

---

## 六、常用開發指令

```bash
npm run typecheck   # TypeScript 靜態型別檢查
npm run build       # 編譯 TypeScript 並打包至 dist/
npm test            # 執行本地自動化驗證測試
npm run push        # 編譯並推送至 Google Apps Script
npm run deploy      # 編譯、推送並建立新版本部署
```
