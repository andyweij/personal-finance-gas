export interface AppSettings {
  monthlyDailyBudget: number;
  emergencyTargetMonths: number;
  usdTwdRate: number;
  fxUpdatedAt?: string | null;
  updatedAt: string;
}

export interface CashFlowLog {
  id: string;
  date: string; // YYYY-MM-DD
  yearMonth: string; // YYYY-MM
  type: string;
  category: string;
  itemName: string;
  amount: number;
  currency: string;
  fxRate: number;
  twdAmount: number;
  source: string;
  note: string;
  recurringDedupKey?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface RecurringItem {
  id: string;
  itemName: string;
  category: string;
  type: string;
  amount: number;
  currency: string;
  cycle: string;
  billingSpec: string;
  status: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface SinkingFundItem {
  id: string;
  itemName: string;
  category: string;
  totalAmount: number;
  months: number;
  dueNote: string;
  status: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface AssetItem {
  id: string;
  updateMode: string;
  majorType: string;
  subCategory: string;
  liquidity: string;
  itemName: string;
  ticker: string;
  quantityOrAmount: number;
  currency: string;
  unitPrice: number;
  priceUpdatedAt?: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface NetWorthHistory {
  yearMonth: string;
  snapshotDate: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  highLiquidityAssets: number;
  investmentAssets: number;
  insuranceAssets: number;
  monthlyIncome: number;
  monthlyConsumption: number;
  savingsRate: number; // 0..1 ratio stored in DB
  note: string;
  updatedAt: string;
}

export interface FinanceSnapshot {
  settings: AppSettings;
  cashflowLogs: CashFlowLog[];
  recurringItems: RecurringItem[];
  sinkingItems: SinkingFundItem[];
  assetItems: AssetItem[];
  netWorthHistory: NetWorthHistory[];
}

export type SyncEntity = 'cashflow' | 'recurring' | 'sinking' | 'asset' | 'settings';
export type SyncOp = 'upsert' | 'delete';

export interface SyncMutation {
  mutationId: string;
  entity: SyncEntity;
  op: SyncOp;
  recordId: string;
  clientTimestamp: string;
  payload?: Record<string, unknown>;
  retryCount?: number;
  lastError?: string;
}

export interface SyncRequest {
  since?: string | null;
  mutations: SyncMutation[];
}

export interface SyncDelta {
  settings: AppSettings | null;
  cashflowLogs: CashFlowLog[];
  recurringItems: RecurringItem[];
  sinkingItems: SinkingFundItem[];
  assetItems: AssetItem[];
  netWorthHistory: NetWorthHistory[];
}

export interface SyncResponse {
  ok: boolean;
  serverTime: string;
  ackedMutationIds: string[];
  rejected: Array<{ mutationId: string; reason: string }>;
  delta: SyncDelta;
}

export interface PeriodMetrics {
  totalIncome: number;
  fixedExpense: number;
  subscription: number;
  dailyExpense: number;
  sinkingReserve: number;
  taxLargeActual: number;
  totalConsumption: number;
  investment: number;
  freeCashFlow: number;
  totalSavings: number;
  savingsRate: number; // percentage 0..100 with 1 decimal
  investmentStock: number;
  investmentFund: number;
  investmentOther: number;
  salary: number;
  rentIncome: number;
  otherIncome: number;
  mortgage: number;
  carLoan: number;
}

export interface MonthlyTrendPoint {
  month: number;
  ym: string;
  income: number;
  fixedSub: number;
  daily: number;
  taxLarge: number;
  investment: number;
  netCashFlow: number;
  totalSavings: number;
}

export interface NetWorthSummary {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  debtRatio: number;
  highLiquidityAssets: number;
  emergencyMonths: number;
  stockValue: number;
  cashUsdValue: number;
  fundStructuredValue: number;
  insuranceValue: number;
  otherAssetsValue: number;
}

export interface CachedPasskeyDto {
  id: string;
  publicKey: string;
  transports: string[];
}

export interface AuthStatusResponse {
  initialized: boolean;
  authenticated: boolean;
  pinEnabled: boolean;
  pinSalt?: string | null;
  pinHash?: string | null;
  passkeyCount: number;
  passkeys?: CachedPasskeyDto[];
}
