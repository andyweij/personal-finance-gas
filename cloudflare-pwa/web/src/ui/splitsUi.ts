import { getEffectiveLedgerId } from '../../../shared/calculations';
import { CASHFLOW_TYPES, DEFAULT_LEDGER_ID } from '../../../shared/constants';
import { getCurrencyDecimals, resolveFxRate } from '../../../shared/currency';
import { todayInTimeZone } from '../../../shared/dates';
import { roundTo } from '../../../shared/format';
import {
  computeEqualSplitShares,
  computeSettlementPreview,
  computeSplitReceivablesSummary,
} from '../../../shared/splits';
import type { SplitReceivable, SplitReceivableStatus } from '../../../shared/types';
import {
  getEffectiveCategoriesForType,
  normalizeEnabledCurrencies,
} from '../../../shared/validation';
import {
  bindSubmit,
  closeModal,
  fmtMoney,
  fmtRaw,
  openModal,
  showToast,
} from './helpers';
import { getActiveLedgers } from './ledgerUi';
import type { UiContext } from './state';

let splitsFilterMode: 'open' | 'all' = 'open';
let splitsCounterpartyFilter: string | null = null;

const STATUS_META: Record<SplitReceivableStatus, { label: string; cls: string }> = {
  open: { label: '未收回', cls: 'badge red' },
  partial: { label: '部分收回', cls: 'badge amber' },
  settled: { label: '已結清', cls: 'badge green' },
  written_off: { label: '已免還', cls: 'badge' },
};

function fmtNativeAmount(amount: number, currency: string, masked: boolean): string {
  if (masked) return '•••••';
  if (currency === 'TWD') return fmtMoney(amount, false);
  return fmtRaw(amount, currency, false);
}

export function openCreateSplitModal(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const enabledCurrs = normalizeEnabledCurrencies(snap.settings.enabledCurrencies);
  const initialCurrency = enabledCurrs.includes(ctx.state.logCurrency)
    ? ctx.state.logCurrency
    : 'TWD';
  const defaultDate =
    (document.getElementById('dateInput') as HTMLInputElement | null)?.value || todayInTimeZone();
  const defaultItemName =
    (document.getElementById('itemNameInput') as HTMLInputElement | null)?.value.trim() || '';
  const defaultTotalStr =
    (document.getElementById('amountInput') as HTMLInputElement | null)?.value.trim() || '';

  const categories = getEffectiveCategoriesForType(
    CASHFLOW_TYPES.DAILY_EXPENSE,
    snap.settings.customCategories
  );
  const initialCategory = categories.includes(ctx.state.logCategory)
    ? ctx.state.logCategory
    : categories[0] || '餐飲';

  const ledgers = getActiveLedgers(ctx);
  const activeLedgerId =
    ledgers.find((l) => l.id === ctx.state.activeLedgerId)?.id || DEFAULT_LEDGER_ID;

  const savingsAccounts = snap.assetItems.filter((a) => !a.deletedAt && a.isLinkedSavings);
  const defaultSourceAccId =
    (ctx.state.logLinkedAccountId &&
      savingsAccounts.some((a) => a.id === ctx.state.logLinkedAccountId) &&
      ctx.state.logLinkedAccountId) ||
    savingsAccounts.find(
      (a) => getEffectiveLedgerId(a) === activeLedgerId && a.isDefaultSavings
    )?.id ||
    savingsAccounts.find((a) => getEffectiveLedgerId(a) === activeLedgerId)?.id ||
    '';

  // Known counterparties for 1-tap quick fill
  const recentCounterparties = Array.from(
    new Set(
      (snap.splitReceivables || [])
        .filter((r) => !r.deletedAt && r.counterparty)
        .map((r) => r.counterparty)
    )
  ).slice(0, 8);

  const body = openModal('新增代墊 / 拆帳支出');
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

  // Row 1: Date & Item Name
  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'tnum';
  dateInp.required = true;
  dateInp.value = defaultDate;

  const itemInp = document.createElement('input');
  itemInp.type = 'text';
  itemInp.maxLength = 80;
  itemInp.required = true;
  itemInp.placeholder = '例如：聚餐、日本飯店、高鐵票';
  itemInp.value = defaultItemName;

  const row1 = document.createElement('div');
  row1.className = 'row-2';
  row1.appendChild(makeField('日期', dateInp));
  row1.appendChild(makeField('項目名稱', itemInp));
  form.appendChild(row1);

  // Row 2: Category & Currency
  const catSel = document.createElement('select');
  for (const c of categories) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === initialCategory) o.selected = true;
    catSel.appendChild(o);
  }

  const currSel = document.createElement('select');
  for (const c of enabledCurrs) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === initialCurrency) o.selected = true;
    currSel.appendChild(o);
  }

  const row2 = document.createElement('div');
  row2.className = 'row-2';
  row2.appendChild(makeField('消費分類', catSel));
  row2.appendChild(makeField('幣別', currSel));
  form.appendChild(row2);

  // Row 3: Total Paid & My Share + 1-click AA button
  const totalInp = document.createElement('input');
  totalInp.type = 'number';
  totalInp.inputMode = 'decimal';
  totalInp.step = 'any';
  totalInp.min = '0';
  totalInp.className = 'tnum';
  totalInp.placeholder = '例如：3000';
  totalInp.value = defaultTotalStr;

  const myShareInp = document.createElement('input');
  myShareInp.type = 'number';
  myShareInp.inputMode = 'decimal';
  myShareInp.step = 'any';
  myShareInp.min = '0';
  myShareInp.className = 'tnum';
  myShareInp.placeholder = '0（純代墊可填 0）';
  myShareInp.value = '0';

  const row3 = document.createElement('div');
  row3.className = 'row-2';
  row3.appendChild(makeField('總代付金額（選填試算）', totalInp));
  row3.appendChild(makeField('我的個人分攤', myShareInp));
  form.appendChild(row3);

  // Participants section
  interface ParticipantRow {
    wrap: HTMLDivElement;
    nameInp: HTMLInputElement;
    amtInp: HTMLInputElement;
  }
  const participantRows: ParticipantRow[] = [];

  const partSection = document.createElement('div');
  partSection.className = 'split-part-section';

  const partHead = document.createElement('div');
  partHead.className = 'split-part-head';
  const partLabel = document.createElement('label');
  partLabel.className = 'section-label';
  partLabel.style.marginBottom = '0';
  partLabel.textContent = '代墊對象與金額';
  const partTools = document.createElement('div');
  partTools.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

  const equalBtn = document.createElement('button');
  equalBtn.type = 'button';
  equalBtn.className = 'btn btn-tinted btn-sm';
  equalBtn.textContent = '均分 AA';

  const addPartBtn = document.createElement('button');
  addPartBtn.type = 'button';
  addPartBtn.className = 'btn btn-outline btn-sm';
  addPartBtn.textContent = '+ 加一位';

  partTools.appendChild(equalBtn);
  partTools.appendChild(addPartBtn);
  partHead.appendChild(partLabel);
  partHead.appendChild(partTools);
  partSection.appendChild(partHead);

  if (recentCounterparties.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'quick-row';
    chips.style.marginBottom = '6px';
    for (const cp of recentCounterparties) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn sm';
      chip.textContent = `+ ${cp}`;
      chip.addEventListener('click', () => {
        const emptyRow = participantRows.find((r) => !r.nameInp.value.trim());
        if (emptyRow) {
          emptyRow.nameInp.value = cp;
        } else {
          addParticipantRow(cp, '');
        }
        updatePreview();
      });
      chips.appendChild(chip);
    }
    partSection.appendChild(chips);
  }

  const partList = document.createElement('div');
  partList.className = 'split-part-list';
  partSection.appendChild(partList);
  form.appendChild(partSection);

  // Payment source account & ledger
  const accSel = document.createElement('select');
  const noAccOpt = document.createElement('option');
  noAccOpt.value = '';
  noAccOpt.textContent = '不連動活存帳戶（現金 / 信用卡）';
  accSel.appendChild(noAccOpt);
  for (const a of savingsAccounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${a.itemName} (${a.currency})`;
    if (a.id === defaultSourceAccId) o.selected = true;
    accSel.appendChild(o);
  }
  form.appendChild(
    makeField(
      '付款活存帳戶',
      accSel,
      '選擇活存後：我的消費與代墊款都會即時自活存扣減，但預算與儲蓄率僅計入「我的個人分攤」。'
    )
  );

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 200;
  noteInp.placeholder = '例如：中信卡代刷、Line Pay 轉帳';
  form.appendChild(makeField('備註（選填）', noteInp));

  // Live conservation preview
  const previewBox = document.createElement('div');
  previewBox.className = 'split-preview-box tnum';
  form.appendChild(previewBox);

  const updatePreview = () => {
    const curr = currSel.value || 'TWD';
    const dec = getCurrencyDecimals(curr);
    const myAmt = Math.max(0, roundTo(Number(myShareInp.value || 0), dec));
    const advAmt = roundTo(
      participantRows.reduce((s, r) => s + Math.max(0, Number(r.amtInp.value || 0)), 0),
      dec
    );
    const sumAmt = roundTo(myAmt + advAmt, dec);
    const totalInput = roundTo(Number(totalInp.value || 0), dec);
    const hasAcc = Boolean(accSel.value);
    const rate = resolveFxRate(curr, snap.settings);
    const sumTwd = roundTo(sumAmt * rate, 0);

    previewBox.innerHTML = '';
    const line1 = document.createElement('div');
    line1.textContent = `你的消費 ${fmtNativeAmount(myAmt, curr, false)} · 新增代墊應收 ${fmtNativeAmount(advAmt, curr, false)} · 合計 ${fmtNativeAmount(sumAmt, curr, false)}${curr !== 'TWD' ? ` (約 ${fmtMoney(sumTwd, false)})` : ''}`;
    previewBox.appendChild(line1);

    const line2 = document.createElement('div');
    line2.className = 'muted';
    line2.style.marginTop = '3px';
    line2.textContent = hasAcc
      ? `活存將立即扣減全額 ${fmtNativeAmount(sumAmt, curr, false)}（消費 ${fmtNativeAmount(myAmt, curr, false)} + 代墊出帳 ${fmtNativeAmount(advAmt, curr, false)}）`
      : '未綁定活存：僅記錄消費與代墊應收，不異動活存餘額';
    previewBox.appendChild(line2);

    if (totalInput > 0 && Math.abs(totalInput - sumAmt) > Math.pow(10, -dec) * 0.5) {
      const warn = document.createElement('div');
      warn.className = 'goal-warn-note';
      warn.style.marginTop = '4px';
      const diff = roundTo(totalInput - sumAmt, dec);
      warn.textContent = `提示：總代付 ${fmtNativeAmount(totalInput, curr, false)} 與目前加總相差 ${diff > 0 ? '+' : ''}${diff} ${curr}（可點「均分 AA」自動分配）`;
      previewBox.appendChild(warn);
    }
  };

  const addParticipantRow = (name = '', amount = '') => {
    const wrap = document.createElement('div');
    wrap.className = 'split-part-row';

    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.maxLength = 40;
    nameInp.placeholder = '對象名稱（如 小明）';
    nameInp.value = name;

    const amtInp = document.createElement('input');
    amtInp.type = 'number';
    amtInp.inputMode = 'decimal';
    amtInp.step = 'any';
    amtInp.min = '0.01';
    amtInp.className = 'tnum';
    amtInp.placeholder = '代墊金額';
    amtInp.value = amount;

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'icon-btn sm';
    rmBtn.title = '移除此對象';
    rmBtn.setAttribute('aria-label', '移除此對象');
    rmBtn.textContent = '✕';

    const rowObj: ParticipantRow = { wrap, nameInp, amtInp };
    participantRows.push(rowObj);

    rmBtn.addEventListener('click', () => {
      if (participantRows.length <= 1) {
        nameInp.value = '';
        amtInp.value = '';
      } else {
        const idx = participantRows.indexOf(rowObj);
        if (idx >= 0) participantRows.splice(idx, 1);
        wrap.remove();
      }
      updatePreview();
    });

    nameInp.addEventListener('input', updatePreview);
    amtInp.addEventListener('input', updatePreview);

    wrap.appendChild(nameInp);
    wrap.appendChild(amtInp);
    wrap.appendChild(rmBtn);
    partList.appendChild(wrap);
  };

  addParticipantRow('', '');

  addPartBtn.addEventListener('click', () => {
    addParticipantRow('', '');
    updatePreview();
  });

  equalBtn.addEventListener('click', () => {
    const total = Number(totalInp.value || 0);
    if (!Number.isFinite(total) || total <= 0) {
      showToast('請先輸入「總代付金額」再點均分 AA', 'error');
      totalInp.focus();
      return;
    }
    const curr = currSel.value || 'TWD';
    const headcount = 1 + participantRows.length;
    const shares = computeEqualSplitShares(total, headcount, curr);
    if (!shares.length) return;
    myShareInp.value = String(shares[0]);
    participantRows.forEach((r, idx) => {
      r.amtInp.value = String(shares[idx + 1] ?? 0);
    });
    updatePreview();
  });

  totalInp.addEventListener('input', updatePreview);
  myShareInp.addEventListener('input', updatePreview);
  currSel.addEventListener('change', updatePreview);
  accSel.addEventListener('change', updatePreview);
  updatePreview();

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認寫入拆帳與代墊';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const participants = participantRows.map((r) => ({
        counterparty: r.nameInp.value.trim(),
        amount: Number(r.amtInp.value || 0),
      }));
      const res = await ctx.engine.createSplitExpense({
        date: dateInp.value,
        itemName: itemInp.value.trim(),
        category: catSel.value,
        currency: currSel.value,
        myShareAmount: Number(myShareInp.value || 0),
        participants,
        sourceAccountId: accSel.value || null,
        ledgerId: activeLedgerId,
        note: noteInp.value.trim(),
      });
      closeModal();
      ctx.renderAll();
      showToast(
        `已建立 ${res.receivables.length} 筆代墊紀錄${res.cashflow ? '並寫入個人消費' : ''}`,
        'success'
      );
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '建立拆帳失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function openSettleSplitModal(ctx: UiContext, rec: SplitReceivable): void {
  const snap = ctx.engine.getSnapshot();
  const curr = rec.currency || 'TWD';
  const dec = getCurrencyDecimals(curr);
  const remaining = Math.max(0, roundTo(rec.amount - rec.settledAmount, dec));

  const body = openModal(`收回代墊 · ${rec.counterparty}`);
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const infoBox = document.createElement('div');
  infoBox.className = 'split-preview-box tnum';
  infoBox.textContent = `${rec.date} · ${rec.itemName} · 原始 ${fmtNativeAmount(rec.amount, curr, ctx.state.masked)} · 尚欠 ${fmtNativeAmount(remaining, curr, ctx.state.masked)}`;
  form.appendChild(infoBox);

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

  const amtInp = document.createElement('input');
  amtInp.type = 'number';
  amtInp.inputMode = 'decimal';
  amtInp.step = 'any';
  amtInp.min = '0.01';
  amtInp.required = true;
  amtInp.className = 'tnum';
  amtInp.value = String(remaining);

  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'tnum';
  dateInp.required = true;
  dateInp.value = todayInTimeZone();

  const row1 = document.createElement('div');
  row1.className = 'row-2';
  row1.appendChild(makeField(`本次收回金額 (${curr})`, amtInp));
  row1.appendChild(makeField('收款日期', dateInp));
  form.appendChild(row1);

  const savingsAccounts = snap.assetItems.filter((a) => !a.deletedAt && a.isLinkedSavings);
  const accSel = document.createElement('select');
  const noAccOpt = document.createElement('option');
  noAccOpt.value = '';
  noAccOpt.textContent = '不入帳活存（現金收回 / 僅標記結清）';
  accSel.appendChild(noAccOpt);
  for (const a of savingsAccounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${a.itemName} (${a.currency})`;
    if (a.id === rec.sourceAccountId) o.selected = true;
    accSel.appendChild(o);
  }
  form.appendChild(
    makeField(
      '收回入帳活存帳戶',
      accSel,
      '收回款項會以正數存轉入帳活存，不會重複計入「其他收入」，避免扭曲儲蓄率。'
    )
  );

  // Cross-currency actual deposit section (shown only when deposit currency !== rec.currency)
  const fxWrap = document.createElement('div');
  fxWrap.className = 'goal-conditional-box';
  fxWrap.style.display = 'none';
  const customDepInp = document.createElement('input');
  customDepInp.type = 'number';
  customDepInp.inputMode = 'decimal';
  customDepInp.step = 'any';
  customDepInp.min = '0.01';
  customDepInp.className = 'tnum';
  const fxHint = document.createElement('div');
  fxHint.className = 'muted tnum';
  fxHint.style.cssText = 'font-size:11.5px;margin-top:5px';
  const fxField = makeField('跨幣別實際入帳金額', customDepInp);
  fxWrap.appendChild(fxField);
  fxWrap.appendChild(fxHint);
  form.appendChild(fxWrap);

  let lastDepCurr = '';
  const updateFxSection = (resetCustom = false) => {
    const acc = savingsAccounts.find((a) => a.id === accSel.value);
    const depCurr = acc?.currency || curr;
    if (!acc || depCurr === curr) {
      fxWrap.style.display = 'none';
      customDepInp.value = '';
      lastDepCurr = depCurr;
      return;
    }
    fxWrap.style.display = '';
    const settleVal = Math.max(0, Number(amtInp.value || 0));
    const lbl = fxField.querySelector('label');
    if (lbl) lbl.textContent = `跨幣別實際入帳金額 (${depCurr})`;
    if (resetCustom || lastDepCurr !== depCurr) {
      const est = computeSettlementPreview({
        receivable: rec,
        settleAmountNative: settleVal,
        depositCurrency: depCurr,
        fxSource: snap.settings,
      });
      customDepInp.value = est.estimatedDepositAmount > 0 ? String(est.estimatedDepositAmount) : '';
      lastDepCurr = depCurr;
    }
    const customNum = Number(customDepInp.value || 0);
    const prev = computeSettlementPreview({
      receivable: rec,
      settleAmountNative: settleVal,
      depositCurrency: depCurr,
      fxSource: snap.settings,
      customDepositAmount: customNum > 0 ? customNum : null,
    });
    const diffSign = prev.fxDiffTwd > 0 ? '+' : '';
    fxHint.textContent = `原代墊約 ${fmtMoney(prev.originalPortionTwd, ctx.state.masked)} · 預估入帳 ${fmtNativeAmount(prev.estimatedDepositAmount, depCurr, ctx.state.masked)} · 匯差 ${ctx.state.masked ? '•••••' : `${diffSign}NT$ ${prev.fxDiffTwd.toLocaleString('zh-TW')}`}`;
  };

  accSel.addEventListener('change', () => updateFxSection(true));
  amtInp.addEventListener('input', () => updateFxSection(true));
  customDepInp.addEventListener('input', () => updateFxSection(false));
  updateFxSection(true);

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 120;
  noteInp.placeholder = '例如：Line Pay 轉回、現金收回';
  form.appendChild(makeField('收款備註（選填）', noteInp));

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認收回入帳';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      const acc = savingsAccounts.find((a) => a.id === accSel.value);
      const isCross = Boolean(acc && acc.currency !== curr);
      const customDep = isCross && Number(customDepInp.value) > 0 ? Number(customDepInp.value) : null;
      const res = await ctx.engine.settleSplitReceivable({
        id: rec.id,
        settleAmount: Number(amtInp.value || 0),
        date: dateInp.value,
        depositAccountId: accSel.value || null,
        customDepositAmount: customDep,
        note: noteInp.value.trim(),
      });
      closeModal();
      ctx.renderAll();
      showToast(
        res.receivable.status === 'settled'
          ? `已結清「${rec.counterparty}」代墊款`
          : `已記錄部分收回「${rec.counterparty}」`,
        'success'
      );
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '收回入帳失敗', 'error');
    }
  });

  body.appendChild(form);
}

function openWriteOffSplitModal(ctx: UiContext, rec: SplitReceivable): void {
  const snap = ctx.engine.getSnapshot();
  const curr = rec.currency || 'TWD';
  const dec = getCurrencyDecimals(curr);
  const remaining = Math.max(0, roundTo(rec.amount - rec.settledAmount, dec));

  const body = openModal(`免還轉列支出 · ${rec.counterparty}`);
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const infoBox = document.createElement('div');
  infoBox.className = 'split-preview-box tnum';
  infoBox.textContent = `將尚未收回的 ${fmtNativeAmount(remaining, curr, ctx.state.masked)}（${rec.itemName}）轉列為個人「日常花費」。現金於原本代墊付款時已扣款，本次轉列支出「不會」重複扣減活存餘額。`;
  form.appendChild(infoBox);

  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'tnum';
  dateInp.required = true;
  dateInp.value = todayInTimeZone();

  const categories = getEffectiveCategoriesForType(
    CASHFLOW_TYPES.DAILY_EXPENSE,
    snap.settings.customCategories
  );
  const catSel = document.createElement('select');
  const catOptions = categories.includes(rec.category)
    ? categories
    : [rec.category, ...categories];
  for (const c of catOptions) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === rec.category) o.selected = true;
    catSel.appendChild(o);
  }

  const row = document.createElement('div');
  row.className = 'row-2';
  const f1 = document.createElement('div');
  f1.className = 'field';
  f1.style.marginBottom = '0';
  const l1 = document.createElement('label');
  l1.className = 'section-label';
  l1.textContent = '轉列支出日期';
  f1.appendChild(l1);
  f1.appendChild(dateInp);

  const f2 = document.createElement('div');
  f2.className = 'field';
  f2.style.marginBottom = '0';
  const l2 = document.createElement('label');
  l2.className = 'section-label';
  l2.textContent = '支出分類';
  f2.appendChild(l2);
  f2.appendChild(catSel);

  row.appendChild(f1);
  row.appendChild(f2);
  form.appendChild(row);

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 120;
  noteInp.placeholder = '例如：請客免還、零頭免收';
  const f3 = document.createElement('div');
  f3.className = 'field';
  f3.style.marginBottom = '0';
  const l3 = document.createElement('label');
  l3.className = 'section-label';
  l3.textContent = '備註（選填）';
  f3.appendChild(l3);
  f3.appendChild(noteInp);
  form.appendChild(f3);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '確認免還並轉列個人支出';
  form.appendChild(submitBtn);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    try {
      await ctx.engine.writeOffSplitReceivable({
        id: rec.id,
        date: dateInp.value,
        category: catSel.value,
        note: noteInp.value.trim(),
      });
      closeModal();
      ctx.renderAll();
      showToast(`已將「${rec.counterparty}」剩餘代墊轉列個人支出`, 'success');
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '免還處理失敗', 'error');
    }
  });

  body.appendChild(form);
}

function openDeleteSplitModal(ctx: UiContext, rec: SplitReceivable): void {
  const snap = ctx.engine.getSnapshot();
  const groupItems = (snap.splitReceivables || []).filter(
    (s) => !s.deletedAt && s.splitGroupId === rec.splitGroupId
  );
  const canUndoWholeGroup =
    groupItems.every((s) => s.settledAmount === 0 && s.status === 'open') &&
    (groupItems.length > 1 || Boolean(rec.sourceCashflowId) || Boolean(rec.sourceAdjustmentId));

  const body = openModal(`刪除代墊紀錄 · ${rec.counterparty}`);
  const wrap = document.createElement('div');
  wrap.className = 'reb-modal-form';

  const desc = document.createElement('div');
  desc.className = 'split-preview-box';
  desc.textContent = `項目：${rec.date} · ${rec.itemName}（${fmtNativeAmount(rec.amount, rec.currency || 'TWD', ctx.state.masked)}）`;
  wrap.appendChild(desc);

  const singleBtn = document.createElement('button');
  singleBtn.type = 'button';
  singleBtn.className = 'btn btn-outline';
  singleBtn.textContent = '僅刪除此筆代墊紀錄（保留原消費與活存變動）';
  singleBtn.addEventListener('click', async () => {
    singleBtn.disabled = true;
    try {
      await ctx.engine.deleteSplitReceivable(rec.id, { undoWholeGroup: false });
      closeModal();
      ctx.renderAll();
      showToast('已刪除此筆代墊紀錄', 'success');
      void ctx.engine.syncNow();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '刪除失敗', 'error');
    } finally {
      singleBtn.disabled = false;
    }
  });
  wrap.appendChild(singleBtn);

  if (canUndoWholeGroup) {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'btn btn-danger';
    undoBtn.textContent = `整筆拆帳連動還原（移除 ${groupItems.length} 筆代墊 + 原消費與活存扣款）`;
    undoBtn.addEventListener('click', async () => {
      undoBtn.disabled = true;
      try {
        await ctx.engine.deleteSplitReceivable(rec.id, { undoWholeGroup: true });
        closeModal();
        ctx.renderAll();
        showToast('已整筆還原此拆帳與活存扣款', 'success');
        void ctx.engine.syncNow();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '整筆還原失敗', 'error');
      } finally {
        undoBtn.disabled = false;
      }
    });
    wrap.appendChild(undoBtn);
  }

  body.appendChild(wrap);
}

export function renderSplitReceivablesCard(ctx: UiContext, container: HTMLElement): void {
  const snap = ctx.engine.getSnapshot();
  const scope = ctx.state.assetsLedgerScope || 'net_worth';
  const summary = computeSplitReceivablesSummary(
    snap.splitReceivables || [],
    snap.settings,
    scope
  );

  // Clear counterparty filter if no longer present
  if (
    splitsCounterpartyFilter &&
    !summary.byCounterparty.some((c) => c.counterparty === splitsCounterpartyFilter)
  ) {
    splitsCounterpartyFilter = null;
  }

  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'card-header';
  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = '代墊款與拆帳應收';
  titleWrap.appendChild(title);

  const totalPill = document.createElement('span');
  totalPill.className = 'fx-pill tint tnum';
  totalPill.textContent = `待收回 ${fmtMoney(summary.totalOutstandingTwd, ctx.state.masked)}`;
  titleWrap.appendChild(totalPill);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-tinted btn-sm';
  addBtn.textContent = '+ 記拆帳';
  addBtn.addEventListener('click', () => openCreateSplitModal(ctx));

  head.appendChild(titleWrap);
  head.appendChild(addBtn);
  container.appendChild(head);

  if (summary.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'goal-empty-box';
    const msg = document.createElement('div');
    msg.className = 'muted';
    msg.style.fontSize = '12.5px';
    msg.textContent = '尚未有代墊或拆帳紀錄。點「+ 記拆帳」可將聚餐或代購拆帳，活存即時扣款而不扭曲本月預算與儲蓄率。';
    empty.appendChild(msg);
    container.appendChild(empty);
    return;
  }

  // Counterparty summary chips (outstanding only)
  if (summary.byCounterparty.length > 0) {
    const cpBar = document.createElement('div');
    cpBar.className = 'quick-row';
    cpBar.style.marginBottom = '8px';
    for (const cp of summary.byCounterparty) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className =
        'chip-btn sm tnum' + (splitsCounterpartyFilter === cp.counterparty ? ' active' : '');
      chip.textContent = `${cp.counterparty} ${fmtMoney(cp.outstandingTwd, ctx.state.masked)}`;
      chip.addEventListener('click', () => {
        splitsCounterpartyFilter =
          splitsCounterpartyFilter === cp.counterparty ? null : cp.counterparty;
        renderSplitReceivablesCard(ctx, container);
      });
      cpBar.appendChild(chip);
    }
    container.appendChild(cpBar);
  }

  // Open vs All filter toggle
  const openTotalCount = summary.openCount + summary.partialCount;
  const filterBar = document.createElement('div');
  filterBar.className = 'split-filter-row';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'chip-btn sm' + (splitsFilterMode === 'open' ? ' active' : '');
  openBtn.textContent = `未結清 (${openTotalCount})`;
  openBtn.addEventListener('click', () => {
    splitsFilterMode = 'open';
    renderSplitReceivablesCard(ctx, container);
  });

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'chip-btn sm' + (splitsFilterMode === 'all' ? ' active' : '');
  allBtn.textContent = `全部 (${summary.items.length})`;
  allBtn.addEventListener('click', () => {
    splitsFilterMode = 'all';
    renderSplitReceivablesCard(ctx, container);
  });

  filterBar.appendChild(openBtn);
  filterBar.appendChild(allBtn);
  container.appendChild(filterBar);

  const visibleItems = summary.items.filter((info) => {
    if (splitsFilterMode === 'open' && !info.isOutstanding) return false;
    if (splitsCounterpartyFilter && info.receivable.counterparty !== splitsCounterpartyFilter) {
      return false;
    }
    return true;
  });

  if (visibleItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.style.padding = '12px 6px';
    empty.textContent =
      splitsFilterMode === 'open' ? '目前所有代墊款皆已結清！' : '查無符合條件的代墊紀錄';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'split-list';

  for (const info of visibleItems) {
    const rec = info.receivable;
    const curr = rec.currency || 'TWD';
    const meta = STATUS_META[rec.status] || STATUS_META.open;

    const item = document.createElement('div');
    item.className = 'split-item';

    const top = document.createElement('div');
    top.className = 'split-item-top';

    const left = document.createElement('div');
    left.className = 'item-main';

    const titleRow = document.createElement('div');
    titleRow.className = 'goal-item-title-wrap';
    const cpBadge = document.createElement('span');
    cpBadge.className = 'badge';
    cpBadge.style.marginRight = '0';
    cpBadge.textContent = rec.counterparty;
    const nameEl = document.createElement('span');
    nameEl.className = 'goal-item-name';
    nameEl.textContent = rec.itemName;
    const stBadge = document.createElement('span');
    stBadge.className = meta.cls;
    stBadge.style.marginRight = '0';
    stBadge.textContent = meta.label;
    titleRow.appendChild(cpBadge);
    titleRow.appendChild(nameEl);
    titleRow.appendChild(stBadge);

    const subRow = document.createElement('div');
    subRow.className = 'item-sub tnum';
    const settledPart =
      rec.settledAmount > 0
        ? ` · 已收回 ${fmtNativeAmount(rec.settledAmount, curr, ctx.state.masked)}`
        : '';
    subRow.textContent = `${rec.date} · ${rec.category} · 原始 ${fmtNativeAmount(rec.amount, curr, ctx.state.masked)}${settledPart}${rec.note ? ` · ${rec.note}` : ''}`;

    left.appendChild(titleRow);
    left.appendChild(subRow);

    const rightAmt = document.createElement('div');
    rightAmt.className = 'split-item-amt tnum';
    if (info.isOutstanding) {
      rightAmt.style.color = ctx.state.masked ? 'var(--text)' : 'var(--primary)';
      rightAmt.textContent =
        curr === 'TWD'
          ? fmtMoney(info.remainingTwd, ctx.state.masked)
          : `${fmtNativeAmount(info.remainingNative, curr, ctx.state.masked)} (${fmtMoney(info.remainingTwd, ctx.state.masked)})`;
    } else {
      rightAmt.className += ' muted';
      rightAmt.textContent = rec.status === 'settled' ? '已結清' : '已免還';
    }

    top.appendChild(left);
    top.appendChild(rightAmt);
    item.appendChild(top);

    const actions = document.createElement('div');
    actions.className = 'savings-acc-actions';
    if (info.isOutstanding) {
      const settleBtn = document.createElement('button');
      settleBtn.type = 'button';
      settleBtn.className = 'btn btn-tinted btn-sm';
      settleBtn.textContent = '收回入帳';
      settleBtn.addEventListener('click', () => openSettleSplitModal(ctx, rec));
      actions.appendChild(settleBtn);

      const woBtn = document.createElement('button');
      woBtn.type = 'button';
      woBtn.className = 'btn btn-outline btn-sm';
      woBtn.textContent = '免還轉支出';
      woBtn.addEventListener('click', () => openWriteOffSplitModal(ctx, rec));
      actions.appendChild(woBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-outline btn-sm';
    delBtn.textContent = '刪除';
    delBtn.addEventListener('click', () => openDeleteSplitModal(ctx, rec));
    actions.appendChild(delBtn);

    item.appendChild(actions);
    list.appendChild(item);
  }

  container.appendChild(list);
}
