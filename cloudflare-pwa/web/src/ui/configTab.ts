import {
  BILLING_CYCLES,
  CASHFLOW_TYPES,
  RECURRING_CASHFLOW_TYPES,
  SINKING_FUND_CATEGORIES,
} from '../../../shared/constants';
import {
  computeRecurringMonthlyTwd,
  computeSinkingMonthlyReserve,
  computeSinkingYtdSpent,
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
import type { UiContext } from './state';

export function renderConfigTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate;

  const recList = el('recurringList');
  recList.innerHTML = '';

  const filtered = snap.recurringItems.filter((item) => {
    if (item.deletedAt) return false;
    const f = ctx.state.recurringFilter;
    if (f === 'all') return true;
    if (f === 'income') return item.type.includes('收入');
    if (f === 'invest') return item.type === CASHFLOW_TYPES.INVESTMENT;
    if (f === 'fixed') return item.type === CASHFLOW_TYPES.FIXED_EXPENSE;
    if (f === 'sub') return item.type === CASHFLOW_TYPES.SUBSCRIPTION;
    return true;
  });

  if (!filtered.length) {
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
      const specText = item.billingSpec ? ` (${item.billingSpec})` : '';
      const monthlyTwd = computeRecurringMonthlyTwd(item, rate);
      sub.appendChild(
        document.createTextNode(
          `${item.cycle}${specText} · ${fmtRaw(item.amount, item.currency, ctx.state.masked)} · 月均 ${fmtMoney(monthlyTwd, ctx.state.masked)}`
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
  const activeSinking = snap.sinkingItems.filter((s) => !s.deletedAt);
  const monthlyTotal = activeSinking.reduce((s, i) => s + computeSinkingMonthlyReserve(i), 0);
  el('sinkingMonthlyTotal').textContent = fmtMoney(monthlyTotal, ctx.state.masked);

  const sList = el('sinkingList');
  sList.innerHTML = '';
  if (!activeSinking.length) {
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
  form.appendChild(makeInputField('項目名稱', 'recName', 'text', existing?.itemName || '', '例如：本業月薪、Claude Pro', true));

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
