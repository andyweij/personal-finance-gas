import type { AuthUser, CachedPasskeyDto, PnlColorScheme, RebalanceTargetKind } from '../../../shared/types';
import type { RebalanceMode } from '../../../shared/analytics';
import type { LedgerDatePreset } from '../../../shared/ledgerSearch';
import type { SyncEngine } from '../sync/syncEngine';
import type { LocalMeta } from '../db/localDb';

export interface LedgerSearchUiState {
  query: string;
  datePreset: LedgerDatePreset;
  dateFrom: string;
  dateTo: string;
  types: string[];
  category: string;
  linkedAccountId: string;
  minAmount: string;
  maxAmount: string;
  scopeMode: 'active' | 'net_worth' | 'all';
  filtersExpanded: boolean;
}

export function createDefaultLedgerSearchState(): LedgerSearchUiState {
  return {
    query: '',
    datePreset: 'month',
    dateFrom: '',
    dateTo: '',
    types: [],
    category: '',
    linkedAccountId: '',
    minAmount: '',
    maxAmount: '',
    scopeMode: 'active',
    filtersExpanded: false,
  };
}

export type StockChartType = 'donut' | 'pie' | 'hbar' | 'treemap';
export type StockChartDimension = 'value' | 'category' | 'cost' | 'market';
export type StockCardDisplayMode = 'list' | 'flip';
export type ReorderSectionKey =
  | 'stocks'
  | 'watchlist'
  | 'recurring'
  | 'sinking'
  | 'assets_savings'
  | 'assets_auto'
  | 'assets_manual';

export interface AppUiState {
  masked: boolean;
  activeTab: 'log' | 'overview' | 'assets' | 'stocks' | 'tools';
  logSubtab: 'entry' | 'ledger';
  ledgerMode: 'list' | 'calendar';
  ledgerPage: number;
  pageSize: number;
  selectedCalendarDay: string;
  ledgerSearch: LedgerSearchUiState;
  overviewPeriod: 'monthly' | 'yearly';
  overviewExpandedGroups: string[];
  chartMetric: 'netCashFlow' | 'investment' | 'totalSavings' | 'daily' | 'income';
  toolsSubtab: 'recurring' | 'sinking' | 'utility';
  recurringFilter: 'all' | 'income' | 'invest' | 'fixed' | 'sub';
  allocMode: 'both' | 'pct' | 'amt';
  allocHighlight: string | null;
  networthChartMode: 'line' | 'area';
  networthChartRange: '12m' | 'all';
  networthChartSelectedYm: string | null;
  stocksSubtab: 'holdings' | 'watchlist';
  dividendCalendarYear: number;
  dividendCalendarSelectedMonth: number | null;
  rebalanceKind: RebalanceTargetKind;
  rebalanceMode: RebalanceMode;
  rebalanceContribution: string;
  rebalanceExcludeUntargeted: boolean;
  stockPriceViewMode: 'unit' | 'total';
  stockCardDisplayMode: StockCardDisplayMode;
  flippedStockIds: string[];
  stockChartType: StockChartType;
  stockChartDimension: StockChartDimension;
  stockChartHighlight: string | null;
  pnlColorScheme: PnlColorScheme;
  reorderSection: ReorderSectionKey | null;
  reorderDraftIds: string[];
  selectedYear: number;
  selectedMonth: number;
  activeLedgerId: string;
  assetsLedgerScope: string;
  overviewLedgerScope: string;
  recurringLedgerScope: string;
  logType: string;
  logCurrency: string;
  logCategory: string;
  logLinkedAccountId: string | null;
  logLinkedAccountTouched: boolean;
  savingsExpanded: boolean;
  idleMinutes: number;
  lastActivityAt: number;
  pinEnabled: boolean;
  pinSalt: string | null;
  pinHash: string | null;
  biometricLockEnabled: boolean;
  passkeys: CachedPasskeyDto[];
  passkeyCount: number;
  authenticated: boolean;
  initialized: boolean;
  currentUser: AuthUser | null;
}

export interface UiContext {
  state: AppUiState;
  engine: SyncEngine;
  renderAll: () => void;
  scheduleSync: () => void;
  navigateToTab: (tab: AppUiState['activeTab']) => void;
  switchAccountDb: (user: AuthUser) => Promise<void>;
  applyUtilityTabVisibility: () => void;
  applyPnlColorScheme: (scheme: PnlColorScheme) => void;
}


/**
 * M9 (v1.8.12): the lock-screen settings live in the engine's stored meta (shared by all tabs). Copy them into the
 * UI state whenever the engine reloads, so a PIN / Face ID change made in another tab is used here too.
 */
export function applyAuthMetaToState(
  state: AppUiState,
  meta: Pick<LocalMeta, 'pinEnabled' | 'pinSalt' | 'pinHash' | 'biometricLockEnabled' | 'passkeys'>
): void {
  state.pinEnabled = Boolean(meta.pinEnabled);
  state.pinSalt = meta.pinSalt ?? null;
  state.pinHash = meta.pinHash ?? null;
  state.biometricLockEnabled = Boolean(meta.biometricLockEnabled);
  state.passkeys = meta.passkeys || [];
  state.passkeyCount = state.passkeys.length;
}
