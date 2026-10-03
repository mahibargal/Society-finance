import { describe, expect, it } from "vitest";
import { INTEREST_SHEET_COLLECTED, INTEREST_SHEET_SUMMARY, REGISTER, SHEET_TOTALS } from "../data/register.js";
import {
  calculateCurrentInterest,
  calculateImportedInstallment,
  calculateInstallment,
  importedInstallmentAccepted,
  sharePendingFromInstallment,
  principalDueThisMonth,
  scheduledForOpenPrincipal,
  shareDueOnBooks,
  shareOnSheet,
  sheetInstallmentTotal,
  splitImportedShareDue,
  calculateInterestDistribution,
  calculateInterestPool,
  poolAccruedForDashboard,
  sumInterestAccrualEvents,
  calculateMonthlyClosing,
  absorbExtraPrincipal,
  allocateCollectingPenaltyFirst,
  calculatePaymentAllocation,
  calculateSocietyBalance,
  societyBalanceFromLedger,
  MoneyError,
  previewWorkedExample,
  reconcile,
  sumMoney,
} from "./finance.js";
import { buildSocietyPlan } from "./register-plan.js";

describe("interest on outstanding principal", () => {
  it("charges 1% on ₹69,000", () => {
    expect(calculateCurrentInterest("69000.00", "0.01")).toBe("690.00");
  });

  it("charges 1% on ₹1,08,000", () => {
    expect(calculateCurrentInterest("108000.00", "0.01")).toBe("1080.00");
  });

  it("rejects floating-point numbers", () => {
    expect(() => calculateCurrentInterest(69000 as unknown as string, "0.01")).toThrow(MoneyError);
  });
});

describe("installments keep every component separate", () => {
  it("adds Mahajan D's October demand to ₹3,580", () => {
    expect(
      calculateInstallment({
        monthlyShare: "500.00",
        previousInterest: "0.00",
        currentInterest: "1080.00",
        principal: "2000.00",
        penalty: "0.00",
      }),
    ).toBe("3580.00");
  });

  it("adds Rajput Mangal's September demand to ₹13,175", () => {
    expect(
      calculateInstallment({
        monthlyShare: "2500.00",
        previousInterest: "6060.00",
        currentInterest: "1515.00",
        principal: "2500.00",
        penalty: "600.00",
      }),
    ).toBe("13175.00");
  });

  it("keeps monthly share and share pending apart on import", () => {
    expect(splitImportedShareDue("500.00", "500.00")).toEqual({
      shareCashPending: "500.00",
      arrearsCash: "0.00",
      collectedThisMonth: "0.00",
    });
    expect(splitImportedShareDue("500.00", "1500.00")).toEqual({
      shareCashPending: "500.00",
      arrearsCash: "1000.00",
      collectedThisMonth: "0.00",
    });
    expect(splitImportedShareDue("500.00", "0.00")).toEqual({
      shareCashPending: "0.00",
      arrearsCash: "0.00",
      collectedThisMonth: "500.00",
    });
    expect(
      calculateImportedInstallment({
        sharePending: "1500.00",
        previousInterest: "50.00",
        currentInterest: "0.00",
        principal: "0.00",
        penalty: "0.00",
      }),
    ).toBe("1550.00");
    const dues = {
      monthlyShare: "500.00",
      sharePending: "2710.00",
      previousInterest: "0.00",
      currentInterest: "0.00",
      principal: "500.00",
      penalty: "0.00",
    };
    expect(sharePendingFromInstallment("3710.00", "0.00", "710.00", "2000.00", "0.00")).toBe("1000.00");
    expect(sharePendingFromInstallment("1000.00", "0.00", "0.00", "0.00", "0.00")).toBe("1000.00");
    expect(sharePendingFromInstallment("7130.00", "1515.00", "1515.00", "2500.00", "100.00")).toBe("1500.00");
    expect(importedInstallmentAccepted(dues, "3210.00")).toBe(true);
    expect(importedInstallmentAccepted(dues, "3710.00")).toBe(true);
    expect(importedInstallmentAccepted({ ...dues, sharePending: "0.00" }, "1000.00")).toBe(true);
    expect(importedInstallmentAccepted(dues, "9999.00")).toBe(false);
  });

  it("prints the full unpaid share on the Share column, or the uploaded share when pending is 0", () => {
    expect(shareDueOnBooks("500.00", "1500.00")).toBe("2000.00");
    expect(shareOnSheet("500.00", "0.00")).toBe("500.00");
    expect(shareOnSheet("500.00", "1000.00")).toBe("1000.00");
    expect(shareOnSheet("500.00", shareDueOnBooks("500.00", "1500.00"))).toBe("2000.00");
    expect(sheetInstallmentTotal("9360.00", "500.00", "2000.00")).toBe("10860.00");
    expect(sheetInstallmentTotal("7745.00", "500.00", "1500.00")).toBe("8745.00");
    expect(sheetInstallmentTotal("3580.00", "500.00", "0.00")).toBe("3580.00");
  });

  it("holds a new loan schedule off this month's principal until next month", () => {
    expect(
      scheduledForOpenPrincipal({
        givenThisMonth: "150.00",
        currentScheduled: "250.00",
        statementPrincipalDue: "100.00",
        unpaidPrincipal: "0.00",
        priorScheduled: "100.00",
      }),
    ).toBe("100.00");
    expect(
      scheduledForOpenPrincipal({
        givenThisMonth: "400.00",
        currentScheduled: "100.00",
        statementPrincipalDue: "0.00",
        unpaidPrincipal: "0.00",
        priorScheduled: "0.00",
      }),
    ).toBe("0.00");
    expect(
      scheduledForOpenPrincipal({
        givenThisMonth: "0.00",
        currentScheduled: "250.00",
        statementPrincipalDue: "100.00",
        unpaidPrincipal: "0.00",
        priorScheduled: "100.00",
      }),
    ).toBe("250.00");
  });

  it("does not add last month's unpaid principal onto this month's Principal column", () => {
    expect(principalDueThisMonth("151500.00", "2500.00")).toBe("2500.00");
    expect(principalDueThisMonth("1500.00", "2500.00")).toBe("1500.00");
  });
});

describe("payment allocation", () => {
  it("sends only collected interest toward the pool", () => {
    const result = calculatePaymentAllocation(
      "3500.00",
      {
        SHARE: "500.00",
        PREVIOUS_INTEREST: "0.00",
        CURRENT_INTEREST: "1000.00",
        PRINCIPAL: "2000.00",
        PENALTY: "0.00",
      },
      ["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"],
    );
    const interest = result.allocations.find((row) => row.component === "CURRENT_INTEREST");
    const principal = result.allocations.find((row) => row.component === "PRINCIPAL");
    expect(interest?.amount).toBe("1000.00");
    expect(principal?.amount).toBe("2000.00");
    expect(result.unapplied).toBe("0.00");
  });

  it("lets a larger deposit repay extra principal without touching the interest split", () => {
    const base = calculatePaymentAllocation(
      "5000.00",
      {
        SHARE: "500.00",
        PREVIOUS_INTEREST: "0.00",
        CURRENT_INTEREST: "1050.00",
        PRINCIPAL: "2000.00",
        PENALTY: "0.00",
      },
      ["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"],
    );
    const result = absorbExtraPrincipal(base.allocations, base.unapplied, "103000.00");
    expect(result.allocations.find((row) => row.component === "CURRENT_INTEREST")?.amount).toBe("1050.00");
    expect(result.allocations.find((row) => row.component === "PRINCIPAL")?.amount).toBe("3450.00");
    expect(result.unapplied).toBe("0.00");
  });

  it("records a zero receipt with nothing allocated", () => {
    const result = calculatePaymentAllocation(
      "0.00",
      {
        SHARE: "500.00",
        PREVIOUS_INTEREST: "0.00",
        CURRENT_INTEREST: "0.00",
        PRINCIPAL: "0.00",
        PENALTY: "0.00",
      },
      ["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"],
    );
    expect(result.totalAllocated).toBe("0.00");
    expect(result.unapplied).toBe("0.00");
    expect(result.allocations.every((row) => row.amount === "0.00")).toBe(true);
  });

  it("can receive only part of the due penalty", () => {
    const result = allocateCollectingPenaltyFirst(
      "530.00",
      {
        SHARE: "500.00",
        PREVIOUS_INTEREST: "0.00",
        CURRENT_INTEREST: "0.00",
        PRINCIPAL: "0.00",
        PENALTY: "200.00",
      },
      ["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"],
      "80.00",
    );
    expect(result.allocations.find((row) => row.component === "PENALTY")?.amount).toBe("80.00");
    expect(result.allocations.find((row) => row.component === "SHARE")?.amount).toBe("450.00");
  });

  it("takes due penalty first when the office chooses to receive it", () => {
    const result = allocateCollectingPenaltyFirst(
      "150.00",
      {
        SHARE: "500.00",
        PREVIOUS_INTEREST: "0.00",
        CURRENT_INTEREST: "0.00",
        PRINCIPAL: "0.00",
        PENALTY: "50.00",
      },
      ["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"],
    );
    expect(result.allocations.find((row) => row.component === "PENALTY")?.amount).toBe("50.00");
    expect(result.allocations.find((row) => row.component === "SHARE")?.amount).toBe("100.00");
    expect(result.unapplied).toBe("0.00");
  });

  it("refuses to invent an allocation order", () => {
    expect(() =>
      calculatePaymentAllocation(
        "500.00",
        {
          SHARE: "500.00",
          PREVIOUS_INTEREST: "0.00",
          CURRENT_INTEREST: "0.00",
          PRINCIPAL: "0.00",
          PENALTY: "0.00",
        },
        [],
      ),
    ).toThrow(/not configured/);
  });
});

describe("equal interest distribution", () => {
  it("splits ₹10,000 across 10 members", () => {
    const result = calculateInterestDistribution("10000.00", 10);
    expect(result.perMember).toBe("1000.00");
    expect(result.totalDistributed).toBe("10000.00");
    expect(result.remaining).toBe("0.00");
  });

  it("splits ₹10,000 across 13 members without creating or losing money", () => {
    const result = calculateInterestDistribution("10000.00", 13);
    expect(result.perMember).toBe("769.23");
    expect(result.totalDistributed).toBe("9999.99");
    expect(result.remaining).toBe("0.01");
    expect(sumMoney([result.totalDistributed, result.remaining])).toBe("10000.00");
  });

  it("does not distribute more than was collected when half-up would overflow", () => {
    const result = calculateInterestDistribution("10470.00", 14);
    expect(result.perMember).toBe("747.85");
    expect(sumMoney([result.totalDistributed, result.remaining])).toBe("10470.00");
    expect(result.roundingModeApplied).toBe("FLOOR_TO_AVOID_CREATING_MONEY");
  });

  it("builds the ten-member worked example from the engine", () => {
    const example = previewWorkedExample();
    expect(example.interestEarned).toBe("10000.00");
    expect(example.members).toBe(10);
    expect(example.yourInterest).toBe("1000.00");
  });

  it("keeps accrued interest out of the distributable pool", () => {
    const pool = calculateInterestPool({
      accrued: "10000.00",
      collected: "8000.00",
      distributed: "0.00",
    });
    expect(pool.pending).toBe("2000.00");
    expect(pool.available).toBe("8000.00");
    expect(() =>
      calculateInterestPool({ accrued: "8000.00", collected: "8000.00", distributed: "8000.01" }),
    ).toThrow(/cannot exceed interest collected/);
  });

  it("uses open-month statements for accrued even when accrual rows double-count", () => {
    const accrued = poolAccruedForDashboard({
      closedPeriods: [],
      openStatements: [{ currentInterest: "10405.00" }],
      events: [
        { kind: "ACCRUAL", memberId: "a", period: "2026-08", amount: "1515.00", createdAt: "2026-08-01" },
        { kind: "ACCRUAL", memberId: "a", period: "2026-08", amount: "1515.00", createdAt: "2026-08-02" },
        { kind: "ACCRUAL", memberId: "b", period: "2026-08", amount: "8890.00", createdAt: "2026-08-01" },
      ],
    });
    expect(accrued).toBe("10405.00");
  });

  it("counts one accrual per member per month for the pool total", () => {
    const total = sumInterestAccrualEvents([
      { kind: "ACCRUAL", memberId: "a", period: "2026-08", amount: "1515.00", createdAt: "2026-08-01" },
      { kind: "ACCRUAL", memberId: "a", period: "2026-08", amount: "1515.00", createdAt: "2026-08-02" },
      { kind: "ACCRUAL", memberId: "b", period: "2026-08", amount: "710.00", createdAt: "2026-08-01" },
      { kind: "ACCRUAL", memberId: "c", period: "2026-08", amount: "4545.00", reason: "Previous interest outstanding on import", createdAt: "2026-08-01" },
    ]);
    expect(total).toBe("2225.00");
  });

  it("does not fail when carried interest is collected after the accrual month", () => {
    const pool = calculateInterestPool({
      accrued: "22555.00",
      collected: "23280.00",
      distributed: "0.00",
    });
    expect(pool.pending).toBe("0.00");
    expect(pool.available).toBe("23280.00");
  });
});

describe("October register reproduced from member rows", () => {
  const plan = buildSocietyPlan();

  it("matches every sheet interest figure at 1% and every installment cross-foot", () => {
    for (const [period, rows] of Object.entries(REGISTER)) {
      const interest = sumMoney(rows.map((row) => calculateCurrentInterest(row.loanOutstanding, "0.01")));
      const shares = sumMoney(rows.map((row) => row.monthlyShare));
      const previous = sumMoney(rows.map((row) => row.previousInterest));
      const principal = sumMoney(rows.map((row) => row.principal));
      const penalty = sumMoney(rows.map((row) => row.penalty));
      const installment = sumMoney(
        rows.map((row) =>
          calculateInstallment({
            monthlyShare: row.monthlyShare,
            previousInterest: row.previousInterest,
            currentInterest: calculateCurrentInterest(row.loanOutstanding, "0.01"),
            principal: row.principal,
            penalty: row.penalty,
          }),
        ),
      );
      const totals = SHEET_TOTALS[period as keyof typeof SHEET_TOTALS];
      expect(interest).toBe(totals.currentInterest);
      expect(shares).toBe(totals.monthlyShare);
      expect(previous).toBe(totals.previousInterest);
      expect(principal).toBe(totals.principal);
      expect(penalty).toBe(totals.penalty);
      expect(installment).toBe(totals.installment);
      expect(sumMoney(rows.map((row) => row.totalShares))).toBe(totals.shares);
      expect(sumMoney(rows.map((row) => row.loanOutstanding))).toBe(totals.loans);
    }
  });

  it("rolls shares, loans, collected interest and capital to the व्याज sheet", () => {
    expect(plan.totals.shares).toBe(INTEREST_SHEET_SUMMARY.shares);
    expect(plan.totals.loansOutstanding).toBe(INTEREST_SHEET_SUMMARY.loans);
    expect(plan.totals.interestCollected).toBe(INTEREST_SHEET_SUMMARY.interest);
    expect(plan.totals.penaltyCollected).toBe(INTEREST_SHEET_SUMMARY.penalty);
    expect(plan.totals.capital).toBe(INTEREST_SHEET_SUMMARY.capital);
    expect(plan.totals.registerResidual).toBe(INTEREST_SHEET_SUMMARY.balance);
    expect(plan.totals.unpaidShares).toBe("7000.00");
    expect(sumMoney([plan.totals.ledgerCash, plan.totals.unpaidShares])).toBe(plan.totals.registerResidual);
    expect(SHEET_TOTALS["2026-10"].installment).toBe("39770.00");
  });

  it("matches collected interest month by month, excluding uncollected October interest", () => {
    for (const [period, expected] of Object.entries(INTEREST_SHEET_COLLECTED)) {
      const collected = sumMoney(
        plan.interestEvents.filter((event) => event.kind === "COLLECTION" && event.period === period).map((event) => event.amount),
      );
      expect(collected).toBe(expected);
    }
    const octoberCollected = plan.interestEvents.filter(
      (event) => event.kind === "COLLECTION" && event.period === "2026-10",
    );
    expect(octoberCollected).toHaveLength(0);
  });

  it("distributes each closed month once and keeps the July rounding remainder", () => {
    const july = plan.distributions.find((distribution) => distribution.period === "2026-07");
    expect(july?.remaining).toBe("0.05");
    expect(sumMoney([july!.totalDistributed, july!.remaining])).toBe("9050.00");
    expect(plan.totals.interestRemaining).toBe("0.05");
    expect(new Set(plan.distributions.map((distribution) => distribution.code)).size).toBe(plan.distributions.length);
  });
});

describe("reconciliation", () => {
  it("reports the difference and does not pretend a mismatch balances", () => {
    const result = reconcile([{ name: "Total installment", expected: "39770.00", calculated: "39270.00" }]);
    expect(result.ok).toBe(false);
    expect(result.checks[0].difference).toBe("500.00");
  });

  it("accepts a month whose formula results match the recorded figures", () => {
    const closing = calculateMonthlyClosing({
      installmentParts: {
        monthlyShare: "7000.00",
        previousInterest: "0.00",
        currentInterest: "10470.00",
        principal: "22000.00",
        penalty: "300.00",
      },
      installmentRecorded: "39770.00",
      openingPrincipal: "100000.00",
      disbursed: "20000.00",
      principalRepaid: "5000.00",
      closingPrincipalRecorded: "115000.00",
      openingShares: "75879.00",
      contributions: "500.00",
      closingSharesRecorded: "76379.00",
      interestCollected: "8000.00",
      interestDistributed: "7000.00",
      openingCash: "1000.00",
      cashCredits: "500.00",
      cashDebits: "200.00",
      closingCashRecorded: "1300.00",
      distributionAvailable: "8000.00",
      distributionDistributed: "7000.00",
      distributionRemaining: "1000.00",
    });
    expect(closing.ok).toBe(true);
  });
});

describe("society cash", () => {
  it("adds credits and subtracts disbursements without mixing in member loan balances", () => {
    expect(
      calculateSocietyBalance({
        opening: "0.00",
        memberContributions: "10000.00",
        principalRecovered: "2000.00",
        interestCollected: "1000.00",
        penaltyCollected: "100.00",
        otherCredits: "0.00",
        loanDisbursements: "8000.00",
        withdrawals: "500.00",
        refunds: "0.00",
      }),
    ).toBe("4600.00");
  });

  it("counts share arrears collected later as cash, not the share-register cashEffect", () => {
    const books = societyBalanceFromLedger([
      { type: "MEMBER_CONTRIBUTION", cashEffect: "IN", credit: "5300.00", debit: "0.00" },
      { type: "MEMBER_CONTRIBUTION", cashEffect: "IN", credit: "500.00", debit: "0.00" },
    ]);
    expect(books.expected).toBe("5800.00");
    expect(books.calculated).toBe("5800.00");
    expect(
      calculateSocietyBalance({
        opening: "0.00",
        memberContributions: "5300.00",
        principalRecovered: "0.00",
        interestCollected: "0.00",
        penaltyCollected: "0.00",
        otherCredits: "0.00",
        loanDisbursements: "0.00",
        withdrawals: "0.00",
        refunds: "0.00",
      }),
    ).toBe("5300.00");
  });

  it("keeps society balance matching when an adjustment also came in", () => {
    const books = societyBalanceFromLedger([
      { type: "MEMBER_CONTRIBUTION", cashEffect: "IN", credit: "4100.00", debit: "0.00" },
      { type: "ADJUSTMENT", cashEffect: "IN", credit: "300.00", debit: "0.00" },
    ]);
    expect(books.expected).toBe("4400.00");
    expect(books.calculated).toBe("4400.00");
  });

  it("nets a removed receipt so society cash does not keep the mistaken collection", () => {
    const books = societyBalanceFromLedger([
      { type: "MEMBER_CONTRIBUTION", cashEffect: "IN", credit: "500.00", debit: "0.00" },
      { type: "MEMBER_CONTRIBUTION", cashEffect: "OUT", credit: "0.00", debit: "500.00" },
      { type: "INTEREST_COLLECTION", cashEffect: "IN", credit: "200.00", debit: "0.00" },
    ]);
    expect(books.expected).toBe("200.00");
    expect(books.calculated).toBe("200.00");
  });
});
