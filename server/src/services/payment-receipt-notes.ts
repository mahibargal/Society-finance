import { isZero, money, sumMoney, subtractMoney } from "../engine/finance.js";
import { formatINR, monthLabel, nextPeriod } from "../lib/format.js";
import { str } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";

type ReceiptPayment = {
  id: string;
  societyId: string;
  memberId: string;
  period: string;
  receiptNo: string;
  createdAt: Date;
  reason: string;
  note: string;
};

function formatReceiptMoney(value: string) {
  return formatINR(value).replace("₹", "Rs. ");
}

/** Lines for the receipt Notes box: reason, next-month penalty, penalty still due after this receipt. */
export async function paymentReceiptNoteLines(payment: ReceiptPayment): Promise<string[]> {
  const lines: string[] = [];
  lines.push(payment.reason.trim() || "Payment recorded in the society books.");
  if (payment.note.trim()) lines.push(payment.note.trim());

  const next = nextPeriod(payment.period);
  const nextMonthRows = await prisma.penalty.findMany({
    where: {
      societyId: payment.societyId,
      memberId: payment.memberId,
      period: next,
      source: "NEXT_MONTH",
      OR: [
        { reason: { contains: payment.receiptNo } },
        {
          createdAt: {
            gte: new Date(payment.createdAt.getTime() - 5000),
            lte: new Date(payment.createdAt.getTime() + 60_000),
          },
        },
      ],
    },
  });
  const nextMonthAdded = sumMoney(nextMonthRows.map((row) => str(row.amount)));
  lines.push(
    !isZero(nextMonthAdded)
      ? `Next month penalty added (${monthLabel(next)}): ${formatReceiptMoney(nextMonthAdded)}`
      : `Next month penalty added (${monthLabel(next)}): None`,
  );

  const remaining = await penaltyRemainingAfterReceipt(payment);
  lines.push(
    !isZero(remaining)
      ? `Previous penalty remaining (${monthLabel(payment.period)}): ${formatReceiptMoney(remaining)}`
      : `Previous penalty remaining (${monthLabel(payment.period)}): None`,
  );

  return lines;
}

async function penaltyRemainingAfterReceipt(payment: ReceiptPayment): Promise<string> {
  const statement = await prisma.memberMonth.findUnique({
    where: {
      societyId_memberId_period: {
        societyId: payment.societyId,
        memberId: payment.memberId,
        period: payment.period,
      },
    },
  });
  if (!statement) return "0.00";

  const payments = await prisma.payment.findMany({
    where: {
      societyId: payment.societyId,
      memberId: payment.memberId,
      period: payment.period,
      status: "RECORDED",
      createdAt: { lte: payment.createdAt },
    },
    include: { allocations: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  let penaltyPaid = "0.00";
  for (const row of payments) {
    for (const allocation of row.allocations) {
      if (allocation.component === "PENALTY") {
        penaltyPaid = sumMoney([penaltyPaid, str(allocation.amount)]);
      }
    }
  }

  let remaining = subtractMoney(str(statement.penalty), penaltyPaid);
  if (money(remaining).isNegative()) remaining = "0.00";
  return remaining;
}
