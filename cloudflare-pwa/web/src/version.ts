declare const __APP_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.7.0';
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'local';
export const DB_SCHEMA_VERSION = '0011';
export const SW_CACHE_VERSION = 'finance-pwa-v18';

export const VERSION_HIGHLIGHTS: string[] = [
  'v1.7.0：新增多帳本隔離管理（可建立獨立帳本隔離流水帳、多項活存與資產，並自由設定是否計入個人總資產／淨值與月底快照；支援單筆資產排除、各帳本獨立預設連動活存與常態收支跨帳本自動入帳）',
  'v1.6.0：持股頁新增「觀察清單」（自動更新報價但不計入總資產與投資組合，支援一鍵轉為持股）、昨收價與今日漲跌／日損益自動配色、股價最後更新時間顯示，以及單欄大張 3D 翻牌卡檢視模式',
  'v1.5.0：新增美股／ETF 自動行情同步（支援 VOO、NVDA、AAPL、BRK.B、NASDAQ:TSLA 等格式，Yahoo Finance ＋ Stooq 免費雙備援，並強化台股上櫃／債券 ETF 自動報價與美股收盤後排程）',
  'v1.4.1：修正混合配色模式（僅持股正紅負綠）於深淺色與快速切換時的即時套用與資產頁持股損益上色；升級排序編輯為浮動卡片連續拖曳（支援手機按住 ≡ 或長按項目跨格拖曳與邊緣自動捲動）',
  'v1.4.0：自訂正負數配色（綠紅／台股紅綠／僅持股紅綠）、持股／固定收支／資產手動排序、持股多圖表統計（甜甜圈／圓餅／長條／面積圖）與自訂持股分類（個股／ETF／特別股）、總覽通用大項可展開明細',
  'v1.3.0：離線使用指南、4～6 碼 PIN 免按確認秒解鎖、總覽稅金攤提口徑對齊',
  'v1.2.0：多租戶家庭隔離、一次性邀請碼、零知情密碼重置、Discoverable Passkey',
  'v1.1.0：樂觀鎖版本衝突保護、貸款自動還本推算、持股成本與配息回本追蹤',
];
