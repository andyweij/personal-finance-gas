import { DEFAULT_LEDGER_ID } from '../../../shared/constants';
import {
  aggregatePeriodMetrics,
  computeMonthlyTrend,
  computeNetWorthSummary,
  computeOverviewBreakdownGroups,
  computeSinkingMonthlyReserve,
  filterCashFlowsByLedgerScope,
} from '../../../shared/calculations';
import { el, fmtMoney, fmtPct } from './helpers';
import { getActiveLedgers, renderLedgerSwitcherBar } from './ledgerUi';
import { getSelectedYearMonth } from './logTab';
import type { UiContext } from './state';

function resolveOverviewScope(ctx: UiContext): string {
  const ledgers = getActiveLedgers(ctx);
  const scope = ctx.state.overviewLedgerScope || 'net_worth';
  if (scope === 'net_worth' || scope === 'all') return scope;
  if (ledgers.some((l) => l.id === scope)) return scope;
  ctx.state.overviewLedgerScope = 'net_worth';
  return 'net_worth';
}

export function renderOverviewTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);
  const scope = resolveOverviewScope(ctx);
  const year = ctx.state.selectedYear;
  const month = ctx.state.selectedMonth;
  const ym = getSelectedYearMonth(year, month);

  renderLedgerSwitcherBar(ctx, el('overviewLedgerBar'), {
    mode: 'scope',
    selectedValue: scope,
    onSelect: (nextScope) => {
      ctx.state.overviewLedgerScope = nextScope;
      renderOverviewTab(ctx);
    },
  });

  el('overviewMonthLabel').textContent = ym;

  const activeLogs = filterCashFlowsByLedgerScope(snap.cashflowLogs, scope, ledgers);
  const monthLogs = activeLogs.filter((l) => l.yearMonth === ym);
  const yearLogs = activeLogs.filter((l) => l.yearMonth.startsWith(`${year}-`));

  const includeSinking = scope === 'net_worth' || scope === 'all' || scope === DEFAULT_LEDGER_ID;
  const monthlySinking = includeSinking
    ? snap.sinkingItems
        .filter((s) => !s.deletedAt)
        .reduce((sum, s) => sum + computeSinkingMonthlyReserve(s), 0)
    : 0;

  const monthly = aggregatePeriodMetrics(monthLogs, monthlySinking, includeSinking);
  const yearly = aggregatePeriodMetrics(yearLogs, monthlySinking * 12, false);
  const nw = computeNetWorthSummary(
    snap.assetItems,
    snap.settings,
    monthly.totalConsumption,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    snap.stockTransactions || [],
    undefined,
    ledgers,
    scope
  );

  const m = ctx.state.overviewPeriod === 'monthly' ? monthly : yearly;
  const kpiGrid = el('overviewKpis');
  kpiGrid.innerHTML = '';

  const kpis = [
    { label: '總收入', val: fmtMoney(m.totalIncome, ctx.state.masked), cls: 'pos' },
    { label: '消費性總支出', val: fmtMoney(m.totalConsumption, ctx.state.masked), cls: '' },
    { label: '投資流出（強制儲蓄）', val: fmtMoney(m.investment, ctx.state.masked), cls: 'inv' },
    {
      label: '真實儲蓄率',
      val: ctx.state.masked ? '••%' : `${fmtPct(m.savingsRate, 1)}`,
      cls: m.savingsRate >= 30 ? 'pos' : m.savingsRate < 10 ? 'neg' : '',
    },
    {
      label: '自由現金流',
      val: fmtMoney(m.freeCashFlow, ctx.state.masked),
      cls: m.freeCashFlow >= 0 ? 'pos' : 'neg',
    },
    {
      label: '緊急預備金可支撐',
      val: ctx.state.masked ? '•• 個月' : `${nw.emergencyMonths.toFixed(1)} 個月`,
      cls: nw.emergencyMonths >= snap.settings.emergencyTargetMonths ? 'pos' : 'neg',
    },
  ];

  for (const k of kpis) {
    const box = document.createElement('div');
    box.className = 'kpi-box';
    const lbl = document.createElement('div');
    lbl.className = 'kpi-label';
    lbl.textContent = k.label;
    const val = document.createElement('div');
    val.className = 'kpi-val ' + k.cls;
    val.textContent = k.val;
    box.appendChild(lbl);
    box.appendChild(val);
    kpiGrid.appendChild(box);
  }

  const tbody = el('majorStatsBody');
  tbody.innerHTML = '';
  const groups = computeOverviewBreakdownGroups(
    monthLogs,
    yearLogs,
    includeSinking ? snap.sinkingItems : [],
    monthly,
    yearly
  );
  const expandedSet = new Set(ctx.state.overviewExpandedGroups);

  for (const group of groups) {
    const hasChildren = group.children.length > 0;
    const isExpanded = hasChildren && expandedSet.has(group.key);

    const tr = document.createElement('tr');
    if (group.isTotal) {
      tr.className = 'total-row';
    } else if (hasChildren) {
      tr.className = 'stat-expand-row' + (isExpanded ? ' is-open' : '');
      tr.setAttribute('role', 'button');
      tr.tabIndex = 0;
      const toggle = () => {
        const idx = ctx.state.overviewExpandedGroups.indexOf(group.key);
        if (idx >= 0) {
          ctx.state.overviewExpandedGroups.splice(idx, 1);
        } else {
          ctx.state.overviewExpandedGroups.push(group.key);
        }
        renderOverviewTab(ctx);
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          toggle();
        }
      });
    }

    const td1 = document.createElement('td');
    if (hasChildren) {
      const labelWrap = document.createElement('span');
      labelWrap.className = 'stat-group-label';
      const chev = document.createElement('span');
      chev.className = 'stat-chevron';
      chev.textContent = isExpanded ? '▾' : '▸';
      const txt = document.createElement('span');
      txt.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'stat-child-count';
      count.textContent = `${group.children.length}`;
      labelWrap.appendChild(chev);
      labelWrap.appendChild(txt);
      labelWrap.appendChild(count);
      td1.appendChild(labelWrap);
    } else {
      td1.textContent = group.label;
    }

    const td2 = document.createElement('td');
    td2.className = 'num';
    td2.textContent = fmtMoney(group.monthlyAmount, ctx.state.masked, '');
    const td3 = document.createElement('td');
    td3.className = 'num';
    td3.textContent = fmtMoney(group.yearlyAmount, ctx.state.masked, '');
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tbody.appendChild(tr);

    if (isExpanded) {
      for (const child of group.children) {
        const subTr = document.createElement('tr');
        subTr.className = 'stat-subrow';
        const subTd1 = document.createElement('td');
        subTd1.textContent = child.label;
        const subTd2 = document.createElement('td');
        subTd2.className = 'num';
        subTd2.textContent = fmtMoney(child.monthlyAmount, ctx.state.masked, '');
        const subTd3 = document.createElement('td');
        subTd3.className = 'num';
        subTd3.textContent = fmtMoney(child.yearlyAmount, ctx.state.masked, '');
        subTr.appendChild(subTd1);
        subTr.appendChild(subTd2);
        subTr.appendChild(subTd3);
        tbody.appendChild(subTr);
      }
    }
  }

  el<HTMLInputElement>('budgetInput').value = String(snap.settings.monthlyDailyBudget);
  el<HTMLInputElement>('emergencyInput').value = String(snap.settings.emergencyTargetMonths);

  renderTrendChart(ctx);
}

export function renderTrendChart(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);
  const scope = resolveOverviewScope(ctx);
  const year = ctx.state.selectedYear;
  const scopedLogs = filterCashFlowsByLedgerScope(snap.cashflowLogs, scope, ledgers);
  const trend = computeMonthlyTrend(scopedLogs, year);
  const metric = ctx.state.chartMetric;
  const values = trend.map((p) => p[metric]);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

  el('chartTitle').textContent = `${year} 年 12 個月趨勢`;
  const chart = el('trendBarChart');
  chart.innerHTML = '';

  const curPoint = trend[ctx.state.selectedMonth - 1];
  const metricLabels: Record<string, string> = {
    netCashFlow: '淨現金流',
    investment: '投資流出',
    totalSavings: '總儲蓄',
    daily: '日常花費',
    income: '總收入',
  };
  el('chartSummaryHint').textContent = curPoint
    ? `${curPoint.ym} ${metricLabels[metric]}：${fmtMoney(curPoint[metric], ctx.state.masked)}`
    : '';

  for (const pt of trend) {
    const val = pt[metric];
    const pct = Math.max(5, Math.round((Math.abs(val) / maxAbs) * 100));
    const isCur = pt.month === ctx.state.selectedMonth;

    const col = document.createElement('div');
    col.className = 'bar-col';
    const track = document.createElement('div');
    track.className = 'bar-track';
    const rect = document.createElement('div');
    rect.className = 'bar-rect' + (val < 0 ? ' neg' : '') + (isCur ? ' cur' : '');
    rect.style.height = `${pct}%`;
    track.appendChild(rect);

    const lbl = document.createElement('div');
    lbl.className = 'bar-lbl' + (isCur ? ' cur' : '');
    lbl.textContent = `${pt.month}月`;

    col.appendChild(track);
    col.appendChild(lbl);
    col.addEventListener('click', () => {
      ctx.state.selectedMonth = pt.month;
      ctx.state.ledgerPage = 1;
      ctx.renderAll();
    });
    chart.appendChild(col);
  }
}
