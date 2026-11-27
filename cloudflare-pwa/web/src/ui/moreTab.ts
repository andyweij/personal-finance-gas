/**
 * v2.2.0 簡潔版「更多」：固定收支、大額攤提、水電分攤、預算、目標、拆帳、帳本、設定的入口。
 * 每一列只是帶到既有的分頁／區塊或開啟既有的設定視窗，不另外實作功能。
 */
import { computeSinkingReserveForMonth } from '../../../shared/calculations';
import { todayInTimeZone } from '../../../shared/dates';
import { openCalculatorFor } from './calculatorUi';
import { fmtMoney, fmtNum } from './helpers';
import { openHelpGuideModal } from './helpGuideUi';
import { getActiveLedgers, openLedgerManagerModal } from './ledgerUi';
import { openSecurityModal } from './securityUi';
import type { AppUiState, UiContext } from './state';
import { getCurrentUiVariant } from './uiVariant';

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

export function bindMoreTabEvents(ctx: UiContext): void {
  document.querySelectorAll<HTMLButtonElement>('[data-more-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.moreAction) {
        case 'recurring':
          openToolsSubtab(ctx, 'recurring');
          break;
        case 'sinking':
          openToolsSubtab(ctx, 'sinking');
          break;
        case 'utility':
          openToolsSubtab(ctx, 'utility');
          break;
        case 'budget':
          scrollToSection(ctx, 'overview', 'budgetForm');
          break;
        case 'goals':
          scrollToSection(ctx, 'overview', 'overviewGoalsCard');
          break;
        case 'splits':
          scrollToSection(ctx, 'assets', 'assetsSplitsCard');
          break;
        case 'calc':
          openCalculatorFor(null);
          break;
        case 'ledgers':
          openLedgerManagerModal(ctx);
          break;
        case 'settings':
          openSecurityModal(ctx);
          break;
        case 'help':
          openHelpGuideModal();
          break;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-ui-variant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.setUiVariant(btn.dataset.uiVariant === 'simple' ? 'simple' : 'classic');
    });
  });
}
