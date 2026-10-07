import { describe, expect, it } from "vitest";
import {
  buildCollectedLines,
  buildReceiptStorageNote,
  parseReceiptMeta,
  receiptPaidInFull,
} from "./payment-receipt-presentation.js";

const statement = {
  shareCashPending: "0.00" as unknown as import("@prisma/client").Prisma.Decimal,
  arrearsCash: "0.00" as unknown as import("@prisma/client").Prisma.Decimal,
  monthlyShare: "500.00" as unknown as import("@prisma/client").Prisma.Decimal,
  previousInterest: "0.00" as unknown as import("@prisma/client").Prisma.Decimal,
  currentInterest: "30.00" as unknown as import("@prisma/client").Prisma.Decimal,
  principalDue: "150.00" as unknown as import("@prisma/client").Prisma.Decimal,
  penalty: "0.00" as unknown as import("@prisma/client").Prisma.Decimal,
};

describe("payment receipt presentation", () => {
  it("splits share lines and records no pending when fully paid", () => {
    const allocations = [
      { component: "SHARE", amount: "500.00" },
      { component: "CURRENT_INTEREST", amount: "30.00" },
      { component: "PRINCIPAL", amount: "150.00" },
    ];
    const lines = buildCollectedLines(allocations, { monthly: "500.00", arrear: "0.00" });
    expect(lines.map((row) => row.label)).toEqual([
      "Monthly share",
      "Interest on the loan",
      "Principal repaid",
    ]);
    const note = buildReceiptStorageNote({
      statement,
      paidBefore: {},
      allocations,
      shareSplit: { monthly: "500.00", arrear: "0.00" },
    });
    const { meta } = parseReceiptMeta(note);
    expect(meta).not.toBeNull();
    expect(receiptPaidInFull(meta!.pending)).toBe(true);
    expect(meta!.pending.installment).toBe("0.00");
    expect(meta!.pending.principal).toBe("0.00");
  });

  it("records installment and principal still pending after a partial receipt", () => {
    const note = buildReceiptStorageNote({
      statement,
      paidBefore: {},
      allocations: [
        { component: "SHARE", amount: "500.00" },
        { component: "CURRENT_INTEREST", amount: "30.00" },
      ],
      shareSplit: { monthly: "500.00", arrear: "0.00" },
      nextMonthPenalty: "100.00",
    });
    const { meta } = parseReceiptMeta(note);
    expect(meta!.pending.installment).toBe("0.00");
    expect(meta!.pending.principal).toBe("150.00");
    expect(meta!.pending.nextMonthPenalty).toBe("100.00");
    expect(receiptPaidInFull(meta!.pending)).toBe(false);
  });
});
