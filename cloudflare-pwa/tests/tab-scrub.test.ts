import { describe, expect, it } from 'vitest';
import {
  computePillOffsetPx,
  computeTabIndexFromX,
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
});
