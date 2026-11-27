import { normalizeRecurringPostDay } from '../../../shared/recurring';
import {
  BILLING_CYCLES,
  CASHFLOW_TYPES,
  DEFAULT_LEDGER_ID,
  RECURRING_CASHFLOW_TYPES,
  SINKING_FUND_CATEGORIES,
  SINKING_FUND_KIND_LABELS,
} from '../../../shared/constants';
import { todayInTimeZone } from '../../../shared/dates';
import {
  compareBySortOrder,
  computeRecurringMonthlyTwd,
  computeSinkingMonthlyReserve,
  computeSinkingReserveForMonth,
  computeSinkingYtdSpent,
  getSinkingSchedule,
  getEffectiveLedgerId,
} from '../../../shared/calculations';
import type { RecurringItem, SinkingFundItem } from '../../../shared/types';
import { normalizeEnabledCurrencies } from '../../../shared/validation';
import {
  closeModal,
  el,
  fmtMoney,
  fmtNum,
  fmtRaw,
  makeInputField,
  makeSelectField,
  openModal,
  showToast, bindSubmit } from './helpers';
import { buildLedgerSelectField, getActiveLedgers, renderLedgerSwitcherBar } from './ledgerUi';
import { renderReorderList } from './reorderHelper';
import type { UiContext } from './state';

const SINKING_END_AUTO = '期滿自動結束';
const SINKING_END_REPEAT = '每年重複';

function addMonthsToYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  return `${ny}-${String(idx - ny * 12 + 1).padStart(2, '0')}`;
}

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
  const rate = snap.settings;
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
      // v1.13.1: show the posting day when it is not the default 1st
      const postDay = normalizeRecurringPostDay(item.postDay);
      const postDayText = postDay !== 1 ? ` · ${postDay} 日入帳` : '';
      const monthlyTwd = computeRecurringMonthlyTwd(item, rate);
      const linkedName = item.linkedAccountId ? savingsMap.get(item.linkedAccountId) : null;
      sub.appendChild(
        document.createTextNode(
          `${item.cycle}${specText}${postDayText} · ${fmtRaw(item.amount, item.currency, ctx.state.masked)} · 月均 ${fmtMoney(monthlyTwd, ctx.state.masked)}${linkedName ? ` · 活存:${linkedName}` : ''}`
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

      row.appendChild(main);
      if (!ctx.engine.isLedgerReadOnly(getEffectiveLedgerId(item))) {
        right.appendChild(editBtn);
        right.appendChild(sw);
        row.appendChild(right);
      }
      recList.appendChild(row);
    }
  }

  // Sinking fund list (v2.1.0: grouped by schedule state for the current month)
  const activeSinking = getActiveSinkingItems(ctx);
  const nowYm = currentYearMonth();
  const nextYm = nextYearMonth(nowYm);
  const monthlyTotal = computeSinkingReserveForMonth(activeSinking, nowYm);
  const nextMonthTotal = computeSinkingReserveForMonth(activeSinking, nextYm);
  el('sinkingMonthlyTotal').textContent = fmtMoney(monthlyTotal, ctx.state.masked);
  const nextHint = el('sinkingNextMonthHint');
  nextHint.textContent =
    nextMonthTotal !== monthlyTotal
      ? `下個月（${formatYmShort(nextYm)}）起變為 ${fmtMoney(nextMonthTotal, ctx.state.masked)}`
      : '';
  nextHint.style.display = nextHint.textContent ? '' : 'none';

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
    e.textContent = '尚無攤提項目，點右上角「+ 新增攤提」';
    sList.appendChild(e);
  } else {
    const current: SinkingFundItem[] = [];
    const ended: SinkingFundItem[] = [];
    for (const item of activeSinking) {
      const state = getSinkingSchedule(item, nowYm).state;
      (state === 'ended' ? ended : current).push(item);
    }
    for (const item of current) sList.appendChild(buildSinkingRow(ctx, item, nowYm));
    if (!current.length) {
      const e = document.createElement('div');
      e.className = 'list-empty';
      e.textContent = '目前沒有進行中的攤提';
      sList.appendChild(e);
    }
    if (ended.length) {
      const details = document.createElement('details');
      details.className = 'sinking-ended-group';
      const summary = document.createElement('summary');
      summary.className = 'list-row';
      summary.textContent = `已結束 · ${ended.length}`;
      details.appendChild(summary);
      for (const item of ended) details.appendChild(buildSinkingRow(ctx, item, nowYm));
      sList.appendChild(details);
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
  const enabledCurrs = normalizeEnabledCurrencies(ctx.engine.getSnapshot().settings.enabledCurrencies);
  const recCurrOpts = existing?.currency && !enabledCurrs.includes(existing.currency)
    ? [...enabledCurrs, existing.currency]
    : enabledCurrs;
  r2.appendChild(makeSelectField('幣別', 'recCurr', recCurrOpts, existing?.currency || 'TWD'));
  form.appendChild(r2);

  const r3 = document.createElement('div');
  r3.className = 'row-2';
  r3.appendChild(makeSelectField('入帳 / 扣款週期', 'recCycle', BILLING_CYCLES, existing?.cycle || '月繳'));
  r3.appendChild(makeSelectField('狀態', 'recStatus', ['啟用', '停用'], existing?.status || '啟用'));
  form.appendChild(r3);

  // v1.13.1: posting day — the auto-posted entry is dated on this day of the month (affects linked savings balances)
  const postDayField = makeInputField(
    '入帳日（每月幾號，1～31；該月沒有這天則記在月底）',
    'recPostDay',
    'number',
    normalizeRecurringPostDay(existing?.postDay),
    '1',
    true
  );
  const postDayInput = postDayField.querySelector('input');
  if (postDayInput) postDayInput.inputMode = 'numeric';
  form.appendChild(postDayField);

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

  bindSubmit(form, async (e) => {
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
        postDay: el<HTMLInputElement>('recPostDay').value.trim(),
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

function currentYearMonth(): string {
  return todayInTimeZone().slice(0, 7);
}

function nextYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function formatYmShort(ym: string | null): string {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${y}/${m}`;
}

/** v2.1.0: one-line description of where an item is in its schedule this month */
export function describeSinkingSchedule(item: SinkingFundItem, ym: string): { badge: string; badgeClass: string; text: string } {
  const sch = getSinkingSchedule(item, ym);
  const months = Math.max(1, Math.round(item.months || 12));
  const range = `${formatYmShort(sch.cycleStartYm)}–${formatYmShort(sch.cycleEndYm)}`;
  switch (sch.state) {
    case 'disabled':
      return { badge: '停用', badgeClass: 'badge red', text: '不計入' };
    case 'unscheduled':
      return { badge: `${months} 個月`, badgeClass: 'badge warn', text: '未設開始月份，每月持續計入' };
    case 'upcoming':
      return { badge: '即將開始', badgeClass: 'badge', text: `${range}，共 ${months} 期` };
    case 'active': {
      const perCycle = item.repeatYearly ? Math.min(months, 12) : months;
      const isLast = !item.repeatYearly && sch.periodIndex === perCycle;
      const tail = item.repeatYearly ? '每年重複' : isLast ? '最後一期，月底後自動結束' : `${formatYmShort(sch.cycleEndYm)} 結束`;
      return { badge: `第 ${sch.periodIndex}/${perCycle} 期`, badgeClass: isLast ? 'badge warn' : 'badge green', text: tail };
    }
    case 'off_cycle':
      return { badge: '本輪已存滿', badgeClass: 'badge', text: `${formatYmShort(sch.nextStartYm)} 開始下一輪` };
    case 'ended':
      return { badge: '已結束', badgeClass: 'badge', text: range };
  }
}

function buildSinkingRow(ctx: UiContext, item: SinkingFundItem, ym: string): HTMLDivElement {
  const snap = ctx.engine.getSnapshot();
  const reserve = computeSinkingMonthlyReserve(item);
  const contributingNow = computeSinkingMonthlyReserve(item, ym) > 0;
  const ytd = computeSinkingYtdSpent(snap.cashflowLogs, ctx.state.selectedYear, item.itemName);
  const desc = describeSinkingSchedule(item, ym);
  const row = document.createElement('div');
  row.className = 'list-row' + (contributingNow ? '' : ' inactive');

  const main = document.createElement('div');
  main.className = 'item-main';
  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.itemName;
  const sub = document.createElement('div');
  sub.className = 'item-sub tnum';
  const badge = document.createElement('span');
  badge.className = desc.badgeClass;
  badge.textContent = desc.badge;
  sub.appendChild(badge);
  sub.appendChild(document.createTextNode(desc.text));
  const sub2 = document.createElement('div');
  sub2.className = 'item-sub tnum';
  const kind = SINKING_FUND_KIND_LABELS[item.fundKind === 'amortize' ? 'amortize' : 'save_first'];
  sub2.textContent = `${kind} · 總額 ${fmtMoney(item.totalAmount, ctx.state.masked)} · 本年已繳 ${fmtMoney(ytd, ctx.state.masked)}`;
  main.appendChild(title);
  main.appendChild(sub);
  main.appendChild(sub2);

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
  return row;
}

export function openSinkingModal(ctx: UiContext, existing: SinkingFundItem | null): void {
  const body = openModal(existing ? '調整攤提' : '新增攤提');
  const form = document.createElement('form');
  form.appendChild(makeInputField('項目名稱', 'sfName', 'text', existing?.itemName || '', '如：所得稅、保費、牙齒矯正、出國旅遊', true));
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
    const start = el<HTMLInputElement>('sfStart')?.value || '';
    const repeat = el<HTMLSelectElement>('sfRepeat')?.value === SINKING_END_REPEAT;
    let period = '';
    if (start) {
      const endYm = addMonthsToYm(start, m - 1);
      period = repeat
        ? ` · 每年 ${Number(start.slice(5))} 月起提撥 ${Math.min(m, 12)} 個月`
        : ` · ${formatYmShort(start)}–${formatYmShort(endYm)}，期滿自動結束`;
    } else {
      period = ' · 未設開始月份：不限期間，停用前每月都計入';
    }
    preview.textContent = `每月提撥 NT$ ${fmtNum(Math.round(a / m))}${period}`;
  };
  // v2.1.0: schedule — start month + auto end / yearly repeat
  const rKind = document.createElement('div');
  rKind.className = 'row-2';
  rKind.appendChild(
    makeSelectField(
      '這筆錢是',
      'sfKind',
      [SINKING_FUND_KIND_LABELS.save_first, SINKING_FUND_KIND_LABELS.amortize],
      SINKING_FUND_KIND_LABELS[existing?.fundKind === 'amortize' ? 'amortize' : 'save_first']
    )
  );
  rKind.appendChild(
    makeSelectField('結束後', 'sfRepeat', [SINKING_END_AUTO, SINKING_END_REPEAT], existing?.repeatYearly ? SINKING_END_REPEAT : SINKING_END_AUTO)
  );
  form.appendChild(rKind);

  const rStart = document.createElement('div');
  rStart.className = 'row-2';
  // A new item starts this month; an existing legacy item keeps an empty start (= unlimited, previous behaviour)
  const startDefault = existing ? existing.startYm || '' : currentYearMonth();
  rStart.appendChild(makeInputField('開始月份', 'sfStart', 'month', startDefault));
  rStart.appendChild(makeSelectField('狀態', 'sfStatus', ['啟用', '停用'], existing?.status || '啟用'));
  form.appendChild(rStart);
  form.appendChild(preview);
  form.appendChild(makeInputField('預計繳款月份', 'sfDue', 'text', existing?.dueNote || '', '例如 5月'));
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

  bindSubmit(form, async (e) => {
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
        startYm: el<HTMLInputElement>('sfStart').value.trim() || null,
        repeatYearly: el<HTMLSelectElement>('sfRepeat').value === SINKING_END_REPEAT,
        fundKind:
          el<HTMLSelectElement>('sfKind').value === SINKING_FUND_KIND_LABELS.amortize ? 'amortize' : 'save_first',
      });
      closeModal();
      showToast('已儲存攤提設定', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
  el('sfAmt').addEventListener('input', updatePreview);
  el('sfMonths').addEventListener('input', updatePreview);
  el('sfStart').addEventListener('input', updatePreview);
  el('sfRepeat').addEventListener('change', updatePreview);
  updatePreview();
}
