import Decimal from "decimal.js";

/**
 * All society money math lives here.
 * Inputs are decimal strings. JavaScript binary floats are rejected.
 * Currency results are always 2 decimal places. Rates may have up to 6.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;
const RATE_RE = /^\d+(\.\d{1,6})?$/;

export const ALLOCATION_COMPONENTS = [
  "SHARE",
  "PREVIOUS_INTEREST",
  "CURRENT_INTEREST",
  "PRINCIPAL",
  "PENALTY",
] as const;

export type AllocationComponent = (typeof ALLOCATION_COMPONENTS)[number];

export type RoundingPolicy = "UNIFORM_HALF_UP_REMAINDER" | "LARGEST_REMAINDER";

export type InstallmentParts = {
  monthlyShare: string;
  previousInterest: string;
  currentInterest: string;
  principal: string;
  penalty: string;
};

export type ReconciliationCheck = {
  name: string;
  expected: string;
  calculated: string;
  difference: string;
  ok: boolean;
};

export function money(value: string): Decimal {
  if (typeof value !== "string") {
    throw new MoneyError("Money must be a decimal string, never a floating-point number");
  }
  const v = value.trim();
  if (!MONEY_RE.test(v)) {
    throw new MoneyError(`Invalid money amount "${value}"`);
  }
  return new Decimal(v);
}

export function rate(value: string): Decimal {
  if (typeof value !== "string" || !RATE_RE.test(value.trim())) {
    throw new MoneyError(`Invalid interest rate "${value}"`);
  }
  const d = new Decimal(value.trim());
  if (d.isNegative() || d.greaterThan(1)) {
    throw new MoneyError("Interest rate must be between 0 and 1 (1% is 0.01)");
  }
  return d;
}

export function moneyToString(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function sumMoney(values: string[]): string {
  return moneyToString(values.reduce((sum, value) => sum.plus(money(value)), new Decimal(0)));
}

export function subtractMoney(a: string, b: string): string {
  return moneyToString(money(a).minus(money(b)));
}

export function compareMoney(a: string, b: string): number {
  return money(a).comparedTo(money(b));
}

export function isZero(value: string): boolean {
  return money(value).isZero();
}

export function isNegative(value: string): boolean {
  return money(value).isNegative();
}

/** Monthly share is the member's configured subscription. It is not derived from a loan. */
export function calculateMonthlyShare(configuredMonthlyShare: string): string {
  const value = money(configuredMonthlyShare);
  if (value.isNegative()) throw new MoneyError("Monthly share cannot be negative");
  return moneyToString(value);
}

export function calculateClosingShares(openingShares: string, contributions: string): string {
  const closing = money(openingShares).plus(money(contributions));
  if (closing.isNegative()) throw new MoneyError("Share balance cannot become negative");
  return moneyToString(closing);
}

export function calculateCurrentInterest(outstandingPrincipal: string, monthlyRate: string): string {
  const principal = money(outstandingPrincipal);
  if (principal.isNegative()) throw new MoneyError("Outstanding principal cannot be negative");
  return moneyToString(principal.times(rate(monthlyRate)));
}

export function calculateInterestOutstanding(
  previousInterest: string,
  currentInterest: string,
  interestCollected: string,
): string {
  const outstanding = money(previousInterest).plus(money(currentInterest)).minus(money(interestCollected));
  if (outstanding.isNegative()) {
    throw new MoneyError("Interest collected cannot exceed previous interest plus current interest");
  }
  return moneyToString(outstanding);
}

export function calculateLoanBalance(openingPrincipal: string, disbursed: string, repaid: string): string {
  const closing = money(openingPrincipal).plus(money(disbursed)).minus(money(repaid));
  if (closing.isNegative()) throw new MoneyError("Loan principal cannot become negative");
  return moneyToString(closing);
}

export function calculatePenalty(input: {
  method: "MANUAL" | "FIXED" | "PERCENTAGE" | "PER_DAY" | "PER_MONTH";
  manualAmount?: string;
}): string {
  if (input.method !== "MANUAL") {
    throw new MoneyError(
      `Penalty method ${input.method} is not enabled. The register uses manual penalties; configure a formula only when the society adopts one.`,
    );
  }
  if (!input.manualAmount) throw new MoneyError("A manual penalty needs an amount");
  const amount = money(input.manualAmount);
  if (amount.isNegative()) throw new MoneyError("Penalty cannot be negative");
  return moneyToString(amount);
}

/**
 * Principal due this month ignores a loan given now and a new EMI.
 * Those apply from next month, same as interest on a new disbursement.
 */
export function scheduledForOpenPrincipal(input: {
  givenThisMonth: string;
  currentScheduled: string;
  statementPrincipalDue: string;
  unpaidPrincipal: string;
  priorScheduled: string;
}): string {
  if (money(input.givenThisMonth).isZero()) return moneyToString(money(input.currentScheduled));
  const already = subtractMoney(input.statementPrincipalDue, input.unpaidPrincipal);
  if (money(already).greaterThan(0)) return already;
  if (money(input.statementPrincipalDue).greaterThan(0)) return moneyToString(money(input.statementPrincipalDue));
  return moneyToString(money(input.priorScheduled));
}

/** This month's Principal column is the usual installment, capped by the opening loan. Unpaid principal stays on the loan and keeps earning interest. */
export function principalDueThisMonth(openingPrincipal: string, scheduled: string): string {
  const opening = money(openingPrincipal);
  const installment = money(scheduled);
  if (opening.isNegative() || installment.isNegative()) {
    throw new MoneyError("Principal cannot be negative");
  }
  return moneyToString(Decimal.min(opening, installment));
}

export function calculateInstallment(parts: InstallmentParts): string {
  return sumMoney([
    parts.monthlyShare,
    parts.previousInterest,
    parts.currentInterest,
    parts.principal,
    parts.penalty,
  ]);
}

/** Share still to collect this month: this month's unpaid share plus last-month arrears. */
export function shareDueOnBooks(shareCashPending: string, arrearsCash: string): string {
  return sumMoney([shareCashPending, arrearsCash]);
}

/**
 * Month-sheet Share column is the full amount still to collect.
 * Pass this month's unpaid share plus arrears. When that total is 0, show the usual monthly share.
 */
export function shareOnSheet(monthlyShare: string, shareDue: string): string {
  return money(shareDue).greaterThan(0)
    ? moneyToString(money(shareDue))
    : moneyToString(money(monthlyShare));
}

/** Replace the usual monthly share inside an installment with the Share column amount. */
export function sheetInstallmentTotal(
  totalInstallment: string,
  monthlyShare: string,
  lastMonthPending: string,
): string {
  return sumMoney([
    subtractMoney(totalInstallment, monthlyShare),
    shareOnSheet(monthlyShare, lastMonthPending),
  ]);
}

/** Monthly share is the usual amount. Pending is cash still to collect, and may include arrears. */
export function splitImportedShareDue(monthlyShare: string, sharePending: string) {
  const monthly = money(monthlyShare);
  const pending = money(sharePending);
  if (monthly.isNegative()) throw new MoneyError("Monthly share cannot be negative");
  if (pending.isNegative()) throw new MoneyError("Monthly share pending cannot be negative");
  const thisMonthDue = Decimal.min(pending, monthly);
  return {
    shareCashPending: moneyToString(thisMonthDue),
    arrearsCash: moneyToString(pending.minus(thisMonthDue)),
    collectedThisMonth: moneyToString(monthly.minus(thisMonthDue)),
  };
}

export function calculateImportedInstallment(parts: Omit<InstallmentParts, "monthlyShare"> & { sharePending: string }): string {
  return sumMoney([
    parts.sharePending,
    parts.previousInterest,
    parts.currentInterest,
    parts.principal,
    parts.penalty,
  ]);
}

/** Share cash on the sheet is whatever the हप्ता still holds after the other due columns. */
export function sharePendingFromInstallment(
  totalInstallment: string,
  previousInterest: string,
  currentInterest: string,
  principal: string,
  penalty: string,
) {
  return subtractMoney(totalInstallment, sumMoney([previousInterest, currentInterest, principal, penalty]));
}

/** Paper registers often still add monthly share into the हप्ता, or add both share columns. */
export function importedInstallmentAccepted(
  parts: InstallmentParts & { sharePending: string },
  sheetTotal: string,
) {
  const others = [parts.previousInterest, parts.currentInterest, parts.principal, parts.penalty];
  return [
    sumMoney([parts.sharePending, ...others]),
    sumMoney([parts.monthlyShare, ...others]),
    sumMoney([parts.monthlyShare, parts.sharePending, ...others]),
  ].includes(sheetTotal);
}

export function calculatePaymentAllocation(
  payment: string,
  dues: Record<AllocationComponent, string>,
  order: readonly string[],
): {
  allocations: { component: AllocationComponent; amount: string }[];
  totalAllocated: string;
  unapplied: string;
} {
  const sequence = assertAllocationOrder(order);
  let remaining = money(payment);
  if (remaining.isNegative()) throw new MoneyError("Payment cannot be negative");

  const allocations = sequence.map((component) => {
    const due = money(dues[component] ?? "0.00");
    if (due.isNegative()) throw new MoneyError(`Due for ${component} cannot be negative`);
    const applied = Decimal.min(remaining, due);
    remaining = remaining.minus(applied);
    return { component, amount: moneyToString(applied) };
  });

  return {
    allocations,
    totalAllocated: sumMoney(allocations.map((row) => row.amount)),
    unapplied: moneyToString(remaining),
  };
}

/** Scheduled principal is the usual installment. Any further amount the member deposits reduces the outstanding loan, up to the room remaining. */
export function absorbExtraPrincipal(
  allocations: { component: AllocationComponent; amount: string }[],
  unapplied: string,
  principalRoom: string,
): {
  allocations: { component: AllocationComponent; amount: string }[];
  totalAllocated: string;
  unapplied: string;
} {
  const extra = Decimal.min(money(unapplied), money(principalRoom));
  if (extra.isNegative()) throw new MoneyError("Extra principal cannot be negative");
  const next = allocations.map((row) =>
    row.component === "PRINCIPAL" ? { ...row, amount: sumMoney([row.amount, moneyToString(extra)]) } : row,
  );
  return {
    allocations: next,
    totalAllocated: sumMoney(next.map((row) => row.amount)),
    unapplied: subtractMoney(unapplied, moneyToString(extra)),
  };
}

/** Collect the due penalty first, then apply the rest in the society's usual order. */
export function allocateCollectingPenaltyFirst(
  payment: string,
  dues: Record<AllocationComponent, string>,
  order: readonly string[],
  penaltyCap?: string,
) {
  const sequence = assertAllocationOrder(order);
  const due = money(dues.PENALTY ?? "0.00");
  const capped = penaltyCap !== undefined ? Decimal.min(due, money(penaltyCap)) : due;
  const take = Decimal.min(money(payment), capped);
  const rest = money(payment).minus(take);
  const restDues = { ...dues, PENALTY: "0.00" };
  if (rest.isZero()) {
    return {
      allocations: sequence.map((component) => ({
        component,
        amount: component === "PENALTY" ? moneyToString(take) : "0.00",
      })),
      totalAllocated: moneyToString(take),
      unapplied: "0.00",
    };
  }
  const restAlloc = calculatePaymentAllocation(moneyToString(rest), restDues, sequence);
  return {
    allocations: restAlloc.allocations.map((row) =>
      row.component === "PENALTY" ? { ...row, amount: moneyToString(take) } : row,
    ),
    totalAllocated: sumMoney([restAlloc.totalAllocated, moneyToString(take)]),
    unapplied: restAlloc.unapplied,
  };
}

export function assertExplicitAllocation(
  payment: string,
  dues: Record<AllocationComponent, string>,
  allocation: { component: AllocationComponent; amount: string }[],
): { allocations: { component: AllocationComponent; amount: string }[]; totalAllocated: string } {
  const seen = new Set<AllocationComponent>();
  const normalized = ALLOCATION_COMPONENTS.map((component) => {
    const rows = allocation.filter((row) => row.component === component);
    if (rows.length > 1) throw new MoneyError(`Duplicate allocation for ${component}`);
    const amount = rows[0] ? money(rows[0].amount) : new Decimal(0);
    if (amount.isNegative()) throw new MoneyError("Allocation amounts cannot be negative");
    const due = money(dues[component] ?? "0.00");
    if (amount.greaterThan(due)) {
      throw new MoneyError(`${component} allocation exceeds the amount due`);
    }
    seen.add(component);
    return { component, amount: moneyToString(amount) };
  });
  if (allocation.some((row) => !seen.has(row.component) && !ALLOCATION_COMPONENTS.includes(row.component))) {
    throw new MoneyError("Unknown payment component");
  }
  const totalAllocated = sumMoney(normalized.map((row) => row.amount));
  if (!money(totalAllocated).equals(money(payment))) {
    throw new MoneyError("Allocated amounts must add up to the payment");
  }
  return { allocations: normalized, totalAllocated };
}

export function assertAllocationOrder(order: readonly string[]): AllocationComponent[] {
  if (!order || order.length === 0) {
    throw new MoneyError("Payment allocation order is not configured");
  }
  if (order.length !== ALLOCATION_COMPONENTS.length || new Set(order).size !== order.length) {
    throw new MoneyError("Payment allocation order must list each component once");
  }
  for (const component of order) {
    if (!ALLOCATION_COMPONENTS.includes(component as AllocationComponent)) {
      throw new MoneyError(`Unknown allocation component ${component}`);
    }
  }
  return [...order] as AllocationComponent[];
}

export function calculateInterestPool(input: {
  accrued: string;
  collected: string;
  distributed: string;
}): {
  accrued: string;
  collected: string;
  pending: string;
  distributed: string;
  available: string;
  undistributed: string;
} {
  const accrued = money(input.accrued);
  const collected = money(input.collected);
  const distributed = money(input.distributed);
  if (accrued.isNegative() || collected.isNegative() || distributed.isNegative()) {
    throw new MoneyError("Interest figures cannot be negative");
  }
  if (distributed.greaterThan(collected)) {
    throw new MoneyError("Interest distributed cannot exceed interest collected");
  }
  /** Carried previous interest can be collected in a later month than its accrual row. Pending collection never goes negative. */
  const pending = accrued.greaterThan(collected) ? accrued.minus(collected) : new Decimal(0);
  const undistributed = collected.minus(distributed);
  return {
    accrued: moneyToString(accrued),
    collected: moneyToString(collected),
    pending: moneyToString(pending),
    distributed: moneyToString(distributed),
    available: moneyToString(undistributed),
    undistributed: moneyToString(undistributed),
  };
}

/** One accrual row per member per month. Carried previous interest is not part of the pool accrual total. */
export function sumInterestAccrualEvents(
  events: { kind: string; memberId: string; period: string; amount: string; reason?: string | null; createdAt?: Date | string }[],
): string {
  const latest = new Map<string, { amount: string; at: number }>();
  for (const row of events) {
    if (row.kind !== "ACCRUAL") continue;
    if (row.reason?.includes("Previous interest outstanding on import")) continue;
    const key = `${row.memberId}:${row.period}`;
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    const prev = latest.get(key);
    if (!prev || at >= prev.at) latest.set(key, { amount: money(row.amount).toFixed(2), at });
  }
  return sumMoney([...latest.values()].map((row) => row.amount));
}

/** Home pool accrued: closed months from accrual rows; open month from statements (matches the installment block). */
export function poolAccruedForDashboard(input: {
  closedPeriods: string[];
  openStatements: { currentInterest: string }[];
  events: { kind: string; memberId: string; period: string; amount: string; reason?: string | null; createdAt?: Date | string }[];
}): string {
  const closedAccrued = input.closedPeriods.length
    ? sumInterestAccrualEvents(input.events.filter((row) => row.kind === "ACCRUAL" && input.closedPeriods.includes(row.period)))
    : "0.00";
  const openAccrued = sumMoney(input.openStatements.map((row) => row.currentInterest));
  return sumMoney([closedAccrued, openAccrued]);
}

export function calculateInterestDistribution(
  available: string,
  eligibleCount: number,
  policy: RoundingPolicy = "UNIFORM_HALF_UP_REMAINDER",
): {
  perMember: string;
  amounts: string[];
  eligibleCount: number;
  totalDistributed: string;
  remaining: string;
  roundingModeApplied: string;
} {
  if (!Number.isInteger(eligibleCount) || eligibleCount <= 0) {
    throw new MoneyError("Eligible member count must be a positive whole number");
  }
  const pool = money(available);
  if (pool.isNegative()) throw new MoneyError("Interest available for distribution cannot be negative");
  if (pool.isZero()) {
    return {
      perMember: "0.00",
      amounts: Array.from({ length: eligibleCount }, () => "0.00"),
      eligibleCount,
      totalDistributed: "0.00",
      remaining: "0.00",
      roundingModeApplied: "ZERO",
    };
  }

  if (policy === "LARGEST_REMAINDER") {
    const paise = pool.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const base = paise.div(eligibleCount).floor();
    let leftover = paise.minus(base.times(eligibleCount)).toNumber();
    const amounts = Array.from({ length: eligibleCount }, () => {
      const extra = leftover > 0 ? 1 : 0;
      if (leftover > 0) leftover -= 1;
      return base.plus(extra).div(100).toFixed(2);
    });
    const totalDistributed = sumMoney(amounts);
    const remaining = moneyToString(pool.minus(money(totalDistributed)));
    if (money(remaining).isNegative() || !money(sumMoney([totalDistributed, remaining])).equals(pool)) {
      throw new MoneyError("Distribution did not conserve the interest pool");
    }
    return {
      perMember: amounts[0],
      amounts,
      eligibleCount,
      totalDistributed,
      remaining,
      roundingModeApplied: "LARGEST_REMAINDER",
    };
  }

  const exact = pool.div(eligibleCount);
  let per = exact.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  let distributed = per.times(eligibleCount);
  let mode = "HALF_UP";
  if (distributed.greaterThan(pool)) {
    per = exact.toDecimalPlaces(2, Decimal.ROUND_DOWN);
    distributed = per.times(eligibleCount);
    mode = "FLOOR_TO_AVOID_CREATING_MONEY";
  }
  const remaining = pool.minus(distributed);
  if (remaining.isNegative()) throw new MoneyError("Distribution exceeded interest collected");
  const perMember = moneyToString(per);
  return {
    perMember,
    amounts: Array.from({ length: eligibleCount }, () => perMember),
    eligibleCount,
    totalDistributed: moneyToString(distributed),
    remaining: moneyToString(remaining),
    roundingModeApplied: mode,
  };
}

export function calculateSocietyBalance(input: {
  opening: string;
  memberContributions: string;
  principalRecovered: string;
  interestCollected: string;
  penaltyCollected: string;
  otherCredits: string;
  loanDisbursements: string;
  withdrawals: string;
  refunds: string;
}): string {
  const credits = sumMoney([
    input.opening,
    input.memberContributions,
    input.principalRecovered,
    input.interestCollected,
    input.penaltyCollected,
    input.otherCredits,
  ]);
  const debits = sumMoney([input.loanDisbursements, input.withdrawals, input.refunds]);
  return subtractMoney(credits, debits);
}

export type LedgerCashLine = {
  type: string;
  cashEffect: string;
  credit: string;
  debit: string;
};

const CASH_IN_SOURCES = new Set(["MEMBER_CONTRIBUTION", "INTEREST_COLLECTION", "PENALTY_COLLECTION", "PRINCIPAL_REPAYMENT"]);
const CASH_OUT_SOURCES = new Set(["LOAN_DISBURSEMENT", "WITHDRAWAL"]);

export function netLedgerByType(lines: LedgerCashLine[], type: string) {
  return subtractMoney(
    sumMoney(lines.filter((row) => row.type === type && row.cashEffect === "IN").map((row) => row.credit)),
    sumMoney(lines.filter((row) => row.type === type && row.cashEffect === "OUT").map((row) => row.debit)),
  );
}

/** Reconstruct society cash from ledger cash lines only. Share-register cashEffect is never a source. */
export function societyBalanceFromLedger(lines: LedgerCashLine[]) {
  const memberContributions = netLedgerByType(lines, "MEMBER_CONTRIBUTION");
  const interestCollected = netLedgerByType(lines, "INTEREST_COLLECTION");
  const penaltyCollected = netLedgerByType(lines, "PENALTY_COLLECTION");
  const principalRecovered = netLedgerByType(lines, "PRINCIPAL_REPAYMENT");
  const otherCredits = sumMoney(lines.filter((row) => row.cashEffect === "IN" && !CASH_IN_SOURCES.has(row.type)).map((row) => row.credit));
  const loanDisbursements = sumMoney(lines.filter((row) => row.type === "LOAN_DISBURSEMENT" && row.cashEffect === "OUT").map((row) => row.debit));
  const withdrawals = sumMoney(lines.filter((row) => row.type === "WITHDRAWAL" && row.cashEffect === "OUT").map((row) => row.debit));
  const refunds = sumMoney(
    lines
      .filter((row) => row.cashEffect === "OUT" && !CASH_OUT_SOURCES.has(row.type) && !CASH_IN_SOURCES.has(row.type))
      .map((row) => row.debit),
  );
  const expected = calculateSocietyBalance({
    opening: "0.00",
    memberContributions,
    principalRecovered,
    interestCollected,
    penaltyCollected,
    otherCredits,
    loanDisbursements,
    withdrawals,
    refunds,
  });
  const calculated = subtractMoney(
    sumMoney(lines.filter((row) => row.cashEffect === "IN").map((row) => row.credit)),
    sumMoney(lines.filter((row) => row.cashEffect === "OUT").map((row) => row.debit)),
  );
  return { expected, calculated };
}

export function reconcile(
  checks: { name: string; expected: string; calculated: string }[],
): { ok: boolean; checks: ReconciliationCheck[] } {
  const results = checks.map((check) => {
    const difference = money(check.expected).minus(money(check.calculated));
    return {
      name: check.name,
      expected: moneyToString(money(check.expected)),
      calculated: moneyToString(money(check.calculated)),
      difference: moneyToString(difference),
      ok: difference.isZero(),
    };
  });
  return { ok: results.every((check) => check.ok), checks: results };
}

export function calculateMonthlyClosing(input: {
  installmentParts: InstallmentParts;
  installmentRecorded: string;
  openingPrincipal: string;
  disbursed: string;
  principalRepaid: string;
  closingPrincipalRecorded: string;
  openingShares: string;
  contributions: string;
  closingSharesRecorded: string;
  interestCollected: string;
  interestDistributed: string;
  openingCash: string;
  cashCredits: string;
  cashDebits: string;
  closingCashRecorded: string;
  distributionAvailable: string;
  distributionDistributed: string;
  distributionRemaining: string;
}) {
  const installmentExpected = calculateInstallment(input.installmentParts);
  const closingPrincipalExpected = calculateLoanBalance(
    input.openingPrincipal,
    input.disbursed,
    input.principalRepaid,
  );
  const closingSharesExpected = calculateClosingShares(input.openingShares, input.contributions);
  const pool = calculateInterestPool({
    accrued: sumMoney([input.interestCollected, "0.00"]),
    collected: input.interestCollected,
    distributed: input.interestDistributed,
  });
  const cashExpected = subtractMoney(
    sumMoney([input.openingCash, input.cashCredits]),
    input.cashDebits,
  );
  const distributionIdentity = sumMoney([input.distributionDistributed, input.distributionRemaining]);

  return reconcile([
    { name: "Total installment", expected: installmentExpected, calculated: input.installmentRecorded },
    { name: "Closing principal", expected: closingPrincipalExpected, calculated: input.closingPrincipalRecorded },
    { name: "Closing shares", expected: closingSharesExpected, calculated: input.closingSharesRecorded },
    { name: "Interest pool", expected: pool.undistributed, calculated: subtractMoney(input.interestCollected, input.interestDistributed) },
    { name: "Society balance", expected: cashExpected, calculated: input.closingCashRecorded },
    { name: "Interest distribution", expected: input.distributionAvailable, calculated: distributionIdentity },
  ]);
}

export function deriveLoanStatus(input: {
  outstanding: string;
  missedPrincipalInstallments: number;
  hasRepayment: boolean;
  cancelled?: boolean;
}): "PENDING" | "ACTIVE" | "PARTIALLY_PAID" | "COMPLETED" | "OVERDUE" | "CANCELLED" {
  if (input.cancelled) return "CANCELLED";
  const outstanding = money(input.outstanding);
  if (outstanding.isNegative()) throw new MoneyError("Loan amounts cannot be negative");
  if (outstanding.isZero()) return "COMPLETED";
  if (input.missedPrincipalInstallments >= 2) return "OVERDUE";
  if (input.hasRepayment) return "PARTIALLY_PAID";
  return "ACTIVE";
}

export const WORKED_EXAMPLE = [
  { member: "Member A", collected: "2000.00" },
  { member: "Member B", collected: "1500.00" },
  { member: "Member C", collected: "1500.00" },
  { member: "Member D", collected: "1000.00" },
  { member: "Member E", collected: "1000.00" },
  { member: "Member F", collected: "800.00" },
  { member: "Member G", collected: "700.00" },
  { member: "Member H", collected: "600.00" },
  { member: "Member I", collected: "500.00" },
  { member: "Member J", collected: "400.00" },
] as const;

export function previewWorkedExample() {
  const total = sumMoney(WORKED_EXAMPLE.map((row) => row.collected));
  const distribution = calculateInterestDistribution(total, WORKED_EXAMPLE.length);
  return {
    lines: WORKED_EXAMPLE.map((row) => ({ ...row })),
    interestEarned: total,
    members: WORKED_EXAMPLE.length,
    yourInterest: distribution.perMember,
    totalDistributed: distribution.totalDistributed,
    remaining: distribution.remaining,
  };
}
