/**
 * 系統全域設定、分頁名稱、驗證選項與樣式常數
 * 注意：為了相容 GAS 全域載入順序，其他檔案請僅於函式內部存取這些常數。
 */

const APP_TIMEZONE = 'Asia/Taipei';
const DEFAULT_USD_TWD_RATE = 32.5;
const DEFAULT_MONTHLY_DAILY_BUDGET = 45000;
const DEFAULT_EMERGENCY_MONTHS = 6;

const SHEET_NAMES = {
  DASHBOARD: 'Dashboard',
  CASHFLOW_LOG: 'CashFlow_Log',
  RECURRING_CONFIG: 'Recurring_Config',
  SINKING_FUND: 'Annual_Sinking_Fund',
  ASSETS_LIABILITIES: 'Assets_Liabilities',
  NETWORTH_HISTORY: 'NetWorth_History',
} as const;

const CASHFLOW_TYPES = {
  FIXED_INCOME: '固定收入',
  OTHER_INCOME: '其他收入',
  FIXED_EXPENSE: '固定支出',
  SUBSCRIPTION: '訂閱扣款',
  INVESTMENT: '投資流出',
  DAILY_EXPENSE: '日常花費',
  TAX_LARGE: '稅金與大額',
} as const;

const ALL_CASHFLOW_TYPES: string[] = [
  CASHFLOW_TYPES.FIXED_INCOME,
  CASHFLOW_TYPES.OTHER_INCOME,
  CASHFLOW_TYPES.FIXED_EXPENSE,
  CASHFLOW_TYPES.SUBSCRIPTION,
  CASHFLOW_TYPES.INVESTMENT,
  CASHFLOW_TYPES.DAILY_EXPENSE,
  CASHFLOW_TYPES.TAX_LARGE,
];

const RECURRING_CASHFLOW_TYPES: string[] = [
  CASHFLOW_TYPES.FIXED_INCOME,
  CASHFLOW_TYPES.OTHER_INCOME,
  CASHFLOW_TYPES.FIXED_EXPENSE,
  CASHFLOW_TYPES.SUBSCRIPTION,
  CASHFLOW_TYPES.INVESTMENT,
];

const CURRENCIES: string[] = ['TWD', 'USD'];
const BILLING_CYCLES: string[] = ['月繳', '年繳', '特定月份', '一次性'];
const STATUS_OPTIONS: string[] = ['啟用', '停用'];
const SOURCE_OPTIONS: string[] = ['自動入帳', '手機記帳', '手動輸入'];

const ASSET_UPDATE_MODES: string[] = ['自動更新', '手動快照'];
const ASSET_MAJOR_TYPES: string[] = ['資產', '負債'];
const ASSET_SUB_CATEGORIES: string[] = [
  '台股',
  '美金',
  '定存/現金',
  '中信基金',
  '結構性商品',
  '保單(保價金)',
  '房貸餘額',
  '車貸餘額',
  '其他資產',
  '其他負債',
];
const LIQUIDITY_LEVELS: string[] = ['高流動', '中流動', '低流動', '負債'];

const SINKING_FUND_CATEGORIES: string[] = [
  '所得稅',
  '房屋/地價稅',
  '汽機車稅費',
  '保費',
  '年度大額支出',
  '旅遊/目標基金',
  '其他',
];

const DASHBOARD_DRILLDOWN_OPTIONS: string[] = [
  '投資流出(全部)',
  '台股投資',
  '中信基金',
  '總儲蓄(投資+存款結餘)',
  '現金存款淨增量',
  '薪資',
  '房租收入',
  '其他收入',
  '房貸',
  '車貸',
  '訂閱扣款',
  '日常花費',
  '稅金與大額',
];

const WEBAPP_CATEGORY_MAP: Record<string, string[]> = {
  日常花費: ['餐飲', '交通', '日用品', '娛樂', '醫療', '服飾', '交際', '其他'],
  稅金與大額: ['所得稅', '房屋/地價稅', '汽機車稅費', '保費', '年度大額支出', '家電/維修', '其他'],
  其他收入: ['獎金', '股息/配息', '退稅', '房租收入', '副業/兼職', '其他'],
  投資流出: ['台股投資', '中信基金', '美股/ETF', '其他投資'],
  固定支出: ['房貸', '車貸', '房租支出', '水電瓦斯/管理費', '電信費', '其他'],
};

const THEME_COLORS = {
  PRIMARY_DARK: '#1B365D',
  PRIMARY_ACCENT: '#2C5282',
  SECTION_BG: '#EBF3FA',
  SUBHEADER_BG: '#F1F5F9',
  INPUT_BG: '#FFFBEB',
  TOTAL_BG: '#EDF2F7',
  ZEBRA_BG: '#F8FAFC',
  WHITE: '#FFFFFF',
  BORDER: '#CBD5E1',
  TEXT_DARK: '#0F172A',
  TEXT_MUTED: '#475569',
  DANGER_BG: '#FEE2E2',
  DANGER_TEXT: '#B91C1C',
  WARNING_BG: '#FEF3C7',
  WARNING_TEXT: '#B45309',
  SUCCESS_BG: '#DCFCE7',
  SUCCESS_TEXT: '#15803D',
  INFO_BG: '#DBEAFE',
  INFO_TEXT: '#1D4ED8',
} as const;

interface CashFlowInput {
  date: Date;
  type: string;
  category: string;
  itemName: string;
  amount: number;
  currency: string;
  fxRate: number;
  source: string;
  note: string;
}

interface WebAppExpensePayload {
  date: string;
  type: string;
  category: string;
  itemName: string;
  amount: number | string;
  currency: string;
  note?: string;
  makeRecurring?: boolean;
}
