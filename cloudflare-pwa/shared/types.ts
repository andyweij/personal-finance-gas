export type PnlColorScheme = 'intl' | 'tw' | 'tw_stocks';

export type RebalanceTargetKind = 'category' | 'ticker';

export interface RebalanceTargetRule {
  id: string;
  kind: RebalanceTargetKind;
  key: string;
  label: string;
  targetPct: number;
}

export type CustomCategoriesMap = Record<string, string[]>;

export interface QuickEntryTemplate {
  id: string;
  label: string;
  type: string;
  category: string;
  itemName: string;
  amount: number | null;
  currency: string;
  linkedAccountId?: string | null;
  ledgerId?: string;
  note: string;
  oneClick?: boolean;
}

export interface AppSettings {
  monthlyDailyBudget: number;
  emergencyTargetMonths: number;
  usdTwdRate: number;
  enabledCurrencies?: string[];
  fxRates?: Record<string, number>;
  autoFxEnabled?: boolean;
  fxUpdatedAt?: string | null;
  pnlColorScheme?: PnlColorScheme;
  customStockCategories?: string[];
  rebalanceTargets?: RebalanceTargetRule[];
  customCategories?: CustomCategoriesMap;
  quickTemplates?: QuickEntryTemplate[];
  updatedAt: string;
  version?: number;
}

export type SharedLedgerRole = 'owner' | 'editor' | 'viewer';

export interface SharedLedgerMemberDto {
  userId: string;
  username: string;
  displayName: string;
  role: SharedLedgerRole;
  includeInNetWorth: boolean;
  joinedAt: string;
}

export interface SharedLedgerInviteDto {
  id: string;
  ledgerId: string;
  role: 'editor' | 'viewer';
  note: string;
  expiresAt: string;
  usedBy: string | null;
  usedByName?: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'used' | 'revoked' | 'expired';
}

export interface SharedLedgerSummaryDto {
  ledgerId: string;
  ledgerName: string;
  ownerUserId: string;
  ownerDisplayName: string;
  myRole: SharedLedgerRole;
  includeInNetWorth: boolean;
  members: SharedLedgerMemberDto[];
  invites?: SharedLedgerInviteDto[];
}

export interface SharedLedgerCursor {
  sinceSeq: number;
  clientEpoch: number;
}

export interface SharedLedgerSyncState {
  ledgerId: string;
  ownerUserId: string;
  ownerDisplayName: string;
  myRole: SharedLedgerRole;
  includeInNetWorth: boolean;
  memberCount: number;
  members: Array<{ userId: string; displayName: string; role: SharedLedgerRole }>;
  changeSeq: number;
  dataEpoch: number;
  fullResyncRequired?: boolean;
  epochMismatch?: boolean;
}

export interface Ledger {
  id: string;
  name: string;
  includeInNetWorth: boolean;
  monthlyDailyBudget?: number | null;
  note: string;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
  /** Phase 9 (v2.0.0): optional shared-ledger metadata populated by sync */
  isShared?: boolean;
  ownerUserId?: string;
  ownerDisplayName?: string;
  myRole?: SharedLedgerRole;
  memberCount?: number;
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
  linkedAccountId?: string | null;
  ledgerId?: string;
  installmentPlanId?: string | null;
  installmentSeq?: number | null;
  updatedByUserId?: string | null;
  updatedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
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
  /** v1.13.1: day of month (1-31) the auto-posted entry is dated; a missing day = 1, clamped to the month's end */
  postDay?: number;
  status: string;
  note: string;
  linkedAccountId?: string | null;
  ledgerId?: string;
  sortOrder?: number;
  updatedByUserId?: string | null;
  updatedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
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
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
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
  previousClose?: number | null;
  costBasis?: number | null;
  priceUpdatedAt?: string | null;
  note: string;
  isLinkedSavings?: boolean;
  balanceAnchorDate?: string | null;
  balanceAnchorAt?: string | null;
  isDefaultSavings?: boolean;
  isAmortizingLoan?: boolean;
  loanAnnualRate?: number | null;
  loanMonthlyPayment?: number | null;
  loanBillingDay?: number | null;
  isCreditCard?: boolean;
  creditBillingDay?: number | null;
  creditDueDay?: number | null;
  creditLimit?: number | null;
  stockCategory?: string;
  isWatchlist?: boolean;
  ledgerId?: string;
  excludeFromNetWorth?: boolean;
  sortOrder?: number;
  updatedByUserId?: string | null;
  updatedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export type StockTransactionType = 'buy' | 'sell' | 'cash_dividend' | 'stock_dividend';

export interface StockTransaction {
  id: string;
  assetId: string;
  date: string; // YYYY-MM-DD
  txType: StockTransactionType;
  shares: number; // > 0 for buy, sell, stock_dividend; 0 for cash_dividend
  totalAmount: number; // asset currency: buy total cost (incl. fee), sell net proceeds, cash_dividend net received
  fee: number; // optional fee / tax / health insurance metadata
  linkedCashflowId?: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export interface StockPositionSummary {
  asset: AssetItem;
  fxRate: number;
  hasCostBasis: boolean;
  baselineShares: number;
  baselineCostBasis: number;
  currentShares: number;
  marketPrice: number;
  previousClose: number | null;
  dailyChange: number | null;
  dailyChangePct: number | null;
  dailyPnl: number | null;
  dailyPnlTwd: number | null;
  marketValue: number; // asset currency
  marketValueTwd: number;
  /** 原始持有總成本（不含息，原幣） */
  costBasis: number;
  costBasisTwd: number;
  /** 原始每股平均成本（不含息，原幣） */
  avgCostPerShare: number;
  /** 帳面價差未實現損益（不含息，原幣 / TWD） */
  unrealizedPnl: number;
  unrealizedPnlTwd: number;
  unrealizedRoiPct: number;
  /** 累計現金配息（原幣 / TWD） */
  cumulativeCashDividends: number;
  cumulativeCashDividendsTwd: number;
  /** 累計股票配股股數 */
  cumulativeStockDividendShares: number;
  /** 已實現賣出損益（移動平均法，原幣 / TWD） */
  realizedPnl: number;
  realizedPnlTwd: number;
  /** 扣除配息後尚未回本成本（下限鎖 0，原幣 / TWD） */
  unrecoveredCost: number;
  unrecoveredCostTwd: number;
  /** 扣除配息後每股剩餘未回本成本（下限鎖 0，原幣） */
  unrecoveredCostPerShare: number;
  /** 成本歸零後超額回收現金（原幣 / TWD） */
  excessRecoveredCash: number;
  excessRecoveredCashTwd: number;
  /** 配息回本進度 0..100 */
  costRecoveryPct: number;
  isCostRecovered: boolean;
  /** 含息總淨利 = 未實現價差 + 累計配息 + 已實現損益（原幣 / TWD） */
  totalReturnPnl: number;
  totalReturnPnlTwd: number;
  /** 含息總報酬率 %（分母使用累計總投入成本，永不除以 0） */
  totalReturnRoiPct: number;
  totalInvestedAllTime: number;
  transactionCount: number;
}

export interface StockPortfolioSummary {
  positions: StockPositionSummary[];
  totalMarketValueTwd: number;
  totalDailyPnlTwd: number | null;
  totalDailyChangePct: number | null;
  latestPriceUpdatedAt: string | null;
  totalCostBasisTwd: number;
  totalUnrealizedPnlTwd: number;
  totalUnrealizedRoiPct: number;
  totalCashDividendsTwd: number;
  totalRealizedPnlTwd: number;
  totalUnrecoveredCostTwd: number;
  totalExcessRecoveredCashTwd: number;
  overallCostRecoveryPct: number;
  totalReturnPnlTwd: number;
  totalReturnRoiPct: number;
  hasAnyCostBasis: boolean;
}

export interface WatchlistItemSummary {
  asset: AssetItem;
  marketPrice: number;
  previousClose: number | null;
  dailyChange: number | null;
  dailyChangePct: number | null;
  priceUpdatedAt: string | null;
}

export interface WatchlistSummary {
  items: WatchlistItemSummary[];
  latestPriceUpdatedAt: string | null;
}

export interface LoanScheduleEntry {
  periodIndex: number;
  paymentDate: string;
  payment: number;
  interest: number;
  principal: number;
  remainingBalance: number;
}

export interface LoanAmortizationSummary {
  baseBalance: number;
  currentBalance: number;
  currentBalanceTwd: number;
  elapsedPeriods: number;
  totalPaidInterest: number;
  totalPaidPrincipal: number;
  nextPaymentDate: string | null;
  nextInterest: number;
  nextPrincipal: number;
  remainingPeriods: number | null;
  estimatedPayoffYm: string | null;
  isInterestOnly: boolean;
}

export interface SavingsAdjustment {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  amount: number; // positive = deposit, negative = withdrawal/transfer out
  twdAmount: number;
  note: string;
  transferGroupId?: string | null;
  updatedByUserId?: string | null;
  updatedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export interface SavingsAccountSummary {
  account: AssetItem;
  baseBalanceTwd: number;
  adjustmentsTotalTwd: number;
  cashflowNetTwd: number;
  linkedLogCount: number;
  adjustmentCount: number;
  /** M8: balance in the account's own currency (equal to currentBalanceTwd for TWD accounts) */
  currentBalanceNative: number;
  currentBalanceTwd: number;
}

export interface AllSavingsSummary {
  accounts: SavingsAccountSummary[];
  totalSavingsTwd: number;
  defaultAccountId: string | null;
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

export interface RentUtilityRecord {
  period: string;
  isBaseline: boolean;
  curTotal: number;
  cur6F: number;
  totalElec: number;
  totalWater: number;
  f6People: number;
  f5People: number;
  curA: number;
  curB: number;
  curC: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export interface RentUtilityRents {
  rent6F: number;
  rentA: number;
  rentB: number;
  rentC: number;
  updatedAt: string;
  version?: number;
}

export type FinancialGoalType = 'net_worth' | 'fire' | 'ledger_bucket' | 'asset_bucket' | 'manual';

export interface FinancialGoal {
  id: string;
  name: string;
  goalType: FinancialGoalType;
  targetAmount: number;
  currency: string;
  linkedLedgerId?: string | null;
  linkedAssetIds: string[];
  currentManualAmount: number;
  expectedAnnualReturnPct: number;
  monthlyContributionOverride?: number | null;
  fireSwrPct?: number | null;
  targetDate?: string | null; // YYYY-MM
  sortOrder?: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export type SplitReceivableStatus = 'open' | 'partial' | 'settled' | 'written_off';

export interface SplitReceivable {
  id: string;
  ledgerId: string;
  splitGroupId: string;
  counterparty: string;
  date: string; // YYYY-MM-DD
  itemName: string;
  category: string;
  amount: number;
  settledAmount: number;
  currency: string;
  fxRate: number;
  twdAmount: number;
  status: SplitReceivableStatus;
  sourceCashflowId?: string | null;
  sourceAccountId?: string | null;
  sourceAdjustmentId?: string | null;
  note: string;
  updatedByUserId?: string | null;
  updatedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export type InstallmentPlanStatus = 'active' | 'completed' | 'cancelled';

export interface InstallmentPlan {
  id: string;
  ledgerId: string;
  cardAccountId?: string | null;
  itemName: string;
  category: string;
  totalAmount: number;
  totalInstallments: number;
  postedInstallments: number;
  startYm: string; // YYYY-MM
  postDay: number; // 1..31
  currency: string;
  status: InstallmentPlanStatus;
  note: string;
  updatedByUserId?: string | null;
  updatedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version?: number;
}

export interface CreditCardBillingWindow {
  statementStart: string; // YYYY-MM-DD
  statementEnd: string; // YYYY-MM-DD
  paymentDueDate: string; // YYYY-MM-DD
  unbilledStart: string; // YYYY-MM-DD
  unbilledEnd: string; // YYYY-MM-DD
}

export interface CreditCardSummary {
  card: AssetItem;
  baseBalanceTwd: number;
  adjustmentsTotalTwd: number;
  cashflowChargesTwd: number;
  currentBalanceNative: number;
  currentBalanceTwd: number;
  unbilledChargesTwd: number;
  billedCycleChargesTwd: number;
  billedUnpaidTwd: number;
  activeInstallmentCount: number;
  remainingInstallmentsNative: number;
  remainingInstallmentsTwd: number;
  totalExposureTwd: number;
  creditLimit: number | null;
  creditLimitTwd: number | null;
  utilizationPct: number | null;
  linkedLogCount: number;
  adjustmentCount: number;
  billingWindow: CreditCardBillingWindow;
}

export interface AllCreditCardsSummary {
  cards: CreditCardSummary[];
  totalUnpaidTwd: number;
  totalRemainingInstallmentsTwd: number;
  totalExposureTwd: number;
}

export interface FinanceSnapshot {
  settings: AppSettings;
  ledgers?: Ledger[];
  cashflowLogs: CashFlowLog[];
  recurringItems: RecurringItem[];
  sinkingItems: SinkingFundItem[];
  assetItems: AssetItem[];
  savingsAdjustments: SavingsAdjustment[];
  stockTransactions: StockTransaction[];
  netWorthHistory: NetWorthHistory[];
  rentUtilityRecords: RentUtilityRecord[];
  rentUtilityRents: RentUtilityRents;
  financialGoals?: FinancialGoal[];
  splitReceivables?: SplitReceivable[];
  installmentPlans?: InstallmentPlan[];
}

export type SyncEntity =
  | 'ledger'
  | 'cashflow'
  | 'recurring'
  | 'sinking'
  | 'asset'
  | 'savings_adjustment'
  | 'stock_tx'
  | 'settings'
  | 'utility_record'
  | 'utility_rents'
  | 'financial_goal'
  | 'split_receivable'
  | 'installment_plan';
export type SyncOp = 'upsert' | 'delete';

export interface SyncMutation {
  mutationId: string;
  entity: SyncEntity;
  op: SyncOp;
  recordId: string;
  clientTimestamp: string;
  baseVersion?: number | null;
  isNewRecord?: boolean;
  payload?: Record<string, unknown>;
  /**
   * M4 (v1.8.12): mutations sharing this id (e.g. both legs and the fee of an account transfer) are applied by the
   * server in one D1 batch — all succeed or none do — and the client never splits them across requests.
   */
  atomicGroupId?: string;
  /** Phase 9 (v2.0.0): target shared ledger ID (server always re-verifies membership & owner). */
  sharedLedgerId?: string | null;
  sentAt?: string;
  attempts?: number;
  retryCount?: number;
  lastError?: string;
  frozenBaselineExisted?: boolean;
  frozenBaselineVersion?: number | null;
  frozenBaselineUpdatedAt?: string | null;
}

export interface SyncConflict {
  mutationId: string;
  entity: SyncEntity;
  op: SyncOp;
  recordId: string;
  baseVersion: number;
  serverVersion: number;
  clientPayload?: Record<string, unknown>;
  serverRecord: Record<string, unknown> | null;
  detectedAt: string;
}

export interface SyncRejection {
  mutationId: string;
  entity: SyncEntity | string;
  op: SyncOp | string;
  recordId: string;
  isNewRecord?: boolean;
  resolutionStatus?: 'rolled_back' | 'restored' | 'pending_resync' | 'quarantined' | 'skipped_newer' | 'held_after_reject';
  reason: string;
  clientPayload?: Record<string, unknown>;
  rejectedAt: string;
}

export interface SyncRequest {
  since?: string | null;
  sinceSeq?: number | null;
  clientEpoch?: number | null;
  mutations: SyncMutation[];
  /**
   * V1: Ask the server to perform a harmless D1 write (touch user_sync_state.updated_at). Sent with an empty
   * mutation list after a mutation failed with 5xx, to tell "this mutation is broken" apart from
   * "the write path is down". The response then carries writeProbeOk: true.
   */
  writeProbe?: boolean;
  /**
   * v1.8.17: the client orders mutations by their references before batching (orderMutationsByDependencies), so
   * the server applies the strict M3 reference check. Requests without it (v1.8.11 clients) may reference a record
   * that is still in their outbox; see refGuardSql in worker/sync.ts.
   */
  refsOrdered?: boolean;
  /** Phase 9 (v2.0.0): per-shared-ledger incremental cursors keyed by ledgerId. */
  sharedCursors?: Record<string, SharedLedgerCursor>;
}

export interface SyncDelta {
  settings: AppSettings | null;
  ledgers?: Ledger[];
  cashflowLogs: CashFlowLog[];
  recurringItems: RecurringItem[];
  sinkingItems: SinkingFundItem[];
  assetItems: AssetItem[];
  savingsAdjustments?: SavingsAdjustment[];
  stockTransactions?: StockTransaction[];
  netWorthHistory: NetWorthHistory[];
  rentUtilityRecords: RentUtilityRecord[];
  rentUtilityRents: RentUtilityRents | null;
  financialGoals?: FinancialGoal[];
  splitReceivables?: SplitReceivable[];
  installmentPlans?: InstallmentPlan[];
}

export interface SyncResponse {
  ok: boolean;
  serverTime: string;
  syncCursor?: number;
  dataEpoch?: number;
  fullResyncRequired?: boolean;
  epochMismatch?: boolean;
  ackedMutationIds: string[];
  rejected: Array<{ mutationId: string; reason: string }>;
  conflicts?: SyncConflict[];
  delta: SyncDelta;
  /** V1: true when the requested writeProbe D1 write succeeded. */
  writeProbeOk?: boolean;
  /** Phase 9 (v2.0.0): active shared-ledger states & member display names for this user. */
  sharedLedgers?: SharedLedgerSyncState[];
  /** Phase 9 (v2.0.0): shared ledger IDs revoked/left since last sync so client purges local cache. */
  revokedSharedLedgerIds?: string[];
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

export interface OverviewBreakdownItem {
  label: string;
  monthlyAmount: number;
  yearlyAmount: number;
}

export interface OverviewBreakdownGroup {
  key: string;
  label: string;
  monthlyAmount: number;
  yearlyAmount: number;
  isTotal?: boolean;
  children: OverviewBreakdownItem[];
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

export type UserRole = 'admin' | 'member';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  showUtilityTab: boolean;
}

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  showUtilityTab: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface InviteSummary {
  id: string;
  note: string;
  expiresAt: string;
  usedBy: string | null;
  usedByUsername?: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'used' | 'revoked' | 'expired';
}

export interface AuthStatusResponse {
  initialized: boolean;
  authenticated: boolean;
  user?: AuthUser;
  pinEnabled?: boolean;
  pinSalt?: string | null;
  pinHash?: string | null;
  passkeyCount?: number;
  passkeys?: CachedPasskeyDto[];
  /** H1: security events of the last 30 days (e.g. password reset with an admin-issued code) */
  securityNotices?: Array<{ id: string; kind: string; createdAt: string; actorDisplayName: string | null }>;
}

