/**
 * Safe arithmetic expression parser & evaluator for the floating mini calculator.
 * Supports +, -, *, /, unary +/-, parentheses (), postfix %, and decimals.
 * Never uses eval() or Function().
 */

export interface CalcEvalResult {
  ok: boolean;
  value: number | null;
  error?: string;
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'percent' };

export function normalizeExpressionText(raw: string): string {
  return String(raw || '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/，/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '');
}

export function roundCalcResult(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  // Eliminate IEEE-754 noise such as 0.1 + 0.2 = 0.30000000000000004
  const rounded = Math.round((n + Number.EPSILON) * 1e8) / 1e8;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatCalcRawNumber(n: number): string {
  const clean = roundCalcResult(n);
  if (!Number.isFinite(clean)) return '';
  // Cap at 6 decimal places for financial inputs, trimming trailing zeros
  const fixed = Math.round(clean * 1e6) / 1e6;
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

export function formatCalcDisplayNumber(n: number): string {
  const clean = roundCalcResult(n);
  if (!Number.isFinite(clean)) return '錯誤';
  return clean.toLocaleString('zh-TW', { maximumFractionDigits: 6 });
}

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let numStr = '';
      let dotCount = 0;
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
        if (expr[i] === '.') {
          dotCount += 1;
          if (dotCount > 1) return null;
        }
        numStr += expr[i];
        i += 1;
      }
      if (numStr === '.') return null;
      const val = Number(numStr);
      if (!Number.isFinite(val)) return null;
      tokens.push({ type: 'num', value: val });
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === '%') {
      tokens.push({ type: 'percent' });
      i += 1;
      continue;
    }
    return null;
  }

  // Insert implicit multiplication: e.g. 2(3+4), (2+3)(4+5), 50%(100), (2+3)4
  const expanded: Token[] = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const cur = tokens[idx];
    const prev = expanded[expanded.length - 1];
    if (prev) {
      const prevEndsValue = prev.type === 'num' || prev.type === 'rparen' || prev.type === 'percent';
      const curStartsValue = cur.type === 'lparen' || cur.type === 'num';
      if (prevEndsValue && curStartsValue && !(prev.type === 'num' && cur.type === 'num')) {
        expanded.push({ type: 'op', value: '*' });
      }
    }
    expanded.push(cur);
  }

  return expanded;
}

export function evaluateCalcExpression(raw: string): CalcEvalResult {
  const expr = normalizeExpressionText(raw);
  if (!expr) {
    return { ok: true, value: null };
  }

  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) {
    return { ok: false, value: null, error: '算式格式錯誤' };
  }

  let pos = 0;
  let divZero = false;

  const peek = (): Token | undefined => tokens[pos];
  const consume = (): Token => tokens[pos++];

  const parseExpression = (): number => {
    let left = parseTerm();
    while (true) {
      const tok = peek();
      if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        consume();
        const right = parseTerm();
        left = tok.value === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseTerm = (): number => {
    let left = parseUnary();
    while (true) {
      const tok = peek();
      if (tok && tok.type === 'op' && (tok.value === '*' || tok.value === '/')) {
        consume();
        const right = parseUnary();
        if (tok.value === '*') {
          left = left * right;
        } else {
          if (right === 0) {
            divZero = true;
            return NaN;
          }
          left = left / right;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseUnary = (): number => {
    const tok = peek();
    if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      consume();
      const val = parseUnary();
      return tok.value === '-' ? -val : val;
    }
    return parsePostfix();
  };

  const parsePostfix = (): number => {
    let val = parsePrimary();
    while (true) {
      const tok = peek();
      if (tok && tok.type === 'percent') {
        consume();
        val = val / 100;
      } else {
        break;
      }
    }
    return val;
  };

  const parsePrimary = (): number => {
    const tok = peek();
    if (!tok) return NaN;
    if (tok.type === 'num') {
      consume();
      return tok.value;
    }
    if (tok.type === 'lparen') {
      consume();
      const val = parseExpression();
      const closing = peek();
      if (!closing || closing.type !== 'rparen') {
        return NaN;
      }
      consume();
      return val;
    }
    return NaN;
  };

  const rawResult = parseExpression();
  if (divZero) {
    return { ok: false, value: null, error: '無法除以 0' };
  }
  if (pos !== tokens.length || !Number.isFinite(rawResult)) {
    return { ok: false, value: null, error: '算式不完整' };
  }

  return { ok: true, value: roundCalcResult(rawResult) };
}

/**
 * Computes a graceful live preview while the user is still typing
 * (auto-closes unbalanced parentheses and trims trailing binary operators).
 */
export function previewCalcExpression(raw: string): CalcEvalResult {
  const direct = evaluateCalcExpression(raw);
  if (direct.ok || direct.error === '無法除以 0') return direct;

  let trimmed = normalizeExpressionText(raw);
  // Strip trailing operators or dots while typing
  while (trimmed.length > 0 && /[+\-*/.(]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  if (!trimmed) return { ok: true, value: null };

  // Auto-close any unclosed '(' for preview
  let openCount = 0;
  for (const ch of trimmed) {
    if (ch === '(') openCount += 1;
    else if (ch === ')') openCount = Math.max(0, openCount - 1);
  }
  if (openCount > 0) {
    trimmed += ')'.repeat(openCount);
  }

  const fallback = evaluateCalcExpression(trimmed);
  return fallback.ok ? fallback : { ok: true, value: null };
}

/**
 * Decides whether pressing the smart "( )" key should append '(' or ')'.
 */
export function pickSmartParen(raw: string): '(' | ')' {
  const expr = normalizeExpressionText(raw);
  let openCount = 0;
  for (const ch of expr) {
    if (ch === '(') openCount += 1;
    else if (ch === ')') openCount = Math.max(0, openCount - 1);
  }
  if (openCount > 0 && /[\d)%]$/.test(expr)) {
    return ')';
  }
  return '(';
}
