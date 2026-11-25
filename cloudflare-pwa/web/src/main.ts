import './styles.css';
import { computeAllSavingsSummary } from '../../shared/calculations';
import type { PnlColorScheme } from '../../shared/types';
import { normalizePnlColorScheme } from '../../shared/validation';
import { LocalFinanceDB } from './db/localDb';
import { SyncEngine, type SyncStatus } from './sync/syncEngine';
import { fetchAuthStatus, getRememberedAccount, saveRememberedAccount } from './auth/authClient';
import { closeModal, el, fmtMoney, isDesktopDevice, setLoading, showToast } from './ui/helpers';
import {
  getTodayYmd,
  renderLogCategories,
  renderLogTab,
  updateFxPreview,
  updateSavingsPreview,
} from './ui/logTab';
import { renderOverviewTab, renderTrendChart } from './ui/overviewTab';
import {
  getActiveSinkingItems,
  getFilteredRecurringItems,
  openRecurringModal,
  openSinkingModal,
  renderConfigTab,
} from './ui/configTab';
import { getAssetSectionIds, openAssetModal, openSavingsAccountModal, renderAssetsTab } from './ui/assetsTab';
import { getOrderedStockIds, openStockBaselineModal, renderStocksTab } from './ui/stocksTab';
import { bindUtilityTabEvents, renderUtilityTab } from './ui/utilityTab';
import { cancelReorder, startReorder } from './ui/reorderHelper';
import {
  closeLockScreen,
  isAnyLockEnabled,
  openAuthScreen,
  openLockScreen,
  openSecurityModal,
  triggerPinKey,
  unlockLockScreenWithFaceId,
  updateSecurityButtons,
} from './ui/securityUi';
import { initBottomNavScrub } from './ui/tabBarScrub';
import { openConflictsModal } from './ui/conflictUi';
import { openHelpGuideModal } from './ui/helpGuideUi';
import type { AppUiState, StockChartDimension, StockChartType, UiContext } from './ui/state';

const RECURRING_ELIGIBLE_LOG = ['其他收入', '投資流出', '固定支出'];

function registerServiceWorker(): void {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Ignore registration errors in unsupported dev contexts
      });
    });
  }
}

function renderSyncPill(status: SyncStatus): void {
  const pill = el('syncStatusPill');
  pill.className = `sync-pill ${status.state}`;
  if (status.state === 'conflict') {
    pill.textContent = `⚠ 衝突 (${status.conflictCount || 1})`;
    pill.title = '偵測到離線與雲端版本衝突，點擊選擇保留版本';
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

async function bootstrap(): Promise<void> {
  registerServiceWorker();

  const storedIdle = localStorage.getItem('finance_idle_minutes');
  const parsedIdle = storedIdle !== null && !Number.isNaN(Number(storedIdle)) ? Number(storedIdle) : 5;
  const storedAlloc = localStorage.getItem('finance_alloc_mode');
  const storedStockView = localStorage.getItem('finance_stock_view_mode');
  const storedChartType = localStorage.getItem('finance_stock_chart_type');
  const storedChartDim = localStorage.getItem('finance_stock_chart_dim');
  const storedPnlScheme = normalizePnlColorScheme(localStorage.getItem('finance_pnl_scheme'));
  const remembered = getRememberedAccount();
  const now = new Date();

  document.documentElement.dataset.pnlScheme = storedPnlScheme;

  const urlParams = new URLSearchParams(window.location.search);
  const inviteParam = (urlParams.get('invite') || '').trim();
  const resetParam = (urlParams.get('reset') || '').trim();
  const userParam = (urlParams.get('user') || '').trim();

  const validChartType: StockChartType =
    storedChartType === 'pie' || storedChartType === 'hbar' || storedChartType === 'treemap'
      ? storedChartType
      : 'donut';
  const validChartDim: StockChartDimension =
    storedChartDim === 'category' || storedChartDim === 'cost' || storedChartDim === 'market'
      ? storedChartDim
      : 'value';

  const state: AppUiState = {
    masked: localStorage.getItem('finance_masked') === '1',
    activeTab: 'log',
    logSubtab: 'entry',
    ledgerMode: 'list',
    ledgerPage: 1,
    pageSize: 10,
    selectedCalendarDay: getTodayYmd(),
    overviewPeriod: 'monthly',
    overviewExpandedGroups: [],
    chartMetric: 'netCashFlow',
    toolsSubtab: 'recurring',
    recurringFilter: 'all',
    allocMode: storedAlloc === 'pct' || storedAlloc === 'amt' ? storedAlloc : 'both',
    allocHighlight: null,
    stockPriceViewMode: storedStockView === 'total' ? 'total' : 'unit',
    stockChartType: validChartType,
    stockChartDimension: validChartDim,
    stockChartHighlight: null,
    pnlColorScheme: storedPnlScheme,
    reorderSection: null,
    reorderDraftIds: [],
    selectedYear: now.getFullYear(),
    selectedMonth: now.getMonth() + 1,
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

  const createSyncEngineForDb = (db: LocalFinanceDB): SyncEngine =>
    new SyncEngine(db, {
      onStatusChange: (status) => renderSyncPill(status),
      onSnapshotChange: () => ctx.renderAll(),
      onAuthRequired: () => {
        ctx.state.authenticated = false;
        openAuthScreen(ctx, 'login', '登入憑證已過期，重新登入後將自動上傳待同步帳目', () => {
          void ctx.engine.syncNow();
        });
      },
    });

  const applyPnlSchemeDom = (scheme: PnlColorScheme) => {
    const normalized = normalizePnlColorScheme(scheme);
    state.pnlColorScheme = normalized;
    document.documentElement.dataset.pnlScheme = normalized;
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
      el('fxTopPill').textContent = `USD ${Number(snap.settings.usdTwdRate || 32.5).toFixed(2)}`;
      renderLogTab(ctx);
      renderOverviewTab(ctx);
      renderAssetsTab(ctx);
      renderStocksTab(ctx);
      renderConfigTab(ctx);
      renderUtilityTab(ctx);
    },
    scheduleSync: () => {
      window.clearTimeout(syncDebounce);
      syncDebounce = window.setTimeout(() => {
        void ctx.engine.syncNow();
      }, 300);
    },
    navigateToTab: () => {},
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
      ctx.state.currentUser = user;
      cancelReorder(ctx, true);
      saveRememberedAccount(user);
      const nextDbName = LocalFinanceDB.dbNameForUser(user.id);
      if (activeDb.getDbName() !== nextDbName) {
        activeDb.close();
        activeDb = new LocalFinanceDB(nextDbName);
        const nextEngine = createSyncEngineForDb(activeDb);
        ctx.engine = nextEngine;
        await nextEngine.init();
        const nextMeta = nextEngine.getMeta();
        state.pinEnabled = nextMeta.pinEnabled;
        state.pinSalt = nextMeta.pinSalt;
        state.pinHash = nextMeta.pinHash;
        state.passkeys = nextMeta.passkeys || [];
        state.passkeyCount = state.passkeys.length;
        state.biometricLockEnabled = Boolean(nextMeta.biometricLockEnabled);
      }
      ctx.applyUtilityTabVisibility();
      ctx.renderAll();
    },
  };

  ctx.engine = createSyncEngineForDb(activeDb);

  // 1. 0ms 立即從該帳號專屬的本機 IndexedDB 載入畫面（離線也能秒開）
  await ctx.engine.init();
  const meta = ctx.engine.getMeta();
  state.pinEnabled = meta.pinEnabled;
  state.pinSalt = meta.pinSalt;
  state.pinHash = meta.pinHash;
  state.passkeys = meta.passkeys || [];
  state.passkeyCount = state.passkeys.length;
  state.biometricLockEnabled = Boolean(meta.biometricLockEnabled);

  el<HTMLInputElement>('dateInput').value = getTodayYmd();
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

  // 2. 背景檢查雲端登入狀態並自動同步
  if (navigator.onLine) {
    try {
      const auth = await fetchAuthStatus();
      state.initialized = auth.initialized;
      state.authenticated = auth.authenticated;
      if (auth.authenticated && auth.user) {
        await ctx.switchAccountDb(auth.user);
        state.pinEnabled = Boolean(auth.pinEnabled);
        state.pinSalt = auth.pinSalt || null;
        state.pinHash = auth.pinHash || null;
        state.passkeys = auth.passkeys || [];
        state.passkeyCount = auth.passkeyCount || 0;
        await ctx.engine.updateLocalPinCache(state.pinEnabled, state.pinSalt, state.pinHash);
        await ctx.engine.updateLocalBiometricCache(state.biometricLockEnabled, state.passkeys);
        updateSecurityButtons(ctx);
        if (!isAnyLockEnabled(ctx)) {
          closeLockScreen(ctx);
        }
        void ctx.engine.syncNow();
      } else if (!auth.initialized) {
        state.pinEnabled = false;
        state.pinSalt = null;
        state.pinHash = null;
        state.biometricLockEnabled = false;
        state.passkeys = [];
        await ctx.engine.updateLocalPinCache(false, null, null);
        await ctx.engine.updateLocalBiometricCache(false, []);
        updateSecurityButtons(ctx);
        closeLockScreen(ctx);
        openAuthScreen(ctx, 'setup', '', () => void ctx.engine.syncNow(true));
      } else if (!meta.lastSyncedAt) {
        // 首次使用無本機快取時要求登入
        closeLockScreen(ctx);
        openAuthScreen(ctx, 'login', '', () => void ctx.engine.syncNow(true));
      }
    } catch {
      // 離線或伺服器暫時無法連線，維持本機模式運作
    }
  }
}

function bindEvents(ctx: UiContext): void {
  // Bottom Nav (支援點擊切換 ＋ 按住左右滑動高亮膠囊、放開切換分頁)
  const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#bottomNav .nav-btn'));
  const tabOrder: Array<AppUiState['activeTab']> = ['log', 'overview', 'assets', 'stocks', 'tools'];

  const activateTabByIndex = (idx: number) => {
    const safeIdx = Math.max(0, Math.min(navButtons.length - 1, idx));
    const btn = navButtons[safeIdx];
    const tab = (btn.dataset.tab as AppUiState['activeTab']) || tabOrder[safeIdx];
    if (ctx.state.activeTab !== tab && ctx.state.reorderSection) {
      cancelReorder(ctx);
    }
    ctx.state.activeTab = tab;
    navButtons.forEach((b, i) => b.classList.toggle('active', i === safeIdx));
    document.querySelectorAll('.tab-view').forEach((v) => v.classList.toggle('active', v.id === 'tab-' + tab));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const navScrub = initBottomNavScrub({
    navEl: el('bottomNav'),
    buttons: navButtons,
    pillEl: el('navPill'),
    getActiveIndex: () => Math.max(0, tabOrder.indexOf(ctx.state.activeTab)),
    onSelectIndex: (idx) => activateTabByIndex(idx),
  });

  ctx.navigateToTab = (tab) => {
    const idx = Math.max(0, tabOrder.indexOf(tab));
    activateTabByIndex(idx);
    navScrub.syncPill(false);
  };

  navButtons.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      activateTabByIndex(idx);
      navScrub.syncPill(false);
    });
  });

  // Topbar actions
  el('syncStatusPill').addEventListener('click', async () => {
    if (ctx.engine.getConflicts().length > 0) {
      openConflictsModal(ctx);
      return;
    }
    if (ctx.engine.getStatus().state === 'auth_required') {
      openAuthScreen(ctx, 'login', '請重新登入以同步資料', () => void ctx.engine.syncNow());
      return;
    }
    const res = await ctx.engine.syncNow();
    if (ctx.engine.getConflicts().length > 0) {
      showToast(`偵測到 ${ctx.engine.getConflicts().length} 筆離線版本衝突，請選擇保留版本`, 'error');
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
    el('expenseForm').style.display = sub === 'entry' ? '' : 'none';
    el('ledgerPanel').style.display = sub === 'ledger' ? 'flex' : 'none';
  };
  document.querySelectorAll<HTMLButtonElement>('#logSubtabBar .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchLogSubtab(btn.dataset.logSub as 'entry' | 'ledger'));
  });

  document.querySelectorAll<HTMLButtonElement>('#ledgerModeToggle .mini-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.state.ledgerMode = btn.dataset.ledgerMode as 'list' | 'calendar';
      document.querySelectorAll('#ledgerModeToggle .mini-seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      el('ledgerListMode').style.display = ctx.state.ledgerMode === 'list' ? 'flex' : 'none';
      el('ledgerCalendarMode').style.display = ctx.state.ledgerMode === 'calendar' ? 'flex' : 'none';
    });
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
    switchLogSubtab('entry');
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

  el('expenseForm').addEventListener('submit', async (e) => {
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
        makeRecurring,
      });
      el<HTMLInputElement>('amountInput').value = '';
      el<HTMLInputElement>('itemNameInput').value = '';
      el<HTMLInputElement>('noteInput').value = '';
      el<HTMLInputElement>('makeRecurringCheckbox').checked = false;
      updateFxPreview(ctx);

      let savingsSuffix = '';
      if (linkedAccountId) {
        const snap = ctx.engine.getSnapshot();
        const sav = computeAllSavingsSummary(
          snap.assetItems,
          snap.cashflowLogs,
          snap.savingsAdjustments || [],
          snap.settings.usdTwdRate
        );
        const acc = sav.accounts.find((a) => a.account.id === linkedAccountId);
        if (acc) {
          savingsSuffix = `｜${acc.account.itemName} 剩 ${fmtMoney(acc.currentBalanceTwd, ctx.state.masked)}`;
        }
      }

      showToast(
        `已記帳：${created.itemName} (${fmtMoney(created.twdAmount, ctx.state.masked)})${savingsSuffix}${makeRecurring ? ' + 已加入每月固定' : ''}`,
        'success'
      );
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

  el('budgetForm').addEventListener('submit', async (e) => {
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

  // Tab 5 Tools 3-way subtab events (固定收支 / 稅金分攤 / 水電分攤)
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
      const res = await fetch('/api/market/refresh', { method: 'POST', credentials: 'same-origin' });
      const json = (await res.json()) as {
        usdTwdRate?: number;
        updatedTickers?: unknown[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || '行情更新失敗');
      await ctx.engine.syncNow();
      showToast(`匯率 ${json.usdTwdRate}｜已更新 ${json.updatedTickers?.length || 0} 檔股價`, 'success');
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
  el('addStockBtn').addEventListener('click', () => openStockBaselineModal(ctx, null));
  el('stocksRefreshMarketBtn').addEventListener('click', () => void refreshMarketAction());
  el('reorderStocksBtn').addEventListener('click', () => {
    startReorder(ctx, 'stocks', getOrderedStockIds(ctx));
  });

  // Tab 5 Utility subtab events
  bindUtilityTabEvents(ctx);

  // iOS PWA Auto-Sync on reconnect / return to foreground + Idle Auto-Lock
  const checkIdle = () => {
    if (ctx.state.idleMinutes <= 0) return;
    if (el('lockScreen').classList.contains('open')) return;
    if (Date.now() - ctx.state.lastActivityAt < ctx.state.idleMinutes * 60 * 1000) return;

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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkIdle();
      if (navigator.onLine) {
        void ctx.engine.syncNow();
      }
    }
  });
  window.setInterval(checkIdle, 15000);
}

void bootstrap();
