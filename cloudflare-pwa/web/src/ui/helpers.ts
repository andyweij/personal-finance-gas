export const EYE_OPEN_SVG =
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
export const EYE_OFF_SVG =
  '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>';
export const TRASH_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

export function el<T = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element #${id}`);
  return node as unknown as T;
}

export function isDesktopDevice(): boolean {
  return Boolean(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
}

let toastTimer: number | undefined;
export function showToast(msg: string, variant?: 'success' | 'error'): void {
  const node = el('toast');
  node.textContent = msg;
  node.className = 'toast show' + (variant ? ' ' + variant : '');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 3000);
}

export function setLoading(on: boolean): void {
  el('loadingBar').classList.toggle('active', on);
}

export function fmtNum(n: number): string {
  return Number(n || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

export function fmtMoney(n: number, masked: boolean, prefix = 'NT$ '): string {
  if (masked) return prefix + '•••••';
  const num = Number(n || 0);
  return (num < 0 ? '-' : '') + prefix + fmtNum(Math.abs(num));
}

export function fmtRaw(n: number, curr: string, masked: boolean): string {
  if (masked) return curr + ' •••';
  return (curr === 'USD' ? 'US$' : 'NT$ ') + Number(n || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}

export function openModal(title: string): HTMLElement {
  el('modalTitle').textContent = title;
  const body = el('modalBody');
  body.innerHTML = '';
  el('modalBackdrop').classList.add('open');
  return body;
}

export function closeModal(): void {
  el('modalBackdrop').classList.remove('open');
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
  URL.revokeObjectURL(url);
}
