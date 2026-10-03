import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import type { AuthUser } from "../middleware/auth.js";
import {
  ALLOCATION_COMPONENTS,
  type AllocationComponent,
  absorbExtraPrincipal,
  allocateCollectingPenaltyFirst,
  assertAllocationOrder,
  assertExplicitAllocation,
  calculateClosingShares,
  calculateCurrentInterest,
  calculateInstallment,
  splitImportedShareDue,
  calculateInterestDistribution,
  calculateInterestPool,
  calculateInterestOutstanding,
  calculateLoanBalance,
  calculatePaymentAllocation,
  calculatePenalty,
  deriveLoanStatus,
  isZero,
  money,
  principalDueThisMonth,
  scheduledForOpenPrincipal,
  shareDueOnBooks,
  netLedgerByType,
  reconcile,
  societyBalanceFromLedger,
  sumInterestAccrualEvents,
  sumMoney,
  subtractMoney,
} from "../engine/finance.js";
import {
  calendarPeriod,
  formatINR,
  importEarliestPeriod,
  monthLabel,
  nextPeriod,
  previousPeriod,
  statementDateFor,
  utcDate,
} from "../lib/format.js";
import { normalizeMobile } from "../lib/phone.js";
import { HttpError } from "../lib/http.js";
import { dec, str } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";

type Tx = Prisma.TransactionClient;

const emptyPaid = (): Record<AllocationComponent, string> => ({
  SHARE: "0.00",
  PREVIOUS_INTEREST: "0.00",
  CURRENT_INTEREST: "0.00",
  PRINCIPAL: "0.00",
  PENALTY: "0.00",
});

export async function audit(
  tx: Tx,
  auth: AuthUser,
  action: string,
  entityType: string,
  entityId: string,
  reason: string,
  oldValue?: unknown,
  newValue?: unknown,
) {
  await tx.auditLog.create({
    data: {
      societyId: auth.societyId,
      actorId: auth.userId,
      actorName: auth.name,
      action,
      entityType,
      entityId,
      reason,
      oldValue: oldValue === undefined ? undefined : (oldValue as Prisma.InputJsonValue),
      newValue: newValue === undefined ? undefined : (newValue as Prisma.InputJsonValue),
    },
  });
}

export async function notify(
  tx: Tx,
  input: {
    societyId: string;
    userId?: string | null;
    memberId?: string | null;
    paymentId?: string | null;
    type: string;
    title: string;
    body: string;
  },
) {
  await tx.notification.create({
    data: {
      societyId: input.societyId,
      userId: input.userId ?? null,
      memberId: input.memberId ?? null,
      paymentId: input.paymentId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
    },
  });
}

async function cashLedger(
  tx: Tx,
  auth: AuthUser,
  input: {
    memberId?: string | null;
    date: string;
    period: string;
    type: "MEMBER_CONTRIBUTION" | "LOAN_DISBURSEMENT" | "PRINCIPAL_REPAYMENT" | "INTEREST_COLLECTION" | "INTEREST_DISTRIBUTION" | "PENALTY_COLLECTION" | "WITHDRAWAL" | "REFUND" | "ADJUSTMENT" | "REVERSAL" | "INTEREST_ACCRUAL";
    direction: "IN" | "OUT" | "NONE";
    amount: string;
    reference: string;
    reason: string;
  },
) {
  const amount = money(input.amount).abs().toFixed(2);
  if (amount === "0.00") return;
  await tx.ledgerEntry.create({
    data: {
      societyId: auth.societyId,
      memberId: input.memberId ?? null,
      date: utcDate(input.date),
      period: input.period,
      type: input.type,
      debit: dec(input.direction === "OUT" ? amount : "0.00"),
      credit: dec(input.direction === "IN" ? amount : "0.00"),
      amount: dec(amount),
      cashEffect: input.direction,
      reference: input.reference,
      reason: input.reason,
      createdById: auth.userId,
    },
  });
}

async function shareAssessmentRoom(tx: Tx, societyId: string, memberId: string) {
  const assessments = await tx.shareTransaction.findMany({ where: { societyId, memberId } });
  return sumMoney(
    assessments.map((row) => {
      const room = subtractMoney(str(row.amount), str(row.cashEffect));
      return money(room).greaterThan(0) ? room : "0.00";
    }),
  );
}

/** Unpaid share from the sheet (this month plus arrears) must have assessment room before cash can settle it. */
async function ensureShareAssessmentRoom(
  tx: Tx,
  societyId: string,
  memberId: string,
  period: string,
  needed: string,
  createdById: string,
) {
  if (isZero(needed) || money(needed).lessThanOrEqualTo(0)) return;
  const room = await shareAssessmentRoom(tx, societyId, memberId);
  if (money(needed).lessThanOrEqualTo(money(room))) return;
  const gap = subtractMoney(needed, room);
  const existing = await tx.shareTransaction.findFirst({
    where: { societyId, memberId, period, reference: `SHARE-ARREARS-${period}` },
  });
  if (existing) {
    await tx.shareTransaction.update({
      where: { id: existing.id },
      data: { amount: dec(sumMoney([str(existing.amount), gap])) },
    });
    return;
  }
  await tx.shareTransaction.create({
    data: {
      societyId,
      memberId,
      date: utcDate(statementDateFor(period)),
      period,
      amount: dec(gap),
      cashEffect: dec("0.00"),
      reason: "Unpaid share brought forward. Cash is recorded when the installment is collected.",
      reference: `SHARE-ARREARS-${period}`,
      createdById,
    },
  });
}

async function applyShareCash(
  tx: Tx,
  societyId: string,
  memberId: string,
  amount: string,
  mode: "strict" | "heal" = "strict",
  createdById?: string,
) {
  if (mode === "strict" && createdById) {
    const open = await tx.accountingMonth.findFirst({ where: { societyId, status: "OPEN" }, orderBy: { period: "desc" } });
    const period = open?.period
      ?? (await tx.shareTransaction.findFirst({ where: { societyId, memberId }, orderBy: { period: "desc" } }))?.period;
    if (period) await ensureShareAssessmentRoom(tx, societyId, memberId, period, amount, createdById);
  }
  let left = amount;
  const assessments = await tx.shareTransaction.findMany({
    where: { societyId, memberId },
    orderBy: [{ period: "asc" }, { createdAt: "asc" }],
  });
  for (const assessment of assessments) {
    if (isZero(left)) break;
    const room = subtractMoney(str(assessment.amount), str(assessment.cashEffect));
    if (money(room).lessThanOrEqualTo(0)) continue;
    const applied = money(left).lessThan(room) ? left : room;
    await tx.shareTransaction.update({
      where: { id: assessment.id },
      data: { cashEffect: dec(sumMoney([str(assessment.cashEffect), applied])) },
    });
    left = subtractMoney(left, applied);
  }
  if (!isZero(left) && mode === "strict") throw new HttpError(409, "There is no share assessment to settle");
}

async function unapplyShareCash(tx: Tx, societyId: string, memberId: string, amount: string) {
  let left = amount;
  const assessments = await tx.shareTransaction.findMany({
    where: { societyId, memberId },
    orderBy: [{ period: "desc" }, { createdAt: "desc" }],
  });
  for (const assessment of assessments) {
    if (isZero(left)) break;
    const available = str(assessment.cashEffect);
    if (money(available).lessThanOrEqualTo(0)) continue;
    const applied = money(left).lessThan(available) ? left : available;
    await tx.shareTransaction.update({
      where: { id: assessment.id },
      data: { cashEffect: dec(subtractMoney(available, applied)) },
    });
    left = subtractMoney(left, applied);
  }
  if (!isZero(left)) throw new HttpError(409, "This receipt's share cash could not be unwound");
}

async function societyCashOnBooks(tx: Tx, societyId: string) {
  const ledger = await tx.ledgerEntry.findMany({ where: { societyId } });
  const cashIn = sumMoney(ledger.filter((row) => row.cashEffect === "IN").map((row) => str(row.credit)));
  const cashOut = sumMoney(ledger.filter((row) => row.cashEffect === "OUT").map((row) => str(row.debit)));
  return subtractMoney(cashIn, cashOut);
}

async function shareCashReceivedInPeriod(tx: Tx, societyId: string, memberId: string, period: string) {
  const member = await tx.member.findUnique({ where: { id: memberId }, select: { shareBooksFromPeriod: true } });
  if (member?.shareBooksFromPeriod && period < member.shareBooksFromPeriod) return "0.00";
  const payments = await tx.payment.findMany({
    where: { societyId, memberId, period, status: "RECORDED" },
    include: { allocations: true },
  });
  return sumMoney(
    payments.flatMap((payment) =>
      payment.allocations.filter((row) => row.component === "SHARE").map((row) => str(row.amount)),
    ),
  );
}

/** Interest/penalty pool paid as share (not installment cash) credits the register in that month. */
async function sharePoolCreditsInPeriod(tx: Tx, societyId: string, memberId: string, period: string) {
  const rows = await tx.shareTransaction.findMany({
    where: {
      societyId,
      memberId,
      period,
      reference: { startsWith: "DIST-" },
    },
  });
  return sumMoney(rows.map((row) => str(row.cashEffect)));
}

/** Share cash collected in one month is booked on the following month's register row. */
async function shareMovementForStatement(tx: Tx, societyId: string, memberId: string, period: string) {
  const from = previousPeriod(period);
  if (!/^\d{4}-\d{2}$/.test(from)) return "0.00";
  return shareCashReceivedInPeriod(tx, societyId, memberId, from);
}

async function shareMovementOnStatement(tx: Tx, societyId: string, memberId: string, period: string) {
  const installmentShare = await shareMovementForStatement(tx, societyId, memberId, period);
  const poolShare = await sharePoolCreditsInPeriod(tx, societyId, memberId, period);
  return sumMoney([installmentShare, poolShare]);
}

/** Rebuild share columns: movement comes from the previous month's share receipts, not the same month. */
async function rebuildMemberStatementShares(tx: Tx, societyId: string, memberId: string, resetFromPeriod?: string) {
  const member = await tx.member.findUnique({
    where: { id: memberId },
    select: { status: true, shareBooksFromPeriod: true },
  });
  if (member?.status === "INACTIVE") return;
  const chainFrom = resetFromPeriod ?? member?.shareBooksFromPeriod ?? null;
  const statements = await tx.memberMonth.findMany({
    where: { societyId, memberId },
    orderBy: { period: "asc" },
  });
  let previousClosing: string | null = null;
  for (const statement of statements) {
    if (chainFrom && statement.period < chainFrom) {
      continue;
    }
    if (chainFrom && statement.period === chainFrom) {
      previousClosing = null;
    }
    const imported = await tx.shareTransaction.findFirst({
      where: {
        societyId,
        memberId,
        period: statement.period,
        reference: { startsWith: "IMPORT-SHARE" },
      },
    });
    if (imported && previousClosing === null) {
      previousClosing = str(statement.closingShares);
      continue;
    }
    const opening = previousClosing ?? str(statement.openingShares);
    let receipts = await shareMovementOnStatement(tx, societyId, memberId, statement.period);
    if (chainFrom && statement.period === chainFrom) {
      receipts = await sharePoolCreditsInPeriod(tx, societyId, memberId, statement.period);
    }
    const closing = sumMoney([opening, receipts]);
    await tx.memberMonth.update({
      where: { id: statement.id },
      data: {
        openingShares: dec(opening),
        shareMovement: dec(receipts),
        closingShares: dec(closing),
      },
    });
    previousClosing = closing;
  }
  const lastClosing = previousClosing ?? "0.00";
  const register = sumMoney(
    (await tx.shareTransaction.findMany({ where: { societyId, memberId } })).map((row) => str(row.cashEffect)),
  );
  const gap = subtractMoney(lastClosing, register);
  if (money(gap).greaterThan(0)) {
    const imported = await tx.shareTransaction.findFirst({
      where: { societyId, memberId, reference: { startsWith: "IMPORT-SHARE" } },
      orderBy: { period: "asc" },
    });
    if (imported) {
      await tx.shareTransaction.update({
        where: { id: imported.id },
        data: {
          amount: dec(sumMoney([str(imported.amount), gap])),
          cashEffect: dec(sumMoney([str(imported.cashEffect), gap])),
        },
      });
    }
  }
}

async function healStatementShareCapital(tx: Tx, societyId: string) {
  const members = await tx.member.findMany({ where: { societyId, status: "ACTIVE" }, select: { id: true } });
  for (const member of members) {
    await rebuildMemberStatementShares(tx, societyId, member.id);
    await refreshMember(tx, member.id);
  }
}

export async function refreshMember(tx: Tx, memberId: string) {
  const memberRow = await tx.member.findUnique({ where: { id: memberId }, select: { status: true } });
  if (memberRow?.status === "INACTIVE") {
    for (const row of await tx.shareTransaction.findMany({ where: { memberId } })) {
      if (!isZero(str(row.cashEffect))) {
        await tx.shareTransaction.update({ where: { id: row.id }, data: { cashEffect: dec("0.00") } });
      }
    }
    await tx.member.update({ where: { id: memberId }, data: { ...zeroMemberMoneyFields } });
    return;
  }
  const [shares, loans, credits, withdrawals] = await Promise.all([
    tx.shareTransaction.findMany({ where: { memberId } }),
    tx.loan.findMany({ where: { memberId, status: { not: "CANCELLED" } } }),
    tx.interestDistributionEntry.findMany({
      where: {
        memberId,
        status: { in: ["CREDITED", "ADDED_TO_SHARES", "PAID_CASH"] },
        distribution: { status: "CONFIRMED" },
      },
    }),
    tx.ledgerEntry.findMany({ where: { memberId, type: "WITHDRAWAL", cashEffect: "OUT" } }),
  ]);
  const shareBalance = sumMoney(shares.map((row) => str(row.cashEffect)));
  const loanOutstanding = sumMoney(loans.map((row) => str(row.outstandingPrincipal)));
  const interestEarned = sumMoney(credits.map((row) => str(row.amount)));
  const creditedOnly = sumMoney(credits.filter((row) => row.status === "CREDITED").map((row) => str(row.amount)));
  const poolCashPaid = sumMoney(
    credits
      .filter((row) => row.status === "PAID_CASH" || row.payoutMethod === "CASH")
      .map((row) => str(row.amount)),
  );
  const walletWithdrawals = withdrawals.filter((row) => !String(row.reference ?? "").startsWith("DIST-"));
  const interestWithdrawnWallet = sumMoney(walletWithdrawals.map((row) => str(row.amount)));
  const interestWithdrawn = sumMoney([interestWithdrawnWallet, poolCashPaid]);
  const interestBalance = subtractMoney(creditedOnly, interestWithdrawnWallet);
  await tx.member.update({
    where: { id: memberId },
    data: {
      shareBalance: dec(shareBalance),
      loanOutstanding: dec(loanOutstanding),
      interestEarned: dec(interestEarned),
      interestWithdrawn: dec(interestWithdrawn),
      interestBalance: dec(interestBalance),
    },
  });
}

const zeroMemberMoneyFields = {
  shareBalance: dec("0.00"),
  loanOutstanding: dec("0.00"),
  interestEarned: dec("0.00"),
  interestWithdrawn: dec("0.00"),
  interestBalance: dec("0.00"),
} as const;

function inactiveMemberNeedsPurge(
  balances: { shareBalance: unknown; loanOutstanding: unknown; interestBalance: unknown; interestEarned: unknown; interestWithdrawn: unknown },
  register: string,
) {
  if (money(register).greaterThan(0)) return true;
  return (
    money(str(balances.shareBalance)).greaterThan(0) ||
    money(str(balances.loanOutstanding)).greaterThan(0) ||
    money(str(balances.interestBalance)).greaterThan(0) ||
    money(str(balances.interestEarned)).greaterThan(0) ||
    money(str(balances.interestWithdrawn)).greaterThan(0)
  );
}

/** Inactive members are fully settled on exit; clear any stale register or wallet balances. */
export async function purgeInactiveMemberBalances(societyId: string) {
  const inactive = await prisma.member.findMany({
    where: { societyId, status: "INACTIVE" },
    select: {
      id: true,
      shareBalance: true,
      loanOutstanding: true,
      interestBalance: true,
      interestEarned: true,
      interestWithdrawn: true,
      exitedAt: true,
      updatedAt: true,
    },
  });
  if (inactive.length === 0) return;
  const missingExit = inactive.filter((row) => !row.exitedAt);
  if (missingExit.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of missingExit) {
        await tx.member.update({ where: { id: row.id }, data: { exitedAt: row.updatedAt } });
      }
    });
  }
  const fixIds: string[] = [];
  for (const member of inactive) {
    const txns = await prisma.shareTransaction.findMany({ where: { societyId, memberId: member.id } });
    const register = sumMoney(txns.map((row) => str(row.cashEffect)));
    if (inactiveMemberNeedsPurge(member, register)) {
      fixIds.push(member.id);
    }
  }
  if (fixIds.length === 0) return;
  await prisma.$transaction(async (tx) => {
    for (const memberId of fixIds) {
      for (const row of await tx.shareTransaction.findMany({ where: { societyId, memberId } })) {
        if (!isZero(str(row.cashEffect))) {
          await tx.shareTransaction.update({ where: { id: row.id }, data: { cashEffect: dec("0.00") } });
        }
      }
      await tx.member.update({ where: { id: memberId }, data: { ...zeroMemberMoneyFields } });
    }
  });
}

function sumShareRegisterForStatus(societyId: string, status: "ACTIVE" | "INACTIVE") {
  return prisma.shareTransaction.findMany({
    where: { societyId, member: { status } },
  });
}

/** Member capital on the home screen — share register cash for active members only. */
export async function sumActiveMemberShareCapital(societyId: string) {
  await purgeInactiveMemberBalances(societyId);
  const rows = await sumShareRegisterForStatus(societyId, "ACTIVE");
  return sumMoney(rows.map((row) => str(row.cashEffect)));
}

export async function openMonth(societyId: string) {
  await ensureManualOpenIsCurrent(societyId);
  const month = await prisma.accountingMonth.findFirst({
    where: { societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!month) throw new HttpError(409, "There is no open month");
  return month;
}

export async function assertPeriodOpen(societyId: string, period: string, action = "change that month") {
  const month = await prisma.accountingMonth.findUnique({ where: { societyId_period: { societyId, period } } });
  if (month?.status === "CLOSED") {
    throw new HttpError(409, `${monthLabel(period)} is closed. Its books and reports stay as they were saved.`);
  }
}

const zeroUnpaidCarry = { share: "0.00", interest: "0.00", penalty: "0.00", principal: "0.00" };

/** Drop share chain carry so a returning member does not inherit capital that was paid out on exit. */
async function clearShareChainTipForExit(tx: Tx, societyId: string, memberId: string, exitPeriod: string) {
  const periods = [exitPeriod];
  const prev = previousPeriod(exitPeriod);
  if (/^\d{4}-\d{2}$/.test(prev)) periods.push(prev);
  await tx.memberMonth.updateMany({
    where: { societyId, memberId, period: { in: periods } },
    data: { openingShares: dec("0.00"), closingShares: dec("0.00"), shareMovement: dec("0.00") },
  });
}

async function prepareMemberReentry(tx: Tx, auth: AuthUser, memberId: string, openPeriod: string) {
  await clearShareChainTipForExit(tx, auth.societyId, memberId, openPeriod);
  const existing = await tx.memberMonth.findUnique({
    where: { societyId_memberId_period: { societyId: auth.societyId, memberId, period: openPeriod } },
  });
  if (existing) await tx.memberMonth.delete({ where: { id: existing.id } });
}

/** Drop pre-rejoin member rows; closed month society reports use frozen snapshots saved at month close. Ledger stays for cash audit. */
async function purgeMemberBooksBeforePeriod(tx: Tx, societyId: string, memberId: string, period: string) {
  const oldPayments = await tx.payment.findMany({
    where: { societyId, memberId, period: { lt: period } },
    select: { id: true },
  });
  if (oldPayments.length > 0) {
    await tx.paymentAllocation.deleteMany({ where: { paymentId: { in: oldPayments.map((row) => row.id) } } });
    await tx.payment.deleteMany({ where: { id: { in: oldPayments.map((row) => row.id) } } });
  }
  await tx.memberMonth.deleteMany({ where: { societyId, memberId, period: { lt: period } } });
  await tx.shareTransaction.deleteMany({ where: { societyId, memberId, period: { lt: period } } });
  await tx.penalty.deleteMany({ where: { societyId, memberId, period: { lt: period } } });
  const loans = await tx.loan.findMany({ where: { societyId, memberId }, select: { id: true } });
  for (const loan of loans) {
    await tx.loanTransaction.deleteMany({ where: { loanId: loan.id } });
    await tx.loan.delete({ where: { id: loan.id } });
  }
}

/** Members added during an open month have no register row yet. Assess their monthly share so a payment can be collected. Interest and principal start on the next statement. Unpaid dues from a previous statement are carried in. */
export async function ensureMemberStatement(
  tx: Tx,
  auth: AuthUser,
  memberId: string,
  period: string,
  options?: { reentry?: boolean },
) {
  const member = await tx.member.findFirst({ where: { id: memberId, societyId: auth.societyId, status: "ACTIVE" } });
  if (!member) return null;
  const reentry = options?.reentry === true;
  const existing = await tx.memberMonth.findUnique({
    where: { societyId_memberId_period: { societyId: auth.societyId, memberId, period } },
  });
  if (existing && money(str(existing.totalInstallment)).greaterThan(0) && !reentry) return existing;
  const month = await tx.accountingMonth.findUnique({
    where: { societyId_period: { societyId: auth.societyId, period } },
  });
  if (!month || month.status !== "OPEN") return null;

  const priorStatement = reentry
    ? null
    : await tx.memberMonth.findUnique({
        where: { societyId_memberId_period: { societyId: auth.societyId, memberId, period: previousPeriod(period) } },
      });
  const openingShares = reentry ? "0.00" : priorStatement ? str(priorStatement.closingShares) : str(member.shareBalance);
  const monthlyShare = str(member.monthlyShare);
  const closingShares = openingShares;
  const unpaid = reentry ? zeroUnpaidCarry : await unpaidFromPeriod(auth.societyId, memberId, previousPeriod(period), tx);
  const hadPrevious = reentry ? false : Boolean(priorStatement);
  const society = await tx.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  const book = hadPrevious ? await openingLoanForPeriod(tx, auth.societyId, memberId, period) : null;
  const openingPrincipal = book?.openingPrincipal ?? "0.00";
  const scheduled = hadPrevious
    ? scheduledForOpenPrincipal({
        givenThisMonth: book?.given ?? "0.00",
        currentScheduled: book?.scheduled ?? "0.00",
        statementPrincipalDue: "0.00",
        unpaidPrincipal: unpaid.principal,
        priorScheduled: await priorScheduledPrincipal(tx, auth.societyId, memberId, period),
      })
    : "0.00";
  const principalDue = hadPrevious ? principalDueThisMonth(openingPrincipal, scheduled) : "0.00";
  const currentInterest = hadPrevious ? calculateCurrentInterest(openingPrincipal, society.interestRate.toString()) : "0.00";
  const penaltyDue = sumMoney([unpaid.penalty, await scheduledPenaltyFor(tx, auth.societyId, memberId, period)]);
  const installment = calculateInstallment({
    monthlyShare,
    previousInterest: unpaid.interest,
    currentInterest,
    principal: principalDue,
    penalty: penaltyDue,
  });
  if (money(monthlyShare).greaterThan(0)) {
    const assessed = await tx.shareTransaction.findFirst({
      where: { societyId: auth.societyId, memberId, period, reference: { startsWith: "SHARE-ASSESS" } },
    });
    if (assessed) {
      const assessAmount = str(assessed.amount);
      if (money(assessAmount).lessThan(monthlyShare)) {
        await tx.shareTransaction.update({
          where: { id: assessed.id },
          data: { amount: dec(monthlyShare) },
        });
      }
    } else {
      await tx.shareTransaction.create({
        data: {
          societyId: auth.societyId,
          memberId,
          date: utcDate(statementDateFor(period)),
          period,
          amount: dec(monthlyShare),
          cashEffect: dec("0.00"),
          reason: hadPrevious
            ? "Monthly share assessed for the new statement. Cash is collected with the installment."
            : reentry
              ? "Monthly share assessed when the member rejoined. Cash is collected with the installment."
              : "Monthly share assessed when the member joined. Cash is collected with the installment.",
          reference: `SHARE-ASSESS-${period}`,
          createdById: auth.userId,
        },
      });
      await cashLedger(tx, auth, {
        memberId,
        date: statementDateFor(period),
        period,
        type: "MEMBER_CONTRIBUTION",
        direction: "NONE",
        amount: monthlyShare,
        reference: `SHARE-ASSESS-${period}`,
        reason: hadPrevious
          ? "Share assessment. Not cash until the installment is collected."
          : "Share assessment for a member who joined this month. Not cash until collected.",
      });
    }
  }
  if (hadPrevious && money(currentInterest).greaterThan(0)) {
    const accrued = await tx.interestEvent.findFirst({
      where: { societyId: auth.societyId, memberId, period, kind: "ACCRUAL" },
    });
    if (!accrued) {
      await tx.interestEvent.create({
        data: {
          societyId: auth.societyId,
          memberId,
          date: utcDate(statementDateFor(period)),
          period,
          kind: "ACCRUAL",
          amount: dec(currentInterest),
          reason: `Interest at ${society.interestRate.toString()} on outstanding ${openingPrincipal}`,
          createdById: auth.userId,
        },
      });
      await cashLedger(tx, auth, {
        memberId,
        date: statementDateFor(period),
        period,
        type: "INTEREST_ACCRUAL",
        direction: "NONE",
        amount: currentInterest,
        reference: "ACCRUAL",
        reason: "Accrued interest. It is not distributable until collected.",
      });
    }
  }
  const statementData = {
    openingShares: dec(openingShares),
    monthlyShare: dec(monthlyShare),
    shareMovement: dec("0.00"),
    shareCashPending: dec(monthlyShare),
    arrearsCash: dec(unpaid.share),
    closingShares: dec(closingShares),
    openingPrincipal: dec(openingPrincipal),
    principalDue: dec(principalDue),
    previousInterest: dec(unpaid.interest),
    currentInterest: dec(currentInterest),
    interestOutstanding: dec(sumMoney([unpaid.interest, currentInterest])),
    penalty: dec(penaltyDue),
    totalInstallment: dec(installment),
  };
  const statement = existing
    ? await tx.memberMonth.update({
        where: { id: existing.id },
        data: statementData,
      })
    : await tx.memberMonth.create({
        data: {
          societyId: auth.societyId,
          memberId,
          period,
          ...statementData,
        },
      });
  await ensurePenaltyAssessment(tx, auth, memberId, period, penaltyDue);
  await refreshMember(tx, memberId);
  await audit(tx, auth, existing ? "Restored open statement" : "Opened statement", "MemberMonth", statement.id, existing ? "Member reactivated during the open month" : "Member joined during the open month", null, {
    memberId,
    period,
    monthlyShare,
  });
  return statement;
}

/** No Excel import: keep an unused society on this calendar month so collections start now. */
export async function ensureManualOpenIsCurrent(societyId: string, tx: Tx | typeof prisma = prisma) {
  const current = calendarPeriod();
  const [members, imported] = await Promise.all([
    tx.member.count({ where: { societyId } }),
    tx.shareTransaction.count({ where: { societyId, reference: { startsWith: "IMPORT-" } } }),
  ]);
  if (members > 0 || imported > 0) return;
  const open = await tx.accountingMonth.findFirst({ where: { societyId, status: "OPEN" }, orderBy: { period: "desc" } });
  if (!open || open.period === current) return;
  const taken = await tx.accountingMonth.findUnique({ where: { societyId_period: { societyId, period: current } } });
  if (taken) {
    if (taken.id !== open.id && taken.status !== "OPEN") {
      await tx.accountingMonth.update({ where: { id: open.id }, data: { status: "CLOSED", closedAt: new Date() } });
      await tx.accountingMonth.update({ where: { id: taken.id }, data: { status: "OPEN" } });
    }
    return;
  }
  await tx.accountingMonth.update({
    where: { id: open.id },
    data: { period: current, statementDate: utcDate(statementDateFor(current)), registerNote: "" },
  });
}

export async function syncOpenMonthInterestBooks(auth: AuthUser) {
  const month = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!month) return;
  const openStatements = await prisma.memberMonth.findMany({
    where: { societyId: auth.societyId, period: month.period },
    orderBy: { memberId: "asc" },
  });
  if (openStatements.length === 0) return;
  const inactive = new Set(
    (await prisma.member.findMany({ where: { societyId: auth.societyId, status: "INACTIVE" }, select: { id: true } })).map((row) => row.id),
  );
  await prisma.$transaction(async (tx) => {
    for (const statement of openStatements) {
      if (inactive.has(statement.memberId)) continue;
      await consolidateActiveLoans(tx, auth.societyId, statement.memberId);
      await syncOpenLoanStatement(tx, auth, statement);
    }
    await consolidateInterestAccruals(tx, auth.societyId);
  }, { timeout: 60000 });
}

export async function ensureOpenStatements(auth: AuthUser) {
  await ensureManualOpenIsCurrent(auth.societyId);
  await relocateNextMonthPenalties(auth.societyId);
  const month = await prisma.accountingMonth.findFirst({ where: { societyId: auth.societyId, status: "OPEN" }, orderBy: { period: "desc" } });
  if (!month) return;
  const [members, statements] = await Promise.all([
    prisma.member.findMany({ where: { societyId: auth.societyId, status: "ACTIVE" }, select: { id: true } }),
    prisma.memberMonth.findMany({ where: { societyId: auth.societyId, period: month.period }, select: { memberId: true } }),
  ]);
  const covered = new Set(statements.map((row) => row.memberId));
  const missing = members.filter((row) => !covered.has(row.id));
  if (missing.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const member of missing) await ensureMemberStatement(tx, auth, member.id, month.period);
    });
  }
  await applyUnpaidCarryToOpenMonth(auth, month.period);
  const openStatements = await prisma.memberMonth.findMany({
    where: { societyId: auth.societyId, period: month.period },
    orderBy: { memberId: "asc" },
  });
  const inactive = new Set(
    (await prisma.member.findMany({ where: { societyId: auth.societyId, status: "INACTIVE" }, select: { id: true } })).map((row) => row.id),
  );
  if (openStatements.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const statement of openStatements) {
          if (inactive.has(statement.memberId)) continue;
          await consolidateActiveLoans(tx, auth.societyId, statement.memberId);
          await syncOpenLoanStatement(tx, auth, statement);
          const latest = await tx.memberMonth.findUniqueOrThrow({ where: { id: statement.id } });
          await ensurePenaltyAssessment(tx, auth, latest.memberId, latest.period, str(latest.penalty));
          await ensureShareAssessmentRoom(
            tx,
            auth.societyId,
            latest.memberId,
            latest.period,
            shareDueOnBooks(str(latest.shareCashPending), str(latest.arrearsCash)),
            auth.userId,
          );
          await refreshMember(tx, statement.memberId);
        }
        await syncShareCashFromLedger(tx, auth.societyId);
        await healStatementShareCapital(tx, auth.societyId);
        await consolidateInterestAccruals(tx, auth.societyId);
      }, { timeout: 120000 });
    } catch {
      // Listing members and opening the month must not fail because older share cash is already marked.
    }
  }
}

async function syncShareCashFromLedger(tx: Tx, societyId: string) {
  const members = await tx.member.findMany({ where: { societyId, status: "ACTIVE" }, select: { id: true, shareBooksFromPeriod: true } });
  for (const member of members) {
    const shareCash = await tx.ledgerEntry.findMany({
      where: {
        societyId,
        memberId: member.id,
        type: "MEMBER_CONTRIBUTION",
        ...(member.shareBooksFromPeriod ? { period: { gte: member.shareBooksFromPeriod } } : {}),
      },
    });
    const received = netLedgerByType(
      shareCash.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
      "MEMBER_CONTRIBUTION",
    );
    const applied = sumMoney(
      (await tx.shareTransaction.findMany({ where: { societyId, memberId: member.id } })).map((row) => str(row.cashEffect)),
    );
    const gap = subtractMoney(received, applied);
    if (money(gap).greaterThan(0)) await applyShareCash(tx, societyId, member.id, gap, "heal");
  }
}

async function applyUnpaidCarryToOpenMonth(auth: AuthUser, period: string) {
  const prior = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "CLOSED", period: { lt: period } },
    orderBy: { period: "desc" },
  });
  if (!prior) return;
  const statements = await prisma.memberMonth.findMany({ where: { societyId: auth.societyId, period } });
  if (statements.length === 0) return;
  const inactiveIds = new Set(
    (
      await prisma.member.findMany({
        where: { societyId: auth.societyId, status: "INACTIVE" },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  await prisma.$transaction(async (tx) => {
    for (const open of statements) {
      if (inactiveIds.has(open.memberId)) continue;
      const previous = await tx.memberMonth.findUnique({
        where: { societyId_memberId_period: { societyId: auth.societyId, memberId: open.memberId, period: prior.period } },
      });
      if (!previous) continue;
      const unpaid = await unpaidFromPeriod(auth.societyId, open.memberId, prior.period, tx);
      const nextArrears = moneyAtLeast(str(open.arrearsCash), unpaid.share);
      const nextPrevInterest = moneyAtLeast(str(open.previousInterest), unpaid.interest);
      const deferredPenalty = await scheduledPenaltyFor(tx, auth.societyId, open.memberId, period);
      const nextPenalty = moneyAtLeast(str(open.penalty), sumMoney([unpaid.penalty, deferredPenalty]));
      if (
        nextArrears === str(open.arrearsCash) &&
        nextPrevInterest === str(open.previousInterest) &&
        nextPenalty === str(open.penalty)
      ) {
        continue;
      }
      const total = calculateInstallment({
        monthlyShare: str(open.monthlyShare),
        previousInterest: nextPrevInterest,
        currentInterest: str(open.currentInterest),
        principal: str(open.principalDue),
        penalty: nextPenalty,
      });
      await tx.memberMonth.update({
        where: { id: open.id },
        data: {
          arrearsCash: dec(nextArrears),
          previousInterest: dec(nextPrevInterest),
          penalty: dec(nextPenalty),
          interestOutstanding: dec(sumMoney([nextPrevInterest, str(open.currentInterest)])),
          totalInstallment: dec(total),
        },
      });
      await ensurePenaltyAssessment(tx, auth, open.memberId, period, nextPenalty);
    }
  });
}

export async function duesFor(societyId: string, memberId: string, period: string, tx: Tx | typeof prisma = prisma) {
  const statement = await tx.memberMonth.findUnique({
    where: { societyId_memberId_period: { societyId, memberId, period } },
  });
  if (!statement) throw new HttpError(404, "That month has no statement for this member");
  const payments = await tx.payment.findMany({
    where: { societyId, memberId, period, status: "RECORDED" },
    include: { allocations: true },
  });
  const paid = emptyPaid();
  for (const payment of payments) {
    for (const allocation of payment.allocations) {
      const component = allocation.component as AllocationComponent;
      paid[component] = sumMoney([paid[component], str(allocation.amount)]);
    }
  }
  const arrears = str(statement.arrearsCash);
  const sharePaid = paid.SHARE;
  const arrearsLeft = money(sharePaid).greaterThanOrEqualTo(arrears) ? "0.00" : subtractMoney(arrears, sharePaid);
  const paidTowardShare = money(sharePaid).greaterThan(arrears) ? subtractMoney(sharePaid, arrears) : "0.00";
  const shareLeftRaw = subtractMoney(str(statement.shareCashPending), paidTowardShare);
  const shareLeft = money(shareLeftRaw).isNegative() ? "0.00" : shareLeftRaw;
  const dues: Record<AllocationComponent, string> = {
    SHARE: sumMoney([shareLeft, arrearsLeft]),
    PREVIOUS_INTEREST: subtractMoney(str(statement.previousInterest), paid.PREVIOUS_INTEREST),
    CURRENT_INTEREST: subtractMoney(str(statement.currentInterest), paid.CURRENT_INTEREST),
    PRINCIPAL: subtractMoney(str(statement.principalDue), paid.PRINCIPAL),
    PENALTY: subtractMoney(str(statement.penalty), paid.PENALTY),
  };
  for (const component of Object.keys(dues) as AllocationComponent[]) {
    if (money(dues[component]).isNegative()) dues[component] = "0.00";
  }
  return {
    statement,
    paid,
    dues,
    shareLeft,
    arrearsLeft,
    totalDue: sumMoney(Object.values(dues)),
    assessed: str(statement.totalInstallment),
  };
}

async function unpaidFromPeriod(
  societyId: string,
  memberId: string,
  period: string,
  tx: Tx | typeof prisma = prisma,
) {
  const previous = await tx.memberMonth.findUnique({
    where: { societyId_memberId_period: { societyId, memberId, period } },
  });
  if (!previous) {
    return { share: "0.00", interest: "0.00", penalty: "0.00", principal: "0.00" };
  }
  const paid = await duesFor(societyId, memberId, period, tx);
  return {
    share: paid.dues.SHARE,
    interest: calculateInterestOutstanding(
      str(previous.previousInterest),
      str(previous.currentInterest),
      sumMoney([paid.paid.PREVIOUS_INTEREST, paid.paid.CURRENT_INTEREST]),
    ),
    penalty: paid.dues.PENALTY,
    principal: paid.dues.PRINCIPAL,
  };
}


async function loanBookForMember(tx: Tx, societyId: string, memberId: string) {
  const loans = await tx.loan.findMany({
    where: { societyId, memberId, outstandingPrincipal: { gt: 0 }, status: { not: "CANCELLED" } },
    orderBy: [{ loanDate: "asc" }, { createdAt: "asc" }],
  });
  return {
    loans,
    outstanding: sumMoney(loans.map((row) => str(row.outstandingPrincipal))),
    scheduled: sumMoney(loans.map((row) => str(row.scheduledPrincipal))),
  };
}

/** Opening loan on a statement excludes money given this month. Interest on a new loan starts next month. */
async function openingLoanForPeriod(tx: Tx, societyId: string, memberId: string, period: string) {
  const book = await loanBookForMember(tx, societyId, memberId);
  const txns = await tx.loanTransaction.findMany({
    where: { societyId, memberId, period, type: { in: ["DISBURSEMENT", "PRINCIPAL_REPAYMENT"] } },
  });
  const given = sumMoney(
    txns
      .filter((row) => row.type === "DISBURSEMENT" && !row.reference.startsWith("IMPORT-LOAN"))
      .map((row) => str(row.amount)),
  );
  const repaid = sumMoney(txns.filter((row) => row.type === "PRINCIPAL_REPAYMENT").map((row) => str(row.amount)));
  const openingPrincipal = subtractMoney(sumMoney([book.outstanding, repaid]), given);
  return {
    ...book,
    given,
    openingPrincipal: money(openingPrincipal).isNegative() ? "0.00" : openingPrincipal,
  };
}

async function priorScheduledPrincipal(tx: Tx, societyId: string, memberId: string, period: string) {
  const prevPeriod = previousPeriod(period);
  const previous = await tx.memberMonth.findUnique({
    where: { societyId_memberId_period: { societyId, memberId, period: prevPeriod } },
  });
  if (!previous) return "0.00";
  const unpaidIntoPrev = await unpaidFromPeriod(societyId, memberId, previousPeriod(prevPeriod), tx);
  const implied = subtractMoney(str(previous.principalDue), unpaidIntoPrev.principal);
  if (money(implied).greaterThan(0)) return implied;
  return money(str(previous.principalDue)).greaterThan(0) ? str(previous.principalDue) : "0.00";
}

/** One running loan per member. A further disbursement is a top-up, matching the register's single loan column. */
async function consolidateActiveLoans(tx: Tx, societyId: string, memberId: string) {
  const loans = await tx.loan.findMany({
    where: { societyId, memberId, outstandingPrincipal: { gt: 0 }, status: { notIn: ["CANCELLED", "COMPLETED"] } },
    orderBy: [{ loanDate: "asc" }, { createdAt: "asc" }],
  });
  if (loans.length <= 1) return loans[0] ?? null;
  const kept = loans[0]!;
  const latest = loans[loans.length - 1]!;
  const outstanding = sumMoney(loans.map((row) => str(row.outstandingPrincipal)));
  const original = sumMoney(loans.map((row) => str(row.originalPrincipal)));
  for (const extra of loans.slice(1)) {
    await tx.loanTransaction.updateMany({ where: { loanId: extra.id }, data: { loanId: kept.id } });
    await tx.loan.update({
      where: { id: extra.id },
      data: { outstandingPrincipal: dec("0.00"), status: "CANCELLED" },
    });
  }
  return tx.loan.update({
    where: { id: kept.id },
    data: {
      outstandingPrincipal: dec(outstanding),
      originalPrincipal: dec(original),
      scheduledPrincipal: latest.scheduledPrincipal,
      status: deriveLoanStatus({ outstanding, missedPrincipalInstallments: 0, hasRepayment: true }),
    },
  });
}

async function consolidateInterestAccruals(tx: Tx, societyId: string) {
  const accruals = await tx.interestEvent.findMany({
    where: { societyId, kind: "ACCRUAL" },
    orderBy: [{ memberId: "asc" }, { period: "asc" }, { createdAt: "asc" }],
  });
  const groups = new Map<string, typeof accruals>();
  for (const row of accruals) {
    const key = `${row.memberId}:${row.period}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const keep = list[list.length - 1]!;
    for (const extra of list.slice(0, -1)) {
      await tx.interestEvent.delete({ where: { id: extra.id } });
    }
    const statement = await tx.memberMonth.findUnique({
      where: { societyId_memberId_period: { societyId, memberId: keep.memberId, period: keep.period } },
    });
    if (statement && str(keep.amount) !== str(statement.currentInterest)) {
      await tx.interestEvent.update({
        where: { id: keep.id },
        data: { amount: dec(str(statement.currentInterest)) },
      });
    }
  }
}

async function upsertInterestAccrual(
  tx: Tx,
  auth: AuthUser,
  input: { memberId: string; period: string; amount: string; reason: string; ledgerReason?: string },
) {
  const accrued = await tx.interestEvent.findFirst({
    where: { societyId: auth.societyId, memberId: input.memberId, period: input.period, kind: "ACCRUAL" },
  });
  if (isZero(input.amount)) {
    if (accrued) await tx.interestEvent.update({ where: { id: accrued.id }, data: { amount: dec("0.00") } });
    return;
  }
  if (accrued) {
    await tx.interestEvent.update({
      where: { id: accrued.id },
      data: { amount: dec(input.amount), reason: input.reason },
    });
    return;
  }
  await tx.interestEvent.create({
    data: {
      societyId: auth.societyId,
      memberId: input.memberId,
      date: utcDate(statementDateFor(input.period)),
      period: input.period,
      kind: "ACCRUAL",
      amount: dec(input.amount),
      reason: input.reason,
      createdById: auth.userId,
    },
  });
  await cashLedger(tx, auth, {
    memberId: input.memberId,
    date: statementDateFor(input.period),
    period: input.period,
    type: "INTEREST_ACCRUAL",
    direction: "NONE",
    amount: input.amount,
    reference: "ACCRUAL",
    reason: input.ledgerReason ?? "Accrued interest. It is not distributable until collected.",
  });
}

async function syncOpenLoanStatement(
  tx: Tx,
  auth: AuthUser,
  statement: { id: string; memberId: string; period: string; monthlyShare: unknown; previousInterest: unknown; penalty: unknown; principalDue?: unknown },
) {
  const society = await tx.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  const book = await openingLoanForPeriod(tx, auth.societyId, statement.memberId, statement.period);
  const unpaid = await unpaidFromPeriod(auth.societyId, statement.memberId, previousPeriod(statement.period), tx);
  const scheduled = scheduledForOpenPrincipal({
    givenThisMonth: book.given,
    currentScheduled: book.scheduled,
    statementPrincipalDue: str(statement.principalDue ?? "0.00"),
    unpaidPrincipal: unpaid.principal,
    priorScheduled: await priorScheduledPrincipal(tx, auth.societyId, statement.memberId, statement.period),
  });
  const principalDue = principalDueThisMonth(book.openingPrincipal, scheduled);
  const currentInterest = calculateCurrentInterest(book.openingPrincipal, society.interestRate.toString());
  const total = calculateInstallment({
    monthlyShare: str(statement.monthlyShare),
    previousInterest: str(statement.previousInterest),
    currentInterest,
    principal: principalDue,
    penalty: str(statement.penalty),
  });
  await tx.memberMonth.update({
    where: { id: statement.id },
    data: {
      openingPrincipal: dec(book.openingPrincipal),
      principalDue: dec(principalDue),
      currentInterest: dec(currentInterest),
      interestOutstanding: dec(sumMoney([str(statement.previousInterest), currentInterest])),
      totalInstallment: dec(total),
    },
  });
  await upsertInterestAccrual(tx, auth, {
    memberId: statement.memberId,
    period: statement.period,
    amount: currentInterest,
    reason: `Interest at ${society.interestRate.toString()} on outstanding ${book.openingPrincipal}`,
  });
}

function moneyAtLeast(current: string, needed: string) {
  return money(needed).greaterThan(current) ? needed : current;
}

async function extraPrincipalRoom(tx: Tx | typeof prisma, societyId: string, memberId: string, alreadyPrincipal: string) {
  const loans = await tx.loan.findMany({
    where: { societyId, memberId, status: { not: "CANCELLED" }, outstandingPrincipal: { gt: 0 } },
  });
  const outstanding = sumMoney(loans.map((loan) => str(loan.outstandingPrincipal)));
  const room = subtractMoney(outstanding, alreadyPrincipal);
  return money(room).isNegative() ? "0.00" : room;
}

function extraPenaltyAmount(value?: string) {
  if (!value) return "0.00";
  return calculatePenalty({ method: "MANUAL", manualAmount: value });
}

async function scheduledPenaltyFor(tx: Tx | typeof prisma, societyId: string, memberId: string, period: string) {
  const rows = await tx.penalty.findMany({
    where: { societyId, memberId, period, source: "NEXT_MONTH" },
  });
  return sumMoney(rows.map((row) => str(row.amount)));
}

async function addPenaltyToStatement(tx: Tx, statementId: string, extra: string) {
  if (isZero(extra)) return;
  const statement = await tx.memberMonth.findUnique({ where: { id: statementId } });
  if (!statement) return;
  const nextPenalty = sumMoney([str(statement.penalty), extra]);
  const total = calculateInstallment({
    monthlyShare: str(statement.monthlyShare),
    previousInterest: str(statement.previousInterest),
    currentInterest: str(statement.currentInterest),
    principal: str(statement.principalDue),
    penalty: nextPenalty,
  });
  await tx.memberMonth.update({
    where: { id: statement.id },
    data: { penalty: dec(nextPenalty), totalInstallment: dec(total) },
  });
}

async function ensurePenaltyAssessment(
  tx: Tx,
  auth: AuthUser,
  memberId: string,
  period: string,
  assessed: string,
) {
  if (isZero(assessed) || money(assessed).isNegative()) return;
  const rows = await tx.penalty.findMany({ where: { societyId: auth.societyId, memberId, period } });
  const onRows = sumMoney(rows.map((row) => str(row.amount)));
  const gap = subtractMoney(assessed, onRows);
  if (money(gap).lessThanOrEqualTo(0)) return;
  await tx.penalty.create({
    data: {
      societyId: auth.societyId,
      memberId,
      period,
      date: utcDate(statementDateFor(period)),
      amount: dec(gap),
      source: "INSTALLMENT",
      reason: "Unpaid penalty carried into this month",
      createdById: auth.userId,
    },
  });
}

export async function relocateNextMonthPenalties(societyId: string) {
  const open = await prisma.accountingMonth.findFirst({
    where: { societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!open) return;
  const prior = await prisma.accountingMonth.findFirst({
    where: { societyId, status: "CLOSED", period: { lt: open.period } },
    orderBy: { period: "desc" },
  });
  const cutoff = prior?.closedAt ?? open.openedAt;
  const target = nextPeriod(open.period);
  await prisma.$transaction(async (tx) => {
    const forwarded = (
      await tx.penalty.findMany({
        where: { societyId, period: target, source: "NEXT_MONTH" },
      })
    ).filter((row) => isZero(str(row.collectedAmount)) && row.createdAt <= cutoff);
    for (const row of forwarded) {
      await tx.penalty.update({ where: { id: row.id }, data: { period: open.period } });
      const statement = await tx.memberMonth.findUnique({
        where: { societyId_memberId_period: { societyId, memberId: row.memberId, period: open.period } },
      });
      if (statement) await addPenaltyToStatement(tx, statement.id, str(row.amount));
    }
    const misplaced = (
      await tx.penalty.findMany({
        where: {
          societyId,
          period: open.period,
          OR: [{ source: "NEXT_MONTH" }, { reason: { contains: "Next month penalty" } }],
        },
      })
    ).filter((row) => isZero(str(row.collectedAmount)) && row.createdAt > cutoff);
    for (const row of misplaced) {
      await tx.penalty.update({
        where: { id: row.id },
        data: { period: target, source: "NEXT_MONTH" },
      });
      const statement = await tx.memberMonth.findUnique({
        where: { societyId_memberId_period: { societyId, memberId: row.memberId, period: open.period } },
      });
      if (!statement) continue;
      const reduced = money(str(statement.penalty)).greaterThan(str(row.amount))
        ? subtractMoney(str(statement.penalty), str(row.amount))
        : "0.00";
      const total = calculateInstallment({
        monthlyShare: str(statement.monthlyShare),
        previousInterest: str(statement.previousInterest),
        currentInterest: str(statement.currentInterest),
        principal: str(statement.principalDue),
        penalty: reduced,
      });
      await tx.memberMonth.update({
        where: { id: statement.id },
        data: { penalty: dec(reduced), totalInstallment: dec(total) },
      });
    }
  });
}

async function scheduleNextMonthPenalty(
  tx: Tx,
  auth: AuthUser,
  input: { memberId: string; period: string; amount: string; date: string; reason: string; receiptNo?: string },
) {
  const penalty = extraPenaltyAmount(input.amount);
  if (isZero(penalty)) throw new HttpError(400, "Penalty amount must be greater than zero");
  const month = await tx.accountingMonth.findUnique({
    where: { societyId_period: { societyId: auth.societyId, period: input.period } },
  });
  if (!month || month.status !== "OPEN") throw new HttpError(409, "Next-month penalties can only be added in an open month");
  const member = await tx.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId, status: "ACTIVE" } });
  if (!member) throw new HttpError(409, "This member has left the society, so there is no installment to collect this month.");
  const period = nextPeriod(month.period);
  const row = await tx.penalty.create({
    data: {
      societyId: auth.societyId,
      memberId: member.id,
      period,
      date: utcDate(input.date),
      amount: dec(penalty),
      source: "NEXT_MONTH",
      reason: input.receiptNo
        ? `${input.receiptNo} · Next month penalty, not collected today.`
        : input.reason,
      createdById: auth.userId,
    },
  });
  await audit(tx, auth, "Scheduled next-month penalty", "Penalty", row.id, input.reason, null, { penalty, period, receiptNo: input.receiptNo ?? null });
  return row;
}

function withExtraPenaltyDue<T extends { dues: Record<AllocationComponent, string>; totalDue: string }>(snapshot: T, extra: string): T {
  if (isZero(extra)) return snapshot;
  const dues = { ...snapshot.dues, PENALTY: sumMoney([snapshot.dues.PENALTY, extra]) };
  return { ...snapshot, dues, totalDue: sumMoney([snapshot.totalDue, extra]) };
}

function allocateReceipt(
  amount: string,
  dues: Record<AllocationComponent, string>,
  order: string[],
  collectPenalty?: boolean,
  collectPenaltyAmount?: string,
) {
  if (collectPenaltyAmount !== undefined) {
    return allocateCollectingPenaltyFirst(amount, dues, order, collectPenaltyAmount);
  }
  return collectPenalty
    ? allocateCollectingPenaltyFirst(amount, dues, order)
    : calculatePaymentAllocation(amount, dues, order);
}

export async function previewPayment(auth: AuthUser, input: { memberId: string; period: string; amount: string; penalty?: string; collectPenalty?: boolean; collectPenaltyAmount?: string; nextMonthPenalty?: string; allocation?: { component: AllocationComponent; amount: string }[] }) {
  const month = await prisma.accountingMonth.findUnique({
    where: { societyId_period: { societyId: auth.societyId, period: input.period } },
  });
  if (!month || month.status !== "OPEN") throw new HttpError(409, "Payments can only be recorded in an open month");
  const statement = await prisma.$transaction(async (tx) => ensureMemberStatement(tx, auth, input.memberId, input.period));
  if (!statement) throw new HttpError(409, "This member has no installment in the open month");
  const extraPenalty = extraPenaltyAmount(input.penalty);
  const snapshot = withExtraPenaltyDue(await duesFor(auth.societyId, input.memberId, input.period), extraPenalty);
  const society = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  if (input.allocation) {
    const explicit = assertExplicitAllocation(input.amount, snapshot.dues, input.allocation);
    return { ...snapshot, allocation: explicit.allocations, unapplied: "0.00", mode: "EXPLICIT" as const };
  }
  const order = assertAllocationOrder(society.paymentAllocationOrder.split(","));
  const allocation = allocateReceipt(input.amount, snapshot.dues, order, input.collectPenalty, input.collectPenaltyAmount);
  const principalSoFar = sumMoney([
    snapshot.paid.PRINCIPAL,
    allocation.allocations.find((row) => row.component === "PRINCIPAL")?.amount ?? "0.00",
  ]);
  const room = await extraPrincipalRoom(prisma, auth.societyId, input.memberId, principalSoFar);
  const absorbed = absorbExtraPrincipal(allocation.allocations, allocation.unapplied, room);
  const nextMonthPenalty = extraPenaltyAmount(input.nextMonthPenalty);
  return {
    ...snapshot,
    allocation: absorbed.allocations,
    unapplied: absorbed.unapplied,
    mode: "ORDER" as const,
    order,
    nextMonthPenalty,
  };
}

export async function postPayment(
  auth: AuthUser,
  input: {
    memberId: string;
    period: string;
    amount: string;
    paidOn: string;
    reason: string;
    note?: string;
    idempotencyKey: string;
    penalty?: string;
    collectPenalty?: boolean;
    collectPenaltyAmount?: string;
    nextMonthPenalty?: string;
    allocation?: { component: AllocationComponent; amount: string }[];
  },
) {
  const existing = await prisma.payment.findFirst({
    where: { societyId: auth.societyId, idempotencyKey: input.idempotencyKey },
    include: { allocations: true, member: true },
  });
  if (existing) {
    if (existing.memberId !== input.memberId || str(existing.amount) !== money(input.amount).toFixed(2)) {
      throw new HttpError(409, "This submission was already used for a different payment");
    }
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const month = await tx.accountingMonth.findUnique({
      where: { societyId_period: { societyId: auth.societyId, period: input.period } },
    });
    if (!month || month.status !== "OPEN") throw new HttpError(409, "Payments can only be recorded in an open month");
    const member = await tx.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId, status: "ACTIVE" } });
    if (!member) throw new HttpError(409, "This member has left the society, so there is no installment to collect this month.");
    let statement = await ensureMemberStatement(tx, auth, member.id, input.period);
    if (!statement) throw new HttpError(409, "This member has no installment in the open month");
    const extraPenalty = extraPenaltyAmount(input.penalty);
    if (!isZero(extraPenalty)) {
      await applyManualPenalty(tx, auth, {
        memberId: member.id,
        period: input.period,
        amount: extraPenalty,
        date: input.paidOn,
        reason: input.reason,
      });
      statement = (await tx.memberMonth.findUnique({ where: { id: statement.id } })) ?? statement;
    }
    const snapshot = await duesFor(auth.societyId, member.id, input.period, tx);
    const society = await tx.society.findUniqueOrThrow({ where: { id: auth.societyId } });
    const computed = input.allocation
      ? { ...assertExplicitAllocation(input.amount, snapshot.dues, input.allocation), unapplied: "0.00" }
      : allocateReceipt(
          input.amount,
          snapshot.dues,
          assertAllocationOrder(society.paymentAllocationOrder.split(",")),
          input.collectPenalty,
          input.collectPenaltyAmount,
        );
    const principalSoFar = sumMoney([
      snapshot.paid.PRINCIPAL,
      computed.allocations.find((row) => row.component === "PRINCIPAL")?.amount ?? "0.00",
    ]);
    const withExtra = input.allocation
      ? computed
      : absorbExtraPrincipal(computed.allocations, computed.unapplied, await extraPrincipalRoom(tx, auth.societyId, member.id, principalSoFar));
    if (money(withExtra.unapplied).greaterThan(0)) {
      throw new HttpError(400, `Payment is ${withExtra.unapplied} more than the installment and the outstanding loan`);
    }

    const receiptPrefix = `RCP-${input.period.replace("-", "")}-`;
    const issued = await tx.payment.findMany({
      where: { societyId: auth.societyId, receiptNo: { startsWith: receiptPrefix } },
      select: { receiptNo: true },
    });
    let receiptSeq = 0;
    for (const row of issued) {
      const n = Number(row.receiptNo.slice(receiptPrefix.length));
      if (Number.isInteger(n) && n > receiptSeq) receiptSeq = n;
    }
    const receiptNo = `${receiptPrefix}${String(receiptSeq + 1).padStart(4, "0")}`;
    const payment = await tx.payment.create({
      data: {
        societyId: auth.societyId,
        memberId: member.id,
        period: input.period,
        receiptNo,
        amount: dec(money(input.amount).toFixed(2)),
        paidOn: utcDate(input.paidOn),
        note: input.note ?? "",
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        createdById: auth.userId,
        allocations: {
          create: withExtra.allocations
            .filter((row) => !isZero(row.amount))
            .map((row) => ({ component: row.component, amount: dec(row.amount) })),
        },
      },
      include: { allocations: true },
    });

    for (const row of withExtra.allocations) {
      if (isZero(row.amount)) continue;
      if (row.component === "SHARE") {
        await applyShareCash(tx, auth.societyId, member.id, row.amount, "strict", auth.userId);
        await cashLedger(tx, auth, {
          memberId: member.id,
          date: input.paidOn,
          period: input.period,
          type: "MEMBER_CONTRIBUTION",
          direction: "IN",
          amount: row.amount,
          reference: receiptNo,
          reason: input.reason,
        });
      }
      if (row.component === "PREVIOUS_INTEREST" || row.component === "CURRENT_INTEREST") {
        await tx.interestEvent.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            date: utcDate(input.paidOn),
            period: input.period,
            kind: "COLLECTION",
            amount: dec(row.amount),
            reason: input.reason,
            createdById: auth.userId,
          },
        });
        await cashLedger(tx, auth, {
          memberId: member.id,
          date: input.paidOn,
          period: input.period,
          type: "INTEREST_COLLECTION",
          direction: "IN",
          amount: row.amount,
          reference: receiptNo,
          reason: input.reason,
        });
      }
      if (row.component === "PRINCIPAL") {
        const loan = await tx.loan.findFirst({
          where: { societyId: auth.societyId, memberId: member.id, outstandingPrincipal: { gt: 0 }, status: { notIn: ["CANCELLED", "COMPLETED"] } },
          orderBy: { outstandingPrincipal: "desc" },
        });
        if (!loan) throw new HttpError(409, "This member has no loan to repay");
        const outstanding = calculateLoanBalance(str(loan.outstandingPrincipal), "0.00", row.amount);
        await tx.loanTransaction.create({
          data: {
            societyId: auth.societyId,
            loanId: loan.id,
            memberId: member.id,
            date: utcDate(input.paidOn),
            period: input.period,
            type: "PRINCIPAL_REPAYMENT",
            amount: dec(row.amount),
            balanceAfter: dec(outstanding),
            reason: input.reason,
            reference: receiptNo,
            createdById: auth.userId,
          },
        });
        await tx.loan.update({
          where: { id: loan.id },
          data: {
            outstandingPrincipal: dec(outstanding),
            status: deriveLoanStatus({
              outstanding,
              missedPrincipalInstallments: 0,
              hasRepayment: true,
            }),
          },
        });
        await tx.memberMonth.update({
          where: { id: statement.id },
          data: { principalCollected: dec(sumMoney([str(statement.principalCollected), row.amount])) },
        });
        await cashLedger(tx, auth, {
          memberId: member.id,
          date: input.paidOn,
          period: input.period,
          type: "PRINCIPAL_REPAYMENT",
          direction: "IN",
          amount: row.amount,
          reference: receiptNo,
          reason: input.reason,
        });
      }
      if (row.component === "PENALTY") {
        let left = row.amount;
        const penalties = await tx.penalty.findMany({
          where: { societyId: auth.societyId, memberId: member.id, period: input.period, source: { in: ["INSTALLMENT", "MANUAL", "NEXT_MONTH"] } },
          orderBy: { createdAt: "asc" },
        });
        for (const penalty of penalties) {
          if (isZero(left)) break;
          const room = subtractMoney(str(penalty.amount), str(penalty.collectedAmount));
          if (money(room).lessThanOrEqualTo(0)) continue;
          const applied = money(left).lessThan(room) ? left : room;
          await tx.penalty.update({
            where: { id: penalty.id },
            data: { collectedAmount: dec(sumMoney([str(penalty.collectedAmount), applied])) },
          });
          left = subtractMoney(left, applied);
        }
        if (!isZero(left)) {
          await tx.penalty.create({
            data: {
              societyId: auth.societyId,
              memberId: member.id,
              period: input.period,
              date: utcDate(input.paidOn),
              amount: dec(left),
              collectedAmount: dec(left),
              source: "MANUAL",
              reason: input.reason,
              createdById: auth.userId,
            },
          });
        }
        await cashLedger(tx, auth, {
          memberId: member.id,
          date: input.paidOn,
          period: input.period,
          type: "PENALTY_COLLECTION",
          direction: "IN",
          amount: row.amount,
          reference: receiptNo,
          reason: input.reason,
        });
      }
    }

    await refreshMember(tx, member.id);
    await rebuildMemberStatementShares(tx, auth.societyId, member.id);
    await audit(tx, auth, "Collected payment", "Payment", payment.id, input.reason, null, {
      receiptNo,
      amount: str(payment.amount),
      allocations: computed.allocations,
    });
    const user = await tx.user.findFirst({ where: { memberId: member.id } });
    await notify(tx, {
      societyId: auth.societyId,
      userId: user?.id,
      memberId: member.id,
      paymentId: payment.id,
      type: "PAYMENT_RECEIVED",
      title: "Payment received",
      body: `${receiptNo} for ${member.name}: ${str(payment.amount)}`,
    });
    const nextMonthPenalty = extraPenaltyAmount(input.nextMonthPenalty);
    if (!isZero(nextMonthPenalty)) {
      await scheduleNextMonthPenalty(tx, auth, {
        memberId: member.id,
        period: input.period,
        amount: nextMonthPenalty,
        date: input.paidOn,
        reason: input.reason,
        receiptNo,
      });
    }
    return payment;
  }, { timeout: 30000 });
}

export async function deletePayment(auth: AuthUser, paymentId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, societyId: auth.societyId },
      include: { allocations: true, member: true },
    });
    if (!payment) throw new HttpError(404, "Receipt not found");
    if (payment.status !== "RECORDED") throw new HttpError(409, "This receipt was already removed");
    const month = await tx.accountingMonth.findUnique({
      where: { societyId_period: { societyId: auth.societyId, period: payment.period } },
    });
    if (!month || month.status !== "OPEN") {
      throw new HttpError(409, "A receipt can be removed only while the month is still open, before you close it.");
    }

    const shareAmount = sumMoney(payment.allocations.filter((row) => row.component === "SHARE").map((row) => str(row.amount)));
    const interestAmount = sumMoney(
      payment.allocations
        .filter((row) => row.component === "PREVIOUS_INTEREST" || row.component === "CURRENT_INTEREST")
        .map((row) => str(row.amount)),
    );
    const principalAmount = sumMoney(payment.allocations.filter((row) => row.component === "PRINCIPAL").map((row) => str(row.amount)));
    const penaltyAmount = sumMoney(payment.allocations.filter((row) => row.component === "PENALTY").map((row) => str(row.amount)));

    if (!isZero(interestAmount)) {
      const pool = await interestPoolForSociety(auth.societyId, tx);
      if (money(interestAmount).greaterThan(pool.available)) {
        throw new HttpError(409, "This receipt's interest is already in a share-out. Reverse that distribution first.");
      }
    }

    if (!isZero(shareAmount)) await unapplyShareCash(tx, auth.societyId, payment.memberId, shareAmount);

    for (const row of payment.allocations) {
      if ((row.component !== "PREVIOUS_INTEREST" && row.component !== "CURRENT_INTEREST") || isZero(str(row.amount))) continue;
      const event = await tx.interestEvent.findFirst({
        where: {
          societyId: auth.societyId,
          memberId: payment.memberId,
          period: payment.period,
          kind: "COLLECTION",
          amount: row.amount,
          date: payment.paidOn,
        },
        orderBy: { createdAt: "desc" },
      });
      if (!event) throw new HttpError(409, "This receipt's interest could not be unwound");
      await tx.interestEvent.update({
        where: { id: event.id },
        data: { kind: "REVERSAL", reason: `${event.reason} Removed ${payment.receiptNo}.` },
      });
    }

    const loanRows = await tx.loanTransaction.findMany({
      where: { societyId: auth.societyId, reference: payment.receiptNo, type: "PRINCIPAL_REPAYMENT" },
    });
    for (const row of loanRows) {
      const loan = await tx.loan.findUniqueOrThrow({ where: { id: row.loanId } });
      const outstanding = sumMoney([str(loan.outstandingPrincipal), str(row.amount)]);
      const otherRepay = await tx.loanTransaction.count({
        where: { loanId: loan.id, type: "PRINCIPAL_REPAYMENT", id: { not: row.id } },
      });
      await tx.loanTransaction.update({
        where: { id: row.id },
        data: { type: "REVERSAL", reason: `${row.reason} Removed ${payment.receiptNo}.` },
      });
      await tx.loan.update({
        where: { id: loan.id },
        data: {
          outstandingPrincipal: dec(outstanding),
          status: deriveLoanStatus({
            outstanding,
            missedPrincipalInstallments: 0,
            hasRepayment: otherRepay > 0,
          }),
        },
      });
    }

    if (!isZero(penaltyAmount)) {
      let left = penaltyAmount;
      const penalties = await tx.penalty.findMany({
        where: { societyId: auth.societyId, memberId: payment.memberId, period: payment.period, source: { in: ["INSTALLMENT", "MANUAL", "NEXT_MONTH"] } },
        orderBy: { createdAt: "desc" },
      });
      const leftoverIds: string[] = [];
      for (const penalty of penalties) {
        if (isZero(left)) break;
        const collected = str(penalty.collectedAmount);
        if (money(collected).lessThanOrEqualTo(0)) continue;
        if (penalty.source === "MANUAL" && collected === str(penalty.amount) && penalty.reason === payment.reason) {
          leftoverIds.push(penalty.id);
        }
        const applied = money(left).lessThan(collected) ? left : collected;
        await tx.penalty.update({
          where: { id: penalty.id },
          data: { collectedAmount: dec(subtractMoney(collected, applied)) },
        });
        left = subtractMoney(left, applied);
      }
      if (!isZero(left)) throw new HttpError(409, "This receipt's penalty could not be unwound");
      if (leftoverIds.length > 0) {
        await tx.penalty.deleteMany({
          where: { id: { in: leftoverIds }, collectedAmount: 0, source: "MANUAL" },
        });
      }
    }

    const windowStart = new Date(payment.createdAt.getTime() - 8000);
    const windowEnd = new Date(payment.createdAt.getTime() + 8000);
    await tx.penalty.deleteMany({
      where: {
        societyId: auth.societyId,
        memberId: payment.memberId,
        source: "NEXT_MONTH",
        collectedAmount: 0,
        createdAt: { gte: windowStart, lte: windowEnd },
        reason: { contains: "Next month penalty" },
      },
    });

    const cashLines = await tx.ledgerEntry.findMany({
      where: { societyId: auth.societyId, reference: payment.receiptNo, cashEffect: "IN" },
    });
    const paidOn = payment.paidOn.toISOString().slice(0, 10);
    for (const line of cashLines) {
      await cashLedger(tx, auth, {
        memberId: payment.memberId,
        date: paidOn,
        period: payment.period,
        type: line.type as "MEMBER_CONTRIBUTION" | "PRINCIPAL_REPAYMENT" | "INTEREST_COLLECTION" | "PENALTY_COLLECTION",
        direction: "OUT",
        amount: str(line.amount),
        reference: payment.receiptNo,
        reason,
      });
    }

    if (!isZero(principalAmount)) {
      const statement = await tx.memberMonth.findUnique({
        where: { societyId_memberId_period: { societyId: auth.societyId, memberId: payment.memberId, period: payment.period } },
      });
      if (statement) {
        const nextCollected = subtractMoney(str(statement.principalCollected), principalAmount);
        await tx.memberMonth.update({
          where: { id: statement.id },
          data: { principalCollected: dec(money(nextCollected).isNegative() ? "0.00" : nextCollected) },
        });
      }
    }

    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { status: "REVERSED", note: payment.note ? `${payment.note} Removed.` : "Removed." },
      include: { allocations: true, member: true },
    });
    await refreshMember(tx, payment.memberId);
    await rebuildMemberStatementShares(tx, auth.societyId, payment.memberId);
    await audit(tx, auth, "Removed payment", "Payment", payment.id, reason, {
      receiptNo: payment.receiptNo,
      amount: str(payment.amount),
      status: "RECORDED",
    }, { status: "REVERSED" });
    const user = await tx.user.findFirst({ where: { memberId: payment.memberId } });
    await notify(tx, {
      societyId: auth.societyId,
      userId: user?.id,
      memberId: payment.memberId,
      paymentId: payment.id,
      type: "PAYMENT_REMOVED",
      title: "Payment removed",
      body: `${payment.receiptNo} for ${payment.member.name} was removed so it can be collected again.`,
    });
    return updated;
  }, { timeout: 30000 });
}

async function societyRegisterImported(societyId: string) {
  const row = await prisma.auditLog.findFirst({
    where: { societyId, action: "Imported register" },
    select: { id: true },
  });
  return Boolean(row);
}

async function latestImportAudit(societyId: string) {
  return prisma.auditLog.findFirst({
    where: { societyId, action: "Imported register" },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
}

export async function importRollbackStatus(auth: AuthUser) {
  const imported = await latestImportAudit(auth.societyId);
  if (!imported) {
    return { imported: false, canRollback: false, blockedReason: "" };
  }
  const since = imported.createdAt;
  const [changesAfterImport, payments, closedMonths, distributions] = await Promise.all([
    prisma.auditLog.count({
      where: {
        societyId: auth.societyId,
        createdAt: { gt: since },
        action: { not: "Imported register" },
      },
    }),
    prisma.payment.count({ where: { societyId: auth.societyId } }),
    prisma.accountingMonth.count({ where: { societyId: auth.societyId, status: "CLOSED" } }),
    prisma.interestDistribution.count({ where: { societyId: auth.societyId, status: "CONFIRMED" } }),
  ]);
  if (changesAfterImport > 0) {
    return {
      imported: true,
      canRollback: false,
      blockedReason: "Other changes were recorded after the import (payments, edits, loans, or month close). The imported data cannot be removed.",
    };
  }
  if (payments > 0) {
    return {
      imported: true,
      canRollback: false,
      blockedReason: "A payment was recorded after the import. Delete payments first, or keep the register as posted.",
    };
  }
  if (closedMonths > 0) {
    return {
      imported: true,
      canRollback: false,
      blockedReason: "A month was closed after the import. The imported register can no longer be removed.",
    };
  }
  if (distributions > 0) {
    return {
      imported: true,
      canRollback: false,
      blockedReason: "Interest was distributed after the import. The imported register can no longer be removed.",
    };
  }
  return { imported: true, canRollback: true, blockedReason: "" };
}

export async function rollbackImportedRegister(auth: AuthUser, reason: string) {
  const status = await importRollbackStatus(auth);
  if (!status.imported) throw new HttpError(404, "This society was not set up from an imported register.");
  if (!status.canRollback) throw new HttpError(409, status.blockedReason || "The imported register can no longer be removed.");
  const { wipeSocietyBooks } = await import("../scripts/wipe-society-books.js");
  return wipeSocietyBooks(auth.societyId);
}

export async function memberRegisterPolicy(auth: AuthUser) {
  const closed = await prisma.accountingMonth.count({
    where: { societyId: auth.societyId, status: "CLOSED" },
  });
  const importedRegister = await societyRegisterImported(auth.societyId);
  if (importedRegister) {
    return { canAddMembers: false, importedRegister: true };
  }
  return { canAddMembers: closed === 0, importedRegister: false };
}

export async function createMember(
  auth: AuthUser,
  input: {
    name: string;
    nameLatin?: string;
    mobile?: string;
    email?: string;
    address?: string;
    joiningDate: string;
    monthlyShare: string;
    username: string;
    password: string;
    reason: string;
  },
) {
  const share = money(input.monthlyShare);
  if (share.isNegative()) throw new HttpError(400, "Monthly share cannot be negative");
  const policy = await memberRegisterPolicy(auth);
  if (!policy.canAddMembers) {
    if (policy.importedRegister) {
      throw new HttpError(
        409,
        "This society was set up from an imported Excel register. New members cannot be added in the app.",
      );
    }
    throw new HttpError(
      409,
      "The first month has already been closed. New members cannot be added after that — only before the first month close.",
    );
  }
  const { normalizeUsername } = await import("./platform.js");
  const username = normalizeUsername(input.username);
  const taken = await prisma.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } });
  if (taken) throw new HttpError(409, `Username ${username} is already in use`);
  const passwordHash = await bcrypt.hash(input.password, 10);
  return prisma.$transaction(async (tx) => {
    await ensureManualOpenIsCurrent(auth.societyId, tx);
    const last = await tx.member.aggregate({ where: { societyId: auth.societyId }, _max: { memberNumber: true } });
    const member = await tx.member.create({
      data: {
        societyId: auth.societyId,
        memberNumber: (last._max.memberNumber ?? 0) + 1,
        name: input.name.trim(),
        nameLatin: input.nameLatin?.trim() ?? "",
        mobile: normalizeMobile(input.mobile ?? "") ?? "",
        email: input.email?.trim() ?? "",
        address: input.address?.trim() ?? "",
        joiningDate: utcDate(input.joiningDate),
        monthlyShare: dec(share.toFixed(2)),
      },
    });
    await tx.user.create({
      data: {
        societyId: auth.societyId,
        memberId: member.id,
        role: "MEMBER",
        name: member.name,
        username,
        mobile: member.mobile,
        passwordHash,
      },
    });
    const month = await tx.accountingMonth.findFirst({ where: { societyId: auth.societyId, status: "OPEN" }, orderBy: { period: "desc" } });
    if (month) await ensureMemberStatement(tx, auth, member.id, month.period);
    await audit(tx, auth, "Added member", "Member", member.id, input.reason, null, { name: member.name, username });
    return { ...member, username };
  });
}

export async function setMemberAccess(
  auth: AuthUser,
  memberId: string,
  input: { username: string; password?: string; reason: string },
) {
  const member = await prisma.member.findFirst({ where: { id: memberId, societyId: auth.societyId } });
  if (!member) throw new HttpError(404, "Member not found");
  const { normalizeUsername } = await import("./platform.js");
  const username = normalizeUsername(input.username);
  const taken = await prisma.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } });
  const current = await prisma.user.findFirst({ where: { memberId: member.id } });
  if (taken && taken.id !== current?.id) throw new HttpError(409, `Username ${username} is already in use`);
  if (!current && !input.password) throw new HttpError(400, "Set a password for this member's first login");
  const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : undefined;
  const user = current
    ? await prisma.user.update({
        where: { id: current.id },
        data: { username, name: member.name, passwordHash, isActive: member.status === "ACTIVE" },
      })
    : await prisma.user.create({
        data: {
          societyId: auth.societyId,
          memberId: member.id,
          role: "MEMBER",
          name: member.name,
          username,
          mobile: member.mobile,
          passwordHash: passwordHash!,
        },
      });
  await prisma.auditLog.create({
    data: {
      societyId: auth.societyId,
      actorId: auth.userId,
      actorName: auth.name,
      action: "Set member login",
      entityType: "User",
      entityId: user.id,
      reason: input.reason,
      newValue: { username, passwordChanged: Boolean(input.password) },
    },
  });
  return { username: user.username };
}

export async function updateMember(
  auth: AuthUser,
  memberId: string,
  input: { name?: string; nameLatin?: string; mobile?: string; email?: string; address?: string; monthlyShare?: string; reason: string },
) {
  const current = await prisma.member.findFirst({ where: { id: memberId, societyId: auth.societyId } });
  if (!current) throw new HttpError(404, "Member not found");
  return prisma.$transaction(async (tx) => {
    const member = await tx.member.update({
      where: { id: current.id },
      data: {
        name: input.name?.trim(),
        nameLatin: input.nameLatin?.trim(),
        mobile: input.mobile === undefined ? undefined : normalizeMobile(input.mobile) ?? "",
        email: input.email?.trim(),
        address: input.address?.trim(),
        monthlyShare: input.monthlyShare ? dec(money(input.monthlyShare).toFixed(2)) : undefined,
      },
    });
    await audit(tx, auth, "Edited member", "Member", member.id, input.reason, {
      name: current.name,
      monthlyShare: str(current.monthlyShare),
    }, { name: member.name, monthlyShare: str(member.monthlyShare) });
    return member;
  });
}

export async function deactivateMember(auth: AuthUser, memberId: string, reason: string) {
  await assertMemberMayDeactivate(auth, memberId);
  return setMemberActive(auth, memberId, false, reason);
}

async function memberDeactivateBlockedMessage(
  auth: AuthUser,
  member: { id: string; name: string; loanOutstanding: Prisma.Decimal },
) {
  const outstanding = str(member.loanOutstanding);
  if (money(outstanding).greaterThan(0)) {
    return (
      `Unable to deactivate ${member.name}. ${formatINR(outstanding)} of loan is still outstanding. ` +
      `Please pay the outstanding loan in full; only then can you deactivate.`
    );
  }
  const open = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!open) return null;
  const receipts = await prisma.payment.count({
    where: {
      societyId: auth.societyId,
      memberId: member.id,
      period: open.period,
      status: "RECORDED",
    },
  });
  if (receipts === 0) return null;
  const label = monthLabel(open.period);
  return `Payment was collected from ${member.name} in ${label}. They cannot be deactivated this month. Deactivate them from the next month after ${label} is closed.`;
}

async function assertMemberMayDeactivate(auth: AuthUser, memberId: string) {
  const member = await prisma.member.findFirst({ where: { id: memberId, societyId: auth.societyId } });
  if (!member) throw new HttpError(404, "Member not found");
  const message = await memberDeactivateBlockedMessage(auth, member);
  if (message) throw new HttpError(409, message);
}

export async function activateMember(auth: AuthUser, memberId: string, reason: string) {
  return setMemberActive(auth, memberId, true, reason);
}

export async function memberDistributionWarning(
  auth: AuthUser,
  input: { action: "deactivate" | "activate" | "add"; memberId?: string },
) {
  const pool = await interestPoolForSociety(auth.societyId);
  const poolLabel = formatINR(pool.combinedAvailable);

  if (input.action === "deactivate") {
    if (!input.memberId) throw new HttpError(400, "Member is required");
    const member = await prisma.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId } });
    if (!member || member.status !== "ACTIVE") {
      return { needsConfirmation: false, blocked: false, message: "", poolAvailable: pool.combinedAvailable };
    }
    const blockMessage = await memberDeactivateBlockedMessage(auth, member);
    if (blockMessage) {
      return {
        needsConfirmation: false,
        blocked: true,
        message: blockMessage,
        poolAvailable: pool.combinedAvailable,
      };
    }
    if (!money(pool.combinedAvailable).greaterThan(0)) {
      return { needsConfirmation: false, blocked: false, message: "", poolAvailable: pool.combinedAvailable };
    }
    return {
      needsConfirmation: true,
      blocked: false,
      poolAvailable: pool.combinedAvailable,
      message:
        `Interest and penalty (${poolLabel}) is still in the society pool and has not been fully distributed. ` +
        `If you deactivate ${member.name}, they will not receive a share of the next distribution. ` +
        `Only the remaining active members will share it. Do you want to continue?`,
    };
  }

  if (input.action === "activate") {
    if (!input.memberId) throw new HttpError(400, "Member is required");
    const member = await prisma.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId } });
    if (!member || member.status !== "INACTIVE") {
      return { needsConfirmation: false, blocked: false, message: "", poolAvailable: pool.combinedAvailable };
    }
    if (!money(pool.combinedAvailable).greaterThan(0)) {
      return { needsConfirmation: false, blocked: false, message: "", poolAvailable: pool.combinedAvailable };
    }
    return {
      needsConfirmation: true,
      blocked: false,
      poolAvailable: pool.combinedAvailable,
      message:
        `Interest and penalty (${poolLabel}) is still in the society pool and has not been fully distributed. ` +
        `If you activate ${member.name}, they will share in the next equal distribution and each active member's share will be smaller. ` +
        `Do you want to continue?`,
    };
  }

  if (!money(pool.combinedAvailable).greaterThan(0)) {
    return { needsConfirmation: false, blocked: false, message: "", poolAvailable: pool.combinedAvailable };
  }

  return {
    needsConfirmation: true,
    blocked: false,
    poolAvailable: pool.combinedAvailable,
    message:
      `Interest and penalty (${poolLabel}) is still in the society pool and has not been fully distributed. ` +
      `The new member will be included in the next equal distribution and each active member's share will be smaller. ` +
      `Do you want to continue?`,
  };
}

/** On deactivation, return share capital and interest wallet in cash and clear loans — member is fully settled. */
async function settleMemberOnExit(tx: Tx, auth: AuthUser, memberId: string, reason: string) {
  await refreshMember(tx, memberId);
  const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });
  const open = await tx.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  const exitDate = new Date().toISOString().slice(0, 10);
  const period = open?.period ?? calendarPeriod();
  const exitRef = `EXIT-M${member.memberNumber}-${member.id.slice(-6)}`;

  const latestStatement = await tx.memberMonth.findFirst({
    where: { societyId: auth.societyId, memberId },
    orderBy: { period: "desc" },
  });
  const registerShares = str(member.shareBalance);
  const statementShares = latestStatement ? str(latestStatement.closingShares) : "0.00";
  const sharePayout =
    isZero(registerShares) && money(statementShares).greaterThan(0) ? statementShares : registerShares;
  const interestPayout = str(member.interestBalance);
  const totalCashOut = sumMoney([sharePayout, interestPayout]);
  const cash = await societyCashOnBooks(tx, auth.societyId);
  if (money(totalCashOut).greaterThan(cash)) {
    throw new HttpError(
      409,
      `The society has ${formatINR(cash)} in hand. Returning shares and interest (${formatINR(totalCashOut)}) on exit needs enough cash.`,
    );
  }

  const assessments = await tx.shareTransaction.findMany({ where: { societyId: auth.societyId, memberId } });
  for (const row of assessments) {
    const unpaid = subtractMoney(str(row.amount), str(row.cashEffect));
    if (money(unpaid).greaterThan(0)) {
      await tx.shareTransaction.update({
        where: { id: row.id },
        data: { amount: dec(str(row.cashEffect)) },
      });
    }
  }

  if (!isZero(sharePayout)) {
    await tx.shareTransaction.create({
      data: {
        societyId: auth.societyId,
        memberId,
        date: utcDate(exitDate),
        period,
        amount: dec(sharePayout),
        cashEffect: dec(subtractMoney("0.00", sharePayout)),
        reason: `Share capital returned on deactivation. ${reason}`,
        reference: `${exitRef}-SHARE`,
        createdById: auth.userId,
      },
    });
    await cashLedger(tx, auth, {
      memberId,
      date: exitDate,
      period,
      type: "REFUND",
      direction: "OUT",
      amount: sharePayout,
      reference: `${exitRef}-SHARE`,
      reason: `Share capital returned to ${member.name} on deactivation.`,
    });
  }

  if (!isZero(interestPayout)) {
    await cashLedger(tx, auth, {
      memberId,
      date: exitDate,
      period,
      type: "WITHDRAWAL",
      direction: "OUT",
      amount: interestPayout,
      reference: `${exitRef}-INTEREST`,
      reason: `Interest balance paid on deactivation. ${reason}`,
    });
  }

  const loans = await tx.loan.findMany({
    where: {
      societyId: auth.societyId,
      memberId,
      outstandingPrincipal: { gt: 0 },
      status: { notIn: ["CANCELLED", "COMPLETED"] },
    },
  });
  for (const loan of loans) {
    const outstanding = str(loan.outstandingPrincipal);
    if (isZero(outstanding)) continue;
    await tx.loanTransaction.create({
      data: {
        societyId: auth.societyId,
        loanId: loan.id,
        memberId,
        date: utcDate(exitDate),
        period,
        type: "ADJUSTMENT",
        amount: dec(outstanding),
        balanceAfter: dec("0.00"),
        reason: `Loan closed on member deactivation. ${reason}`,
        reference: exitRef,
        createdById: auth.userId,
      },
    });
    await tx.loan.update({
      where: { id: loan.id },
      data: { outstandingPrincipal: dec("0.00"), status: "COMPLETED" },
    });
    await cashLedger(tx, auth, {
      memberId,
      date: exitDate,
      period,
      type: "ADJUSTMENT",
      direction: "NONE",
      amount: outstanding,
      reference: `${exitRef}-LOAN-${loan.id.slice(-6)}`,
      reason: `Outstanding loan written off on deactivation of ${member.name}.`,
    });
  }

  const penalties = await tx.penalty.findMany({ where: { societyId: auth.societyId, memberId } });
  for (const row of penalties) {
    const left = subtractMoney(str(row.amount), str(row.collectedAmount));
    if (money(left).greaterThan(0)) {
      await tx.penalty.update({
        where: { id: row.id },
        data: { collectedAmount: row.amount },
      });
    }
  }

  if (open) {
    const statement = await tx.memberMonth.findUnique({
      where: { societyId_memberId_period: { societyId: auth.societyId, memberId, period: open.period } },
    });
    if (statement) {
      await tx.memberMonth.delete({ where: { id: statement.id } });
    }
  }
  if (latestStatement && (!open || latestStatement.period !== open.period) && !isZero(sharePayout)) {
    await tx.memberMonth.update({
      where: { id: latestStatement.id },
      data: { closingShares: dec("0.00") },
    });
  }

  for (const row of await tx.shareTransaction.findMany({ where: { societyId: auth.societyId, memberId } })) {
    if (!isZero(str(row.cashEffect))) {
      await tx.shareTransaction.update({ where: { id: row.id }, data: { cashEffect: dec("0.00") } });
    }
  }
  await tx.interestDistributionEntry.updateMany({
    where: {
      memberId,
      status: { in: ["CREDITED", "ADDED_TO_SHARES", "PAID_CASH"] },
      distribution: { status: "CONFIRMED" },
    },
    data: { status: "REVERSED" },
  });
  await tx.member.update({ where: { id: memberId }, data: { ...zeroMemberMoneyFields } });
  await clearShareChainTipForExit(tx, auth.societyId, memberId, period);
  await audit(tx, auth, "Settled member on exit", "Member", memberId, reason, null, {
    shareReturned: sharePayout,
    interestPaid: interestPayout,
    exitRef,
  });
}

async function setMemberActive(auth: AuthUser, memberId: string, active: boolean, reason: string) {
  const current = await prisma.member.findFirst({ where: { id: memberId, societyId: auth.societyId } });
  if (!current) throw new HttpError(404, "Member not found");
  const next = active ? "ACTIVE" : "INACTIVE";
  if (current.status === next) return current;
  return prisma.$transaction(async (tx) => {
    let exitPeriod: string | null = null;
    if (!active) {
      await settleMemberOnExit(tx, auth, memberId, reason);
      const open = await tx.accountingMonth.findFirst({
        where: { societyId: auth.societyId, status: "OPEN" },
        orderBy: { period: "desc" },
      });
      exitPeriod = open?.period ?? calendarPeriod();
    }
    const member = await tx.member.update({
      where: { id: current.id },
      data: {
        status: next,
        exitedAt: active ? null : utcDate(statementDateFor(exitPeriod ?? calendarPeriod())),
        ...(!active ? { shareBooksFromPeriod: null } : {}),
      },
    });
    if (!active) {
      await healStatementShareCapital(tx, auth.societyId);
    }
    await tx.user.updateMany({
      where: { memberId: member.id },
      data: { isActive: active, tokenVersion: { increment: 1 } },
    });
    if (active) {
      const month = await tx.accountingMonth.findFirst({ where: { societyId: auth.societyId, status: "OPEN" }, orderBy: { period: "desc" } });
      if (month) {
        if (current.status === "INACTIVE") {
          await prepareMemberReentry(tx, auth, member.id, month.period);
          await purgeMemberBooksBeforePeriod(tx, auth.societyId, member.id, month.period);
          await tx.member.update({
            where: { id: member.id },
            data: { shareBooksFromPeriod: month.period },
          });
          await ensureMemberStatement(tx, auth, member.id, month.period, { reentry: true });
          await rebuildMemberStatementShares(tx, auth.societyId, member.id, month.period);
          await refreshMember(tx, member.id);
          await healStatementShareCapital(tx, auth.societyId);
        } else {
          await ensureMemberStatement(tx, auth, member.id, month.period);
        }
      }
    }
    await audit(tx, auth, active ? "Activated member" : "Deactivated member", "Member", member.id, reason, { status: current.status }, { status: next });
    return member;
  });
}

export async function createLoan(
  auth: AuthUser,
  input: { memberId: string; amount: string; date: string; scheduledPrincipal: string; purpose?: string; notes?: string; interestRate?: string; reason: string },
) {
  const month = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!month) throw new HttpError(409, "There is no open month. Open a month before disbursing a loan.");
  if (!input.memberId.trim()) throw new HttpError(400, "Please select a member.");
  const period = month.period;
  const society = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  const rate = input.interestRate ?? str(society.interestRate);
  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId, status: "ACTIVE" } });
    if (!member) {
      const known = await tx.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId } });
      if (!known) throw new HttpError(404, "Member not found.");
      throw new HttpError(409, "This member has left the society, so a loan cannot be disbursed.");
    }
    const amount = money(input.amount).toFixed(2);
    if (money(amount).lessThanOrEqualTo(0)) throw new HttpError(400, "Loan amount must be greater than zero");
    const cash = await societyCashOnBooks(tx, auth.societyId);
    if (money(amount).greaterThan(cash)) {
      throw new HttpError(400, `The society has ${formatINR(cash)} in hand. The loan cannot be more than that.`);
    }
    const existing = await tx.loan.findFirst({
      where: { societyId: auth.societyId, memberId: member.id, outstandingPrincipal: { gt: 0 }, status: { notIn: ["CANCELLED", "COMPLETED"] } },
      orderBy: [{ loanDate: "asc" }, { createdAt: "asc" }],
    });
    const scheduled = money(input.scheduledPrincipal).toFixed(2);
    const loan = existing
      ? await tx.loan.update({
          where: { id: existing.id },
          data: {
            originalPrincipal: dec(sumMoney([str(existing.originalPrincipal), amount])),
            outstandingPrincipal: dec(sumMoney([str(existing.outstandingPrincipal), amount])),
            scheduledPrincipal: dec(scheduled),
            status: "ACTIVE",
            purpose: input.purpose ? input.purpose : existing.purpose,
            notes: input.notes ? input.notes : existing.notes,
          },
        })
      : await tx.loan.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            originalPrincipal: dec(amount),
            loanDate: utcDate(input.date),
            interestRate: dec(new Prisma.Decimal(rate).toFixed(6)),
            interestType: society.interestCalculationMethod,
            outstandingPrincipal: dec(amount),
            scheduledPrincipal: dec(scheduled),
            status: "ACTIVE",
            purpose: input.purpose ?? "",
            notes: input.notes ?? "",
          },
        });
    await tx.loanTransaction.create({
      data: {
        societyId: auth.societyId,
        loanId: loan.id,
        memberId: member.id,
        date: utcDate(input.date),
        period,
        type: "DISBURSEMENT",
        amount: dec(amount),
        balanceAfter: dec(str(loan.outstandingPrincipal)),
        reason: input.reason,
        reference: `LOAN-${loan.id.slice(-6)}`,
        createdById: auth.userId,
      },
    });
    await cashLedger(tx, auth, {
      memberId: member.id,
      date: input.date,
      period,
      type: "LOAN_DISBURSEMENT",
      direction: "OUT",
      amount,
      reference: loan.id,
      reason: input.reason,
    });
    await refreshMember(tx, member.id);
    const statement = await tx.memberMonth.findUnique({
      where: { societyId_memberId_period: { societyId: auth.societyId, memberId: member.id, period } },
    });
    if (statement) await syncOpenLoanStatement(tx, auth, statement);
    await audit(tx, auth, "Disbursed loan", "Loan", loan.id, input.reason, null, { amount });
    const user = await tx.user.findFirst({ where: { memberId: member.id } });
    await notify(tx, {
      societyId: auth.societyId,
      userId: user?.id,
      memberId: member.id,
      type: "LOAN_DISBURSED",
      title: "Loan disbursed",
      body: `${member.name} received ${amount}. Interest and scheduled principal start next month, matching the register.`,
    });
    return loan;
  });
}

async function applyManualPenalty(
  tx: Tx,
  auth: AuthUser,
  input: { memberId: string; period: string; amount: string; date: string; reason: string },
) {
  const penalty = extraPenaltyAmount(input.amount);
  if (isZero(penalty)) throw new HttpError(400, "Penalty amount must be greater than zero");
  const month = await tx.accountingMonth.findUnique({ where: { societyId_period: { societyId: auth.societyId, period: input.period } } });
  if (!month || month.status !== "OPEN") throw new HttpError(409, "Penalties can only be added to an open month");
  const statement = await ensureMemberStatement(tx, auth, input.memberId, input.period);
  if (!statement) throw new HttpError(404, "Open statement not found");
  const row = await tx.penalty.create({
    data: {
      societyId: auth.societyId,
      memberId: input.memberId,
      period: input.period,
      date: utcDate(input.date),
      amount: dec(penalty),
      source: "MANUAL",
      reason: input.reason,
      createdById: auth.userId,
    },
  });
  const nextPenalty = sumMoney([str(statement.penalty), penalty]);
  const total = calculateInstallment({
    monthlyShare: str(statement.monthlyShare),
    previousInterest: str(statement.previousInterest),
    currentInterest: str(statement.currentInterest),
    principal: str(statement.principalDue),
    penalty: nextPenalty,
  });
  await tx.memberMonth.update({
    where: { id: statement.id },
    data: { penalty: dec(nextPenalty), totalInstallment: dec(total) },
  });
  await audit(tx, auth, "Added penalty", "Penalty", row.id, input.reason, { penalty: str(statement.penalty), total: str(statement.totalInstallment) }, { penalty: nextPenalty, total });
  return row;
}

export async function addPenalty(auth: AuthUser, input: { memberId: string; period: string; amount: string; date: string; reason: string; nextMonth?: boolean }) {
  return prisma.$transaction((tx) =>
    input.nextMonth ? scheduleNextMonthPenalty(tx, auth, input) : applyManualPenalty(tx, auth, input),
  );
}

export async function withdrawInterest(auth: AuthUser, input: { memberId: string; amount: string; date: string; reason: string }) {
  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findFirst({ where: { id: input.memberId, societyId: auth.societyId } });
    if (!member) throw new HttpError(404, "Member not found");
    const amount = money(input.amount).toFixed(2);
    if (money(amount).greaterThan(str(member.interestBalance))) throw new HttpError(400, "Withdrawal is larger than the interest balance");
    const period = input.date.slice(0, 7);
    await assertPeriodOpen(auth.societyId, period);
    await cashLedger(tx, auth, {
      memberId: member.id,
      date: input.date,
      period,
      type: "WITHDRAWAL",
      direction: "OUT",
      amount,
      reference: "INTEREST-WITHDRAWAL",
      reason: input.reason,
    });
    await refreshMember(tx, member.id);
    await audit(tx, auth, "Withdrew interest", "Member", member.id, input.reason, { interestBalance: str(member.interestBalance) }, { amount });
    return tx.member.findUniqueOrThrow({ where: { id: member.id } });
  });
}

function distributedPortionsFromRow(row: { totalDistributed: unknown; interestPortion: unknown; penaltyPortion: unknown }) {
  const total = str(row.totalDistributed);
  const interest = str(row.interestPortion);
  const penalty = str(row.penaltyPortion);
  if (money(interest).greaterThan(0) || money(penalty).greaterThan(0)) {
    return { interest, penalty };
  }
  return { interest: total, penalty: "0.00" };
}

export async function interestPoolForSociety(societyId: string, tx: Tx | typeof prisma = prisma) {
  const events = await tx.interestEvent.findMany({ where: { societyId } });
  const interestCollected = sumMoney(events.filter((row) => row.kind === "COLLECTION").map((row) => str(row.amount)));
  const accrued = sumInterestAccrualEvents(
    events.map((row) => ({
      kind: row.kind,
      memberId: row.memberId,
      period: row.period,
      amount: str(row.amount),
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  );
  const ledger = await tx.ledgerEntry.findMany({ where: { societyId } });
  const penaltyCollected = netLedgerByType(
    ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
    "PENALTY_COLLECTION",
  );
  const distributions = await tx.interestDistribution.findMany({ where: { societyId, status: "CONFIRMED" } });
  const portions = distributions.map((row) => distributedPortionsFromRow(row));
  const interestDistributed = sumMoney(portions.map((row) => row.interest));
  const penaltyDistributed = sumMoney(portions.map((row) => row.penalty));
  const distributed = sumMoney(distributions.map((row) => str(row.totalDistributed)));
  const interestAvailable = subtractMoney(interestCollected, interestDistributed);
  const penaltyAvailable = subtractMoney(penaltyCollected, penaltyDistributed);
  const combinedAvailable = sumMoney([interestAvailable, penaltyAvailable]);
  const pool = calculateInterestPool({ accrued, collected: interestCollected, distributed: interestDistributed });
  return {
    accrued: pool.accrued,
    collected: interestCollected,
    pending: pool.pending,
    distributed: interestDistributed,
    available: interestAvailable,
    penaltyCollected,
    penaltyDistributed,
    penaltyAvailable,
    combinedAvailable,
    totalDistributed: distributed,
  };
}

/** Open month is settled for distribution when a receipt exists (any amount, including ₹0) or nothing is due. */
async function openMonthCollectionSettled(
  societyId: string,
  memberId: string,
  period: string,
  tx: Tx | typeof prisma = prisma,
) {
  const receiptCount = await tx.payment.count({
    where: { societyId, memberId, period, status: "RECORDED" },
  });
  if (receiptCount > 0) return true;
  const due = await duesFor(societyId, memberId, period, tx);
  return !money(due.totalDue).greaterThan(0);
}

async function openMonthCollectionGate(auth: AuthUser) {
  await ensureOpenStatements(auth);
  const open = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!open) return { period: null as string | null, openMonth: "", unpaid: [] as { name: string; totalDue: string }[] };
  const active = await prisma.member.findMany({
    where: { societyId: auth.societyId, status: "ACTIVE" },
    orderBy: { memberNumber: "asc" },
  });
  const unpaid: { name: string; totalDue: string }[] = [];
  for (const member of active) {
    const settled = await openMonthCollectionSettled(auth.societyId, member.id, open.period);
    if (settled) continue;
    const due = await duesFor(auth.societyId, member.id, open.period);
    unpaid.push({ name: member.name, totalDue: due.totalDue });
  }
  return { period: open.period, openMonth: monthLabel(open.period), unpaid };
}

function collectionGateMessage(gate: Awaited<ReturnType<typeof openMonthCollectionGate>>) {
  const list = gate.unpaid.map((row) => `${row.name} (${formatINR(row.totalDue)} due, no receipt yet)`).join(", ");
  return `Record a payment for every active member in ${gate.openMonth} before you distribute (₹0 is fine). Still needed: ${list}.`;
}

export async function distributionPreview(auth: AuthUser, _period?: string) {
  const society = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  if (society.distributionMethod !== "EQUAL" || society.interestEligibilityRule !== "ALL_ACTIVE_MEMBERS") {
    throw new HttpError(400, "Only equal distribution to all active members is enabled");
  }
  const open = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  const period = open?.period ?? _period ?? calendarPeriod();
  const pool = await interestPoolForSociety(auth.societyId);
  const members = await prisma.member.findMany({
    where: { societyId: auth.societyId, status: "ACTIVE" },
    orderBy: { memberNumber: "asc" },
  });
  if (members.length === 0) throw new HttpError(409, "There are no active members");
  const distribution = calculateInterestDistribution(
    pool.combinedAvailable,
    members.length,
    society.roundingPolicy === "LARGEST_REMAINDER" ? "LARGEST_REMAINDER" : "UNIFORM_HALF_UP_REMAINDER",
  );
  const gate = await openMonthCollectionGate(auth);
  const collectionsComplete = gate.unpaid.length === 0;
  return {
    period,
    month: monthLabel(period),
    interestAccrued: pool.accrued,
    interestCollected: pool.collected,
    interestPending: pool.pending,
    interestDistributed: pool.distributed,
    penaltyCollected: pool.penaltyCollected,
    penaltyDistributed: pool.penaltyDistributed,
    penaltyAvailable: pool.penaltyAvailable,
    interestAvailable: pool.available,
    poolAvailable: pool.combinedAvailable,
    collectedToDate: pool.collected,
    alreadyDistributed: pool.totalDistributed,
    eligibleMembers: members.map((member, index) => ({
      id: member.id,
      name: member.name,
      nameLatin: member.nameLatin,
      shares: str(member.shareBalance),
      amount: distribution.amounts[index],
      status: "PREVIEW",
    })),
    eligibleCount: members.length,
    perMember: distribution.perMember,
    totalDistributed: distribution.totalDistributed,
    remaining: distribution.remaining,
    roundingMode: distribution.roundingModeApplied,
    canConfirm: money(pool.combinedAvailable).greaterThan(0) && collectionsComplete,
    collectionsComplete,
    openMonth: gate.openMonth,
    unpaidMembers: gate.unpaid,
    alreadyCompleted: false,
  };
}

export type DistributionPayoutMethod = "CASH" | "SHARES";

export async function confirmDistribution(
  auth: AuthUser,
  period: string,
  reason: string,
  payouts?: { memberId: string; payoutMethod: DistributionPayoutMethod }[],
) {
  const preview = await distributionPreview(auth, period);
  const gate = await openMonthCollectionGate(auth);
  if (gate.unpaid.length > 0) {
    throw new HttpError(409, collectionGateMessage(gate));
  }
  if (!preview.canConfirm) {
    throw new HttpError(409, "Nothing is available to distribute. Collect interest or penalties first.");
  }
  const payoutMap =
    payouts && payouts.length > 0
      ? new Map(payouts.map((row) => [row.memberId, row.payoutMethod]))
      : new Map(preview.eligibleMembers.map((member) => [member.id, "SHARES" as DistributionPayoutMethod]));
  for (const member of preview.eligibleMembers) {
    const method = payoutMap.get(member.id);
    if (method !== "CASH" && method !== "SHARES") {
      throw new HttpError(400, `Choose cash or share for every member (${member.name}).`);
    }
  }
  return prisma.$transaction(async (tx) => {
    const again = await interestPoolForSociety(auth.societyId, tx);
    if (!money(again.combinedAvailable).equals(money(preview.poolAvailable))) {
      throw new HttpError(409, "The pool changed. Preview again before confirming.");
    }
    const totalOut = preview.totalDistributed;
    const penaltyPortion = money(again.penaltyAvailable).lessThan(totalOut) ? again.penaltyAvailable : totalOut;
    const interestPortion = subtractMoney(totalOut, penaltyPortion);
    const prior = await tx.interestDistribution.count({ where: { societyId: auth.societyId } });
    const code = prior === 0 ? `DIST-${preview.period}` : `DIST-${preview.period}-${prior + 1}`;
    const distDate = new Date().toISOString().slice(0, 10);
    const saved = await tx.interestDistribution.create({
      data: {
        societyId: auth.societyId,
        code,
        period: preview.period,
        totalAvailable: dec(preview.poolAvailable),
        eligibleCount: preview.eligibleCount,
        perMemberAmount: dec(preview.perMember),
        totalDistributed: dec(preview.totalDistributed),
        interestPortion: dec(interestPortion),
        penaltyPortion: dec(penaltyPortion),
        remaining: dec(preview.remaining),
        roundingMode: preview.roundingMode,
        status: "CONFIRMED",
        reason,
        createdById: auth.userId,
        confirmedAt: new Date(),
        entries: {
          create: preview.eligibleMembers.map((member) => {
            const payoutMethod = payoutMap.get(member.id)!;
            return {
              memberId: member.id,
              amount: dec(member.amount),
              payoutMethod,
              status: payoutMethod === "CASH" ? "PAID_CASH" : "ADDED_TO_SHARES",
            };
          }),
        },
      },
      include: { entries: true },
    });
    for (const member of preview.eligibleMembers) {
      const payoutMethod = payoutMap.get(member.id)!;
      if (payoutMethod === "SHARES") {
        await tx.shareTransaction.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            date: utcDate(distDate),
            period: preview.period,
            amount: dec(member.amount),
            cashEffect: dec(member.amount),
            reason,
            reference: code,
            createdById: auth.userId,
          },
        });
      } else {
        await cashLedger(tx, auth, {
          memberId: member.id,
          date: distDate,
          period: preview.period,
          type: "WITHDRAWAL",
          direction: "OUT",
          amount: member.amount,
          reference: code,
          reason: `${reason} (paid in cash)`,
        });
      }
      await cashLedger(tx, auth, {
        memberId: member.id,
        date: distDate,
        period: preview.period,
        type: "INTEREST_DISTRIBUTION",
        direction: "NONE",
        amount: member.amount,
        reference: code,
        reason,
      });
      await refreshMember(tx, member.id);
      const user = await tx.user.findFirst({ where: { memberId: member.id } });
      await notify(tx, {
        societyId: auth.societyId,
        userId: user?.id,
        memberId: member.id,
        type: "INTEREST_DISTRIBUTED",
        title: payoutMethod === "CASH" ? "Interest + penalty paid in cash" : "Interest + penalty added to shares",
        body: `${formatINR(member.amount)} from the pool`,
      });
    }
    for (const member of preview.eligibleMembers) {
      if (payoutMap.get(member.id) === "SHARES") {
        await rebuildMemberStatementShares(tx, auth.societyId, member.id);
      }
    }
    await audit(tx, auth, "Confirmed interest distribution", "InterestDistribution", saved.id, reason, null, {
      code,
      totalDistributed: preview.totalDistributed,
      remaining: preview.remaining,
    });
    return saved;
  }, { timeout: 30000 });
}

export async function reverseDistribution(auth: AuthUser, id: string, reason: string) {
  if (auth.role !== "OWNER") throw new HttpError(403, "Only the society owner can reverse a distribution");
  return prisma.$transaction(async (tx) => {
    const distribution = await tx.interestDistribution.findFirst({
      where: { id, societyId: auth.societyId },
      include: { entries: true },
    });
    if (!distribution) throw new HttpError(404, "Distribution not found");
    if (distribution.status !== "CONFIRMED") throw new HttpError(409, "Only a completed distribution can be reversed");
    const open = await tx.accountingMonth.findFirst({
      where: { societyId: auth.societyId, status: "OPEN" },
      orderBy: { period: "desc" },
    });
    const reversalPeriod = open?.period ?? distribution.period;
    await tx.interestDistribution.update({ where: { id }, data: { status: "REVERSED" } });
    await tx.interestDistributionEntry.updateMany({ where: { distributionId: id }, data: { status: "REVERSED" } });
    for (const entry of distribution.entries) {
      await cashLedger(tx, auth, {
        memberId: entry.memberId,
        date: new Date().toISOString().slice(0, 10),
        period: reversalPeriod,
        type: "REVERSAL",
        direction: "NONE",
        amount: str(entry.amount),
        reference: distribution.code,
        reason,
      });
      await refreshMember(tx, entry.memberId);
    }
    await audit(tx, auth, "Reversed interest distribution", "InterestDistribution", id, reason, { status: "CONFIRMED" }, { status: "REVERSED" });
    return { id, status: "REVERSED" };
  });
}

export async function previewClose(auth: AuthUser) {
  await ensureOpenStatements(auth);
  const month = await openMonth(auth.societyId);
  const statements = (await prisma.memberMonth.findMany({
    where: { societyId: auth.societyId, period: month.period },
    include: { member: true },
    orderBy: { member: { memberNumber: "asc" } },
  })).filter((row) => row.member.status === "ACTIVE");
  const parts = {
    monthlyShare: sumMoney(statements.map((row) => str(row.monthlyShare))),
    previousInterest: sumMoney(statements.map((row) => str(row.previousInterest))),
    currentInterest: sumMoney(statements.map((row) => str(row.currentInterest))),
    principal: sumMoney(statements.map((row) => str(row.principalDue))),
    penalty: sumMoney(statements.map((row) => str(row.penalty))),
  };
  const installment = sumMoney(statements.map((row) => str(row.totalInstallment)));
  const formula = calculateInstallment(parts);
  const shareOpening = sumMoney(statements.map((row) => str(row.openingShares)));
  const shareMovement = sumMoney(statements.map((row) => str(row.shareMovement)));
  const shareClosing = sumMoney(statements.map((row) => str(row.closingShares)));
  const loans = await prisma.loan.findMany({ where: { societyId: auth.societyId, status: { not: "CANCELLED" } } });
  const loanTx = await prisma.loanTransaction.findMany({ where: { societyId: auth.societyId } });
  const disbursed = sumMoney(loanTx.filter((row) => row.type === "DISBURSEMENT").map((row) => str(row.amount)));
  const repaid = sumMoney(
    loanTx
      .filter((row) => row.type === "PRINCIPAL_REPAYMENT" || row.type === "ADJUSTMENT")
      .map((row) => str(row.amount)),
  );
  const outstanding = sumMoney(loans.map((row) => str(row.outstandingPrincipal)));
  const events = await prisma.interestEvent.findMany({ where: { societyId: auth.societyId } });
  const collected = sumMoney(events.filter((row) => row.kind === "COLLECTION").map((row) => str(row.amount)));
  const accrued = sumInterestAccrualEvents(
    events.map((row) => ({
      kind: row.kind,
      memberId: row.memberId,
      period: row.period,
      amount: str(row.amount),
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  );
  const distributions = await prisma.interestDistribution.findMany({ where: { societyId: auth.societyId, status: "CONFIRMED" } });
  const distributed = sumMoney(distributions.map((row) => str(row.totalDistributed)));
  const poolDetail = await interestPoolForSociety(auth.societyId);
  const remaining = poolDetail.combinedAvailable;
  const ledger = await prisma.ledgerEntry.findMany({ where: { societyId: auth.societyId } });
  const periodLedger = ledger.filter((row) => row.period === month.period);
  const penaltyCollectedPeriod = netLedgerByType(
    periodLedger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
    "PENALTY_COLLECTION",
  );
  const penaltyDistributedPeriod = sumMoney(
    distributions
      .filter((row) => row.period === month.period)
      .map((row) => distributedPortionsFromRow(row).penalty),
  );
  const cashIn = sumMoney(ledger.filter((row) => row.cashEffect === "IN").map((row) => str(row.credit)));
  const cashOut = sumMoney(ledger.filter((row) => row.cashEffect === "OUT").map((row) => str(row.debit)));
  const cash = subtractMoney(cashIn, cashOut);
  const members = await prisma.member.findMany({ where: { societyId: auth.societyId } });
  const shareRegister = await prisma.shareTransaction.findMany({ where: { societyId: auth.societyId } });
  const distributedEntries = await prisma.interestDistributionEntry.findMany({
    where: { distribution: { societyId: auth.societyId, status: "CONFIRMED" } },
  });
  const interestCashIn = netLedgerByType(
    ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
    "INTEREST_COLLECTION",
  );
  const penaltyCashIn = netLedgerByType(
    ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
    "PENALTY_COLLECTION",
  );
  const distributedToMembers = sumMoney(distributedEntries.map((row) => str(row.amount)));
  const poolCollections = sumMoney([interestCashIn, penaltyCashIn]);
  const societyCash = societyBalanceFromLedger(
    ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
  );
  const checks = reconcile([
    { name: "Total installment", expected: formula, calculated: installment },
    { name: "Closing shares", expected: calculateClosingShares(shareOpening, shareMovement), calculated: shareClosing },
    { name: "Share register", expected: sumMoney(shareRegister.map((row) => str(row.cashEffect))), calculated: sumMoney(members.map((row) => str(row.shareBalance))) },
    { name: "Closing principal", expected: calculateLoanBalance("0.00", disbursed, repaid), calculated: outstanding },
    { name: "Interest collected", expected: collected, calculated: interestCashIn },
    { name: "Interest credited to members", expected: distributedToMembers, calculated: sumMoney(members.map((row) => str(row.interestEarned))) },
    { name: "Interest pool", expected: remaining, calculated: subtractMoney(poolCollections, distributedToMembers) },
    { name: "Interest distribution", expected: distributed, calculated: distributedToMembers },
    { name: "Society balance", expected: societyCash.expected, calculated: societyCash.calculated },
  ]);
  const dues = await Promise.all(statements.map(async (row) => duesFor(auth.societyId, row.memberId, month.period)));
  const stillDue = sumMoney(dues.map((row) => row.totalDue));
  const collections = statements
    .map((row, index) => ({
      memberId: row.memberId,
      number: row.member.memberNumber,
      name: row.member.name,
      paid: sumMoney(Object.values(dues[index]!.paid)),
      unpaid: dues[index]!.totalDue,
    }))
    .sort((a, b) => {
      const aUnpaid = money(a.unpaid).greaterThan(0) ? 0 : 1;
      const bUnpaid = money(b.unpaid).greaterThan(0) ? 0 : 1;
      if (aUnpaid !== bUnpaid) return aUnpaid - bUnpaid;
      return a.number - b.number;
    });
  return {
    period: month.period,
    month: monthLabel(month.period),
    collections,
    parts,
    installment,
    interestAccrued: accrued,
    interestCollected: collected,
    interestDistributed: distributed,
    penaltyAssessed: parts.penalty,
    penaltyCollected: penaltyCollectedPeriod,
    penaltyDistributed: penaltyDistributedPeriod,
    interestAvailable: remaining,
    principalRecovered: repaid,
    loansDisbursed: disbursed,
    loansOutstanding: outstanding,
    societyCash: cash,
    stillDue,
    checks,
    warnings: [
      money(stillDue).greaterThan(0) ? `Unpaid installments of ${stillDue} will carry into the next month as dues, not as a broken equation.` : null,
      money(remaining).greaterThan(0) ? `Collected interest of ${remaining} is still undistributed.` : null,
    ].filter(Boolean),
  };
}

export async function confirmClose(auth: AuthUser, reason: string) {
  const preview = await previewClose(auth);
  if (!preview.checks.ok) {
    throw new HttpError(422, "Financial reconciliation error", preview.checks);
  }
  const society = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  return prisma.$transaction(async (tx) => {
    const month = await tx.accountingMonth.findUnique({
      where: { societyId_period: { societyId: auth.societyId, period: preview.period } },
    });
    if (!month || month.status !== "OPEN") throw new HttpError(409, "That month is already closed");
    const { monthSheet, monthSheetCollected } = await import("./read.js");
    const sheet = await monthSheet(auth, month.period, { snapshot: true });
    const sheetCollected = await monthSheetCollected(auth, month.period, { snapshot: true });
    await tx.accountingMonth.update({
      where: { id: month.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedById: auth.userId,
        summary: { ...preview, sheet, sheetCollected } as unknown as Prisma.InputJsonValue,
      },
    });
    const period = nextPeriod(month.period);
    const createdMonth = await tx.accountingMonth.create({
      data: {
        societyId: auth.societyId,
        period,
        status: "OPEN",
        statementDate: utcDate(statementDateFor(period)),
      },
    });
    const members = await tx.member.findMany({ where: { societyId: auth.societyId, status: "ACTIVE" }, orderBy: { memberNumber: "asc" } });
    for (const member of members) {
      const previous = await tx.memberMonth.findUnique({
        where: { societyId_memberId_period: { societyId: auth.societyId, memberId: member.id, period: month.period } },
      });
      const unpaid = previous
        ? await unpaidFromPeriod(auth.societyId, member.id, month.period, tx)
        : { share: "0.00", interest: "0.00", penalty: "0.00", principal: "0.00" };
      const openingShares = previous ? str(previous.closingShares) : str(member.shareBalance);
      const monthlyShare = str(member.monthlyShare);
      const closingShares = openingShares;
      if (money(monthlyShare).greaterThan(0)) {
        await tx.shareTransaction.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            date: utcDate(statementDateFor(period)),
            period,
            amount: dec(monthlyShare),
            cashEffect: dec("0.00"),
            reason: "Monthly share assessed for the new statement. Cash is collected with the installment.",
            reference: `SHARE-ASSESS-${period}`,
            createdById: auth.userId,
          },
        });
        await cashLedger(tx, auth, {
          memberId: member.id,
          date: statementDateFor(period),
          period,
          type: "MEMBER_CONTRIBUTION",
          direction: "NONE",
          amount: monthlyShare,
          reference: `SHARE-ASSESS-${period}`,
          reason: "Share assessment. Not cash until the installment is collected.",
        });
      }
      await consolidateActiveLoans(tx, auth.societyId, member.id);
      const book = await loanBookForMember(tx, auth.societyId, member.id);
      const openingPrincipal = book.outstanding;
      const scheduled = book.scheduled;
      const principalDue = principalDueThisMonth(openingPrincipal, scheduled);
      const currentInterest = calculateCurrentInterest(openingPrincipal, society.interestRate.toString());
      const deferredPenalty = await scheduledPenaltyFor(tx, auth.societyId, member.id, period);
      const penaltyDue = sumMoney([unpaid.penalty, deferredPenalty]);
      const total = calculateInstallment({
        monthlyShare,
        previousInterest: unpaid.interest,
        currentInterest,
        principal: principalDue,
        penalty: penaltyDue,
      });
      await tx.memberMonth.create({
        data: {
          societyId: auth.societyId,
          memberId: member.id,
          period,
          openingShares: dec(openingShares),
          monthlyShare: dec(monthlyShare),
          shareMovement: dec("0.00"),
          shareCashPending: dec(monthlyShare),
          arrearsCash: dec(unpaid.share),
          closingShares: dec(closingShares),
          openingPrincipal: dec(openingPrincipal),
          principalDue: dec(principalDue),
          previousInterest: dec(unpaid.interest),
          currentInterest: dec(currentInterest),
          interestOutstanding: dec(sumMoney([unpaid.interest, currentInterest])),
          penalty: dec(penaltyDue),
          totalInstallment: dec(total),
        },
      });
      await ensurePenaltyAssessment(tx, auth, member.id, period, penaltyDue);
      await upsertInterestAccrual(tx, auth, {
        memberId: member.id,
        period,
        amount: currentInterest,
        reason: `Interest at ${str(society.interestRate)} on outstanding ${openingPrincipal}`,
      });
      await refreshMember(tx, member.id);
    }
    await healStatementShareCapital(tx, auth.societyId);
    await audit(tx, auth, "Closed month", "AccountingMonth", month.id, reason, { status: "OPEN" }, { status: "CLOSED", next: period });
    await notify(tx, {
      societyId: auth.societyId,
      userId: auth.userId,
      type: "MONTH_CLOSING",
      title: `${monthLabel(month.period)} closed`,
      body: `${monthLabel(period)} is now open.`,
    });
    return { closed: month.period, opened: createdMonth.period };
  }, { timeout: 60000 });
}

export async function reopenStatus(auth: AuthUser) {
  const open = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  if (!open) {
    return {
      canReopen: false,
      openPeriod: "",
      openMonth: "",
      previousPeriod: "",
      previousMonth: "",
      blocked: "There is no open month.",
    };
  }
  const prior = previousPeriod(open.period);
  const previous = await prisma.accountingMonth.findUnique({
    where: { societyId_period: { societyId: auth.societyId, period: prior } },
  });
  const base = {
    openPeriod: open.period,
    openMonth: monthLabel(open.period),
    previousPeriod: prior,
    previousMonth: monthLabel(prior),
  };
  if (!previous || previous.status !== "CLOSED") {
    return { ...base, canReopen: false, blocked: `${monthLabel(prior)} is not a closed month, so it cannot be reopened.` };
  }
  const payments = await prisma.payment.count({
    where: { societyId: auth.societyId, period: open.period, status: "RECORDED" },
  });
  if (payments > 0) {
    return {
      ...base,
      canReopen: false,
      blocked: `${monthLabel(open.period)} already has collections. You can only go back before anything is collected in the new month.`,
    };
  }
  const loans = await prisma.loanTransaction.count({
    where: {
      societyId: auth.societyId,
      period: open.period,
      type: "DISBURSEMENT",
      NOT: { reference: { startsWith: "IMPORT-LOAN" } },
    },
  });
  if (loans > 0) {
    return {
      ...base,
      canReopen: false,
      blocked: `${monthLabel(open.period)} already has a loan. You can only go back before a loan is given in the new month.`,
    };
  }
  const shared = await prisma.interestDistribution.count({
    where: { societyId: auth.societyId, period: open.period, status: "CONFIRMED" },
  });
  if (shared > 0) {
    return {
      ...base,
      canReopen: false,
      blocked: `Interest was already shared in ${monthLabel(open.period)}. That month cannot be rolled back.`,
    };
  }
  const newMembers = await prisma.memberMonth.count({
    where: {
      societyId: auth.societyId,
      period: open.period,
      NOT: { member: { statements: { some: { societyId: auth.societyId, period: prior } } } },
    },
  });
  if (newMembers > 0) {
    return {
      ...base,
      canReopen: false,
      blocked: `A member was added in ${monthLabel(open.period)}. You can only go back before new members are added.`,
    };
  }
  return { ...base, canReopen: true, blocked: "" };
}

/** Reopen the last closed month so staff can correct a collection, then close again. Only one month back. */
export async function reopenPreviousMonth(auth: AuthUser, reason: string) {
  const status = await reopenStatus(auth);
  if (!status.canReopen) throw new HttpError(409, status.blocked || "This month cannot be reopened.");
  const openPeriod = status.openPeriod;
  const prior = status.previousPeriod;
  return prisma.$transaction(async (tx) => {
    const previous = await tx.accountingMonth.findUniqueOrThrow({
      where: { societyId_period: { societyId: auth.societyId, period: prior } },
    });
    await tx.memberMonth.deleteMany({ where: { societyId: auth.societyId, period: openPeriod } });
    await tx.shareTransaction.deleteMany({ where: { societyId: auth.societyId, period: openPeriod } });
    await tx.ledgerEntry.deleteMany({ where: { societyId: auth.societyId, period: openPeriod } });
    await tx.interestEvent.deleteMany({ where: { societyId: auth.societyId, period: openPeriod } });
    await tx.penalty.deleteMany({
      where: { societyId: auth.societyId, period: openPeriod, source: { not: "NEXT_MONTH" } },
    });
    await tx.accountingMonth.deleteMany({ where: { societyId: auth.societyId, period: openPeriod } });
    await tx.accountingMonth.update({
      where: { id: previous.id },
      data: { status: "OPEN", closedAt: null, closedById: null, summary: Prisma.JsonNull },
    });
    const members = await tx.member.findMany({ where: { societyId: auth.societyId }, select: { id: true } });
    for (const member of members) await refreshMember(tx, member.id);
    await audit(tx, auth, "Reopened previous month", "AccountingMonth", previous.id, reason, { status: "CLOSED", next: openPeriod }, { status: "OPEN" });
    await notify(tx, {
      societyId: auth.societyId,
      userId: auth.userId,
      type: "MONTH_CLOSING",
      title: `${status.previousMonth} is open again`,
      body: `${status.openMonth} was not closed. Receipts in ${status.previousMonth} can be changed, then the month can be closed again.`,
    });
    return { opened: prior, removed: openPeriod };
  }, { timeout: 60000 });
}

type ImportRow = {
  name: string;
  totalShares: string;
  loanOutstanding: string;
  monthlyShare: string;
  sharePending?: string;
  previousInterest: string;
  currentInterest: string;
  principal: string;
  penalty: string;
};

export async function importRegister(
  auth: AuthUser,
  input: { period: string; reason: string; rows: ImportRow[] },
) {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new HttpError(400, "Choose a month as YYYY-MM");
  const current = calendarPeriod();
  const earliestImport = importEarliestPeriod(current);
  if (input.period > current) {
    throw new HttpError(400, "Choose one of the last three months. A future month cannot be opened.");
  }
  if (input.period < earliestImport) {
    throw new HttpError(
      400,
      `Import is only for the last three months (${monthLabel(earliestImport)} through ${monthLabel(current)}).`,
    );
  }
  if (input.rows.length === 0) throw new HttpError(400, "The import has no members");
  const existing = await prisma.member.count({ where: { societyId: auth.societyId } });
  if (existing > 0) {
    throw new HttpError(409, "This society already has members. Import is blocked so the register cannot be posted twice.");
  }
  const names = new Set<string>();
  const prepared = input.rows.map((row, index) => {
    const name = row.name.trim();
    if (!name) throw new HttpError(400, `Row ${index + 1} has no member name`);
    if (names.has(name)) throw new HttpError(400, `Duplicate member name: ${name}`);
    names.add(name);
    const monthlyShare = money(row.monthlyShare).toFixed(2);
    const sharePending = money(row.sharePending ?? row.monthlyShare).toFixed(2);
    const split = splitImportedShareDue(monthlyShare, sharePending);
    const parts = {
      monthlyShare,
      previousInterest: money(row.previousInterest).toFixed(2),
      currentInterest: money(row.currentInterest).toFixed(2),
      principal: money(row.principal).toFixed(2),
      penalty: money(row.penalty).toFixed(2),
    };
    const totalShares = money(row.totalShares).toFixed(2);
    const loanOutstanding = money(row.loanOutstanding).toFixed(2);
    const openingShares = subtractMoney(totalShares, split.collectedThisMonth);
    if (money(openingShares).isNegative()) throw new HttpError(400, `${name}: total shares are smaller than the share already collected this month`);
    if (calculateClosingShares(openingShares, split.collectedThisMonth) !== totalShares) {
      throw new HttpError(400, `${name}: share roll-forward does not match`);
    }
    return {
      name,
      totalShares,
      openingShares,
      loanOutstanding,
      ...parts,
      sharePending,
      shareCashPending: split.shareCashPending,
      arrearsCash: split.arrearsCash,
      collectedThisMonth: split.collectedThisMonth,
      installment: calculateInstallment({
        monthlyShare: split.shareCashPending,
        previousInterest: parts.previousInterest,
        currentInterest: parts.currentInterest,
        principal: parts.principal,
        penalty: parts.penalty,
      }),
      interestOutstanding: calculateInterestOutstanding(parts.previousInterest, parts.currentInterest, "0.00"),
    };
  });

  const date = statementDateFor(input.period);
  return prisma.$transaction(async (tx) => {
    const society = await tx.society.findUniqueOrThrow({ where: { id: auth.societyId } });
    const rate = society.interestRate.toString();
    /** A new society already has an empty open month. Reuse it instead of inserting a second row. */
    const months = await tx.accountingMonth.findMany({ where: { societyId: auth.societyId } });
    for (const month of months) {
      const used = await tx.memberMonth.count({ where: { societyId: auth.societyId, period: month.period } });
      if (used > 0) {
        throw new HttpError(409, `${monthLabel(month.period)} already has a register. Import is only for a society with no members.`);
      }
    }
    const note = "Opened from an imported register. Monthly share is the usual amount. Share pending is cash still to collect.";
    const same = months.find((month) => month.period === input.period);
    if (same) {
      await tx.accountingMonth.update({
        where: { id: same.id },
        data: { status: "OPEN", statementDate: utcDate(date), registerNote: note },
      });
    } else {
      await tx.accountingMonth.deleteMany({ where: { societyId: auth.societyId, id: { in: months.map((month) => month.id) } } });
      await tx.accountingMonth.create({
        data: {
          societyId: auth.societyId,
          period: input.period,
          status: "OPEN",
          statementDate: utcDate(date),
          registerNote: note,
        },
      });
    }
    for (const [index, row] of prepared.entries()) {
      const member = await tx.member.create({
        data: {
          societyId: auth.societyId,
          memberNumber: index + 1,
          name: row.name,
          joiningDate: utcDate(date),
          monthlyShare: dec(row.monthlyShare),
        },
      });
      if (money(row.openingShares).greaterThan(0)) {
        await tx.shareTransaction.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            date: utcDate(date),
            period: input.period,
            amount: dec(row.openingShares),
            cashEffect: dec(row.openingShares),
            reason: "Opening shares imported from the register",
            reference: `IMPORT-SHARE-${index + 1}`,
            createdById: auth.userId,
          },
        });
        await cashLedger(tx, auth, {
          memberId: member.id,
          date,
          period: input.period,
          type: "MEMBER_CONTRIBUTION",
          direction: "IN",
          amount: row.openingShares,
          reference: `IMPORT-SHARE-${index + 1}`,
          reason: "Opening shares imported from the register",
        });
      }
      await tx.shareTransaction.create({
        data: {
          societyId: auth.societyId,
          memberId: member.id,
          date: utcDate(date),
          period: input.period,
          amount: dec(money(row.sharePending).greaterThan(0) ? row.sharePending : row.monthlyShare),
          cashEffect: dec(row.collectedThisMonth),
          reason: money(row.collectedThisMonth).greaterThan(0)
            ? "Monthly share assessed. The pending column shows cash still to collect; the rest was already received."
            : "Monthly share assessed. Cash is recorded when the payment is collected.",
          reference: `SHARE-ASSESS-${input.period}`,
          createdById: auth.userId,
        },
      });
      if (money(row.collectedThisMonth).greaterThan(0)) {
        await cashLedger(tx, auth, {
          memberId: member.id,
          date,
          period: input.period,
          type: "MEMBER_CONTRIBUTION",
          direction: "IN",
          amount: row.collectedThisMonth,
          reference: `SHARE-ASSESS-${input.period}`,
          reason: "Imported monthly share already collected, from monthly share minus share pending",
        });
      }
      if (money(row.loanOutstanding).greaterThan(0)) {
        const loan = await tx.loan.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            originalPrincipal: dec(row.loanOutstanding),
            loanDate: utcDate(date),
            interestRate: dec(rate),
            interestType: "PERCENT_OF_OUTSTANDING_PRINCIPAL",
            outstandingPrincipal: dec(row.loanOutstanding),
            scheduledPrincipal: dec(row.principal),
            status: deriveLoanStatus({ outstanding: row.loanOutstanding, missedPrincipalInstallments: 0, hasRepayment: false }),
            purpose: "Opening loan imported from the register",
            notes: "Imported as one outstanding balance. Earlier disbursements were not in the file.",
          },
        });
        await tx.loanTransaction.create({
          data: {
            societyId: auth.societyId,
            loanId: loan.id,
            memberId: member.id,
            date: utcDate(date),
            period: input.period,
            type: "DISBURSEMENT",
            amount: dec(row.loanOutstanding),
            balanceAfter: dec(row.loanOutstanding),
            reason: "Opening loan imported from the register",
            reference: `IMPORT-LOAN-${index + 1}`,
            createdById: auth.userId,
          },
        });
        await cashLedger(tx, auth, {
          memberId: member.id,
          date,
          period: input.period,
          type: "LOAN_DISBURSEMENT",
          direction: "OUT",
          amount: row.loanOutstanding,
          reference: `IMPORT-LOAN-${index + 1}`,
          reason: "Opening loan imported from the register",
        });
      }
      if (money(row.penalty).greaterThan(0)) {
        await tx.penalty.create({
          data: {
            societyId: auth.societyId,
            memberId: member.id,
            period: input.period,
            date: utcDate(date),
            amount: dec(row.penalty),
            collectedAmount: dec("0.00"),
            source: "IMPORT",
            reason: "Penalty assessed on the imported register. It is not interest.",
            createdById: auth.userId,
          },
        });
      }
      await tx.memberMonth.create({
        data: {
          societyId: auth.societyId,
          memberId: member.id,
          period: input.period,
          openingShares: dec(row.openingShares),
          monthlyShare: dec(row.monthlyShare),
          shareMovement: dec(row.collectedThisMonth),
          shareCashPending: dec(row.shareCashPending),
          arrearsCash: dec(row.arrearsCash),
          closingShares: dec(row.totalShares),
          openingPrincipal: dec(row.loanOutstanding),
          principalDue: dec(row.principal),
          previousInterest: dec(row.previousInterest),
          currentInterest: dec(row.currentInterest),
          interestOutstanding: dec(row.interestOutstanding),
          penalty: dec(row.penalty),
          totalInstallment: dec(row.installment),
        },
      });
      await refreshMember(tx, member.id);
    }
    const importedStatements = await tx.memberMonth.findMany({
      where: { societyId: auth.societyId, period: input.period },
      orderBy: { memberId: "asc" },
    });
    for (const statement of importedStatements) {
      await consolidateActiveLoans(tx, auth.societyId, statement.memberId);
      await syncOpenLoanStatement(tx, auth, statement);
    }
    await consolidateInterestAccruals(tx, auth.societyId);
    await audit(tx, auth, "Imported register", "Society", auth.societyId, input.reason, null, {
      period: input.period,
      members: prepared.length,
      shares: sumMoney(prepared.map((row) => row.totalShares)),
      loans: sumMoney(prepared.map((row) => row.loanOutstanding)),
      installment: sumMoney(prepared.map((row) => row.installment)),
    });
    return {
      members: prepared.length,
      shares: sumMoney(prepared.map((row) => row.totalShares)),
      loans: sumMoney(prepared.map((row) => row.loanOutstanding)),
      installment: sumMoney(prepared.map((row) => row.installment)),
    };
  }, { timeout: 60000 });
}

export { ALLOCATION_COMPONENTS };
