import { describe, expect, it } from 'vitest';
import {
  computeLoanAmortizationSchedule,
  computeLoanAmortizationSummary,
  computeNetWorthSummary,
  solveImpliedLoanAnnualRate,
} from '../shared/calculations';
import type { AssetItem } from '../shared/types';

function makeMortgage(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: 'loan-mortgage-1',
    updateMode: '手動快照',
    majorType: '負債',
    subCategory: '房貸餘額',
    liquidity: '負債',
    itemName: '自住房貸',
    ticker: '',
    quantityOrAmount: 3760328,
    currency: 'TWD',
    unitPrice: 1,
    note: '',
    isAmortizingLoan: true,
    balanceAnchorDate: '2025-05-25',
    loanAnnualRate: 2.367,
    loanMonthlyPayment: 30765,
    loanBillingDay: 12,
    createdAt: '2025-05-25T00:00:00.000Z',
    updatedAt: '2025-05-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('Loan Auto-Amortization & Snapshot Preservation', () => {
  it('amortizes mortgage balance accurately from anchor date across elapsed monthly billing cycles', () => {
    const mortgage = makeMortgage();

    // Before first billing cycle after 2025-05-25 (e.g. 2025-06-11): 0 periods elapsed
    const s0 = computeLoanAmortizationSummary(mortgage, 32.5, '2025-06-11');
    expect(s0.elapsedPeriods).toBe(0);
    expect(s0.currentBalance).toBe(3760328);
    expect(s0.nextPaymentDate).toBe('2025-06-12');
    expect(s0.nextInterest).toBe(7417); // round(3760328 * 0.02367 / 12)
    expect(s0.nextPrincipal).toBe(23348); // 30765 - 7417

    // After 1st billing cycle on 2025-06-12
    const s1 = computeLoanAmortizationSummary(mortgage, 32.5, '2025-06-12');
    expect(s1.elapsedPeriods).toBe(1);
    expect(s1.currentBalance).toBe(3760328 - 23348);
    expect(s1.totalPaidInterest).toBe(7417);
    expect(s1.totalPaidPrincipal).toBe(23348);

    // After 12 cycles (2026-05-25) & 18 cycles (2026-11-24)
    const s12 = computeLoanAmortizationSummary(mortgage, 32.5, '2026-05-25');
    expect(s12.elapsedPeriods).toBe(12);
    expect(s12.currentBalance).toBeGreaterThan(3475000);
    expect(s12.currentBalance).toBeLessThan(3480000);

    const s18 = computeLoanAmortizationSummary(mortgage, 32.5, '2026-11-24');
    expect(s18.elapsedPeriods).toBe(18);
    expect(s18.currentBalance).toBeGreaterThan(3330000);
    expect(s18.currentBalance).toBeLessThan(3336000);
    expect(s18.estimatedPayoffYm).toBe('2037-01');
  });

  it('reverse-solves implied annual interest rate from start date, term years, balance, and monthly payment', () => {
    const solved = solveImpliedLoanAnnualRate({
      baseBalance: 3760328,
      anchorDate: '2025-05-25',
      loanStartDate: '2017-01-12',
      loanTermYears: 20,
      monthlyPayment: 30765,
      billingDay: 12,
    });

    expect(solved.remainingPeriods).toBe(140);
    expect(solved.annualRate).toBe(2.367);
  });

  it('supports 0% installment loans, grace-period interest-only guard, Feb month-end clamping, and payoff cap at 0', () => {
    // 1. 0% car installment: 120,000 balance, 10,000/mo, billingDay=31 (clamps in Feb)
    const zeroLoan = makeMortgage({
      id: 'car-0',
      itemName: '零利率車貸',
      quantityOrAmount: 120000,
      balanceAnchorDate: '2026-01-15',
      loanAnnualRate: 0,
      loanMonthlyPayment: 10000,
      loanBillingDay: 31,
    });
    const febCheck = computeLoanAmortizationSummary(zeroLoan, 32.5, '2026-02-28');
    // Jan 31 + Feb 28 = 2 cycles
    expect(febCheck.elapsedPeriods).toBe(2);
    expect(febCheck.currentBalance).toBe(100000);
    expect(febCheck.totalPaidInterest).toBe(0);

    // After 15 months -> never drops below 0
    const paidOff = computeLoanAmortizationSummary(zeroLoan, 32.5, '2027-06-01');
    expect(paidOff.currentBalance).toBe(0);
    expect(paidOff.remainingPeriods).toBe(0);

    // 2. Grace period (monthlyPayment <= monthly interest): balance stays unchanged, never grows
    const graceLoan = makeMortgage({
      id: 'grace-1',
      quantityOrAmount: 5000000,
      balanceAnchorDate: '2026-01-01',
      loanAnnualRate: 2.4, // 10,000/mo interest
      loanMonthlyPayment: 10000,
      loanBillingDay: 15,
    });
    const graceRes = computeLoanAmortizationSummary(graceLoan, 32.5, '2026-06-20');
    expect(graceRes.isInterestOnly).toBe(true);
    expect(graceRes.currentBalance).toBe(5000000);
    expect(graceRes.remainingPeriods).toBeNull();
  });

  it('generates future amortization schedule entries and integrates with computeNetWorthSummary without breaking manual snapshots', () => {
    const mortgage = makeMortgage();
    const schedule = computeLoanAmortizationSchedule(mortgage, '2026-11-24', 12);
    expect(schedule).toHaveLength(12);
    expect(schedule[0].paymentDate).toBe('2026-12-12');
    // Principal paid increases each month as interest decreases
    expect(schedule[11].principal).toBeGreaterThan(schedule[0].principal);
    expect(schedule[11].interest).toBeLessThan(schedule[0].interest);

    // Auto-amortizing loan reduces totalLiabilities in computeNetWorthSummary
    const manualSnapshotVersion = makeMortgage({ isAmortizingLoan: false });
    const cashAsset: AssetItem = {
      id: 'cash-1',
      updateMode: '手動快照',
      majorType: '資產',
      subCategory: '定存/現金',
      liquidity: '高流動',
      itemName: '定存',
      ticker: '',
      quantityOrAmount: 5000000,
      currency: 'TWD',
      unitPrice: 1,
      note: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    const nwAuto = computeNetWorthSummary([cashAsset, mortgage], 32.5, 0, [], [], [], '2026-11-24');
    const nwManual = computeNetWorthSummary([cashAsset, manualSnapshotVersion], 32.5, 0, [], [], [], '2026-11-24');

    expect(nwManual.totalLiabilities).toBe(3760328);
    expect(nwAuto.totalLiabilities).toBeLessThan(3340000);
    expect(nwAuto.netWorth).toBeGreaterThan(nwManual.netWorth + 400000);
  });
});
