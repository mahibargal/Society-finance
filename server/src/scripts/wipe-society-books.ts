import "./load-env.js";
import { calendarPeriod, statementDateFor, utcDate } from "../lib/format.js";
import { prisma } from "../lib/prisma.js";

/** Remove members, months, payments, loans, etc. Staff users (office, admins) stay. Society settings unchanged. */
export async function wipeSocietyBooks(societyId: string) {
  const society = await prisma.society.findUnique({
    where: { id: societyId },
    select: { id: true, name: true, interestRate: true },
  });
  if (!society) throw new Error("Society not found");

  await prisma.$transaction(async (tx) => {
    await tx.paymentAllocation.deleteMany({ where: { payment: { societyId } } });
    await tx.payment.deleteMany({ where: { societyId } });
    await tx.ledgerEntry.deleteMany({ where: { societyId } });
    await tx.shareTransaction.deleteMany({ where: { societyId } });
    await tx.interestEvent.deleteMany({ where: { societyId } });
    await tx.penalty.deleteMany({ where: { societyId } });
    await tx.interestDistributionEntry.deleteMany({ where: { distribution: { societyId } } });
    await tx.interestDistribution.deleteMany({ where: { societyId } });
    await tx.loanTransaction.deleteMany({ where: { societyId } });
    await tx.loan.deleteMany({ where: { societyId } });
    await tx.memberMonth.deleteMany({ where: { societyId } });
    await tx.notificationRead.deleteMany({ where: { notification: { societyId } } });
    await tx.notification.deleteMany({ where: { societyId } });
    await tx.auditLog.deleteMany({ where: { societyId } });
    await tx.user.deleteMany({ where: { societyId, memberId: { not: null } } });
    await tx.member.deleteMany({ where: { societyId } });
    await tx.accountingMonth.deleteMany({ where: { societyId } });

    const period = calendarPeriod();
    await tx.accountingMonth.create({
      data: {
        societyId,
        period,
        status: "OPEN",
        statementDate: utcDate(statementDateFor(period)),
      },
    });
  }, { timeout: 120000 });

  const period = calendarPeriod();
  const staff = await prisma.user.findMany({
    where: { societyId },
    select: { username: true, role: true },
    orderBy: { username: "asc" },
  });

  return {
    id: society.id,
    name: society.name,
    period,
    interestRate: society.interestRate.toString(),
    staff: staff.map((row) => `${row.username ?? "(no username)"} ${row.role}`),
  };
}

export async function wipeAllSocietyBooks() {
  const societies = await prisma.society.findMany({ select: { id: true } });
  if (societies.length === 0) throw new Error("No society in the database");
  const results = [];
  for (const row of societies) results.push(await wipeSocietyBooks(row.id));
  return results;
}
