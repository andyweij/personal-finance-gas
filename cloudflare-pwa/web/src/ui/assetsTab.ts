import { todayInTimeZone } from '../../../shared/dates';
import { ASSET_SUB_CATEGORIES, DEFAULT_LEDGER_ID } from '../../../shared/constants';
import {
  compareBySortOrder,
  computeAllSavingsSummary,
  computeAssetEffectiveTwdValue,
  computeLoanAmortizationSchedule,
  computeLoanAmortizationSummary,
  computeNetWorthSummary,
  computeSavingsAccountSummary,
  computeStockPositionSummary,
  filterAssetsByLedgerScope,
  getEffectiveLedgerId,
  isStockAsset,
  isTransferableAccount,
  solveImpliedLoanAnnualRate,
} from '../../../shared/calculations';
import type { AssetItem } from '../../../shared/types';
import { resolveStockModalPriceFields } from '../../../shared/validation';
import {
  closeModal,
  el,
  escapeHtml,
  fmtMoney,
  fmtNum,
  fmtRaw,
  makeInputField,
  makeSelectField,
  openModal,
  showToast,
  TRASH_SVG, fmtPct, bindSubmit } from './helpers';
import { buildLedgerSelectField, getActiveLedgers, renderLedgerSwitcherBar } from './ledgerUi';
import { renderReorderList } from './reorderHelper';
import type { UiContext } from './state';

function resolveAssetsScope(ctx: UiContext): string {
  const ledgers = getActiveLedgers(ctx);
  const scope = ctx.state.assetsLedgerScope || 'net_worth';
  if (scope === 'net_worth' || scope === 'all') return scope;
  if (ledgers.some((l) => l.id === scope)) return scope;
  ctx.state.assetsLedgerScope = 'net_worth';
  return 'net_worth';
}

export function getAssetSectionIds(
  ctx: UiContext,
  section: 'assets_savings' | 'assets_auto' | 'assets_manual'
): string[] {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);
  const scope = resolveAssetsScope(ctx);
  const active = filterAssetsByLedgerScope(snap.assetItems, scope, ledgers)
    .slice()
    .sort(compareBySortOrder);
  if (section === 'assets_savings') {
    return active.filter((a) => a.isLinkedSavings).map((a) => a.id);
  }
  if (section === 'assets_auto') {
    return active
      .filter((a) => !a.isLinkedSavings && !(a.majorType === '負債' && a.isAmortizingLoan) && a.updateMode === '自動更新')
      .map((a) => a.id);
  }
  return active
    .filter((a) => !a.isLinkedSavings && ((a.majorType === '負債' && a.isAmortizingLoan) || a.updateMode !== '自動更新'))
    .map((a) => a.id);
}

function todayYmdLocal(): string {
  return todayInTimeZone(); // v1.8.15: "today" is the APP_TIMEZONE date, like the server
}

function fmtSignedMoney(n: number, masked: boolean): string {
  if (masked) return '•••••';
  n = Math.round(Number(n) || 0); // v1.8.15: sign of the displayed (whole-dollar) value
  if (n > 0) return '+' + fmtMoney(n, false, '');
  if (n < 0) return '-' + fmtMoney(Math.abs(n), false, '');
  return '0';
}

export function renderAssetsTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate;
  const ledgers = getActiveLedgers(ctx);
  const scope = resolveAssetsScope(ctx);

  renderLedgerSwitcherBar(ctx, el('assetsLedgerBar'), {
    mode: 'scope',
    selectedValue: scope,
    onSelect: (nextScope) => {
      ctx.state.assetsLedgerScope = nextScope;
      renderAssetsTab(ctx);
    },
  });

  const selectedLedger = ledgers.find((l) => l.id === scope) || null;
  const heroTitleEl = el('assetsHeroTitle');
  const bannerEl = el('assetsIsolatedBanner');
  if (scope === 'net_worth') {
    heroTitleEl.textContent = '整合淨資產 (TWD)';
    bannerEl.style.display = 'none';
  } else if (scope === 'all') {
    heroTitleEl.textContent = '全部帳本合併淨資產 (TWD)';
    bannerEl.style.display = 'flex';
    bannerEl.textContent = '目前為「全部合併」檢視（包含獨立帳本與單獨排除項目），僅供盤點參考，不影響個人總淨值快照';
  } else if (selectedLedger) {
    heroTitleEl.textContent = `${selectedLedger.name} · 帳本淨值 (TWD)`;
    if (!selectedLedger.includeInNetWorth) {
      bannerEl.style.display = 'flex';
      bannerEl.textContent = `獨立帳本「${selectedLedger.name}」：此帳本所有資產與活存皆不計入個人總資產與淨值`;
    } else {
      bannerEl.style.display = 'none';
    }
  }

  const activeAssets = filterAssetsByLedgerScope(snap.assetItems, scope, ledgers)
    .slice()
    .sort(compareBySortOrder);
  const adjustments = snap.savingsAdjustments || [];
  const stockTxs = snap.stockTransactions || [];
  const nw = computeNetWorthSummary(
    snap.assetItems,
    rate,
    0,
    snap.cashflowLogs,
    adjustments,
    stockTxs,
    undefined,
    ledgers,
    scope
  );

  el('netWorthHero').textContent = fmtMoney(nw.netWorth, ctx.state.masked);
  el('totalAssetsText').textContent = fmtMoney(nw.totalAssets, ctx.state.masked);
  el('totalLiabText').textContent = fmtMoney(nw.totalLiabilities, ctx.state.masked);
  el('debtRatioBadge').textContent = `負債比 ${fmtPct(nw.debtRatio, 1)}`;

  document.querySelectorAll<HTMLButtonElement>('#allocModeToggle .mini-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.allocMode === ctx.state.allocMode);
  });

  const alloc = [
    { key: 'stock', name: '股票', val: nw.stockValue, color: '#4E8FE6' },
    { key: 'cash', name: '活存 / 現金 / 美金', val: nw.cashUsdValue, color: '#34C759' },
    { key: 'fund', name: '基金 / 結構', val: nw.fundStructuredValue, color: '#FF9500' },
    { key: 'ins', name: '保單保價金', val: nw.insuranceValue, color: '#5856D6' },
  ];
  if (nw.otherAssetsValue > 0) {
    alloc.push({ key: 'other', name: '其他資產', val: nw.otherAssetsValue, color: '#8E8E93' });
  }

  const bar = el('allocBar');
  const legend = el('allocLegend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  const base = Math.max(1, nw.totalAssets);

  for (const a of alloc) {
    const pctNum = nw.totalAssets > 0 ? (a.val / base) * 100 : 0;
    const pctStr = fmtPct(pctNum, 1);
    const isHl = ctx.state.allocHighlight === a.key;
    const isDim = Boolean(ctx.state.allocHighlight && !isHl);

    if (pctNum > 0) {
      const seg = document.createElement('div');
      seg.className = 'alloc-seg';
      seg.style.width = `${pctNum}%`;
      seg.style.background = a.color;
      seg.style.opacity = isDim ? '0.26' : '1';
      seg.title = `${a.name}：${pctStr}`;
      seg.addEventListener('click', () => {
        ctx.state.allocHighlight = isHl ? null : a.key;
        renderAssetsTab(ctx);
      });
      bar.appendChild(seg);
    }

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'alloc-tile' + (isHl ? ' highlighted' : '') + (isDim ? ' dimmed' : '');

    const head = document.createElement('div');
    head.className = 'alloc-tile-head';
    const dot = document.createElement('span');
    dot.className = 'alloc-dot';
    dot.style.background = a.color;
    head.appendChild(dot);
    head.appendChild(document.createTextNode(a.name));
    tile.appendChild(head);

    if (ctx.state.allocMode === 'both') {
      const v1 = document.createElement('div');
      v1.className = 'alloc-primary-val';
      v1.textContent = fmtMoney(a.val, ctx.state.masked);
      const v2 = document.createElement('div');
      v2.className = 'alloc-secondary-val';
      v2.textContent = `佔比 ${pctStr}`;
      tile.appendChild(v1);
      tile.appendChild(v2);
    } else if (ctx.state.allocMode === 'pct') {
      const v1 = document.createElement('div');
      v1.className = 'alloc-primary-val';
      v1.style.fontSize = '18px';
      v1.textContent = pctStr;
      tile.appendChild(v1);
    } else {
      const v1 = document.createElement('div');
      v1.className = 'alloc-primary-val';
      v1.textContent = fmtMoney(a.val, ctx.state.masked);
      tile.appendChild(v1);
    }

    tile.addEventListener('click', () => {
      ctx.state.allocHighlight = isHl ? null : a.key;
      renderAssetsTab(ctx);
    });
    legend.appendChild(tile);
  }

  // ==================== 活存帳戶區（與流水帳即時連動） ====================
  const savings = computeAllSavingsSummary(activeAssets, snap.cashflowLogs, adjustments, rate);
  el('assetsSavingsTotalLabel').textContent = `合計 ${fmtMoney(savings.totalSavingsTwd, ctx.state.masked)}`;
  const savReorderBtn = el<HTMLButtonElement>('reorderSavingsBtn');
  const isReorderingSavings = ctx.state.reorderSection === 'assets_savings';
  savReorderBtn.style.display = savings.accounts.length >= 2 && !isReorderingSavings ? '' : 'none';

  const savList = el('savingsAccountsList');
  savList.innerHTML = '';

  if (isReorderingSavings && savings.accounts.length >= 2) {
    renderReorderList(ctx, {
      container: savList,
      section: 'assets_savings',
      items: savings.accounts.map((s) => ({
        id: s.account.id,
        title: s.account.itemName,
        badge: s.account.isDefaultSavings ? '★ 預設' : s.account.currency,
        subtitle: `即時餘額 ${fmtMoney(s.currentBalanceTwd, ctx.state.masked)}`,
      })),
      onSave: (orderedIds) => ctx.engine.reorderAssets(orderedIds),
      onReRender: () => renderAssetsTab(ctx),
    });
  } else if (!savings.accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.style.display = 'flex';
    empty.style.flexDirection = 'column';
    empty.style.alignItems = 'center';
    empty.style.gap = '10px';
    const txt = document.createElement('div');
    txt.textContent = '尚未建立連動活存帳戶（支援多帳戶累加與流水帳即時扣減）';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-tinted btn-sm';
    addBtn.textContent = '+ 建立第一個活存帳戶';
    addBtn.addEventListener('click', () => openSavingsAccountModal(ctx, null));
    empty.appendChild(txt);
    empty.appendChild(addBtn);
    savList.appendChild(empty);
  } else {
    for (const s of savings.accounts) {
      const row = document.createElement('div');
      row.className = 'savings-acc-row';

      const top = document.createElement('div');
      top.className = 'savings-acc-top';

      const main = document.createElement('div');
      main.className = 'item-main';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.style.display = 'flex';
      title.style.alignItems = 'center';
      title.style.gap = '6px';
      title.style.flexWrap = 'wrap';
      title.appendChild(document.createTextNode(s.account.itemName));
      if (s.account.isDefaultSavings) {
        const defBadge = document.createElement('span');
        defBadge.className = 'badge green';
        defBadge.style.marginRight = '0';
        defBadge.textContent = '★ 預設連動';
        title.appendChild(defBadge);
      }
      if (s.account.currency === 'USD') {
        const currBadge = document.createElement('span');
        currBadge.className = 'badge';
        currBadge.style.marginRight = '0';
        currBadge.textContent = 'USD';
        title.appendChild(currBadge);
      }

      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      sub.textContent = `基準 ${fmtMoney(s.baseBalanceTwd, ctx.state.masked)} (${s.account.balanceAnchorDate || '起算'}) · 存轉 ${fmtSignedMoney(s.adjustmentsTotalTwd, ctx.state.masked)} (${s.adjustmentCount}筆) · 流水帳 ${fmtSignedMoney(s.cashflowNetTwd, ctx.state.masked)} (${s.linkedLogCount}筆)`;
      main.appendChild(title);
      main.appendChild(sub);

      const bal = document.createElement('div');
      bal.className = 'savings-acc-bal tnum' + (s.currentBalanceTwd < 0 ? ' neg' : '');
      bal.textContent = fmtMoney(s.currentBalanceTwd, ctx.state.masked);

      top.appendChild(main);
      top.appendChild(bal);

      const actions = document.createElement('div');
      actions.className = 'savings-acc-actions';

      const adjBtn = document.createElement('button');
      adjBtn.type = 'button';
      adjBtn.className = 'btn btn-tinted btn-sm';
      adjBtn.textContent = '+ 存入 / 轉出';
      adjBtn.addEventListener('click', () => openSavingsAdjustmentModal(ctx, s.account));

      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'btn btn-outline btn-sm';
      recBtn.textContent = '對帳校準';
      recBtn.addEventListener('click', () => openReconcileModal(ctx, s.account));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => openSavingsAccountModal(ctx, s.account));

      actions.appendChild(adjBtn);
      actions.appendChild(recBtn);
      actions.appendChild(editBtn);

      row.appendChild(top);
      row.appendChild(actions);
      savList.appendChild(row);
    }
  }

  // ==================== 一般資產與負債（排除已顯示於活存區的連動帳戶） ====================
  const autoList = el('autoAssetsList');
  const manualList = el('manualAssetsList');
  autoList.innerHTML = '';
  manualList.innerHTML = '';

  const autoItems: AssetItem[] = [];
  const manualItems: AssetItem[] = [];
  for (const item of activeAssets) {
    if (item.isLinkedSavings) continue;
    if (item.majorType === '負債' && item.isAmortizingLoan) {
      manualItems.push(item);
    } else if (item.updateMode === '自動更新') {
      autoItems.push(item);
    } else {
      manualItems.push(item);
    }
  }

  const autoReorderBtn = el<HTMLButtonElement>('reorderAutoAssetsBtn');
  const isReorderingAuto = ctx.state.reorderSection === 'assets_auto';
  autoReorderBtn.style.display = autoItems.length >= 2 && !isReorderingAuto ? '' : 'none';

  const manualReorderBtn = el<HTMLButtonElement>('reorderManualAssetsBtn');
  const isReorderingManual = ctx.state.reorderSection === 'assets_manual';
  manualReorderBtn.style.display = manualItems.length >= 2 && !isReorderingManual ? '' : 'none';

  const todayYmd = todayYmdLocal();

  if (isReorderingAuto && autoItems.length >= 2) {
    renderReorderList(ctx, {
      container: autoList,
      section: 'assets_auto',
      items: autoItems.map((item) => {
        const twdVal = computeAssetEffectiveTwdValue(item, rate, snap.cashflowLogs, adjustments, stockTxs, todayYmd);
        return {
          id: item.id,
          title: item.itemName,
          badge: item.ticker || item.subCategory,
          subtitle: `市值 ${fmtMoney(twdVal, ctx.state.masked)}`,
        };
      }),
      onSave: (orderedIds) => ctx.engine.reorderAssets(orderedIds),
      onReRender: () => renderAssetsTab(ctx),
    });
  } else if (!autoItems.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '尚無自動更新資產';
    autoList.appendChild(e);
  } else {
    for (const item of autoItems) {
      const isStock = isStockAsset(item);
      const stockPos = isStock ? computeStockPositionSummary(item, stockTxs, rate) : null;
      const twdVal = computeAssetEffectiveTwdValue(item, rate, snap.cashflowLogs, adjustments, stockTxs, todayYmd);
      const row = document.createElement('div');
      row.className = 'list-row';

      const main = document.createElement('div');
      main.className = 'item-main';
      const t = document.createElement('div');
      t.className = 'item-title';
      t.textContent = item.itemName;
      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      const b = document.createElement('span');
      b.className = 'badge' + (item.majorType === '負債' ? ' red' : ' green');
      b.textContent = item.subCategory;
      sub.appendChild(b);
      const displayQty = stockPos ? stockPos.currentShares : item.quantityOrAmount;
      const detail = item.ticker || isStock
        ? `${item.ticker ? item.ticker + ' · ' : ''}${fmtNum(displayQty)} 股 @ ${item.unitPrice}`
        : item.currency === 'USD'
          ? fmtRaw(item.quantityOrAmount, 'USD', ctx.state.masked)
          : item.liquidity;
      sub.appendChild(document.createTextNode(detail));
      if (stockPos && stockPos.hasCostBasis) {
        sub.appendChild(document.createTextNode(' · '));
        const pnlSpan = document.createElement('span');
        pnlSpan.style.fontWeight = '600';
        pnlSpan.style.color =
          stockPos.totalReturnPnlTwd > 0
            ? 'var(--stock-pos)'
            : stockPos.totalReturnPnlTwd < 0
              ? 'var(--stock-neg)'
              : 'var(--text-secondary)';
        pnlSpan.textContent = `含息 ${fmtSignedMoney(stockPos.totalReturnPnlTwd, ctx.state.masked)}`;
        sub.appendChild(pnlSpan);
      }
      main.appendChild(t);
      main.appendChild(sub);

      const right = document.createElement('div');
      right.className = 'item-right';
      const amt = document.createElement('div');
      amt.className = 'item-amount';
      amt.style.color = item.majorType === '負債' ? 'var(--neg)' : 'var(--text)';
      amt.textContent = (item.majorType === '負債' ? '-' : '') + fmtMoney(twdVal, ctx.state.masked);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = isStock ? '持股頁' : '更新';
      editBtn.addEventListener('click', () => {
        if (isStock) ctx.navigateToTab('stocks');
        else openAssetModal(ctx, item);
      });

      right.appendChild(amt);
      right.appendChild(editBtn);
      row.appendChild(main);
      row.appendChild(right);
      autoList.appendChild(row);
    }
  }

  if (isReorderingManual && manualItems.length >= 2) {
    renderReorderList(ctx, {
      container: manualList,
      section: 'assets_manual',
      items: manualItems.map((item) => {
        const twdVal = computeAssetEffectiveTwdValue(item, rate, snap.cashflowLogs, adjustments, stockTxs, todayYmd);
        return {
          id: item.id,
          title: item.itemName,
          badge: item.subCategory,
          subtitle: `${item.majorType === '負債' ? '負債 -' : ''}${fmtMoney(twdVal, ctx.state.masked)}`,
        };
      }),
      onSave: (orderedIds) => ctx.engine.reorderAssets(orderedIds),
      onReRender: () => renderAssetsTab(ctx),
    });
  } else if (!manualItems.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '尚無手動快照項目';
    manualList.appendChild(e);
  } else {
    for (const item of manualItems) {
      if (item.majorType === '負債' && item.isAmortizingLoan) {
        const loan = computeLoanAmortizationSummary(item, rate, todayYmd);
        const row = document.createElement('div');
        row.className = 'savings-acc-row';

        const top = document.createElement('div');
        top.className = 'savings-acc-top';

        const main = document.createElement('div');
        main.className = 'item-main';
        const title = document.createElement('div');
        title.className = 'item-title';
        title.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
        title.appendChild(document.createTextNode(item.itemName));

        const catBadge = document.createElement('span');
        catBadge.className = 'badge red';
        catBadge.style.marginRight = '0';
        catBadge.textContent = item.subCategory;
        title.appendChild(catBadge);

        const autoBadge = document.createElement('span');
        autoBadge.className = 'badge';
        autoBadge.style.marginRight = '0';
        autoBadge.textContent = '自動還本';
        title.appendChild(autoBadge);

        const sub = document.createElement('div');
        sub.className = 'item-sub tnum';
        if (loan.currentBalance <= 0) {
          sub.textContent = `已推算清償（基準 ${fmtMoney(loan.baseBalance, ctx.state.masked)} @ ${item.balanceAnchorDate || '-'}）`;
        } else if (loan.isInterestOnly) {
          sub.textContent = `寬限期/只繳息 · 年利 ${item.loanAnnualRate ?? 0}% · 月息 ~${fmtMoney(loan.nextInterest, ctx.state.masked)} · 基準 ${item.balanceAnchorDate || '-'}`;
        } else {
          const payoffTxt = loan.estimatedPayoffYm ? ` · 預計 ${loan.estimatedPayoffYm} 清償` : '';
          sub.textContent = `年利 ${item.loanAnnualRate ?? 0}% · 已推算 ${loan.elapsedPeriods} 期 · 下期還本 ~${fmtMoney(loan.nextPrincipal, ctx.state.masked)} / 息 ~${fmtMoney(loan.nextInterest, ctx.state.masked)}${payoffTxt}`;
        }
        main.appendChild(title);
        main.appendChild(sub);

        const bal = document.createElement('div');
        bal.className = 'savings-acc-bal neg tnum';
        bal.textContent = '-' + fmtMoney(loan.currentBalanceTwd, ctx.state.masked);

        top.appendChild(main);
        top.appendChild(bal);

        const actions = document.createElement('div');
        actions.className = 'savings-acc-actions';

        const recBtn = document.createElement('button');
        recBtn.type = 'button';
        recBtn.className = 'btn btn-tinted btn-sm';
        recBtn.textContent = '快照校準';
        recBtn.addEventListener('click', () => openLoanReconcileModal(ctx, item));

        const schBtn = document.createElement('button');
        schBtn.type = 'button';
        schBtn.className = 'btn btn-outline btn-sm';
        schBtn.textContent = '攤還試算';
        schBtn.addEventListener('click', () => openLoanScheduleModal(ctx, item));

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-outline btn-sm';
        editBtn.textContent = '編輯';
        editBtn.addEventListener('click', () => openAssetModal(ctx, item));

        actions.appendChild(recBtn);
        actions.appendChild(schBtn);
        actions.appendChild(editBtn);

        row.appendChild(top);
        row.appendChild(actions);
        manualList.appendChild(row);
        continue;
      }

      const isStock = isStockAsset(item);
      const stockPos = isStock ? computeStockPositionSummary(item, stockTxs, rate) : null;
      const twdVal = computeAssetEffectiveTwdValue(item, rate, snap.cashflowLogs, adjustments, stockTxs, todayYmd);
      const row = document.createElement('div');
      row.className = 'list-row';

      const main = document.createElement('div');
      main.className = 'item-main';
      const t = document.createElement('div');
      t.className = 'item-title';
      t.textContent = item.itemName;
      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      const b = document.createElement('span');
      b.className = 'badge' + (item.majorType === '負債' ? ' red' : ' green');
      b.textContent = item.subCategory;
      sub.appendChild(b);
      const displayQty = stockPos ? stockPos.currentShares : item.quantityOrAmount;
      const pnlSuffix =
        stockPos && stockPos.hasCostBasis
          ? ` · 含息 ${fmtSignedMoney(stockPos.totalReturnPnlTwd, ctx.state.masked)}`
          : '';
      const detail = item.ticker || isStock
        ? `${item.ticker ? item.ticker + ' · ' : ''}${fmtNum(displayQty)} 股 @ ${item.unitPrice}${pnlSuffix}`
        : item.currency === 'USD'
          ? fmtRaw(item.quantityOrAmount, 'USD', ctx.state.masked)
          : item.liquidity;
      sub.appendChild(document.createTextNode(detail));
      main.appendChild(t);
      main.appendChild(sub);

      const right = document.createElement('div');
      right.className = 'item-right';
      const amt = document.createElement('div');
      amt.className = 'item-amount';
      amt.style.color = item.majorType === '負債' ? 'var(--neg)' : 'var(--text)';
      amt.textContent = (item.majorType === '負債' ? '-' : '') + fmtMoney(twdVal, ctx.state.masked);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = isStock ? '持股頁' : '更新';
      editBtn.addEventListener('click', () => {
        if (isStock) ctx.navigateToTab('stocks');
        else openAssetModal(ctx, item);
      });

      right.appendChild(amt);
      if (isTransferableAccount(item)) {
        const trBtn = document.createElement('button');
        trBtn.type = 'button';
        trBtn.className = 'btn btn-tinted btn-sm';
        trBtn.textContent = '轉帳';
        trBtn.addEventListener('click', () => openAccountTransferModal(ctx, item.id));
        right.appendChild(trBtn);
      }
      right.appendChild(editBtn);
      row.appendChild(main);
      row.appendChild(right);
      manualList.appendChild(row);
    }
  }

  // Render independent ledgers summary when viewing personal net_worth scope
  const indepSec = document.getElementById('independentLedgersSection');
  const indepList = document.getElementById('independentLedgersList');
  if (indepSec && indepList) {
    const independentLedgers = ledgers.filter((l) => !l.includeInNetWorth);
    const individuallyExcluded = snap.assetItems.filter(
      (a) =>
        !a.deletedAt &&
        !a.isWatchlist &&
        a.excludeFromNetWorth &&
        ledgers.some((l) => l.id === getEffectiveLedgerId(a) && l.includeInNetWorth)
    );
    if (scope === 'net_worth' && (independentLedgers.length > 0 || individuallyExcluded.length > 0)) {
      indepSec.style.display = 'block';
      indepList.innerHTML = '';
      for (const lg of independentLedgers) {
        const lgNw = computeNetWorthSummary(
          snap.assetItems,
          rate,
          0,
          snap.cashflowLogs,
          adjustments,
          stockTxs,
          todayYmd,
          ledgers,
          lg.id
        );
        const lgCount = snap.assetItems.filter(
          (a) => !a.deletedAt && !a.isWatchlist && getEffectiveLedgerId(a) === lg.id
        ).length;
        const row = document.createElement('div');
        row.className = 'list-row';
        row.style.cursor = 'pointer';
        const main = document.createElement('div');
        main.className = 'item-main';
        const t = document.createElement('div');
        t.className = 'item-title';
        t.textContent = lg.name;
        const sub = document.createElement('div');
        sub.className = 'item-sub tnum';
        sub.textContent = `${lgCount} 項資產/活存 · 總資產 ${fmtMoney(lgNw.totalAssets, ctx.state.masked)}${lgNw.totalLiabilities > 0 ? ` · 負債 ${fmtMoney(lgNw.totalLiabilities, ctx.state.masked)}` : ''}`;
        main.appendChild(t);
        main.appendChild(sub);

        const right = document.createElement('div');
        right.className = 'item-right';
        const amt = document.createElement('div');
        amt.className = 'item-amount';
        amt.textContent = fmtMoney(lgNw.netWorth, ctx.state.masked);
        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'btn btn-outline btn-sm';
        goBtn.textContent = '檢視';
        goBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          ctx.state.assetsLedgerScope = lg.id;
          renderAssetsTab(ctx);
        });
        right.appendChild(amt);
        right.appendChild(goBtn);
        row.appendChild(main);
        row.appendChild(right);
        row.addEventListener('click', () => {
          ctx.state.assetsLedgerScope = lg.id;
          renderAssetsTab(ctx);
        });
        indepList.appendChild(row);
      }

      if (individuallyExcluded.length > 0) {
        const exclTotal = individuallyExcluded.reduce(
          (sum, a) =>
            sum +
            computeAssetEffectiveTwdValue(a, rate, snap.cashflowLogs, adjustments, stockTxs, todayYmd) *
              (a.majorType === '負債' ? -1 : 1),
          0
        );
        const row = document.createElement('div');
        row.className = 'list-row';
        const main = document.createElement('div');
        main.className = 'item-main';
        const t = document.createElement('div');
        t.className = 'item-title';
        t.textContent = `單筆排除不計入總資產 (${individuallyExcluded.length} 項)`;
        const sub = document.createElement('div');
        sub.className = 'item-sub';
        sub.textContent = '切換至上方「全部合併」可編輯這些項目';
        main.appendChild(t);
        main.appendChild(sub);
        const right = document.createElement('div');
        right.className = 'item-right';
        const amt = document.createElement('div');
        amt.className = 'item-amount';
        amt.textContent = fmtMoney(Math.round(exclTotal), ctx.state.masked);
        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'btn btn-outline btn-sm';
        goBtn.textContent = '檢視';
        goBtn.addEventListener('click', () => {
          ctx.state.assetsLedgerScope = 'all';
          renderAssetsTab(ctx);
        });
        right.appendChild(amt);
        right.appendChild(goBtn);
        row.appendChild(main);
        row.appendChild(right);
        indepList.appendChild(row);
      }
    } else {
      indepSec.style.display = 'none';
    }
  }

  const hList = el('historyList');
  hList.innerHTML = '';
  const history = snap.netWorthHistory.slice(0, 12);
  if (!history.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '尚無歷史快照，點上方「記錄快照」建立第一筆';
    hList.appendChild(e);
  } else {
    for (const h of history) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const main = document.createElement('div');
      main.className = 'item-main';
      const t = document.createElement('div');
      t.className = 'item-title tnum';
      t.textContent = `${h.yearMonth} 淨資產快照`;
      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      sub.textContent = `總資產 ${fmtMoney(h.totalAssets, ctx.state.masked)} ｜ 總負債 ${fmtMoney(h.totalLiabilities, ctx.state.masked)} ｜ 儲蓄率 ${fmtPct((h.savingsRate * 100), 1)}`;
      main.appendChild(t);
      main.appendChild(sub);

      const amt = document.createElement('div');
      amt.className = 'item-amount';
      amt.style.color = h.netWorth >= 0 ? 'var(--pos)' : 'var(--neg)';
      amt.textContent = fmtMoney(h.netWorth, ctx.state.masked);
      row.appendChild(main);
      row.appendChild(amt);
      hList.appendChild(row);
    }
  }
}

export function openSavingsAccountModal(
  ctx: UiContext,
  existing: AssetItem | null,
  defaultLedgerId?: string
): void {
  const body = openModal(existing ? '編輯活存帳戶' : '新增連動活存帳戶');
  const form = document.createElement('form');
  const today = todayYmdLocal();
  const initialLedgerId = existing
    ? getEffectiveLedgerId(existing)
    : defaultLedgerId ||
      (ctx.state.assetsLedgerScope !== 'net_worth' && ctx.state.assetsLedgerScope !== 'all'
        ? ctx.state.assetsLedgerScope
        : DEFAULT_LEDGER_ID);

  form.appendChild(
    makeInputField('活存帳戶名稱', 'svName', 'text', existing?.itemName || '', '例如：中信活存、台新 Richart', true)
  );

  form.appendChild(buildLedgerSelectField(ctx, 'svLedger', initialLedgerId, '所屬帳本'));

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(
    makeInputField('目前基準餘額（可填 0 再分筆存入）', 'svBase', 'number', existing?.quantityOrAmount ?? 0, '500000', true)
  );
  r1.appendChild(makeSelectField('幣別', 'svCurr', ['TWD', 'USD'], existing?.currency || 'TWD'));
  form.appendChild(r1);

  form.appendChild(
    makeInputField('基準生效日（此日之前的歷史流水帳不重複扣減）', 'svAnchorDate', 'date', existing?.balanceAnchorDate || today, '', true)
  );

  const defLabel = document.createElement('label');
  defLabel.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:11px 13px;margin-bottom:10px;border-radius:12px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
  const defCb = document.createElement('input');
  defCb.id = 'svDefault';
  defCb.type = 'checkbox';
  defCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  const hasOtherSavingsInLedger = ctx.engine
    .getSnapshot()
    .assetItems.some(
      (a) =>
        !a.deletedAt &&
        a.isLinkedSavings &&
        a.id !== existing?.id &&
        getEffectiveLedgerId(a) === initialLedgerId
    );
  defCb.checked = existing ? Boolean(existing.isDefaultSavings) : !hasOtherSavingsInLedger;
  const defText = document.createElement('span');
  defText.innerHTML =
    '<strong>設為此帳本的預設連動帳戶</strong><small style="display:block;color:var(--text-secondary);font-size:11px">在該帳本記帳時自動預選此帳戶，不同帳本各自獨立預設</small>';
  defLabel.appendChild(defCb);
  defLabel.appendChild(defText);
  form.appendChild(defLabel);

  const exclLabel = document.createElement('label');
  exclLabel.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:11px 13px;margin-bottom:14px;border-radius:12px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
  const exclCb = document.createElement('input');
  exclCb.id = 'svExcludeNw';
  exclCb.type = 'checkbox';
  exclCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  exclCb.checked = Boolean(existing?.excludeFromNetWorth);
  const exclText = document.createElement('span');
  exclText.innerHTML =
    '<strong>單獨不計入個人總資產</strong><small style="display:block;color:var(--text-secondary);font-size:11px">即使歸屬在主帳本，也不納入整合淨資產計算（若已選獨立帳本則本來就不計入）</small>';
  exclLabel.appendChild(exclCb);
  exclLabel.appendChild(exclText);
  form.appendChild(exclLabel);

  form.appendChild(makeInputField('備註（選填）', 'svNote', 'text', existing?.note || '', '例如：薪轉戶、緊急預備金'));

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  if (existing) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = '刪除帳戶';
    del.addEventListener('click', async () => {
      if (!confirm(`確定刪除活存帳戶「${existing.itemName}」？（歷史流水帳仍會保留）`)) return;
      await ctx.engine.deleteAsset(existing.id);
      closeModal();
      showToast(`已刪除活存帳戶：${existing.itemName}`, 'success');
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

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary';
  save.textContent = existing ? '儲存活存設定' : '建立活存帳戶';
  btns.appendChild(save);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const anchorDate = el<HTMLInputElement>('svAnchorDate').value || today;
      const nowIso = new Date().toISOString();
      let balanceAnchorAt: string;
      if (anchorDate < today) {
        balanceAnchorAt = `${anchorDate}T00:00:00.000Z`;
      } else if (existing && existing.balanceAnchorDate === anchorDate && existing.balanceAnchorAt) {
        balanceAnchorAt = existing.balanceAnchorAt;
      } else {
        balanceAnchorAt = nowIso;
      }

      await ctx.engine.saveAsset({
        id: existing?.id,
        itemName: el<HTMLInputElement>('svName').value.trim(),
        majorType: '資產',
        updateMode: '手動快照',
        subCategory: '活存',
        liquidity: '高流動',
        quantityOrAmount: parseFloat(el<HTMLInputElement>('svBase').value) || 0,
        currency: el<HTMLSelectElement>('svCurr').value,
        ticker: '',
        unitPrice: 1,
        isLinkedSavings: true,
        isDefaultSavings: el<HTMLInputElement>('svDefault').checked,
        ledgerId: el<HTMLSelectElement>('svLedger').value || DEFAULT_LEDGER_ID,
        excludeFromNetWorth: el<HTMLInputElement>('svExcludeNw').checked,
        balanceAnchorDate: anchorDate,
        balanceAnchorAt,
        note: el<HTMLInputElement>('svNote').value.trim(),
      });
      closeModal();
      showToast(existing ? '已更新活存帳戶' : '已建立連動活存帳戶', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function openSavingsAdjustmentModal(ctx: UiContext, account: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const freshAccount = snap.assetItems.find((a) => a.id === account.id && !a.deletedAt) || account;
  const summary = computeSavingsAccountSummary(
    freshAccount,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    snap.settings.usdTwdRate
  );

  const body = openModal(`${freshAccount.itemName} · 存入 / 轉出累加`);

  // Current balance banner
  const banner = document.createElement('div');
  banner.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;padding:10px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px;';
  banner.innerHTML = `<span style="font-size:12.5px;color:var(--text-secondary);font-weight:600">目前即時餘額</span><strong class="tnum" style="font-size:18px;color:${summary.currentBalanceTwd < 0 ? 'var(--neg)' : 'var(--pos)'}">${fmtMoney(summary.currentBalanceTwd, ctx.state.masked)}</strong>`;
  body.appendChild(banner);

  let mode: 'deposit' | 'withdraw' = 'deposit';
  const seg = document.createElement('div');
  seg.className = 'seg-bar cols-3';
  seg.style.marginBottom = '12px';
  const depBtn = document.createElement('button');
  depBtn.type = 'button';
  depBtn.className = 'seg-btn active';
  depBtn.textContent = '+ 存入活存';
  const wdBtn = document.createElement('button');
  wdBtn.type = 'button';
  wdBtn.className = 'seg-btn';
  wdBtn.textContent = '- 轉出 / 提領';
  const trBtn = document.createElement('button');
  trBtn.type = 'button';
  trBtn.className = 'seg-btn';
  trBtn.textContent = '⇄ 帳戶互轉';
  trBtn.addEventListener('click', () => openAccountTransferModal(ctx, freshAccount.id));
  seg.appendChild(depBtn);
  seg.appendChild(wdBtn);
  seg.appendChild(trBtn);
  body.appendChild(seg);

  const form = document.createElement('form');
  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(
    makeInputField(`金額 (${freshAccount.currency})`, 'adjAmt', 'number', '', '例如：100000', true)
  );
  r1.appendChild(makeInputField('日期', 'adjDate', 'date', todayYmdLocal(), '', true));
  form.appendChild(r1);
  form.appendChild(
    makeInputField('備註（選填，不計入流水帳收入或儲蓄率）', 'adjNote', 'text', '', '例如：定存到期、帳戶互轉、現金存入')
  );

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary btn-block';
  submitBtn.textContent = '新增存入紀錄';
  form.appendChild(submitBtn);

  const updateModeUi = () => {
    depBtn.classList.toggle('active', mode === 'deposit');
    wdBtn.classList.toggle('active', mode === 'withdraw');
    submitBtn.textContent = mode === 'deposit' ? '新增存入紀錄' : '新增轉出紀錄';
  };
  depBtn.addEventListener('click', () => {
    mode = 'deposit';
    updateModeUi();
  });
  wdBtn.addEventListener('click', () => {
    mode = 'withdraw';
    updateModeUi();
  });

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const rawAmt = parseFloat(el<HTMLInputElement>('adjAmt').value);
    const date = el<HTMLInputElement>('adjDate').value;
    if (!date || Number.isNaN(rawAmt) || rawAmt <= 0) {
      showToast('請輸入大於 0 的金額與日期', 'error');
      return;
    }
    try {
      const signedAmount = mode === 'withdraw' ? -Math.abs(rawAmt) : Math.abs(rawAmt);
      await ctx.engine.addSavingsAdjustment({
        accountId: freshAccount.id,
        date,
        amount: signedAmount,
        currency: freshAccount.currency,
        note: el<HTMLInputElement>('adjNote').value.trim(),
      });
      showToast(
        `${mode === 'deposit' ? '已存入' : '已轉出'} ${fmtRaw(rawAmt, freshAccount.currency, ctx.state.masked)}`,
        'success'
      );
      ctx.scheduleSync();
      openSavingsAdjustmentModal(ctx, freshAccount);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '寫入失敗', 'error');
    }
  });
  body.appendChild(form);

  // Existing N deposit/withdrawal adjustments list
  const accountAdjs = (snap.savingsAdjustments || []).filter(
    (a) => !a.deletedAt && a.accountId === freshAccount.id
  );
  const listWrap = document.createElement('div');
  listWrap.className = 'savings-adj-list';
  const listHead = document.createElement('div');
  listHead.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:2px';
  listHead.textContent = `已累加存轉紀錄（共 ${accountAdjs.length} 筆）`;
  listWrap.appendChild(listHead);

  if (!accountAdjs.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '8px 2px';
    empty.textContent = '尚無分筆存入/轉出紀錄，上方可隨時新增多筆累加';
    listWrap.appendChild(empty);
  } else {
    for (const adj of accountAdjs) {
      const row = document.createElement('div');
      row.className = 'savings-adj-item';

      const info = document.createElement('div');
      info.style.minWidth = '0';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      title.textContent = adj.note || (adj.amount >= 0 ? '活存存入' : '活存轉出');
      const sub = document.createElement('div');
      sub.className = 'muted tnum';
      const beforeAnchor =
        freshAccount.balanceAnchorDate && adj.date < freshAccount.balanceAnchorDate ? ' · 基準日前(不計入)' : '';
      const pairedSibling = adj.transferGroupId
        ? (snap.savingsAdjustments || []).find(
            (s) => !s.deletedAt && s.id !== adj.id && s.transferGroupId === adj.transferGroupId
          )
        : undefined;
      const pairedTag = pairedSibling ? ' · ⇄ 配對互轉' : '';
      sub.textContent = `${adj.date}${beforeAnchor}${pairedTag}`;
      info.appendChild(title);
      info.appendChild(sub);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
      const amt = document.createElement('span');
      amt.className = 'tnum';
      amt.style.fontWeight = '700';
      amt.style.color = adj.twdAmount >= 0 ? 'var(--pos)' : 'var(--neg)';
      amt.textContent = fmtSignedMoney(adj.twdAmount, ctx.state.masked);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn sm';
      delBtn.style.color = 'var(--text-muted)';
      delBtn.title = '刪除此筆紀錄';
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener('click', async () => {
        if (pairedSibling) {
          const siblingAcc = snap.assetItems.find((a) => !a.deletedAt && a.id === pairedSibling.accountId);
          const siblingName = siblingAcc?.itemName || '對方帳戶';
          if (
            !confirm(
              `確定刪除此筆 ${adj.date} 的帳戶互轉紀錄？\n\n對方帳戶「${siblingName}」的對應轉帳紀錄也會一併撤銷（若當時有記轉帳手續費流水帳，可另至流水帳刪除）。`
            )
          ) {
            return;
          }
          await ctx.engine.deleteSavingsAdjustment(adj.id, true);
          showToast(`已同步撤銷「${freshAccount.itemName}」與「${siblingName}」的配對轉帳`, 'success');
        } else {
          if (!confirm(`確定刪除此筆 ${adj.date} 的存轉紀錄？`)) return;
          await ctx.engine.deleteSavingsAdjustment(adj.id, false);
          showToast('已刪除存轉紀錄並重算餘額', 'success');
        }
        ctx.scheduleSync();
        openSavingsAdjustmentModal(ctx, freshAccount);
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

export function openAccountTransferModal(ctx: UiContext, presetFromAccountId?: string): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const ledgers = getActiveLedgers(ctx);
  const ledgerNameMap = new Map(ledgers.map((l) => [l.id, l.name]));
  const showLedgerTag = ledgers.length > 1;

  const accounts = snap.assetItems
    .filter((a) => isTransferableAccount(a))
    .slice()
    .sort(compareBySortOrder);

  const body = openModal('帳戶互轉（活存 / 定存）');

  if (accounts.length < 2) {
    const empty = document.createElement('div');
    empty.className = 'stock-live-preview';
    empty.textContent =
      '需要至少 2 個活存或定存／現金帳戶才能進行帳戶互轉。請先於資產頁新增活存帳戶或定存／現金資產。';
    body.appendChild(empty);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-outline btn-block';
    closeBtn.textContent = '關閉';
    closeBtn.addEventListener('click', closeModal);
    body.appendChild(closeBtn);
    return;
  }

  const getAccountCurrentRawBalance = (acc: AssetItem): number => {
    if (acc.isLinkedSavings) {
      const s = computeSavingsAccountSummary(
        acc,
        snap.cashflowLogs,
        snap.savingsAdjustments || [],
        rate
      );
      return s.currentBalanceNative;
    }
    return acc.quantityOrAmount;
  };

  const getAccountCurrentTwd = (acc: AssetItem): number => {
    if (acc.isLinkedSavings) {
      return computeSavingsAccountSummary(
        acc,
        snap.cashflowLogs,
        snap.savingsAdjustments || [],
        rate
      ).currentBalanceTwd;
    }
    return computeAssetEffectiveTwdValue(acc, rate, snap.cashflowLogs, snap.savingsAdjustments || []);
  };

  const formatAccountOptionLabel = (acc: AssetItem): string => {
    const lgPrefix = showLedgerTag ? `[${ledgerNameMap.get(getEffectiveLedgerId(acc)) || '主帳本'}] ` : '';
    const kind = acc.isLinkedSavings ? '活存' : acc.subCategory;
    const balStr = fmtRaw(getAccountCurrentRawBalance(acc), acc.currency, ctx.state.masked);
    return `${lgPrefix}${acc.itemName}（${kind} · ${balStr}）`;
  };

  const buildGroupedAccountSelect = (id: string, label: string, selectedId: string): HTMLDivElement => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lbl = document.createElement('label');
    lbl.className = 'section-label';
    lbl.htmlFor = id;
    lbl.textContent = label;
    const sel = document.createElement('select');
    sel.id = id;

    const savingsList = accounts.filter((a) => a.isLinkedSavings);
    const otherList = accounts.filter((a) => !a.isLinkedSavings);

    if (savingsList.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '連動活存帳戶';
      for (const acc of savingsList) {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = formatAccountOptionLabel(acc);
        if (acc.id === selectedId) opt.selected = true;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }

    if (otherList.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '定存 / 現金與其他帳戶';
      for (const acc of otherList) {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = formatAccountOptionLabel(acc);
        if (acc.id === selectedId) opt.selected = true;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }

    wrap.appendChild(lbl);
    wrap.appendChild(sel);
    return wrap;
  };

  const defaultFrom =
    accounts.find((a) => a.id === presetFromAccountId) ||
    accounts.find((a) => a.isLinkedSavings && a.isDefaultSavings) ||
    accounts[0];
  const defaultTo = accounts.find((a) => a.id !== defaultFrom.id) || accounts[1];

  const intro = document.createElement('div');
  intro.className = 'stock-live-preview';
  intro.textContent =
    '本金互轉會同步扣減轉出帳戶並增加轉入帳戶餘額，不計入當月收支與儲蓄率；若有填寫轉帳手續費，僅手續費會記為一筆支出。';
  body.appendChild(intro);

  const form = document.createElement('form');
  form.appendChild(buildGroupedAccountSelect('trFromAcc', '轉出帳戶（從 A 扣款）', defaultFrom.id));

  const swapRow = document.createElement('div');
  swapRow.style.cssText = 'display:flex;justify-content:center;margin:-4px 0 8px';
  const swapBtn = document.createElement('button');
  swapBtn.type = 'button';
  swapBtn.className = 'btn btn-outline btn-sm';
  swapBtn.textContent = '⇅ 互換轉出 / 轉入帳戶';
  swapRow.appendChild(swapBtn);
  form.appendChild(swapRow);

  form.appendChild(buildGroupedAccountSelect('trToAcc', '轉入帳戶（入帳到 B）', defaultTo.id));

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(makeInputField(`轉出金額 (${defaultFrom.currency})`, 'trAmt', 'number', '', '例如：50000', true));
  r1.appendChild(makeInputField('日期', 'trDate', 'date', todayYmdLocal(), '', true));
  form.appendChild(r1);

  // Cross-currency target amount container (shown only when from.currency !== to.currency)
  const fxWrap = document.createElement('div');
  fxWrap.id = 'trFxWrap';
  fxWrap.style.display = 'none';
  fxWrap.appendChild(
    makeInputField('實際入帳金額（可依網銀實際成交調整）', 'trTargetAmt', 'number', '', '')
  );
  form.appendChild(fxWrap);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(
    makeInputField(`轉帳手續費（選填，${defaultFrom.currency}）`, 'trFee', 'number', '', '0')
  );
  r2.appendChild(makeInputField('備註（選填）', 'trNote', 'text', '', '如：轉存定存、銀行互轉'));
  form.appendChild(r2);

  const previewBox = document.createElement('div');
  previewBox.id = 'trPreviewBox';
  previewBox.className = 'stock-live-preview tnum';
  previewBox.style.cssText = 'display:flex;flex-direction:column;gap:4px;line-height:1.55';
  form.appendChild(previewBox);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:4px';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認轉帳';
  btns.appendChild(cancelBtn);
  btns.appendChild(submitBtn);
  form.appendChild(btns);

  body.appendChild(form);

  const fromSel = el<HTMLSelectElement>('trFromAcc');
  const toSel = el<HTMLSelectElement>('trToAcc');
  const amtInp = el<HTMLInputElement>('trAmt');
  const targetAmtInp = el<HTMLInputElement>('trTargetAmt');
  const feeInp = el<HTMLInputElement>('trFee');
  let targetAmtTouched = false;

  const findAcc = (id: string) => accounts.find((a) => a.id === id);

  const updatePreview = (autoFillTarget = false) => {
    const fromAcc = findAcc(fromSel.value);
    const toAcc = findAcc(toSel.value);
    if (!fromAcc || !toAcc) return;

    const amtLbl = document.querySelector<HTMLLabelElement>('label[for="trAmt"]');
    if (amtLbl) amtLbl.textContent = `轉出金額 (${fromAcc.currency})`;
    const feeLbl = document.querySelector<HTMLLabelElement>('label[for="trFee"]');
    if (feeLbl) feeLbl.textContent = `轉帳手續費（選填，${fromAcc.currency}）`;

    const crossCurr = fromAcc.currency !== toAcc.currency;
    fxWrap.style.display = crossCurr ? 'block' : 'none';
    const targetLbl = document.querySelector<HTMLLabelElement>('label[for="trTargetAmt"]');
    if (targetLbl) targetLbl.textContent = `實際入帳金額 (${toAcc.currency}，依匯率 ${rate} 估算，可修改)`;

    const rawAmt = parseFloat(amtInp.value);
    const hasAmt = !Number.isNaN(rawAmt) && rawAmt > 0;
    const rawFee = parseFloat(feeInp.value);
    const fee = !Number.isNaN(rawFee) && rawFee > 0 ? rawFee : 0;

    if (crossCurr && (autoFillTarget || !targetAmtTouched)) {
      if (hasAmt) {
        const est =
          fromAcc.currency === 'TWD'
            ? Math.round((rawAmt / rate) * 100) / 100
            : Math.round(rawAmt * rate);
        targetAmtInp.value = String(est);
      } else {
        targetAmtInp.value = '';
      }
    }

    const rawTarget = parseFloat(targetAmtInp.value);
    const toAmt = crossCurr ? (!Number.isNaN(rawTarget) && rawTarget > 0 ? rawTarget : 0) : hasAmt ? rawAmt : 0;

    const fromBefore = getAccountCurrentRawBalance(fromAcc);
    const toBefore = getAccountCurrentRawBalance(toAcc);
    const fromAfter = hasAmt ? Math.round((fromBefore - rawAmt - fee) * 100) / 100 : fromBefore;
    const toAfter = toAmt > 0 ? Math.round((toBefore + toAmt) * 100) / 100 : toBefore;

    if (fromAcc.id === toAcc.id) {
      previewBox.innerHTML = '<span style="color:var(--neg);font-weight:600">⚠ 轉出與轉入帳戶相同，請選擇不同的目標帳戶。</span>';
      return;
    }

    const fromLine = `<div>轉出 <strong>${escapeHtml(fromAcc.itemName)}</strong>：${fmtRaw(fromBefore, fromAcc.currency, ctx.state.masked)} → <strong style="color:${fromAfter < 0 ? 'var(--neg)' : 'var(--text)'}">${fmtRaw(fromAfter, fromAcc.currency, ctx.state.masked)}</strong></div>`;
    const toLine = `<div>轉入 <strong>${escapeHtml(toAcc.itemName)}</strong>：${fmtRaw(toBefore, toAcc.currency, ctx.state.masked)} → <strong style="color:var(--pos)">${fmtRaw(toAfter, toAcc.currency, ctx.state.masked)}</strong></div>`;
    const feeLine =
      fee > 0
        ? `<div style="color:var(--text-secondary)">含轉帳手續費 ${fmtRaw(fee, fromAcc.currency, ctx.state.masked)}（同步記為流水帳支出）</div>`
        : '';
    const crossLedgerHint =
      getEffectiveLedgerId(fromAcc) !== getEffectiveLedgerId(toAcc)
        ? `<div style="color:var(--warning)">跨帳本轉帳：${escapeHtml(ledgerNameMap.get(getEffectiveLedgerId(fromAcc)) || '主帳本')} → ${escapeHtml(ledgerNameMap.get(getEffectiveLedgerId(toAcc)) || '主帳本')}</div>`
        : '';
    const twdHint =
      !hasAmt
        ? `<div style="color:var(--text-muted)">目前合計參考：${fmtMoney(getAccountCurrentTwd(fromAcc), ctx.state.masked)} / ${fmtMoney(getAccountCurrentTwd(toAcc), ctx.state.masked)}</div>`
        : '';

    previewBox.innerHTML = fromLine + toLine + feeLine + crossLedgerHint + twdHint;
  };

  swapBtn.addEventListener('click', () => {
    const prevFrom = fromSel.value;
    fromSel.value = toSel.value;
    toSel.value = prevFrom;
    targetAmtTouched = false;
    updatePreview(true);
  });

  fromSel.addEventListener('change', () => {
    if (fromSel.value === toSel.value) {
      const alt = accounts.find((a) => a.id !== fromSel.value);
      if (alt) toSel.value = alt.id;
    }
    targetAmtTouched = false;
    updatePreview(true);
  });
  toSel.addEventListener('change', () => {
    targetAmtTouched = false;
    updatePreview(true);
  });
  amtInp.addEventListener('input', () => updatePreview(false));
  feeInp.addEventListener('input', () => updatePreview(false));
  targetAmtInp.addEventListener('input', () => {
    targetAmtTouched = true;
    updatePreview(false);
  });

  updatePreview(true);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const fromAcc = findAcc(fromSel.value);
    const toAcc = findAcc(toSel.value);
    if (!fromAcc || !toAcc) return;
    try {
      const res = await ctx.engine.transferBetweenAccounts({
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        date: el<HTMLInputElement>('trDate').value,
        amount: amtInp.value,
        targetAmount: fromAcc.currency !== toAcc.currency ? targetAmtInp.value : null,
        fee: feeInp.value,
        note: el<HTMLInputElement>('trNote').value.trim(),
      });
      closeModal();
      const feeText = res.fee > 0 ? `（含手續費 ${fmtRaw(res.fee, fromAcc.currency, ctx.state.masked)}）` : '';
      showToast(
        `已轉帳：${fromAcc.itemName} → ${toAcc.itemName} ${fmtRaw(res.fromAmount, fromAcc.currency, ctx.state.masked)}${feeText}`,
        'success'
      );
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '轉帳失敗', 'error');
    }
  });
}

export function openReconcileModal(ctx: UiContext, account: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const summary = computeSavingsAccountSummary(
    account,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    rate
  );

  const body = openModal(`對帳校準 · ${account.itemName}`);
  const info = document.createElement('div');
  info.style.cssText =
    'padding:11px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px;font-size:13px;line-height:1.55;color:var(--text-secondary)';
  info.innerHTML = `目前系統推算餘額：<strong class="tnum" style="color:var(--text)">${fmtMoney(summary.currentBalanceTwd, ctx.state.masked)}</strong><br/>校準後將以「現在時刻」重設基準餘額；過去所有流水帳與存轉紀錄都會完整保留，但不會重複加減。`;
  body.appendChild(info);

  const form = document.createElement('form');
  // M8: the prefilled balance is the account's own-currency balance (no TWD round trip)
  const defaultVal = summary.currentBalanceNative;
  form.appendChild(
    makeInputField(`網銀實際餘額 (${account.currency})`, 'recActual', 'number', defaultVal, '0', true)
  );

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary';
  save.textContent = '確認校準餘額';
  btns.appendChild(cancel);
  btns.appendChild(save);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const actual = parseFloat(el<HTMLInputElement>('recActual').value);
    if (Number.isNaN(actual)) {
      showToast('請輸入有效的實際餘額', 'error');
      return;
    }
    try {
      await ctx.engine.reconcileSavingsAccount(account.id, actual, todayYmdLocal());
      closeModal();
      showToast(`已校準「${account.itemName}」餘額`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '校準失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function openLoanReconcileModal(ctx: UiContext, item: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const today = todayYmdLocal();
  const loan = computeLoanAmortizationSummary(item, rate, today);

  const body = openModal(`快照校準 · ${item.itemName}`);
  const info = document.createElement('div');
  info.style.cssText =
    'padding:11px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px;font-size:13px;line-height:1.55;color:var(--text-secondary)';
  info.innerHTML = `目前推估剩餘本金：<strong class="tnum" style="color:var(--neg)">${fmtMoney(loan.currentBalanceTwd, ctx.state.masked)}</strong><br/>拿到最新銀行對帳單或遇到調息時，直接填入最新本金與基準日覆蓋，後續會從新基準繼續自動還本推算；若想改回純手動快照也可於下方勾選。`;
  body.appendChild(info);

  const form = document.createElement('form');
  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(
    makeInputField(`最新實際剩餘本金 (${item.currency})`, 'lnRecBal', 'number', loan.currentBalance, '0', true)
  );
  r1.appendChild(makeInputField('單據基準日', 'lnRecDate', 'date', today, '', true));
  form.appendChild(r1);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(
    makeInputField('年利率 (%)', 'lnRecRate', 'number', item.loanAnnualRate ?? 0, '2.37', true)
  );
  r2.appendChild(
    makeInputField('每月月付金', 'lnRecPay', 'number', item.loanMonthlyPayment ?? '', '30765', true)
  );
  form.appendChild(r2);

  const disableLbl = document.createElement('label');
  disableLbl.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:14px;border-radius:10px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
  const disableCb = document.createElement('input');
  disableCb.id = 'lnRecDisable';
  disableCb.type = 'checkbox';
  disableCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  const disableTxt = document.createElement('span');
  disableTxt.innerHTML =
    '<strong>切回純手動快照模式</strong><small style="display:block;color:var(--text-secondary);font-size:11px">勾選後將停止按月自動推算，改為固定顯示您填寫的快照餘額</small>';
  disableLbl.appendChild(disableCb);
  disableLbl.appendChild(disableTxt);
  form.appendChild(disableLbl);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary';
  save.textContent = '確認更新快照';
  btns.appendChild(cancel);
  btns.appendChild(save);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const actualBal = parseFloat(el<HTMLInputElement>('lnRecBal').value);
    const anchorDate = el<HTMLInputElement>('lnRecDate').value || today;
    const annualRate = parseFloat(el<HTMLInputElement>('lnRecRate').value);
    const monthlyPayment = parseFloat(el<HTMLInputElement>('lnRecPay').value);
    const disableAutoAmortize = el<HTMLInputElement>('lnRecDisable').checked;
    if (Number.isNaN(actualBal) || actualBal < 0) {
      showToast('請輸入大於等於 0 的剩餘本金', 'error');
      return;
    }
    try {
      await ctx.engine.reconcileLoanBalance(item.id, actualBal, anchorDate, {
        annualRate: Number.isNaN(annualRate) ? undefined : annualRate,
        monthlyPayment: Number.isNaN(monthlyPayment) ? undefined : monthlyPayment,
        disableAutoAmortize,
      });
      closeModal();
      showToast(
        disableAutoAmortize
          ? `已將「${item.itemName}」更新為手動快照`
          : `已校準「${item.itemName}」餘額與基準日`,
        'success'
      );
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '校準失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function openLoanScheduleModal(ctx: UiContext, item: AssetItem): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const today = todayYmdLocal();
  const loan = computeLoanAmortizationSummary(item, rate, today);

  const body = openModal(`攤還試算表 · ${item.itemName}`);

  const banner = document.createElement('div');
  banner.style.cssText =
    'padding:11px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:12px;font-size:12.5px;line-height:1.6;color:var(--text-secondary)';
  const remainText =
    loan.remainingPeriods === null
      ? '寬限期／只繳息'
      : `剩餘約 ${loan.remainingPeriods} 期${loan.estimatedPayoffYm ? `（預計 ${loan.estimatedPayoffYm} 清償）` : ''}`;
  banner.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span>截至今日預估餘額</span><strong class="tnum" style="font-size:17px;color:var(--neg)">${fmtMoney(loan.currentBalanceTwd, ctx.state.masked)}</strong></div>` +
    `<div class="tnum">年利率 ${escapeHtml(item.loanAnnualRate ?? 0)}% · 月付 ${fmtRaw(item.loanMonthlyPayment || 0, item.currency, ctx.state.masked)} · 每月 ${escapeHtml(item.loanBillingDay || 1)} 號扣款<br/>基準單據 ${fmtRaw(loan.baseBalance, item.currency, ctx.state.masked)} (${escapeHtml(item.balanceAnchorDate || '-')}) · 已推算 ${loan.elapsedPeriods} 期 · ${remainText}</div>`;
  body.appendChild(banner);

  let showAll = false;
  const toggleBar = document.createElement('div');
  toggleBar.className = 'seg-bar';
  toggleBar.style.marginBottom = '10px';
  const btn12 = document.createElement('button');
  btn12.type = 'button';
  btn12.className = 'seg-btn active';
  btn12.textContent = '未來 12 期';
  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'seg-btn';
  btnAll.textContent = '全部剩餘期數';
  toggleBar.appendChild(btn12);
  toggleBar.appendChild(btnAll);
  body.appendChild(toggleBar);

  const wrap = document.createElement('div');
  wrap.className = 'loan-schedule-wrap';
  body.appendChild(wrap);

  const renderTable = () => {
    btn12.classList.toggle('active', !showAll);
    btnAll.classList.toggle('active', showAll);
    const entries = computeLoanAmortizationSchedule(item, today, showAll ? 600 : 12);
    wrap.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = loan.currentBalance <= 0 ? '此筆貸款已推算清償完畢。' : '目前設定為寬限期／只繳息，暫無還本試算表。';
      wrap.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'loan-schedule-table tnum';
    table.innerHTML =
      '<thead><tr><th>扣款日</th><th>實還本金</th><th>利息</th><th>剩餘本金</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const row of entries) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${row.paymentDate}</td>` +
        `<td style="color:var(--pos);font-weight:600">${ctx.state.masked ? '•••' : fmtNum(row.principal)}</td>` +
        `<td style="color:var(--text-secondary)">${ctx.state.masked ? '•••' : fmtNum(row.interest)}</td>` +
        `<td style="font-weight:600">${ctx.state.masked ? '•••••' : fmtNum(row.remainingBalance)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  };

  btn12.addEventListener('click', () => {
    showAll = false;
    renderTable();
  });
  btnAll.addEventListener('click', () => {
    showAll = true;
    renderTable();
  });
  renderTable();

  const footer = document.createElement('div');
  footer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px';
  const recBtn = document.createElement('button');
  recBtn.type = 'button';
  recBtn.className = 'btn btn-tinted';
  recBtn.textContent = '快照校準餘額';
  recBtn.addEventListener('click', () => openLoanReconcileModal(ctx, item));
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-outline';
  closeBtn.textContent = '關閉';
  closeBtn.addEventListener('click', closeModal);
  footer.appendChild(recBtn);
  footer.appendChild(closeBtn);
  body.appendChild(footer);
}

export function openAssetModal(
  ctx: UiContext,
  existing: AssetItem | null,
  defaultLedgerId?: string
): void {
  const body = openModal(existing ? '更新資產 / 負債餘額' : '新增資產 / 負債');
  const form = document.createElement('form');
  const today = todayYmdLocal();
  const initialLedgerId = existing
    ? getEffectiveLedgerId(existing)
    : defaultLedgerId ||
      (ctx.state.assetsLedgerScope !== 'net_worth' && ctx.state.assetsLedgerScope !== 'all'
        ? ctx.state.assetsLedgerScope
        : DEFAULT_LEDGER_ID);

  form.appendChild(makeInputField('項目名稱', 'asName', 'text', existing?.itemName || '', '如：0050、台幣定存、房貸餘額', true));
  form.appendChild(buildLedgerSelectField(ctx, 'asLedger', initialLedgerId, '所屬帳本'));

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(makeSelectField('大類', 'asMajor', ['資產', '負債'], existing?.majorType || '資產'));
  r1.appendChild(makeSelectField('更新方式', 'asMode', ['手動快照', '自動更新'], existing?.updateMode || '手動快照'));
  form.appendChild(r1);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(makeSelectField('細分類別', 'asSub', ASSET_SUB_CATEGORIES, existing?.subCategory || '定存/現金'));
  r2.appendChild(makeSelectField('流動性', 'asLiq', ['高流動', '中流動', '低流動', '負債'], existing?.liquidity || '高流動'));
  form.appendChild(r2);

  const r3 = document.createElement('div');
  r3.className = 'row-2';
  r3.appendChild(makeInputField('持有股數 / 原幣餘額（基準餘額）', 'asQty', 'number', existing?.quantityOrAmount ?? '', '0', true));
  r3.appendChild(makeSelectField('幣別', 'asCurr', ['TWD', 'USD'], existing?.currency || 'TWD'));
  form.appendChild(r3);

  const r4 = document.createElement('div');
  r4.className = 'row-2';
  r4.appendChild(
    makeInputField(
      '股票代碼（台股如 0050；美股如 VOO / NVDA）',
      'asTicker',
      'text',
      existing?.ticker || '',
      'TPE:0050 或 VOO'
    )
  );
  r4.appendChild(makeInputField('目前單價（非股票填 1）', 'asPrice', 'number', existing?.unitPrice ?? 1, '1', true));
  form.appendChild(r4);

  // Optional auto-amortizing loan section (shown only when majorType === '負債')
  const loanBox = document.createElement('div');
  loanBox.id = 'loanAutoBox';
  loanBox.className = 'loan-config-box';

  const loanToggleLbl = document.createElement('label');
  loanToggleLbl.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;';
  const loanCb = document.createElement('input');
  loanCb.id = 'asLoanAuto';
  loanCb.type = 'checkbox';
  loanCb.checked = Boolean(existing?.isAmortizingLoan);
  loanCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  const loanToggleTxt = document.createElement('span');
  loanToggleTxt.innerHTML =
    '<strong>啟用本息均攤自動還本推算</strong><small style="display:block;color:var(--text-secondary);font-size:11px">未勾選維持純手動快照；勾選後依基準日與扣款日自動算到今日，仍可隨時快照校準</small>';
  loanToggleLbl.appendChild(loanCb);
  loanToggleLbl.appendChild(loanToggleTxt);
  loanBox.appendChild(loanToggleLbl);

  const loanFields = document.createElement('div');
  loanFields.id = 'loanFieldsBox';
  loanFields.style.marginTop = '12px';

  const lr1 = document.createElement('div');
  lr1.className = 'row-2';
  lr1.appendChild(
    makeInputField('單據基準日', 'asLoanAnchor', 'date', existing?.balanceAnchorDate || today)
  );
  lr1.appendChild(
    makeInputField('每月扣款日 (1~31)', 'asLoanDay', 'number', existing?.loanBillingDay ?? 12, '12')
  );
  loanFields.appendChild(lr1);

  const lr2 = document.createElement('div');
  lr2.className = 'row-2';
  lr2.appendChild(
    makeInputField('每月月付金', 'asLoanPay', 'number', existing?.loanMonthlyPayment ?? '', '30765')
  );
  lr2.appendChild(
    makeInputField('年利率 (%)', 'asLoanRate', 'number', existing?.loanAnnualRate ?? '', '2.37')
  );
  loanFields.appendChild(lr2);

  // Built-in implied annual interest rate reverse solver
  const solver = document.createElement('details');
  solver.className = 'loan-solver-box';
  const solverSum = document.createElement('summary');
  solverSum.textContent = '不知道確切年利率？依申貸日＋年限一鍵反推';
  solver.appendChild(solverSum);

  const solverBody = document.createElement('div');
  solverBody.className = 'loan-solver-body';
  const sr1 = document.createElement('div');
  sr1.className = 'row-2';
  sr1.appendChild(makeInputField('原始申貸日', 'asSolveStart', 'date', ''));
  sr1.appendChild(makeInputField('貸款年限 (年)', 'asSolveYears', 'number', 20, '20'));
  solverBody.appendChild(sr1);

  const solveBtn = document.createElement('button');
  solveBtn.type = 'button';
  solveBtn.className = 'btn btn-tinted btn-sm';
  solveBtn.textContent = '反推年利率並帶入';
  solveBtn.addEventListener('click', () => {
    try {
      const baseBalance = parseFloat(el<HTMLInputElement>('asQty').value);
      const anchorDate = el<HTMLInputElement>('asLoanAnchor').value || today;
      const loanStartDate = el<HTMLInputElement>('asSolveStart').value;
      const loanTermYears = parseFloat(el<HTMLInputElement>('asSolveYears').value);
      const monthlyPayment = parseFloat(el<HTMLInputElement>('asLoanPay').value);
      const billingDayInput = parseInt(el<HTMLInputElement>('asLoanDay').value, 10);
      const startDay = loanStartDate ? Number(loanStartDate.slice(8, 10)) : undefined;
      const billingDay =
        !Number.isNaN(billingDayInput) && billingDayInput >= 1 && billingDayInput <= 31
          ? billingDayInput
          : startDay;

      const solved = solveImpliedLoanAnnualRate({
        baseBalance,
        anchorDate,
        loanStartDate,
        loanTermYears,
        monthlyPayment,
        billingDay,
      });
      el<HTMLInputElement>('asLoanRate').value = String(solved.annualRate);
      if (billingDay && (!el<HTMLInputElement>('asLoanDay').value || Number.isNaN(billingDayInput))) {
        el<HTMLInputElement>('asLoanDay').value = String(billingDay);
      }
      showToast(`推算年利率約 ${solved.annualRate}%（基準日起剩餘 ${solved.remainingPeriods} 期）`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '請先填妥基準餘額、月付金、申貸日與年限', 'error');
    }
  });
  solverBody.appendChild(solveBtn);
  solver.appendChild(solverBody);
  loanFields.appendChild(solver);
  loanBox.appendChild(loanFields);
  form.appendChild(loanBox);

  const exclLabel = document.createElement('label');
  exclLabel.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:11px 13px;margin-bottom:14px;border-radius:12px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
  const exclCb = document.createElement('input');
  exclCb.id = 'asExcludeNw';
  exclCb.type = 'checkbox';
  exclCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  exclCb.checked = Boolean(existing?.excludeFromNetWorth);
  const exclText = document.createElement('span');
  exclText.innerHTML =
    '<strong>單獨不計入個人總資產</strong><small style="display:block;color:var(--text-secondary);font-size:11px">即使歸屬在主帳本，也不納入整合淨資產計算（若已選獨立帳本則本來就不計入）</small>';
  exclLabel.appendChild(exclCb);
  exclLabel.appendChild(exclText);
  form.appendChild(exclLabel);

  form.appendChild(makeInputField('備註（選填）', 'asNote', 'text', existing?.note || ''));

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  if (existing) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = '刪除';
    del.addEventListener('click', async () => {
      if (!confirm(`確定刪除「${existing.itemName}」？`)) return;
      await ctx.engine.deleteAsset(existing.id);
      closeModal();
      showToast(`已刪除：${existing.itemName}`, 'success');
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

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary';
  save.textContent = '儲存並即時重算';
  btns.appendChild(save);
  form.appendChild(btns);

  const syncLoanVisibility = () => {
    const isLiab = el<HTMLSelectElement>('asMajor').value === '負債';
    loanBox.style.display = isLiab ? 'block' : 'none';
    loanFields.style.display = isLiab && loanCb.checked ? 'block' : 'none';
  };

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const majorType = el<HTMLSelectElement>('asMajor').value;
      const isAmortizingLoan = majorType === '負債' && loanCb.checked;
      const anchorVal = el<HTMLInputElement>('asLoanAnchor').value.trim();
      const rateVal = el<HTMLInputElement>('asLoanRate').value.trim();
      const payVal = el<HTMLInputElement>('asLoanPay').value.trim();
      const dayVal = el<HTMLInputElement>('asLoanDay').value.trim();

      const updateMode = el<HTMLSelectElement>('asMode').value;
      const rawPrice = el<HTMLInputElement>('asPrice').value.trim();
      const priceFields =
        existing && updateMode === '自動更新'
          ? resolveStockModalPriceFields({
              existing,
              rawPrice,
              hasPrevCloseInput: false,
              defaultNewPrice: 1,
            })
          : { unitPrice: parseFloat(rawPrice) || 1 };

      await ctx.engine.saveAsset({
        id: existing?.id,
        itemName: el<HTMLInputElement>('asName').value.trim(),
        majorType,
        updateMode,
        subCategory: el<HTMLSelectElement>('asSub').value,
        liquidity: el<HTMLSelectElement>('asLiq').value,
        quantityOrAmount: parseFloat(el<HTMLInputElement>('asQty').value),
        currency: el<HTMLSelectElement>('asCurr').value,
        ticker: el<HTMLInputElement>('asTicker').value.trim(),
        ...priceFields,
        ledgerId: el<HTMLSelectElement>('asLedger').value || DEFAULT_LEDGER_ID,
        excludeFromNetWorth: el<HTMLInputElement>('asExcludeNw').checked,
        note: el<HTMLInputElement>('asNote').value.trim(),
        isAmortizingLoan,
        balanceAnchorDate: isAmortizingLoan ? anchorVal || today : anchorVal || null,
        loanAnnualRate: rateVal !== '' ? parseFloat(rateVal) : null,
        loanMonthlyPayment: payVal !== '' ? parseFloat(payVal) : null,
        loanBillingDay: dayVal !== '' ? parseInt(dayVal, 10) : null,
      });
      closeModal();
      showToast('已更新資產負債項目', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
  el('asMajor').addEventListener('change', syncLoanVisibility);
  loanCb.addEventListener('change', syncLoanVisibility);
  syncLoanVisibility();
}
