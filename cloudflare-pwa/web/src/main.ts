/// <reference types="vite/client" />
import { getDatePartsInTimeZone } from '../../shared/dates';
import './styles.css';
import { DEFAULT_LEDGER_ID } from '../../shared/constants';
import { CURRENCY_META, SUPPORTED_CURRENCY_CODES, isValidFxRateForCurrency, resolveFxRate } from '../../shared/currency';
import { computeAllSavingsSummary } from '../../shared/calculations';
import { computeAllCreditCardsSummary } from '../../shared/creditCard';
import type { PnlColorScheme } from '../../shared/types';
import { normalizeEnabledCurrencies, normalizePnlColorScheme } from '../../shared/validation';
import { LocalFinanceDB } from './db/localDb';
import { SyncEngine, type SyncStatus } from './sync/syncEngine';
import {
  fetchAuthStatus,
  getRememberedAccount,
  logoutSession,
  PENDING_SERVER_LOGOUT_KEY,
  saveRememberedAccount,
  setAuthExpectedUser,
} from './auth/authClient';
import { resetCreditCardUiState } from './ui/creditCardUi';
import { createCrossTabChannel } from './sync/crossTab';
import { closeModal, el, fmtMoney, isDesktopDevice, openModal, setLoading, showToast, bindSubmit } from './ui/helpers';
import {
  bindLedgerSearchEvents,
  getTodayYmd,
  renderLogCategories,
  renderLogCurrencyButtons,
  renderLogTab,
  updateFxPreview,
  updateSavingsPreview,
} from './ui/logTab';
import { bindQuickTemplatesAndAutocompleteEvents, closeAutocompleteDropdown } from './ui/quickTemplatesUi';
import { renderOverviewTab, renderTrendChart } from './ui/overviewTab';
import {
  getActiveSinkingItems,
  getFilteredRecurringItems,
  openRecurringModal,
  openSinkingModal,
  renderConfigTab,
} from './ui/configTab';
import {
  getAssetSectionIds,
  openAccountTransferModal,
  openAssetModal,
  openSavingsAccountModal,
  renderAssetsTab,
} from './ui/assetsTab';
import {
  getOrderedStockIds,
  getOrderedWatchlistIds,
  openStockBaselineModal,
  openWatchlistModal,
  renderStocksTab,
} from './ui/stocksTab';
import { bindUtilityTabEvents, renderUtilityTab } from './ui/utilityTab';
import { openCreateSplitModal } from './ui/splitsUi';
import { openJoinSharedLedgerModal } from './ui/sharedLedgerUi';
import { cancelReorder, startReorder } from './ui/reorderHelper';
import {
  closeLockScreen,
  isAnyLockEnabled,
  openAuthScreen,
  openLockScreen,
  showSecurityNotices,
  openSecurityModal,
  triggerPinKey,
  unlockLockScreenWithFaceId,
  updateSecurityButtons,
} from './ui/securityUi';
import { initBottomNavScrub } from './ui/tabBarScrub';
import { openConflictsModal } from './ui/conflictUi';
import { openHelpGuideModal } from './ui/helpGuideUi';
import { initFloatingCalculator, openCalculatorFor } from './ui/calculatorUi';
import { renderHomeTab, renderSimpleStocksRow } from './ui/homeTab';
import { bindMoreTabEvents, renderMoreTab } from './ui/moreTab';
import { renderLedgerSwitcherBar, resolveActiveLedger } from './ui/ledgerUi';
import {
  CLASSIC_TABS,
  SIMPLE_SECONDARY_PARENT,
  getCurrentUiVariant,
  readUiVariant,
  resolveTabForVariant,
  simpleNavHighlight,
  writeUiVariant,
  type UiVariant,
} from './ui/uiVariant';
import type {
  AppUiState,
  StockCardDisplayMode,
  StockChartDimension,
  StockChartType,
  UiContext,
} from './ui/state';
import { applyAuthMetaToState, createDefaultLedgerSearchState } from './ui/state';

const RECURRING_ELIGIBLE_LOG = ['其他收入', '投資流出', '固定支出'];

/**
 * M12 (v1.8.14): register the Service Worker and offer updates. A new version installs in the background and
 * waits; the user is asked ("有新版本") and only on confirmation does the page send SKIP_WAITING, after which the
 * page reloads once when the new worker takes control. Unsynced data is safe: it lives in IndexedDB.
 */
function showUpdateBanner(worker: ServiceWorker, activatedElsewhere = false): void {
  const existing = document.getElementById('swUpdateBanner');
  if (existing && !activatedElsewhere) return;
  existing?.remove();
  const bar = document.createElement('div');
  bar.id = 'swUpdateBanner';
  bar.className = 'update-banner';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  text.textContent = activatedElsewhere ? '新版本已在其他分頁啟用，請重新整理' : '有新版本可以使用';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'btn btn-sm';
  later.textContent = '稍後';
  later.addEventListener('click', () => bar.remove());
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-tinted btn-sm';
  apply.textContent = activatedElsewhere ? '重新整理' : '立即更新';
  apply.addEventListener('click', () => {
    apply.disabled = true;
    // Review (M12): another tab may already have activated this worker — then only a reload is needed
    if (activatedElsewhere || worker.state === 'activated' || worker.state === 'redundant') {
      window.location.reload();
      return;
    }
    updateRequested = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
  bar.appendChild(text);
  bar.appendChild(later);
  bar.appendChild(apply);
  document.body.appendChild(bar);
}

let updateRequested = false;

function registerServiceWorker(): void {
  // Review (M12): the dev server serves untransformed sources; never let a Service Worker cache them
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  const hadControllerAtLoad = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) {
      updateRequested = false;
      window.location.reload();
      return;
    }
    // First install (clients.claim) — nothing to do. Otherwise another tab activated a new version while this
    // tab still runs the old bundle: ask for a reload instead of silently continuing with old code.
    if (hadControllerAtLoad && navigator.serviceWorker.controller) {
      showUpdateBanner(navigator.serviceWorker.controller, true);
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const offer = (worker: ServiceWorker | null) => {
          if (worker && navigator.serviceWorker.controller) showUpdateBanner(worker);
        };
        const track = (incoming: ServiceWorker) => {
          if (incoming.state === 'installed') offer(incoming);
          incoming.addEventListener('statechange', () => {
            if (incoming.state === 'installed') offer(incoming);
          });
        };
        if (reg.waiting) offer(reg.waiting);
        if (reg.installing) track(reg.installing); // an update that started before `load`
        reg.addEventListener('updatefound', () => {
          if (reg.installing) track(reg.installing);
        });
        // Check for a new version when the app comes back to the foreground
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        });
      })
      .catch(() => {
        // Ignore registration errors in unsupported dev contexts
      });
  });
}

type AppTab = AppUiState['activeTab'];
// v2.2.0: apply the stored 介面版本 before anything renders, so the 經典版 layout never flashes first
document.documentElement.dataset.ui = readUiVariant(localStorage);
const ALL_TABS: AppTab[] = ['home', 'log', 'overview', 'assets', 'stocks', 'tools', 'more'];
const dirtyTabs = new Set<AppTab>(ALL_TABS);
let renderTabImpl: ((tab: AppTab) => void) | null = null;

function renderTabIfDirty(tab: AppTab): void {
  if (!dirtyTabs.has(tab) || !renderTabImpl) return;
  dirtyTabs.delete(tab);
  renderTabImpl(tab);
}

function renderSyncPill(status: SyncStatus): void {
  const pill = el('syncStatusPill');
  pill.className = `sync-pill ${status.state}`;
  // v1.8.15: rejections no longer turn the engine state into 'conflict' (so offline / pending stay visible);
  // the pill still shows them as a warning together with that state
  const rejectionOnly =
    (status.rejectedCount || 0) > 0 &&
    (status.state === 'synced' || status.state === 'pending' || status.state === 'offline');
  if (rejectionOnly) pill.className = 'sync-pill conflict';
  if (status.state === 'conflict' || rejectionOnly) {
    const cCount = status.conflictCount || 0;
    const rCount = status.rejectedCount || 0;
    const fCount = status.frozenOutboxCount || 0;
    if (fCount > 0) {
      pill.textContent = `⚠ 待確認 (${fCount + cCount + rCount})`;
      pill.title = `雲端已從備份還原，有 ${fCount} 筆還原前離線異動待確認，點擊處理`;
    } else if (cCount > 0 && rCount > 0) {
      pill.textContent = `⚠ 異常 (${cCount + rCount})`;
      pill.title = `有 ${cCount} 筆版本衝突與 ${rCount} 筆同步失敗，點擊處理`;
    } else if (rCount > 0) {
      // Status pill: rejections must not hide offline / pending state
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const extra = offline
        ? ' · 離線'
        : status.pendingCount > 0
          ? ` · 待同步 ${status.pendingCount}`
          : '';
      pill.textContent = `⚠ 同步失敗 (${rCount})${extra}`;
      pill.title = `有 ${rCount} 筆異動被伺服器拒絕${
        status.pendingCount > 0 ? `，另有 ${status.pendingCount} 筆待同步` : ''
      }，點擊同步並檢視原因`;
    } else {
      pill.textContent = `⚠ 衝突 (${cCount || 1})`;
      pill.title = '偵測到離線與雲端版本衝突，點擊選擇保留版本';
    }
  } else if (status.state === 'synced') {
    pill.textContent = '● 已同步';
    pill.title = '點擊立即同步';
  } else if (status.state === 'syncing') {
    pill.textContent = '↻ 同步中';
    pill.title = '正在同步雲端資料';
  } else if (status.state === 'pending') {
    pill.textContent = `☁ 待同步 (${status.pendingCount})`;
    pill.title = '點擊立即上傳待同步資料';
  } else if (status.state === 'offline') {
    pill.textContent = status.pendingCount > 0 ? `✈ 離線 (${status.pendingCount})` : '✈ 離線模式';
    pill.title = '目前處於離線模式，恢復網路後自動同步';
  } else {
    pill.textContent = status.pendingCount > 0 ? `🔒 需登入 (${status.pendingCount})` : '🔒 請重新登入';
    pill.title = '點擊重新登入以同步';
  }
}

/**
 * H3 / M11: While the sign-in or lock screen is open, the app behind it must be neither readable (the overlay
 * is only a blur) nor reachable by keyboard / screen readers. Watches both overlays' `open` class.
 */
function concealAppWhileOverlayOpen(): void {
  const overlayIds = ['authScreen', 'lockScreen'];
  // M12: the update prompt stays usable on the sign-in screen (it is hidden while the lock screen is open)
  const keepVisible = new Set([...overlayIds, 'toast', 'loadingBar', 'swUpdateBanner']);
  const overlays = overlayIds
    .map((id) => document.getElementById(id))
    .filter((n): n is HTMLElement => Boolean(n));
  const apply = () => {
    const covered = overlays.some((o) => o.classList.contains('open'));
    document.body.classList.toggle('app-concealed', covered);
    document.body.classList.toggle('lock-open', Boolean(document.getElementById('lockScreen')?.classList.contains('open')));
    // Every other top-level element (topbar, content, nav, modal sheet, calculator…) is hidden and inert
    for (const part of Array.from(document.body.children) as HTMLElement[]) {
      if (keepVisible.has(part.id) || part.tagName === 'SCRIPT') continue;
      if (covered) {
        part.setAttribute('inert', '');
        part.setAttribute('aria-hidden', 'true');
      } else {
        part.removeAttribute('inert');
        part.removeAttribute('aria-hidden');
      }
    }
  };
  const observer = new MutationObserver(apply);
  for (const o of overlays) observer.observe(o, { attributes: true, attributeFilter: ['class'] });
  apply();
}

async function bootstrap(): Promise<void> {
  registerServiceWorker();

  const storedIdle = localStorage.getItem('finance_idle_minutes');
  const parsedIdle = storedIdle !== null && !Number.isNaN(Number(storedIdle)) ? Number(storedIdle) : 5;
  const storedAlloc = localStorage.getItem('finance_alloc_mode');
  const storedStockView = localStorage.getItem('finance_stock_view_mode');
  const storedCardMode = localStorage.getItem('finance_stock_card_mode');
  const storedChartType = localStorage.getItem('finance_stock_chart_type');
  const storedChartDim = localStorage.getItem('finance_stock_chart_dim');
  const storedPnlScheme = normalizePnlColorScheme(localStorage.getItem('finance_pnl_scheme'));
  const remembered = getRememberedAccount();
  const now = new Date();

  document.documentElement.dataset.pnlScheme = storedPnlScheme;
  document.documentElement.classList.remove('pnl-scheme-intl', 'pnl-scheme-tw', 'pnl-scheme-tw_stocks');
  document.documentElement.classList.add(`pnl-scheme-${storedPnlScheme}`);

  const urlParams = new URLSearchParams(window.location.search);
  const inviteParam = (urlParams.get('invite') || '').trim();
  const resetParam = (urlParams.get('reset') || '').trim();
  const userParam = (urlParams.get('user') || '').trim();
  const joinLedgerParam = (urlParams.get('joinLedger') || '').trim();

  const validChartType: StockChartType =
    storedChartType === 'pie' || storedChartType === 'hbar' || storedChartType === 'treemap'
      ? storedChartType
      : 'donut';
  const validChartDim: StockChartDimension =
    storedChartDim === 'category' || storedChartDim === 'cost' || storedChartDim === 'market'
      ? storedChartDim
      : 'value';
  const validCardMode: StockCardDisplayMode = storedCardMode === 'flip' ? 'flip' : 'list';

  const state: AppUiState = {
    masked: localStorage.getItem('finance_masked') === '1',
    activeTab: readUiVariant(localStorage) === 'simple' ? 'home' : 'log',
    activeLedgerId: localStorage.getItem('finance_active_ledger_id') || DEFAULT_LEDGER_ID,
    assetsLedgerScope: 'net_worth',
    overviewLedgerScope: 'net_worth',
    recurringLedgerScope: 'all',
    logSubtab: 'entry',
    ledgerMode: 'list',
    ledgerPage: 1,
    pageSize: 10,
    selectedCalendarDay: getTodayYmd(),
    ledgerSearch: createDefaultLedgerSearchState(),
    overviewPeriod: 'monthly',
    overviewExpandedGroups: [],
    chartMetric: 'netCashFlow',
    toolsSubtab: 'recurring',
    recurringFilter: 'all',
    allocMode: storedAlloc === 'pct' || storedAlloc === 'amt' ? storedAlloc : 'both',
    allocHighlight: null,
    networthChartMode: 'line',
    networthChartRange: '12m',
    networthChartSelectedYm: null,
    stocksSubtab: 'holdings',
    dividendCalendarYear: getDatePartsInTimeZone(now).year,
    dividendCalendarSelectedMonth: null,
    rebalanceKind: 'category',
    rebalanceMode: 'buy_only',
    rebalanceContribution: '',
    rebalanceExcludeUntargeted: false,
    stockPriceViewMode: storedStockView === 'total' ? 'total' : 'unit',
    stockCardDisplayMode: validCardMode,
    flippedStockIds: [],
    stockChartType: validChartType,
    stockChartDimension: validChartDim,
    stockChartHighlight: null,
    pnlColorScheme: storedPnlScheme,
    reorderSection: null,
    reorderDraftIds: [],
    selectedYear: getDatePartsInTimeZone(now).year, // review (v1.8.15): APP_TIMEZONE month
    selectedMonth: getDatePartsInTimeZone(now).month,
    logType: '日常花費',
    logCurrency: 'TWD',
    logCategory: '餐飲',
    logLinkedAccountId: null,
    logLinkedAccountTouched: false,
    savingsExpanded: false,
    idleMinutes: [0, 5, 15, 30, 60].includes(parsedIdle) ? parsedIdle : 5,
    lastActivityAt: Date.now(),
    pinEnabled: false,
    pinSalt: null,
    pinHash: null,
    biometricLockEnabled: false,
    passkeys: [],
    passkeyCount: 0,
    authenticated: false,
    initialized: true,
    currentUser: null,
  };

  let syncDebounce: number | undefined;
  let activeDb = new LocalFinanceDB(LocalFinanceDB.dbNameForUser(remembered?.id));
  const accountChannel = createCrossTabChannel('personal-finance-account-sync');

  const createSyncEngineForDb = (db: LocalFinanceDB, expectedUserId?: string): SyncEngine => {
    const engine: SyncEngine = new SyncEngine(db, {
      expectedUserId,
      onStatusChange: (status) => renderSyncPill(status),
      onSnapshotChange: () => {
        // M9: a PIN / Face ID change made in another tab reloads this engine — pick the new lock settings up
        if (ctx.engine === engine) {
          applyAuthMetaToState(ctx.state, engine.getMeta());
          updateSecurityButtons(ctx);
        }
        ctx.renderAll();
      },
      onError: (msg) => showToast(`本機資料儲存失敗：${msg}`, 'error'),
      onAuthRequired: () => {
        ctx.state.authenticated = false;
        openAuthScreen(ctx, 'login', '登入憑證已過期，重新登入後將自動上傳待同步帳目', () => {
          void ctx.engine.syncNow();
        });
      },
      onAccountMismatch: (info) => {
        ctx.state.authenticated = false;
        showToast(info.error, 'error');
        openAuthScreen(ctx, 'login', info.error, () => {
          void fetchAuthStatus().then(async (auth) => {
            if (auth.authenticated && auth.user) {
              await ctx.switchAccountDb(auth.user);
              void ctx.engine.syncNow(true);
            }
          });
        });
      },
    });
    return engine;
  };

  const applyPnlSchemeDom = (scheme: PnlColorScheme) => {
    const normalized = normalizePnlColorScheme(scheme);
    state.pnlColorScheme = normalized;
    document.documentElement.dataset.pnlScheme = normalized;
    document.documentElement.classList.remove('pnl-scheme-intl', 'pnl-scheme-tw', 'pnl-scheme-tw_stocks');
    document.documentElement.classList.add(`pnl-scheme-${normalized}`);
    localStorage.setItem('finance_pnl_scheme', normalized);
  };

  const ctx: UiContext = {
    state,
    engine: null as unknown as SyncEngine,
    applyPnlColorScheme: (scheme) => {
      applyPnlSchemeDom(scheme);
    },
    renderAll: () => {
      const snap = ctx.engine.getSnapshot();
      if (snap.settings.pnlColorScheme) {
        applyPnlSchemeDom(snap.settings.pnlColorScheme);
      }
      const autoFx = snap.settings.autoFxEnabled !== false;
      const enabledCurrs = normalizeEnabledCurrencies(snap.settings.enabledCurrencies);
      const extraCount = enabledCurrs.filter((c) => c !== 'TWD' && c !== 'USD').length;
      const fxEl = el('fxTopPill');
      fxEl.textContent = `USD ${Number(snap.settings.usdTwdRate || 32.5).toFixed(2)}${extraCount > 0 ? ` · +${extraCount}幣` : ''}${autoFx ? '' : ' · 手動'}`;
      fxEl.title = autoFx ? '多幣別與自動匯率設定（點擊調整）' : '多幣別與手動匯率設定（點擊調整）';
      // v1.8.15 performance: only the visible tab is rendered now; the others are marked dirty and rendered
      // when they are opened (each tab reads the engine snapshot, not another tab's DOM)
      for (const tab of ALL_TABS) dirtyTabs.add(tab);
      renderTabIfDirty(ctx.state.activeTab);
    },
    scheduleSync: () => {
      window.clearTimeout(syncDebounce);
      syncDebounce = window.setTimeout(() => {
        void ctx.engine.syncNow();
      }, 300);
    },
    navigateToTab: () => {},
    setUiVariant: () => {},
    openQuickAdd: () => {},
    applyUtilityTabVisibility: () => {
      const show =
        ctx.state.currentUser !== null
          ? ctx.state.currentUser.showUtilityTab
          : Boolean(remembered?.showUtilityTab);
      const bar = el('toolsSubtabBar');
      const utilBtn = bar.querySelector<HTMLButtonElement>('[data-tools-sub="utility"]');
      if (utilBtn) {
        utilBtn.style.display = show ? '' : 'none';
      }
      bar.classList.toggle('cols-3', show);
      bar.classList.toggle('cols-2', !show);
      if (!show && ctx.state.toolsSubtab === 'utility') {
        ctx.state.toolsSubtab = 'recurring';
        bar.querySelectorAll<HTMLButtonElement>('[data-tools-sub]').forEach((b) => {
          b.classList.toggle('active', b.dataset.toolsSub === 'recurring');
        });
        el('subtab-recurring').style.display = 'flex';
        el('subtab-sinking').style.display = 'none';
        el('subtab-utility').style.display = 'none';
      }
    },
    switchAccountDb: async (user) => {
      const prevUserId = ctx.state.currentUser?.id || remembered?.id || null;
      ctx.state.currentUser = user;
      setAuthExpectedUser(ctx.state.currentUser?.id ?? null);
      cancelReorder(ctx, true);
      saveRememberedAccount(user);
      const nextDbName = LocalFinanceDB.dbNameForUser(user.id);
      if (activeDb.getDbName() !== nextDbName) {
        // v1.8.15: let queued local operations finish before the database is closed
        await ctx.engine?.destroy();
        activeDb.close();
        activeDb = new LocalFinanceDB(nextDbName);
        const nextEngine = createSyncEngineForDb(activeDb, user.id);
        ctx.engine = nextEngine;
        await nextEngine.init();
        applyAuthMetaToState(state, nextEngine.getMeta());
        state.activeLedgerId = DEFAULT_LEDGER_ID;
        localStorage.setItem('finance_active_ledger_id', DEFAULT_LEDGER_ID);
        state.assetsLedgerScope = 'net_worth';
        state.overviewLedgerScope = 'net_worth';
        state.recurringLedgerScope = 'all';
        state.flippedStockIds = [];
        state.logLinkedAccountTouched = false;
        state.ledgerSearch = createDefaultLedgerSearchState();
        state.ledgerPage = 1;
        state.networthChartSelectedYm = null;
        state.dividendCalendarYear = getDatePartsInTimeZone(new Date()).year;
        resetCreditCardUiState();
        state.dividendCalendarSelectedMonth = null;
        state.rebalanceContribution = '';
        state.rebalanceExcludeUntargeted = false;
      } else {
        ctx.engine?.setExpectedUserId(user.id);
      }
      if (prevUserId && prevUserId !== user.id) {
        accountChannel?.postMessage({ type: 'account_changed', userId: user.id });
      }
      ctx.applyUtilityTabVisibility();
      ctx.renderAll();
    },
  };

  renderTabImpl = (tab) => {
    if (tab === 'home') renderHomeTab(ctx);
    else if (tab === 'more') renderMoreTab(ctx);
    else if (tab === 'log') renderLogTab(ctx);
    else if (tab === 'overview') renderOverviewTab(ctx);
    else if (tab === 'assets') {
      renderAssetsTab(ctx);
      renderSimpleStocksRow(ctx);
    } else if (tab === 'stocks') renderStocksTab(ctx);
    else {
      renderConfigTab(ctx);
      renderUtilityTab(ctx);
    }
  };
  ctx.engine = createSyncEngineForDb(activeDb, remembered?.id);

  if (accountChannel) {
    accountChannel.onmessage = (data: unknown) => {
      const msg = data as { type?: string; userId?: string } | null;
      if (!msg) return;
      if (msg.type === 'logout') {
        // H3: the other tab deletes this account's local data on logout — reload into the clean state
        ctx.engine.haltForAccountMismatch();
        ctx.engine.destroy();
        ctx.state.authenticated = false;
        document.body.classList.add('app-concealed');
        window.location.reload();
        return;
      }
      if (msg.type !== 'account_changed') return;
      const currentId = ctx.state.currentUser?.id || remembered?.id;
      if (msg.userId && msg.userId !== currentId) {
        ctx.engine.haltForAccountMismatch();
        showToast('其他分頁已切換登入帳號，正在同步切換對應帳本…');
        void fetchAuthStatus()
          .then(async (auth) => {
            if (auth.authenticated && auth.user) {
              await ctx.switchAccountDb(auth.user);
              void ctx.engine.syncNow(true);
            } else {
              ctx.state.authenticated = false;
              openAuthScreen(ctx, 'login', '其他分頁已切換或登出帳號，請重新登入', () => {
                void ctx.engine.syncNow(true);
              });
            }
          })
          .catch(() => {});
      }
    };
  }

  // 1. 0ms 立即從該帳號專屬的本機 IndexedDB 載入畫面（離線也能秒開）
  await ctx.engine.init();
  applyAuthMetaToState(state, ctx.engine.getMeta());

  el<HTMLInputElement>('dateInput').value = getTodayYmd();
  renderLogCurrencyButtons(ctx);
  renderLogCategories(ctx);
  ctx.applyUtilityTabVisibility();
  updateSecurityButtons(ctx);
  ctx.renderAll();

  if (!inviteParam && !resetParam && isAnyLockEnabled(ctx)) {
    openLockScreen(ctx, '');
  }

  // 申請瀏覽器持久化儲存（降低 iOS 清理機率）
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }

  bindEvents(ctx);
  concealAppWhileOverlayOpen();

  // 網址帶入邀請碼或密碼重置碼時，直接開啟對應畫面
  if (inviteParam) {
    closeLockScreen(ctx);
    openAuthScreen(ctx, 'register', '', () => void ctx.engine.syncNow(true), { inviteCode: inviteParam });
    return;
  }
  if (resetParam) {
    closeLockScreen(ctx);
    openAuthScreen(ctx, 'reset', '', () => void ctx.engine.syncNow(true), {
      resetCode: resetParam,
      username: userParam,
    });
    return;
  }

  // H3: a logout that could not reach the server must be completed before the session cookie is trusted again
  let pendingServerLogout = false;
  try {
    pendingServerLogout = localStorage.getItem(PENDING_SERVER_LOGOUT_KEY) === '1';
  } catch {
    pendingServerLogout = false;
  }
  if (pendingServerLogout) {
    const done = navigator.onLine ? await logoutSession(false, false) : false;
    if (!done) {
      closeLockScreen(ctx);
      openAuthScreen(ctx, 'login', '已登出，請重新登入', () => void ctx.engine.syncNow(true));
      return;
    }
  }

  // 2. 背景檢查雲端登入狀態並自動同步
  if (navigator.onLine) {
    try {
      const auth = await fetchAuthStatus();
      state.initialized = auth.initialized;
      state.authenticated = auth.authenticated;
      if (auth.authenticated && auth.user) {
        await ctx.switchAccountDb(auth.user);
        // M9: write the server's PIN / passkeys first, then read every lock setting back from the stored meta
        // (the per-device Face ID toggle may have been changed by another tab and is not overwritten here)
        await ctx.engine.updateLocalPinCache(Boolean(auth.pinEnabled), auth.pinSalt || null, auth.pinHash || null);
        await ctx.engine.updateLocalPasskeysCache(auth.passkeys || []);
        applyAuthMetaToState(state, ctx.engine.getMeta());
        updateSecurityButtons(ctx);
        if (!isAnyLockEnabled(ctx)) {
          closeLockScreen(ctx);
        }
        showSecurityNotices(auth.securityNotices);
        void ctx.engine.syncNow();
        if (joinLedgerParam) {
          try {
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('joinLedger');
            window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
          } catch {
            // ignore
          }
          openJoinSharedLedgerModal(ctx, joinLedgerParam);
        }
      } else if (!auth.initialized) {
        await ctx.engine.updateLocalPinCache(false, null, null);
        await ctx.engine.updateLocalBiometricCache(false, []);
        applyAuthMetaToState(state, ctx.engine.getMeta());
        updateSecurityButtons(ctx);
        closeLockScreen(ctx);
        openAuthScreen(ctx, 'setup', '', () => void ctx.engine.syncNow(true));
      } else {
        // H3: the server is reachable and says this device is not signed in (logged out or session expired).
        // Never show the cached ledger without signing in again — offline-first viewing is only for real offline.
        closeLockScreen(ctx);
        openAuthScreen(
          ctx,
          'login',
          ctx.engine.getMeta().lastSyncedAt ? '登入已失效，請重新登入後繼續使用' : '',
          () => void ctx.engine.syncNow(true)
        );
      }
    } catch {
      // 離線或伺服器暫時無法連線，維持本機模式運作
    }
  }
}

function bindEvents(ctx: UiContext): void {
  // Bottom Nav (支援點擊切換 ＋ 按住左右滑動高亮膠囊、放開切換分頁)
  const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#bottomNav .nav-btn'));
  const simpleNavButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#simpleNav [data-simple-tab]'));
  const tabOrder: Array<AppUiState['activeTab']> = CLASSIC_TABS;
  const TAB_LABELS: Partial<Record<AppTab, string>> = { home: '首頁', log: '明細', assets: '資產', more: '更多' };
  // v2.2.0 簡潔版：從哪一頁點進總覽／持股／工具，返回鍵就回到那一頁
  let simpleReturnTab: AppTab | null = null;

  const showTab = (tab: AppTab) => {
    if (ctx.state.activeTab !== tab && ctx.state.reorderSection) {
      cancelReorder(ctx);
    }
    ctx.state.activeTab = tab;
    renderTabIfDirty(tab); // v1.8.15: tabs are rendered lazily
    navButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const highlighted = simpleNavHighlight(tab);
    simpleNavButtons.forEach((b) => b.classList.toggle('active', b.dataset.simpleTab === highlighted));
    document.querySelectorAll('.tab-view').forEach((v) => v.classList.toggle('active', v.id === 'tab-' + tab));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activateTabByIndex = (idx: number) => {
    const safeIdx = Math.max(0, Math.min(navButtons.length - 1, idx));
    const btn = navButtons[safeIdx];
    showTab((btn.dataset.tab as AppUiState['activeTab']) || tabOrder[safeIdx]);
  };

  const navScrub = initBottomNavScrub({
    navEl: el('bottomNav'),
    buttons: navButtons,
    pillEl: el('navPill'),
    getActiveIndex: () => Math.max(0, tabOrder.indexOf(ctx.state.activeTab)),
    onSelectIndex: (idx) => activateTabByIndex(idx),
  });

  ctx.navigateToTab = (tab) => {
    const variant = getCurrentUiVariant();
    const target = resolveTabForVariant(tab, variant);
    if (variant === 'simple') {
      document.getElementById('quickAddBackdrop')?.classList.remove('open');
      if (SIMPLE_SECONDARY_PARENT[target]) {
        const from = ctx.state.activeTab;
        if (!SIMPLE_SECONDARY_PARENT[from]) simpleReturnTab = from;
        const label = TAB_LABELS[simpleReturnTab || SIMPLE_SECONDARY_PARENT[target]!] || '返回';
        document.querySelectorAll<HTMLElement>(`#tab-${target} [data-simple-back-label]`).forEach((n) => {
          n.textContent = label;
        });
      } else {
        simpleReturnTab = null;
      }
      showTab(target);
      return;
    }
    showTab(target);
    navScrub.syncPill(false);
  };

  navButtons.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      activateTabByIndex(idx);
      navScrub.syncPill(false);
    });
  });

  simpleNavButtons.forEach((btn) => {
    btn.addEventListener('click', () => ctx.navigateToTab(btn.dataset.simpleTab as AppTab));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-simple-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = ctx.state.activeTab;
      ctx.navigateToTab(simpleReturnTab || SIMPLE_SECONDARY_PARENT[current] || 'home');
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-goto-tab]').forEach((btn) => {
    btn.addEventListener('click', () => ctx.navigateToTab(btn.dataset.gotoTab as AppTab));
  });

  // v2.2.0 簡潔版「記一筆」底部面板（沿用 #expenseForm，搬進面板）
  const expenseForm = el<HTMLFormElement>('expenseForm');
  const quickAddBackdrop = el('quickAddBackdrop');
  const QA_SEG_FOR_TYPE: Record<string, string> = {
    日常花費: '日常花費',
    稅金與大額: '日常花費',
    固定支出: '日常花費',
    其他收入: '其他收入',
    投資流出: '投資流出',
  };
  const syncQaTypeSeg = () => {
    const active = QA_SEG_FOR_TYPE[ctx.state.logType] || '';
    document.querySelectorAll<HTMLButtonElement>('#qaTypeSeg [data-qa-type]').forEach((b) => {
      const on = b.dataset.qaType === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  };
  document.querySelectorAll<HTMLButtonElement>('#qaTypeSeg [data-qa-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>(`#logTypeChips [data-type="${btn.dataset.qaType}"]`)?.click();
      syncQaTypeSeg();
    });
  });
  el('logTypeChips').addEventListener('click', () => window.setTimeout(syncQaTypeSeg, 0));
  el('qaMoreToggle').addEventListener('click', () => {
    const expanded = expenseForm.classList.toggle('qa-expanded');
    el('qaMoreToggle').setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
  el('amountCalcBtn').addEventListener('click', () => openCalculatorFor(el<HTMLInputElement>('amountInput')));

  const renderQuickAddLedgerBar = () => {
    renderLedgerSwitcherBar(ctx, el('quickAddLedgerBar'), {
      mode: 'single',
      selectedValue: resolveActiveLedger(ctx).id,
      onSelect: (nextId) => {
        ctx.state.activeLedgerId = nextId;
        localStorage.setItem('finance_active_ledger_id', nextId);
        ctx.state.logLinkedAccountTouched = false;
        ctx.state.ledgerPage = 1;
        renderLogTab(ctx);
        renderQuickAddLedgerBar();
        syncQaTypeSeg();
      },
    });
  };
  const closeQuickAdd = () => {
    quickAddBackdrop.classList.remove('open');
    closeAutocompleteDropdown();
  };
  ctx.openQuickAdd = () => {
    if (getCurrentUiVariant() !== 'simple') {
      ctx.navigateToTab('log');
      document.querySelector<HTMLButtonElement>('#logSubtabBar [data-log-sub="entry"]')?.click();
      return;
    }
    if (!el<HTMLInputElement>('dateInput').value) el<HTMLInputElement>('dateInput').value = getTodayYmd();
    renderLogTab(ctx); // refreshes the form's chips, templates and linked accounts
    renderQuickAddLedgerBar();
    syncQaTypeSeg();
    quickAddBackdrop.classList.add('open');
    el<HTMLInputElement>('amountInput').focus();
  };
  el('simpleAddBtn').addEventListener('click', () => ctx.openQuickAdd());
  el('quickAddCloseBtn').addEventListener('click', closeQuickAdd);
  quickAddBackdrop.addEventListener('click', (e) => {
    if (e.target === quickAddBackdrop) closeQuickAdd();
  });
  quickAddBackdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('modalBackdrop').classList.contains('open') && !el('calcBackdrop').classList.contains('open')) {
      closeQuickAdd();
    }
  });
  expenseForm.addEventListener('finance:entry-saved', () => {
    if (getCurrentUiVariant() === 'simple') closeQuickAdd();
  });

  // v2.2.0 簡潔版資產頁：一顆「＋」收納原本的 5 顆操作按鈕
  el('simpleAssetsRefreshBtn').addEventListener('click', () => el('refreshMarketBtn').click());
  el('simpleAssetsAddBtn').addEventListener('click', () => {
    const body = openModal('資產操作');
    const list = document.createElement('div');
    list.className = 'simple-action-list';
    const actions: Array<[string, string, string]> = [
      ['addSavingsBtn', '新增活存帳戶', 'btn btn-primary'],
      ['addAssetBtn', '新增資產或負債', 'btn btn-tinted'],
      ['transferAccountBtn', '帳戶互轉（活存／定存）', 'btn btn-tinted'],
      ['runSnapshotBtn', '記錄本月淨值快照', 'btn btn-outline'],
    ];
    for (const [id, label, cls] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls + ' btn-block';
      b.textContent = label;
      b.addEventListener('click', () => {
        closeModal();
        el(id).click();
      });
      list.appendChild(b);
    }
    body.appendChild(list);
  });

  bindMoreTabEvents(ctx);

  const applyUiVariant = (variant: UiVariant) => {
    document.documentElement.dataset.ui = variant;
    if (variant === 'simple') {
      el('quickAddBody').appendChild(expenseForm);
      expenseForm.style.display = '';
    } else {
      closeQuickAdd();
      const ledgerPanel = el('ledgerPanel');
      ledgerPanel.parentNode?.insertBefore(expenseForm, ledgerPanel);
      expenseForm.classList.remove('qa-expanded');
      el('qaMoreToggle').setAttribute('aria-expanded', 'false');
      expenseForm.style.display = ctx.state.logSubtab === 'entry' ? '' : 'none';
    }
    simpleReturnTab = null;
    for (const tab of ALL_TABS) dirtyTabs.add(tab);
    showTab(resolveTabForVariant(ctx.state.activeTab, variant));
    if (variant === 'classic') window.requestAnimationFrame(() => navScrub.syncPill(false));
  };
  ctx.setUiVariant = (variant) => {
    if (variant === getCurrentUiVariant()) return;
    writeUiVariant(localStorage, variant);
    if (variant === 'simple') ctx.state.activeTab = 'home';
    applyUiVariant(variant);
    showToast(variant === 'simple' ? '已切換為簡潔版' : '已切換為經典版', 'success');
  };
  applyUiVariant(readUiVariant(localStorage));

  // Topbar actions
  el('syncStatusPill').addEventListener('click', async () => {
    // Conflicts and frozen (post-restore) changes need a decision first. Rejections alone do not block a
    // manual sync: sync first, then the modal below lists the rejections.
    if (ctx.engine.getConflicts().length > 0 || ctx.engine.getFrozenOutbox().length > 0) {
      openConflictsModal(ctx);
      return;
    }
    if (ctx.engine.getStatus().state === 'auth_required') {
      openAuthScreen(ctx, 'login', '請重新登入以同步資料', () => void ctx.engine.syncNow());
      return;
    }
    const res = await ctx.engine.syncNow();
    if (ctx.engine.getConflicts().length > 0 || ctx.engine.getRejections().length > 0) {
      const cCnt = ctx.engine.getConflicts().length;
      const rCnt = ctx.engine.getRejections().length;
      showToast(
        rCnt > 0
          ? `偵測到 ${rCnt} 筆同步被拒${cCnt > 0 ? `與 ${cCnt} 筆衝突` : ''}，請檢視原因`
          : `偵測到 ${cCnt} 筆離線版本衝突，請選擇保留版本`,
        'error'
      );
      openConflictsModal(ctx);
    } else if (res.ok) {
      showToast('雲端同步完成', 'success');
    } else if (!res.authRequired) {
      showToast(res.error || '目前處於離線模式');
    }
  });

  el('refreshBtn').addEventListener('click', async () => {
    setLoading(true);
    const res = await ctx.engine.syncNow(true);
    setLoading(false);
    if (res.ok) showToast('已重新同步最新雲端帳本', 'success');
    else if (!res.authRequired) showToast(res.error || '同步失敗', 'error');
  });

  const fxPillEl = document.getElementById('fxTopPill');
  if (fxPillEl) {
    fxPillEl.style.cursor = 'pointer';
    fxPillEl.addEventListener('click', () => {
      const s = ctx.engine.getSnapshot().settings;
      const autoFx = s.autoFxEnabled !== false;
      const draftEnabled = new Set<string>(normalizeEnabledCurrencies(s.enabledCurrencies));
      const draftRates: Record<string, number> = {};
      for (const code of SUPPORTED_CURRENCY_CODES) {
        if (code === 'TWD') continue;
        draftRates[code] = resolveFxRate(code, s);
      }

      const body = openModal('多幣別與匯率設定');
      const form = document.createElement('form');
      form.className = 'reb-modal-form';

      const curSection = document.createElement('div');
      const curLabel = document.createElement('label');
      curLabel.className = 'section-label';
      curLabel.textContent = '啟用幣別（顯示於快速記帳與帳戶表單）';
      const curChips = document.createElement('div');
      curChips.className = 'chip-group';
      curSection.appendChild(curLabel);
      curSection.appendChild(curChips);
      form.appendChild(curSection);

      const ratesSection = document.createElement('div');
      ratesSection.className = 'fx-rates-list';
      form.appendChild(ratesSection);

      const rateInputs = new Map<string, HTMLInputElement>();

      const renderRatesList = () => {
        // Persist in-progress edits before re-rendering
        for (const [code, inp] of rateInputs.entries()) {
          const v = Number(inp.value);
          if (Number.isFinite(v) && v > 0) draftRates[code] = v;
        }
        rateInputs.clear();
        ratesSection.innerHTML = '';
        const list = SUPPORTED_CURRENCY_CODES.filter((c) => c !== 'TWD' && (c === 'USD' || draftEnabled.has(c)));
        for (const code of list) {
          const meta = CURRENCY_META[code];
          const row = document.createElement('div');
          row.className = 'reb-edit-row';
          const left = document.createElement('div');
          left.className = 'reb-edit-left';
          const titleEl = document.createElement('strong');
          titleEl.textContent = `1 ${code} (${meta.label})`;
          const hintEl = document.createElement('span');
          hintEl.className = 'muted tnum';
          hintEl.style.fontSize = '11px';
          hintEl.textContent = `= ? TWD（合理範圍 ${meta.minTwdRate}～${meta.maxTwdRate}）`;
          left.appendChild(titleEl);
          left.appendChild(hintEl);

          const inp = document.createElement('input');
          inp.type = 'number';
          inp.inputMode = 'decimal';
          // v1.12.3: auto-updated rates carry 4–6 decimals; a fixed step made the browser's native validation
          // (stepMismatch) silently block the whole form. Range checks are done by isValidFxRateForCurrency.
          inp.step = 'any';
          inp.className = 'tnum reb-pct-input';
          inp.style.width = '96px';
          inp.value = String(draftRates[code] ?? meta.defaultTwdRate);
          rateInputs.set(code, inp);

          row.appendChild(left);
          row.appendChild(inp);
          ratesSection.appendChild(row);
        }
      };

      const renderCurChips = () => {
        curChips.innerHTML = '';
        for (const code of SUPPORTED_CURRENCY_CODES) {
          const meta = CURRENCY_META[code];
          const btn = document.createElement('button');
          btn.type = 'button';
          const isOn = code === 'TWD' || draftEnabled.has(code);
          btn.className = 'chip-btn sm' + (isOn ? ' active' : '');
          btn.textContent = `${code} ${meta.label}`;
          if (code === 'TWD') {
            btn.disabled = true;
          } else {
            btn.addEventListener('click', () => {
              if (draftEnabled.has(code)) draftEnabled.delete(code);
              else draftEnabled.add(code);
              renderCurChips();
              renderRatesList();
            });
          }
          curChips.appendChild(btn);
        }
      };

      renderCurChips();
      renderRatesList();

      const autoRow = document.createElement('label');
      autoRow.className = 'tpl-oneclick-box';
      const autoCb = document.createElement('input');
      autoCb.type = 'checkbox';
      autoCb.checked = autoFx;
      const autoTxt = document.createElement('span');
      autoTxt.textContent = '允許系統每日排程自動更新所有外幣匯率（關閉後將保留您的手動匯率，不被排程覆蓋）';
      autoRow.appendChild(autoCb);
      autoRow.appendChild(autoTxt);
      form.appendChild(autoRow);

      const footer = document.createElement('div');
      footer.className = 'reb-modal-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-outline btn-sm';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => closeModal());
      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'btn btn-primary btn-sm';
      saveBtn.textContent = '儲存多幣別設定';
      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);
      form.appendChild(footer);

      bindSubmit(form, async (e) => {
        e.preventDefault();
        try {
          const nextRates: Record<string, number> = { ...draftRates };
          for (const [code, inp] of rateInputs.entries()) {
            const val = Number(inp.value);
            if (!isValidFxRateForCurrency(code, val)) {
              const meta = CURRENCY_META[code as keyof typeof CURRENCY_META];
              throw new Error(`${code} 匯率超出合理範圍（須介於 ${meta.minTwdRate}～${meta.maxTwdRate}）`);
            }
            nextRates[code] = val;
          }
          const usdRate = nextRates.USD ?? s.usdTwdRate ?? 32.5;
          const enabledList = SUPPORTED_CURRENCY_CODES.filter((c) => c === 'TWD' || draftEnabled.has(c));
          await ctx.engine.saveMultiCurrencySettings({
            usdTwdRate: usdRate,
            fxRates: nextRates,
            enabledCurrencies: enabledList,
            autoFxEnabled: autoCb.checked,
          });
          closeModal();
          showToast(
            autoCb.checked
              ? `已更新多幣別設定（共 ${enabledList.length} 幣別，自動更新開啟）`
              : `已更新多幣別與手動匯率設定（共 ${enabledList.length} 幣別）`,
            'success'
          );
          ctx.scheduleSync();
        } catch (err) {
          showToast(err instanceof Error ? err.message : '匯率格式不正確', 'error');
        }
      });

      body.appendChild(form);
    });
  }

  el('maskBtn').addEventListener('click', () => {
    ctx.state.masked = !ctx.state.masked;
    localStorage.setItem('finance_masked', ctx.state.masked ? '1' : '0');
    updateSecurityButtons(ctx);
    ctx.renderAll();
    showToast(ctx.state.masked ? '已開啟金額隱私遮罩' : '已顯示實際金額');
  });

  el('securityBtn').addEventListener('click', () => openSecurityModal(ctx));
  el('lockNowBtn').addEventListener('click', () => openLockScreen(ctx, '已手動上鎖'));
  el('lockFaceIdBtn').addEventListener('click', () => void unlockLockScreenWithFaceId(ctx));
  el('lockUsePasswordBtn').addEventListener('click', () => {
    closeLockScreen(ctx);
    openAuthScreen(ctx, 'login', '請輸入主密碼驗證解鎖', () => {
      void ctx.engine.syncNow();
    });
  });

  // Modal backdrop close (mobile closes on tap; desktop shakes to prevent accidental data loss)
  el('closeModalBtn').addEventListener('click', closeModal);
  el('modalBackdrop').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id !== 'modalBackdrop') return;
    if (isDesktopDevice()) {
      const sheet = el('modalSheet');
      sheet.classList.remove('shake');
      void sheet.offsetWidth;
      sheet.classList.add('shake');
      showToast('電腦版防誤觸：請點右上角「✕」關閉');
    } else {
      closeModal();
    }
  });

  // PIN keypad & desktop keyboard support
  el('pinPad').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.pin-key');
    if (btn?.dataset.k) void triggerPinKey(ctx, btn.dataset.k);
  });
  window.addEventListener('keydown', (e) => {
    if (!el('lockScreen').classList.contains('open')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      void triggerPinKey(ctx, e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      void triggerPinKey(ctx, 'del');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void triggerPinKey(ctx, 'go');
    }
  });

  // Tab 1 live savings strip toggle
  el('savingsStripToggle').addEventListener('click', () => {
    ctx.state.savingsExpanded = !ctx.state.savingsExpanded;
    renderLogTab(ctx);
  });

  // Tab 1 subtabs & ledger modes
  const switchLogSubtab = (sub: 'entry' | 'ledger') => {
    ctx.state.logSubtab = sub;
    document.querySelectorAll<HTMLButtonElement>('#logSubtabBar .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.logSub === sub);
    });
    // v2.2.0: in the 簡潔版 the form lives in the 記一筆 sheet and is always shown there
    el('expenseForm').style.display = sub === 'entry' || getCurrentUiVariant() === 'simple' ? '' : 'none';
    el('ledgerPanel').style.display = sub === 'ledger' ? 'flex' : 'none';
  };
  document.querySelectorAll<HTMLButtonElement>('#logSubtabBar .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchLogSubtab(btn.dataset.logSub as 'entry' | 'ledger'));
  });

  document.querySelectorAll<HTMLButtonElement>('#ledgerModeToggle .mini-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      ctx.state.ledgerMode = btn.dataset.ledgerMode as 'list' | 'calendar';
      renderLogTab(ctx);
    });
  });

  bindLedgerSearchEvents(ctx);
  bindQuickTemplatesAndAutocompleteEvents(ctx);

  document.getElementById('openSplitExpenseBtn')?.addEventListener('click', () => {
    openCreateSplitModal(ctx);
  });

  const shiftMonth = (delta: number) => {
    let y = ctx.state.selectedYear;
    let m = ctx.state.selectedMonth + delta;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    ctx.state.selectedYear = y;
    ctx.state.selectedMonth = m;
    ctx.state.ledgerPage = 1;
    ctx.renderAll(); // 0ms 純本機切換！
  };
  el('ledgerPrevMonthBtn').addEventListener('click', () => shiftMonth(-1));
  el('ledgerNextMonthBtn').addEventListener('click', () => shiftMonth(1));
  el('prevMonthBtn').addEventListener('click', () => shiftMonth(-1));
  el('nextMonthBtn').addEventListener('click', () => shiftMonth(1));

  el('prevPageBtn').addEventListener('click', () => {
    if (ctx.state.ledgerPage > 1) { ctx.state.ledgerPage--; renderLogTab(ctx); }
  });
  el('nextPageBtn').addEventListener('click', () => {
    ctx.state.ledgerPage++; renderLogTab(ctx);
  });
  el('calQuickAddBtn').addEventListener('click', () => {
    if (ctx.state.selectedCalendarDay) {
      el<HTMLInputElement>('dateInput').value = ctx.state.selectedCalendarDay;
      updateSavingsPreview(ctx);
    }
    if (getCurrentUiVariant() === 'simple') ctx.openQuickAdd();
    else switchLogSubtab('entry');
    showToast(`已帶入日期 ${ctx.state.selectedCalendarDay}`);
  });

  // Expense form
  document.querySelectorAll<HTMLButtonElement>('#logTypeChips .chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#logTypeChips .chip-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ctx.state.logType = btn.dataset.type || '日常花費';
      renderLogCategories(ctx);
      updateSavingsPreview(ctx);
      const show = RECURRING_ELIGIBLE_LOG.includes(ctx.state.logType);
      el('recurringToggleBox').style.display = show ? 'flex' : 'none';
      if (!show) el<HTMLInputElement>('makeRecurringCheckbox').checked = false;
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.curr-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.curr-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ctx.state.logCurrency = btn.dataset.curr || 'TWD';
      updateFxPreview(ctx);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inp = el<HTMLInputElement>('amountInput');
      inp.value = String((parseFloat(inp.value) || 0) + parseFloat(btn.dataset.add || '0'));
      updateFxPreview(ctx);
    });
  });
  el('amountInput').addEventListener('input', () => updateFxPreview(ctx));
  el('dateInput').addEventListener('change', () => updateSavingsPreview(ctx));

  bindSubmit(el('expenseForm'), async (e) => {
    e.preventDefault();
    const amount = parseFloat(el<HTMLInputElement>('amountInput').value);
    const date = el<HTMLInputElement>('dateInput').value;
    if (!date || Number.isNaN(amount) || amount <= 0) {
      showToast('請確認日期與大於 0 的金額', 'error');
      return;
    }
    try {
      const makeRecurring = el<HTMLInputElement>('makeRecurringCheckbox').checked;
      const linkedAccountId = ctx.state.logLinkedAccountId;
      const created = await ctx.engine.addCashFlow({
        date,
        type: ctx.state.logType,
        category: ctx.state.logCategory,
        itemName: el<HTMLInputElement>('itemNameInput').value.trim() || ctx.state.logCategory,
        amount,
        currency: ctx.state.logCurrency,
        note: el<HTMLInputElement>('noteInput').value.trim(),
        linkedAccountId,
        ledgerId: ctx.state.activeLedgerId,
        makeRecurring,
      });
      el<HTMLInputElement>('amountInput').value = '';
      el<HTMLInputElement>('itemNameInput').value = '';
      el<HTMLInputElement>('noteInput').value = '';
      el<HTMLInputElement>('makeRecurringCheckbox').checked = false;
      closeAutocompleteDropdown();
      updateFxPreview(ctx);

      let savingsSuffix = '';
      if (linkedAccountId) {
        const snap = ctx.engine.getSnapshot();
        const sav = computeAllSavingsSummary(
          snap.assetItems,
          snap.cashflowLogs,
          snap.savingsAdjustments || [],
          snap.settings,
          ctx.state.activeLedgerId
        );
        const acc = sav.accounts.find((a) => a.account.id === linkedAccountId);
        if (acc) {
          savingsSuffix = `｜${acc.account.itemName} 剩 ${fmtMoney(acc.currentBalanceTwd, ctx.state.masked)}`;
        } else {
          const cc = computeAllCreditCardsSummary(
            snap.assetItems,
            snap.cashflowLogs,
            snap.savingsAdjustments || [],
            snap.installmentPlans || [],
            snap.settings,
            ctx.state.activeLedgerId
          );
          const cardSum = cc.cards.find((c) => c.card.id === linkedAccountId);
          if (cardSum) {
            savingsSuffix = `｜💳 ${cardSum.card.itemName} 未繳 ${fmtMoney(cardSum.currentBalanceTwd, ctx.state.masked)}`;
          }
        }
      }

      showToast(
        `已記帳：${created.itemName} (${fmtMoney(created.twdAmount, ctx.state.masked)})${savingsSuffix}${makeRecurring ? ' + 已加入每月固定' : ''}`,
        'success'
      );
      el('expenseForm').dispatchEvent(new CustomEvent('finance:entry-saved'));
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '寫入失敗', 'error');
    }
  });

  // Tab 2 Overview events
  el('overviewHelpBtn').addEventListener('click', () => openHelpGuideModal('savings'));

  document.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-period]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ctx.state.overviewPeriod = btn.dataset.period as 'monthly' | 'yearly';
      renderOverviewTab(ctx);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('#chartMetricPills .chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#chartMetricPills .chip-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ctx.state.chartMetric = btn.dataset.metric as AppUiState['chartMetric'];
      renderTrendChart(ctx);
    });
  });

  bindSubmit(el('budgetForm'), async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.saveBudgetSettings(
        parseFloat(el<HTMLInputElement>('budgetInput').value),
        parseInt(el<HTMLInputElement>('emergencyInput').value, 10)
      );
      showToast('已更新預算與預備金參數', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  // Tab 5 Tools 3-way subtab events (固定收支 / 大額攤提 / 水電分攤)
  document.querySelectorAll<HTMLButtonElement>('#toolsSubtabBar [data-tools-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.toolsSub as AppUiState['toolsSubtab'];
      if (ctx.state.reorderSection) cancelReorder(ctx);
      ctx.state.toolsSubtab = sub;
      document.querySelectorAll('#toolsSubtabBar [data-tools-sub]').forEach((b) => b.classList.toggle('active', b === btn));
      el('subtab-recurring').style.display = sub === 'recurring' ? 'flex' : 'none';
      el('subtab-sinking').style.display = sub === 'sinking' ? 'flex' : 'none';
      el('subtab-utility').style.display = sub === 'utility' ? 'flex' : 'none';
    });
  });

  document.querySelectorAll<HTMLButtonElement>('#recurringFilterPills .chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (ctx.state.reorderSection === 'recurring') cancelReorder(ctx, true);
      document.querySelectorAll('#recurringFilterPills .chip-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ctx.state.recurringFilter = btn.dataset.filter as AppUiState['recurringFilter'];
      renderConfigTab(ctx);
    });
  });

  el('addRecurringBtn').addEventListener('click', () => openRecurringModal(ctx, null));
  el('addSinkingBtn').addEventListener('click', () => openSinkingModal(ctx, null));
  el('reorderRecurringBtn').addEventListener('click', () => {
    startReorder(
      ctx,
      'recurring',
      getFilteredRecurringItems(ctx).map((i) => i.id)
    );
  });
  el('reorderSinkingBtn').addEventListener('click', () => {
    startReorder(
      ctx,
      'sinking',
      getActiveSinkingItems(ctx).map((i) => i.id)
    );
  });

  el('runRecurringBtn').addEventListener('click', async () => {
    const ym = `${ctx.state.selectedYear}-${String(ctx.state.selectedMonth).padStart(2, '0')}`;
    if (!confirm(`確定執行 ${ym} 的常態收支自動入帳？（已存在項目自動略過）`)) return;
    setLoading(true);
    try {
      await ctx.engine.syncNow();
      const res = await fetch('/api/automation/recurring', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ year: ctx.state.selectedYear, month: ctx.state.selectedMonth }),
      });
      const json = (await res.json()) as { insertedCount?: number; skippedCount?: number; error?: string };
      if (!res.ok) throw new Error(json.error || '入帳失敗');
      await ctx.engine.syncNow();
      showToast(`${ym} 入帳完成：新增 ${json.insertedCount} 筆，略過 ${json.skippedCount} 筆`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '請於連線狀態下執行', 'error');
    } finally {
      setLoading(false);
    }
  });

  const refreshMarketAction = async () => {
    setLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (ctx.state.currentUser?.id) headers['x-expected-user'] = ctx.state.currentUser.id;
      const res = await fetch('/api/market/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
      });
      const json = (await res.json()) as {
        usdTwdRate?: number;
        updatedTickers?: unknown[];
        failedTickers?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || '行情更新失敗');
      await ctx.engine.syncNow();
      const updatedCount = json.updatedTickers?.length || 0;
      const failed = Array.isArray(json.failedTickers) ? json.failedTickers : [];
      if (failed.length > 0) {
        showToast(
          `匯率 ${json.usdTwdRate}｜已更新 ${updatedCount} 檔（未取得：${failed.join('、')}）`,
          updatedCount > 0 ? 'success' : 'error'
        );
      } else {
        showToast(`匯率 ${json.usdTwdRate}｜已更新 ${updatedCount} 檔台美股價`, 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '行情更新需要網路連線', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Tab 3 Assets events
  document.querySelectorAll<HTMLButtonElement>('#allocModeToggle .mini-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.state.allocMode = btn.dataset.allocMode as 'both' | 'pct' | 'amt';
      localStorage.setItem('finance_alloc_mode', ctx.state.allocMode);
      renderAssetsTab(ctx);
    });
  });

  el('addSavingsBtn').addEventListener('click', () => openSavingsAccountModal(ctx, null));
  el('addAssetBtn').addEventListener('click', () => openAssetModal(ctx, null));
  el('transferAccountBtn').addEventListener('click', () => openAccountTransferModal(ctx));
  el('refreshMarketBtn').addEventListener('click', () => void refreshMarketAction());
  el('reorderSavingsBtn').addEventListener('click', () => {
    startReorder(ctx, 'assets_savings', getAssetSectionIds(ctx, 'assets_savings'));
  });
  el('reorderAutoAssetsBtn').addEventListener('click', () => {
    startReorder(ctx, 'assets_auto', getAssetSectionIds(ctx, 'assets_auto'));
  });
  el('reorderManualAssetsBtn').addEventListener('click', () => {
    startReorder(ctx, 'assets_manual', getAssetSectionIds(ctx, 'assets_manual'));
  });

  el('runSnapshotBtn').addEventListener('click', async () => {
    if (!confirm('確定立即將目前資產負債總計寫入本月歷史快照？')) return;
    setLoading(true);
    try {
      await ctx.engine.syncNow();
      const res = await fetch('/api/automation/snapshot', { method: 'POST', credentials: 'same-origin' });
      const json = (await res.json()) as { yearMonth?: string; netWorth?: number; error?: string };
      if (!res.ok) throw new Error(json.error || '快照失敗');
      await ctx.engine.syncNow();
      showToast(`${json.yearMonth} 淨資產快照完成：NT$ ${(json.netWorth || 0).toLocaleString()}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '建立快照需要網路連線', 'error');
    } finally {
      setLoading(false);
    }
  });

  // Tab 4 Stocks events
  document.querySelectorAll<HTMLButtonElement>('#stockViewModeToggle .mini-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.state.stockPriceViewMode = btn.dataset.stockView === 'total' ? 'total' : 'unit';
      localStorage.setItem('finance_stock_view_mode', ctx.state.stockPriceViewMode);
      renderStocksTab(ctx);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('#stocksSubtabBar [data-stocks-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextSub = btn.dataset.stocksSub === 'watchlist' ? 'watchlist' : 'holdings';
      if (ctx.state.reorderSection === 'stocks' || ctx.state.reorderSection === 'watchlist') {
        cancelReorder(ctx, true);
      }
      ctx.state.stocksSubtab = nextSub;
      renderStocksTab(ctx);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('#stockCardModeToggle .mini-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.state.stockCardDisplayMode = btn.dataset.cardMode === 'flip' ? 'flip' : 'list';
      localStorage.setItem('finance_stock_card_mode', ctx.state.stockCardDisplayMode);
      renderStocksTab(ctx);
    });
  });
  el('addStockBtn').addEventListener('click', () => {
    if (ctx.state.stocksSubtab === 'watchlist') {
      openWatchlistModal(ctx, null);
    } else {
      openStockBaselineModal(ctx, null);
    }
  });
  el('stocksRefreshMarketBtn').addEventListener('click', () => void refreshMarketAction());
  el('reorderStocksBtn').addEventListener('click', () => {
    if (ctx.state.stocksSubtab === 'watchlist') {
      startReorder(ctx, 'watchlist', getOrderedWatchlistIds(ctx));
    } else {
      startReorder(ctx, 'stocks', getOrderedStockIds(ctx));
    }
  });

  // Tab 5 Utility subtab events
  bindUtilityTabEvents(ctx);

  // Global non-disruptive floating mini calculator
  initFloatingCalculator();

  // iOS PWA Auto-Sync on reconnect / return to foreground + Idle Auto-Lock
  const checkIdle = () => {
    if (ctx.state.idleMinutes <= 0) return;
    if (el('lockScreen').classList.contains('open')) return;
    if (Date.now() - ctx.state.lastActivityAt < ctx.state.idleMinutes * 60 * 1000) return;

    el('calcBackdrop').classList.remove('open');
    el('calcFabBtn').classList.remove('is-open');
    closeModal();
    if (isAnyLockEnabled(ctx)) {
      openLockScreen(ctx, `閒置超過 ${ctx.state.idleMinutes} 分鐘，已自動鎖定`);
    } else if (!ctx.state.masked) {
      ctx.state.masked = true;
      updateSecurityButtons(ctx);
      ctx.renderAll();
    }
  };

  const touchActivity = () => {
    ctx.state.lastActivityAt = Date.now();
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, touchActivity, { passive: true });
  });

  window.addEventListener('online', () => {
    showToast('網路已恢復，正在背景同步...', 'success');
    void ctx.engine.syncNow();
  });
  window.addEventListener('offline', () => {
    renderSyncPill({
      ...ctx.engine.getStatus(),
      state: 'offline',
    });
  });
  const BACKGROUND_LOCK_GRACE_MS = 30_000;
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    // M11: when the app goes to the background, conceal it at once (the OS app-switcher snapshot must not show
    // balances) but only lock if it stays away for a while — a quick switch to copy an OTP or a file picker
    // must not discard the open form or force an unlock.
    if (document.visibilityState === 'hidden') {
      if (isAnyLockEnabled(ctx)) {
        hiddenAt = Date.now();
        document.body.classList.add('app-backgrounded');
      }
      return;
    }
    if (document.visibilityState === 'visible') {
      const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      document.body.classList.remove('app-backgrounded');
      if (
        awayMs > BACKGROUND_LOCK_GRACE_MS &&
        isAnyLockEnabled(ctx) &&
        !el('lockScreen').classList.contains('open') &&
        !el('authScreen').classList.contains('open')
      ) {
        openLockScreen(ctx, '已自動鎖定');
      }
      checkIdle();
      if (navigator.onLine) {
        void ctx.engine.syncNow();
      }
    }
  });
  window.setInterval(checkIdle, 15000);
}

void bootstrap();
