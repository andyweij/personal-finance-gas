export const APP_TIMEZONE = 'Asia/Taipei';
export const DEFAULT_USD_TWD_RATE = 32.5;
export const DEFAULT_MONTHLY_DAILY_BUDGET = 45000;
export const DEFAULT_EMERGENCY_MONTHS = 6;
export const DEFAULT_PNL_COLOR_SCHEME = 'intl' as const;
export const PNL_COLOR_SCHEMES = ['intl', 'tw', 'tw_stocks'] as const;
export const DEFAULT_STOCK_CATEGORIES: string[] = ['個股', 'ETF', '特別股'];
export const DEFAULT_LEDGER_ID = 'default';
export const DEFAULT_LEDGER_NAME = '個人主帳本';

export const CASHFLOW_TYPES = {
  FIXED_INCOME: '固定收入',
  OTHER_INCOME: '其他收入',
  FIXED_EXPENSE: '固定支出',
  SUBSCRIPTION: '訂閱扣款',
  INVESTMENT: '投資流出',
  DAILY_EXPENSE: '日常花費',
  TAX_LARGE: '稅金與大額',
} as const;

export type CashFlowType = (typeof CASHFLOW_TYPES)[keyof typeof CASHFLOW_TYPES];

export const ALL_CASHFLOW_TYPES: string[] = [
  CASHFLOW_TYPES.FIXED_INCOME,
  CASHFLOW_TYPES.OTHER_INCOME,
  CASHFLOW_TYPES.FIXED_EXPENSE,
  CASHFLOW_TYPES.SUBSCRIPTION,
  CASHFLOW_TYPES.INVESTMENT,
  CASHFLOW_TYPES.DAILY_EXPENSE,
  CASHFLOW_TYPES.TAX_LARGE,
];

export const RECURRING_CASHFLOW_TYPES: string[] = [
  CASHFLOW_TYPES.FIXED_INCOME,
  CASHFLOW_TYPES.OTHER_INCOME,
  CASHFLOW_TYPES.FIXED_EXPENSE,
  CASHFLOW_TYPES.SUBSCRIPTION,
  CASHFLOW_TYPES.INVESTMENT,
];

export const QUICK_ENTRY_TYPES: string[] = [
  CASHFLOW_TYPES.DAILY_EXPENSE,
  CASHFLOW_TYPES.TAX_LARGE,
  CASHFLOW_TYPES.OTHER_INCOME,
  CASHFLOW_TYPES.INVESTMENT,
  CASHFLOW_TYPES.FIXED_EXPENSE,
];

export const CURRENCIES: string[] = ['TWD', 'USD', 'JPY', 'EUR', 'HKD', 'GBP', 'AUD', 'SGD', 'KRW'];
export const BILLING_CYCLES: string[] = ['月繳', '年繳', '特定月份', '一次性'];
export const STATUS_OPTIONS: string[] = ['啟用', '停用'];
export const SOURCE_OPTIONS: string[] = ['自動入帳', '手機記帳', '手動輸入', '匯入'];

export const ASSET_UPDATE_MODES: string[] = ['自動更新', '手動快照'];
export const ASSET_MAJOR_TYPES: string[] = ['資產', '負債'];
export const ASSET_SUB_CATEGORIES: string[] = [
  '活存',
  '台股',
  '美股/ETF',
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
export const LIQUIDITY_LEVELS: string[] = ['高流動', '中流動', '低流動', '負債'];

export const STOCK_TX_TYPES = {
  BUY: 'buy',
  SELL: 'sell',
  CASH_DIVIDEND: 'cash_dividend',
  STOCK_DIVIDEND: 'stock_dividend',
} as const;

export const FINANCIAL_GOAL_TYPES = ['net_worth', 'fire', 'ledger_bucket', 'asset_bucket', 'manual'] as const;

export const ALL_STOCK_TX_TYPES: string[] = [
  STOCK_TX_TYPES.BUY,
  STOCK_TX_TYPES.SELL,
  STOCK_TX_TYPES.CASH_DIVIDEND,
  STOCK_TX_TYPES.STOCK_DIVIDEND,
];

export const SINKING_FUND_CATEGORIES: string[] = [
  '所得稅',
  '房屋/地價稅',
  '汽機車稅費',
  '保費',
  '年度大額支出',
  '旅遊/目標基金',
  '其他',
];

export const WEBAPP_CATEGORY_MAP: Record<string, string[]> = {
  日常花費: ['餐飲', '交通', '日用品', '娛樂', '醫療', '服飾', '交際', '其他'],
  稅金與大額: ['所得稅', '房屋/地價稅', '汽機車稅費', '保費', '年度大額支出', '家電/維修', '其他'],
  其他收入: ['獎金', '股息/配息', '退稅', '房租收入', '副業/兼職', '其他'],
  投資流出: ['台股投資', '中信基金', '美股/ETF', '其他投資'],
  固定支出: ['房貸', '車貸', '房租支出', '水電瓦斯/管理費', '電信費', '其他'],
};

/**
 * H5 (v1.8.13): Cloudflare D1 allows 50 queries per Worker invocation on the Workers Free plan (1000 on Paid).
 * The client sends at most this many mutations per sync request and the server processes at most this many per
 * request (it also stops early when its per-request query budget would run out — unprocessed mutations are simply
 * not acked and are sent again with the next request).
 */
export const SYNC_MAX_MUTATIONS_PER_REQUEST = 20;
export const D1_QUERIES_PER_INVOCATION_FREE = 50;
