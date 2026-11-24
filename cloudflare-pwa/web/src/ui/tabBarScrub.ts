export function computeTabIndexFromX(
  clientX: number,
  barLeft: number,
  barWidth: number,
  tabCount: number
): number {
  if (tabCount <= 1 || barWidth <= 0) return 0;
  const relX = clientX - barLeft;
  const ratio = relX / barWidth;
  const idx = Math.floor(ratio * tabCount);
  return Math.max(0, Math.min(tabCount - 1, idx));
}

export function computePillOffsetPx(
  clientX: number,
  barLeft: number,
  barWidth: number,
  tabCount: number
): number {
  if (tabCount <= 1 || barWidth <= 0) return 0;
  const slotWidth = barWidth / tabCount;
  const rawLeft = clientX - barLeft - slotWidth / 2;
  const maxLeft = barWidth - slotWidth;
  return Math.max(0, Math.min(maxLeft, rawLeft));
}

export function isScrubCancelled(
  clientY: number,
  barTop: number,
  cancelThresholdPx = 72
): boolean {
  return clientY < barTop - cancelThresholdPx;
}

export interface BottomNavScrubOptions {
  navEl: HTMLElement;
  buttons: HTMLButtonElement[];
  pillEl: HTMLElement;
  getActiveIndex: () => number;
  onSelectIndex: (index: number) => void;
}

/**
 * 實作 iOS 原生風格底部導覽列「按住左右滑動高亮膠囊、放開才切換分頁」手勢
 */
export function initBottomNavScrub(opts: BottomNavScrubOptions): { syncPill: (instant?: boolean) => void } {
  const { navEl, buttons, pillEl, getActiveIndex, onSelectIndex } = opts;
  const tabCount = buttons.length;

  let activePointerId: number | null = null;
  let startX = 0;
  let isScrubbing = false;
  let hoveredIndex = -1;
  let suppressNextClick = false;

  const getTrackMetrics = () => {
    const style = window.getComputedStyle(navEl);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const rect = navEl.getBoundingClientRect();
    const innerLeft = rect.left + padLeft;
    const innerWidth = Math.max(1, rect.width - padLeft - padRight);
    return { rect, padLeft, innerLeft, innerWidth, slotWidth: innerWidth / tabCount };
  };

  const snapPillToIndex = (idx: number, instant = false) => {
    const { padLeft, slotWidth } = getTrackMetrics();
    const safeIdx = Math.max(0, Math.min(tabCount - 1, idx));
    pillEl.style.width = `${Math.max(0, slotWidth - 6)}px`;
    if (instant) {
      pillEl.classList.add('no-anim');
    } else {
      pillEl.classList.remove('no-anim');
    }
    pillEl.style.transform = `translate3d(${padLeft + safeIdx * slotWidth + 3}px, 0, 0)`;
    if (instant) {
      void pillEl.offsetWidth;
      pillEl.classList.remove('no-anim');
    }
  };

  const clearScrubClasses = () => {
    navEl.classList.remove('scrubbing');
    pillEl.classList.remove('scrubbing');
    buttons.forEach((b) => b.classList.remove('scrub-target'));
  };

  const setHoveredTarget = (idx: number) => {
    hoveredIndex = idx;
    buttons.forEach((b, i) => b.classList.toggle('scrub-target', i === idx));
  };

  const beginTouch = (clientX: number) => {
    startX = clientX;
    isScrubbing = false;
    const { innerLeft, innerWidth } = getTrackMetrics();
    hoveredIndex = computeTabIndexFromX(clientX, innerLeft, innerWidth, tabCount);
  };

  const moveTouch = (clientX: number, clientY: number) => {
    const { rect, padLeft, innerLeft, innerWidth, slotWidth } = getTrackMetrics();
    if (!isScrubbing && Math.abs(clientX - startX) >= 8) {
      isScrubbing = true;
      navEl.classList.add('scrubbing');
      pillEl.classList.add('scrubbing');
      if (activePointerId !== null && typeof navEl.setPointerCapture === 'function') {
        try {
          navEl.setPointerCapture(activePointerId);
        } catch {
          // Ignore if capture is unsupported
        }
      }
    }
    if (!isScrubbing) return;

    if (isScrubCancelled(clientY, rect.top)) {
      hoveredIndex = -1;
      buttons.forEach((b) => b.classList.remove('scrub-target'));
      snapPillToIndex(getActiveIndex(), false);
      return;
    }

    const offsetPx = computePillOffsetPx(clientX, innerLeft, innerWidth, tabCount);
    pillEl.style.width = `${Math.max(0, slotWidth - 6)}px`;
    pillEl.style.transform = `translate3d(${padLeft + offsetPx + 3}px, 0, 0)`;
    const idx = computeTabIndexFromX(clientX, innerLeft, innerWidth, tabCount);
    setHoveredTarget(idx);
  };

  const releaseCaptureIfHeld = (pointerId: number) => {
    if (
      typeof navEl.hasPointerCapture === 'function' &&
      typeof navEl.releasePointerCapture === 'function'
    ) {
      try {
        if (navEl.hasPointerCapture(pointerId)) {
          navEl.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore if already released
      }
    }
  };

  const endTouch = (cancelled = false) => {
    const didScrub = isScrubbing;
    const chosen = hoveredIndex;
    isScrubbing = false;
    hoveredIndex = -1;
    clearScrubClasses();

    if (didScrub) {
      suppressNextClick = true;
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 60);

      if (!cancelled && chosen >= 0 && chosen < tabCount) {
        onSelectIndex(chosen);
        snapPillToIndex(chosen, false);
      } else {
        snapPillToIndex(getActiveIndex(), false);
      }
    }
  };

  // Prefer Pointer Events (unified across iOS 13+ Safari, Android Chrome, and Desktop).
  // IMPORTANT: Do NOT call setPointerCapture on pointerdown — capturing on pointerdown
  // retargets desktop click events from child <button class="nav-btn"> to navEl, breaking normal clicks.
  navEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    activePointerId = e.pointerId;
    beginTouch(e.clientX);
  });

  window.addEventListener('pointermove', (e) => {
    if (activePointerId !== e.pointerId) return;
    moveTouch(e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', (e) => {
    if (activePointerId !== e.pointerId) return;
    const pid = activePointerId;
    activePointerId = null;
    releaseCaptureIfHeld(pid);
    endTouch(false);
  });

  window.addEventListener('pointercancel', (e) => {
    if (activePointerId !== e.pointerId) return;
    const pid = activePointerId;
    activePointerId = null;
    releaseCaptureIfHeld(pid);
    endTouch(true);
  });

  // Suppress synthetic click immediately following a scrub gesture
  navEl.addEventListener(
    'click',
    (e) => {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  window.addEventListener('resize', () => snapPillToIndex(getActiveIndex(), true));
  requestAnimationFrame(() => snapPillToIndex(getActiveIndex(), true));

  return {
    syncPill: (instant = false) => snapPillToIndex(getActiveIndex(), instant),
  };
}
