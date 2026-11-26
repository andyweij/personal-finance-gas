import {
  BILLING_CYCLES,
  CASHFLOW_TYPES,
  DEFAULT_LEDGER_ID,
  RECURRING_CASHFLOW_TYPES,
  SINKING_FUND_CATEGORIES,
} from '../../../shared/constants';
import {
  compareBySortOrder,
  computeRecurringMonthlyTwd,
  computeSinkingMonthlyReserve,
  computeSinkingYtdSpent,
  getEffectiveLedgerId,
} from '../../../shared/calculations';
import type { RecurringItem, SinkingFundItem } from '../../../shared/types';
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
import { buildLedgerSelectField, getActiveLedgers, renderLedgerSwitcherBar } from './ledgerUi';
import { renderReorderList } from './reorderHelper';
import type { UiContext } from './state';

export function getFilteredRecurringItems(ctx: UiContext): RecurringItem[] {
  const snap = ctx.engine.getSnapshot();
  const ledgerScope = ctx.state.recurringLedgerScope || 'all';
  return snap.recurringItems
    .filter((item) => {
      if (item.deletedAt) return false;
      if (ledgerScope !== 'all' && ledgerScope !== 'net_worth') {
        if (getEffectiveLedgerId(item) !== ledgerScope) return false;
      }
      const f = ctx.state.recurringFilter;
      if (f === 'all') return true;
      if (f === 'income') return item.type.includes('收入');
      if (f === 'invest') return item.type === CASHFLOW_TYPES.INVESTMENT;
      if (f === 'fixed') return item.type === CASHFLOW_TYPES.FIXED_EXPENSE;
      if (f === 'sub') return item.type === CASHFLOW_TYPES.SUBSCRIPTION;
      return true;
    })
    .slice()
    .sort(compareBySortOrder);
}

export function getActiveSinkingItems(ctx: UiContext): SinkingFundItem[] {
  return ctx.engine
    .getSnapshot()
    .sinkingItems.filter((s) => !s.deletedAt)
    .slice()
    .sort(compareBySortOrder);
}

export function renderConfigTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate;
  const ledgers = getActiveLedgers(ctx);
  const ledgerNameMap = new Map(ledgers.map((l) => [l.id, l.name]));

  const recLedgerBar = document.getElementById('recurringLedgerBar');
  if (recLedgerBar) {
    if (ledgers.length > 1) {
      recLedgerBar.style.display = 'flex';
      const curScope =
        ctx.state.recurringLedgerScope === 'all' ||
        ledgers.some((l) => l.id === ctx.state.recurringLedgerScope)
          ? ctx.state.recurringLedgerScope
          : 'all';
      ctx.state.recurringLedgerScope = curScope;
      renderLedgerSwitcherBar(ctx, recLedgerBar, {
        mode: 'scope',
        selectedValue: curScope,
        onSelect: (nextScope) => {
          ctx.state.recurringLedgerScope = nextScope === 'net_worth' ? 'all' : nextScope;
          renderConfigTab(ctx);
        },
      });
    } else {
      recLedgerBar.style.display = 'none';
    }
  }

  const recList = el('recurringList');
  recList.innerHTML = '';

  const filtered = getFilteredRecurringItems(ctx);
  const recReorderBtn = el<HTMLButtonElement>('reorderRecurringBtn');
  const isReorderingRec = ctx.state.reorderSection === 'recurring';
  recReorderBtn.style.display = filtered.length >= 2 && !isReorderingRec ? '' : 'none';

  const savingsMap = new Map(
    snap.assetItems.filter((a) => !a.deletedAt && a.isLinkedSavings).map((a) => [a.id, a.itemName])
  );

  if (isReorderingRec && filtered.length >= 2) {
    renderReorderList(ctx, {
      container: recList,
      section: 'recurring',
      items: filtered.map((item) => {
        const monthlyTwd = computeRecurringMonthlyTwd(item, rate);
        return {
          id: item.id,
          title: item.itemName,
          badge: item.type,
          subtitle: `${item.cycle} · ${fmtRaw(item.amount, item.currency, ctx.state.masked)} · 月均 ${fmtMoney(monthlyTwd, ctx.state.masked)}`,
        };
      }),
      onSave: (orderedIds) => ctx.engine.reorderRecurring(orderedIds),
      onReRender: () => renderConfigTab(ctx),
    });
  } else if (!filtered.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '此分類尚無固定設定，點右上角「+ 新增」';
    recList.appendChild(e);
  } else {
    for (const item of filtered) {
      const row = document.createElement('div');
      row.className = 'list-row' + (item.status === '停用' ? ' inactive' : '');

      const main = document.createElement('div');
      main.className = 'item-main';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.itemName;

      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      const badge = document.createElement('span');
      badge.className = 'badge' + (item.type.includes('收入') ? ' green' : '');
      badge.textContent = item.type;
      sub.appendChild(badge);
      const itemLedgerId = getEffectiveLedgerId(item);
      if (ledgers.length > 1 && itemLedgerId !== DEFAULT_LEDGER_ID) {
        const lgBadge = document.createElement('span');
        lgBadge.className = 'badge warn';
        lgBadge.textContent = ledgerNameMap.get(itemLedgerId) || '獨立帳本';
        sub.appendChild(lgBadge);
      }
      const specText = item.billingSpec ? ` (${item.billingSpec})` : '';
      const monthlyTwd = computeRecurringMonthlyTwd(item, rate);
      const linkedName = item.linkedAccountId ? savingsMap.get(item.linkedAccountId) : null;
      sub.appendChild(
        document.createTextNode(
          `${item.cycle}${specText} · ${fmtRaw(item.amount, item.currency, ctx.state.masked)} · 月均 ${fmtMoney(monthlyTwd, ctx.state.masked)}${linkedName ? ` · 活存:${linkedName}` : ''}`
        )
      );
      main.appendChild(title);
      main.appendChild(sub);

      const right = document.createElement('div');
      right.className = 'item-right';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => openRecurringModal(ctx, item));

      const sw = document.createElement('label');
      sw.className = 'switch';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.status === '啟用';
      cb.addEventListener('change', async () => {
        const nextStatus = cb.checked ? '啟用' : '停用';
        await ctx.engine.saveRecurring({ ...item, status: nextStatus });
        showToast(`${item.itemName} 已設為「${nextStatus}」`, 'success');
        ctx.scheduleSync();
      });
      const sl = document.createElement('span');
      sl.className = 'slider';
      sw.appendChild(cb);
      sw.appendChild(sl);

      right.appendChild(editBtn);
      right.appendChild(sw);
      row.appendChild(main);
      row.appendChild(right);
      recList.appendChild(row);
    }
  }

  // Sinking fund list
  const activeSinking = getActiveSinkingItems(ctx);
  const monthlyTotal = activeSinking.reduce((s, i) => s + computeSinkingMonthlyReserve(i), 0);
  el('sinkingMonthlyTotal').textContent = fmtMoney(monthlyTotal, ctx.state.masked);

  const sinkReorderBtn = el<HTMLButtonElement>('reorderSinkingBtn');
  const isReorderingSink = ctx.state.reorderSection === 'sinking';
  sinkReorderBtn.style.display = activeSinking.length >= 2 && !isReorderingSink ? '' : 'none';

  const sList = el('sinkingList');
  sList.innerHTML = '';
  if (isReorderingSink && activeSinking.length >= 2) {
    renderReorderList(ctx, {
      container: sList,
      section: 'sinking',
      items: activeSinking.map((item) => ({
        id: item.id,
        title: item.itemName,
        badge: `${item.months} 個月`,
        subtitle: `總額 ${fmtMoney(item.totalAmount, ctx.state.masked)} · 每月提撥 ${fmtMoney(computeSinkingMonthlyReserve(item), ctx.state.masked)}`,
      })),
      onSave: (orderedIds) => ctx.engine.reorderSinking(orderedIds),
      onReRender: () => renderConfigTab(ctx),
    });
  } else if (!activeSinking.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '尚無不定期攤提項目，點右上角「+ 新增攤提」';
    sList.appendChild(e);
  } else {
    for (const item of activeSinking) {
      const reserve = computeSinkingMonthlyReserve(item);
      const ytd = computeSinkingYtdSpent(snap.cashflowLogs, ctx.state.selectedYear, item.itemName);
      const row = document.createElement('div');
      row.className = 'list-row' + (item.status === '停用' ? ' inactive' : '');

      const main = document.createElement('div');
      main.className = 'item-main';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.itemName;
      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = `${item.months} 個月`;
      sub.appendChild(badge);
      sub.appendChild(
        document.createTextNode(
          `總額 ${fmtMoney(item.totalAmount, ctx.state.masked)} · 本年已繳 ${fmtMoney(ytd, ctx.state.masked)}`
        )
      );
      main.appendChild(title);
      main.appendChild(sub);

      const right = document.createElement('div');
      right.className = 'item-right';
      const amt = document.createElement('div');
      amt.className = 'item-amount';
      amt.textContent = fmtMoney(reserve, ctx.state.masked) + '/月';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '調整';
      editBtn.addEventListener('click', () => openSinkingModal(ctx, item));

      right.appendChild(amt);
      right.appendChild(editBtn);
      row.appendChild(main);
      row.appendChild(right);
      sList.appendChild(row);
    }
  }
}

export function openRecurringModal(ctx: UiContext, existing: RecurringItem | null): void {
  const body = openModal(existing ? '編輯固定收支 / 訂閱' : '新增固定收支 / 訂閱');
  const form = document.createElement('form');
  const initialLedgerId = existing
    ? getEffectiveLedgerId(existing)
    : ctx.state.recurringLedgerScope !== 'all' && ctx.state.recurringLedgerScope !== 'net_worth'
      ? ctx.state.recurringLedgerScope
      : DEFAULT_LEDGER_ID;

  form.appendChild(makeInputField('項目名稱', 'recName', 'text', existing?.itemName || '', '例如：本業月薪、Claude Pro', true));

  form.appendChild(buildLedgerSelectField(ctx, 'recLedger', initialLedgerId, '所屬帳本'));

  const r1 = document.createElement('div');
  r1.className = 'row-2';
  r1.appendChild(makeSelectField('收支類型', 'recType', RECURRING_CASHFLOW_TYPES, existing?.type || CASHFLOW_TYPES.SUBSCRIPTION));
  r1.appendChild(makeInputField('分類', 'recCat', 'text', existing?.category || 'AI訂閱', '例如：薪資/房貸/AI訂閱', true));
  form.appendChild(r1);

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(makeInputField('金額', 'recAmt', 'number', existing?.amount ?? '', '0', true));
  r2.appendChild(makeSelectField('幣別', 'recCurr', ['TWD', 'USD'], existing?.currency || 'TWD'));
  form.appendChild(r2);

  const r3 = document.createElement('div');
  r3.className = 'row-2';
  r3.appendChild(makeSelectField('入帳 / 扣款週期', 'recCycle', BILLING_CYCLES, existing?.cycle || '月繳'));
  r3.appendChild(makeSelectField('狀態', 'recStatus', ['啟用', '停用'], existing?.status || '啟用'));
  form.appendChild(r3);

  form.appendChild(
    makeInputField(
      '生效月份（月繳留空｜年繳填 1-12｜特定月填 3,6,9,12｜一次填 2026-12）',
      'recSpec',
      'text',
      existing?.billingSpec || '',
      '例如：3,6,9,12 或 2026-12'
    )
  );

  // Linked savings account selector (scoped to selected ledger)
  const linkWrap = document.createElement('div');
  linkWrap.className = 'field';
  const linkLbl = document.createElement('label');
  linkLbl.className = 'section-label';
  linkLbl.htmlFor = 'recLinkedAccount';
  linkLbl.textContent = '自動入帳連動活存帳戶（選填）';
  const linkSel = document.createElement('select');
  linkSel.id = 'recLinkedAccount';

  const populateSavingsForLedger = (ledgerId: string, preferredAccId: string | null) => {
    linkSel.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '不連動活存';
    linkSel.appendChild(noneOpt);
    const savingsAccounts = ctx.engine
      .getSnapshot()
      .assetItems.filter(
        (a) => !a.deletedAt && a.isLinkedSavings && getEffectiveLedgerId(a) === ledgerId
      );
    for (const acc of savingsAccounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = `${acc.isDefaultSavings ? '★ ' : ''}${acc.itemName}`;
      if (preferredAccId === acc.id) opt.selected = true;
      linkSel.appendChild(opt);
    }
  };
  populateSavingsForLedger(initialLedgerId, existing?.linkedAccountId ?? null);

  linkWrap.appendChild(linkLbl);
  linkWrap.appendChild(linkSel);
  form.appendChild(linkWrap);

  form.appendChild(makeInputField('備註（選填）', 'recNote', 'text', existing?.note || ''));

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  if (existing) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = '刪除項目';
    del.addEventListener('click', async () => {
      if (!confirm(`確定刪除「${existing.itemName}」？（不會影響歷史流水帳）`)) return;
      await ctx.engine.deleteRecurring(existing.id);
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
  save.textContent = '儲存設定';
  btns.appendChild(save);
  form.appendChild(btns);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.saveRecurring({
        id: existing?.id,
        itemName: el<HTMLInputElement>('recName').value.trim(),
        type: el<HTMLSelectElement>('recType').value,
        category: el<HTMLInputElement>('recCat').value.trim(),
        amount: parseFloat(el<HTMLInputElement>('recAmt').value),
        currency: el<HTMLSelectElement>('recCurr').value,
        cycle: el<HTMLSelectElement>('recCycle').value,
        billingSpec: el<HTMLInputElement>('recSpec').value.trim(),
        status: el<HTMLSelectElement>('recStatus').value,
        linkedAccountId: el<HTMLSelectElement>('recLinkedAccount').value || null,
        ledgerId: el<HTMLSelectElement>('recLedger').value || DEFAULT_LEDGER_ID,
        note: el<HTMLInputElement>('recNote').value.trim(),
      });
      closeModal();
      showToast(existing ? '已更新固定設定' : '已新增固定設定', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
  const ledgerSel = el<HTMLSelectElement>('recLedger');
  ledgerSel.addEventListener('change', () => {
    populateSavingsForLedger(ledgerSel.value || DEFAULT_LEDGER_ID, null);
  });
}

export function openSinkingModal(ctx: UiContext, existing: SinkingFundItem | null): void {
  const body = openModal(existing ? '調整不定期攤提與月數' : '新增不定期攤提');
  const form = document.createElement('form');
  form.appendChild(makeInputField('項目名稱', 'sfName', 'text', existing?.itemName || '', '如：綜合所得稅、出國旅遊', true));
  form.appendChild(makeSelectField('分類', 'sfCat', SINKING_FUND_CATEGORIES, existing?.category || SINKING_FUND_CATEGORIES[0]));

  const r2 = document.createElement('div');
  r2.className = 'row-2';
  r2.appendChild(makeInputField('預估總金額 (TWD)', 'sfAmt', 'number', existing?.totalAmount ?? '', '60000', true));
  r2.appendChild(makeInputField('分攤月數（如 3/6/12/24）', 'sfMonths', 'number', existing?.months ?? 12, '12', true));
  form.appendChild(r2);

  const preview = document.createElement('div');
  preview.className = 'tnum';
  preview.style.cssText = 'font-size:13px;font-weight:600;color:var(--primary);margin-bottom:12px';
  const updatePreview = () => {
    const a = parseFloat(el<HTMLInputElement>('sfAmt').value) || 0;
    const m = Math.max(1, parseInt(el<HTMLInputElement>('sfMonths').value, 10) || 12);
    preview.textContent = `試算每月應提撥：NT$ ${fmtNum(Math.round(a / m))} / 月`;
  };
  form.appendChild(preview);

  const r3 = document.createElement('div');
  r3.className = 'row-2';
  r3.appendChild(makeInputField('預計繳款月份', 'sfDue', 'text', existing?.dueNote || '', '例如 5月'));
  r3.appendChild(makeSelectField('狀態', 'sfStatus', ['啟用', '停用'], existing?.status || '啟用'));
  form.appendChild(r3);
  form.appendChild(makeInputField('備註', 'sfNote', 'text', existing?.note || ''));

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  if (existing) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = '刪除';
    del.addEventListener('click', async () => {
      if (!confirm(`確定刪除「${existing.itemName}」？`)) return;
      await ctx.engine.deleteSinking(existing.id);
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
  save.textContent = '儲存攤提設定';
  btns.appendChild(save);
  form.appendChild(btns);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.saveSinking({
        id: existing?.id,
        itemName: el<HTMLInputElement>('sfName').value.trim(),
        category: el<HTMLSelectElement>('sfCat').value,
        totalAmount: parseFloat(el<HTMLInputElement>('sfAmt').value),
        months: parseInt(el<HTMLInputElement>('sfMonths').value, 10),
        dueNote: el<HTMLInputElement>('sfDue').value.trim(),
        status: el<HTMLSelectElement>('sfStatus').value,
        note: el<HTMLInputElement>('sfNote').value.trim(),
      });
      closeModal();
      showToast('已儲存不定期攤提設定', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
  el('sfAmt').addEventListener('input', updatePreview);
  el('sfMonths').addEventListener('input', updatePreview);
  updatePreview();
}
