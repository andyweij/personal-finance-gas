# SDD：貸款自動還本推算與快照校準機制（Loan Auto-Amortization & Snapshot Calibration）

> 適用範圍：`cloudflare-pwa/`（不動根目錄 GAS 專案）
> 目標：針對「無法從網銀 APP 隨時查餘額」的房貸／車貸，只需輸入最後一次銀行單據基準，即自動按每月扣款日逐期本息均攤推算至今日剩餘本金；同時**完整保留手動快照更新與隨時校準能力**。

---

## 1. 需求與核心原則

1. **免依賴舊流水帳，直接算到今天**：
   - 以銀行最後一次對帳單的「**基準餘額 ＋ 基準日**」為起點，依「**每月扣款日、每月月付金、年利率**」自動計算 `基準日 < 扣款日 <= 今日` 的每一期本息均攤，0ms 得出**截至今日預估剩餘本金**。
2. **完整保留快照更新機制**：
   - 一般負債預設仍是純手動快照；開啟自動推算的貸款可隨時點「快照校準」覆蓋最新餘額與基準日（或調整升／降息後的新利率、月付金），也可隨時切回純手動快照。
3. **內建「反推年利率」小工具**：
   - 輸入「申貸日 ＋ 貸款年限（年）＋ 基準餘額 ＋ 每月月付金」，以二分法反推近似年利率一鍵帶入。
4. **即時反映至淨資產與月底歷史快照**：
   - `computeNetWorthSummary` 與 `runMonthEndSnapshotD1` 皆以當日推算剩餘本金計入總負債與淨資產。

---

## 2. D1 Migration（`migrations/0005_loan_amortization.sql`）

重用 `asset_items.balance_anchor_date` 作為單據基準日，新增 4 個向下相容欄位：
- `is_amortizing_loan INTEGER NOT NULL DEFAULT 0`
- `loan_annual_rate REAL`
- `loan_monthly_payment REAL`
- `loan_billing_day INTEGER`
