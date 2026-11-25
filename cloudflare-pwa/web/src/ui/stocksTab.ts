import { CASHFLOW_TYPES, DEFAULT_STOCK_CATEGORIES, STOCK_TX_TYPES } from '../../../shared/constants';
import {
  computeAllSavingsSummary,
  computeStockPortfolioSummary,
  computeStockPositionSummary,
} from '../../../shared/calculations';
import type { AssetItem, StockPositionSummary, StockTransaction } from '../../../shared/types';
import { normalizeStockCategory } from '../../../shared/validation';
import {
  closeModal,
  el,
  fmtMoney,
  fmtNum,
  makeInputField,
  makeSelectField,
  openModal,
  showToast,
  TRASH_SVG,
} from './helpers';
import { renderReorderList } from './reorderHelper';
import { renderStockChartCard } from './stockCharts';
import type { UiContext } from './state';

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

function todayYmdLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtPrice(n: number, masked: boolean, currency = 'TWD'): string {
  if (masked) return '•••';
  const num = Number(n || 0);
  const prefix = currency === 'USD' ? 'US$' : '';
  return prefix + num.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCurrencyAmount(n: number, currency: string, masked: boolean): string {
  if (masked) return (currency === 'USD' ? 'US$' : 'NT$ ') + '•••••';
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (currency === 'USD') {
    return `${sign}US$${abs.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}NT$ ${Math.round(abs).toLocaleString('zh-TW')}`;
}

function fmtSignedCurrency(n: number, currency: string, masked: boolean): string {
  if (masked) return '•••••';
  const num = Number(n || 0);
  if (num > 0) return '+' + fmtCurrencyAmount(num, currency, false);
  if (num < 0) return fmtCurrencyAmount(num, currency, false);
  return fmtCurrencyAmount(0, currency, false);
}

function fmtSignedPct(pct: number, masked: boolean): string {
  if (masked) return '••%';
  const num = Number(pct || 0);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(1)}%`;
}

function fmtShares(shares: number): string {
  return Number(shares || 0).toLocaleString('zh-TW', { maximumFractionDigits: 4 });
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
  const masked = ctx.state.masked;
  const viewMode = ctx.state.stockPriceViewMode;

  document.querySelectorAll<HTMLButtonElement>('#stockViewModeToggle .mini-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.stockView === viewMode);
  });

  el('stocksCountBadge').textContent = `${portfolio.positions.length} 檔`;
  el('stocksMarketValueHero').textContent = fmtMoney(portfolio.totalMarketValueTwd, masked);

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
    portfolio.overallCostRecoveryPct >= 100 ? 'var(--success)' : 'var(--primary)';
  recoveryPctText.textContent = `整體配息回本：${portfolio.overallCostRecoveryPct.toFixed(1)}%`;
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

  // Render stock allocation chart card
  renderStockChartCard(ctx, portfolio, el('stocksChartCard'), {
    onManageCategories: () => openStockCategoryManagerModal(ctx),
  });

  // Reorder button visibility
  const reorderBtn = el<HTMLButtonElement>('reorderStocksBtn');
  const isReordering = ctx.state.reorderSection === 'stocks';
  reorderBtn.style.display = portfolio.positions.length >= 2 && !isReordering ? '' : 'none';

  // Render stock cards list (or reorder editor)
  const list = el('stocksPortfolioList');
  list.innerHTML = '';

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
    list.appendChild(empty);
    return;
  }

  if (isReordering && portfolio.positions.length >= 2) {
    renderReorderList(ctx, {
      container: list,
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
    list.appendChild(renderStockPositionCard(ctx, pos, weightPct));
  }
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
    wtBadge.textContent = `佔 ${weightPct.toFixed(1)}%`;
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
    recBadge.className = 'badge green';
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
  subRow.textContent =
    viewMode === 'unit'
      ? `持有 ${fmtShares(pos.currentShares)} 股${lotsHint} · 市值 ${fmtCurrencyAmount(pos.marketValue, curr, masked)}`
      : `持有 ${fmtShares(pos.currentShares)} 股${lotsHint} · 現價 ${fmtPrice(pos.marketPrice, masked, curr)}`;

  left.appendChild(titleRow);
  left.appendChild(subRow);

  const right = document.createElement('div');
  right.className = 'stock-head-right tnum';
  const primaryVal = document.createElement('div');
  primaryVal.className = 'stock-head-val';
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
    card.appendChild(grid);

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
      fill.style.background = pos.isCostRecovered ? 'var(--success)' : 'var(--primary)';
      track.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'stock-recovery-meta tnum';
      const parts: string[] = [];
      if (pos.cumulativeCashDividends > 0) {
        parts.push(`配息回本 ${pos.costRecoveryPct.toFixed(1)}%`);
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

  // Action buttons row
  const actions = document.createElement('div');
  actions.className = 'stock-card-actions';

  const buyBtn = document.createElement('button');
  buyBtn.type = 'button';
  buyBtn.className = 'btn btn-tinted btn-sm';
  buyBtn.textContent = '+ 加碼';
  buyBtn.addEventListener('click', () => openStockTradeModal(ctx, pos.asset, 'buy'));

  const divBtn = document.createElement('button');
  divBtn.type = 'button';
  divBtn.className = 'btn btn-tinted btn-sm';
  divBtn.textContent = '配息/配股';
  divBtn.addEventListener('click', () => openStockDividendModal(ctx, pos.asset));

  const sellBtn = document.createElement('button');
  sellBtn.type = 'button';
  sellBtn.className = 'btn btn-outline btn-sm';
  sellBtn.textContent = '賣出';
  sellBtn.addEventListener('click', () => openStockTradeModal(ctx, pos.asset, 'sell'));

  const histBtn = document.createElement('button');
  histBtn.type = 'button';
  histBtn.className = 'btn btn-outline btn-sm';
  histBtn.textContent = pos.transactionCount > 0 ? `明細 (${pos.transactionCount})` : '設成本';
  histBtn.addEventListener('click', () =>
    pos.transactionCount > 0
      ? openStockHistoryModal(ctx, pos.asset)
      : openStockBaselineModal(ctx, pos.asset)
  );

  actions.appendChild(buyBtn);
  actions.appendChild(divBtn);
  actions.appendChild(sellBtn);
  actions.appendChild(histBtn);
  card.appendChild(actions);

  return card;
}

/* ==================== Modal 1: 新增持股 / 編輯期初成本 ==================== */

export function openStockBaselineModal(ctx: UiContext, existing: AssetItem | null): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const pos = existing
    ? computeStockPositionSummary(existing, snap.stockTransactions || [], rate)
    : null;

  const body = openModal(existing ? `期初成本與設定 · ${existing.itemName}` : '新增股票持股');
  const form = document.createElement('form');

  if (pos && pos.transactionCount > 0) {
    const info = document.createElement('div');
    info.className = 'stock-live-preview tnum';
    info.style.marginBottom = '12px';
    info.textContent = `目前含 ${pos.transactionCount} 筆交易後推算總股數為 ${fmtShares(pos.currentShares)} 股。下方「期初股數／期初成本」代表歷史起算基準。`;
    form.appendChild(info);
  }

  const r0 = document.createElement('div');
  r0.className = 'row-2';
  r0.appendChild(
    makeInputField('股票名稱', 'stName', 'text', existing?.itemName || '', '例如：0050、台積電', true)
  );
  r0.appendChild(
    makeInputField('股票代碼（自動更新行情）', 'stTicker', 'text', existing?.ticker || '', '如 TPE:0050 或 2330')
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
      existing?.quantityOrAmount ?? '',
      '1000',
      true
    )
  );
  r2.appendChild(
    makeInputField('目前市價（每股）', 'stPrice', 'number', existing?.unitPrice ?? '', '40', true)
  );
  form.appendChild(r2);

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

  unitBtn.addEventListener('click', () => switchCostMode('unit'));
  totalBtn.addEventListener('click', () => switchCostMode('total'));
  sharesInp.addEventListener('input', refreshPreview);
  priceInp.addEventListener('input', refreshPreview);
  costInp.addEventListener('input', refreshPreview);
  currSel.addEventListener('change', refreshPreview);
  refreshPreview();

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';
  if (existing) {
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
  saveBtn.textContent = existing ? '儲存持股成本' : '建立持股';
  btns.appendChild(saveBtn);
  form.appendChild(btns);

  form.addEventListener('submit', async (e) => {
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
      await ctx.engine.saveAsset({
        id: existing?.id,
        itemName: el<HTMLInputElement>('stName').value.trim(),
        majorType: '資產',
        updateMode: ticker ? '自動更新' : existing?.updateMode || '手動快照',
        subCategory: el<HTMLSelectElement>('stSub').value,
        liquidity: existing?.liquidity || '高流動',
        quantityOrAmount: shares,
        currency: currSel.value,
        ticker,
        unitPrice: marketPrice,
        costBasis: hasCost ? totalCost : null,
        stockCategory: selectedStockCategory,
        note: el<HTMLInputElement>('stNote').value.trim(),
      });
      closeModal();
      showToast(existing ? '已更新持股成本設定' : '已建立新持股', 'success');
      ctx.scheduleSync();
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

  form.addEventListener('submit', async (e) => {
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
          ? `目前持有 ${fmtShares(pos.currentShares)} 股 · 未回本成本 ${fmtCurrencyAmount(pos.unrecoveredCost, curr, false)}（已回本 ${pos.costRecoveryPct.toFixed(1)}%）`
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
          : `實領 ${fmtCurrencyAmount(netCash, curr, false)} → 未回本成本 ${fmtCurrencyAmount(pos.unrecoveredCost, curr, false)} → ${fmtCurrencyAmount(nextUnrecovered, curr, false)}（回本 ${nextPct.toFixed(1)}%）`;
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

  form.addEventListener('submit', async (e) => {
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
    addForm.addEventListener('submit', async (ev) => {
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
