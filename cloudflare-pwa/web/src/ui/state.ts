import type { AuthUser, CachedPasskeyDto, PnlColorScheme } from '../../../shared/types';
import type { SyncEngine } from '../sync/syncEngine';

export type StockChartType = 'donut' | 'pie' | 'hbar' | 'treemap';
export type StockChartDimension = 'value' | 'category' | 'cost' | 'market';
export type ReorderSectionKey =
  | 'stocks'
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
  overviewPeriod: 'monthly' | 'yearly';
  overviewExpandedGroups: string[];
  chartMetric: 'netCashFlow' | 'investment' | 'totalSavings' | 'daily' | 'income';
  toolsSubtab: 'recurring' | 'sinking' | 'utility';
  recurringFilter: 'all' | 'income' | 'invest' | 'fixed' | 'sub';
  allocMode: 'both' | 'pct' | 'amt';
  allocHighlight: string | null;
  stockPriceViewMode: 'unit' | 'total';
  stockChartType: StockChartType;
  stockChartDimension: StockChartDimension;
  stockChartHighlight: string | null;
  pnlColorScheme: PnlColorScheme;
  reorderSection: ReorderSectionKey | null;
  reorderDraftIds: string[];
  selectedYear: number;
  selectedMonth: number;
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

