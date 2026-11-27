/**
 * v2.2.0 簡潔版「更多」：固定收支、大額攤提、水電分攤、預算、目標、拆帳、帳本、設定的入口。
 * 每一列只是帶到既有的分頁／區塊或開啟既有的設定視窗，不另外實作功能。
 * v2.2.1: 列的內容由 featureEntries.ts 產生；每個入口的動作寫在 MORE_ACTIONS（缺一個 TypeScript 就會報錯）。
 */
import { computeSinkingReserveForMonth } from '../../../shared/calculations';
import { todayInTimeZone } from '../../../shared/dates';
import { openCalculatorFor } from './calculatorUi';
import { MORE_GROUP_TITLES, getMoreEntries, type MoreEntryId, type MoreGroup } from './featureEntries';
import { el, fmtMoney, fmtNum } from './helpers';
import { openHelpGuideModal } from './helpGuideUi';
import { getActiveLedgers, openLedgerManagerModal } from './ledgerUi';
import { openSecurityModal } from './securityUi';
import type { AppUiState, UiContext } from './state';
import { getCurrentUiVariant } from './uiVariant';

const CHEVRON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function openToolsSubtab(ctx: UiContext, sub: AppUiState['toolsSubtab']): void {
  ctx.navigateToTab('tools');
  document.querySelector<HTMLButtonElement>(`#toolsSubtabBar [data-tools-sub="${sub}"]`)?.click();
}

function scrollToSection(ctx: UiContext, tab: AppUiState['activeTab'], id: string): void {
  ctx.navigateToTab(tab);
  window.setTimeout(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

/** 每一個「更多」入口的動作。新增入口到 featureEntries.ts 後，這裡沒補上會編譯失敗。 */
const MORE_ACTIONS: Record<MoreEntryId, (ctx: UiContext) => void> = {
  recurring: (ctx) => openToolsSubtab(ctx, 'recurring'),
  sinking: (ctx) => openToolsSubtab(ctx, 'sinking'),
  utility: (ctx) => openToolsSubtab(ctx, 'utility'),
  budget_settings: (ctx) => scrollToSection(ctx, 'overview', 'budgetForm'),
  goals: (ctx) => scrollToSection(ctx, 'overview', 'overviewGoalsCard'),
  splits: (ctx) => scrollToSection(ctx, 'assets', 'assetsSplitsCard'),
  calculator: () => openCalculatorFor(null),
  ledgers: (ctx) => openLedgerManagerModal(ctx),
  settings: (ctx) => openSecurityModal(ctx),
  help: () => openHelpGuideModal(),
};

function buildMoreEntries(ctx: UiContext): void {
  const container = el('moreEntries');
  container.innerHTML = '';
  const groups = new Map<MoreGroup, HTMLDivElement>();
  for (const entry of getMoreEntries()) {
    let list = groups.get(entry.simple.group);
    if (!list) {
      const group = document.createElement('div');
      group.className = 'more-group';
      const title = document.createElement('div');
      title.className = 'more-group-title';
      title.textContent = MORE_GROUP_TITLES[entry.simple.group];
      list = document.createElement('div');
      list.className = 'list-group';
      group.appendChild(title);
      group.appendChild(list);
      container.appendChild(group);
      groups.set(entry.simple.group, list);
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'more-row';
    row.dataset.moreAction = entry.id;
    // read by tests/e2e/ui-variants.e2e.mjs to check where the row leads
    row.dataset.expect = JSON.stringify(entry.simple.outcome);

    const icon = document.createElement('span');
    icon.className = 'more-row-icon';
    icon.style.background = entry.simple.color;
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${entry.simple.icon}</svg>`;
    const label = document.createElement('span');
    label.className = 'more-row-label';
    label.textContent = entry.label;
    row.appendChild(icon);
    row.appendChild(label);
    if (entry.simple.hintId) {
      const hint = document.createElement('span');
      hint.className = 'more-row-hint tnum';
      hint.id = entry.simple.hintId;
      row.appendChild(hint);
    }
    row.insertAdjacentHTML('beforeend', CHEVRON_SVG);

    const action = MORE_ACTIONS[entry.id as MoreEntryId];
    row.addEventListener('click', () => action(ctx));
    list.appendChild(row);
  }
}

function setHint(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

export function renderMoreTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const masked = ctx.state.masked;
  const activeRecurring = snap.recurringItems.filter((r) => !r.deletedAt && r.status === '啟用').length;
  setHint('moreRecurringHint', activeRecurring ? `${activeRecurring} 項啟用` : '');
  const sinkingNow = computeSinkingReserveForMonth(snap.sinkingItems, todayInTimeZone().slice(0, 7));
  setHint('moreSinkingHint', sinkingNow > 0 ? `本月 ${fmtMoney(sinkingNow, masked, '')}` : '');
  setHint(
    'moreBudgetHint',
    `${fmtMoney(snap.settings.monthlyDailyBudget, masked, '')} · ${fmtNum(snap.settings.emergencyTargetMonths)} 個月`
  );
  setHint('moreLedgersHint', `${getActiveLedgers(ctx).length} 本`);

  // 水電分攤只在帳號有開啟時顯示（與工具分頁的子分頁同步）
  const utilityBtn = document.querySelector<HTMLButtonElement>('#toolsSubtabBar [data-tools-sub="utility"]');
  const utilityRow = document.querySelector<HTMLElement>('[data-more-action="utility"]');
  if (utilityRow) utilityRow.style.display = utilityBtn && utilityBtn.style.display === 'none' ? 'none' : '';

  const variant = getCurrentUiVariant();
  document.querySelectorAll<HTMLButtonElement>('[data-ui-variant]').forEach((b) => {
    const on = b.dataset.uiVariant === variant;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

export function bindMoreTabEvents(ctx: UiContext): void {
  buildMoreEntries(ctx);
  document.querySelectorAll<HTMLButtonElement>('[data-ui-variant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.setUiVariant(btn.dataset.uiVariant === 'simple' ? 'simple' : 'classic');
    });
  });
}
