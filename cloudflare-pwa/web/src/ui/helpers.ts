import { formatPercent, roundTo } from '../../../shared/format';
export const EYE_OPEN_SVG =
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
export const EYE_OFF_SVG =
  '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>';
export const TRASH_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

/**
 * H4: Escape text before it is placed into an HTML string. Prefer textContent; use this only where a
 * template string is unavoidable. User / server strings must never go into innerHTML unescaped.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function el<T = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element #${id}`);
  return node as unknown as T;
}

export function isDesktopDevice(): boolean {
  return Boolean(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
}

let toastTimer: number | undefined;
let lastToast: { text: string; at: number } | null = null;

export function showToast(msg: string, variant?: 'success' | 'error'): void {
  const node = el('toast');
  // v1.8.15: the same error reported twice (engine onError + the caller's catch) is shown once
  const now = Date.now();
  // only errors are de-duplicated (two identical successful saves must both be confirmed)
  if (variant === 'error' && lastToast && now - lastToast.at < 1500 && msg && lastToast.text.includes(msg)) return;
  lastToast = { text: msg, at: now };
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.textContent = msg;
  node.className = 'toast show' + (variant ? ' ' + variant : '');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 3000);
}

export function setLoading(on: boolean): void {
  el('loadingBar').classList.toggle('active', on);
}

export function fmtNum(n: number): string {
  return roundTo(Number(n || 0), 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 }); // never "-0"
}

export function fmtMoney(n: number, masked: boolean, prefix = 'NT$ '): string {
  if (masked) return prefix + '•••••';
  // v1.8.15: the sign follows the value as displayed (whole dollars) — never "-NT$ 0"
  const num = roundTo(Number(n || 0), 0);
  return (num < 0 ? '-' : '') + prefix + fmtNum(Math.abs(num));
}

/** v1.8.15: percentage for display — never "-0.0%" */
export function fmtPct(n: number, decimals = 1, signed = false): string {
  return formatPercent(n, decimals, signed);
}

export function fmtRaw(n: number, curr: string, masked: boolean): string {
  if (masked) return curr + ' •••';
  return (curr === 'USD' ? 'US$' : 'NT$ ') + roundTo(Number(n || 0), 2).toLocaleString('zh-TW', { maximumFractionDigits: 2 }); // never "-0"
}

/* v1.8.15 accessibility: Esc closes the modal, focus moves into it (and stays inside on Tab) and returns to
   where it was when the modal closes. */
let modalReturnFocus: HTMLElement | null = null;
let modalKeysBound = false;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function bindModalKeys(): void {
  if (modalKeysBound) return;
  modalKeysBound = true;
  document.addEventListener('keydown', (e) => {
    const backdrop = document.getElementById('modalBackdrop');
    if (!backdrop?.classList.contains('open')) return;
    // review (v1.8.15): the floating calculator / lock screen above the modal own the keyboard, and an Esc that
    // cancels an IME composition (Chinese input) must not close the form
    if (e.isComposing || e.keyCode === 229) return;
    if (document.getElementById('calcBackdrop')?.classList.contains('open')) return;
    if (document.getElementById('lockScreen')?.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key === 'Tab') {
      const sheet = document.getElementById('modalSheet') || backdrop;
      const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!sheet.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

export function openModal(title: string): HTMLElement {
  bindModalKeys();
  const backdrop = el('modalBackdrop');
  if (!backdrop.classList.contains('open')) {
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  el('modalTitle').textContent = title;
  el('modalSheet').setAttribute('aria-labelledby', 'modalTitle');
  const body = el('modalBody');
  body.innerHTML = '';
  backdrop.classList.add('open');
  // the caller fills the body synchronously; focus its first control afterwards
  window.setTimeout(() => {
    if (!backdrop.classList.contains('open')) return;
    // review (v1.8.15): on touch devices focusing an input pops the keyboard over the form — focus the sheet
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      const sheet = document.getElementById('modalSheet');
      if (sheet) {
        sheet.setAttribute('tabindex', '-1');
        sheet.focus();
      }
      return;
    }
    const target =
      body.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select, textarea') ||
      body.querySelector<HTMLElement>(FOCUSABLE) ||
      document.getElementById('closeModalBtn');
    target?.focus();
  }, 0);
  return body;
}

export function closeModal(): void {
  el('modalBackdrop').classList.remove('open');
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if (back && document.contains(back)) back.focus();
}

export function makeInputField(
  label: string,
  id: string,
  type: string,
  value: string | number | undefined,
  placeholder = '',
  required = false
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.className = 'section-label';
  lbl.htmlFor = id;
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.id = id;
  inp.type = type;
  if (type === 'number') {
    inp.step = 'any';
    inp.inputMode = 'decimal';
    inp.className = 'tnum';
  }
  inp.value = value !== undefined && value !== null ? String(value) : '';
  if (placeholder) inp.placeholder = placeholder;
  if (required) inp.required = true;
  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  return wrap;
}

export function makeSelectField(
  label: string,
  id: string,
  options: string[],
  selectedValue: string
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.className = 'section-label';
  lbl.htmlFor = id;
  lbl.textContent = label;
  const sel = document.createElement('select');
  sel.id = id;
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === selectedValue) o.selected = true;
    sel.appendChild(o);
  }
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // v1.8.15: iOS Safari reads the blob after click() returns — revoking immediately can produce an empty file
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * v1.8.15: submit handler that cannot run twice at once — a double tap (iOS) or a second Enter while the first
 * save is still running is ignored, and the form's submit buttons are disabled until the handler settles.
 */
export function bindSubmit(form: HTMLElement, handler: (e: SubmitEvent) => unknown): void {
  form.addEventListener('submit', async (e) => {
    if (form.dataset.submitting === '1') {
      e.preventDefault();
      return;
    }
    form.dataset.submitting = '1';
    const buttons = Array.from(
      form.querySelectorAll<HTMLButtonElement>('button[type="submit"], button:not([type])')
    ).filter((b) => !b.disabled);
    for (const b of buttons) b.disabled = true;
    try {
      await handler(e as SubmitEvent);
    } finally {
      delete form.dataset.submitting;
      for (const b of buttons) b.disabled = false;
    }
  });
}
