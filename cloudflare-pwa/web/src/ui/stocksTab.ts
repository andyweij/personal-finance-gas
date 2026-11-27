import { todayInTimeZone } from '../../../shared/dates';
import { roundTo } from '../../../shared/format';
import { CASHFLOW_TYPES, DEFAULT_STOCK_CATEGORIES, STOCK_TX_TYPES } from '../../../shared/constants';
import {
  computeAllSavingsSummary,
  computeStockPortfolioSummary,
  computeStockPositionSummary,
  computeWatchlistSummary,
} from '../../../shared/calculations';
import type {
  AssetItem,
  StockPositionSummary,
  StockTransaction,
  WatchlistItemSummary,
} from '../../../shared/types';
import { normalizeStockCategory, resolveStockModalPriceFields } from '../../../shared/validation';
import {
  closeModal,
  el,
  fmtMoney,
  fmtNum,
  makeInputField,
  makeSelectField,
  openModal,
  showToast,
  TRASH_SVG, fmtPct, bindSubmit } from './helpers';
import { renderDividendCalendarCard } from './dividendCalendarUi';
import { renderRebalanceCard } from './rebalanceUi';
import { renderReorderList } from './reorderHelper';
import { renderStockChartCard } from './stockCharts';
import type { UiContext } from './state';

/**
 * Q8 / F5: Right after a ticker replacement (or creating an auto-updated holding / watchlist item without a price),
 * push the edit to the server and fetch a quote for THAT asset only, so the holding never sits at price 0 until the
 * next scheduled run (or gets recorded as 0 by a month-end snapshot). Best-effort: offline / failures simply leave
 * the "報價待更新" state for the next scheduled or manual refresh.
 */
async function refreshQuoteForAsset(ctx: UiContext, assetId: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    await ctx.engine.syncNow();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ctx.state.currentUser?.id) headers['x-expected-user'] = ctx.state.currentUser.id;
    const res = await fetch('/api/market/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ assetIds: [assetId] }),
    });
    if (!res.ok) return;
    const json = (await res.json().catch(() => ({}))) as { updatedTickers?: unknown[] };
    await ctx.engine.syncNow();
    if ((json.updatedTickers?.length || 0) > 0) {
      showToast('已取得最新報價', 'success');
    }
  } catch {
    // Leave "報價待更新" for the next scheduled / manual refresh
  }
}

function needsImmediateQuote(asset: AssetItem): boolean {
  return asset.updateMode === '自動更新' && Boolean((asset.ticker || '').trim()) && !asset.priceUpdatedAt;
}

export function getAllStockCategories(ctx: UiContext): string[] {
  const snap = ctx.engine.getSnapshot();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const cleaned = normalizeStockCategory(raw);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  for (const d of DEFAULT_STOCK_CATEGORIES) push(d);
  for (const c of snap.settings.customStockCategories || []) push(c);
  for (const a of snap.assetItems) {
    if (!a.deletedAt && a.stockCategory) push(a.stockCategory);
  }
  return out;
}

export function getOrderedStockIds(ctx: UiContext): string[] {
  const snap = ctx.engine.getSnapshot();
  const portfolio = computeStockPortfolioSummary(
    snap.assetItems,
    snap.stockTransactions || [],
    snap.settings.usdTwdRate || 32.5
  );
  return portfolio.positions.map((p) => p.asset.id);
}

export function getOrderedWatchlistIds(ctx: UiContext): string[] {
  const snap = ctx.engine.getSnapshot();
  return computeWatchlistSummary(snap.assetItems).items.map((w) => w.asset.id);
}

function todayYmdLocal(): string {
  return todayInTimeZone(); // v1.8.15: "today" is the APP_TIMEZONE date, like the server
}

export function fmtQuoteTimestamp(iso?: string | null): string {
  if (!iso) return '尚未更新';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '尚未更新';
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin >= 0 && diffMin < 1) return `剛剛 (${hm})`;
  if (diffMin >= 1 && diffMin < 60) return `${diffMin} 分鐘前 (${hm})`;
  if (isToday) return `今日 ${hm}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
}

function fmtPrice(n: number, masked: boolean, currency = 'TWD'): string {
  if (masked) return '•••';
  const num = Number(n || 0);
  const prefix = currency === 'USD' ? 'US$' : '';
  return prefix + num.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCurrencyAmount(n: number, currency: string, masked: boolean): string {
  if (masked) return (currency === 'USD' ? 'US$' : 'NT$ ') + '•••••';
  // v1.8.15: sign of the value as displayed (cents for USD, whole dollars for TWD)
  const num = roundTo(Number(n || 0), currency === 'USD' ? 2 : 0);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (currency === 'USD') {
    return `${sign}US$${abs.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}NT$ ${Math.round(abs).toLocaleString('zh-TW')}`;
}

function fmtSignedCurrency(n: number, currency: string, masked: boolean): string {
  if (masked) return '•••••';
  const num = roundTo(Number(n || 0), currency === 'USD' ? 2 : 0);
  if (num > 0) return '+' + fmtCurrencyAmount(num, currency, false);
  if (num < 0) return fmtCurrencyAmount(num, currency, false);
  return fmtCurrencyAmount(0, currency, false);
}

function fmtSignedPct(pct: number, masked: boolean, decimals = 1): string {
  if (masked) return '••%';
  return fmtPct(Number(pct || 0), decimals, true); // v1.8.15: never "-0.0%"
}

function fmtShares(shares: number): string {
  return Number(shares || 0).toLocaleString('zh-TW', { maximumFractionDigits: 4 });
}

function createDailyChangeBadge(
  dailyChange: number | null,
  dailyChangePct: number | null,
  currency: string,
  masked: boolean,
  compact = false
): HTMLSpanElement {
  const pill = document.createElement('span');
  if (dailyChange === null || dailyChangePct === null) {
    pill.className = 'daily-change-pill flat tnum';
    pill.textContent = '昨收待更新';
    return pill;
  }
  const dirCls = dailyChange > 0 ? 'pos' : dailyChange < 0 ? 'neg' : 'flat';
  pill.className = `daily-change-pill ${dirCls} tnum`;
  if (masked) {
    pill.textContent = dailyChange > 0 ? '▲ ••%' : dailyChange < 0 ? '▼ ••%' : '0.00%';
    return pill;
  }
  const arrow = dailyChange > 0 ? '▲' : dailyChange < 0 ? '▼' : '▬';
  const sign = dailyChange > 0 ? '+' : '';
  const absDec = Math.abs(dailyChange) < 1 && dailyChange !== 0 ? 3 : 2;
  const prefix = currency === 'USD' ? 'US$' : '';
  const diffStr = `${sign}${prefix}${dailyChange.toFixed(absDec)}`;
  const pctStr = fmtSignedPct(dailyChangePct, false, 2);
  pill.textContent = compact ? `${arrow} ${pctStr}` : `${arrow} ${diffStr} (${pctStr})`;
  return pill;
}

function toggleStockFlip(ctx: UiContext, assetId: string, innerEl: HTMLElement): void {
  const idx = ctx.state.flippedStockIds.indexOf(assetId);
  if (idx >= 0) {
    ctx.state.flippedStockIds.splice(idx, 1);
    innerEl.classList.remove('is-flipped');
  } else {
    ctx.state.flippedStockIds.push(assetId);
    innerEl.classList.add('is-flipped');
  }
}

function isUnitPriceSuspicious(impliedUnitPrice: number, marketPrice: number): boolean {
  if (!(impliedUnitPrice > 0) || !(marketPrice > 0)) return false;
  const ratio = impliedUnitPrice / marketPrice;
  return ratio >= 5 || ratio <= 0.2;
}

function buildSavingsLinkSection(
  ctx: UiContext,
  checkboxId: string,
  selectId: string,
  labelText: string,
  subText: string,
  defaultChecked: boolean
): HTMLDivElement {
  const snap = ctx.engine.getSnapshot();
  const savings = computeAllSavingsSummary(
    snap.assetItems,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    snap.settings.usdTwdRate
  );

  const wrap = document.createElement('div');
  wrap.className = 'stock-link-box';

  const label = document.createElement('label');
  label.className = 'stock-link-check';
  const cb = document.createElement('input');
  cb.id = checkboxId;
  cb.type = 'checkbox';
  cb.checked = defaultChecked;
  const textSpan = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = labelText;
  const small = document.createElement('small');
  small.textContent = subText;
  textSpan.appendChild(strong);
  textSpan.appendChild(small);
  label.appendChild(cb);
  label.appendChild(textSpan);
  wrap.appendChild(label);

  const accWrap = document.createElement('div');
  accWrap.style.marginTop = '8px';
  accWrap.style.display = defaultChecked ? 'block' : 'none';

  const accLabel = document.createElement('label');
  accLabel.className = 'section-label';
  accLabel.htmlFor = selectId;
  accLabel.style.marginBottom = '4px';
  accLabel.textContent = '連動活存帳戶（選填）';

  const sel = document.createElement('select');
  sel.id = selectId;
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '不連動活存帳戶（僅寫入流水帳）';
  sel.appendChild(noneOpt);
  for (const s of savings.accounts) {
    const opt = document.createElement('option');
    opt.value = s.account.id;
    opt.textContent = `${s.account.isDefaultSavings ? '★ ' : ''}${s.account.itemName} (${fmtMoney(s.currentBalanceTwd, ctx.state.masked)})`;
    if (s.account.id === savings.defaultAccountId) opt.selected = true;
    sel.appendChild(opt);
  }
  accWrap.appendChild(accLabel);
  accWrap.appendChild(sel);
  wrap.appendChild(accWrap);

  cb.addEventListener('change', () => {
    accWrap.style.display = cb.checked ? 'block' : 'none';
  });

  return wrap;
}

export function renderStocksTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const portfolio = computeStockPortfolioSummary(
    snap.assetItems,
    snap.stockTransactions || [],
    rate
  );
  const watchlist = computeWatchlistSummary(snap.assetItems);
  const masked = ctx.state.masked;
  const viewMode = ctx.state.stockPriceViewMode;
  const cardMode = ctx.state.stockCardDisplayMode;
  const subtab = ctx.state.stocksSubtab;

  document.querySelectorAll<HTMLButtonElement>('#stockViewModeToggle .mini-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.stockView === viewMode);
  });
  document.querySelectorAll<HTMLButtonElement>('#stockCardModeToggle .mini-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.cardMode === cardMode);
  });
  document.querySelectorAll<HTMLButtonElement>('#stocksSubtabBar [data-stocks-sub]').forEach((b) => {
    b.classList.toggle('active', b.dataset.stocksSub === subtab);
  });

  el('stocksCountBadge').textContent = `${portfolio.positions.length} 檔`;
  el('stocksHoldingsSubBadge').textContent = String(portfolio.positions.length);
  el('stocksWatchlistSubBadge').textContent = String(watchlist.items.length);
  el('stocksMarketValueHero').textContent = fmtMoney(portfolio.totalMarketValueTwd, masked);

  // Hero today's total daily PnL badge
  const heroDailyBadge = el('stocksHeroDailyBadge');
  if (portfolio.totalDailyPnlTwd !== null && portfolio.totalDailyChangePct !== null) {
    heroDailyBadge.style.display = 'inline-flex';
    const dirCls =
      portfolio.totalDailyPnlTwd > 0 ? 'pos' : portfolio.totalDailyPnlTwd < 0 ? 'neg' : 'flat';
    heroDailyBadge.className = `daily-change-pill ${dirCls} tnum`;
    const arrow =
      portfolio.totalDailyPnlTwd > 0 ? '▲' : portfolio.totalDailyPnlTwd < 0 ? '▼' : '▬';
    heroDailyBadge.textContent = masked
      ? `今日 ${arrow} •••`
      : `今日 ${arrow} ${fmtSignedCurrency(portfolio.totalDailyPnlTwd, 'TWD', false)} (${fmtSignedPct(portfolio.totalDailyChangePct, false, 2)})`;
  } else {
    heroDailyBadge.style.display = 'none';
  }

  // Latest stock quote & FX updated timestamp bar
  const latestStockTs = [portfolio.latestPriceUpdatedAt, watchlist.latestPriceUpdatedAt]
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop() || null;
  const fxTs = snap.settings.fxUpdatedAt || null;
  const updatedBar = el('stocksQuoteUpdatedBar');
  if (latestStockTs || fxTs) {
    const parts: string[] = [];
    if (latestStockTs) parts.push(`股價更新：${fmtQuoteTimestamp(latestStockTs)}`);
    if (fxTs) parts.push(`匯率更新：${fmtQuoteTimestamp(fxTs)}`);
    updatedBar.textContent = parts.join(' · ');
  } else {
    updatedBar.textContent = '股價尚未自動更新 · 點下方「更新股價匯率」同步最新行情與昨收';
  }

  const priceOnlyEl = el('stocksPricePnlText');
  const priceOnlySubEl = el('stocksPricePnlSub');
  const divAdjEl = el('stocksDivPnlText');
  const divAdjSubEl = el('stocksDivPnlSub');

  if (!portfolio.hasAnyCostBasis) {
    priceOnlyEl.textContent = '尚未設定成本';
    priceOnlyEl.style.color = 'var(--text-muted)';
    priceOnlySubEl.textContent = '點各檔「設成本」即可計算';
    divAdjEl.textContent = fmtMoney(portfolio.totalCashDividendsTwd, masked);
    divAdjEl.style.color = 'var(--text-secondary)';
    divAdjSubEl.textContent = '累計現金配息';
  } else {
    const pSign = portfolio.totalUnrealizedPnlTwd > 0 ? '+' : '';
    priceOnlyEl.textContent = masked
      ? 'NT$ •••••'
      : `${pSign}${fmtMoney(portfolio.totalUnrealizedPnlTwd, false)} (${fmtSignedPct(portfolio.totalUnrealizedRoiPct, false)})`;
    priceOnlyEl.style.color =
      portfolio.totalUnrealizedPnlTwd > 0
        ? 'var(--stock-pos)'
        : portfolio.totalUnrealizedPnlTwd < 0
          ? 'var(--stock-neg)'
          : 'var(--text)';
    priceOnlySubEl.textContent = `投入成本 ${fmtMoney(portfolio.totalCostBasisTwd, masked)}`;

    const dSign = portfolio.totalReturnPnlTwd > 0 ? '+' : '';
    divAdjEl.textContent = masked
      ? 'NT$ •••••'
      : `${dSign}${fmtMoney(portfolio.totalReturnPnlTwd, false)} (${fmtSignedPct(portfolio.totalReturnRoiPct, false)})`;
    divAdjEl.style.color =
      portfolio.totalReturnPnlTwd > 0
        ? 'var(--stock-pos)'
        : portfolio.totalReturnPnlTwd < 0
          ? 'var(--stock-neg)'
          : 'var(--text)';
    const realizedSuffix =
      portfolio.totalRealizedPnlTwd !== 0
        ? ` · 已實現 ${fmtSignedCurrency(portfolio.totalRealizedPnlTwd, 'TWD', masked)}`
        : '';
    divAdjSubEl.textContent = `累計配息 ${fmtMoney(portfolio.totalCashDividendsTwd, masked)}${realizedSuffix}`;
  }

  // Overall cost recovery bar
  const recoveryBar = el('stocksRecoveryFill');
  const recoveryPctText = el('stocksRecoveryPctText');
  const unrecoveredText = el('stocksUnrecoveredText');
  recoveryBar.style.width = `${Math.min(100, Math.max(0, portfolio.overallCostRecoveryPct))}%`;
  recoveryBar.style.background =
    portfolio.overallCostRecoveryPct >= 100 ? 'var(--stock-pos-bar)' : 'var(--primary)';
  recoveryPctText.textContent = `整體配息回本：${fmtPct(portfolio.overallCostRecoveryPct, 1)}`;
  if (!portfolio.hasAnyCostBasis) {
    unrecoveredText.textContent = '尚未設定成本';
  } else if (portfolio.totalUnrecoveredCostTwd === 0 && portfolio.totalCashDividendsTwd > 0) {
    unrecoveredText.textContent =
      portfolio.totalExcessRecoveredCashTwd > 0
        ? `已回本！超額回收 +${fmtMoney(portfolio.totalExcessRecoveredCashTwd, masked)}`
        : '剩餘未回本 NT$ 0（已回本）';
  } else {
    unrecoveredText.textContent = `未回本成本 ${fmtMoney(portfolio.totalUnrecoveredCostTwd, masked)}`;
  }

  // Render stock allocation chart, dividend calendar, and rebalance cards (holdings only)
  const chartCard = el('stocksChartCard');
  const dividendCard = el('stocksDividendCard');
  const rebalanceCard = el('stocksRebalanceCard');
  if (subtab === 'holdings') {
    renderStockChartCard(ctx, portfolio, chartCard, {
      onManageCategories: () => openStockCategoryManagerModal(ctx),
    });
    renderDividendCalendarCard(ctx, dividendCard);
    renderRebalanceCard(ctx, portfolio, rebalanceCard);
  } else {
    chartCard.style.display = 'none';
    dividendCard.style.display = 'none';
    rebalanceCard.style.display = 'none';
  }

  // Action button label & reorder button visibility
  const addBtn = el<HTMLButtonElement>('addStockBtn');
  addBtn.textContent = subtab === 'watchlist' ? '+ 新增觀察' : '+ 新增持股';

  const reorderBtn = el<HTMLButtonElement>('reorderStocksBtn');
  const isReorderingHoldings = ctx.state.reorderSection === 'stocks';
  const isReorderingWatchlist = ctx.state.reorderSection === 'watchlist';
  if (subtab === 'holdings') {
    reorderBtn.style.display = portfolio.positions.length >= 2 && !isReorderingHoldings ? '' : 'none';
  } else {
    reorderBtn.style.display = watchlist.items.length >= 2 && !isReorderingWatchlist ? '' : 'none';
  }

  const portfolioList = el('stocksPortfolioList');
  const watchlistList = el('stocksWatchlistList');
  portfolioList.style.display = subtab === 'holdings' ? 'flex' : 'none';
  watchlistList.style.display = subtab === 'watchlist' ? 'flex' : 'none';

  // ---- Render Holdings Subtab ----
  if (subtab === 'holdings') {
    portfolioList.innerHTML = '';

    if (!portfolio.positions.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.style.cssText = 'text-align:center;padding:28px 18px;display:flex;flex-direction:column;align-items:center;gap:10px';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:15px;font-weight:700';
      title.textContent = '尚無股票持股紀錄';
      const desc = document.createElement('div');
      desc.className = 'muted';
      desc.textContent = '可直接建立持股並填入平均成本（支援單價 39 或總額 39,000），之後隨時加碼與登錄配息配股';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '+ 建立第一檔持股';
      btn.addEventListener('click', () => openStockBaselineModal(ctx, null));
      empty.appendChild(title);
      empty.appendChild(desc);
      empty.appendChild(btn);
      portfolioList.appendChild(empty);
      return;
    }

    if (isReorderingHoldings && portfolio.positions.length >= 2) {
      renderReorderList(ctx, {
        container: portfolioList,
        section: 'stocks',
        wrapInCard: true,
        items: portfolio.positions.map((pos) => {
          const weightPct =
            portfolio.totalMarketValueTwd > 0
              ? ((pos.marketValueTwd / portfolio.totalMarketValueTwd) * 100).toFixed(1)
              : '0.0';
          return {
            id: pos.asset.id,
            title: pos.asset.itemName,
            badge: pos.asset.ticker || pos.asset.subCategory,
            subtitle: `${fmtShares(pos.currentShares)} 股 · 市值 ${fmtMoney(pos.marketValueTwd, masked)} (${weightPct}%)`,
          };
        }),
        onSave: (orderedIds) => ctx.engine.reorderAssets(orderedIds),
        onReRender: () => renderStocksTab(ctx),
      });
      return;
    }

    for (const pos of portfolio.positions) {
      const weightPct =
        portfolio.totalMarketValueTwd > 0
          ? (pos.marketValueTwd / portfolio.totalMarketValueTwd) * 100
          : 0;
      portfolioList.appendChild(
        cardMode === 'flip'
          ? renderStockFlipCard(ctx, pos, weightPct)
          : renderStockPositionCard(ctx, pos, weightPct)
      );
    }
    return;
  }

  // ---- Render Watchlist Subtab ----
  watchlistList.innerHTML = '';

  if (!watchlist.items.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.style.cssText = 'text-align:center;padding:28px 18px;display:flex;flex-direction:column;align-items:center;gap:10px';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:700';
    title.textContent = '觀察清單目前是空的';
    const desc = document.createElement('div');
    desc.className = 'muted';
    desc.textContent = '加入想追蹤的台股或美股／ETF，系統會自動同步現價與昨收漲跌，但不會計入你的總資產與持股損益';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = '+ 加入第一檔觀察標的';
    btn.addEventListener('click', () => openWatchlistModal(ctx, null));
    empty.appendChild(title);
    empty.appendChild(desc);
    empty.appendChild(btn);
    watchlistList.appendChild(empty);
    return;
  }

  if (isReorderingWatchlist && watchlist.items.length >= 2) {
    renderReorderList(ctx, {
      container: watchlistList,
      section: 'watchlist',
      wrapInCard: true,
      items: watchlist.items.map((w) => ({
        id: w.asset.id,
        title: w.asset.itemName,
        badge: w.asset.ticker || w.asset.subCategory,
        subtitle:
          w.marketPrice > 0
            ? `現價 ${fmtPrice(w.marketPrice, masked, w.asset.currency)}`
            : '尚未取得報價',
      })),
      onSave: (orderedIds) => ctx.engine.reorderAssets(orderedIds),
      onReRender: () => renderStocksTab(ctx),
    });
    return;
  }

  for (const item of watchlist.items) {
    watchlistList.appendChild(
      cardMode === 'flip' ? renderWatchlistFlipCard(ctx, item) : renderWatchlistCard(ctx, item)
    );
  }
}

function renderStockMetricsGrid(
  pos: StockPositionSummary,
  viewMode: 'unit' | 'total',
  masked: boolean,
  curr: string
): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'stock-metrics-grid';

  // Box 1: 帳面價差（不含息）
  const box1 = document.createElement('div');
  box1.className = 'stock-metric-box';
  const b1Head = document.createElement('div');
  b1Head.className = 'stock-metric-label';
  b1Head.textContent = '帳面價差（不含息）';

  const b1Cost = document.createElement('div');
  b1Cost.className = 'stock-metric-cost tnum';
  b1Cost.textContent =
    viewMode === 'unit'
      ? `原均價 ${fmtPrice(pos.avgCostPerShare, masked, curr)} /股`
      : `投入成本 ${fmtCurrencyAmount(pos.costBasis, curr, masked)}`;

  const b1Pnl = document.createElement('div');
  b1Pnl.className =
    'stock-metric-pnl tnum' +
    (pos.unrealizedPnl > 0 ? ' pos' : pos.unrealizedPnl < 0 ? ' neg' : '');
  if (viewMode === 'unit' && pos.currentShares > 0) {
    const unitDiff = pos.marketPrice - pos.avgCostPerShare;
    const uSign = unitDiff > 0 ? '+' : '';
    b1Pnl.textContent = masked
      ? '•••••'
      : `${uSign}${unitDiff.toFixed(2)}/股 (${fmtSignedPct(pos.unrealizedRoiPct, false)})`;
  } else {
    b1Pnl.textContent = masked
      ? '•••••'
      : `${fmtSignedCurrency(pos.unrealizedPnl, curr, false)} (${fmtSignedPct(pos.unrealizedRoiPct, false)})`;
  }

  const b1Sub = document.createElement('div');
  b1Sub.className = 'stock-metric-sub tnum';
  b1Sub.textContent =
    viewMode === 'unit'
      ? `帳面淨利 ${fmtSignedCurrency(pos.unrealizedPnl, curr, masked)}`
      : `原均價 ${fmtPrice(pos.avgCostPerShare, masked, curr)} /股`;

  box1.appendChild(b1Head);
  box1.appendChild(b1Cost);
  box1.appendChild(b1Pnl);
  box1.appendChild(b1Sub);

  // Box 2: 配息降成本（含息總報酬）
  const box2 = document.createElement('div');
  box2.className = 'stock-metric-box tinted';
  const b2Head = document.createElement('div');
  b2Head.className = 'stock-metric-label';
  b2Head.textContent = '配息扣成本（含息）';

  const b2Cost = document.createElement('div');
  b2Cost.className = 'stock-metric-cost tnum';
  if (pos.isCostRecovered) {
    b2Cost.textContent =
      viewMode === 'unit'
        ? `未回本 ${fmtPrice(0, masked, curr)} /股（歸零）`
        : `未回本 ${fmtCurrencyAmount(0, curr, masked)}（歸零）`;
  } else {
    b2Cost.textContent =
      viewMode === 'unit'
        ? `未回本 ${fmtPrice(pos.unrecoveredCostPerShare, masked, curr)} /股`
        : `未回本 ${fmtCurrencyAmount(pos.unrecoveredCost, curr, masked)}`;
  }

  const b2Pnl = document.createElement('div');
  b2Pnl.className =
    'stock-metric-pnl tnum' +
    (pos.totalReturnPnl > 0 ? ' pos' : pos.totalReturnPnl < 0 ? ' neg' : '');
  b2Pnl.textContent = masked
    ? '•••••'
    : `${fmtSignedCurrency(pos.totalReturnPnl, curr, false)} (${fmtSignedPct(pos.totalReturnRoiPct, false)})`;

  const b2Sub = document.createElement('div');
  b2Sub.className = 'stock-metric-sub tnum';
  if (pos.excessRecoveredCash > 0) {
    b2Sub.textContent = `超額回收 +${fmtCurrencyAmount(pos.excessRecoveredCash, curr, masked)}`;
  } else {
    b2Sub.textContent = `累計配息 ${fmtCurrencyAmount(pos.cumulativeCashDividends, curr, masked)}`;
  }

  box2.appendChild(b2Head);
  box2.appendChild(b2Cost);
  box2.appendChild(b2Pnl);
  box2.appendChild(b2Sub);

  grid.appendChild(box1);
  grid.appendChild(box2);
  return grid;
}

function renderStockCardActions(
  ctx: UiContext,
  pos: StockPositionSummary,
  stopProp = false
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'stock-card-actions';

  const wire = (btn: HTMLButtonElement, fn: () => void) => {
    btn.addEventListener('click', (e) => {
      if (stopProp) e.stopPropagation();
      fn();
    });
  };

  const buyBtn = document.createElement('button');
  buyBtn.type = 'button';
  buyBtn.className = 'btn btn-tinted btn-sm';
  buyBtn.textContent = '+ 加碼';
  wire(buyBtn, () => openStockTradeModal(ctx, pos.asset, 'buy'));

  const divBtn = document.createElement('button');
  divBtn.type = 'button';
  divBtn.className = 'btn btn-tinted btn-sm';
  divBtn.textContent = '配息/配股';
  wire(divBtn, () => openStockDividendModal(ctx, pos.asset));

  const sellBtn = document.createElement('button');
  sellBtn.type = 'button';
  sellBtn.className = 'btn btn-outline btn-sm';
  sellBtn.textContent = '賣出';
  wire(sellBtn, () => openStockTradeModal(ctx, pos.asset, 'sell'));

  const histBtn = document.createElement('button');
  histBtn.type = 'button';
  histBtn.className = 'btn btn-outline btn-sm';
  histBtn.textContent = pos.transactionCount > 0 ? `明細 (${pos.transactionCount})` : '設成本';
  wire(histBtn, () =>
    pos.transactionCount > 0
      ? openStockHistoryModal(ctx, pos.asset)
      : openStockBaselineModal(ctx, pos.asset)
  );

  actions.appendChild(buyBtn);
  actions.appendChild(divBtn);
  actions.appendChild(sellBtn);
  actions.appendChild(histBtn);
  return actions;
}

function renderStockPositionCard(
  ctx: UiContext,
  pos: StockPositionSummary,
  weightPct = 0
): HTMLElement {
  const masked = ctx.state.masked;
  const viewMode = ctx.state.stockPriceViewMode;
  const curr = pos.asset.currency || 'TWD';

  const card = document.createElement('div');
  card.className = 'card stock-card';

  // Header row
  const head = document.createElement('div');
  head.className = 'stock-card-head';

  const left = document.createElement('div');
  left.className = 'item-main';
  const titleRow = document.createElement('div');
  titleRow.className = 'stock-title-row';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'stock-name';
  nameSpan.textContent = pos.asset.itemName;
  titleRow.appendChild(nameSpan);

  if (pos.asset.ticker) {
    const tickerBadge = document.createElement('span');
    tickerBadge.className = 'badge';
    tickerBadge.style.marginRight = '0';
    tickerBadge.textContent = pos.asset.ticker;
    titleRow.appendChild(tickerBadge);
  }
  const catBtn = document.createElement('button');
  catBtn.type = 'button';
  catBtn.className = pos.asset.stockCategory ? 'stock-cat-btn set' : 'stock-cat-btn unset';
  catBtn.textContent = pos.asset.stockCategory || '+ 分類';
  catBtn.title = '點擊快速變更持股分類';
  catBtn.addEventListener('click', () => openQuickStockCategoryPicker(ctx, pos.asset));
  titleRow.appendChild(catBtn);

  if (weightPct > 0) {
    const wtBadge = document.createElement('span');
    wtBadge.className = 'badge';
    wtBadge.style.cssText = 'margin-right:0;background:var(--fill);color:var(--text-secondary)';
    wtBadge.textContent = `佔 ${fmtPct(weightPct, 1)}`;
    titleRow.appendChild(wtBadge);
  }
  if (curr === 'USD') {
    const currBadge = document.createElement('span');
    currBadge.className = 'badge';
    currBadge.style.marginRight = '0';
    currBadge.textContent = 'USD';
    titleRow.appendChild(currBadge);
  }
  if (pos.isCostRecovered) {
    const recBadge = document.createElement('span');
    recBadge.className = 'badge stock-recovered';
    recBadge.style.marginRight = '0';
    recBadge.textContent = '✓ 已回本';
    titleRow.appendChild(recBadge);
  }

  const subRow = document.createElement('div');
  subRow.className = 'item-sub tnum';
  const lotsHint =
    curr === 'TWD' && pos.currentShares >= 1000 && pos.currentShares % 1000 === 0
      ? ` (${pos.currentShares / 1000} 張)`
      : '';
  const prevCloseStr =
    pos.previousClose !== null ? ` · 昨收 ${fmtPrice(pos.previousClose, masked, curr)}` : '';
  subRow.textContent =
    viewMode === 'unit'
      ? `持有 ${fmtShares(pos.currentShares)} 股${lotsHint} · 市值 ${fmtCurrencyAmount(pos.marketValue, curr, masked)}${prevCloseStr}`
      : `持有 ${fmtShares(pos.currentShares)} 股${lotsHint} · 現價 ${fmtPrice(pos.marketPrice, masked, curr)}${prevCloseStr}`;

  left.appendChild(titleRow);
  left.appendChild(subRow);

  const right = document.createElement('div');
  right.className = 'stock-head-right tnum';
  const primaryVal = document.createElement('div');
  primaryVal.className = 'stock-head-val';
  if (pos.dailyChange !== null && pos.dailyChange !== 0) {
    primaryVal.style.color = pos.dailyChange > 0 ? 'var(--stock-pos)' : 'var(--stock-neg)';
  }
  primaryVal.textContent =
    viewMode === 'unit'
      ? fmtPrice(pos.marketPrice, masked, curr)
      : fmtCurrencyAmount(pos.marketValue, curr, masked);
  const primaryCaption = document.createElement('div');
  primaryCaption.className = 'stock-head-cap';
  primaryCaption.textContent =
    viewMode === 'unit'
      ? '目前市價 / 股'
      : curr === 'USD'
        ? `約 ${fmtMoney(pos.marketValueTwd, masked)}`
        : '目前總市值';
  right.appendChild(primaryVal);
  right.appendChild(primaryCaption);

  head.appendChild(left);
  head.appendChild(right);
  card.appendChild(head);

  // Daily change strip (yesterday close vs today + per-stock updated time)
  const quoteStrip = document.createElement('div');
  quoteStrip.className = 'stock-quote-strip tnum';
  const stripLeft = document.createElement('div');
  stripLeft.className = 'stock-quote-strip-left';
  stripLeft.appendChild(createDailyChangeBadge(pos.dailyChange, pos.dailyChangePct, curr, masked));
  if (pos.dailyPnlTwd !== null && pos.currentShares > 0) {
    const dpSpan = document.createElement('span');
    dpSpan.className =
      'stock-daily-pnl ' +
      (pos.dailyPnlTwd > 0 ? 'pos' : pos.dailyPnlTwd < 0 ? 'neg' : '');
    dpSpan.textContent = `今日 ${fmtSignedCurrency(pos.dailyPnlTwd, 'TWD', masked)}`;
    stripLeft.appendChild(dpSpan);
  }
  const stripTime = document.createElement('span');
  stripTime.className = 'stock-quote-time';
  stripTime.textContent = pos.asset.priceUpdatedAt
    ? fmtQuoteTimestamp(pos.asset.priceUpdatedAt)
    : needsImmediateQuote(pos.asset)
      ? '報價待更新'
      : pos.asset.updateMode;
  quoteStrip.appendChild(stripLeft);
  quoteStrip.appendChild(stripTime);
  card.appendChild(quoteStrip);

  // Metrics section (Price-only vs Dividend-adjusted coexisting side-by-side)
  if (!pos.hasCostBasis) {
    const prompt = document.createElement('div');
    prompt.className = 'stock-unset-banner';
    const txt = document.createElement('span');
    txt.textContent = '尚未設定成本價，設定後即可檢視價差淨利與配息回本進度';
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.className = 'btn btn-tinted btn-sm';
    setBtn.textContent = '設定成本';
    setBtn.addEventListener('click', () => openStockBaselineModal(ctx, pos.asset));
    prompt.appendChild(txt);
    prompt.appendChild(setBtn);
    card.appendChild(prompt);
  } else {
    card.appendChild(renderStockMetricsGrid(pos, viewMode, masked, curr));

    // Mini recovery bar & badges
    if (
      pos.cumulativeCashDividends > 0 ||
      pos.cumulativeStockDividendShares > 0 ||
      pos.realizedPnl !== 0
    ) {
      const recWrap = document.createElement('div');
      recWrap.className = 'stock-recovery-wrap';

      const track = document.createElement('div');
      track.className = 'progress-track sm';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = `${Math.min(100, Math.max(0, pos.costRecoveryPct))}%`;
      fill.style.background = pos.isCostRecovered ? 'var(--stock-pos-bar)' : 'var(--primary)';
      track.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'stock-recovery-meta tnum';
      const parts: string[] = [];
      if (pos.cumulativeCashDividends > 0) {
        parts.push(`配息回本 ${fmtPct(pos.costRecoveryPct, 1)}`);
      }
      if (pos.cumulativeStockDividendShares > 0) {
        parts.push(`累計配股 +${fmtShares(pos.cumulativeStockDividendShares)} 股`);
      }
      if (pos.realizedPnl !== 0) {
        parts.push(`已實現 ${fmtSignedCurrency(pos.realizedPnl, curr, masked)}`);
      }
      meta.textContent = parts.join(' · ');

      recWrap.appendChild(track);
      recWrap.appendChild(meta);
      card.appendChild(recWrap);
    }
  }

  card.appendChild(renderStockCardActions(ctx, pos, false));
  return card;
}

function renderStockFlipCard(
  ctx: UiContext,
  pos: StockPositionSummary,
  weightPct = 0
): HTMLElement {
  const masked = ctx.state.masked;
  const viewMode = ctx.state.stockPriceViewMode;
  const curr = pos.asset.currency || 'TWD';
  const isFlipped = ctx.state.flippedStockIds.includes(pos.asset.id);
  const accentCls =
    pos.dailyChange !== null && pos.dailyChange > 0
      ? ' accent-pos'
      : pos.dailyChange !== null && pos.dailyChange < 0
        ? ' accent-neg'
        : '';

  const scene = document.createElement('div');
  scene.className = 'stock-flip-scene';

  const inner = document.createElement('div');
  inner.className = 'stock-flip-inner' + (isFlipped ? ' is-flipped' : '');

  // ==================== FRONT FACE ====================
  const front = document.createElement('div');
  front.className = 'card stock-card stock-flip-face stock-flip-front' + accentCls;

  const frontTop = document.createElement('div');
  frontTop.className = 'flip-top-row';

  const titleRow = document.createElement('div');
  titleRow.className = 'stock-title-row';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'stock-name';
  nameSpan.textContent = pos.asset.itemName;
  titleRow.appendChild(nameSpan);
  if (pos.asset.ticker) {
    const tickerBadge = document.createElement('span');
    tickerBadge.className = 'badge';
    tickerBadge.style.marginRight = '0';
    tickerBadge.textContent = pos.asset.ticker;
    titleRow.appendChild(tickerBadge);
  }
  const catBtn = document.createElement('button');
  catBtn.type = 'button';
  catBtn.className = pos.asset.stockCategory ? 'stock-cat-btn set' : 'stock-cat-btn unset';
  catBtn.textContent = pos.asset.stockCategory || '+ 分類';
  catBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openQuickStockCategoryPicker(ctx, pos.asset);
  });
  titleRow.appendChild(catBtn);
  if (weightPct > 0) {
    const wtBadge = document.createElement('span');
    wtBadge.className = 'badge';
    wtBadge.style.cssText = 'margin-right:0;background:var(--fill);color:var(--text-secondary)';
    wtBadge.textContent = `佔 ${fmtPct(weightPct, 1)}`;
    titleRow.appendChild(wtBadge);
  }
  if (pos.isCostRecovered) {
    const recBadge = document.createElement('span');
    recBadge.className = 'badge stock-recovered';
    recBadge.style.marginRight = '0';
    recBadge.textContent = '✓ 已回本';
    titleRow.appendChild(recBadge);
  }

  const flipCue = document.createElement('span');
  flipCue.className = 'flip-cue';
  flipCue.textContent = '↻ 翻面';

  frontTop.appendChild(titleRow);
  frontTop.appendChild(flipCue);
  front.appendChild(frontTop);

  // Main price & market value hero
  const hero = document.createElement('div');
  hero.className = 'flip-price-hero tnum';

  const priceBlock = document.createElement('div');
  priceBlock.className = 'flip-price-left';
  const priceMain = document.createElement('div');
  priceMain.className = 'flip-big-price';
  if (pos.dailyChange !== null && pos.dailyChange !== 0) {
    priceMain.style.color = pos.dailyChange > 0 ? 'var(--stock-pos)' : 'var(--stock-neg)';
  }
  priceMain.textContent = fmtPrice(pos.marketPrice, masked, curr);

  const changeRow = document.createElement('div');
  changeRow.className = 'flip-change-row';
  changeRow.appendChild(createDailyChangeBadge(pos.dailyChange, pos.dailyChangePct, curr, masked));
  if (pos.previousClose !== null) {
    const prevSpan = document.createElement('span');
    prevSpan.className = 'flip-prev-close';
    prevSpan.textContent = `昨收 ${fmtPrice(pos.previousClose, masked, curr)}`;
    changeRow.appendChild(prevSpan);
  }
  priceBlock.appendChild(priceMain);
  priceBlock.appendChild(changeRow);

  const valueBlock = document.createElement('div');
  valueBlock.className = 'flip-value-right';
  const valMain = document.createElement('div');
  valMain.className = 'flip-val-num';
  valMain.textContent = fmtCurrencyAmount(pos.marketValue, curr, masked);
  const valSub = document.createElement('div');
  valSub.className = 'flip-val-sub';
  const lotsHint =
    curr === 'TWD' && pos.currentShares >= 1000 && pos.currentShares % 1000 === 0
      ? ` (${pos.currentShares / 1000}張)`
      : '';
  valSub.textContent = `${fmtShares(pos.currentShares)} 股${lotsHint}`;
  valueBlock.appendChild(valMain);
  valueBlock.appendChild(valSub);
  if (pos.dailyPnlTwd !== null && pos.currentShares > 0) {
    const dpEl = document.createElement('div');
    dpEl.className =
      'flip-daily-pnl ' +
      (pos.dailyPnlTwd > 0 ? 'pos' : pos.dailyPnlTwd < 0 ? 'neg' : '');
    dpEl.textContent = `今日 ${fmtSignedCurrency(pos.dailyPnlTwd, 'TWD', masked)}`;
    valueBlock.appendChild(dpEl);
  }

  hero.appendChild(priceBlock);
  hero.appendChild(valueBlock);
  front.appendChild(hero);

  // Bottom quick summary strip
  const summaryRow = document.createElement('div');
  summaryRow.className = 'flip-summary-strip tnum';
  if (pos.hasCostBasis) {
    const pChip = document.createElement('span');
    pChip.className =
      'flip-stat-chip ' +
      (pos.unrealizedPnl > 0 ? 'pos' : pos.unrealizedPnl < 0 ? 'neg' : '');
    pChip.textContent = `價差 ${fmtSignedPct(pos.unrealizedRoiPct, masked)}`;

    const dChip = document.createElement('span');
    dChip.className =
      'flip-stat-chip ' +
      (pos.totalReturnPnl > 0 ? 'pos' : pos.totalReturnPnl < 0 ? 'neg' : '');
    dChip.textContent = `含息 ${fmtSignedPct(pos.totalReturnRoiPct, masked)}`;

    const recChip = document.createElement('span');
    recChip.className = 'flip-stat-chip neutral';
    recChip.textContent = `回本 ${fmtPct(pos.costRecoveryPct, 0)}`;

    summaryRow.appendChild(pChip);
    summaryRow.appendChild(dChip);
    summaryRow.appendChild(recChip);
  } else {
    const unsetChip = document.createElement('span');
    unsetChip.className = 'flip-stat-chip neutral';
    unsetChip.textContent = '點擊翻面設定成本與紀錄交易';
    summaryRow.appendChild(unsetChip);
  }
  front.appendChild(summaryRow);

  // ==================== BACK FACE ====================
  const back = document.createElement('div');
  back.className = 'card stock-card stock-flip-face stock-flip-back' + accentCls;

  const backTop = document.createElement('div');
  backTop.className = 'flip-top-row';
  const backTitle = document.createElement('div');
  backTitle.className = 'stock-title-row';
  const bName = document.createElement('span');
  bName.className = 'stock-name';
  bName.textContent = pos.asset.itemName;
  backTitle.appendChild(bName);
  if (pos.asset.ticker) {
    const bTick = document.createElement('span');
    bTick.className = 'badge';
    bTick.style.marginRight = '0';
    bTick.textContent = pos.asset.ticker;
    backTitle.appendChild(bTick);
  }
  const backCue = document.createElement('span');
  backCue.className = 'flip-cue';
  backCue.textContent = '↺ 翻回行情';
  backTop.appendChild(backTitle);
  backTop.appendChild(backCue);
  back.appendChild(backTop);

  const backMeta = document.createElement('div');
  backMeta.className = 'flip-back-meta tnum';
  const metaBits: string[] = [];
  if (pos.previousClose !== null) {
    metaBits.push(`昨收 ${fmtPrice(pos.previousClose, masked, curr)}`);
  }
  metaBits.push(
    pos.asset.priceUpdatedAt
      ? `更新 ${fmtQuoteTimestamp(pos.asset.priceUpdatedAt)}`
      : needsImmediateQuote(pos.asset)
        ? '報價待更新'
        : pos.asset.updateMode
  );
  if (curr === 'USD') {
    metaBits.push(`市值約 ${fmtMoney(pos.marketValueTwd, masked)}`);
  }
  backMeta.textContent = metaBits.join(' · ');
  back.appendChild(backMeta);

  if (!pos.hasCostBasis) {
    const prompt = document.createElement('div');
    prompt.className = 'stock-unset-banner';
    const txt = document.createElement('span');
    txt.textContent = '尚未設定成本價，設定後即可檢視價差淨利與配息回本';
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.className = 'btn btn-tinted btn-sm';
    setBtn.textContent = '設定成本';
    setBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStockBaselineModal(ctx, pos.asset);
    });
    prompt.appendChild(txt);
    prompt.appendChild(setBtn);
    back.appendChild(prompt);
  } else {
    back.appendChild(renderStockMetricsGrid(pos, viewMode, masked, curr));
  }

  back.appendChild(renderStockCardActions(ctx, pos, true));

  inner.appendChild(front);
  inner.appendChild(back);
  scene.appendChild(inner);

  scene.addEventListener('click', () => toggleStockFlip(ctx, pos.asset.id, inner));
  return scene;
}

function renderWatchlistActions(
  ctx: UiContext,
  asset: AssetItem,
  stopProp = false
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'watchlist-card-actions';

  const wire = (btn: HTMLButtonElement, fn: () => void) => {
    btn.addEventListener('click', (e) => {
      if (stopProp) e.stopPropagation();
      fn();
    });
  };

  const convBtn = document.createElement('button');
  convBtn.type = 'button';
  convBtn.className = 'btn btn-tinted btn-sm';
  convBtn.textContent = '轉為正式持股';
  wire(convBtn, () => openStockBaselineModal(ctx, asset, { convertFromWatchlist: true }));

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-outline btn-sm';
  editBtn.textContent = '編輯';
  wire(editBtn, () => openWatchlistModal(ctx, asset));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-outline btn-sm';
  delBtn.style.color = 'var(--danger)';
  delBtn.textContent = '移除';
  wire(delBtn, async () => {
    if (!confirm(`確定從觀察清單移除「${asset.itemName}」？`)) return;
    await ctx.engine.deleteAsset(asset.id);
    showToast(`已移除觀察標的：${asset.itemName}`, 'success');
    ctx.scheduleSync();
  });

  actions.appendChild(convBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  return actions;
}

function renderWatchlistCard(ctx: UiContext, item: WatchlistItemSummary): HTMLElement {
  const masked = ctx.state.masked;
  const curr = item.asset.currency || 'TWD';
  const card = document.createElement('div');
  card.className = 'card stock-card';

  const head = document.createElement('div');
  head.className = 'stock-card-head';

  const left = document.createElement('div');
  left.className = 'item-main';
  const titleRow = document.createElement('div');
  titleRow.className = 'stock-title-row';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'stock-name';
  nameSpan.textContent = item.asset.itemName;
  titleRow.appendChild(nameSpan);

  const watchBadge = document.createElement('span');
  watchBadge.className = 'badge watchlist-tag';
  watchBadge.style.marginRight = '0';
  watchBadge.textContent = '觀察中';
  titleRow.appendChild(watchBadge);

  if (item.asset.ticker) {
    const tickerBadge = document.createElement('span');
    tickerBadge.className = 'badge';
    tickerBadge.style.marginRight = '0';
    tickerBadge.textContent = item.asset.ticker;
    titleRow.appendChild(tickerBadge);
  }
  const catBtn = document.createElement('button');
  catBtn.type = 'button';
  catBtn.className = item.asset.stockCategory ? 'stock-cat-btn set' : 'stock-cat-btn unset';
  catBtn.textContent = item.asset.stockCategory || '+ 分類';
  catBtn.addEventListener('click', () => openQuickStockCategoryPicker(ctx, item.asset));
  titleRow.appendChild(catBtn);

  if (curr === 'USD') {
    const currBadge = document.createElement('span');
    currBadge.className = 'badge';
    currBadge.style.marginRight = '0';
    currBadge.textContent = 'USD';
    titleRow.appendChild(currBadge);
  }

  const subRow = document.createElement('div');
  subRow.className = 'item-sub tnum';
  const subParts: string[] = [item.asset.subCategory || '台股'];
  if (item.previousClose !== null) {
    subParts.push(`昨收 ${fmtPrice(item.previousClose, masked, curr)}`);
  }
  if (item.asset.note) {
    subParts.push(item.asset.note);
  }
  subRow.textContent = subParts.join(' · ');

  left.appendChild(titleRow);
  left.appendChild(subRow);

  const right = document.createElement('div');
  right.className = 'stock-head-right tnum';
  const priceEl = document.createElement('div');
  priceEl.className = 'stock-head-val';
  if (item.dailyChange !== null && item.dailyChange !== 0) {
    priceEl.style.color = item.dailyChange > 0 ? 'var(--stock-pos)' : 'var(--stock-neg)';
  }
  priceEl.textContent =
    item.marketPrice > 0 ? fmtPrice(item.marketPrice, masked, curr) : '待更新';
  const capEl = document.createElement('div');
  capEl.className = 'stock-head-cap';
  capEl.textContent = '目前報價（不計入資產）';
  right.appendChild(priceEl);
  right.appendChild(capEl);

  head.appendChild(left);
  head.appendChild(right);
  card.appendChild(head);

  const strip = document.createElement('div');
  strip.className = 'stock-quote-strip tnum';
  const stripLeft = document.createElement('div');
  stripLeft.className = 'stock-quote-strip-left';
  stripLeft.appendChild(createDailyChangeBadge(item.dailyChange, item.dailyChangePct, curr, masked));
  const stripTime = document.createElement('span');
  stripTime.className = 'stock-quote-time';
  stripTime.textContent = item.priceUpdatedAt
    ? fmtQuoteTimestamp(item.priceUpdatedAt)
    : '尚未自動更新';
  strip.appendChild(stripLeft);
  strip.appendChild(stripTime);
  card.appendChild(strip);

  card.appendChild(renderWatchlistActions(ctx, item.asset, false));
  return card;
}

function renderWatchlistFlipCard(ctx: UiContext, item: WatchlistItemSummary): HTMLElement {
  const masked = ctx.state.masked;
  const curr = item.asset.currency || 'TWD';
  const isFlipped = ctx.state.flippedStockIds.includes(item.asset.id);
  const accentCls =
    item.dailyChange !== null && item.dailyChange > 0
      ? ' accent-pos'
      : item.dailyChange !== null && item.dailyChange < 0
        ? ' accent-neg'
        : '';

  const scene = document.createElement('div');
  scene.className = 'stock-flip-scene';

  const inner = document.createElement('div');
  inner.className = 'stock-flip-inner' + (isFlipped ? ' is-flipped' : '');

  // Front
  const front = document.createElement('div');
  front.className = 'card stock-card stock-flip-face stock-flip-front' + accentCls;

  const frontTop = document.createElement('div');
  frontTop.className = 'flip-top-row';
  const titleRow = document.createElement('div');
  titleRow.className = 'stock-title-row';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'stock-name';
  nameSpan.textContent = item.asset.itemName;
  titleRow.appendChild(nameSpan);
  const watchBadge = document.createElement('span');
  watchBadge.className = 'badge watchlist-tag';
  watchBadge.style.marginRight = '0';
  watchBadge.textContent = '觀察中';
  titleRow.appendChild(watchBadge);
  if (item.asset.ticker) {
    const tickerBadge = document.createElement('span');
    tickerBadge.className = 'badge';
    tickerBadge.style.marginRight = '0';
    tickerBadge.textContent = item.asset.ticker;
    titleRow.appendChild(tickerBadge);
  }
  const flipCue = document.createElement('span');
  flipCue.className = 'flip-cue';
  flipCue.textContent = '↻ 翻面';
  frontTop.appendChild(titleRow);
  frontTop.appendChild(flipCue);
  front.appendChild(frontTop);

  const hero = document.createElement('div');
  hero.className = 'flip-price-hero tnum';
  const priceLeft = document.createElement('div');
  priceLeft.className = 'flip-price-left';
  const bigPrice = document.createElement('div');
  bigPrice.className = 'flip-big-price';
  if (item.dailyChange !== null && item.dailyChange !== 0) {
    bigPrice.style.color = item.dailyChange > 0 ? 'var(--stock-pos)' : 'var(--stock-neg)';
  }
  bigPrice.textContent =
    item.marketPrice > 0 ? fmtPrice(item.marketPrice, masked, curr) : '待更新';
  const changeRow = document.createElement('div');
  changeRow.className = 'flip-change-row';
  changeRow.appendChild(createDailyChangeBadge(item.dailyChange, item.dailyChangePct, curr, masked));
  priceLeft.appendChild(bigPrice);
  priceLeft.appendChild(changeRow);

  const rightBox = document.createElement('div');
  rightBox.className = 'flip-value-right';
  const prevLabel = document.createElement('div');
  prevLabel.className = 'flip-val-sub';
  prevLabel.textContent =
    item.previousClose !== null
      ? `昨收 ${fmtPrice(item.previousClose, masked, curr)}`
      : '昨收待更新';
  const mktLabel = document.createElement('div');
  mktLabel.className = 'flip-val-sub';
  mktLabel.textContent = `${item.asset.subCategory || '台股'} · 不計入總資產`;
  rightBox.appendChild(prevLabel);
  rightBox.appendChild(mktLabel);

  hero.appendChild(priceLeft);
  hero.appendChild(rightBox);
  front.appendChild(hero);

  if (item.asset.note) {
    const noteBar = document.createElement('div');
    noteBar.className = 'flip-summary-strip';
    const noteChip = document.createElement('span');
    noteChip.className = 'flip-stat-chip neutral';
    noteChip.textContent = `筆記：${item.asset.note}`;
    noteBar.appendChild(noteChip);
    front.appendChild(noteBar);
  }

  // Back
  const back = document.createElement('div');
  back.className = 'card stock-card stock-flip-face stock-flip-back' + accentCls;

  const backTop = document.createElement('div');
  backTop.className = 'flip-top-row';
  const bTitle = document.createElement('div');
  bTitle.className = 'stock-title-row';
  const bName = document.createElement('span');
  bName.className = 'stock-name';
  bName.textContent = item.asset.itemName;
  bTitle.appendChild(bName);
  if (item.asset.ticker) {
    const bTick = document.createElement('span');
    bTick.className = 'badge';
    bTick.style.marginRight = '0';
    bTick.textContent = item.asset.ticker;
    bTitle.appendChild(bTick);
  }
  const backCue = document.createElement('span');
  backCue.className = 'flip-cue';
  backCue.textContent = '↺ 翻回行情';
  backTop.appendChild(bTitle);
  backTop.appendChild(backCue);
  back.appendChild(backTop);

  const detailBox = document.createElement('div');
  detailBox.className = 'stock-metric-box tnum';
  const l1 = document.createElement('div');
  l1.className = 'stock-metric-cost';
  l1.textContent = `昨收：${item.previousClose !== null ? fmtPrice(item.previousClose, masked, curr) : '待更新'} · 更新：${item.priceUpdatedAt ? fmtQuoteTimestamp(item.priceUpdatedAt) : '尚未更新'}`;
  const l2 = document.createElement('div');
  l2.className = 'stock-metric-sub';
  l2.textContent = item.asset.note ? `觀察備註：${item.asset.note}` : '尚未填寫觀察備註（可點編輯記錄目標買入價）';
  detailBox.appendChild(l1);
  detailBox.appendChild(l2);
  back.appendChild(detailBox);

  back.appendChild(renderWatchlistActions(ctx, item.asset, true));

  inner.appendChild(front);
  inner.appendChild(back);
  scene.appendChild(inner);
  scene.addEventListener('click', () => toggleStockFlip(ctx, item.asset.id, inner));
  return scene;
}

/* ==================== Modal 0: 新增 / 編輯觀察清單 ==================== */

export function openWatchlistModal(ctx: UiContext, existing: AssetItem | null): void {
  const body = openModal(existing ? `編輯觀察標的 · ${existing.itemName}` : '新增觀察標的');
  const form = document.createElement('form');

  const hint = document.createElement('div');
  hint.className = 'stock-live-preview';
  hint.textContent = '觀察清單僅追蹤最新報價與今日漲跌，不會計入持股市值、資產配置或個人總淨值；隨時可一鍵轉為正式持股。';
  form.appendChild(hint);

  const r0 = document.createElement('div');
  r0.className = 'row-2';
  r0.appendChild(
    makeInputField('股票名稱', 'wlName', 'text', existing?.itemName || '', '例如：台積電、NVDA、0050', true)
  );
  r0.appendChild(
    makeInputField(
      '股票代碼（自動抓報價與昨收）',
      'wlTicker',
      'text',
      existing?.ticker || '',
      '台股如 2330；美股如 NVDA / VOO',
      true
    )
  );
  form.appendChild(r0);

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(
    makeSelectField('市場', 'wlSub', ['台股', '美股/ETF'], existing?.subCategory === '美股/ETF' ? '美股/ETF' : '台股')
  );
  r1.appendChild(makeSelectField('幣別', 'wlCurr', ['TWD', 'USD'], existing?.currency || 'TWD'));
  form.appendChild(r1);

  let selectedStockCategory = normalizeStockCategory(existing?.stockCategory);
  const catSection = document.createElement('div');
  catSection.className = 'field';
  const catLbl = document.createElement('label');
  catLbl.textContent = '分類標籤（選填）';
  catSection.appendChild(catLbl);
  const catChipsWrap = document.createElement('div');
  catChipsWrap.className = 'quick-row';
  const renderCatChips = () => {
    catChipsWrap.innerHTML = '';
    const opts = [{ label: '未分類', value: '' }, ...getAllStockCategories(ctx).map((c) => ({ label: c, value: c }))];
    for (const opt of opts) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn sm' + (selectedStockCategory === opt.value ? ' active' : '');
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        selectedStockCategory = opt.value;
        renderCatChips();
      });
      catChipsWrap.appendChild(chip);
    }
  };
  renderCatChips();
  catSection.appendChild(catChipsWrap);
  form.appendChild(catSection);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(
    makeInputField(
      '目前市價（選填，留空則自動更新）',
      'wlPrice',
      'number',
      existing && existing.unitPrice > 0 ? existing.unitPrice : '',
      '留空或填參考價'
    )
  );
  r2.appendChild(
    makeInputField(
      '昨收價（選填，自動更新帶入）',
      'wlPrevClose',
      'number',
      existing && existing.previousClose ? existing.previousClose : '',
      '自動更新將帶入'
    )
  );
  form.appendChild(r2);

  form.appendChild(
    makeInputField('觀察備註（選填）', 'wlNote', 'text', existing?.note || '', '例如：目標買進價 950、等季線回測')
  );

  const subSel = form.querySelector('#wlSub') as unknown as HTMLSelectElement;
  const currSel = form.querySelector('#wlCurr') as unknown as HTMLSelectElement;
  const tickerInp = form.querySelector<HTMLInputElement>('#wlTicker')!;
  const wlPriceInp = form.querySelector<HTMLInputElement>('#wlPrice')!;
  const wlPrevInp = form.querySelector<HTMLInputElement>('#wlPrevClose')!;

  // F6: When editing an existing watchlist item and modifying market price, clear stale previousClose immediately
  if (existing && existing.previousClose != null && existing.previousClose > 0) {
    const initialPrevStr = String(existing.previousClose);
    const initialPriceStr = existing.unitPrice > 0 ? String(existing.unitPrice) : '';
    let prevAutoCleared = false;
    wlPriceInp.addEventListener('input', () => {
      if (!prevAutoCleared && wlPriceInp.value.trim() !== initialPriceStr && wlPrevInp.value.trim() === initialPrevStr) {
        wlPrevInp.value = '';
        prevAutoCleared = true;
      } else if (prevAutoCleared && wlPriceInp.value.trim() === initialPriceStr && wlPrevInp.value.trim() === '') {
        // F6 edge: price typed back to its original value → restore the auto-cleared previous close,
        // otherwise submit would send previousClose: null and wipe the server value.
        wlPrevInp.value = initialPrevStr;
        prevAutoCleared = false;
      }
    });
  }

  subSel.addEventListener('change', () => {
    if (!existing) {
      currSel.value = subSel.value === '美股/ETF' ? 'USD' : 'TWD';
    }
  });
  tickerInp.addEventListener('input', () => {
    if (existing) return;
    const raw = tickerInp.value.trim().toUpperCase();
    if (!raw) return;
    const looksUs =
      /^(?:US|NASDAQ|NYSE|NYSEARCA|ARCA|AMEX|BATS|CBOE):/.test(raw) ||
      /\.US$/.test(raw) ||
      (/^[A-Z]{1,5}(?:[.\-][A-Z]{1,2})?$/.test(raw) && !raw.startsWith('TPE'));
    const looksTw =
      /^(?:TPE|TWSE|TPEX|OTC|TWO|TW):/.test(raw) ||
      /\.(?:TW|TWO)$/.test(raw) ||
      /^\d{4,6}[A-Z]?$/.test(raw);
    if (looksUs && subSel.value !== '美股/ETF') {
      subSel.value = '美股/ETF';
      currSel.value = 'USD';
    } else if (looksTw && subSel.value !== '台股') {
      subSel.value = '台股';
      currSel.value = 'TWD';
    }
  });

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = existing ? '儲存觀察標的' : '加入觀察清單';
  btns.appendChild(cancelBtn);
  btns.appendChild(saveBtn);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const ticker = tickerInp.value.trim().toUpperCase();
      const rawPrice = wlPriceInp.value.trim();
      const rawPrev = wlPrevInp.value.trim();
      const tickerChanged = Boolean(
        existing && (existing.ticker || '').trim().toUpperCase() !== ticker
      );
      const priceFields = resolveStockModalPriceFields({
        existing,
        rawPrice,
        rawPrevClose: rawPrev,
        hasPrevCloseInput: true,
        tickerChanged,
        newTicker: ticker,
        defaultNewPrice: 0,
      });
      const savedWatch = await ctx.engine.saveAsset({
        id: existing?.id,
        itemName: el<HTMLInputElement>('wlName').value.trim(),
        majorType: '資產',
        updateMode: ticker ? '自動更新' : '手動快照',
        subCategory: subSel.value,
        liquidity: '高流動',
        quantityOrAmount: 0,
        currency: currSel.value,
        ticker,
        ...priceFields,
        costBasis: null,
        stockCategory: selectedStockCategory,
        isWatchlist: true,
        note: el<HTMLInputElement>('wlNote').value.trim(),
      });
      closeModal();
      const fetchWatchQuote = needsImmediateQuote(savedWatch);
      showToast(
        existing
          ? fetchWatchQuote
            ? '已更新觀察標的（正在取得新代號報價）'
            : '已更新觀察標的'
          : fetchWatchQuote
            ? '已加入觀察清單（正在取得報價）'
            : '已加入觀察清單',
        'success'
      );
      if (fetchWatchQuote) {
        void refreshQuoteForAsset(ctx, savedWatch.id);
      } else {
        ctx.scheduleSync();
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}

/* ==================== Modal 1: 新增持股 / 編輯期初成本 ==================== */

export function openStockBaselineModal(
  ctx: UiContext,
  existing: AssetItem | null,
  opts?: { convertFromWatchlist?: boolean }
): void {
  const isConverting = Boolean(opts?.convertFromWatchlist && existing);
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const pos = existing
    ? computeStockPositionSummary(existing, snap.stockTransactions || [], rate)
    : null;

  const modalTitle = isConverting
    ? `轉為正式持股 · ${existing?.itemName}`
    : existing
      ? `期初成本與設定 · ${existing.itemName}`
      : '新增股票持股';
  const body = openModal(modalTitle);
  const form = document.createElement('form');

  if (isConverting) {
    const info = document.createElement('div');
    info.className = 'stock-live-preview';
    info.style.marginBottom = '12px';
    info.textContent = '填入持有股數與平均成本後，將直接從觀察清單轉為正式持股（保留最新報價與昨收價）。';
    form.appendChild(info);
  } else if (pos && pos.transactionCount > 0) {
    const info = document.createElement('div');
    info.className = 'stock-live-preview tnum';
    info.style.marginBottom = '12px';
    info.textContent = `目前含 ${pos.transactionCount} 筆交易後推算總股數為 ${fmtShares(pos.currentShares)} 股。下方「期初股數／期初成本」代表歷史起算基準。`;
    form.appendChild(info);
  }

  const r0 = document.createElement('div');
  r0.className = 'row-2';
  r0.appendChild(
    makeInputField('股票名稱', 'stName', 'text', existing?.itemName || '', '例如：0050、台積電、VOO', true)
  );
  r0.appendChild(
    makeInputField(
      '股票代碼（自動更新行情）',
      'stTicker',
      'text',
      existing?.ticker || '',
      existing?.subCategory === '美股/ETF' ? '如 VOO、NVDA、AAPL、BRK.B' : '台股如 0050；美股如 VOO / NVDA'
    )
  );
  form.appendChild(r0);

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(
    makeSelectField('市場', 'stSub', ['台股', '美股/ETF'], existing?.subCategory === '美股/ETF' ? '美股/ETF' : '台股')
  );
  r1.appendChild(
    makeSelectField('幣別', 'stCurr', ['TWD', 'USD'], existing?.currency || 'TWD')
  );
  form.appendChild(r1);

  // Stock category selector (個股 / ETF / 特別股 + custom categories)
  let selectedStockCategory = normalizeStockCategory(existing?.stockCategory);
  const catSection = document.createElement('div');
  catSection.className = 'field';
  const catLbl = document.createElement('label');
  catLbl.textContent = '持股分類（選填，用於圓餅圖分類佔比）';
  catSection.appendChild(catLbl);

  const catChipsWrap = document.createElement('div');
  catChipsWrap.className = 'quick-row';
  catChipsWrap.style.marginBottom = '8px';

  const renderCategoryChips = () => {
    catChipsWrap.innerHTML = '';
    const allCats = getAllStockCategories(ctx);
    const options: Array<{ label: string; value: string }> = [
      { label: '未分類', value: '' },
      ...allCats.map((c) => ({ label: c, value: c })),
    ];
    for (const opt of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn sm' + (selectedStockCategory === opt.value ? ' active' : '');
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        selectedStockCategory = opt.value;
        renderCategoryChips();
      });
      catChipsWrap.appendChild(chip);
    }
  };
  renderCategoryChips();
  catSection.appendChild(catChipsWrap);

  const customCatRow = document.createElement('div');
  customCatRow.className = 'stock-cat-inline-add';
  const customCatInp = document.createElement('input');
  customCatInp.type = 'text';
  customCatInp.maxLength = 24;
  customCatInp.placeholder = '自訂新分類（例如：債券ETF、高股息）';
  const customCatAddBtn = document.createElement('button');
  customCatAddBtn.type = 'button';
  customCatAddBtn.className = 'btn btn-tinted btn-sm';
  customCatAddBtn.textContent = '+ 新增';
  customCatAddBtn.addEventListener('click', async () => {
    const cleaned = normalizeStockCategory(customCatInp.value);
    if (!cleaned) return;
    const curCustom = ctx.engine.getSnapshot().settings.customStockCategories || [];
    if (!DEFAULT_STOCK_CATEGORIES.includes(cleaned) && !curCustom.includes(cleaned)) {
      await ctx.engine.saveCustomStockCategories([...curCustom, cleaned]);
      ctx.scheduleSync();
    }
    selectedStockCategory = cleaned;
    customCatInp.value = '';
    renderCategoryChips();
    showToast(`已新增並套用分類：${cleaned}`, 'success');
  });
  customCatRow.appendChild(customCatInp);
  customCatRow.appendChild(customCatAddBtn);
  catSection.appendChild(customCatRow);
  form.appendChild(catSection);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(
    makeInputField(
      pos && pos.transactionCount > 0 ? '期初基準股數' : '目前持有股數',
      'stShares',
      'number',
      isConverting ? '' : (existing?.quantityOrAmount ?? ''),
      '1000',
      true
    )
  );
  r2.appendChild(
    makeInputField(
      '目前市價（每股）',
      'stPrice',
      'number',
      existing && existing.unitPrice > 0 ? existing.unitPrice : '',
      '40',
      true
    )
  );
  form.appendChild(r2);

  form.appendChild(
    makeInputField(
      '昨收價（選填，修改市價未填將自動清空待更新）',
      'stPrevClose',
      'number',
      existing && existing.previousClose != null && existing.previousClose > 0
        ? existing.previousClose
        : '',
      '留空待自動更新',
      false
    )
  );

  // Cost input mode selector (每股平均成本 vs 期初總成本)
  let costMode: 'unit' | 'total' = ctx.state.stockPriceViewMode;
  const modeLabel = document.createElement('label');
  modeLabel.className = 'section-label';
  modeLabel.textContent = '成本價輸入方式（底層自動精確換算）';
  form.appendChild(modeLabel);

  const modeSeg = document.createElement('div');
  modeSeg.className = 'seg-bar';
  modeSeg.style.marginBottom = '10px';
  const unitBtn = document.createElement('button');
  unitBtn.type = 'button';
  unitBtn.className = 'seg-btn' + (costMode === 'unit' ? ' active' : '');
  unitBtn.textContent = '輸入每股均價（如 39）';
  const totalBtn = document.createElement('button');
  totalBtn.type = 'button';
  totalBtn.className = 'seg-btn' + (costMode === 'total' ? ' active' : '');
  totalBtn.textContent = '輸入總投入成本（如 39000）';
  modeSeg.appendChild(unitBtn);
  modeSeg.appendChild(totalBtn);
  form.appendChild(modeSeg);

  const initialUnitCost =
    existing && existing.costBasis != null && existing.quantityOrAmount > 0
      ? Math.round((existing.costBasis / existing.quantityOrAmount) * 10000) / 10000
      : '';
  const initialTotalCost =
    existing && existing.costBasis != null ? existing.costBasis : '';

  const costField = makeInputField(
    costMode === 'unit' ? '期初每股平均成本（選填）' : '期初總投入成本（選填）',
    'stCostVal',
    'number',
    costMode === 'unit' ? initialUnitCost : initialTotalCost,
    costMode === 'unit' ? '例如：39' : '例如：39000',
    false
  );
  form.appendChild(costField);

  const previewBox = document.createElement('div');
  previewBox.className = 'stock-live-preview tnum';
  previewBox.style.display = 'none';
  form.appendChild(previewBox);

  const warnBox = document.createElement('div');
  warnBox.className = 'stock-warn-box';
  warnBox.style.display = 'none';
  form.appendChild(warnBox);

  form.appendChild(makeInputField('備註（選填）', 'stNote', 'text', existing?.note || '', '例如：存股核心部位'));

  const sharesInp = form.querySelector<HTMLInputElement>('#stShares')!;
  const priceInp = form.querySelector<HTMLInputElement>('#stPrice')!;
  const costInp = form.querySelector<HTMLInputElement>('#stCostVal')!;
  const costLbl = costField.querySelector<HTMLLabelElement>('label')!;
  const currSel = form.querySelector('#stCurr') as unknown as HTMLSelectElement;

  const computeImplied = () => {
    const shares = parseFloat(sharesInp.value) || 0;
    const marketPrice = parseFloat(priceInp.value) || 0;
    const rawStr = costInp.value.trim();
    if (!rawStr) {
      return { hasCost: false, totalCost: null as number | null, unitCost: 0, shares, marketPrice };
    }
    const raw = parseFloat(rawStr);
    if (Number.isNaN(raw) || raw < 0) {
      return { hasCost: false, totalCost: null as number | null, unitCost: 0, shares, marketPrice };
    }
    if (costMode === 'unit') {
      const totalCost = Math.round(raw * shares * 100) / 100;
      return { hasCost: true, totalCost, unitCost: raw, shares, marketPrice };
    }
    const unitCost = shares > 0 ? raw / shares : 0;
    return { hasCost: true, totalCost: Math.round(raw * 100) / 100, unitCost, shares, marketPrice };
  };

  const refreshPreview = () => {
    const { hasCost, totalCost, unitCost, shares, marketPrice } = computeImplied();
    const curr = currSel.value || 'TWD';
    if (!hasCost || totalCost === null) {
      previewBox.style.display = 'none';
      warnBox.style.display = 'none';
      return;
    }
    previewBox.style.display = 'block';
    const marketVal = shares * marketPrice;
    const pnl = marketVal - totalCost;
    const lotCostHint =
      curr === 'TWD' && unitCost > 0 ? ` ｜ 每張約 ${fmtCurrencyAmount(unitCost * 1000, curr, false)}` : '';
    previewBox.textContent =
      `換算：${fmtShares(shares)} 股 × ${fmtPrice(unitCost, false, curr)}/股 = 總成本 ${fmtCurrencyAmount(totalCost, curr, false)}${lotCostHint}` +
      (marketPrice > 0 ? ` ｜ 預估價差 ${fmtSignedCurrency(pnl, curr, false)}` : '');

    if (isUnitPriceSuspicious(unitCost, marketPrice)) {
      warnBox.style.display = 'block';
      warnBox.textContent = `⚠️ 注意：反推每股成本為 ${fmtPrice(unitCost, false, curr)}，與目前市價 ${fmtPrice(marketPrice, false, curr)} 落差極大，請確認是否選錯「每股均價 / 總投入成本」單位！`;
    } else {
      warnBox.style.display = 'none';
    }
  };

  const switchCostMode = (nextMode: 'unit' | 'total') => {
    if (nextMode === costMode) return;
    const prev = computeImplied();
    costMode = nextMode;
    unitBtn.classList.toggle('active', costMode === 'unit');
    totalBtn.classList.toggle('active', costMode === 'total');
    costLbl.textContent = costMode === 'unit' ? '期初每股平均成本（選填）' : '期初總投入成本（選填）';
    costInp.placeholder = costMode === 'unit' ? '例如：39' : '例如：39000';
    if (prev.hasCost && prev.totalCost !== null) {
      costInp.value =
        costMode === 'unit'
          ? prev.shares > 0
            ? String(Math.round((prev.totalCost / prev.shares) * 10000) / 10000)
            : ''
          : String(prev.totalCost);
    }
    refreshPreview();
  };

  const subSel = form.querySelector('#stSub') as unknown as HTMLSelectElement;
  const tickerInp = form.querySelector<HTMLInputElement>('#stTicker')!;
  const syncMarketPlaceholder = () => {
    const isUs = subSel.value === '美股/ETF';
    tickerInp.placeholder = isUs ? '如 VOO、NVDA、AAPL、BRK.B' : '台股如 0050、2330、00679B';
  };
  subSel.addEventListener('change', () => {
    syncMarketPlaceholder();
    if (!existing) {
      currSel.value = subSel.value === '美股/ETF' ? 'USD' : 'TWD';
      refreshPreview();
    }
  });
  tickerInp.addEventListener('input', () => {
    if (existing) return;
    const raw = tickerInp.value.trim().toUpperCase();
    if (!raw) return;
    const looksUs =
      /^(?:US|NASDAQ|NYSE|NYSEARCA|ARCA|AMEX|BATS|CBOE):/.test(raw) ||
      /\.US$/.test(raw) ||
      (/^[A-Z]{1,5}(?:[.\-][A-Z]{1,2})?$/.test(raw) && !raw.startsWith('TPE'));
    const looksTw =
      /^(?:TPE|TWSE|TPEX|OTC|TWO|TW):/.test(raw) ||
      /\.(?:TW|TWO)$/.test(raw) ||
      /^\d{4,6}[A-Z]?$/.test(raw);
    if (looksUs && subSel.value !== '美股/ETF') {
      subSel.value = '美股/ETF';
      currSel.value = 'USD';
      syncMarketPlaceholder();
      refreshPreview();
    } else if (looksTw && subSel.value !== '台股') {
      subSel.value = '台股';
      currSel.value = 'TWD';
      syncMarketPlaceholder();
      refreshPreview();
    }
  });
  syncMarketPlaceholder();

  unitBtn.addEventListener('click', () => switchCostMode('unit'));
  totalBtn.addEventListener('click', () => switchCostMode('total'));
  sharesInp.addEventListener('input', refreshPreview);
  const stPrevInp = form.querySelector<HTMLInputElement>('#stPrevClose')!;
  if (existing && existing.previousClose != null && existing.previousClose > 0) {
    const initialPrevStr = String(existing.previousClose);
    const initialPriceStr = existing.unitPrice > 0 ? String(existing.unitPrice) : '';
    let prevAutoCleared = false;
    priceInp.addEventListener('input', () => {
      if (!prevAutoCleared && priceInp.value.trim() !== initialPriceStr && stPrevInp.value.trim() === initialPrevStr) {
        stPrevInp.value = '';
        prevAutoCleared = true;
      } else if (prevAutoCleared && priceInp.value.trim() === initialPriceStr && stPrevInp.value.trim() === '') {
        // F6 edge: price typed back to its original value → restore the auto-cleared previous close,
        // otherwise submit would send previousClose: null and wipe the server value.
        stPrevInp.value = initialPrevStr;
        prevAutoCleared = false;
      }
    });
  }
  priceInp.addEventListener('input', refreshPreview);
  costInp.addEventListener('input', refreshPreview);
  currSel.addEventListener('change', refreshPreview);
  refreshPreview();

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';
  if (existing && !isConverting) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = '刪除持股';
    del.addEventListener('click', async () => {
      if (!confirm(`確定刪除持股「${existing.itemName}」？`)) return;
      await ctx.engine.deleteAsset(existing.id);
      closeModal();
      showToast(`已刪除持股：${existing.itemName}`, 'success');
      ctx.scheduleSync();
    });
    btns.appendChild(del);
  } else {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-outline';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeModal);
    btns.appendChild(cancel);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = isConverting ? '確認轉為正式持股' : existing ? '儲存持股成本' : '建立持股';
  btns.appendChild(saveBtn);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const { hasCost, totalCost, unitCost, shares, marketPrice } = computeImplied();
    if (hasCost && isUnitPriceSuspicious(unitCost, marketPrice)) {
      if (
        !confirm(
          `反推每股成本為 ${unitCost.toFixed(2)}，與目前市價 ${marketPrice.toFixed(2)} 相差超過 5 倍，確定仍要儲存？`
        )
      ) {
        return;
      }
    }
    try {
      const ticker = el<HTMLInputElement>('stTicker').value.trim().toUpperCase();
      const rawPrice = priceInp.value.trim();
      const rawPrev = stPrevInp.value.trim();
      const tickerChanged = Boolean(
        existing && (existing.ticker || '').trim().toUpperCase() !== ticker
      );
      const priceFields = resolveStockModalPriceFields({
        existing,
        rawPrice,
        rawPrevClose: rawPrev,
        hasPrevCloseInput: true,
        tickerChanged,
        newTicker: ticker,
        defaultNewPrice: marketPrice,
      });
      const savedHolding = await ctx.engine.saveAsset({
        id: existing?.id,
        itemName: el<HTMLInputElement>('stName').value.trim(),
        majorType: '資產',
        updateMode: ticker ? '自動更新' : existing?.updateMode || '手動快照',
        subCategory: el<HTMLSelectElement>('stSub').value,
        liquidity: existing?.liquidity || '高流動',
        quantityOrAmount: shares,
        currency: currSel.value,
        ticker,
        ...priceFields,
        costBasis: hasCost ? totalCost : null,
        stockCategory: selectedStockCategory,
        isWatchlist: false,
        note: el<HTMLInputElement>('stNote').value.trim(),
      });
      if (isConverting) {
        ctx.state.stocksSubtab = 'holdings';
      }
      closeModal();
      showToast(
        isConverting ? '已從觀察清單轉為正式持股' : existing ? '已更新持股成本設定' : '已建立新持股',
        'success'
      );
      if (needsImmediateQuote(savedHolding)) {
        void refreshQuoteForAsset(ctx, savedHolding.id);
      } else {
        ctx.scheduleSync();
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}

/* ==================== Modal 2: 加碼買入 / 賣出減碼 ==================== */

export function openStockTradeModal(
  ctx: UiContext,
  asset: AssetItem,
  mode: 'buy' | 'sell'
): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const freshAsset = snap.assetItems.find((a) => a.id === asset.id && !a.deletedAt) || asset;
  const pos = computeStockPositionSummary(freshAsset, snap.stockTransactions || [], rate);
  const curr = freshAsset.currency || 'TWD';
  const isBuy = mode === 'buy';

  const body = openModal(`${isBuy ? '加碼買入' : '賣出減碼'} · ${freshAsset.itemName}`);

  // Current position banner
  const banner = document.createElement('div');
  banner.className = 'stock-live-preview tnum';
  banner.style.marginBottom = '12px';
  banner.textContent = `目前持有 ${fmtShares(pos.currentShares)} 股 ｜ 現價 ${fmtPrice(pos.marketPrice, ctx.state.masked, curr)} ｜ ${
    pos.hasCostBasis ? `原均價 ${fmtPrice(pos.avgCostPerShare, ctx.state.masked, curr)}` : '尚未設定期初成本'
  }`;
  body.appendChild(banner);

  const form = document.createElement('form');

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(makeInputField('交易日期', 'trDate', 'date', todayYmdLocal(), '', true));
  r1.appendChild(
    makeInputField(isBuy ? '買入股數（1張=1000）' : '賣出股數', 'trShares', 'number', '', '1000', true)
  );
  form.appendChild(r1);

  if (!isBuy && pos.currentShares > 0) {
    const quickRow = document.createElement('div');
    quickRow.className = 'quick-row';
    quickRow.style.marginBottom = '10px';
    for (const ratio of [
      { label: '賣一半', val: Math.floor(pos.currentShares / 2) },
      { label: '全部出清', val: pos.currentShares },
    ]) {
      if (ratio.val <= 0) continue;
      const qb = document.createElement('button');
      qb.type = 'button';
      qb.className = 'chip-btn sm tnum';
      qb.textContent = `${ratio.label} (${fmtShares(ratio.val)}股)`;
      qb.addEventListener('click', () => {
        const inp = el<HTMLInputElement>('trShares');
        inp.value = String(ratio.val);
        inp.dispatchEvent(new Event('input'));
      });
      quickRow.appendChild(qb);
    }
    form.appendChild(quickRow);
  }

  let inputMode: 'unit' | 'total' = ctx.state.stockPriceViewMode;
  const modeSeg = document.createElement('div');
  modeSeg.className = 'seg-bar';
  modeSeg.style.marginBottom = '10px';
  const unitBtn = document.createElement('button');
  unitBtn.type = 'button';
  unitBtn.className = 'seg-btn' + (inputMode === 'unit' ? ' active' : '');
  unitBtn.textContent = isBuy ? '輸入每股成交價（如 39）' : '輸入每股賣出價';
  const totalBtn = document.createElement('button');
  totalBtn.type = 'button';
  totalBtn.className = 'seg-btn' + (inputMode === 'total' ? ' active' : '');
  totalBtn.textContent = isBuy ? '輸入交割總額（如 39000）' : '輸入實拿總金額';
  modeSeg.appendChild(unitBtn);
  modeSeg.appendChild(totalBtn);
  form.appendChild(modeSeg);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  const amtField = makeInputField(
    inputMode === 'unit' ? (isBuy ? '每股成交價' : '每股賣出價') : isBuy ? '總投入金額' : '實拿總金額',
    'trAmount',
    'number',
    '',
    inputMode === 'unit' ? String(pos.marketPrice || 39) : '39000',
    true
  );
  const feeField = makeInputField(
    isBuy ? '手續費（選填）' : '手續費＋證交稅（選填）',
    'trFee',
    'number',
    '0',
    '0',
    false
  );
  r2.appendChild(amtField);
  r2.appendChild(feeField);
  form.appendChild(r2);

  const simBox = document.createElement('div');
  simBox.className = 'stock-live-preview tnum';
  simBox.style.display = 'none';
  form.appendChild(simBox);

  const warnBox = document.createElement('div');
  warnBox.className = 'stock-warn-box';
  warnBox.style.display = 'none';
  form.appendChild(warnBox);

  form.appendChild(makeInputField('備註（選填）', 'trNote', 'text', '', isBuy ? '例如：定期定額、逢低加碼' : '例如：部分獲利了結'));

  form.appendChild(
    buildSavingsLinkSection(
      ctx,
      'trSyncCf',
      'trLinkedAcc',
      isBuy ? '同步寫入流水帳（投資流出）並扣減活存' : '同步寫入流水帳（其他收入）並加計活存',
      isBuy ? '僅限「額外臨時加碼」勾選；定期定額已由固定收支扣款請勿重複勾選' : '賣出款項若要直接入帳活存可勾選',
      false
    )
  );

  if (isBuy) {
    const dupHint = document.createElement('div');
    dupHint.className = 'stock-live-preview tnum';
    dupHint.style.cssText = 'display:none;margin-top:8px;font-size:12px;line-height:1.55';
    form.appendChild(dupHint);

    const dateInp = form.querySelector<HTMLInputElement>('#trDate')!;
    const syncCb = form.querySelector<HTMLInputElement>('#trSyncCf')!;

    const refreshDupHint = () => {
      const ym = String(dateInp.value || todayYmdLocal()).slice(0, 7);
      const monthInvLogs = snap.cashflowLogs.filter(
        (l) => !l.deletedAt && l.yearMonth === ym && l.type === CASHFLOW_TYPES.INVESTMENT
      );
      const monthInvTotal = monthInvLogs.reduce((s, l) => s + l.twdAmount, 0);
      const hasAutoRecurringInv = monthInvLogs.some((l) => l.source === '自動入帳');
      const activeRecInvCount = snap.recurringItems.filter(
        (r) => !r.deletedAt && r.status === '啟用' && r.type === CASHFLOW_TYPES.INVESTMENT
      ).length;

      if (monthInvTotal <= 0 && activeRecInvCount === 0) {
        dupHint.style.display = 'none';
        return;
      }

      dupHint.style.display = 'block';
      const checked = syncCb.checked;
      dupHint.className = checked ? 'stock-warn-box tnum' : 'stock-live-preview tnum';

      if (monthInvTotal > 0) {
        const tag = hasAutoRecurringInv ? '（含每月固定排程入帳）' : '';
        dupHint.textContent = checked
          ? `⚠️ ${ym} 流水帳已有投資流出 ${fmtMoney(monthInvTotal, ctx.state.masked)}${tag}！若本次為定期定額請「取消勾選」以免重複扣款；若為額外加碼則可保留勾選。`
          : `💡 ${ym} 流水帳已有投資流出 ${fmtMoney(monthInvTotal, ctx.state.masked)}${tag}。定期定額請維持不勾選（只更新股數與均價，不重複扣款）。`;
      } else {
        dupHint.textContent = checked
          ? `⚠️ 你已有 ${activeRecInvCount} 筆啟用中的固定投資排程，若本次屬於定期定額請取消勾選以免重複計算。`
          : `💡 你已有 ${activeRecInvCount} 筆啟用中的固定投資排程；定期定額維持不勾選即可避免重複扣款。`;
      }
    };

    dateInp.addEventListener('change', refreshDupHint);
    syncCb.addEventListener('change', refreshDupHint);
    refreshDupHint();
  }

  const sharesInp = form.querySelector<HTMLInputElement>('#trShares')!;
  const amtInp = form.querySelector<HTMLInputElement>('#trAmount')!;
  const feeInp = form.querySelector<HTMLInputElement>('#trFee')!;
  const amtLbl = amtField.querySelector<HTMLLabelElement>('label')!;

  const computeTrade = () => {
    const shares = parseFloat(sharesInp.value) || 0;
    const rawAmt = parseFloat(amtInp.value) || 0;
    const fee = Math.max(0, parseFloat(feeInp.value) || 0);
    let totalAmount = 0;
    let impliedUnitPrice = 0;
    if (inputMode === 'unit') {
      impliedUnitPrice = rawAmt;
      totalAmount = isBuy ? shares * rawAmt + fee : Math.max(0, shares * rawAmt - fee);
    } else {
      totalAmount = rawAmt;
      impliedUnitPrice = shares > 0 ? rawAmt / shares : 0;
    }
    return {
      shares,
      fee,
      totalAmount: Math.round(totalAmount * 100) / 100,
      impliedUnitPrice,
    };
  };

  const refreshSim = () => {
    const { shares, totalAmount, impliedUnitPrice } = computeTrade();
    if (!(shares > 0) || !(totalAmount > 0)) {
      simBox.style.display = 'none';
      warnBox.style.display = 'none';
      return;
    }

    simBox.style.display = 'block';
    if (isBuy) {
      const nextShares = pos.currentShares + shares;
      const nextCost = (pos.hasCostBasis ? pos.costBasis : 0) + totalAmount;
      const nextAvg = nextShares > 0 ? nextCost / nextShares : 0;
      simBox.textContent =
        `總投入 ${fmtCurrencyAmount(totalAmount, curr, false)}（≈ ${fmtPrice(impliedUnitPrice, false, curr)}/股）` +
        (pos.hasCostBasis || pos.currentShares === 0
          ? ` → 買後持有 ${fmtShares(nextShares)} 股 · 新均價 ${fmtPrice(nextAvg, false, curr)}/股`
          : ` → 買後持有 ${fmtShares(nextShares)} 股`);
    } else {
      const sold = Math.min(shares, pos.currentShares);
      const removedCost = pos.hasCostBasis ? pos.avgCostPerShare * sold : 0;
      const realized = pos.hasCostBasis ? totalAmount - removedCost : 0;
      const nextShares = Math.max(0, pos.currentShares - sold);
      simBox.textContent =
        `實拿 ${fmtCurrencyAmount(totalAmount, curr, false)} → 剩餘 ${fmtShares(nextShares)} 股` +
        (pos.hasCostBasis
          ? ` ｜ 預估本次已實現損益 ${fmtSignedCurrency(realized, curr, false)}（剩餘均價維持 ${fmtPrice(pos.avgCostPerShare, false, curr)}）`
          : '');
    }

    const warnings: string[] = [];
    if (!isBuy && shares > pos.currentShares) {
      warnings.push(`賣出股數 (${fmtShares(shares)}) 超過目前持有股數 (${fmtShares(pos.currentShares)})！`);
    }
    if (isUnitPriceSuspicious(impliedUnitPrice, pos.marketPrice)) {
      warnings.push(
        `反推每股成交價 ${fmtPrice(impliedUnitPrice, false, curr)} 與現價 ${fmtPrice(pos.marketPrice, false, curr)} 落差極大，請確認輸入單位！`
      );
    }
    if (warnings.length) {
      warnBox.style.display = 'block';
      warnBox.textContent = '⚠️ ' + warnings.join(' ');
    } else {
      warnBox.style.display = 'none';
    }
  };

  const switchMode = (next: 'unit' | 'total') => {
    if (next === inputMode) return;
    const prev = computeTrade();
    inputMode = next;
    unitBtn.classList.toggle('active', inputMode === 'unit');
    totalBtn.classList.toggle('active', inputMode === 'total');
    amtLbl.textContent =
      inputMode === 'unit' ? (isBuy ? '每股成交價' : '每股賣出價') : isBuy ? '總投入金額' : '實拿總金額';
    amtInp.placeholder = inputMode === 'unit' ? String(pos.marketPrice || 39) : '39000';
    if (prev.shares > 0 && prev.totalAmount > 0) {
      amtInp.value =
        inputMode === 'unit'
          ? String(Math.round((prev.totalAmount / prev.shares) * 10000) / 10000)
          : String(prev.totalAmount);
    }
    refreshSim();
  };

  unitBtn.addEventListener('click', () => switchMode('unit'));
  totalBtn.addEventListener('click', () => switchMode('total'));
  sharesInp.addEventListener('input', refreshSim);
  amtInp.addEventListener('input', refreshSim);
  feeInp.addEventListener('input', refreshSim);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  submit.textContent = isBuy ? '確認加碼並累算成本' : '確認賣出並計入損益';
  btns.appendChild(cancel);
  btns.appendChild(submit);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const { shares, fee, totalAmount, impliedUnitPrice } = computeTrade();
    if (!isBuy && shares > pos.currentShares) {
      showToast(`賣出股數不可超過目前持有 ${fmtShares(pos.currentShares)} 股`, 'error');
      return;
    }
    if (isUnitPriceSuspicious(impliedUnitPrice, pos.marketPrice)) {
      if (
        !confirm(
          `反推每股成交價為 ${impliedUnitPrice.toFixed(2)}，與現價 ${pos.marketPrice.toFixed(2)} 相差超過 5 倍，確定仍要送出？`
        )
      ) {
        return;
      }
    }
    try {
      const syncToCashflow = el<HTMLInputElement>('trSyncCf').checked;
      const linkedAccountId = el<HTMLSelectElement>('trLinkedAcc').value || null;
      await ctx.engine.addStockTransaction({
        assetId: freshAsset.id,
        date: el<HTMLInputElement>('trDate').value,
        txType: isBuy ? STOCK_TX_TYPES.BUY : STOCK_TX_TYPES.SELL,
        shares,
        totalAmount,
        fee,
        note: el<HTMLInputElement>('trNote').value.trim(),
        syncToCashflow,
        linkedAccountId,
      });
      closeModal();
      showToast(
        `${isBuy ? '已加碼累算' : '已記錄賣出'} ${freshAsset.itemName} (${fmtShares(shares)} 股)${syncToCashflow ? ' ＋ 已同步流水帳' : ''}`,
        'success'
      );
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}

/* ==================== Modal 3: 登錄配息 / 配股 ==================== */

export function openStockDividendModal(ctx: UiContext, asset: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const freshAsset = snap.assetItems.find((a) => a.id === asset.id && !a.deletedAt) || asset;
  const pos = computeStockPositionSummary(freshAsset, snap.stockTransactions || [], rate);
  const curr = freshAsset.currency || 'TWD';

  const body = openModal(`登錄配息 / 配股 · ${freshAsset.itemName}`);

  let divKind: 'cash' | 'stock' = 'cash';
  const kindSeg = document.createElement('div');
  kindSeg.className = 'seg-bar';
  kindSeg.style.marginBottom = '12px';
  const cashKindBtn = document.createElement('button');
  cashKindBtn.type = 'button';
  cashKindBtn.className = 'seg-btn active';
  cashKindBtn.textContent = '💰 現金配息（扣成本）';
  const stockKindBtn = document.createElement('button');
  stockKindBtn.type = 'button';
  stockKindBtn.className = 'seg-btn';
  stockKindBtn.textContent = '📈 股票配股（增股數）';
  kindSeg.appendChild(cashKindBtn);
  kindSeg.appendChild(stockKindBtn);
  body.appendChild(kindSeg);

  const form = document.createElement('form');
  form.appendChild(makeInputField('入帳 / 除權息日期', 'dvDate', 'date', todayYmdLocal(), '', true));

  // Cash dividend section
  const cashSection = document.createElement('div');
  let cashInputMode: 'total' | 'per_share' = 'total';
  const cashModeSeg = document.createElement('div');
  cashModeSeg.className = 'seg-bar';
  cashModeSeg.style.marginBottom = '10px';
  const cashTotalBtn = document.createElement('button');
  cashTotalBtn.type = 'button';
  cashTotalBtn.className = 'seg-btn active';
  cashTotalBtn.textContent = '實領總配息（如 400）';
  const cashPerShareBtn = document.createElement('button');
  cashPerShareBtn.type = 'button';
  cashPerShareBtn.className = 'seg-btn';
  cashPerShareBtn.textContent = '每股配息（如 0.4）';
  cashModeSeg.appendChild(cashTotalBtn);
  cashModeSeg.appendChild(cashPerShareBtn);
  cashSection.appendChild(cashModeSeg);

  const cr = document.createElement('div');
  cr.className = 'row-2';
  const cashValField = makeInputField('現金配息總額', 'dvCashVal', 'number', '', '400', false);
  const cashFeeField = makeInputField('匯費 / 二代健保（選填）', 'dvCashFee', 'number', '0', '10', false);
  cr.appendChild(cashValField);
  cr.appendChild(cashFeeField);
  cashSection.appendChild(cr);

  const cashLinkBox = buildSavingsLinkSection(
    ctx,
    'dvSyncCf',
    'dvLinkedAcc',
    '同步寫入流水帳（股息/配息）並加計活存',
    '勾選後將自動記為「其他收入 → 股息/配息」',
    false
  );
  cashSection.appendChild(cashLinkBox);
  form.appendChild(cashSection);

  // Stock dividend section
  const stockSection = document.createElement('div');
  stockSection.style.display = 'none';
  let stockInputMode: 'shares' | 'yuan' = 'shares';
  const stockModeSeg = document.createElement('div');
  stockModeSeg.className = 'seg-bar';
  stockModeSeg.style.marginBottom = '10px';
  const stSharesBtn = document.createElement('button');
  stSharesBtn.type = 'button';
  stSharesBtn.className = 'seg-btn active';
  stSharesBtn.textContent = '實領配股股數（如 100 股）';
  const stYuanBtn = document.createElement('button');
  stYuanBtn.type = 'button';
  stYuanBtn.className = 'seg-btn';
  stYuanBtn.textContent = '每股配股元數（如 1.0 元）';
  stockModeSeg.appendChild(stSharesBtn);
  stockModeSeg.appendChild(stYuanBtn);
  stockSection.appendChild(stockModeSeg);

  const stockValField = makeInputField('配得股數（股）', 'dvStockVal', 'number', '', '100', false);
  stockSection.appendChild(stockValField);
  form.appendChild(stockSection);

  const previewBox = document.createElement('div');
  previewBox.className = 'stock-live-preview tnum';
  previewBox.style.marginBottom = '12px';
  form.appendChild(previewBox);

  form.appendChild(makeInputField('備註（選填）', 'dvNote', 'text', '', '例如：2026 Q2 配息'));

  const cashValInp = cashValField.querySelector<HTMLInputElement>('input')!;
  const cashValLbl = cashValField.querySelector<HTMLLabelElement>('label')!;
  const cashFeeInp = cashFeeField.querySelector<HTMLInputElement>('input')!;
  const stockValInp = stockValField.querySelector<HTMLInputElement>('input')!;
  const stockValLbl = stockValField.querySelector<HTMLLabelElement>('label')!;

  const computeDividend = () => {
    if (divKind === 'cash') {
      const raw = parseFloat(cashValInp.value) || 0;
      const fee = Math.max(0, parseFloat(cashFeeInp.value) || 0);
      const gross = cashInputMode === 'per_share' ? raw * pos.currentShares : raw;
      const net = Math.max(0, Math.round((cashInputMode === 'per_share' ? gross - fee : raw - fee) * 100) / 100);
      return { netCash: net, fee, stockShares: 0 };
    }
    const raw = parseFloat(stockValInp.value) || 0;
    const stockShares =
      stockInputMode === 'yuan' ? Math.floor((pos.currentShares * raw) / 10) : raw;
    return { netCash: 0, fee: 0, stockShares: Math.max(0, Math.round(stockShares * 10000) / 10000) };
  };

  const refreshPreview = () => {
    const { netCash, stockShares } = computeDividend();
    if (divKind === 'cash') {
      if (!(netCash > 0)) {
        previewBox.textContent = pos.hasCostBasis
          ? `目前持有 ${fmtShares(pos.currentShares)} 股 · 未回本成本 ${fmtCurrencyAmount(pos.unrecoveredCost, curr, false)}（已回本 ${fmtPct(pos.costRecoveryPct, 1)}）`
          : `目前持有 ${fmtShares(pos.currentShares)} 股 · 累計配息 ${fmtCurrencyAmount(pos.cumulativeCashDividends, curr, false)}`;
        return;
      }
      if (!pos.hasCostBasis) {
        previewBox.textContent = `本次實領配息 ${fmtCurrencyAmount(netCash, curr, false)} → 累計配息 ${fmtCurrencyAmount(pos.cumulativeCashDividends + netCash, curr, false)}`;
        return;
      }
      const nextCumDiv = pos.cumulativeCashDividends + netCash;
      const nextUnrecovered = Math.max(0, pos.costBasis - nextCumDiv);
      const nextExcess = Math.max(0, nextCumDiv - pos.costBasis);
      const nextPct =
        pos.costBasis > 0 ? Math.min(100, (nextCumDiv / pos.costBasis) * 100) : 100;
      previewBox.textContent =
        nextUnrecovered === 0
          ? `實領 ${fmtCurrencyAmount(netCash, curr, false)} → 🎉 成本已完全歸零（100%）` +
            (nextExcess > 0 ? ` · 超額回收 +${fmtCurrencyAmount(nextExcess, curr, false)}` : '')
          : `實領 ${fmtCurrencyAmount(netCash, curr, false)} → 未回本成本 ${fmtCurrencyAmount(pos.unrecoveredCost, curr, false)} → ${fmtCurrencyAmount(nextUnrecovered, curr, false)}（回本 ${fmtPct(nextPct, 1)}）`;
    } else {
      if (!(stockShares > 0)) {
        previewBox.textContent = `股票配股會增加持有股數、總投入成本不變，自動稀釋每股平均成本（目前 ${fmtShares(pos.currentShares)} 股）`;
        return;
      }
      const nextShares = pos.currentShares + stockShares;
      const nextAvg = pos.hasCostBasis && nextShares > 0 ? pos.costBasis / nextShares : 0;
      previewBox.textContent =
        `配得 +${fmtShares(stockShares)} 股 → 總股數 ${fmtShares(pos.currentShares)} → ${fmtShares(nextShares)} 股` +
        (pos.hasCostBasis
          ? ` ｜ 原始均價 ${fmtPrice(pos.avgCostPerShare, false, curr)} → ${fmtPrice(nextAvg, false, curr)}/股（總成本維持不變）`
          : '');
    }
  };

  const switchKind = (next: 'cash' | 'stock') => {
    divKind = next;
    cashKindBtn.classList.toggle('active', divKind === 'cash');
    stockKindBtn.classList.toggle('active', divKind === 'stock');
    cashSection.style.display = divKind === 'cash' ? 'block' : 'none';
    stockSection.style.display = divKind === 'stock' ? 'block' : 'none';
    refreshPreview();
  };

  cashKindBtn.addEventListener('click', () => switchKind('cash'));
  stockKindBtn.addEventListener('click', () => switchKind('stock'));

  cashTotalBtn.addEventListener('click', () => {
    cashInputMode = 'total';
    cashTotalBtn.classList.add('active');
    cashPerShareBtn.classList.remove('active');
    cashValLbl.textContent = '現金配息總額';
    cashValInp.placeholder = '400';
    refreshPreview();
  });
  cashPerShareBtn.addEventListener('click', () => {
    cashInputMode = 'per_share';
    cashPerShareBtn.classList.add('active');
    cashTotalBtn.classList.remove('active');
    cashValLbl.textContent = `每股配息（× ${fmtShares(pos.currentShares)} 股）`;
    cashValInp.placeholder = '0.4';
    refreshPreview();
  });

  stSharesBtn.addEventListener('click', () => {
    stockInputMode = 'shares';
    stSharesBtn.classList.add('active');
    stYuanBtn.classList.remove('active');
    stockValLbl.textContent = '配得股數（股）';
    stockValInp.placeholder = '100';
    refreshPreview();
  });
  stYuanBtn.addEventListener('click', () => {
    stockInputMode = 'yuan';
    stYuanBtn.classList.add('active');
    stSharesBtn.classList.remove('active');
    stockValLbl.textContent = `每股配股元數（每張配 元×100 股）`;
    stockValInp.placeholder = '1.0';
    refreshPreview();
  });

  cashValInp.addEventListener('input', refreshPreview);
  cashFeeInp.addEventListener('input', refreshPreview);
  stockValInp.addEventListener('input', refreshPreview);
  refreshPreview();

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  submit.textContent = '確認寫入配息/配股';
  btns.appendChild(cancel);
  btns.appendChild(submit);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const { netCash, fee, stockShares } = computeDividend();
    try {
      if (divKind === 'cash') {
        if (!(netCash > 0)) {
          showToast('請輸入大於 0 的現金配息金額', 'error');
          return;
        }
        const syncToCashflow = el<HTMLInputElement>('dvSyncCf').checked;
        const linkedAccountId = el<HTMLSelectElement>('dvLinkedAcc').value || null;
        await ctx.engine.addStockTransaction({
          assetId: freshAsset.id,
          date: el<HTMLInputElement>('dvDate').value,
          txType: STOCK_TX_TYPES.CASH_DIVIDEND,
          shares: 0,
          totalAmount: netCash,
          fee,
          note: el<HTMLInputElement>('dvNote').value.trim(),
          syncToCashflow,
          linkedAccountId,
        });
        closeModal();
        showToast(
          `已登錄現金配息 ${fmtCurrencyAmount(netCash, curr, ctx.state.masked)}${syncToCashflow ? ' ＋ 已同步流水帳' : ''}`,
          'success'
        );
      } else {
        if (!(stockShares > 0)) {
          showToast('請輸入大於 0 的配股股數', 'error');
          return;
        }
        await ctx.engine.addStockTransaction({
          assetId: freshAsset.id,
          date: el<HTMLInputElement>('dvDate').value,
          txType: STOCK_TX_TYPES.STOCK_DIVIDEND,
          shares: stockShares,
          totalAmount: 0,
          fee: 0,
          note: el<HTMLInputElement>('dvNote').value.trim(),
        });
        closeModal();
        showToast(`已登錄股票配股 +${fmtShares(stockShares)} 股，並自動重算均價`, 'success');
      }
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}

/* ==================== Modal 4: 交易明細與期初設定入口 ==================== */

function txTypeMeta(txType: StockTransaction['txType']): { label: string; cls: string } {
  if (txType === 'buy') return { label: '買入加碼', cls: 'badge' };
  if (txType === 'sell') return { label: '賣出減碼', cls: 'badge red' };
  if (txType === 'cash_dividend') return { label: '現金配息', cls: 'badge green' };
  return { label: '股票配股', cls: 'badge green' };
}

export function openStockHistoryModal(ctx: UiContext, asset: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const freshAsset = snap.assetItems.find((a) => a.id === asset.id && !a.deletedAt) || asset;
  const pos = computeStockPositionSummary(freshAsset, snap.stockTransactions || [], rate);
  const curr = freshAsset.currency || 'TWD';
  const masked = ctx.state.masked;

  const body = openModal(`${freshAsset.itemName} · 異動明細與成本`);

  // Baseline summary & edit button
  const baseCard = document.createElement('div');
  baseCard.className = 'stock-baseline-bar';
  const baseInfo = document.createElement('div');
  baseInfo.className = 'tnum';
  const baseTitle = document.createElement('div');
  baseTitle.style.cssText = 'font-size:13px;font-weight:700;color:var(--text)';
  baseTitle.textContent = `期初基準：${fmtShares(pos.baselineShares)} 股`;
  const baseSub = document.createElement('div');
  baseSub.className = 'muted';
  baseSub.textContent = pos.hasCostBasis
    ? `期初總成本 ${fmtCurrencyAmount(pos.baselineCostBasis, curr, masked)}（目前總計 ${fmtShares(pos.currentShares)} 股）`
    : '尚未設定期初成本';
  baseInfo.appendChild(baseTitle);
  baseInfo.appendChild(baseSub);

  const editBaseBtn = document.createElement('button');
  editBaseBtn.type = 'button';
  editBaseBtn.className = 'btn btn-outline btn-sm';
  editBaseBtn.textContent = '編輯期初/設定';
  editBaseBtn.addEventListener('click', () => openStockBaselineModal(ctx, freshAsset));

  baseCard.appendChild(baseInfo);
  baseCard.appendChild(editBaseBtn);
  body.appendChild(baseCard);

  // Transaction list
  const txs = (snap.stockTransactions || [])
    .filter((t) => !t.deletedAt && t.assetId === freshAsset.id)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  const listWrap = document.createElement('div');
  listWrap.className = 'savings-adj-list';
  listWrap.style.marginTop = '12px';
  listWrap.style.borderTop = 'none';
  listWrap.style.paddingTop = '0';

  const head = document.createElement('div');
  head.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:4px';
  head.textContent = `歷史買賣與配息/配股紀錄（共 ${txs.length} 筆）`;
  listWrap.appendChild(head);

  if (!txs.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '12px 2px';
    empty.textContent = '尚無買賣或配息/配股異動紀錄';
    listWrap.appendChild(empty);
  } else {
    for (const tx of txs) {
      const row = document.createElement('div');
      row.className = 'savings-adj-item';

      const info = document.createElement('div');
      info.style.minWidth = '0';

      const title = document.createElement('div');
      title.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:600';
      const meta = txTypeMeta(tx.txType);
      const badge = document.createElement('span');
      badge.className = meta.cls;
      badge.style.marginRight = '0';
      badge.textContent = meta.label;
      title.appendChild(badge);

      const descText =
        tx.txType === 'buy'
          ? `+${fmtShares(tx.shares)} 股 (@ ${fmtPrice(tx.shares > 0 ? tx.totalAmount / tx.shares : 0, masked, curr)})`
          : tx.txType === 'sell'
            ? `-${fmtShares(tx.shares)} 股 (@ ${fmtPrice(tx.shares > 0 ? tx.totalAmount / tx.shares : 0, masked, curr)})`
            : tx.txType === 'stock_dividend'
              ? `+${fmtShares(tx.shares)} 股（稀釋均價）`
              : '現金股利（扣未回本成本）';
      title.appendChild(document.createTextNode(descText));

      const sub = document.createElement('div');
      sub.className = 'muted tnum';
      const subParts = [tx.date];
      if (tx.fee > 0) subParts.push(`費用 ${fmtNum(tx.fee)}`);
      if (tx.linkedCashflowId) subParts.push('已連動流水帳');
      if (tx.note) subParts.push(tx.note);
      sub.textContent = subParts.join(' · ');

      info.appendChild(title);
      info.appendChild(sub);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
      const amt = document.createElement('span');
      amt.className = 'tnum';
      amt.style.fontWeight = '700';
      if (tx.txType === 'stock_dividend') {
        amt.style.color = 'var(--stock-pos)';
        amt.textContent = `+${fmtShares(tx.shares)}股`;
      } else {
        amt.style.color =
          tx.txType === 'cash_dividend' || tx.txType === 'sell' ? 'var(--stock-pos)' : 'var(--text)';
        amt.textContent =
          (tx.txType === 'cash_dividend' || tx.txType === 'sell' ? '+' : '') +
          fmtCurrencyAmount(tx.totalAmount, curr, masked);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn sm';
      delBtn.style.color = 'var(--text-muted)';
      delBtn.title = '刪除此筆異動';
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener('click', async () => {
        if (!confirm(`確定刪除 ${tx.date} 的「${meta.label}」紀錄？系統將立即重算股數與成本。`)) {
          return;
        }
        let deleteCf = false;
        if (tx.linkedCashflowId) {
          deleteCf = confirm('此筆紀錄曾同步寫入流水帳，是否一併刪除對應的流水帳紀錄？');
        }
        await ctx.engine.deleteStockTransaction(tx.id, deleteCf);
        showToast('已刪除異動並即時重算持股成本', 'success');
        ctx.scheduleSync();
        openStockHistoryModal(ctx, freshAsset);
      });

      right.appendChild(amt);
      right.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(right);
      listWrap.appendChild(row);
    }
  }

  body.appendChild(listWrap);
}

/* ==================== Modal 5: 單檔快速分類 & 分類管理 ==================== */

export function openQuickStockCategoryPicker(ctx: UiContext, asset: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const fresh = snap.assetItems.find((a) => a.id === asset.id && !a.deletedAt) || asset;
  const currentCat = normalizeStockCategory(fresh.stockCategory);
  const body = openModal(`設定持股分類 · ${fresh.itemName}`);

  const desc = document.createElement('div');
  desc.className = 'muted';
  desc.style.marginBottom = '12px';
  desc.textContent = '點擊下方標籤即可立即分類，方便在圓餅圖檢視「個股 / ETF / 特別股 / 自訂」佔比。';
  body.appendChild(desc);

  const chips = document.createElement('div');
  chips.className = 'quick-row';
  chips.style.marginBottom = '14px';

  const applyCat = async (nextCat: string) => {
    try {
      await ctx.engine.updateAssetStockCategory(fresh.id, nextCat);
      closeModal();
      showToast(nextCat ? `${fresh.itemName} 已歸類為「${nextCat}」` : `已清除 ${fresh.itemName} 的分類`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '分類更新失敗', 'error');
    }
  };

  const allCats = getAllStockCategories(ctx);
  for (const cat of allCats) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-btn' + (currentCat === cat ? ' active' : '');
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      void applyCat(cat);
    });
    chips.appendChild(btn);
  }
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'chip-btn' + (!currentCat ? ' active' : '');
  clearBtn.textContent = '未分類';
  clearBtn.addEventListener('click', () => {
    void applyCat('');
  });
  chips.appendChild(clearBtn);
  body.appendChild(chips);

  // Quick add custom category & apply
  const addWrap = document.createElement('div');
  addWrap.className = 'stock-cat-inline-add';
  addWrap.style.marginBottom = '12px';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.maxLength = 24;
  inp.placeholder = '新增自訂分類並立即套用（如 債券ETF）';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-primary btn-sm';
  addBtn.textContent = '+ 新增套用';
  addBtn.addEventListener('click', async () => {
    const cleaned = normalizeStockCategory(inp.value);
    if (!cleaned) {
      showToast('請輸入分類名稱', 'error');
      return;
    }
    const curCustom = ctx.engine.getSnapshot().settings.customStockCategories || [];
    if (!DEFAULT_STOCK_CATEGORIES.includes(cleaned) && !curCustom.includes(cleaned)) {
      await ctx.engine.saveCustomStockCategories([...curCustom, cleaned]);
    }
    await applyCat(cleaned);
  });
  addWrap.appendChild(inp);
  addWrap.appendChild(addBtn);
  body.appendChild(addWrap);

  const manageLink = document.createElement('button');
  manageLink.type = 'button';
  manageLink.className = 'btn btn-outline btn-block btn-sm';
  manageLink.textContent = '管理所有分類與批次設定持股';
  manageLink.addEventListener('click', () => openStockCategoryManagerModal(ctx));
  body.appendChild(manageLink);
}

export function openStockCategoryManagerModal(ctx: UiContext): void {
  const body = openModal('持股分類管理與快速標記');

  const renderContent = () => {
    body.innerHTML = '';
    const snap = ctx.engine.getSnapshot();
    const rate = snap.settings.usdTwdRate || 32.5;
    const portfolio = computeStockPortfolioSummary(
      snap.assetItems,
      snap.stockTransactions || [],
      rate
    );
    const customCats = snap.settings.customStockCategories || [];
    const allCats = getAllStockCategories(ctx);

    // Section 1: Category tags
    const s1 = document.createElement('div');
    s1.className = 'stock-cat-section';
    const s1Title = document.createElement('div');
    s1Title.className = 'section-label';
    s1Title.textContent = '分類標籤（預設：個股 / ETF / 特別股，可自由新增自訂分類）';
    s1.appendChild(s1Title);

    const tagRow = document.createElement('div');
    tagRow.className = 'quick-row';
    tagRow.style.marginBottom = '10px';

    for (const def of DEFAULT_STOCK_CATEGORIES) {
      const pill = document.createElement('span');
      pill.className = 'stock-cat-chip is-default';
      pill.textContent = def;
      tagRow.appendChild(pill);
    }

    for (const custom of customCats) {
      const pill = document.createElement('span');
      pill.className = 'stock-cat-chip is-custom';
      const txt = document.createElement('span');
      txt.textContent = custom;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'stock-cat-chip-del';
      del.textContent = '×';
      del.title = `刪除自訂分類「${custom}」`;
      del.addEventListener('click', async () => {
        const usingAssets = snap.assetItems.filter(
          (a) => !a.deletedAt && normalizeStockCategory(a.stockCategory) === custom
        );
        if (usingAssets.length > 0) {
          if (
            !confirm(
              `目前有 ${usingAssets.length} 檔持股使用「${custom}」。確定移除此自訂分類並將這些持股改為「未分類」？`
            )
          ) {
            return;
          }
          for (const a of usingAssets) {
            await ctx.engine.updateAssetStockCategory(a.id, '');
          }
        }
        const nextCustom = customCats.filter((c) => c !== custom);
        await ctx.engine.saveCustomStockCategories(nextCustom);
        showToast(`已移除自訂分類：${custom}`, 'success');
        ctx.scheduleSync();
        renderContent();
      });
      pill.appendChild(txt);
      pill.appendChild(del);
      tagRow.appendChild(pill);
    }
    s1.appendChild(tagRow);

    const addForm = document.createElement('form');
    addForm.className = 'stock-cat-inline-add';
    const addInp = document.createElement('input');
    addInp.type = 'text';
    addInp.maxLength = 24;
    addInp.placeholder = '輸入新分類名稱（如：債券ETF、高股息、美股科技）';
    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'btn btn-primary btn-sm';
    addBtn.textContent = '+ 新增分類';
    addForm.appendChild(addInp);
    addForm.appendChild(addBtn);
    bindSubmit(addForm, async (ev) => {
      ev.preventDefault();
      const cleaned = normalizeStockCategory(addInp.value);
      if (!cleaned) {
        showToast('請輸入分類名稱', 'error');
        return;
      }
      if (DEFAULT_STOCK_CATEGORIES.includes(cleaned) || customCats.includes(cleaned)) {
        showToast(`分類「${cleaned}」已存在`, 'error');
        return;
      }
      await ctx.engine.saveCustomStockCategories([...customCats, cleaned]);
      showToast(`已新增自訂分類：${cleaned}`, 'success');
      ctx.scheduleSync();
      renderContent();
    });
    s1.appendChild(addForm);
    body.appendChild(s1);

    // Section 2: Quick batch-tagging per stock
    const s2 = document.createElement('div');
    s2.className = 'stock-cat-section';
    const s2Title = document.createElement('div');
    s2Title.className = 'section-label';
    s2Title.textContent = `快速標記各檔持股（共 ${portfolio.positions.length} 檔，點一下立即儲存）`;
    s2.appendChild(s2Title);

    if (!portfolio.positions.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = '目前尚未建立股票持股';
      s2.appendChild(empty);
    } else {
      const rows = document.createElement('div');
      rows.className = 'stock-cat-batch-list';

      for (const pos of portfolio.positions) {
        const row = document.createElement('div');
        row.className = 'cat-manage-row';

        const header = document.createElement('div');
        header.className = 'cat-manage-head';
        const nm = document.createElement('strong');
        nm.textContent = pos.asset.itemName;
        header.appendChild(nm);
        if (pos.asset.ticker) {
          const tk = document.createElement('span');
          tk.className = 'badge';
          tk.style.marginRight = '0';
          tk.textContent = pos.asset.ticker;
          header.appendChild(tk);
        }
        row.appendChild(header);

        const curCat = normalizeStockCategory(pos.asset.stockCategory);
        const pillWrap = document.createElement('div');
        pillWrap.className = 'quick-row';

        const choices: Array<{ label: string; value: string }> = [
          ...allCats.map((c) => ({ label: c, value: c })),
          { label: '未分類', value: '' },
        ];
        for (const ch of choices) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip-btn sm' + (curCat === ch.value ? ' active' : '');
          b.textContent = ch.label;
          b.addEventListener('click', async () => {
            await ctx.engine.updateAssetStockCategory(pos.asset.id, ch.value);
            ctx.scheduleSync();
            renderContent();
          });
          pillWrap.appendChild(b);
        }
        row.appendChild(pillWrap);
        rows.appendChild(row);
      }
      s2.appendChild(rows);
    }
    body.appendChild(s2);

    const footerBtn = document.createElement('button');
    footerBtn.type = 'button';
    footerBtn.className = 'btn btn-primary btn-block';
    footerBtn.style.marginTop = '12px';
    footerBtn.textContent = '完成並檢視「持股分類」圖表';
    footerBtn.addEventListener('click', () => {
      ctx.state.stockChartDimension = 'category';
      ctx.state.stockChartHighlight = null;
      localStorage.setItem('finance_stock_chart_dim', 'category');
      closeModal();
      renderStocksTab(ctx);
    });
    body.appendChild(footerBtn);
  };

  renderContent();
}
