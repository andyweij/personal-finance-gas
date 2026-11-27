/**
 * v2.2.0：簡潔版／經典版介面切換的純函式。
 */
import { describe, expect, it } from 'vitest';
import { remainingDaysInMonth } from '../shared/dates';
import {
  UI_VARIANT_STORAGE_KEY,
  normalizeUiVariant,
  readUiVariant,
  resolveTabForVariant,
  simpleNavHighlight,
  writeUiVariant,
} from '../web/src/ui/uiVariant';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('介面版本：儲存與讀取', () => {
  it('預設為經典版；只接受 simple／classic', () => {
    expect(readUiVariant(memoryStorage())).toBe('classic');
    expect(readUiVariant(memoryStorage({ [UI_VARIANT_STORAGE_KEY]: 'simple' }))).toBe('simple');
    expect(readUiVariant(memoryStorage({ [UI_VARIANT_STORAGE_KEY]: 'weird' }))).toBe('classic');
    expect(normalizeUiVariant(undefined)).toBe('classic');
  });

  it('寫入後可讀回；storage 無法使用時不拋錯', () => {
    const st = memoryStorage();
    writeUiVariant(st, 'simple');
    expect(readUiVariant(st)).toBe('simple');
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => writeUiVariant(broken, 'simple')).not.toThrow();
    expect(readUiVariant(broken)).toBe('classic');
    expect(readUiVariant(null)).toBe('classic');
  });
});

describe('介面版本：分頁對應', () => {
  it('切回經典版時，簡潔版才有的分頁對應到最接近的頁面', () => {
    expect(resolveTabForVariant('home', 'classic')).toBe('log');
    expect(resolveTabForVariant('more', 'classic')).toBe('tools');
    expect(resolveTabForVariant('assets', 'classic')).toBe('assets');
    expect(resolveTabForVariant('stocks', 'simple')).toBe('stocks');
  });

  it('簡潔版的次要頁面在底部導覽亮上一層', () => {
    expect(simpleNavHighlight('overview')).toBe('home');
    expect(simpleNavHighlight('stocks')).toBe('assets');
    expect(simpleNavHighlight('tools')).toBe('more');
    expect(simpleNavHighlight('log')).toBe('log');
  });
});

describe('首頁：本月剩餘天數', () => {
  it('含今天；月底當天為 1；閏年 2 月', () => {
    expect(remainingDaysInMonth('2026-11', '2026-11-27')).toBe(4);
    expect(remainingDaysInMonth('2026-11', '2026-11-30')).toBe(1);
    expect(remainingDaysInMonth('2028-02', '2028-02-01')).toBe(29);
  });

  it('檢視的不是本月時回傳 null', () => {
    expect(remainingDaysInMonth('2026-10', '2026-11-27')).toBeNull();
  });
});
