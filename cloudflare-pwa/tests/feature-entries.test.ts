/**
 * v2.2.1：功能入口清單（web/src/ui/featureEntries.ts）對照 web/index.html，
 * 確保每個功能在經典版與簡潔版都找得到入口，新增功能時不會只做一邊。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEATURE_ENTRIES, type FeatureEntry } from '../web/src/ui/featureEntries';
import { CLASSIC_TABS, SIMPLE_PRIMARY_TABS } from '../web/src/ui/uiVariant';

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../web/index.html'), 'utf8');
const entries = FEATURE_ENTRIES as readonly FeatureEntry[];

/** The HTML of `<section id="tab-…">`, or null when the tab section does not exist */
function tabSection(tab: string): string | null {
  const open = html.search(new RegExp(`<section[^>]*\\bid="tab-${tab}"`));
  if (open < 0) return null;
  const close = html.indexOf('</section>', open);
  return html.slice(open, close);
}

function hasId(fragment: string, id: string): boolean {
  return new RegExp(`\\bid="${id}"`).test(fragment);
}

describe('功能入口清單', () => {
  it('id 不重複，每筆都有名稱', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of entries) expect(e.label.trim()).not.toBe('');
  });

  it.each(entries.map((e) => [e.id, e] as const))('經典版入口存在：%s', (_id, e) => {
    if (e.classic.tab) {
      expect(CLASSIC_TABS).toContain(e.classic.tab);
      const section = tabSection(e.classic.tab);
      expect(section, `tab-${e.classic.tab} 不存在`).not.toBeNull();
      expect(hasId(section!, e.classic.elementId), `#${e.classic.elementId} 不在 tab-${e.classic.tab}`).toBe(true);
    } else {
      expect(hasId(html, e.classic.elementId), `#${e.classic.elementId} 不存在`).toBe(true);
    }
  });

  it.each(entries.map((e) => [e.id, e] as const))('簡潔版入口存在：%s', (_id, e) => {
    const s = e.simple;
    switch (s.kind) {
      case 'nav':
        expect(SIMPLE_PRIMARY_TABS).toContain(s.tab);
        expect(html).toContain(`data-simple-tab="${s.tab}"`);
        expect(tabSection(s.tab)).not.toBeNull();
        break;
      case 'quickadd':
        expect(hasId(html, 'simpleAddBtn')).toBe(true);
        expect(hasId(html, 'quickAddBody')).toBe(true);
        break;
      case 'element': {
        const section = tabSection(s.tab);
        expect(section, `tab-${s.tab} 不存在`).not.toBeNull();
        expect(hasId(section!, s.elementId), `#${s.elementId} 不在 tab-${s.tab}`).toBe(true);
        break;
      }
      case 'more': {
        expect(hasId(tabSection('more') || '', 'moreEntries')).toBe(true);
        expect(s.icon).toMatch(/^<(path|circle|rect)/);
        if (s.outcome.kind === 'tab') {
          const section = tabSection(s.outcome.tab);
          expect(section, `tab-${s.outcome.tab} 不存在`).not.toBeNull();
          if (s.outcome.elementId) expect(hasId(section!, s.outcome.elementId)).toBe(true);
        }
        break;
      }
    }
  });

  it('兩個版本的底部導覽分頁都在清單裡', () => {
    const classicTabs = new Set(entries.map((e) => e.classic.tab).filter(Boolean));
    for (const tab of CLASSIC_TABS) expect(classicTabs.has(tab), `經典版分頁 ${tab} 沒有任何功能`).toBe(true);
    const simpleNav = new Set(entries.map((e) => (e.simple.kind === 'nav' ? e.simple.tab : null)).filter(Boolean));
    for (const tab of SIMPLE_PRIMARY_TABS.filter((t) => t !== 'more')) {
      expect(simpleNav.has(tab), `簡潔版導覽 ${tab} 沒有對應功能`).toBe(true);
    }
  });

  it('簡潔版的次要分頁（總覽、持股、工具）都有入口', () => {
    const reachable = new Set<string>();
    for (const e of entries) {
      if (e.simple.kind === 'nav') reachable.add(e.simple.tab);
      if (e.simple.kind === 'element') reachable.add(e.classic.tab || '');
      if (e.simple.kind === 'more' && e.simple.outcome.kind === 'tab') reachable.add(e.simple.outcome.tab);
    }
    for (const tab of ['overview', 'stocks', 'tools']) expect(reachable.has(tab), `${tab} 在簡潔版沒有入口`).toBe(true);
  });
});
