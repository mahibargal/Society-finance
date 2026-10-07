import { isZero, money, shareDueOnBooks, shareOnSheet, subtractMoney, sumMoney } from "../engine/finance.js";
import { formatINR, monthLabel, nextPeriod } from "../lib/format.js";
import { str } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import {
  pendingFromMeta,
  type ReceiptPending,
  parseReceiptMeta,
  receiptPaidInFull,
} from "./payment-receipt-presentation.js";

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

async function pendingAfterReceiptFallback(payment: ReceiptPayment): Promise<ReceiptPending> {
  const statement = await prisma.memberMonth.findUnique({
    where: {
      societyId_memberId_period: {
        societyId: payment.societyId,
        memberId: payment.memberId,
        period: payment.period,
      },
    },
  });
  if (!statement) {
    return { installment: "0.00", principal: "0.00", nextMonthPenalty: "0.00" };
  }

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

  const paid: Record<string, string> = {};
  for (const row of payments) {
    for (const allocation of row.allocations) {
      paid[allocation.component] = sumMoney([paid[allocation.component] ?? "0.00", str(allocation.amount)]);
    }
  }

  const shareDue = shareDueOnBooks(str(statement.shareCashPending), str(statement.arrearsCash));
  const share = shareOnSheet(str(statement.monthlyShare), shareDue);
  const installmentDue = sumMoney([
    share,
    str(statement.previousInterest),
    str(statement.currentInterest),
    str(statement.penalty),
  ]);
  const paidInstallment = sumMoney([
    paid.SHARE ?? "0.00",
    paid.PREVIOUS_INTEREST ?? "0.00",
    paid.CURRENT_INTEREST ?? "0.00",
    paid.PENALTY ?? "0.00",
  ]);
  let installmentLeft = subtractMoney(installmentDue, paidInstallment);
  if (money(installmentLeft).isNegative()) installmentLeft = "0.00";

  let principalLeft = subtractMoney(str(statement.principalDue), paid.PRINCIPAL ?? "0.00");
  if (money(principalLeft).isNegative()) principalLeft = "0.00";

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

  return {
    installment: installmentLeft,
    principal: principalLeft,
    nextMonthPenalty: nextMonthAdded,
  };
}

function pendingNoteLines(pending: ReceiptPending, period: string): string[] {
  const lines: string[] = [];
  const next = nextPeriod(period);
  if (!isZero(pending.installment)) {
    lines.push(`${formatReceiptMoney(pending.installment)} unpaid installment added to ${monthLabel(next)}`);
  }
  if (!isZero(pending.principal)) {
    lines.push(`${formatReceiptMoney(pending.principal)} principal still due on the loan`);
  }
  if (!isZero(pending.nextMonthPenalty)) {
    lines.push(
      `${formatReceiptMoney(pending.nextMonthPenalty)} penalty for ${monthLabel(next)} (not collected on this receipt)`,
    );
  }
  if (lines.length === 0) {
    lines.push("Nothing pending — full due for this month was collected on this receipt.");
  }
  return lines;
}

/** Lines for the receipt Notes box: pending carry, reason, and penalty context. */
export async function paymentReceiptNoteLines(payment: ReceiptPayment): Promise<string[]> {
  const pending = pendingFromMeta(payment.note) ?? (await pendingAfterReceiptFallback(payment));
  const { userNote } = parseReceiptMeta(payment.note);

  const lines: string[] = [];
  lines.push("Pending / added next month");
  lines.push(...pendingNoteLines(pending, payment.period));
  lines.push("");
  lines.push(`Reason: ${payment.reason.trim() || "Payment recorded in the society books."}`);
  if (userNote) lines.push(userNote);

  const next = nextPeriod(payment.period);
  const remaining = await penaltyRemainingAfterReceipt(payment);
  lines.push(
    !isZero(remaining)
      ? `Penalty still due on ${monthLabel(payment.period)} after this receipt: ${formatReceiptMoney(remaining)}`
      : `Penalty still due on ${monthLabel(payment.period)} after this receipt: None`,
  );

  return lines;
}

export async function paymentReceiptPaidInFull(payment: ReceiptPayment): Promise<boolean> {
  const pending = pendingFromMeta(payment.note) ?? (await pendingAfterReceiptFallback(payment));
  return receiptPaidInFull(pending);
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
