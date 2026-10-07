import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { monthCollectionStatusForRow } from "./read.js";

const dec = (value: string) => new Prisma.Decimal(value);

function statementRow(overrides: Partial<{
  memberId: string;
  shareCashPending: string;
  arrearsCash: string;
  previousInterest: string;
  currentInterest: string;
  principalDue: string;
  penalty: string;
}>) {
  return {
    memberId: "m1",
    member: { memberNumber: 1, name: "Test" },
    shareCashPending: dec("0.00"),
    arrearsCash: dec("0.00"),
    monthlyShare: dec("500.00"),
    previousInterest: dec("0.00"),
    currentInterest: dec("30.00"),
    principalDue: dec("150.00"),
    penalty: dec("0.00"),
    totalInstallment: dec("680.00"),
    ...overrides,
    shareCashPending: dec(overrides.shareCashPending ?? "0.00"),
    arrearsCash: dec(overrides.arrearsCash ?? "0.00"),
    previousInterest: dec(overrides.previousInterest ?? "0.00"),
    currentInterest: dec(overrides.currentInterest ?? "30.00"),
    principalDue: dec(overrides.principalDue ?? "150.00"),
    penalty: dec(overrides.penalty ?? "0.00"),
  } as Parameters<typeof monthCollectionStatusForRow>[0];
}

describe("month collection status", () => {
  it("is pending without a receipt", () => {
    const row = statementRow({});
    const status = monthCollectionStatusForRow(row, [], new Map());
    expect(status).toBe("pending");
  });

  it("is collected when receipt clears all dues on the statement", () => {
    const row = statementRow({});
    const payments = [
      {
        memberId: "m1",
        amount: dec("680.00"),
        allocations: [
          { component: "SHARE", amount: dec("500.00") },
          { component: "CURRENT_INTEREST", amount: dec("30.00") },
          { component: "PRINCIPAL", amount: dec("150.00") },
        ],
      },
    ] as Parameters<typeof monthCollectionStatusForRow>[1];
    const paidMap = new Map([
      [
        "m1",
        {
          sharePaid: "500.00",
          previousInterestPaid: "0.00",
          currentInterestPaid: "30.00",
          principalPaid: "150.00",
          penaltyPaid: "0.00",
          totalReceived: "680.00",
        },
      ],
    ]);
    expect(monthCollectionStatusForRow(row, payments, paidMap)).toBe("collected");
  });

  it("is partial when a receipt exists but dues remain", () => {
    const row = statementRow({});
    const payments = [
      {
        memberId: "m1",
        amount: dec("530.00"),
        allocations: [
          { component: "SHARE", amount: dec("500.00") },
          { component: "CURRENT_INTEREST", amount: dec("30.00") },
        ],
      },
    ] as Parameters<typeof monthCollectionStatusForRow>[1];
    const paidMap = new Map([
      [
        "m1",
        {
          sharePaid: "500.00",
          previousInterestPaid: "0.00",
          currentInterestPaid: "30.00",
          principalPaid: "0.00",
          penaltyPaid: "0.00",
          totalReceived: "530.00",
        },
      ],
    ]);
    expect(monthCollectionStatusForRow(row, payments, paidMap)).toBe("partial");
  });
});
