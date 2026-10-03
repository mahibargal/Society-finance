import { describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { paymentReceiptNoteLines } from "./payment-receipt-notes.js";

describe("payment receipt notes", () => {
  it("includes next-month penalty and remaining penalty on the books month", async () => {
    const payment = await prisma.payment.findFirst({
      where: { status: "RECORDED" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) return;
    const lines = await paymentReceiptNoteLines({
      id: payment.id,
      societyId: payment.societyId,
      memberId: payment.memberId,
      period: payment.period,
      receiptNo: payment.receiptNo,
      createdAt: payment.createdAt,
      reason: payment.reason,
      note: payment.note ?? "",
    });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((line) => line.includes("Next month penalty added"))).toBe(true);
    expect(lines.some((line) => line.includes("Previous penalty remaining"))).toBe(true);
  });
});
