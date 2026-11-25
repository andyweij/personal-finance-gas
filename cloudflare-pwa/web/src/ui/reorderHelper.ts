import { showToast } from './helpers';
import type { ReorderSectionKey, UiContext } from './state';

export interface ReorderDisplayItem {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  valueText?: string;
}

export function startReorder(
  ctx: UiContext,
  section: ReorderSectionKey,
  currentIds: string[]
): void {
  ctx.state.reorderSection = section;
  ctx.state.reorderDraftIds = currentIds.slice();
  ctx.renderAll();
}

export function cancelReorder(ctx: UiContext, silent = false): void {
  if (!ctx.state.reorderSection) return;
  ctx.state.reorderSection = null;
  ctx.state.reorderDraftIds = [];
  if (!silent) {
    ctx.renderAll();
  }
}

function syncDraftWithAvailable(draftIds: string[], items: ReorderDisplayItem[]): string[] {
  const validSet = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of draftIds) {
    if (validSet.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      next.push(item.id);
    }
  }
  return next;
}

/**
 * Given the dragged card's vertical center and sorted vertical midpoints of all
 * non-dragged sibling rows, returns the exact insertion index (0..siblingMidpoints.length).
 * Allows jumping across multiple slots smoothly in a single pointer/touch move.
 */
export function computeDropTargetIndex(
  dragCenterY: number,
  siblingMidpoints: number[]
): number {
  for (let i = 0; i < siblingMidpoints.length; i++) {
    if (dragCenterY < siblingMidpoints[i]) {
      return i;
    }
  }
  return siblingMidpoints.length;
}

export interface RenderReorderListOptions {
  container: HTMLElement;
  section: ReorderSectionKey;
  items: ReorderDisplayItem[];
  onSave: (orderedIds: string[]) => Promise<number>;
  onReRender: () => void;
  wrapInCard?: boolean;
}

const GRIP_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';

interface ActiveDragState {
  row: HTMLElement;
  placeholder: HTMLDivElement;
  pointerId: number;
  startClientY: number;
  originTop: number;
  rowHeight: number;
  lastClientY: number;
  rafId: number | null;
}

export function renderReorderList(ctx: UiContext, opts: RenderReorderListOptions): void {
  const { container, items, onSave, onReRender } = opts;
  ctx.state.reorderDraftIds = syncDraftWithAvailable(ctx.state.reorderDraftIds, items);
  const byId = new Map(items.map((i) => [i.id, i]));

  container.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'reorder-toolbar';

  const info = document.createElement('div');
  info.className = 'reorder-toolbar-text';
  const titleEl = document.createElement('div');
  titleEl.className = 'reorder-toolbar-title';
  titleEl.textContent = `編輯排序（共 ${ctx.state.reorderDraftIds.length} 項）`;
  const hintEl = document.createElement('div');
  hintEl.className = 'muted';
  hintEl.style.fontSize = '11px';
  hintEl.textContent = '按住右側 ≡（或長按項目）直接上下拖曳，完成後點「儲存排序」';
  info.appendChild(titleEl);
  info.appendChild(hintEl);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'reorder-toolbar-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline btn-sm';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => cancelReorder(ctx));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = '儲存排序';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const orderedIds = ctx.state.reorderDraftIds.slice();
      const changed = await onSave(orderedIds);
      ctx.state.reorderSection = null;
      ctx.state.reorderDraftIds = [];
      ctx.renderAll();
      if (changed > 0) {
        showToast('已儲存自訂排序', 'success');
        ctx.scheduleSync();
      } else {
        showToast('順序未變更');
      }
    } catch (err) {
      saveBtn.disabled = false;
      showToast(err instanceof Error ? err.message : '儲存排序失敗', 'error');
    }
  });

  btnGroup.appendChild(cancelBtn);
  btnGroup.appendChild(saveBtn);
  toolbar.appendChild(info);
  toolbar.appendChild(btnGroup);
  container.appendChild(toolbar);

  const listWrap = document.createElement('div');
  listWrap.className = opts.wrapInCard ? 'list-group reorder-list' : 'reorder-list';

  let activeDrag: ActiveDragState | null = null;

  const refreshRowDecorations = () => {
    const rows = Array.from(listWrap.querySelectorAll<HTMLElement>('.reorder-row'));
    const nextOrder: string[] = [];
    rows.forEach((row, idx) => {
      const id = row.dataset.reorderId || '';
      if (id) nextOrder.push(id);
      const numEl = row.querySelector<HTMLElement>('.reorder-rank');
      if (numEl) numEl.textContent = String(idx + 1);
      const upBtn = row.querySelector<HTMLButtonElement>('.reorder-up-btn');
      const downBtn = row.querySelector<HTMLButtonElement>('.reorder-down-btn');
      if (upBtn) upBtn.disabled = idx === 0;
      if (downBtn) downBtn.disabled = idx === rows.length - 1;
    });
    ctx.state.reorderDraftIds = nextOrder;
  };

  const refreshLiveRanksDuringDrag = (drag: ActiveDragState) => {
    let rankNum = 0;
    for (const child of Array.from(listWrap.children)) {
      if (child === drag.row) continue;
      rankNum += 1;
      if (child === drag.placeholder) {
        const dragRank = drag.row.querySelector<HTMLElement>('.reorder-rank');
        if (dragRank) dragRank.textContent = String(rankNum);
      } else {
        const numEl = child.querySelector<HTMLElement>('.reorder-rank');
        if (numEl) numEl.textContent = String(rankNum);
      }
    }
  };

  const updatePlaceholderPosition = (drag: ActiveDragState, clientY: number) => {
    const dy = clientY - drag.startClientY;
    drag.row.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.02)`;

    const dragCenterY = drag.originTop + dy + drag.rowHeight / 2;
    const siblings = Array.from(listWrap.children).filter(
      (el): el is HTMLElement =>
        el !== drag.row && el !== drag.placeholder && el.classList.contains('reorder-row')
    );
    const midpoints = siblings.map((sib) => {
      const r = sib.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const targetIdx = computeDropTargetIndex(dragCenterY, midpoints);
    const beforeNode = siblings[targetIdx] || null;

    if (beforeNode) {
      if (drag.placeholder.nextElementSibling !== beforeNode) {
        listWrap.insertBefore(drag.placeholder, beforeNode);
        refreshLiveRanksDuringDrag(drag);
      }
    } else if (listWrap.lastElementChild !== drag.placeholder) {
      listWrap.appendChild(drag.placeholder);
      refreshLiveRanksDuringDrag(drag);
    }
  };

  const onWindowPointerMove = (e: PointerEvent) => {
    if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
    e.preventDefault();
    activeDrag.lastClientY = e.clientY;
    updatePlaceholderPosition(activeDrag, e.clientY);
  };

  const onWindowTouchMove = (e: TouchEvent) => {
    if (!activeDrag) return;
    // Prevent iOS Safari / Android Chrome from hijacking touch drag as page scroll
    e.preventDefault();
    if (e.touches.length > 0) {
      activeDrag.lastClientY = e.touches[0].clientY;
      updatePlaceholderPosition(activeDrag, e.touches[0].clientY);
    }
  };

  const finishDrag = () => {
    if (!activeDrag) return;
    const drag = activeDrag;
    activeDrag = null;

    if (drag.rafId !== null) {
      window.cancelAnimationFrame(drag.rafId);
    }
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerEnd);
    window.removeEventListener('pointercancel', onWindowPointerEnd);
    window.removeEventListener('touchmove', onWindowTouchMove);
    window.removeEventListener('touchend', onWindowTouchEnd);
    window.removeEventListener('touchcancel', onWindowTouchEnd);
    window.removeEventListener('blur', finishDrag);
    document.body.classList.remove('is-reordering-drag');

    // Clear floating inline styles and place row cleanly at placeholder's exact slot
    drag.row.classList.remove('dragging', 'dragging-floating');
    drag.row.style.position = '';
    drag.row.style.left = '';
    drag.row.style.top = '';
    drag.row.style.width = '';
    drag.row.style.height = '';
    drag.row.style.zIndex = '';
    drag.row.style.margin = '';
    drag.row.style.pointerEvents = '';
    drag.row.style.transform = '';

    if (drag.placeholder.parentNode === listWrap) {
      listWrap.insertBefore(drag.row, drag.placeholder);
      drag.placeholder.remove();
    }
    refreshRowDecorations();
  };

  const onWindowPointerEnd = (e: PointerEvent) => {
    if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
    finishDrag();
  };

  const onWindowTouchEnd = () => {
    if (!activeDrag) return;
    finishDrag();
  };

  const runAutoScroll = () => {
    if (!activeDrag) return;
    const edgeThreshold = 76;
    const y = activeDrag.lastClientY;
    const vh = window.innerHeight;
    let scrollDelta = 0;
    if (y < edgeThreshold) {
      scrollDelta = -Math.ceil(((edgeThreshold - y) / edgeThreshold) * 14);
    } else if (y > vh - edgeThreshold) {
      scrollDelta = Math.ceil(((y - (vh - edgeThreshold)) / edgeThreshold) * 14);
    }
    if (scrollDelta !== 0) {
      window.scrollBy(0, scrollDelta);
      updatePlaceholderPosition(activeDrag, activeDrag.lastClientY);
    }
    activeDrag.rafId = window.requestAnimationFrame(runAutoScroll);
  };

  const beginDrag = (row: HTMLElement, clientY: number, pointerId: number) => {
    if (activeDrag) finishDrag();
    const rect = row.getBoundingClientRect();

    const placeholder = document.createElement('div');
    placeholder.className = 'reorder-placeholder';
    placeholder.style.height = `${rect.height}px`;
    listWrap.insertBefore(placeholder, row);

    // Float the dragged row in fixed viewport coordinates while moving only `placeholder` in DOM
    // (never detaches/re-inserts the active dragged node, preventing iOS Safari pointercancel!)
    row.classList.add('dragging', 'dragging-floating');
    row.style.position = 'fixed';
    row.style.left = `${rect.left}px`;
    row.style.top = `${rect.top}px`;
    row.style.width = `${rect.width}px`;
    row.style.height = `${rect.height}px`;
    row.style.zIndex = '999';
    row.style.margin = '0';
    row.style.pointerEvents = 'none';
    row.style.transform = 'translate3d(0, 0, 0) scale(1.02)';

    document.body.classList.add('is-reordering-drag');
    try {
      navigator.vibrate?.(12);
    } catch {
      // Ignore on unsupported devices
    }

    activeDrag = {
      row,
      placeholder,
      pointerId,
      startClientY: clientY,
      originTop: rect.top,
      rowHeight: rect.height,
      lastClientY: clientY,
      rafId: null,
    };

    window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
    window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
    window.addEventListener('touchend', onWindowTouchEnd);
    window.addEventListener('touchcancel', onWindowTouchEnd);
    window.addEventListener('blur', finishDrag);

    activeDrag.rafId = window.requestAnimationFrame(runAutoScroll);
  };

  const moveByDelta = (id: string, delta: number) => {
    const idx = ctx.state.reorderDraftIds.indexOf(id);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= ctx.state.reorderDraftIds.length) return;
    const next = ctx.state.reorderDraftIds.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    ctx.state.reorderDraftIds = next;
    onReRender();
  };

  ctx.state.reorderDraftIds.forEach((id, idx) => {
    const item = byId.get(id);
    if (!item) return;

    const row = document.createElement('div');
    row.className = 'reorder-row';
    row.dataset.reorderId = id;

    const rank = document.createElement('span');
    rank.className = 'reorder-rank tnum';
    rank.textContent = String(idx + 1);

    const main = document.createElement('div');
    main.className = 'item-main';
    const t = document.createElement('div');
    t.className = 'item-title';
    t.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    t.appendChild(document.createTextNode(item.title));
    if (item.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.marginRight = '0';
      badge.textContent = item.badge;
      t.appendChild(badge);
    }
    main.appendChild(t);

    if (item.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      sub.textContent = item.subtitle;
      main.appendChild(sub);
    }

    const controls = document.createElement('div');
    controls.className = 'reorder-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'icon-btn sm reorder-up-btn';
    upBtn.title = '上移一格';
    upBtn.ariaLabel = `將 ${item.title} 上移`;
    upBtn.textContent = '▲';
    upBtn.disabled = idx === 0;
    upBtn.addEventListener('click', () => moveByDelta(id, -1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'icon-btn sm reorder-down-btn';
    downBtn.title = '下移一格';
    downBtn.ariaLabel = `將 ${item.title} 下移`;
    downBtn.textContent = '▼';
    downBtn.disabled = idx === ctx.state.reorderDraftIds.length - 1;
    downBtn.addEventListener('click', () => moveByDelta(id, 1));

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'reorder-handle';
    handle.title = '按住直接上下拖曳排序';
    handle.ariaLabel = `拖曳 ${item.title} 調整順序`;
    handle.innerHTML = GRIP_SVG;

    // 1. Immediate drag from the ≡ grip handle (works cleanly on iOS/Android touch & mouse)
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      beginDrag(row, e.clientY, e.pointerId);
    });

    // 2. Also allow dragging from anywhere on the row (instant on mouse drag; 160ms long-press on touch so normal scroll still works)
    row.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('button')) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;

      if (e.pointerType === 'mouse') {
        const onMouseCheck = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          if (Math.abs(ev.clientY - startY) >= 5) {
            cleanupRowPreDrag();
            beginDrag(row, ev.clientY, pointerId);
          }
        };
        const cleanupRowPreDrag = () => {
          window.removeEventListener('pointermove', onMouseCheck);
          window.removeEventListener('pointerup', cleanupRowPreDrag);
          window.removeEventListener('pointercancel', cleanupRowPreDrag);
        };
        window.addEventListener('pointermove', onMouseCheck);
        window.addEventListener('pointerup', cleanupRowPreDrag);
        window.addEventListener('pointercancel', cleanupRowPreDrag);
        return;
      }

      // Touch / pen: 160ms press-and-hold picks up the card; swiping > 8px before 160ms cancels so scrolling stays natural
      let latestY = startY;
      const holdTimer = window.setTimeout(() => {
        cleanupTouchHold();
        beginDrag(row, latestY, pointerId);
      }, 160);

      const onTouchMoveCheck = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        latestY = ev.clientY;
        if (Math.abs(ev.clientY - startY) > 8 || Math.abs(ev.clientX - startX) > 8) {
          cleanupTouchHold();
        }
      };
      const cleanupTouchHold = () => {
        window.clearTimeout(holdTimer);
        window.removeEventListener('pointermove', onTouchMoveCheck);
        window.removeEventListener('pointerup', cleanupTouchHold);
        window.removeEventListener('pointercancel', cleanupTouchHold);
      };
      window.addEventListener('pointermove', onTouchMoveCheck);
      window.addEventListener('pointerup', cleanupTouchHold);
      window.addEventListener('pointercancel', cleanupTouchHold);
    });

    controls.appendChild(upBtn);
    controls.appendChild(downBtn);
    controls.appendChild(handle);

    row.appendChild(rank);
    row.appendChild(main);
    row.appendChild(controls);
    listWrap.appendChild(row);
  });

  container.appendChild(listWrap);
}
