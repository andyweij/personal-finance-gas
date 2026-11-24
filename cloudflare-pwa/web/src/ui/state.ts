import type { CachedPasskeyDto } from '../../../shared/types';
import type { SyncEngine } from '../sync/syncEngine';

export interface AppUiState {
  masked: boolean;
  activeTab: 'log' | 'overview' | 'config' | 'assets';
  logSubtab: 'entry' | 'ledger';
  ledgerMode: 'list' | 'calendar';
  ledgerPage: number;
  pageSize: number;
  selectedCalendarDay: string;
  overviewPeriod: 'monthly' | 'yearly';
  chartMetric: 'netCashFlow' | 'investment' | 'totalSavings' | 'daily' | 'income';
  configSubtab: 'recurring' | 'sinking';
  recurringFilter: 'all' | 'income' | 'invest' | 'fixed' | 'sub';
  allocMode: 'both' | 'pct' | 'amt';
  allocHighlight: string | null;
  selectedYear: number;
  selectedMonth: number;
  logType: string;
  logCurrency: string;
  logCategory: string;
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
}

export interface UiContext {
  state: AppUiState;
  engine: SyncEngine;
  renderAll: () => void;
  scheduleSync: () => void;
}
