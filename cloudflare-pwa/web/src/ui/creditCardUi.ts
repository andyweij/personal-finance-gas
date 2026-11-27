import { getEffectiveLedgerId, isTransferableAccount } from '../../../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../../../shared/constants';
import {
  computeAllCreditCardsSummary,
  computeInstallmentPlanProgress,
  computeInstallmentScheduleAmounts,
  isCreditCardAsset,
} from '../../../shared/creditCard';
import { getCurrencyDecimals, resolveFxRate } from '../../../shared/currency';
import { todayInTimeZone } from '../../../shared/dates';
import type {
  AssetItem,
  CreditCardSummary,
  InstallmentPlan,
  InstallmentPlanStatus,
} from '../../../shared/types';
import {
  getEffectiveCategoriesForType,
  normalizeEnabledCurrencies,
} from '../../../shared/validation';
import {
  bindSubmit,
  closeModal,
  fmtMoney,
  fmtPct,
  fmtRaw,
  openModal,
  showToast,
} from './helpers';
import { buildLedgerSelectField, getActiveLedgers } from './ledgerUi';
import type { UiContext } from './state';

let instFilterMode: 'active' | 'all' = 'active';

const INST_STATUS_META: Record<InstallmentPlanStatus, { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'badge amber' },
  completed: { label: '已結清', cls: 'badge green' },
  cancelled: { label: '已取消', cls: 'badge' },
};

function fmtCardNative(amount: number, currency: string, masked: boolean): string {
  if (masked) return '•••••';
  if (currency === 'TWD') return fmtMoney(amount, false);
  return fmtRaw(amount, currency, false);
}

export function openCreditCardModal(
  ctx: UiContext,
  existing: AssetItem | null,
  presetLedgerId?: string
): void {
  const snap = ctx.engine.getSnapshot();
  const enabledCurrs = normalizeEnabledCurrencies(snap.settings.enabledCurrencies);
  const currOptions =
    existing?.currency && !enabledCurrs.includes(existing.currency)
      ? [...enabledCurrs, existing.currency]
      : enabledCurrs;

  const body = openModal(existing ? `編輯信用卡 · ${existing.itemName}` : '新增信用卡帳戶');
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const makeField = (labelText: string, inputEl: Node, subHint?: string) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.marginBottom = '0';
    const lbl = document.createElement('label');
    lbl.className = 'section-label';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(inputEl);
    if (subHint) {
      const h = document.createElement('div');
      h.className = 'muted';
      h.style.cssText = 'font-size:11px;margin-top:3px';
      h.textContent = subHint;
      wrap.appendChild(h);
    }
    return wrap;
  };

  const nameInp = document.createElement('input');
  nameInp.type = 'text';
  nameInp.maxLength = 80;
  nameInp.required = true;
  nameInp.placeholder = '例如：中信 Line Pay、玉山 UBear、國泰 CUBE';
  nameInp.value = existing?.itemName || '';
  form.appendChild(makeField('信用卡名稱', nameInp));

  const currSel = document.createElement('select');
  for (const c of currOptions) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === (existing?.currency || 'TWD')) o.selected = true;
    currSel.appendChild(o);
  }

  const limitInp = document.createElement('input');
  limitInp.type = 'number';
  limitInp.inputMode = 'decimal';
  limitInp.step = 'any';
  limitInp.min = '0';
  limitInp.className = 'tnum';
  limitInp.placeholder = '選填（例如 200000）';
  limitInp.value =
    existing?.creditLimit !== undefined && existing?.creditLimit !== null
      ? String(existing.creditLimit)
      : '';

  const rowCurrLimit = document.createElement('div');
  rowCurrLimit.className = 'row-2';
  rowCurrLimit.appendChild(makeField('帳單幣別', currSel));
  rowCurrLimit.appendChild(makeField('信用額度（選填）', limitInp));
  form.appendChild(rowCurrLimit);

  const billingDayInp = document.createElement('input');
  billingDayInp.type = 'number';
  billingDayInp.inputMode = 'numeric';
  billingDayInp.min = '1';
  billingDayInp.max = '31';
  billingDayInp.required = true;
  billingDayInp.className = 'tnum';
  billingDayInp.value = String(existing?.creditBillingDay ?? 15);

  const dueDayInp = document.createElement('input');
  dueDayInp.type = 'number';
  dueDayInp.inputMode = 'numeric';
  dueDayInp.min = '1';
  dueDayInp.max = '31';
  dueDayInp.required = true;
  dueDayInp.className = 'tnum';
  dueDayInp.value = String(existing?.creditDueDay ?? 1);

  const rowCycle = document.createElement('div');
  rowCycle.className = 'row-2';
  rowCycle.appendChild(makeField('每月結帳日 (1～31)', billingDayInp));
  rowCycle.appendChild(makeField('每月繳款截止日 (1～31)', dueDayInp));
  form.appendChild(rowCycle);

  const balInp = document.createElement('input');
  balInp.type = 'number';
  balInp.inputMode = 'decimal';
  balInp.step = 'any';
  balInp.min = '0';
  balInp.required = true;
  balInp.className = 'tnum';
  balInp.value = String(existing?.quantityOrAmount ?? 0);

  const anchorInp = document.createElement('input');
  anchorInp.type = 'date';
  anchorInp.className = 'tnum';
  anchorInp.required = true;
  anchorInp.value = existing?.balanceAnchorDate || todayInTimeZone();

  const rowBal = document.createElement('div');
  rowBal.className = 'row-2';
  rowBal.appendChild(makeField('基準未繳餘額', balInp));
  rowBal.appendChild(makeField('基準生效日', anchorInp));
  form.appendChild(rowBal);

  const defaultLedgerId =
    existing
      ? getEffectiveLedgerId(existing)
      : presetLedgerId && presetLedgerId !== 'net_worth' && presetLedgerId !== 'all'
        ? presetLedgerId
        : DEFAULT_LEDGER_ID;
  const ledgerWrap = buildLedgerSelectField(ctx, 'ccLedgerSelect', defaultLedgerId);
  form.appendChild(ledgerWrap);

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 200;
  noteInp.placeholder = '例如：網購 3%、海外刷卡主力';
  noteInp.value = existing?.note || '';
  form.appendChild(makeField('備註（選填）', noteInp));

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = existing ? '儲存信用卡設定' : '建立信用卡帳戶';
  form.appendChild(submitBtn);

  if (existing) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = '刪除此信用卡帳戶';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      try {
        await ctx.engine.deleteAsset(existing.id);
        closeModal();
        ctx.renderAll();
        showToast(`已刪除信用卡「${existing.itemName}」`, 'success');
        void ctx.engine.syncNow();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '刪除失敗', 'error');
      } finally {
        delBtn.disabled = false;
      }
    });
    form.appendChild(delBtn);
  }

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const ledgerSel = ledgerWrap.querySelector('select') as HTMLSelectElement | null;
      const limitVal = limitInp.value.trim();
      await ctx.engine.saveAsset({
        ...(existing ? { id: existing.id } : {}),
        updateMode: '手動快照',
        majorType: '負債',
        subCategory: '信用卡',
        liquidity: '負債',
        itemName: nameInp.value.trim(),
        quantityOrAmount: Number(balInp.value || 0),
        currency: currSel.value || 'TWD',
        unitPrice: 1,
        isCreditCard: true,
        creditBillingDay: Number(billingDayInp.value || 15),
        creditDueDay: Number(dueDayInp.value || 1),
        creditLimit: limitVal !== '' ? Number(limitVal) : null,
        balanceAnchorDate: anchorInp.value,
        balanceAnchorAt: existing?.balanceAnchorAt || new Date().toISOString(),
        ledgerId: ledgerSel?.value || defaultLedgerId,
        note: noteInp.value.trim(),
      });
      closeModal();
      ctx.renderAll();
      showToast(existing ? '已更新信用卡設定' : '已新增信用卡帳戶', 'success');
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存信用卡失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function openPayCreditCardModal(ctx: UiContext, summary: CreditCardSummary): void {
  const snap = ctx.engine.getSnapshot();
  const card = summary.card;
  const fromAccounts = snap.assetItems.filter((a) => isTransferableAccount(a));

  const body = openModal(`繳納卡費 · ${card.itemName}`);
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const info = document.createElement('div');
  info.className = 'split-preview-box tnum';
  info.textContent = `總未繳 ${fmtMoney(summary.currentBalanceTwd, ctx.state.masked)} · 本期已出帳未繳 ${fmtMoney(summary.billedUnpaidTwd, ctx.state.masked)}（截止 ${summary.billingWindow.paymentDueDate}）· 繳卡費屬於帳戶轉移，不會重複計入消費或影響儲蓄率。`;
  form.appendChild(info);

  if (!fromAccounts.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '尚未建立任何活存或現金帳戶，請先建立活存帳戶後再繳卡費。';
    form.appendChild(empty);
    body.appendChild(form);
    return;
  }

  const makeField = (labelText: string, inputEl: Node, subHint?: string) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.marginBottom = '0';
    const lbl = document.createElement('label');
    lbl.className = 'section-label';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(inputEl);
    if (subHint) {
      const h = document.createElement('div');
      h.className = 'muted';
      h.style.cssText = 'font-size:11px;margin-top:3px';
      h.textContent = subHint;
      wrap.appendChild(h);
    }
    return wrap;
  };

  const fromSel = document.createElement('select');
  const cardLedgerId = getEffectiveLedgerId(card);
  const preferredFrom =
    fromAccounts.find((a) => getEffectiveLedgerId(a) === cardLedgerId && a.isDefaultSavings)?.id ||
    fromAccounts.find((a) => getEffectiveLedgerId(a) === cardLedgerId && a.isLinkedSavings)?.id ||
    fromAccounts[0].id;
  for (const a of fromAccounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${a.itemName} (${a.currency})`;
    if (a.id === preferredFrom) o.selected = true;
    fromSel.appendChild(o);
  }
  form.appendChild(makeField('扣款活存 / 現金帳戶', fromSel));

  const defaultPayAmt =
    summary.billedUnpaidTwd > 0 && card.currency === 'TWD'
      ? summary.billedUnpaidTwd
      : Math.max(0, summary.currentBalanceNative);

  const amtInp = document.createElement('input');
  amtInp.type = 'number';
  amtInp.inputMode = 'decimal';
  amtInp.step = 'any';
  amtInp.min = '0.01';
  amtInp.required = true;
  amtInp.className = 'tnum';
  amtInp.value = defaultPayAmt > 0 ? String(defaultPayAmt) : '';

  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'tnum';
  dateInp.required = true;
  dateInp.value = todayInTimeZone();

  const row1 = document.createElement('div');
  row1.className = 'row-2';
  row1.appendChild(makeField('繳款金額', amtInp));
  row1.appendChild(makeField('繳款日期', dateInp));
  form.appendChild(row1);

  const crossWrap = document.createElement('div');
  crossWrap.className = 'goal-conditional-box';
  crossWrap.style.display = 'none';
  const cardCreditInp = document.createElement('input');
  cardCreditInp.type = 'number';
  cardCreditInp.inputMode = 'decimal';
  cardCreditInp.step = 'any';
  cardCreditInp.min = '0.01';
  cardCreditInp.className = 'tnum';
  const crossField = makeField(`沖銷信用卡帳單金額 (${card.currency})`, cardCreditInp);
  crossWrap.appendChild(crossField);
  form.appendChild(crossWrap);

  const updateCross = () => {
    const acc = fromAccounts.find((a) => a.id === fromSel.value);
    if (!acc || acc.currency === card.currency) {
      crossWrap.style.display = 'none';
      cardCreditInp.value = '';
      return;
    }
    crossWrap.style.display = '';
    const amt = Number(amtInp.value || 0);
    if (amt > 0) {
      const fRate = resolveFxRate(acc.currency, snap.settings);
      const cRate = resolveFxRate(card.currency, snap.settings);
      const dec = getCurrencyDecimals(card.currency);
      const est = Math.round(((amt * fRate) / (cRate || 1)) * Math.pow(10, dec)) / Math.pow(10, dec);
      cardCreditInp.value = String(est);
    }
  };
  fromSel.addEventListener('change', updateCross);
  amtInp.addEventListener('input', updateCross);
  updateCross();

  const feeInp = document.createElement('input');
  feeInp.type = 'number';
  feeInp.inputMode = 'decimal';
  feeInp.step = 'any';
  feeInp.min = '0';
  feeInp.className = 'tnum';
  feeInp.placeholder = '0';
  feeInp.value = '0';

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 120;
  noteInp.placeholder = '例如：11月帳單全額扣繳';

  const row2 = document.createElement('div');
  row2.className = 'row-2';
  row2.appendChild(makeField('手續費（選填）', feeInp));
  row2.appendChild(makeField('備註（選填）', noteInp));
  form.appendChild(row2);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認繳納卡費';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const acc = fromAccounts.find((a) => a.id === fromSel.value);
      const isCross = Boolean(acc && acc.currency !== card.currency);
      await ctx.engine.payCreditCardBill({
        fromAccountId: fromSel.value,
        cardAccountId: card.id,
        amount: Number(amtInp.value || 0),
        date: dateInp.value,
        cardCreditAmount:
          isCross && Number(cardCreditInp.value) > 0 ? Number(cardCreditInp.value) : undefined,
        fee: Number(feeInp.value || 0),
        note: noteInp.value.trim(),
      });
      closeModal();
      ctx.renderAll();
      showToast(`已繳納「${card.itemName}」卡費`, 'success');
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '繳卡費失敗', 'error');
    }
  });

  body.appendChild(form);
}

function openReconcileCreditCardModal(ctx: UiContext, summary: CreditCardSummary): void {
  const card = summary.card;
  const body = openModal(`對帳校準 · ${card.itemName}`);
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const hint = document.createElement('div');
  hint.className = 'split-preview-box tnum';
  hint.textContent = `目前推算未繳：${fmtCardNative(summary.currentBalanceNative, card.currency, ctx.state.masked)}。校準後會將基準未繳設為您輸入的實際金額，並自生效日起重新累計新交易。`;
  form.appendChild(hint);

  const balInp = document.createElement('input');
  balInp.type = 'number';
  balInp.inputMode = 'decimal';
  balInp.step = 'any';
  balInp.min = '0';
  balInp.required = true;
  balInp.className = 'tnum';
  balInp.value = String(Math.max(0, summary.currentBalanceNative));

  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'tnum';
  dateInp.required = true;
  dateInp.value = todayInTimeZone();

  const row = document.createElement('div');
  row.className = 'row-2';
  const f1 = document.createElement('div');
  f1.className = 'field';
  f1.style.marginBottom = '0';
  const l1 = document.createElement('label');
  l1.className = 'section-label';
  l1.textContent = `實際未繳金額 (${card.currency})`;
  f1.appendChild(l1);
  f1.appendChild(balInp);

  const f2 = document.createElement('div');
  f2.className = 'field';
  f2.style.marginBottom = '0';
  const l2 = document.createElement('label');
  l2.className = 'section-label';
  l2.textContent = '基準生效日';
  f2.appendChild(l2);
  f2.appendChild(dateInp);

  row.appendChild(f1);
  row.appendChild(f2);
  form.appendChild(row);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認校準未繳餘額';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.reconcileCreditCard(card.id, Number(balInp.value || 0), dateInp.value);
      closeModal();
      ctx.renderAll();
      showToast(`已校準「${card.itemName}」未繳餘額`, 'success');
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '校準失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function openInstallmentPlanModal(
  ctx: UiContext,
  existing: InstallmentPlan | null,
  presetCardId?: string
): void {
  const snap = ctx.engine.getSnapshot();
  const cards = snap.assetItems.filter((a) => isCreditCardAsset(a));
  const enabledCurrs = normalizeEnabledCurrencies(snap.settings.enabledCurrencies);
  const categories = getEffectiveCategoriesForType(
    CASHFLOW_TYPES.DAILY_EXPENSE,
    snap.settings.customCategories
  );
  const today = todayInTimeZone();
  const currentYm = today.slice(0, 7);
  const todayDay = Number(today.slice(8, 10)) || 1;

  const body = openModal(existing ? `編輯分期 · ${existing.itemName}` : '新增信用卡分期付款');
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const makeField = (labelText: string, inputEl: Node, subHint?: string) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.marginBottom = '0';
    const lbl = document.createElement('label');
    lbl.className = 'section-label';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(inputEl);
    if (subHint) {
      const h = document.createElement('div');
      h.className = 'muted';
      h.style.cssText = 'font-size:11px;margin-top:3px';
      h.textContent = subHint;
      wrap.appendChild(h);
    }
    return wrap;
  };

  const nameInp = document.createElement('input');
  nameInp.type = 'text';
  nameInp.maxLength = 80;
  nameInp.required = true;
  nameInp.placeholder = '例如：MacBook Pro、家電分期、保費分期';
  nameInp.value = existing?.itemName || '';
  form.appendChild(makeField('分期項目名稱', nameInp));

  const catSel = document.createElement('select');
  const catOpts =
    existing?.category && !categories.includes(existing.category)
      ? [existing.category, ...categories]
      : categories;
  for (const c of catOpts) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === (existing?.category || '其他')) o.selected = true;
    catSel.appendChild(o);
  }

  const cardSel = document.createElement('select');
  const noCardOpt = document.createElement('option');
  noCardOpt.value = '';
  noCardOpt.textContent = '不綁定信用卡（一般分期）';
  cardSel.appendChild(noCardOpt);
  const selectedCardId = existing ? existing.cardAccountId || '' : presetCardId || cards[0]?.id || '';
  for (const c of cards) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.itemName} (${c.currency})`;
    if (c.id === selectedCardId) o.selected = true;
    cardSel.appendChild(o);
  }

  const row1 = document.createElement('div');
  row1.className = 'row-2';
  row1.appendChild(makeField('消費分類', catSel));
  row1.appendChild(makeField('綁定信用卡', cardSel));
  form.appendChild(row1);

  const totalInp = document.createElement('input');
  totalInp.type = 'number';
  totalInp.inputMode = 'decimal';
  totalInp.step = 'any';
  totalInp.min = '0.01';
  totalInp.required = true;
  totalInp.className = 'tnum';
  totalInp.placeholder = '例如：36000';
  totalInp.value = existing ? String(existing.totalAmount) : '';

  const currSel = document.createElement('select');
  const currOpts =
    existing?.currency && !enabledCurrs.includes(existing.currency)
      ? [...enabledCurrs, existing.currency]
      : enabledCurrs;
  for (const c of currOpts) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === (existing?.currency || 'TWD')) o.selected = true;
    currSel.appendChild(o);
  }

  const row2 = document.createElement('div');
  row2.className = 'row-2';
  row2.appendChild(makeField('分期總金額', totalInp));
  row2.appendChild(makeField('幣別', currSel));
  form.appendChild(row2);

  const instCountInp = document.createElement('input');
  instCountInp.type = 'number';
  instCountInp.inputMode = 'numeric';
  instCountInp.min = '2';
  instCountInp.max = '60';
  instCountInp.required = true;
  instCountInp.className = 'tnum';
  instCountInp.value = String(existing?.totalInstallments ?? 6);

  const postedInp = document.createElement('input');
  postedInp.type = 'number';
  postedInp.inputMode = 'numeric';
  postedInp.min = '0';
  postedInp.max = '60';
  postedInp.required = true;
  postedInp.className = 'tnum';
  postedInp.value = String(existing?.postedInstallments ?? 0);

  const row3 = document.createElement('div');
  row3.className = 'row-2';
  row3.appendChild(makeField('總期數 (2～60)', instCountInp));
  row3.appendChild(makeField('已入帳期數', postedInp));
  form.appendChild(row3);

  // Quick period chips
  const quickPeriods = document.createElement('div');
  quickPeriods.className = 'quick-row';
  for (const n of [3, 6, 12, 24]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn sm';
    b.textContent = `${n} 期`;
    b.addEventListener('click', () => {
      instCountInp.value = String(n);
      updatePreview();
    });
    quickPeriods.appendChild(b);
  }
  form.appendChild(quickPeriods);

  const startYmInp = document.createElement('input');
  startYmInp.type = 'month';
  startYmInp.className = 'tnum';
  startYmInp.required = true;
  startYmInp.value = existing?.startYm || currentYm;

  const postDayInp = document.createElement('input');
  postDayInp.type = 'number';
  postDayInp.inputMode = 'numeric';
  postDayInp.min = '1';
  postDayInp.max = '31';
  postDayInp.required = true;
  postDayInp.className = 'tnum';
  postDayInp.value = String(existing?.postDay ?? todayDay);

  const row4 = document.createElement('div');
  row4.className = 'row-2';
  row4.appendChild(makeField('首期入帳年月', startYmInp));
  row4.appendChild(makeField('每月入帳日 (1～31)', postDayInp));
  form.appendChild(row4);

  let postFirstChk: HTMLInputElement | null = null;
  if (!existing) {
    const chkLabel = document.createElement('label');
    chkLabel.className = 'goal-asset-check-row';
    chkLabel.style.cssText =
      'padding:9px 11px;border-radius:11px;background:var(--surface-alt);border:0.5px solid var(--sep)';
    postFirstChk = document.createElement('input');
    postFirstChk.type = 'checkbox';
    postFirstChk.checked = true;
    const span = document.createElement('span');
    span.textContent = '同時立即入帳第 1 期消費至流水帳與信用卡未繳（後續期數每月自動入帳）';
    chkLabel.appendChild(postFirstChk);
    chkLabel.appendChild(span);
    form.appendChild(chkLabel);
  }

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 200;
  noteInp.placeholder = '例如：0 利率分期';
  noteInp.value = existing?.note || '';
  form.appendChild(makeField('備註（選填）', noteInp));

  const previewBox = document.createElement('div');
  previewBox.className = 'split-preview-box tnum';
  form.appendChild(previewBox);

  const updatePreview = () => {
    const tot = Number(totalInp.value || 0);
    const n = Math.floor(Number(instCountInp.value || 0));
    const curr = currSel.value || 'TWD';
    const sched = computeInstallmentScheduleAmounts(tot, n, curr);
    if (!sched.length) {
      previewBox.textContent = '輸入總金額與期數後即時試算每期入帳金額（零尾差守恆）。';
      return;
    }
    const first = sched[0];
    const reg = sched[1] ?? first;
    if (first === reg) {
      previewBox.textContent = `共 ${n} 期 · 每期 ${fmtCardNative(reg, curr, false)} · 總和 ${fmtCardNative(tot, curr, false)}`;
    } else {
      previewBox.textContent = `共 ${n} 期 · 首期 ${fmtCardNative(first, curr, false)}（含尾差）· 第 2～${n} 期每期 ${fmtCardNative(reg, curr, false)}`;
    }
  };
  totalInp.addEventListener('input', updatePreview);
  instCountInp.addEventListener('input', updatePreview);
  currSel.addEventListener('change', updatePreview);
  updatePreview();

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = existing ? '儲存分期計畫' : '建立分期付款計畫';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const selectedCard = cards.find((c) => c.id === cardSel.value);
      const ledgerId = selectedCard
        ? getEffectiveLedgerId(selectedCard)
        : existing?.ledgerId || ctx.state.activeLedgerId || DEFAULT_LEDGER_ID;
      const res = await ctx.engine.saveInstallmentPlan({
        ...(existing ? { id: existing.id } : {}),
        ledgerId,
        cardAccountId: cardSel.value || null,
        itemName: nameInp.value.trim(),
        category: catSel.value,
        totalAmount: Number(totalInp.value || 0),
        totalInstallments: Number(instCountInp.value || 0),
        postedInstallments: Number(postedInp.value || 0),
        startYm: startYmInp.value,
        postDay: Number(postDayInp.value || 1),
        currency: currSel.value || 'TWD',
        status: existing?.status,
        note: noteInp.value.trim(),
        postFirstNow: Boolean(postFirstChk?.checked),
      });
      closeModal();
      ctx.renderAll();
      showToast(
        res.firstCashflow
          ? `已建立「${res.plan.itemName}」並入帳第 1 期`
          : existing
            ? '已更新分期計畫'
            : `已建立分期計畫「${res.plan.itemName}」`,
        'success'
      );
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存分期計畫失敗', 'error');
    }
  });

  body.appendChild(form);
}

function openEarlyPayoffModal(ctx: UiContext, plan: InstallmentPlan): void {
  const snap = ctx.engine.getSnapshot();
  const prog = computeInstallmentPlanProgress(plan, snap.settings);
  const body = openModal(`提前清償分期 · ${plan.itemName}`);
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const info = document.createElement('div');
  info.className = 'split-preview-box tnum';
  info.textContent = `剩餘 ${prog.remainingInstallmentsCount} 期，將一次認列剩餘總額 ${fmtCardNative(prog.remainingAmount, plan.currency, ctx.state.masked)} 至流水帳與信用卡未繳，並將此分期標記為「已結清」。`;
  form.appendChild(info);

  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'tnum';
  dateInp.required = true;
  dateInp.value = todayInTimeZone();

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 120;
  noteInp.placeholder = '例如：電話申請提前清償';

  const f1 = document.createElement('div');
  f1.className = 'field';
  f1.style.marginBottom = '0';
  const l1 = document.createElement('label');
  l1.className = 'section-label';
  l1.textContent = '清償入帳日期';
  f1.appendChild(l1);
  f1.appendChild(dateInp);

  const f2 = document.createElement('div');
  f2.className = 'field';
  f2.style.marginBottom = '0';
  const l2 = document.createElement('label');
  l2.className = 'section-label';
  l2.textContent = '備註（選填）';
  f2.appendChild(l2);
  f2.appendChild(noteInp);

  form.appendChild(f1);
  form.appendChild(f2);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認提前清償剩餘期數';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.payOffInstallmentPlanEarly({
        id: plan.id,
        date: dateInp.value,
        note: noteInp.value.trim(),
      });
      closeModal();
      ctx.renderAll();
      showToast(`已提前清償「${plan.itemName}」`, 'success');
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提前清償失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function renderCreditCardsAndInstallmentsCard(ctx: UiContext, container: HTMLElement): void {
  const snap = ctx.engine.getSnapshot();
  const scope = ctx.state.assetsLedgerScope || 'net_worth';
  const ledgers = getActiveLedgers(ctx);
  const todayYmd = todayInTimeZone();
  const currentYm = todayYmd.slice(0, 7);

  const scopedLedgerId =
    scope === 'net_worth' || scope === 'all' ? scope : ledgers.some((l) => l.id === scope) ? scope : 'net_worth';

  const ccSummary = computeAllCreditCardsSummary(
    snap.assetItems,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    snap.installmentPlans || [],
    snap.settings,
    scopedLedgerId,
    todayYmd
  );

  const allPlans = (snap.installmentPlans || []).filter((p) => {
    if (!p || p.deletedAt) return false;
    if (scopedLedgerId !== 'all' && scopedLedgerId !== 'net_worth') {
      return (p.ledgerId || DEFAULT_LEDGER_ID) === scopedLedgerId;
    }
    return true;
  });
  const activePlans = allPlans.filter((p) => p.status === 'active');
  const cardNameMap = new Map(snap.assetItems.map((a) => [a.id, a.itemName]));

  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'card-header';
  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = '信用卡與分期付款';
  titleWrap.appendChild(title);

  if (ccSummary.cards.length > 0 || activePlans.length > 0) {
    const unpaidPill = document.createElement('span');
    unpaidPill.className = 'fx-pill tnum';
    unpaidPill.textContent = `未繳 ${fmtMoney(ccSummary.totalUnpaidTwd, ctx.state.masked)}`;
    titleWrap.appendChild(unpaidPill);
  }

  const headBtns = document.createElement('div');
  headBtns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  const addCardBtn = document.createElement('button');
  addCardBtn.type = 'button';
  addCardBtn.className = 'btn btn-tinted btn-sm';
  addCardBtn.textContent = '+ 信用卡';
  addCardBtn.addEventListener('click', () => openCreditCardModal(ctx, null, scopedLedgerId));

  const addInstBtn = document.createElement('button');
  addInstBtn.type = 'button';
  addInstBtn.className = 'btn btn-outline btn-sm';
  addInstBtn.textContent = '+ 分期';
  addInstBtn.addEventListener('click', () => openInstallmentPlanModal(ctx, null));

  headBtns.appendChild(addCardBtn);
  headBtns.appendChild(addInstBtn);
  head.appendChild(titleWrap);
  head.appendChild(headBtns);
  container.appendChild(head);

  if (!ccSummary.cards.length && !allPlans.length) {
    const empty = document.createElement('div');
    empty.className = 'goal-empty-box';
    const msg = document.createElement('div');
    msg.className = 'muted';
    msg.style.fontSize = '12.5px';
    msg.textContent =
      '建立信用卡後，記帳可選刷卡（即時算預算但不扣活存），並追蹤結帳日、已出帳／未出帳金額、繳卡費沖銷與每期分期入帳。';
    empty.appendChild(msg);
    container.appendChild(empty);
    return;
  }

  // Credit Cards List
  if (ccSummary.cards.length > 0) {
    const cardList = document.createElement('div');
    cardList.className = 'split-list';
    cardList.style.marginBottom = allPlans.length > 0 ? '14px' : '0';

    for (const cs of ccSummary.cards) {
      const card = cs.card;
      const item = document.createElement('div');
      item.className = 'split-item';

      const top = document.createElement('div');
      top.className = 'split-item-top';

      const left = document.createElement('div');
      left.className = 'item-main';
      const titleRow = document.createElement('div');
      titleRow.className = 'goal-item-title-wrap';
      const nameEl = document.createElement('span');
      nameEl.className = 'goal-item-name';
      nameEl.textContent = `💳 ${card.itemName}`;
      titleRow.appendChild(nameEl);

      const cycleBadge = document.createElement('span');
      cycleBadge.className = 'badge';
      cycleBadge.style.marginRight = '0';
      cycleBadge.textContent = `結帳 ${card.creditBillingDay ?? 15}日 · 繳款 ${card.creditDueDay ?? 1}日`;
      titleRow.appendChild(cycleBadge);

      if (card.currency !== 'TWD') {
        const cBadge = document.createElement('span');
        cBadge.className = 'badge';
        cBadge.style.marginRight = '0';
        cBadge.textContent = card.currency;
        titleRow.appendChild(cBadge);
      }
      if (cs.utilizationPct !== null) {
        const uBadge = document.createElement('span');
        uBadge.className =
          cs.utilizationPct >= 80 ? 'badge red' : cs.utilizationPct >= 50 ? 'badge amber' : 'badge green';
        uBadge.style.marginRight = '0';
        uBadge.textContent = `額度 ${fmtPct(cs.utilizationPct, 1)}`;
        titleRow.appendChild(uBadge);
      }

      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      const instTxt =
        cs.remainingInstallmentsTwd > 0
          ? ` · 未到期分期 ${fmtMoney(cs.remainingInstallmentsTwd, ctx.state.masked)}`
          : '';
      sub.textContent = `已出帳未繳 ${fmtMoney(cs.billedUnpaidTwd, ctx.state.masked)}（截止 ${cs.billingWindow.paymentDueDate}）· 未出帳 ${fmtMoney(cs.unbilledChargesTwd, ctx.state.masked)}${instTxt}`;

      left.appendChild(titleRow);
      left.appendChild(sub);

      const rightAmt = document.createElement('div');
      rightAmt.className = 'split-item-amt tnum';
      if (cs.currentBalanceTwd > 0) {
        rightAmt.style.color = ctx.state.masked ? 'var(--text)' : 'var(--neg)';
        rightAmt.textContent = '-' + fmtMoney(cs.currentBalanceTwd, ctx.state.masked);
      } else if (cs.currentBalanceTwd < 0) {
        rightAmt.style.color = ctx.state.masked ? 'var(--text)' : 'var(--pos)';
        rightAmt.textContent = '溢繳 ' + fmtMoney(Math.abs(cs.currentBalanceTwd), ctx.state.masked);
      } else {
        rightAmt.className += ' muted';
        rightAmt.textContent = fmtMoney(0, ctx.state.masked);
      }

      top.appendChild(left);
      top.appendChild(rightAmt);
      item.appendChild(top);

      const actions = document.createElement('div');
      actions.className = 'savings-acc-actions';

      const payBtn = document.createElement('button');
      payBtn.type = 'button';
      payBtn.className = 'btn btn-tinted btn-sm';
      payBtn.textContent = '💳 繳卡費';
      payBtn.addEventListener('click', () => openPayCreditCardModal(ctx, cs));

      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'btn btn-outline btn-sm';
      recBtn.textContent = '對帳校準';
      recBtn.addEventListener('click', () => openReconcileCreditCardModal(ctx, cs));

      const instBtn = document.createElement('button');
      instBtn.type = 'button';
      instBtn.className = 'btn btn-outline btn-sm';
      instBtn.textContent = '+ 分期';
      instBtn.addEventListener('click', () => openInstallmentPlanModal(ctx, null, card.id));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => openCreditCardModal(ctx, card));

      actions.appendChild(payBtn);
      actions.appendChild(recBtn);
      actions.appendChild(instBtn);
      actions.appendChild(editBtn);
      item.appendChild(actions);
      cardList.appendChild(item);
    }

    container.appendChild(cardList);
  }

  // Installment Plans Section
  if (allPlans.length > 0) {
    const instHead = document.createElement('div');
    instHead.className = 'split-part-head';
    instHead.style.marginBottom = '8px';

    const filterGroup = document.createElement('div');
    filterGroup.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    const actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'chip-btn sm' + (instFilterMode === 'active' ? ' active' : '');
    actBtn.textContent = `分期進行中 (${activePlans.length})`;
    actBtn.addEventListener('click', () => {
      instFilterMode = 'active';
      renderCreditCardsAndInstallmentsCard(ctx, container);
    });
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'chip-btn sm' + (instFilterMode === 'all' ? ' active' : '');
    allBtn.textContent = `全部 (${allPlans.length})`;
    allBtn.addEventListener('click', () => {
      instFilterMode = 'all';
      renderCreditCardsAndInstallmentsCard(ctx, container);
    });
    filterGroup.appendChild(actBtn);
    filterGroup.appendChild(allBtn);

    const postMonthBtn = document.createElement('button');
    postMonthBtn.type = 'button';
    postMonthBtn.className = 'btn btn-outline btn-sm';
    postMonthBtn.textContent = `入帳 ${currentYm} 分期`;
    postMonthBtn.addEventListener('click', async () => {
      postMonthBtn.disabled = true;
      try {
        const res = await ctx.engine.postDueInstallmentsForMonth(currentYm);
        ctx.renderAll();
        if (res.postedCount > 0) {
          showToast(`已入帳 ${res.postedCount} 筆 ${currentYm} 分期消費`, 'success');
          void ctx.engine.syncNow();
        } else {
          showToast(`${currentYm} 無待入帳的分期項目`, 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : '分期入帳失敗', 'error');
      } finally {
        postMonthBtn.disabled = false;
      }
    });

    instHead.appendChild(filterGroup);
    if (activePlans.length > 0) instHead.appendChild(postMonthBtn);
    container.appendChild(instHead);

    const visiblePlans = instFilterMode === 'active' ? activePlans : allPlans;
    if (!visiblePlans.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.style.padding = '10px 6px';
      empty.textContent = '目前沒有進行中的分期計畫';
      container.appendChild(empty);
      return;
    }

    const pList = document.createElement('div');
    pList.className = 'split-list';

    for (const plan of visiblePlans) {
      const prog = computeInstallmentPlanProgress(plan, snap.settings);
      const stMeta = INST_STATUS_META[plan.status] || INST_STATUS_META.active;
      const pct = Math.min(100, Math.round((plan.postedInstallments / Math.max(1, plan.totalInstallments)) * 100));

      const row = document.createElement('div');
      row.className = 'goal-item';

      const top = document.createElement('div');
      top.className = 'goal-item-head';
      const titleRow = document.createElement('div');
      titleRow.className = 'goal-item-title-wrap';
      const nameEl = document.createElement('span');
      nameEl.className = 'goal-item-name';
      nameEl.textContent = plan.itemName;
      const stBadge = document.createElement('span');
      stBadge.className = stMeta.cls;
      stBadge.style.marginRight = '0';
      stBadge.textContent = stMeta.label;
      titleRow.appendChild(nameEl);
      titleRow.appendChild(stBadge);
      if (plan.cardAccountId && cardNameMap.has(plan.cardAccountId)) {
        const cBadge = document.createElement('span');
        cBadge.className = 'badge';
        cBadge.style.marginRight = '0';
        cBadge.textContent = `💳 ${cardNameMap.get(plan.cardAccountId)}`;
        titleRow.appendChild(cBadge);
      }

      const seqEl = document.createElement('span');
      seqEl.className = 'tnum muted';
      seqEl.style.fontSize = '12px';
      seqEl.textContent = `${plan.postedInstallments}/${plan.totalInstallments} 期`;

      top.appendChild(titleRow);
      top.appendChild(seqEl);
      row.appendChild(top);

      const track = document.createElement('div');
      track.className = 'goal-progress-track';
      const fill = document.createElement('div');
      fill.className = 'goal-progress-fill' + (plan.status === 'completed' ? ' achieved' : '');
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      row.appendChild(track);

      const meta = document.createElement('div');
      meta.className = 'goal-meta-row tnum';
      meta.textContent =
        plan.status === 'active'
          ? `每期 ${fmtCardNative(prog.regularInstallmentAmount, plan.currency, ctx.state.masked)} · 剩餘 ${prog.remainingInstallmentsCount} 期（尚欠 ${fmtMoney(prog.remainingTwd, ctx.state.masked)}）· ${plan.startYm}～${prog.endYm}`
          : `總額 ${fmtCardNative(plan.totalAmount, plan.currency, ctx.state.masked)} · ${plan.startYm}～${prog.endYm}`;
      row.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'savings-acc-actions';
      if (plan.status === 'active') {
        const payoffBtn = document.createElement('button');
        payoffBtn.type = 'button';
        payoffBtn.className = 'btn btn-tinted btn-sm';
        payoffBtn.textContent = '提前清償';
        payoffBtn.addEventListener('click', () => openEarlyPayoffModal(ctx, plan));
        actions.appendChild(payoffBtn);
      }
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => openInstallmentPlanModal(ctx, plan));
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-outline btn-sm';
      delBtn.textContent = '刪除';
      delBtn.addEventListener('click', async () => {
        delBtn.disabled = true;
        try {
          await ctx.engine.deleteInstallmentPlan(plan.id);
          ctx.renderAll();
          showToast(`已刪除分期計畫「${plan.itemName}」`, 'success');
          void ctx.engine.syncNow();
        } catch (err) {
          showToast(err instanceof Error ? err.message : '刪除失敗', 'error');
        } finally {
          delBtn.disabled = false;
        }
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      pList.appendChild(row);
    }

    container.appendChild(pList);
  }
}
