# 任務：修正持股「昨收」與現價不一致導致漲跌判定異常

你是這個專案的原作者。使用者回報：**更新股價後，昨收資訊可能與實際不符，導致漲跌判定異常。** 以下是審查找到的原因，請逐一修正。

- 範圍僅限 `cloudflare-pwa/`，不要修改根目錄 GAS 版。下文路徑皆相對於 `cloudflare-pwa/`。
- 行號以 commit `6c0b194`（v1.8.1）為準，若已變動請自行定位。
- 審查時無法連線至 TWSE MIS / Yahoo 實測，標「待確認」的項目請先查證資料來源的實際行為再決定修法。

## 工作規則

1. 每項修正先寫能重現問題的失敗測試（vitest，用假的 `fetchImpl` 模擬 TWSE MIS / Yahoo / Stooq 回應），再修正。
2. 完成後 `npm run typecheck && npm test` 全數通過。
3. 一個 commit，格式 `fix(cloudflare-pwa): vX.Y.Z ...`，更新 `package.json`、`web/src/version.ts`、`web/public/sw.js` 的版本。
4. 若需要 schema 變更，新增 migration（目前已用到 `0012`，從 `0013` 起），不要改舊 migration。
5. 若你判斷某項分析有誤，說明理由後跳過。

---

## 1. TWSE MIS 盤中無成交時把昨收當現價（最優先）— `worker/market.ts:398-404`

```ts
const zNum = entry?.z && entry.z !== '-' ? Number(entry.z) : NaN;
const price = validZ ?? validY;   // z 為 '-' 時現價 = 昨收
return { price, previousClose: validY };
```

MIS 的 `z`（最近成交價）在盤中常為 `-`（該快照期間無成交、13:25–13:30 收盤集合競價等）。此時現價被設成昨收 `y`，漲跌顯示 0，且錯誤的現價被寫入 `asset_items.unit_price`，覆蓋原本正確的價格。

**修正方向：**
- `z` 為 `-` 時，依序嘗試：最佳買賣價中間值或第一檔（`b` / `a`，以 `_` 分隔的字串，取第一個有效數字）→ 開盤價 `o` → 改走 Yahoo fallback。
- 只有在「確定當日完全無成交」時才可用 `y` 當現價（請查證 MIS 欄位判斷方式；若無法判斷，寧可回傳 null 讓 Yahoo 接手）。
- 測試：`z: '-'` 且有 `b`/`a`；`z: '-'` 且只有 `o`；`z: '-'` 全無 → 應 fallback 到 Yahoo。

## 2. 06:00 排程可能把台股寫成「現價 = 昨收」（待確認）— `wrangler.toml.example` crons、`worker/index.ts` 排程分派

06:00（UTC 22:00）的排程會更新所有報價（含台股）。若 MIS 在此時已換日（`z = '-'`、`y` = 前一交易日收盤），套用第 1 點的舊邏輯會覆蓋 23:00 抓到的正確收盤與漲跌，整天顯示平盤。

**修正方向：**
- 先查證 MIS 換日時間。
- 06:00 排程只更新美股（它本來的目的是美股收盤後更新）；台股只在 23:00 與使用者手動更新時抓取。或在寫入前判斷：若新報價的現價等於昨收、且舊資料的 `price_updated_at` 在同一交易日以後，就不要覆蓋。

## 3. 報價缺昨收時沿用舊值 — `worker/market.ts:565`

```sql
SET unit_price = ?, previous_close = COALESCE(?, previous_close), ...
```

報價來源回傳 `previousClose: null` 時，會寫入新現價但保留舊昨收（可能是好幾天前），漲跌變成「今天價格 − 數天前收盤」。會回傳 null 的情況：
- Stooq 單筆 fallback（`market.ts:373` 固定 `previousClose: null`）
- Yahoo 只有 1 根有效 K 棒且日期條件不成立

**修正方向：**
- 缺昨收時寫入 `NULL`（前端顯示「待更新」並不判定漲跌），不再 `COALESCE` 沿用舊值。
- 或者只在舊昨收與新現價屬同一交易日時才保留（需記錄昨收所屬日期；若要做，新增 `previous_close_date` 欄位）。
- 測試：舊資料有昨收 100，新報價 `{ price: 120, previousClose: null }` → 寫入後昨收不應為 100。

## 4. Yahoo `chartPreviousClose` 不是昨收 — `worker/market.ts:284-293`

使用 `range=5d` 時，`meta.chartPreviousClose` 是「圖表區間起點前一日」的收盤（約一週前），不是昨收；`meta.previousClose` 在非 `range=1d` 時通常不存在。

**修正方向：**
- 移除 `chartPreviousClose` fallback。
- 有效 K 棒不足 2 根時，改打一次 `range=1d`（其 `meta.previousClose` / `chartPreviousClose` 才是昨收），否則回傳 null。
- 測試：5d 回應只有 1 根 K 棒、`chartPreviousClose` 為一週前價格 → 不應被當作昨收。

## 5. 手動修改持股市價時昨收維持舊值 — `web/src/ui/stocksTab.ts:1888`（持股視窗 `stPrice` 欄位約在 `:1654-1662`）

```ts
unitPrice: marketPrice,                         // 使用者剛輸入的新價格
previousClose: existing?.previousClose ?? null, // 舊昨收
```

持股編輯視窗可以改「目前市價」，但沒有昨收欄位（觀察清單有 `wlPrevClose`），存檔後漲跌 = 新價格 − 舊昨收。

**修正方向：**
- 持股視窗比照觀察清單加入「昨收價（選填）」欄位；或者使用者修改了市價（與 `existing.unitPrice` 不同）時把 `previousClose` 設為 null，等下次自動更新補上。
- 使用者只改成本、股數等其他欄位而沒改市價時，**不要送出** `unitPrice` / `previousClose`，避免用本機舊報價覆蓋伺服器新報價（見第 6 點）。
- 觀察清單視窗（`stocksTab.ts:1489-1501`）同樣檢查：使用者改了價格但沒改昨收時的行為。

## 6. 伺服器更新報價不遞增 version，客戶端舊報價可覆蓋新報價 — `worker/market.ts:562-569`、`worker/sync.ts:1100-1125`

排程或手動更新報價時只改 `updated_at`，不改 `version`。裝置在尚未同步到新報價前編輯持股（例如改成本），payload 帶著本機的舊 `unitPrice` / `previousClose`，版本檢查通過，伺服器的新報價被覆蓋回舊值。

**修正方向（擇一）：**
- **建議**：報價欄位（`unit_price`、`previous_close`、`price_updated_at`）對 `updateMode = '自動更新'` 的資產視為伺服器擁有。sync upsert 時若 payload 的 `unitPrice` / `previousClose` 與現存值不同，且未明確標記為使用者手動輸入，就保留伺服器值。
- 或在 market UPDATE 加 `version = version + 1`（但會讓使用者在報價更新後編輯持股時產生衝突，需評估 UX）。
- 測試：伺服器 v3 報價已更新為 (120, 118)，客戶端以 baseVersion 3 送出只改成本、帶舊報價 (100, 99) 的 upsert → 伺服器報價應維持 (120, 118)。

---

## 交付要求

回報：
- 各項修正方式（或跳過理由），特別是第 1、2、4 點查證到的資料來源實際行為
- 新增的測試清單與 `npm test` 結果
- 是否新增 migration 與相容性說明
- 既有資料中可能已經錯誤的昨收要如何處理（例如部署後手動觸發一次 `/api/market/refresh`，或 migration 將 `price_updated_at` 早於某日的 `previous_close` 清為 NULL）
