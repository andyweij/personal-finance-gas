import { ASSET_SUB_CATEGORIES } from '../../../shared/constants';
import { computeAssetTwdValue, computeNetWorthSummary } from '../../../shared/calculations';
import type { AssetItem } from '../../../shared/types';
import {
  closeModal,
  el,
  fmtMoney,
  fmtNum,
  fmtRaw,
  makeInputField,
  makeSelectField,
  openModal,
  showToast,
} from './helpers';
import type { UiContext } from './state';

export function renderAssetsTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate;
  const activeAssets = snap.assetItems.filter((a) => !a.deletedAt);
  const nw = computeNetWorthSummary(activeAssets, rate, 0);

  el('netWorthHero').textContent = fmtMoney(nw.netWorth, ctx.state.masked);
  el('totalAssetsText').textContent = fmtMoney(nw.totalAssets, ctx.state.masked);
  el('totalLiabText').textContent = fmtMoney(nw.totalLiabilities, ctx.state.masked);
  el('debtRatioBadge').textContent = `負債比 ${nw.debtRatio.toFixed(1)}%`;

  document.querySelectorAll<HTMLButtonElement>('#allocModeToggle .mini-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.allocMode === ctx.state.allocMode);
  });

  const alloc = [
    { key: 'stock', name: '台股', val: nw.stockValue, color: '#4E8FE6' },
    { key: 'cash', name: '現金 / 美金', val: nw.cashUsdValue, color: '#34C759' },
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
    const pctStr = pctNum.toFixed(1) + '%';
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

  const autoList = el('autoAssetsList');
  const manualList = el('manualAssetsList');
  autoList.innerHTML = '';
  manualList.innerHTML = '';

  let autoCount = 0;
  let manualCount = 0;
  for (const item of activeAssets) {
    const twdVal = computeAssetTwdValue(item, rate);
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
    const detail = item.ticker
      ? `${item.ticker} · ${fmtNum(item.quantityOrAmount)} 股 @ ${item.unitPrice}`
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
    amt.style.color = item.majorType === '負債' ? 'var(--danger)' : 'var(--text)';
    amt.textContent = (item.majorType === '負債' ? '-' : '') + fmtMoney(twdVal, ctx.state.masked);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-outline btn-sm';
    editBtn.textContent = '更新';
    editBtn.addEventListener('click', () => openAssetModal(ctx, item));

    right.appendChild(amt);
    right.appendChild(editBtn);
    row.appendChild(main);
    row.appendChild(right);

    if (item.updateMode === '自動更新') {
      autoList.appendChild(row);
      autoCount++;
    } else {
      manualList.appendChild(row);
      manualCount++;
    }
  }

  if (!autoCount) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '尚無自動更新資產';
    autoList.appendChild(e);
  }
  if (!manualCount) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '尚無手動快照項目';
    manualList.appendChild(e);
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
      sub.textContent = `總資產 ${fmtMoney(h.totalAssets, ctx.state.masked)} ｜ 總負債 ${fmtMoney(h.totalLiabilities, ctx.state.masked)} ｜ 儲蓄率 ${(h.savingsRate * 100).toFixed(1)}%`;
      main.appendChild(t);
      main.appendChild(sub);

      const amt = document.createElement('div');
      amt.className = 'item-amount';
      amt.style.color = h.netWorth >= 0 ? 'var(--success)' : 'var(--danger)';
      amt.textContent = fmtMoney(h.netWorth, ctx.state.masked);
      row.appendChild(main);
      row.appendChild(amt);
      hList.appendChild(row);
    }
  }
}

export function openAssetModal(ctx: UiContext, existing: AssetItem | null): void {
  const body = openModal(existing ? '更新資產 / 負債餘額' : '新增資產 / 負債');
  const form = document.createElement('form');
  form.appendChild(makeInputField('項目名稱', 'asName', 'text', existing?.itemName || '', '如：0050、台幣定存、房貸餘額', true));

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
  r3.appendChild(makeInputField('持有股數 / 原幣餘額', 'asQty', 'number', existing?.quantityOrAmount ?? '', '0', true));
  r3.appendChild(makeSelectField('幣別', 'asCurr', ['TWD', 'USD'], existing?.currency || 'TWD'));
  form.appendChild(r3);

  const r4 = document.createElement('div');
  r4.className = 'row-2';
  r4.appendChild(makeInputField('股票代碼（選填，如 TPE:0050）', 'asTicker', 'text', existing?.ticker || '', 'TPE:0050'));
  r4.appendChild(makeInputField('目前單價（非股票填 1）', 'asPrice', 'number', existing?.unitPrice ?? 1, '1', true));
  form.appendChild(r4);

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.saveAsset({
        id: existing?.id,
        itemName: el<HTMLInputElement>('asName').value.trim(),
        majorType: el<HTMLSelectElement>('asMajor').value,
        updateMode: el<HTMLSelectElement>('asMode').value,
        subCategory: el<HTMLSelectElement>('asSub').value,
        liquidity: el<HTMLSelectElement>('asLiq').value,
        quantityOrAmount: parseFloat(el<HTMLInputElement>('asQty').value),
        currency: el<HTMLSelectElement>('asCurr').value,
        ticker: el<HTMLInputElement>('asTicker').value.trim(),
        unitPrice: parseFloat(el<HTMLInputElement>('asPrice').value) || 1,
        note: el<HTMLInputElement>('asNote').value.trim(),
      });
      closeModal();
      showToast('已更新資產負債項目', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}
