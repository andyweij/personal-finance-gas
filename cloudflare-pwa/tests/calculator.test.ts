import { describe, expect, it } from 'vitest';
import {
  evaluateCalcExpression,
  formatCalcDisplayNumber,
  formatCalcRawNumber,
  pickSmartParen,
  previewCalcExpression,
} from '../shared/calculator';

describe('Floating Mini Calculator Expression Engine', () => {
  it('evaluates basic arithmetic with standard operator precedence and Unicode operators', () => {
    expect(evaluateCalcExpression('120+85+45')).toEqual({ ok: true, value: 250 });
    expect(evaluateCalcExpression('1000×62.5+20')).toEqual({ ok: true, value: 62520 });
    expect(evaluateCalcExpression('(1500+300)÷3')).toEqual({ ok: true, value: 600 });
    expect(evaluateCalcExpression('5000−1200×2')).toEqual({ ok: true, value: 2600 });
  });

  it('handles floating point precision, percentages, unary signs, and implicit multiplication', () => {
    expect(evaluateCalcExpression('0.1+0.2')).toEqual({ ok: true, value: 0.3 });
    expect(evaluateCalcExpression('1000*1.425%*0.28')).toEqual({ ok: true, value: 3.99 });
    expect(evaluateCalcExpression('2(150+50)')).toEqual({ ok: true, value: 400 });
    expect(evaluateCalcExpression('-50+200')).toEqual({ ok: true, value: 150 });
    expect(formatCalcRawNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatCalcDisplayNumber(62520.5)).toBe('62,520.5');
  });

  it('provides graceful live preview while user is mid-expression', () => {
    expect(previewCalcExpression('120+85+')).toEqual({ ok: true, value: 205 });
    expect(previewCalcExpression('(500+300')).toEqual({ ok: true, value: 800 });
    expect(previewCalcExpression('')).toEqual({ ok: true, value: null });
  });

  it('rejects division by zero and malformed expressions safely', () => {
    expect(evaluateCalcExpression('100/0')).toEqual({
      ok: false,
      value: null,
      error: '無法除以 0',
    });
    expect(evaluateCalcExpression('12..3+4').ok).toBe(false);
    expect(evaluateCalcExpression('alert(1)').ok).toBe(false);
  });

  it('picks smart parentheses based on current expression context', () => {
    expect(pickSmartParen('')).toBe('(');
    expect(pickSmartParen('(120+80')).toBe(')');
    expect(pickSmartParen('(120+')).toBe('(');
    expect(pickSmartParen('(120+80)')).toBe('(');
  });
});
