import type { AuthUser, CachedPasskeyDto } from '../../../shared/types';
import type { SyncEngine } from '../sync/syncEngine';

export interface AppUiState {
  masked: boolean;
  activeTab: 'log' | 'overview' | 'assets' | 'stocks' | 'tools';
  logSubtab: 'entry' | 'ledger';
  ledgerMode: 'list' | 'calendar';
  ledgerPage: number;
  pageSize: number;
  selectedCalendarDay: string;
  overviewPeriod: 'monthly' | 'yearly';
  chartMetric: 'netCashFlow' | 'investment' | 'totalSavings' | 'daily' | 'income';
  toolsSubtab: 'recurring' | 'sinking' | 'utility';
  recurringFilter: 'all' | 'income' | 'invest' | 'fixed' | 'sub';
  allocMode: 'both' | 'pct' | 'amt';
  allocHighlight: string | null;
  stockPriceViewMode: 'unit' | 'total';
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
}

