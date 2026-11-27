/**
 * v2.2.0 簡潔版「首頁」：本月還可以花（或非預算帳本的本月淨結餘）、收入／總支出／儲蓄率三個數字、最近 5 筆交易。
 * 數字的算法與記帳分頁的預算卡相同（aggregatePeriodMetrics + 當月在期間內的攤提）。
 */
import { DEFAULT_LEDGER_ID } from '../../../shared/constants';
import { remainingDaysInMonth, todayInTimeZone } from '../../../shared/dates';
import {
  aggregatePeriodMetrics,
  computeSinkingReserveForMonth,
  computeStockPortfolioSummary,
  getEffectiveLedgerId,
} from '../../../shared/calculations';
import { el, fmtMoney, fmtPct } from './helpers';
import { renderLedgerSwitcherBar, getActiveLedgers, resolveActiveLedger } from './ledgerUi';
import { createLedgerRow, getSelectedYearMonth, linkableAccountNames } from './logTab';
import type { UiContext } from './state';

const RECENT_COUNT = 5;

export function renderHomeTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);
  const activeLedger = resolveActiveLedger(ctx);
  const masked = ctx.state.masked;
  const ym = getSelectedYearMonth(ctx.state.selectedYear, ctx.state.selectedMonth);
  const today = todayInTimeZone();

  renderLedgerSwitcherBar(ctx, el('homeLedgerBar'), {
    mode: 'single',
    selectedValue: activeLedger.id,
    onSelect: (nextId) => {
      ctx.state.activeLedgerId = nextId;
      localStorage.setItem('finance_active_ledger_id', nextId);
      ctx.state.logLinkedAccountTouched = false;
      ctx.state.ledgerPage = 1;
      ctx.renderAll();
    },
  });

  const ledgerLogs = snap.cashflowLogs.filter((l) => !l.deletedAt && getEffectiveLedgerId(l) === activeLedger.id);
  const monthLogs = ledgerLogs.filter((l) => l.yearMonth === ym);
  const isDefaultLedger = activeLedger.id === DEFAULT_LEDGER_ID;
  const monthlySinking = isDefaultLedger ? computeSinkingReserveForMonth(snap.sinkingItems, ym) : 0;
  const monthly = aggregatePeriodMetrics(monthLogs, monthlySinking, isDefaultLedger);
  const budget = isDefaultLedger ? snap.settings.monthlyDailyBudget : Number(activeLedger.monthlyDailyBudget || 0);
  const hasBudget = isDefaultLedger || budget > 0;
  const monthNum = Number(ym.slice(5, 7));
  const daysLeft = remainingDaysInMonth(ym, today);

  const track = el('homeHeroTrack');
  const valueEl = el('homeHeroValue');
  if (hasBudget) {
    const remaining = Math.round(budget - monthly.dailyExpense);
    const usagePct = budget > 0 ? (monthly.dailyExpense / budget) * 100 : 0;
    el('homeHeroTitle').textContent = `${monthNum} 月還可以花`;
    el('homeHeroMeta').textContent = daysLeft !== null ? `剩 ${daysLeft} 天` : ym;
    valueEl.textContent = fmtMoney(remaining, masked);
    valueEl.style.color = remaining < 0 ? 'var(--neg)' : 'var(--text)';
    track.style.display = '';
    const fill = el('homeHeroFill');
    fill.style.width = Math.min(100, Math.max(0, usagePct)) + '%';
    fill.className = 'progress-fill' + (usagePct >= 100 ? ' over' : usagePct >= 80 ? ' warn' : '');
    el('homeHeroSpent').textContent = `已花 ${fmtMoney(monthly.dailyExpense, masked, '')} ／ 預算 ${fmtMoney(budget, masked, '')}`;
    el('homeHeroDaily').textContent =
      daysLeft !== null && remaining > 0 ? `每日可用 ${fmtMoney(Math.floor(remaining / daysLeft), masked, '')}` : '';
  } else {
    const outflow = Math.round(monthly.totalConsumption + monthly.investment);
    const net = Math.round(monthly.totalIncome - outflow);
    el('homeHeroTitle').textContent = `${activeLedger.name} · ${monthNum} 月淨結餘`;
    el('homeHeroMeta').textContent = daysLeft !== null ? `剩 ${daysLeft} 天` : ym;
    valueEl.textContent = fmtMoney(net, masked);
    valueEl.style.color = net < 0 ? 'var(--neg)' : 'var(--text)';
    track.style.display = 'none';
    el('homeHeroSpent').textContent = `收入 ${fmtMoney(monthly.totalIncome, masked, '')} ／ 支出 ${fmtMoney(outflow, masked, '')}`;
    el('homeHeroDaily').textContent = '';
  }

  const stats = el('homeStats');
  stats.innerHTML = '';
  const tiles: Array<{ label: string; value: string; color?: string }> = [
    { label: '收入', value: fmtMoney(monthly.totalIncome, masked, '') },
    { label: '總支出', value: fmtMoney(monthly.totalConsumption, masked, '') },
    {
      label: '儲蓄率',
      value: masked ? '••%' : monthly.totalIncome > 0 ? fmtPct(monthly.savingsRate, 0) : '—',
      color: monthly.totalIncome > 0 && monthly.savingsRate > 0 ? 'var(--pos)' : undefined,
    },
  ];
  for (const t of tiles) {
    const box = document.createElement('div');
    box.className = 'home-stat';
    const lbl = document.createElement('span');
    lbl.className = 'home-stat-label';
    lbl.textContent = t.label;
    const val = document.createElement('span');
    val.className = 'home-stat-value';
    val.textContent = t.value;
    if (t.color) val.style.color = t.color;
    box.appendChild(lbl);
    box.appendChild(val);
    stats.appendChild(box);
  }

  const recent = ledgerLogs
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, RECENT_COUNT);
  const list = el('homeRecentList');
  list.innerHTML = '';
  if (!recent.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = '還沒有紀錄，點下方「＋」記第一筆';
    list.appendChild(e);
  } else {
    const names = linkableAccountNames(snap);
    const ledgerNames = new Map(ledgers.map((l) => [l.id, l.name]));
    for (const item of recent) list.appendChild(createLedgerRow(ctx, item, names, [], ledgerNames));
  }
}

/** v2.2.0 簡潔版資產頁的「台股持股」入口列 */
export function renderSimpleStocksRow(ctx: UiContext): void {
  const valueEl = document.getElementById('simpleStocksValue');
  if (!valueEl) return;
  const snap = ctx.engine.getSnapshot();
  const masked = ctx.state.masked;
  const p = computeStockPortfolioSummary(snap.assetItems, snap.stockTransactions || [], snap.settings);
  el('simpleStocksCount').textContent = p.positions.length ? `${p.positions.length} 檔` : '';
  if (!p.positions.length) {
    valueEl.textContent = '';
    el('simpleStocksSub').textContent = '尚無持股，點此新增持股與觀察清單';
    return;
  }
  valueEl.textContent = fmtMoney(p.totalMarketValueTwd, masked);
  const parts: string[] = [];
  if (p.totalDailyChangePct !== null) parts.push(`今日 ${fmtPct(p.totalDailyChangePct, 1, true)}`);
  if (p.hasAnyCostBasis) parts.push(`含息報酬 ${fmtPct(p.totalReturnRoiPct, 1, true)}`);
  el('simpleStocksSub').textContent = parts.length ? parts.join(' · ') : '市值、損益、配息與再平衡';
}
