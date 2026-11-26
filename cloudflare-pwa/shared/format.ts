/**
 * v1.8.15 (low-priority group): one decimal rounding helper and sign-safe display formatting.
 *
 * `roundTo` rounds half away from zero on the DECIMAL value (1.005 → 1.01, 2.675 → 2.68), unlike
 * `Math.round(n * 100) / 100`, which works on the binary approximation (1.005 → 1).
 */
export function roundTo(n: number, decimals = 2): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const d = Math.max(0, Math.min(10, Math.floor(decimals)));
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  // Shift via the decimal string representation so no binary error leaks into the rounding decision
  const text = String(abs);
  const out = text.includes('e')
    ? sign * (Math.round(abs * 10 ** d) / 10 ** d) // already exponent notation (tiny / huge): plain math is exact enough
    : sign * Number(`${Math.round(Number(`${text}e${d}`))}e-${d}`);
  return Object.is(out, -0) || out === 0 ? 0 : out;
}

/** -1 / 0 / 1 of the value as it will be DISPLAYED with `decimals` decimals (so -0.004 → 0, never "-0.00"). */
export function displaySign(n: number, decimals = 0): -1 | 0 | 1 {
  const r = roundTo(n, decimals);
  return r > 0 ? 1 : r < 0 ? -1 : 0;
}

/** "12.3%" — never "-0.0%". `signed` adds "+" to positive values. */
export function formatPercent(n: number, decimals = 1, signed = false): string {
  const r = roundTo(Number(n) || 0, decimals);
  const sign = r > 0 && signed ? '+' : '';
  return `${sign}${r.toFixed(decimals)}%`;
}

/** CSV cell escaping with formula-injection protection (OWASP): text starting with = + - @ TAB CR gets a "'". */
export function escapeCsvCell(val: unknown): string {
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '';
  let str = val === null || val === undefined ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}
