import {
  evaluateCalcExpression,
  formatCalcDisplayNumber,
  formatCalcRawNumber,
  pickSmartParen,
  previewCalcExpression,
} from '../../../shared/calculator';
import { el, showToast } from './helpers';

interface CalcHistoryEntry {
  expr: string;
  rawValue: string;
  displayValue: string;
}

const FAB_POS_STORAGE_KEY = 'finance_calc_fab_pos';

function isEligibleNumericInput(node: EventTarget | null): node is HTMLInputElement {
  if (!(node instanceof HTMLInputElement)) return false;
  if (node.disabled || node.readOnly) return false;
  if (node.closest('#calcBackdrop') || node.closest('#lockScreen') || node.closest('#authScreen')) {
    return false;
  }
  return node.type === 'number' || node.inputMode === 'decimal' || node.inputMode === 'numeric';
}

function getInputLabel(inp: HTMLInputElement): string {
  let raw = '';
  if (inp.id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(inp.id)}"]`);
    if (lbl?.textContent) raw = lbl.textContent.trim();
  }
  if (!raw && inp.getAttribute('aria-label')) {
    raw = inp.getAttribute('aria-label')!.trim();
  }
  if (!raw && inp.placeholder) {
    raw = inp.placeholder.trim();
  }
  // Remove long parenthetical descriptions like "（此日之前的...）"
  const cleaned = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (!cleaned) return '數值欄位';
  return cleaned.length > 14 ? cleaned.slice(0, 14) + '…' : cleaned;
}

function isInputCurrentlyUsable(inp: HTMLInputElement | null): inp is HTMLInputElement {
  if (!inp || !inp.isConnected || inp.disabled || inp.readOnly) return false;
  // Must be visible in layout
  if (inp.offsetParent === null) return false;
  // If a modal is open, only target inputs inside that modal so we never overwrite background fields
  const modalOpen = document.getElementById('modalBackdrop')?.classList.contains('open');
  if (modalOpen && !inp.closest('#modalBackdrop')) return false;
  return true;
}

function formatExprForDisplay(expr: string): string {
  return expr.replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−');
}

export function initFloatingCalculator(): void {
  const fab = el<HTMLButtonElement>('calcFabBtn');
  const backdrop = el<HTMLDivElement>('calcBackdrop');
  const closeBtn = el<HTMLButtonElement>('calcCloseBtn');
  const targetBadge = el<HTMLSpanElement>('calcTargetBadge');
  const loadCurrentBtn = el<HTMLButtonElement>('calcLoadCurrentBtn');
  const exprEl = el<HTMLDivElement>('calcExprDisplay');
  const resultEl = el<HTMLDivElement>('calcResultDisplay');
  const historyEl = el<HTMLDivElement>('calcHistoryRow');
  const keypad = el<HTMLDivElement>('calcKeypad');
  const copyBtn = el<HTMLButtonElement>('calcCopyBtn');
  const applyBtn = el<HTMLButtonElement>('calcApplyBtn');

  let lastTargetInput: HTMLInputElement | null = null;
  let expression = '';
  let justEvaluated = false;
  let history: CalcHistoryEntry[] = [];

  // Track the most recently focused numeric input anywhere in the app
  document.addEventListener(
    'focusin',
    (e) => {
      if (isEligibleNumericInput(e.target)) {
        lastTargetInput = e.target;
      }
    },
    true
  );

  const getActiveTarget = (): HTMLInputElement | null => {
    if (isInputCurrentlyUsable(lastTargetInput)) return lastTargetInput;
    // Convenient fallback on Tab 1 quick entry when no modal is open
    const modalOpen = document.getElementById('modalBackdrop')?.classList.contains('open');
    const logTabActive = document.getElementById('tab-log')?.classList.contains('active');
    if (!modalOpen && logTabActive) {
      const amountInput = document.getElementById('amountInput') as HTMLInputElement | null;
      if (isInputCurrentlyUsable(amountInput)) return amountInput;
    }
    return null;
  };

  const renderDisplay = () => {
    exprEl.textContent = expression ? formatExprForDisplay(expression) : '0';
    exprEl.scrollLeft = exprEl.scrollWidth;

    const target = getActiveTarget();
    if (target) {
      const lbl = getInputLabel(target);
      targetBadge.textContent = `目標：${lbl}`;
      targetBadge.classList.add('has-target');
      applyBtn.textContent = `帶入「${lbl}」`;

      const curNum = parseFloat(target.value);
      if (!expression && !Number.isNaN(curNum) && target.value.trim() !== '') {
        loadCurrentBtn.style.display = 'inline-flex';
        loadCurrentBtn.textContent = `載入原值 (${formatCalcDisplayNumber(curNum)})`;
      } else {
        loadCurrentBtn.style.display = 'none';
      }
    } else {
      targetBadge.textContent = '獨立試算模式';
      targetBadge.classList.remove('has-target');
      applyBtn.textContent = '完成關閉';
      loadCurrentBtn.style.display = 'none';
    }

    if (!expression) {
      resultEl.textContent = '';
      resultEl.classList.remove('error');
    } else {
      const preview = previewCalcExpression(expression);
      if (!preview.ok && preview.error) {
        resultEl.textContent = preview.error;
        resultEl.classList.add('error');
      } else if (preview.value !== null) {
        resultEl.textContent = `= ${formatCalcDisplayNumber(preview.value)}`;
        resultEl.classList.remove('error');
      } else {
        resultEl.textContent = '';
        resultEl.classList.remove('error');
      }
    }

    // Render compact history chips (last 3)
    historyEl.innerHTML = '';
    if (history.length > 0) {
      historyEl.style.display = 'flex';
      for (const h of history) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'calc-hist-chip tnum';
        chip.title = '點選帶回此結果繼續計算';
        chip.textContent = `${formatExprForDisplay(h.expr)} = ${h.displayValue}`;
        chip.addEventListener('click', () => {
          if (!expression || justEvaluated) {
            expression = h.rawValue;
            justEvaluated = false;
          } else if (/[+\-*/(]$/.test(expression)) {
            expression += h.rawValue;
          } else {
            expression = h.rawValue;
          }
          renderDisplay();
        });
        historyEl.appendChild(chip);
      }
    } else {
      historyEl.style.display = 'none';
    }
  };

  const pushHistory = (expr: string, val: number) => {
    const rawValue = formatCalcRawNumber(val);
    const displayValue = formatCalcDisplayNumber(val);
    // Only record meaningful expressions (containing an operator or %)
    if (!/[+\-*/%]/.test(expr)) return;
    history = [
      { expr, rawValue, displayValue },
      ...history.filter((h) => h.expr !== expr),
    ].slice(0, 3);
  };

  const appendDigitOrDot = (ch: string) => {
    if (justEvaluated) {
      expression = ch === '.' ? '0.' : ch;
      justEvaluated = false;
      renderDisplay();
      return;
    }
    if (ch === '.') {
      // Find current numeric segment after the last operator/paren
      const seg = expression.split(/[+\-*/()%]/).pop() || '';
      if (seg.includes('.')) return;
      if (!seg) {
        expression += '0.';
      } else {
        expression += '.';
      }
      renderDisplay();
      return;
    }
    // Replace lonely leading 0 unless followed by dot
    if (expression === '0') {
      expression = ch;
    } else {
      expression += ch;
    }
    renderDisplay();
  };

  const appendOperator = (op: '+' | '-' | '*' | '/') => {
    justEvaluated = false;
    if (!expression) {
      if (op === '-') {
        expression = '-';
        renderDisplay();
      }
      return;
    }
    if (/[+\-*/]$/.test(expression)) {
      // Replace previous binary operator (unless it's lone leading '-')
      if (expression === '-') {
        if (op === '+') expression = '';
        renderDisplay();
        return;
      }
      expression = expression.slice(0, -1) + op;
    } else if (expression.endsWith('(')) {
      if (op === '-') expression += '-';
    } else {
      expression += op;
    }
    renderDisplay();
  };

  const handleAction = (key: string) => {
    if (key >= '0' && key <= '9') {
      appendDigitOrDot(key);
      return;
    }
    if (key === '.') {
      appendDigitOrDot('.');
      return;
    }
    if (key === '+' || key === '-' || key === '*' || key === '/') {
      appendOperator(key);
      return;
    }
    if (key === 'paren') {
      if (justEvaluated) {
        justEvaluated = false;
      }
      expression += pickSmartParen(expression);
      renderDisplay();
      return;
    }
    if (key === '(' || key === ')') {
      justEvaluated = false;
      expression += key;
      renderDisplay();
      return;
    }
    if (key === '%') {
      if (!expression || /[+\-*/(%]$/.test(expression)) return;
      justEvaluated = false;
      expression += '%';
      renderDisplay();
      return;
    }
    if (key === 'clear') {
      expression = '';
      justEvaluated = false;
      renderDisplay();
      return;
    }
    if (key === 'back') {
      if (justEvaluated) {
        expression = '';
        justEvaluated = false;
      } else {
        expression = expression.slice(0, -1);
      }
      renderDisplay();
      return;
    }
    if (key === 'eval') {
      if (!expression) return;
      const res = evaluateCalcExpression(expression);
      if (!res.ok) {
        showToast(res.error || '算式無法計算', 'error');
        return;
      }
      if (res.value !== null) {
        pushHistory(expression, res.value);
        expression = formatCalcRawNumber(res.value);
        justEvaluated = true;
        renderDisplay();
      }
    }
  };

  const resolveCurrentNumber = (): number | null => {
    if (!expression) return null;
    const exact = evaluateCalcExpression(expression);
    if (exact.ok && exact.value !== null) return exact.value;
    if (!exact.ok && exact.error === '無法除以 0') {
      showToast('無法除以 0', 'error');
      return null;
    }
    const prev = previewCalcExpression(expression);
    if (prev.ok && prev.value !== null) return prev.value;
    showToast('請先輸入有效的算式或數字', 'error');
    return null;
  };

  const openCalculator = () => {
    backdrop.classList.add('open');
    fab.classList.add('is-open');
    fab.setAttribute('aria-expanded', 'true');
    renderDisplay();
  };

  const closeCalculator = (restoreFocus = false) => {
    backdrop.classList.remove('open');
    fab.classList.remove('is-open');
    fab.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      const target = getActiveTarget();
      if (target) {
        try {
          target.focus();
        } catch {
          // ignore focus errors on mobile Safari
        }
      }
    }
  };

  // Load current field's existing value into calculator
  loadCurrentBtn.addEventListener('click', () => {
    const target = getActiveTarget();
    if (!target) return;
    const val = parseFloat(target.value);
    if (!Number.isNaN(val)) {
      expression = formatCalcRawNumber(val);
      justEvaluated = false;
      renderDisplay();
    }
  });

  // Keypad clicks
  keypad.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-calc-key]');
    if (!btn?.dataset.calcKey) return;
    handleAction(btn.dataset.calcKey);
  });

  // Copy result to clipboard
  copyBtn.addEventListener('click', async () => {
    const val = resolveCurrentNumber();
    if (val === null) {
      showToast('目前沒有可複製的計算結果', 'error');
      return;
    }
    const raw = formatCalcRawNumber(val);
    try {
      await navigator.clipboard.writeText(raw);
      showToast(`已複製結果：${formatCalcDisplayNumber(val)}`, 'success');
    } catch {
      showToast(`結果為 ${raw}（瀏覽器不支援自動複製）`);
    }
  });

  // Insert result into the last focused numeric input & close
  const applyAndClose = () => {
    const target = getActiveTarget();
    if (!target) {
      if (expression) {
        const res = evaluateCalcExpression(expression);
        if (res.ok && res.value !== null) {
          pushHistory(expression, res.value);
          expression = formatCalcRawNumber(res.value);
          justEvaluated = true;
        }
      }
      closeCalculator(false);
      return;
    }

    const val = resolveCurrentNumber();
    if (val === null) return;

    pushHistory(expression, val);
    const rawStr = formatCalcRawNumber(val);
    const lbl = getInputLabel(target);

    target.value = rawStr;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));

    expression = rawStr;
    justEvaluated = true;
    closeCalculator(true);
    showToast(`已帶入「${lbl}」：${formatCalcDisplayNumber(val)}`, 'success');
  };

  applyBtn.addEventListener('click', applyAndClose);
  closeBtn.addEventListener('click', () => closeCalculator(true));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeCalculator(true);
    }
  });

  // Desktop keyboard support while calculator is open
  window.addEventListener('keydown', (e) => {
    if (!backdrop.classList.contains('open')) return;
    if (document.getElementById('lockScreen')?.classList.contains('open')) return;
    if (e.altKey) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCalculator(true);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      applyAndClose();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;

    if ((e.key >= '0' && e.key <= '9') || e.key === '.' || e.key === '+' || e.key === '-' || e.key === '*' || e.key === '/' || e.key === '(' || e.key === ')' || e.key === '%') {
      e.preventDefault();
      e.stopPropagation();
      handleAction(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      handleAction('back');
    } else if (e.key === 'Delete' || e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      e.stopPropagation();
      handleAction('clear');
    } else if (e.key === 'Enter' || e.key === '=') {
      e.preventDefault();
      e.stopPropagation();
      handleAction('eval');
    }
  });

  // ==================== Draggable Floating Button ====================
  const applySavedFabPosition = () => {
    try {
      const saved = localStorage.getItem(FAB_POS_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { right?: number; bottom?: number };
      if (typeof parsed.right === 'number' && typeof parsed.bottom === 'number') {
        const maxRight = Math.max(12, window.innerWidth - 64);
        const maxBottom = Math.max(80, window.innerHeight - 120);
        const clampedRight = Math.min(Math.max(12, parsed.right), maxRight);
        const clampedBottom = Math.min(Math.max(76, parsed.bottom), maxBottom);
        fab.style.right = `${clampedRight}px`;
        fab.style.bottom = `${clampedBottom}px`;
      }
    } catch {
      // ignore invalid storage
    }
  };
  applySavedFabPosition();
  window.addEventListener('resize', applySavedFabPosition);

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startRight = 16;
  let startBottom = 86;

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    startRight = Math.max(12, window.innerWidth - rect.right);
    startBottom = Math.max(76, window.innerHeight - rect.bottom);
    try {
      fab.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  });

  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) >= 6) {
      moved = true;
      fab.classList.add('dragging');
    }
    if (!moved) return;
    const maxRight = Math.max(12, window.innerWidth - 64);
    const maxBottom = Math.max(80, window.innerHeight - 120);
    const nextRight = Math.min(Math.max(12, startRight - dx), maxRight);
    const nextBottom = Math.min(Math.max(76, startBottom - dy), maxBottom);
    fab.style.right = `${Math.round(nextRight)}px`;
    fab.style.bottom = `${Math.round(nextBottom)}px`;
  });

  const finishPointer = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove('dragging');
    try {
      fab.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (moved) {
      const rect = fab.getBoundingClientRect();
      try {
        localStorage.setItem(
          FAB_POS_STORAGE_KEY,
          JSON.stringify({
            right: Math.round(window.innerWidth - rect.right),
            bottom: Math.round(window.innerHeight - rect.bottom),
          })
        );
      } catch {
        // ignore
      }
      return;
    }
    // Short tap toggles calculator without disturbing current page/modal
    if (backdrop.classList.contains('open')) {
      closeCalculator(true);
    } else {
      openCalculator();
    }
  };

  fab.addEventListener('pointerup', finishPointer);
  fab.addEventListener('pointercancel', finishPointer);
}
