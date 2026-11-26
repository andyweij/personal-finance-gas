declare const __APP_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.8.5';
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'local';
export const DB_SCHEMA_VERSION = '0013';
export const SW_CACHE_VERSION = 'finance-pwa-v25';

export const VERSION_HIGHLIGHTS: string[] = [
  'v1.8.5：第二階段審查全面修復（嚴格僅對本次 ack 紀錄執行 rebase 不再繞過他機衝突、Promise-chain 互斥鎖序列化所有本機編輯與同步套用消除並行覆蓋、outbox 持久化 sentAt/attempts 防逾時或重載後誤合併、data_epoch 變動時凍結全部待送異動由使用者決定捨棄或重新套用並偵測請求中還原競態、CSV 匯入原子遞增 change_seq、報價／匯率未變不遞增 version 且 /api/market/refresh 尊重手動匯率設定、merge 匯入不復活軟刪除紀錄、UTF-8 位元組上限與全寫入端點 X-Expected-User 檢查、429 Retry-After 與無進展自動重試、localStorage 備援鎖與多分頁 snapshot_changed/logout 廣播）',
  'v1.8.4：修正持股「昨收」與現價不一致導致漲跌判定異常（TWSE MIS 盤中無成交 z="-" 改依序取委買賣價／開盤價／Yahoo 備援，絕不以昨收冒充現價；06:00 與每月 1 號 08:00 盤前排程僅更新美股與匯率；報價缺昨收時清空為 NULL 不沿用舊值；移除 Yahoo range=5d 的 chartPreviousClose 誤用並改補打 range=1d；持股編輯彈窗新增選填昨收欄位，手動改價未改昨收自動清空；自動更新持股的報價視為伺服器擁有，改成本／股數不覆蓋最新報價）',
  'v1.8.3：第一階段審查全面修復（同 mutationId 並發重試自動冪等確認不再誤報衝突、區分 RejectError 與暫時性 DB 錯誤避免資料遺失、固定時間窗速率限制原子化並自動清理過期 challenge、merge 匯入遞增版號與帳本刪除防並發 TOCTOU、遭拒編輯／刪除自動全量還原雲端真值、顯式 isNewRecord 與同步中 forceFullPull 佇列化，以及遭拒卡片新增複製內容與立即同步待上傳按鈕；另提醒舊版裝置更新後會自動相容同步）',
  'v1.8.2：同步引擎正確性全面升級（同步中編輯／刪除自動 rebase 不再自衝突或死而復生、單調遞增 change_seq 游標與伺服器統一 updated_at、還原覆蓋 data_epoch 跨裝置自動重載、行情更新遞增版號與自動／手動匯率切換、X-Expected-User 409 防跨帳號寫入與 BroadcastChannel 跨分頁同步、逾時控制／分批同步／指數退避／Web Locks，以及 IndexedDB 先落庫再更新狀態）',
  'v1.8.1：安全性與同步核心強化（Passkey 登入 challenge 原子綁定與速率限制、防覆寫他人憑證、D1 樂觀鎖條件寫入與批次原子交易、匯入前全量驗證、未知同步類型白名單拒絕，以及客戶端顯示並清理遭伺服器拒絕的同步異動）',
  'v1.8.0：新增「帳戶互轉（活存 ↔ 活存 / 定存・現金）」功能（支援跨幣別換匯自訂成交金額、跨帳本轉帳、選填轉帳手續費自動記支出不重複扣款，以及活存互轉配對一鍵雙向撤銷）',
  'v1.7.1：新增全域可拖曳「懸浮隨手計算機」（不中斷既有表單與編輯彈窗，支援四則運算／括號／百分比、近期計算紀錄，以及一鍵帶入剛剛輸入的金額或股數欄位並自動重算）',
  'v1.7.0：新增多帳本隔離管理（可建立獨立帳本隔離流水帳、多項活存與資產，並自由設定是否計入個人總資產／淨值與月底快照；支援單筆資產排除、各帳本獨立預設連動活存與常態收支跨帳本自動入帳）',
  'v1.6.0：持股頁新增「觀察清單」（自動更新報價但不計入總資產與投資組合，支援一鍵轉為持股）、昨收價與今日漲跌／日損益自動配色、股價最後更新時間顯示，以及單欄大張 3D 翻牌卡檢視模式',
  'v1.5.0：新增美股／ETF 自動行情同步（支援 VOO、NVDA、AAPL、BRK.B、NASDAQ:TSLA 等格式，Yahoo Finance ＋ Stooq 免費雙備援，並強化台股上櫃／債券 ETF 自動報價與美股收盤後排程）',
  'v1.4.1：修正混合配色模式（僅持股正紅負綠）於深淺色與快速切換時的即時套用與資產頁持股損益上色；升級排序編輯為浮動卡片連續拖曳（支援手機按住 ≡ 或長按項目跨格拖曳與邊緣自動捲動）',
  'v1.4.0：自訂正負數配色（綠紅／台股紅綠／僅持股紅綠）、持股／固定收支／資產手動排序、持股多圖表統計（甜甜圈／圓餅／長條／面積圖）與自訂持股分類（個股／ETF／特別股）、總覽通用大項可展開明細',
  'v1.3.0：離線使用指南、4～6 碼 PIN 免按確認秒解鎖、總覽稅金攤提口徑對齊',
  'v1.2.0：多租戶家庭隔離、一次性邀請碼、零知情密碼重置、Discoverable Passkey',
  'v1.1.0：樂觀鎖版本衝突保護、貸款自動還本推算、持股成本與配息回本追蹤',
];
