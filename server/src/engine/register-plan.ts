import {
  CAPITAL_PENALTIES,
  INTEREST_SHEET_SUMMARY,
  MEMBERS,
  OPEN_PERIOD,
  PERIODS,
  REGISTER,
  STATEMENT_DATES,
  type Period,
  type RegisterRow,
} from "../data/register.js";
import {
  calculateClosingShares,
  calculateCurrentInterest,
  calculateInstallment,
  calculateInterestDistribution,
  calculateInterestOutstanding,
  calculateLoanBalance,
  money,
  moneyToString,
  subtractMoney,
  sumMoney,
} from "./finance.js";

const MONTHLY_RATE = "0.01";

export type ShareTxn = {
  memberKey: string;
  date: string;
  period: string;
  amount: string;
  cashEffect: string;
  reason: string;
  reference: string;
};

export type LoanTxn = {
  memberKey: string;
  date: string;
  period: string;
  type: "DISBURSEMENT" | "PRINCIPAL_REPAYMENT";
  amount: string;
  reason: string;
  reference: string;
};

export type InterestEvent = {
  memberKey: string;
  date: string;
  period: string;
  kind: "ACCRUAL" | "COLLECTION";
  amount: string;
  reason: string;
};

export type StatementPlan = {
  memberKey: string;
  period: Period;
  openingShares: string;
  monthlyShare: string;
  shareMovement: string;
  arrearsCash: string;
  shareCashPending: string;
  closingShares: string;
  openingPrincipal: string;
  principalDue: string;
  closingPrincipal: string;
  previousInterest: string;
  currentInterest: string;
  interestCollected: string;
  interestOutstanding: string;
  penalty: string;
  totalInstallment: string;
};

export type DistributionPlan = {
  period: string;
  code: string;
  available: string;
  eligibleKeys: string[];
  perMember: string;
  amounts: string[];
  totalDistributed: string;
  remaining: string;
  roundingModeApplied: string;
};

function monthEnd(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

function rowMap(rows: RegisterRow[]): Map<string, RegisterRow> {
  return new Map(rows.map((row) => [row.key, row]));
}

/**
 * When the outstanding loan rises between statements, the previous scheduled
 * principal is treated as repaid and the rest as a new disbursement.
 * That matches members who otherwise repay the scheduled amount every month.
 * The note is stored on the transaction so it can be reversed if the paper
 * loan book shows a different split. The व्याज sheet left कर्ज वाटप blank.
 */
export function inferLoanMovement(previousOutstanding: string, nextOutstanding: string, scheduledPrincipal: string) {
  const delta = money(nextOutstanding).minus(money(previousOutstanding));
  if (delta.isZero()) return { repaid: "0.00", disbursed: "0.00" };
  if (delta.isNegative()) return { repaid: moneyToString(delta.abs()), disbursed: "0.00" };
  const disbursed = delta.plus(money(scheduledPrincipal));
  return { repaid: moneyToString(money(scheduledPrincipal)), disbursed: moneyToString(disbursed) };
}

export function buildSocietyPlan() {
  const june = REGISTER["2026-06"];
  const mahajan = june.find((row) => row.key === "mahajan");
  if (!mahajan) throw new Error("Mahajan D is missing from the June register");
  const openingShare = subtractMoney(mahajan.totalShares, mahajan.monthlyShare);

  const shareBalance = new Map<string, string>();
  const shareTransactions: ShareTxn[] = [];
  const loanTransactions: LoanTxn[] = [];
  const interestEvents: InterestEvent[] = [];
  const statements: StatementPlan[] = [];

  for (const member of MEMBERS) {
    shareBalance.set(member.key, openingShare);
    shareTransactions.push({
      memberKey: member.key,
      date: "2026-06-01",
      period: "opening",
      amount: openingShare,
      cashEffect: openingShare,
      reason: "Opening share balance migrated from the June 2026 register, before that month's contribution",
      reference: "OPENING-SHARES",
    });
  }

  const juneLoans = rowMap(june);
  for (const member of MEMBERS) {
    const loan = juneLoans.get(member.key)?.loanOutstanding ?? "0.00";
    if (money(loan).isZero()) continue;
    loanTransactions.push({
      memberKey: member.key,
      date: "2026-06-01",
      period: "opening",
      type: "DISBURSEMENT",
      amount: loan,
      reason: "Opening loan balance migrated from the June 2026 register",
      reference: "OPENING-LOAN",
    });
  }

  const broughtForward = june.filter((row) => money(row.previousInterest).greaterThan(0));
  for (const row of broughtForward) {
    interestEvents.push({
      memberKey: row.key,
      date: "2026-05-31",
      period: "2026-05",
      kind: "ACCRUAL",
      amount: row.previousInterest,
      reason: "Previous interest outstanding brought forward on the June 2026 register",
    });
  }

  for (let index = 0; index < PERIODS.length; index += 1) {
    const period = PERIODS[index];
    const rows = REGISTER[period];
    const present = new Set(rows.map((row) => row.key));
    const nextRows = index < PERIODS.length - 1 ? rowMap(REGISTER[PERIODS[index + 1]]) : null;
    const open = period === OPEN_PERIOD;

    for (const [key, balance] of shareBalance) {
      if (!present.has(key) && money(balance).greaterThan(0)) {
        shareTransactions.push({
          memberKey: key,
          date: STATEMENT_DATES[period],
          period,
          amount: moneyToString(money(balance).neg()),
          cashEffect: moneyToString(money(balance).neg()),
          reason: "Share refund. The member is no longer on the register from this month.",
          reference: `EXIT-${period}`,
        });
        shareBalance.set(key, "0.00");
      }
    }

    for (const row of rows) {
      const openingShares = shareBalance.get(row.key) ?? "0.00";
      const delta = money(row.totalShares).minus(money(openingShares));
      if (delta.isNegative()) throw new Error(`Unexpected share drop for ${row.key} in ${period}`);

      let arrearsCash = "0.00";
      let shareCashPending = "0.00";
      if (delta.greaterThan(0)) {
        const column = money(row.monthlyShare);
        if (!open) {
          shareTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            amount: moneyToString(delta),
            cashEffect: moneyToString(delta),
            reason: "Monthly share credited and collected, as shown by the increase in total shares",
            reference: `SHARE-${period}`,
          });
        } else if (delta.equals(column)) {
          shareCashPending = moneyToString(delta);
          shareTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            amount: moneyToString(delta),
            cashEffect: "0.00",
            reason: "October share assessed into total shares. Cash is still to be collected with the installment.",
            reference: `SHARE-ASSESS-${period}`,
          });
        } else if (delta.greaterThan(column)) {
          arrearsCash = moneyToString(delta.minus(column));
          shareCashPending = moneyToString(column);
          shareTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            amount: arrearsCash,
            cashEffect: arrearsCash,
            reason:
              "Accumulated monthly-share arrears settled. The October column shows only the regular ₹500 share; the balance moved by the full settlement.",
            reference: `SHARE-ARREARS-${period}`,
          });
          shareTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            amount: shareCashPending,
            cashEffect: "0.00",
            reason: "October regular share assessed into total shares. Cash is still to be collected with the installment.",
            reference: `SHARE-ASSESS-${period}`,
          });
        } else {
          shareCashPending = moneyToString(delta);
          shareTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            amount: moneyToString(delta),
            cashEffect: "0.00",
            reason: "Partial share credit on the open statement",
            reference: `SHARE-ASSESS-${period}`,
          });
        }
        shareBalance.set(row.key, row.totalShares);
      }

      const calculatedInterest = calculateCurrentInterest(row.loanOutstanding, MONTHLY_RATE);
      if (calculatedInterest !== row.currentInterest) {
        throw new Error(
          `${row.key} ${period}: 1% of ${row.loanOutstanding} is ${calculatedInterest}, register shows ${row.currentInterest}`,
        );
      }
      const calculatedInstallment = calculateInstallment({
        monthlyShare: row.monthlyShare,
        previousInterest: row.previousInterest,
        currentInterest: calculatedInterest,
        principal: row.principal,
        penalty: row.penalty,
      });
      if (calculatedInstallment !== row.totalInstallment) {
        throw new Error(
          `${row.key} ${period}: installment ${calculatedInstallment} does not match register ${row.totalInstallment}`,
        );
      }

      let interestCollected = "0.00";
      if (!open) {
        const next = nextRows?.get(row.key);
        const owed = sumMoney([row.previousInterest, row.currentInterest]);
        if (!next) {
          interestCollected = owed;
        } else {
          interestCollected = subtractMoney(owed, next.previousInterest);
        }
        if (money(interestCollected).isNegative()) {
          throw new Error(`Negative interest collection for ${row.key} ${period}`);
        }
      }

      const interestOutstanding = calculateInterestOutstanding(
        row.previousInterest,
        calculatedInterest,
        interestCollected,
      );

      if (money(calculatedInterest).greaterThan(0)) {
        interestEvents.push({
          memberKey: row.key,
          date: STATEMENT_DATES[period],
          period,
          kind: "ACCRUAL",
          amount: calculatedInterest,
          reason: `Monthly interest at 1% on outstanding loan ${row.loanOutstanding}`,
        });
      }
      if (money(interestCollected).greaterThan(0)) {
        const settledArrears = money(row.previousInterest).greaterThan(0);
        interestEvents.push({
          memberKey: row.key,
          date: settledArrears ? monthEnd(period) : STATEMENT_DATES[period],
          period,
          kind: "COLLECTION",
          amount: interestCollected,
          reason: settledArrears
            ? "Collected previous and current interest. The next statement shows previous interest cleared."
            : "Current interest collected. The next statement does not carry it forward.",
        });
      }

      const closingShares = calculateClosingShares(openingShares, moneyToString(delta));
      if (closingShares !== row.totalShares) {
        throw new Error(`Share roll-forward failed for ${row.key} ${period}`);
      }

      statements.push({
        memberKey: row.key,
        period,
        openingShares,
        monthlyShare: row.monthlyShare,
        shareMovement: moneyToString(delta),
        arrearsCash,
        shareCashPending,
        closingShares,
        openingPrincipal: row.loanOutstanding,
        principalDue: row.principal,
        closingPrincipal: row.loanOutstanding,
        previousInterest: row.previousInterest,
        currentInterest: calculatedInterest,
        interestCollected,
        interestOutstanding,
        penalty: row.penalty,
        totalInstallment: calculatedInstallment,
      });
    }

    if (nextRows) {
      for (const row of rows) {
        const next = nextRows.get(row.key);
        const nextLoan = next?.loanOutstanding ?? "0.00";
        const movement = inferLoanMovement(row.loanOutstanding, nextLoan, row.principal);
        const closing = calculateLoanBalance(row.loanOutstanding, movement.disbursed, movement.repaid);
        if (closing !== nextLoan) throw new Error(`Loan roll-forward failed for ${row.key} after ${period}`);
        if (money(movement.repaid).greaterThan(0)) {
          loanTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            type: "PRINCIPAL_REPAYMENT",
            amount: movement.repaid,
            reason: `Principal recovered after the ${period} statement. The next register balance is ${nextLoan}.`,
            reference: `PRIN-${period}`,
          });
        }
        if (money(movement.disbursed).greaterThan(0)) {
          loanTransactions.push({
            memberKey: row.key,
            date: STATEMENT_DATES[period],
            period,
            type: "DISBURSEMENT",
            amount: movement.disbursed,
            reason: `New loan inferred because the balance rose from ${row.loanOutstanding} to ${nextLoan} after scheduled principal of ${row.principal}. Reverse this if the paper book shows a different split.`,
            reference: `LOAN-${period}`,
          });
        }
      }
    }
  }

  const penalties = [
    ...CAPITAL_PENALTIES.map((penalty) => ({
      memberKey: penalty.key,
      period: penalty.period,
      date: STATEMENT_DATES[penalty.period],
      amount: penalty.amount,
      collected: penalty.amount,
      source: "INTEREST_SHEET" as const,
      reason: penalty.note,
    })),
    ...statements
      .filter((statement) => money(statement.penalty).greaterThan(0))
      .map((statement) => ({
        memberKey: statement.memberKey,
        period: statement.period,
        date: STATEMENT_DATES[statement.period],
        amount: statement.penalty,
        collected: "0.00",
        source: "INSTALLMENT" as const,
        reason: "Penalty printed in the monthly installment column. It is not added to the interest pool.",
      })),
  ];

  const collectionsByPeriod = new Map<string, string>();
  for (const event of interestEvents) {
    if (event.kind !== "COLLECTION") continue;
    const current = collectionsByPeriod.get(event.period) ?? "0.00";
    collectionsByPeriod.set(event.period, sumMoney([current, event.amount]));
  }

  const distributions: DistributionPlan[] = [];
  for (const period of PERIODS) {
    if (period === OPEN_PERIOD) continue;
    const available = collectionsByPeriod.get(period) ?? "0.00";
    const eligibleKeys = REGISTER[period].map((row) => row.key);
    const distribution = calculateInterestDistribution(available, eligibleKeys.length);
    distributions.push({
      period,
      code: `DIST-${period}`,
      available,
      eligibleKeys,
      perMember: distribution.perMember,
      amounts: distribution.amounts,
      totalDistributed: distribution.totalDistributed,
      remaining: distribution.remaining,
      roundingModeApplied: distribution.roundingModeApplied,
    });
  }

  const shareTotal = sumMoney([...shareBalance.values()]);
  const loanNet = new Map<string, string>();
  for (const txn of loanTransactions) {
    const current = loanNet.get(txn.memberKey) ?? "0.00";
    loanNet.set(
      txn.memberKey,
      txn.type === "DISBURSEMENT" ? sumMoney([current, txn.amount]) : subtractMoney(current, txn.amount),
    );
  }
  const loansOutstanding = sumMoney([...loanNet.values()]);
  const interestAccrued = sumMoney(interestEvents.filter((event) => event.kind === "ACCRUAL").map((event) => event.amount));
  const interestCollected = sumMoney(interestEvents.filter((event) => event.kind === "COLLECTION").map((event) => event.amount));
  const interestDistributed = sumMoney(distributions.map((distribution) => distribution.totalDistributed));
  const penaltyCollected = sumMoney(penalties.map((penalty) => penalty.collected));
  const shareCash = sumMoney(shareTransactions.map((txn) => txn.cashEffect));
  const principalRecovered = sumMoney(
    loanTransactions.filter((txn) => txn.type === "PRINCIPAL_REPAYMENT").map((txn) => txn.amount),
  );
  const loanDisbursements = sumMoney(
    loanTransactions.filter((txn) => txn.type === "DISBURSEMENT").map((txn) => txn.amount),
  );
  const withdrawals = sumMoney(
    shareTransactions.filter((txn) => money(txn.amount).isNegative()).map((txn) => moneyToString(money(txn.amount).abs())),
  );

  return {
    monthlyRate: MONTHLY_RATE,
    openingShare,
    shareTransactions,
    loanTransactions,
    interestEvents,
    statements,
    penalties,
    distributions,
    totals: {
      shares: shareTotal,
      loansOutstanding,
      interestAccrued,
      interestCollected,
      interestDistributed,
      interestRemaining: subtractMoney(interestCollected, interestDistributed),
      penaltyCollected,
      shareCash,
      principalRecovered,
      loanDisbursements,
      withdrawals,
      unpaidShares: subtractMoney(shareTotal, shareCash),
      ledgerCash: moneyToString(
        money(shareCash).plus(interestCollected).plus(penaltyCollected).plus(principalRecovered).minus(loanDisbursements),
      ),
      registerResidual: moneyToString(
        money(shareTotal).plus(interestCollected).plus(penaltyCollected).minus(loansOutstanding),
      ),
      capital: sumMoney([shareTotal, interestCollected, penaltyCollected]),
    },
    expected: INTEREST_SHEET_SUMMARY,
  };
}
