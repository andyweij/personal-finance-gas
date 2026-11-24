import { WEBAPP_CATEGORY_MAP } from '../../../shared/constants';
import { aggregatePeriodMetrics, computeSinkingMonthlyReserve } from '../../../shared/calculations';
import type { CashFlowLog } from '../../../shared/types';
import { el, fmtMoney, fmtNum, showToast, TRASH_SVG } from './helpers';
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
}

function createLedgerRow(ctx: UiContext, item: CashFlowLog): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'list-row';
  const isInc = item.type.includes('收入');
  const isInv = item.type === '投資流出';
  const dotColor = isInc ? 'var(--success-bar)' : isInv ? 'var(--primary)' : 'var(--text-muted)';

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
  sub.textContent = `${item.date} · ${item.type} · ${item.category}${item.note ? ' · ' + item.note : ''}`;
  main.appendChild(t);
  main.appendChild(sub);
  leading.appendChild(dotBox);
  leading.appendChild(main);

  const right = document.createElement('div');
  right.className = 'item-right';
  const amt = document.createElement('div');
  amt.className = 'item-amount';
  amt.style.color = isInc ? 'var(--success)' : isInv ? 'var(--primary)' : 'var(--text)';
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
  const ym = getSelectedYearMonth(ctx.state.selectedYear, ctx.state.selectedMonth);
  const monthLogs = snap.cashflowLogs.filter((l) => !l.deletedAt && l.yearMonth === ym);
  const monthlySinking = snap.sinkingItems
    .filter((s) => !s.deletedAt)
    .reduce((sum, s) => sum + computeSinkingMonthlyReserve(s), 0);
  const monthly = aggregatePeriodMetrics(monthLogs, monthlySinking, true);

  const budget = snap.settings.monthlyDailyBudget;
  const remaining = Math.round(budget - monthly.dailyExpense);
  const usagePct = budget > 0 ? Math.round((monthly.dailyExpense / budget) * 1000) / 10 : 0;

  el('logMonthBadge').textContent = ym;
  el('ledgerMonthLabel').textContent = ym;
  el('ledgerCountBadge').textContent = String(monthLogs.length);
  el('remainingBudget').textContent = fmtMoney(remaining, ctx.state.masked);
  el('remainingBudget').style.color = remaining < 0 ? 'var(--danger)' : 'var(--text)';
  el('spentText').textContent = '已花費 ' + fmtMoney(monthly.dailyExpense, ctx.state.masked);
  el('budgetLimitText').textContent = '上限 ' + fmtMoney(budget, ctx.state.masked);
  el('usagePctText').textContent = `使用率：${usagePct.toFixed(1)}%`;
  el('quickFreeCashText').textContent = '自由現金流：' + fmtMoney(monthly.freeCashFlow, ctx.state.masked);

  const bar = el('budgetProgress');
  bar.style.width = Math.min(100, Math.max(0, usagePct)) + '%';
  bar.className = 'progress-fill' + (usagePct >= 100 ? ' over' : usagePct >= 80 ? ' warn' : '');

  renderLedgerList(ctx, monthLogs);
  renderLedgerCalendar(ctx, monthLogs, ym);
}

function renderLedgerList(ctx: UiContext, logs: CashFlowLog[]): void {
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
      list.appendChild(createLedgerRow(ctx, item));
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
      renderLedgerList(ctx, logs);
    });
    pills.appendChild(btn);
  }
}

function renderLedgerCalendar(ctx: UiContext, logs: CashFlowLog[], ym: string): void {
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
        dt.style.background = 'var(--danger-bar)';
        dots.appendChild(dt);
      }
      if (info.income > 0) {
        const dt = document.createElement('span');
        dt.className = 'cal-dot';
        dt.style.background = 'var(--success-bar)';
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
      renderLedgerCalendar(ctx, logs, ym);
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
      dayList.appendChild(createLedgerRow(ctx, item));
    }
  }
}
