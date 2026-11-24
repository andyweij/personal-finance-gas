import { describe, expect, it, vi } from 'vitest';
import {
  computePillOffsetPx,
  computeTabIndexFromX,
  initBottomNavScrub,
  isScrubCancelled,
} from '../web/src/ui/tabBarScrub';

describe('Bottom Tab Bar Scrub Gesture Geometry', () => {
  it('maps finger X position to the correct tab index and clamps out-of-bounds edges', () => {
    // Nav bar: left=0, width=400, 4 tabs (100px each)
    expect(computeTabIndexFromX(-20, 0, 400, 4)).toBe(0);
    expect(computeTabIndexFromX(10, 0, 400, 4)).toBe(0);
    expect(computeTabIndexFromX(150, 0, 400, 4)).toBe(1);
    expect(computeTabIndexFromX(250, 0, 400, 4)).toBe(2);
    expect(computeTabIndexFromX(350, 0, 400, 4)).toBe(3);
    expect(computeTabIndexFromX(480, 0, 400, 4)).toBe(3);
  });

  it('computes continuous pill X offset centered under finger and clamped inside nav bar', () => {
    // 4 tabs in 400px -> slotWidth=100, maxOffset=300
    expect(computePillOffsetPx(0, 0, 400, 4)).toBe(0);
    expect(computePillOffsetPx(50, 0, 400, 4)).toBe(0);
    expect(computePillOffsetPx(150, 0, 400, 4)).toBe(100);
    expect(computePillOffsetPx(200, 0, 400, 4)).toBe(150);
    expect(computePillOffsetPx(390, 0, 400, 4)).toBe(300);
    expect(computePillOffsetPx(500, 0, 400, 4)).toBe(300);
  });

  it('cancels scrub only when finger drags significantly above the tab bar', () => {
    // Nav bar starts at y = 760
    expect(isScrubCancelled(780, 760)).toBe(false);
    expect(isScrubCancelled(720, 760)).toBe(false);
    expect(isScrubCancelled(670, 760)).toBe(true);
  });

  it('does not capture pointer on normal click (preserving desktop button clicks), but captures and selects on drag >= 8px', () => {
    const navListeners = new Map<string, Array<(e: unknown) => void>>();
    const winListeners = new Map<string, Array<(e: unknown) => void>>();

    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const makeClassList = () => {
      const set = new Set<string>();
      return {
        add: (c: string) => set.add(c),
        remove: (c: string) => set.delete(c),
        toggle: (c: string, force?: boolean) => {
          if (force === undefined) set.has(c) ? set.delete(c) : set.add(c);
          else if (force) set.add(c);
          else set.delete(c);
        },
        contains: (c: string) => set.has(c),
      };
    };

    const navEl = {
      classList: makeClassList(),
      getBoundingClientRect: () => ({ left: 0, top: 760, width: 500, height: 60 }),
      setPointerCapture,
      hasPointerCapture: () => setPointerCapture.mock.calls.length > 0,
      releasePointerCapture,
      addEventListener: (type: string, cb: (e: unknown) => void) => {
        const arr = navListeners.get(type) || [];
        arr.push(cb);
        navListeners.set(type, arr);
      },
    } as unknown as HTMLElement;

    const pillEl = {
      classList: makeClassList(),
      style: { width: '', transform: '' },
      offsetWidth: 100,
    } as unknown as HTMLElement;

    const buttons = Array.from({ length: 5 }, () => ({
      classList: makeClassList(),
    })) as unknown as HTMLButtonElement[];

    const origWindow = globalThis.window;
    const origRaf = globalThis.requestAnimationFrame;
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0' }),
      addEventListener: (type: string, cb: (e: unknown) => void) => {
        const arr = winListeners.get(type) || [];
        arr.push(cb);
        winListeners.set(type, arr);
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 1;
      },
    };
    (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = () => 1;

    try {
      const onSelectIndex = vi.fn();
      initBottomNavScrub({
        navEl,
        buttons,
        pillEl,
        getActiveIndex: () => 0,
        onSelectIndex,
      });

      const emitNav = (type: string, ev: unknown) => navListeners.get(type)?.forEach((fn) => fn(ev));
      const emitWin = (type: string, ev: unknown) => winListeners.get(type)?.forEach((fn) => fn(ev));

      // 1. Desktop click without drag: must NOT call setPointerCapture, must NOT suppress click
      emitNav('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 250, clientY: 780 });
      emitWin('pointerup', { pointerId: 1, clientX: 250, clientY: 780 });

      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(onSelectIndex).not.toHaveBeenCalled();

      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      emitNav('click', { preventDefault, stopPropagation });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(stopPropagation).not.toHaveBeenCalled();

      // 2. Drag >= 8px from tab 0 to tab 3: captures pointer & selects tab 3 on release
      emitNav('pointerdown', { button: 0, pointerType: 'touch', pointerId: 2, clientX: 50, clientY: 780 });
      emitWin('pointermove', { pointerId: 2, clientX: 350, clientY: 780 });
      expect(setPointerCapture).toHaveBeenCalledWith(2);

      emitWin('pointerup', { pointerId: 2, clientX: 350, clientY: 780 });
      expect(onSelectIndex).toHaveBeenCalledWith(3);
    } finally {
      (globalThis as unknown as { window: unknown }).window = origWindow;
      (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = origRaf;
    }
  });
});
