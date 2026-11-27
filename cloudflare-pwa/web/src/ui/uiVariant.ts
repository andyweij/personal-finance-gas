/**
 * v2.2.0: 介面版本切換（簡潔版／經典版）。
 *
 * 兩個版本共用同一份資料、同步與計算邏輯，只換畫面的排列方式；設定只存在這台裝置（localStorage）。
 * 簡潔版沿用既有區塊：
 *   - 「明細」= 記帳分頁的流水帳面板（tab-log，固定顯示 ledger 子分頁）
 *   - 「記一筆」= 同一張記帳表單，搬進底部面板
 *   - 總覽、持股、工具仍是原本的分頁，從首頁／資產／更多點進去，頂部多一個返回鍵
 * 新寫的只有「首頁」與「更多」兩個分頁。
 */
import type { AppUiState } from './state';

export type UiVariant = 'classic' | 'simple';
export type AppTab = AppUiState['activeTab'];

export const UI_VARIANT_STORAGE_KEY = 'finance_ui_variant';

/** 簡潔版底部導覽的分頁（「＋記一筆」不是分頁） */
export const SIMPLE_PRIMARY_TABS: AppTab[] = ['home', 'log', 'assets', 'more'];
/** 經典版底部導覽的分頁 */
export const CLASSIC_TABS: AppTab[] = ['log', 'overview', 'assets', 'stocks', 'tools'];
/** 簡潔版從其他頁點進去的次要分頁，以及返回時回到哪一頁 */
export const SIMPLE_SECONDARY_PARENT: Partial<Record<AppTab, AppTab>> = {
  overview: 'home',
  stocks: 'assets',
  tools: 'more',
};

export function normalizeUiVariant(raw: unknown): UiVariant {
  return raw === 'simple' ? 'simple' : 'classic';
}

export function readUiVariant(storage: Pick<Storage, 'getItem'> | null | undefined): UiVariant {
  try {
    return normalizeUiVariant(storage?.getItem(UI_VARIANT_STORAGE_KEY));
  } catch {
    return 'classic';
  }
}

export function writeUiVariant(storage: Pick<Storage, 'setItem'> | null | undefined, variant: UiVariant): void {
  try {
    storage?.setItem(UI_VARIANT_STORAGE_KEY, variant);
  } catch {
    // private mode / blocked storage: the choice only lasts for this page view
  }
}

/** 切換版本後，目前所在的分頁要換成哪一頁（各版本沒有的分頁對應到最接近的頁面） */
export function resolveTabForVariant(tab: AppTab, variant: UiVariant): AppTab {
  if (variant === 'classic') {
    if (tab === 'home') return 'log';
    if (tab === 'more') return 'tools';
    return tab;
  }
  return tab;
}

/** 簡潔版底部導覽要亮哪一顆：次要分頁亮它的上一層 */
export function simpleNavHighlight(tab: AppTab): AppTab {
  return SIMPLE_SECONDARY_PARENT[tab] || tab;
}

export function getCurrentUiVariant(): UiVariant {
  if (typeof document === 'undefined') return 'classic';
  return normalizeUiVariant(document.documentElement.dataset.ui);
}
