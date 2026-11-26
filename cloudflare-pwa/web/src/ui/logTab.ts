import { DEFAULT_LEDGER_ID, WEBAPP_CATEGORY_MAP } from '../../../shared/constants';
import {
  aggregatePeriodMetrics,
  computeAllSavingsSummary,
  computeSinkingMonthlyReserve,
  getEffectiveLedgerId,
  isCashFlowIncome,
} from '../../../shared/calculations';
import type { CashFlowLog } from '../../../shared/types';
import { openSavingsAccountModal } from './assetsTab';
import { el, fmtMoney, fmtNum, showToast, TRASH_SVG } from './helpers';
import { renderLedgerSwitcherBar, resolveActiveLedger } from './ledgerUi';
import type { UiContext } from './state';

export function getSelectedYearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function getTodayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function renderLogCategories(ctx: UiContext): void {
  const box = el('categoryChips');
  box.innerHTML = '';
  const cats = WEBAPP_CATEGORY_MAP[ctx.state.logType] || ['其他'];
  if (!cats.includes(ctx.state.logCategory)) {
    ctx.state.logCategory = cats[0];
  }
  for (const c of cats) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn sm' + (c === ctx.state.logCategory ? ' active' : '');
    b.textContent = c;
    b.addEventListener('click', () => {
      ctx.state.logCategory = c;
      renderLogCategories(ctx);
    });
    box.appendChild(b);
  }
}

export function updateFxPreview(ctx: UiContext): void {
  const preview = el('fxPreview');
  const val = parseFloat(el<HTMLInputElement>('amountInput').value);
  const rate = ctx.engine.getSnapshot().settings.usdTwdRate || 32.5;
  if (ctx.state.logCurrency === 'USD' && !Number.isNaN(val) && val > 0) {
    preview.textContent = '≈ NT$ ' + fmtNum(Math.round(val * rate));
  } else {
    preview.textContent = '';
  }
  updateSavingsPreview(ctx);
}

export function updateSavingsPreview(ctx: UiContext): void {
  const preview = el('savingsDeltaPreview');
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const activeLedger = resolveActiveLedger(ctx);
  const savings = computeAllSavingsSummary(
    snap.assetItems,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    rate,
    activeLedger.id
  );
  const selected = savings.accounts.find((a) => a.account.id === ctx.state.logLinkedAccountId);
  if (!selected) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }

  const rawAmt = parseFloat(el<HTMLInputElement>('amountInput').value);
  const dateVal = el<HTMLInputElement>('dateInput').value || getTodayYmd();
  const beforeAnchor = Boolean(
    selected.account.balanceAnchorDate && dateVal < selected.account.balanceAnchorDate
  );

  preview.style.display = 'flex';
  preview.innerHTML = '';

  if (Number.isNaN(rawAmt) || rawAmt <= 0) {
    const left = document.createElement('span');
    left.textContent = `${selected.account.itemName} 目前餘額`;
    const right = document.createElement('strong');
    right.className = selected.currentBalanceTwd < 0 ? 'delta-neg' : 'delta-pos';
    right.textContent = fmtMoney(selected.currentBalanceTwd, ctx.state.masked);
    preview.appendChild(left);
    preview.appendChild(right);
    return;
  }

  if (beforeAnchor) {
    const warn = document.createElement('span');
    warn.className = 'delta-warn';
    warn.textContent = `日期早於 ${selected.account.itemName} 基準日 (${selected.account.balanceAnchorDate})，寫入後不影響目前餘額`;
    preview.appendChild(warn);
    return;
  }

  const twdDeltaAbs = Math.round(ctx.state.logCurrency === 'USD' ? rawAmt * rate : rawAmt);
  const isInc = isCashFlowIncome(ctx.state.logType);
  const signedDelta = isInc ? twdDeltaAbs : -twdDeltaAbs;
  const afterBal = selected.currentBalanceTwd + signedDelta;

  const left = document.createElement('span');
  left.textContent = `${selected.account.itemName}：${fmtMoney(selected.currentBalanceTwd, ctx.state.masked)} → `;
  const afterStrong = document.createElement('strong');
  afterStrong.className = afterBal < 0 ? 'delta-neg' : 'delta-pos';
  afterStrong.textContent = fmtMoney(afterBal, ctx.state.masked);
  left.appendChild(afterStrong);

  const deltaSpan = document.createElement('span');
  deltaSpan.className = isInc ? 'delta-pos' : 'delta-neg';
  deltaSpan.textContent = ctx.state.masked
    ? isInc
      ? '+•••'
      : '-•••'
    : `${isInc ? '+' : '-'}${fmtNum(twdDeltaAbs)}`;

  preview.appendChild(left);
  preview.appendChild(deltaSpan);
}

function renderSavingsStripAndChips(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const rate = snap.settings.usdTwdRate || 32.5;
  const activeLedger = resolveActiveLedger(ctx);
  const savings = computeAllSavingsSummary(
    snap.assetItems,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    rate,
    activeLedger.id
  );

  // Keep selected linked savings account in sync with available accounts in this ledger
  if (!ctx.state.logLinkedAccountTouched) {
    ctx.state.logLinkedAccountId = savings.defaultAccountId;
  } else if (
    ctx.state.logLinkedAccountId &&
    !savings.accounts.some((a) => a.account.id === ctx.state.logLinkedAccountId)
  ) {
    ctx.state.logLinkedAccountId = savings.defaultAccountId;
    ctx.state.logLinkedAccountTouched = false;
  }

  // 1. Live savings balance strip
  const countPill = el('savingsAccountCountPill');
  const totalEl = el('logSavingsTotal');
  const chevron = el('savingsChevron');
  const toggleBtn = el('savingsStripToggle');
  const bodyEl = el('savingsStripBody');

  countPill.textContent = savings.accounts.length ? `${savings.accounts.length} 個帳戶` : '未建立';
  if (!savings.accounts.length) {
    totalEl.className = 'savings-strip-total empty';
    totalEl.textContent = '點此建立活存';
  } else {
    totalEl.className = 'savings-strip-total tnum' + (savings.totalSavingsTwd < 0 ? ' neg' : '');
    totalEl.textContent = fmtMoney(savings.totalSavingsTwd, ctx.state.masked);
  }

  toggleBtn.setAttribute('aria-expanded', String(ctx.state.savingsExpanded));
  chevron.classList.toggle('open', ctx.state.savingsExpanded);
  bodyEl.style.display = ctx.state.savingsExpanded ? 'flex' : 'none';
  bodyEl.innerHTML = '';

  if (ctx.state.savingsExpanded) {
    if (!savings.accounts.length) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = `在「${activeLedger.name}」建立活存帳戶後，此帳本的記帳將即時加減該帳戶餘額。`;
      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.className = 'btn btn-tinted btn-sm';
      createBtn.textContent = `+ 建立「${activeLedger.name}」活存帳戶`;
      createBtn.addEventListener('click', () => {
        ctx.state.assetsLedgerScope = activeLedger.includeInNetWorth ? 'net_worth' : activeLedger.id;
        ctx.navigateToTab('assets');
        openSavingsAccountModal(ctx, null, activeLedger.id);
      });
      bodyEl.appendChild(hint);
      bodyEl.appendChild(createBtn);
    } else {
      for (const s of savings.accounts) {
        const row = document.createElement('div');
        row.className = 'savings-mini-row';
        const name = document.createElement('span');
        name.className = 'savings-mini-name';
        name.textContent = `${s.account.isDefaultSavings ? '★ ' : ''}${s.account.itemName}`;
        const val = document.createElement('span');
        val.className = 'savings-mini-val tnum' + (s.currentBalanceTwd < 0 ? ' neg' : '');
        val.textContent = fmtMoney(s.currentBalanceTwd, ctx.state.masked);
        row.appendChild(name);
        row.appendChild(val);
        bodyEl.appendChild(row);
      }
      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'btn btn-outline btn-sm';
      manageBtn.style.marginTop = '2px';
      manageBtn.textContent = '前往資產頁管理活存 / 存入款項';
      manageBtn.addEventListener('click', () => {
        ctx.state.assetsLedgerScope = activeLedger.includeInNetWorth ? 'net_worth' : activeLedger.id;
        ctx.navigateToTab('assets');
      });
      bodyEl.appendChild(manageBtn);
    }
  }

  // 2. Quick Entry linked savings account chips
  const chipsBox = el('logSavingsChips');
  chipsBox.innerHTML = '';
  if (!savings.accounts.length) {
    const setupBtn = document.createElement('button');
    setupBtn.type = 'button';
    setupBtn.className = 'chip-btn sm';
    setupBtn.textContent = `+ 建立「${activeLedger.name}」活存帳戶`;
    setupBtn.addEventListener('click', () => {
      ctx.state.assetsLedgerScope = activeLedger.includeInNetWorth ? 'net_worth' : activeLedger.id;
      ctx.navigateToTab('assets');
      openSavingsAccountModal(ctx, null, activeLedger.id);
    });
    chipsBox.appendChild(setupBtn);
  } else {
    for (const s of savings.accounts) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn sm' + (ctx.state.logLinkedAccountId === s.account.id ? ' active' : '');
      chip.textContent = `${s.account.isDefaultSavings ? '★ ' : ''}${s.account.itemName}`;
      chip.addEventListener('click', () => {
        ctx.state.logLinkedAccountId = s.account.id;
        ctx.state.logLinkedAccountTouched = true;
        renderSavingsStripAndChips(ctx);
      });
      chipsBox.appendChild(chip);
    }
    const noneChip = document.createElement('button');
    noneChip.type = 'button';
    noneChip.className = 'chip-btn sm' + (ctx.state.logLinkedAccountId === null ? ' active' : '');
    noneChip.textContent = '不連動';
    noneChip.addEventListener('click', () => {
      ctx.state.logLinkedAccountId = null;
      ctx.state.logLinkedAccountTouched = true;
      renderSavingsStripAndChips(ctx);
    });
    chipsBox.appendChild(noneChip);
  }

  updateSavingsPreview(ctx);
}

function createLedgerRow(
  ctx: UiContext,
  item: CashFlowLog,
  savingsNameById: Map<string, string>
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'list-row';
  const isInc = item.type.includes('收入');
  const isInv = item.type === '投資流出';
  const dotColor = isInc ? 'var(--pos-bar)' : isInv ? 'var(--primary)' : 'var(--text-muted)';

  const leading = document.createElement('div');
  leading.className = 'row-leading';
  const dotBox = document.createElement('div');
  dotBox.className = 'type-dot-box';
  const dot = document.createElement('span');
  dot.className = 'type-dot';
  dot.style.background = dotColor;
  dotBox.appendChild(dot);

  const main = document.createElement('div');
  main.className = 'item-main';
  const t = document.createElement('div');
  t.className = 'item-title';
  t.textContent = item.itemName || item.category;
  const sub = document.createElement('div');
  sub.className = 'item-sub tnum';
  const accName = item.linkedAccountId ? savingsNameById.get(item.linkedAccountId) : null;
  sub.textContent = `${item.date} · ${item.type} · ${item.category}${accName ? ` · 活存:${accName}` : ''}${item.note ? ' · ' + item.note : ''}`;
  main.appendChild(t);
  main.appendChild(sub);
  leading.appendChild(dotBox);
  leading.appendChild(main);

  const right = document.createElement('div');
  right.className = 'item-right';
  const amt = document.createElement('div');
  amt.className = 'item-amount';
  amt.style.color = isInc ? 'var(--pos)' : isInv ? 'var(--primary)' : 'var(--text)';
  amt.textContent = (isInc ? '+' : '-') + fmtMoney(item.twdAmount, ctx.state.masked, '');

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'icon-btn sm';
  delBtn.style.color = 'var(--text-muted)';
  delBtn.title = '刪除此筆紀錄';
  delBtn.innerHTML = TRASH_SVG;
  delBtn.addEventListener('click', async () => {
    if (!confirm(`確定刪除「${item.itemName || item.category}」(${item.date})？`)) return;
    await ctx.engine.deleteCashFlow(item.id);
    showToast(`已刪除：${item.itemName || item.category}`, 'success');
    ctx.scheduleSync();
  });

  right.appendChild(amt);
  right.appendChild(delBtn);
  row.appendChild(leading);
  row.appendChild(right);
  return row;
}

export function renderLogTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const activeLedger = resolveActiveLedger(ctx);
  const ym = getSelectedYearMonth(ctx.state.selectedYear, ctx.state.selectedMonth);

  renderLedgerSwitcherBar(ctx, el('logLedgerBar'), {
    mode: 'single',
    selectedValue: activeLedger.id,
    onSelect: (nextId) => {
      ctx.state.activeLedgerId = nextId;
      localStorage.setItem('finance_active_ledger_id', nextId);
      ctx.state.logLinkedAccountTouched = false;
      ctx.state.ledgerPage = 1;
      renderLogTab(ctx);
    },
  });

  const isolatedBanner = el('logIsolatedBanner');
  if (!activeLedger.includeInNetWorth) {
    isolatedBanner.style.display = 'flex';
    isolatedBanner.textContent = `獨立帳本「${activeLedger.name}」：此帳本流水帳與活存完全隔離，不計入個人總資產與儲蓄率`;
  } else {
    isolatedBanner.style.display = 'none';
  }

  const monthLogs = snap.cashflowLogs.filter(
    (l) => !l.deletedAt && l.yearMonth === ym && getEffectiveLedgerId(l) === activeLedger.id
  );
  const isDefaultLedger = activeLedger.id === DEFAULT_LEDGER_ID;
  const monthlySinking = isDefaultLedger
    ? snap.sinkingItems
        .filter((s) => !s.deletedAt)
        .reduce((sum, s) => sum + computeSinkingMonthlyReserve(s), 0)
    : 0;
  const monthly = aggregatePeriodMetrics(monthLogs, monthlySinking, isDefaultLedger);

  const hasBudgetLimit =
    isDefaultLedger ||
    (activeLedger.monthlyDailyBudget !== null &&
      activeLedger.monthlyDailyBudget !== undefined &&
      activeLedger.monthlyDailyBudget > 0);
  const budget = isDefaultLedger
    ? snap.settings.monthlyDailyBudget
    : Number(activeLedger.monthlyDailyBudget || 0);

  el('logMonthBadge').textContent = ym;
  el('ledgerMonthLabel').textContent = ym;
  el('ledgerCountBadge').textContent = String(monthLogs.length);

  const progressTrack = el('budgetProgressTrack');
  if (hasBudgetLimit) {
    const remaining = Math.round(budget - monthly.dailyExpense);
    const usagePct = budget > 0 ? Math.round((monthly.dailyExpense / budget) * 1000) / 10 : 0;

    el('logBudgetCardTitle').textContent = isDefaultLedger
      ? '當月日常消費預算'
      : `${activeLedger.name} · 當月消費預算`;
    el('remainingBudgetLabel').textContent = '剩餘可用';
    el('remainingBudget').textContent = fmtMoney(remaining, ctx.state.masked);
    el('remainingBudget').style.color = remaining < 0 ? 'var(--neg)' : 'var(--text)';
    el('spentText').textContent = '已花費 ' + fmtMoney(monthly.dailyExpense, ctx.state.masked);
    el('budgetLimitText').textContent = '上限 ' + fmtMoney(budget, ctx.state.masked);
    el('usagePctText').textContent = `使用率：${usagePct.toFixed(1)}%`;
    el('quickFreeCashText').textContent = '自由現金流：' + fmtMoney(monthly.freeCashFlow, ctx.state.masked);

    progressTrack.style.display = '';
    const bar = el('budgetProgress');
    bar.style.width = Math.min(100, Math.max(0, usagePct)) + '%';
    bar.className = 'progress-fill' + (usagePct >= 100 ? ' over' : usagePct >= 80 ? ' warn' : '');
  } else {
    const totalOutflow = Math.round(monthly.totalConsumption + monthly.investment);
    const netFlow = Math.round(monthly.totalIncome - totalOutflow);
    el('logBudgetCardTitle').textContent = `${activeLedger.name} · 本月收支摘要`;
    el('remainingBudgetLabel').textContent = '本月淨結餘';
    el('remainingBudget').textContent = fmtMoney(netFlow, ctx.state.masked);
    el('remainingBudget').style.color = netFlow < 0 ? 'var(--neg)' : netFlow > 0 ? 'var(--pos)' : 'var(--text)';
    el('spentText').textContent = '本月收入 ' + fmtMoney(monthly.totalIncome, ctx.state.masked);
    el('budgetLimitText').textContent = '本月支出 ' + fmtMoney(totalOutflow, ctx.state.masked);
    progressTrack.style.display = 'none';
    el('usagePctText').textContent = `本月共 ${monthLogs.length} 筆紀錄`;
    el('quickFreeCashText').textContent = activeLedger.includeInNetWorth
      ? '納入個人總資產'
      : '獨立帳本（不計總資產）';
  }

  renderSavingsStripAndChips(ctx);

  const savingsNameById = new Map(
    snap.assetItems.filter((a) => !a.deletedAt && a.isLinkedSavings).map((a) => [a.id, a.itemName])
  );
  renderLedgerList(ctx, monthLogs, savingsNameById);
  renderLedgerCalendar(ctx, monthLogs, ym, savingsNameById);
}

function renderLedgerList(
  ctx: UiContext,
  logs: CashFlowLog[],
  savingsNameById: Map<string, string>
): void {
  const total = logs.length;
  const totalPages = Math.max(1, Math.ceil(total / ctx.state.pageSize));
  if (ctx.state.ledgerPage > totalPages) ctx.state.ledgerPage = totalPages;
  if (ctx.state.ledgerPage < 1) ctx.state.ledgerPage = 1;

  const start = (ctx.state.ledgerPage - 1) * ctx.state.pageSize;
  const slice = logs.slice(start, start + ctx.state.pageSize);

  el('listRangeInfo').textContent = total
    ? `顯示第 ${start + 1}–${Math.min(total, start + ctx.state.pageSize)} 筆，共 ${total} 筆`
    : '本月尚無流水帳紀錄';

  const list = el('recentList');
  list.innerHTML = '';
  if (!slice.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '本月尚無流水帳紀錄';
    list.appendChild(empty);
  } else {
    for (const item of slice) {
      list.appendChild(createLedgerRow(ctx, item, savingsNameById));
    }
  }

  const bar = el('paginationBar');
  bar.style.display = total > ctx.state.pageSize ? 'flex' : 'none';
  el<HTMLButtonElement>('prevPageBtn').disabled = ctx.state.ledgerPage <= 1;
  el<HTMLButtonElement>('nextPageBtn').disabled = ctx.state.ledgerPage >= totalPages;

  const pills = el('pagePills');
  pills.innerHTML = '';
  const pagesToShow: Array<number | string> = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - ctx.state.ledgerPage) <= 1) {
      pagesToShow.push(p);
    } else if (pagesToShow[pagesToShow.length - 1] !== '...') {
      pagesToShow.push('...');
    }
  }
  for (const p of pagesToShow) {
    if (p === '...') {
      const sp = document.createElement('span');
      sp.className = 'page-ellipsis';
      sp.textContent = '…';
      pills.appendChild(sp);
      continue;
    }
    const pageNum = p as number;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-pill' + (pageNum === ctx.state.ledgerPage ? ' active' : '');
    btn.textContent = String(pageNum);
    btn.addEventListener('click', () => {
      ctx.state.ledgerPage = pageNum;
      renderLedgerList(ctx, logs, savingsNameById);
    });
    pills.appendChild(btn);
  }
}

function renderLedgerCalendar(
  ctx: UiContext,
  logs: CashFlowLog[],
  ym: string,
  savingsNameById: Map<string, string>
): void {
  const year = ctx.state.selectedYear;
  const month = ctx.state.selectedMonth;
  const todayYmd = getTodayYmd();

  if (!ctx.state.selectedCalendarDay || !ctx.state.selectedCalendarDay.startsWith(ym + '-')) {
    ctx.state.selectedCalendarDay = todayYmd.startsWith(ym + '-')
      ? todayYmd
      : logs[0]?.date || `${ym}-01`;
  }

  const byDate = new Map<string, { logs: CashFlowLog[]; expense: number; income: number; inv: number }>();
  for (const item of logs) {
    const entry = byDate.get(item.date) || { logs: [], expense: 0, income: 0, inv: 0 };
    entry.logs.push(item);
    if (item.type.includes('收入')) entry.income += item.twdAmount;
    else if (item.type === '投資流出') entry.inv += item.twdAmount;
    else entry.expense += item.twdAmount;
    byDate.set(item.date, entry);
  }

  const grid = el('calendarGrid');
  grid.innerHTML = '';
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    grid.appendChild(document.createElement('div'));
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${ym}-${String(d).padStart(2, '0')}`;
    const info = byDate.get(dateStr);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className =
      'cal-cell' +
      (dateStr === todayYmd ? ' today' : '') +
      (dateStr === ctx.state.selectedCalendarDay ? ' selected' : '');

    const num = document.createElement('span');
    num.className = 'cal-day-num';
    num.textContent = String(d);
    cell.appendChild(num);

    const dots = document.createElement('div');
    dots.className = 'cal-dots';
    if (info) {
      if (info.expense > 0) {
        const dt = document.createElement('span');
        dt.className = 'cal-dot';
        dt.style.background = 'var(--neg-bar)';
        dots.appendChild(dt);
      }
      if (info.income > 0) {
        const dt = document.createElement('span');
        dt.className = 'cal-dot';
        dt.style.background = 'var(--pos-bar)';
        dots.appendChild(dt);
      }
      if (info.inv > 0) {
        const dt = document.createElement('span');
        dt.className = 'cal-dot';
        dt.style.background = 'var(--primary)';
        dots.appendChild(dt);
      }
    }
    cell.appendChild(dots);

    if (info && info.expense > 0 && !ctx.state.masked) {
      const mini = document.createElement('div');
      mini.className = 'cal-mini-amt';
      mini.textContent = info.expense >= 10000 ? `${(info.expense / 1000).toFixed(0)}k` : fmtNum(info.expense);
      cell.appendChild(mini);
    }

    cell.addEventListener('click', () => {
      ctx.state.selectedCalendarDay = dateStr;
      renderLedgerCalendar(ctx, logs, ym, savingsNameById);
    });
    grid.appendChild(cell);
  }

  const sel = byDate.get(ctx.state.selectedCalendarDay);
  el('calSelectedTitle').textContent = `${ctx.state.selectedCalendarDay} 交易明細`;
  el('calSelectedSummary').textContent = sel
    ? `共 ${sel.logs.length} 筆｜支出 ${fmtMoney(sel.expense, ctx.state.masked)}｜收入 ${fmtMoney(sel.income, ctx.state.masked)}`
    : '當日無交易紀錄';

  const dayList = el('calDayList');
  dayList.innerHTML = '';
  if (!sel || !sel.logs.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '這天還沒有記帳紀錄，可點右上角「+ 補記這天」';
    dayList.appendChild(empty);
  } else {
    for (const item of sel.logs) {
      dayList.appendChild(createLedgerRow(ctx, item, savingsNameById));
    }
  }
}
