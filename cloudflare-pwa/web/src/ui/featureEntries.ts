/**
 * v2.2.1: 功能入口清單 —— 每個功能在「經典版」與「簡潔版」各從哪裡進去。
 *
 * 新增功能時：
 *   1. 功能本體（邏輯、區塊、彈窗）只寫一份，兩個版本共用。
 *   2. 在這份清單加一筆，寫明經典版與簡潔版的入口。
 *      - 簡潔版入口是「更多」的一列時，moreTab.ts 的 MORE_ACTIONS 必須補上處理（TypeScript 會擋）。
 *   3. tests/feature-entries.test.ts 會對照 index.html 檢查兩邊的入口都存在；
 *      tests/e2e/ui-variants.e2e.mjs 會在兩個版本實際點過一次。
 *
 * 這個檔案只放資料（不 import 任何畫面模組），測試可以直接讀。
 */
import type { AppUiState } from './state';

type AppTab = AppUiState['activeTab'];

/** 經典版入口：`elementId` 是功能所在的元素；有 `tab` 時該元素必須在那個分頁裡，沒有則是全域元素（頂列、浮動按鈕） */
export interface ClassicEntry {
  tab?: AppTab;
  elementId: string;
}

/** 「更多」列點下去的結果，供端到端測試驗證 */
export type MoreOutcome = { kind: 'tab'; tab: AppTab; elementId?: string } | { kind: 'modal' } | { kind: 'calculator' };

export type MoreGroup = 'automation' | 'planning' | 'account';

export const MORE_GROUP_TITLES: Record<MoreGroup, string> = {
  automation: '每月自動化',
  planning: '規劃與工具',
  account: '帳本與帳號',
};

export type SimpleEntry =
  /** 簡潔版底部導覽的分頁 */
  | { kind: 'nav'; tab: AppTab }
  /** ＋記一筆面板 */
  | { kind: 'quickadd' }
  /** 簡潔版某一頁上的按鈕或連結（`elementId` 必須在 `tab` 分頁裡） */
  | { kind: 'element'; tab: AppTab; elementId: string }
  /** 「更多」頁的一列 */
  | {
      kind: 'more';
      group: MoreGroup;
      color: string;
      /** 24×24 stroke 圖示的 SVG 內容 */
      icon: string;
      /** 列右側的提示文字元素 id（moreTab.ts 填入內容） */
      hintId?: string;
      outcome: MoreOutcome;
    };

export interface FeatureEntry {
  id: string;
  label: string;
  classic: ClassicEntry;
  simple: SimpleEntry;
}

export const FEATURE_ENTRIES = [
  {
    id: 'budget_summary',
    label: '本月預算與收支',
    classic: { tab: 'log', elementId: 'logBudgetCard' },
    simple: { kind: 'nav', tab: 'home' },
  },
  {
    id: 'ledger',
    label: '流水帳明細',
    classic: { tab: 'log', elementId: 'ledgerPanel' },
    simple: { kind: 'nav', tab: 'log' },
  },
  {
    id: 'entry',
    label: '記一筆',
    classic: { tab: 'log', elementId: 'expenseForm' },
    simple: { kind: 'quickadd' },
  },
  {
    id: 'overview',
    label: '年度趨勢與大項統計',
    classic: { tab: 'overview', elementId: 'overviewKpis' },
    simple: { kind: 'element', tab: 'home', elementId: 'homeOverviewLink' },
  },
  {
    id: 'assets',
    label: '資產負債',
    classic: { tab: 'assets', elementId: 'assetsHeroCard' },
    simple: { kind: 'nav', tab: 'assets' },
  },
  {
    id: 'stocks',
    label: '台股持股',
    classic: { tab: 'stocks', elementId: 'stocksPortfolioList' },
    simple: { kind: 'element', tab: 'assets', elementId: 'simpleStocksRow' },
  },
  {
    id: 'recurring',
    label: '固定收支',
    classic: { tab: 'tools', elementId: 'subtab-recurring' },
    simple: {
      kind: 'more',
      group: 'automation',
      color: '#2F6FD0',
      icon: '<path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/>',
      hintId: 'moreRecurringHint',
      outcome: { kind: 'tab', tab: 'tools', elementId: 'subtab-recurring' },
    },
  },
  {
    id: 'sinking',
    label: '大額攤提',
    classic: { tab: 'tools', elementId: 'subtab-sinking' },
    simple: {
      kind: 'more',
      group: 'automation',
      color: '#E8913A',
      icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
      hintId: 'moreSinkingHint',
      outcome: { kind: 'tab', tab: 'tools', elementId: 'subtab-sinking' },
    },
  },
  {
    id: 'budget_settings',
    label: '預算與緊急預備金',
    classic: { tab: 'overview', elementId: 'budgetForm' },
    simple: {
      kind: 'more',
      group: 'automation',
      color: '#34A853',
      icon: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
      hintId: 'moreBudgetHint',
      outcome: { kind: 'tab', tab: 'overview', elementId: 'budgetForm' },
    },
  },
  {
    id: 'goals',
    label: '財務目標',
    classic: { tab: 'overview', elementId: 'overviewGoalsCard' },
    simple: {
      kind: 'more',
      group: 'planning',
      color: '#C2185B',
      icon: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
      outcome: { kind: 'tab', tab: 'overview', elementId: 'overviewGoalsCard' },
    },
  },
  {
    id: 'splits',
    label: '代墊與拆帳',
    classic: { tab: 'assets', elementId: 'assetsSplitsCard' },
    simple: {
      kind: 'more',
      group: 'planning',
      color: '#6E3FBF',
      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
      outcome: { kind: 'tab', tab: 'assets', elementId: 'assetsSplitsCard' },
    },
  },
  {
    id: 'utility',
    label: '5F／6F 水電分攤',
    classic: { tab: 'tools', elementId: 'subtab-utility' },
    simple: {
      kind: 'more',
      group: 'planning',
      color: '#0A84A8',
      icon: '<path d="M12 2.7s-6 6.3-6 11.3a6 6 0 0 0 12 0c0-5-6-11.3-6-11.3Z"/>',
      outcome: { kind: 'tab', tab: 'tools', elementId: 'subtab-utility' },
    },
  },
  {
    id: 'calculator',
    label: '計算機',
    classic: { elementId: 'calcFabBtn' },
    simple: {
      kind: 'more',
      group: 'planning',
      color: '#636366',
      icon: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
      outcome: { kind: 'calculator' },
    },
  },
  {
    id: 'ledgers',
    label: '帳本與共享',
    classic: { tab: 'log', elementId: 'logLedgerBar' },
    simple: {
      kind: 'more',
      group: 'account',
      color: '#5856D6',
      icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z"/>',
      hintId: 'moreLedgersHint',
      outcome: { kind: 'modal' },
    },
  },
  {
    id: 'settings',
    label: '帳號、安全、配色與備份',
    classic: { elementId: 'securityBtn' },
    simple: {
      kind: 'more',
      group: 'account',
      color: '#3A3A3C',
      icon: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
      outcome: { kind: 'modal' },
    },
  },
  {
    id: 'help',
    label: '使用說明',
    classic: { tab: 'overview', elementId: 'overviewHelpBtn' },
    simple: {
      kind: 'more',
      group: 'account',
      color: '#8E8E93',
      icon: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
      outcome: { kind: 'modal' },
    },
  },
  {
    id: 'ui_variant',
    label: '介面版本切換',
    // 經典版在「設定」視窗裡（由頂列的設定鍵開啟）
    classic: { elementId: 'securityBtn' },
    simple: { kind: 'element', tab: 'more', elementId: 'moreUiVariantSeg' },
  },
] as const satisfies readonly FeatureEntry[];

type Entry = (typeof FEATURE_ENTRIES)[number];
/** 簡潔版入口在「更多」頁的功能 id */
export type MoreEntryId = Extract<Entry, { simple: { kind: 'more' } }>['id'];

export function getMoreEntries(): Array<FeatureEntry & { simple: Extract<SimpleEntry, { kind: 'more' }> }> {
  return (FEATURE_ENTRIES as readonly FeatureEntry[]).filter(
    (e): e is FeatureEntry & { simple: Extract<SimpleEntry, { kind: 'more' }> } => e.simple.kind === 'more'
  );
}
