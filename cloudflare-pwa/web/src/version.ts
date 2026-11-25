declare const __APP_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.4.1';
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'local';
export const DB_SCHEMA_VERSION = '0009';
export const SW_CACHE_VERSION = 'finance-pwa-v16';

export const VERSION_HIGHLIGHTS: string[] = [
  'v1.4.1：修正混合配色模式（僅持股正紅負綠）於深淺色與快速切換時的即時套用與資產頁持股損益上色；升級排序編輯為浮動卡片連續拖曳（支援手機按住 ≡ 或長按項目跨格拖曳與邊緣自動捲動）',
  'v1.4.0：自訂正負數配色（綠紅／台股紅綠／僅持股紅綠）、持股／固定收支／資產手動排序、持股多圖表統計（甜甜圈／圓餅／長條／面積圖）與自訂持股分類（個股／ETF／特別股）、總覽通用大項可展開明細',
  'v1.3.0：離線使用指南、4～6 碼 PIN 免按確認秒解鎖、總覽稅金攤提口徑對齊',
  'v1.2.0：多租戶家庭隔離、一次性邀請碼、零知情密碼重置、Discoverable Passkey',
  'v1.1.0：樂觀鎖版本衝突保護、貸款自動還本推算、持股成本與配息回本追蹤',
];
