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

export interface RenderReorderListOptions {
  container: HTMLElement;
  section: ReorderSectionKey;
  items: ReorderDisplayItem[];
  onSave: (orderedIds: string[]) => Promise<number>;
  onReRender: () => void;
  wrapInCard?: boolean;
}

const GRIP_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="19" y2="17"/></svg>';

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
  hintEl.textContent = '拖曳右側 ≡ 或點 ▲▼ 調整，完成後按「儲存排序」';
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
    handle.title = '按住上下拖曳排序';
    handle.ariaLabel = `拖曳 ${item.title} 調整順序`;
    handle.innerHTML = GRIP_SVG;

    let dragging = false;
    let activePointerId = -1;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      dragging = true;
      activePointerId = e.pointerId;
      row.classList.add('dragging');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failures in non-browser test envs
      }
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== activePointerId) return;
      e.preventDefault();
      const pointerY = e.clientY;
      const siblings = Array.from(listWrap.querySelectorAll<HTMLElement>('.reorder-row')).filter(
        (el) => el !== row
      );
      for (const sib of siblings) {
        const rect = sib.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const sibIdx = Array.from(listWrap.children).indexOf(sib);
        const curIdx = Array.from(listWrap.children).indexOf(row);
        if (pointerY < midY && curIdx > sibIdx) {
          listWrap.insertBefore(row, sib);
          refreshRowDecorations();
          break;
        }
        if (pointerY > midY && curIdx < sibIdx) {
          listWrap.insertBefore(row, sib.nextSibling);
          refreshRowDecorations();
          break;
        }
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = -1;
      row.classList.remove('dragging');
      try {
        if (handle.hasPointerCapture(e.pointerId)) {
          handle.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }
      refreshRowDecorations();
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

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
