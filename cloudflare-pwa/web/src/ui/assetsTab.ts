import { ASSET_SUB_CATEGORIES } from '../../../shared/constants';
import {
  computeAllSavingsSummary,
  computeAssetTwdValue,
  computeNetWorthSummary,
  computeSavingsAccountSummary,
} from '../../../shared/calculations';
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
  TRASH_SVG,
} from './helpers';
import type { UiContext } from './state';

function todayYmdLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtSignedMoney(n: number, masked: boolean): string {
  if (masked) return '•••••';
  if (n > 0) return '+' + fmtMoney(n, false, '');
  if (n < 0) return '-' + fmtMoney(Math.abs(n), false, '');
  return '0';
}

export function renderAssetsTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate;
  const activeAssets = snap.assetItems.filter((a) => !a.deletedAt);
  const adjustments = snap.savingsAdjustments || [];
  const nw = computeNetWorthSummary(activeAssets, rate, 0, snap.cashflowLogs, adjustments);

  el('netWorthHero').textContent = fmtMoney(nw.netWorth, ctx.state.masked);
  el('totalAssetsText').textContent = fmtMoney(nw.totalAssets, ctx.state.masked);
  el('totalLiabText').textContent = fmtMoney(nw.totalLiabilities, ctx.state.masked);
  el('debtRatioBadge').textContent = `負債比 ${nw.debtRatio.toFixed(1)}%`;

  document.querySelectorAll<HTMLButtonElement>('#allocModeToggle .mini-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.allocMode === ctx.state.allocMode);
  });

  const alloc = [
    { key: 'stock', name: '台股', val: nw.stockValue, color: '#4E8FE6' },
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

  // ==================== 活存帳戶區（與流水帳即時連動） ====================
  const savings = computeAllSavingsSummary(activeAssets, snap.cashflowLogs, adjustments, rate);
  el('assetsSavingsTotalLabel').textContent = `合計 ${fmtMoney(savings.totalSavingsTwd, ctx.state.masked)}`;
  const savList = el('savingsAccountsList');
  savList.innerHTML = '';

  if (!savings.accounts.length) {
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

  let autoCount = 0;
  let manualCount = 0;
  for (const item of activeAssets) {
    if (item.isLinkedSavings) continue;
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

export function openSavingsAccountModal(ctx: UiContext, existing: AssetItem | null): void {
  const body = openModal(existing ? '編輯活存帳戶' : '新增連動活存帳戶');
  const form = document.createElement('form');
  const today = todayYmdLocal();

  form.appendChild(
    makeInputField('活存帳戶名稱', 'svName', 'text', existing?.itemName || '', '例如：中信活存、台新 Richart', true)
  );

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
    'display:flex;align-items:center;gap:10px;padding:11px 13px;margin-bottom:14px;border-radius:12px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
  const defCb = document.createElement('input');
  defCb.id = 'svDefault';
  defCb.type = 'checkbox';
  defCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  const hasOtherSavings = ctx.engine
    .getSnapshot()
    .assetItems.some((a) => !a.deletedAt && a.isLinkedSavings && a.id !== existing?.id);
  defCb.checked = existing ? Boolean(existing.isDefaultSavings) : !hasOtherSavings;
  const defText = document.createElement('span');
  defText.innerHTML =
    '<strong>設為快速記帳預設連動帳戶</strong><small style="display:block;color:var(--text-secondary);font-size:11px">記帳時自動預選此帳戶，仍可隨時切換其他帳戶或不連動</small>';
  defLabel.appendChild(defCb);
  defLabel.appendChild(defText);
  form.appendChild(defLabel);

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

  form.addEventListener('submit', async (e) => {
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
  banner.innerHTML = `<span style="font-size:12.5px;color:var(--text-secondary);font-weight:600">目前即時餘額</span><strong class="tnum" style="font-size:18px;color:${summary.currentBalanceTwd < 0 ? 'var(--danger)' : 'var(--success)'}">${fmtMoney(summary.currentBalanceTwd, ctx.state.masked)}</strong>`;
  body.appendChild(banner);

  let mode: 'deposit' | 'withdraw' = 'deposit';
  const seg = document.createElement('div');
  seg.className = 'seg-bar';
  seg.style.marginBottom = '12px';
  const depBtn = document.createElement('button');
  depBtn.type = 'button';
  depBtn.className = 'seg-btn active';
  depBtn.textContent = '+ 存入活存';
  const wdBtn = document.createElement('button');
  wdBtn.type = 'button';
  wdBtn.className = 'seg-btn';
  wdBtn.textContent = '- 轉出 / 提領';
  seg.appendChild(depBtn);
  seg.appendChild(wdBtn);
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

  form.addEventListener('submit', async (e) => {
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
      sub.textContent = `${adj.date}${beforeAnchor}`;
      info.appendChild(title);
      info.appendChild(sub);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
      const amt = document.createElement('span');
      amt.className = 'tnum';
      amt.style.fontWeight = '700';
      amt.style.color = adj.twdAmount >= 0 ? 'var(--success)' : 'var(--danger)';
      amt.textContent = fmtSignedMoney(adj.twdAmount, ctx.state.masked);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn sm';
      delBtn.style.color = 'var(--text-muted)';
      delBtn.title = '刪除此筆紀錄';
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener('click', async () => {
        if (!confirm(`確定刪除此筆 ${adj.date} 的存轉紀錄？`)) return;
        await ctx.engine.deleteSavingsAdjustment(adj.id);
        showToast('已刪除存轉紀錄並重算餘額', 'success');
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
  const defaultVal =
    account.currency === 'USD'
      ? Math.round((summary.currentBalanceTwd / rate) * 100) / 100
      : summary.currentBalanceTwd;
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

  form.addEventListener('submit', async (e) => {
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
