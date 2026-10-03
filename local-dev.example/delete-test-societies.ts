import "./load-env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../server/src/lib/prisma.js";
import { wipeKrantiSocietyData } from "./wipe-kranti-society.js";

async function deleteSocietyCompletely(societyId: string) {
  await prisma.paymentAllocation.deleteMany({ where: { payment: { societyId } } });
  await prisma.payment.deleteMany({ where: { societyId } });
  await prisma.ledgerEntry.deleteMany({ where: { societyId } });
  await prisma.shareTransaction.deleteMany({ where: { societyId } });
  await prisma.interestEvent.deleteMany({ where: { societyId } });
  await prisma.penalty.deleteMany({ where: { societyId } });
  await prisma.interestDistributionEntry.deleteMany({ where: { distribution: { societyId } } });
  await prisma.interestDistribution.deleteMany({ where: { societyId } });
  await prisma.loanTransaction.deleteMany({ where: { societyId } });
  await prisma.loan.deleteMany({ where: { societyId } });
  await prisma.memberMonth.deleteMany({ where: { societyId } });
  await prisma.notificationRead.deleteMany({ where: { notification: { societyId } } });
  await prisma.notification.deleteMany({ where: { societyId } });
  await prisma.auditLog.deleteMany({ where: { societyId } });
  await prisma.user.deleteMany({ where: { societyId } });
  await prisma.member.deleteMany({ where: { societyId } });
  await prisma.accountingMonth.deleteMany({ where: { societyId } });
  await prisma.society.delete({ where: { id: societyId } });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const removed = await prisma.society.findMany({
    where: {
      OR: [
        { name: { contains: "mahi", mode: "insensitive" } },
        { name: { contains: "Mahesh", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true },
  });
  for (const row of removed) {
    await deleteSocietyCompletely(row.id);
    console.log(`Removed society: ${row.name}`);
  }
  if (removed.length === 0) console.log("No society name matched mahi / Mahesh.");

  const wiped = await wipeKrantiSocietyData();
  for (const row of wiped) {
    console.log(`Cleared Kranti data: ${row.name}`);
    console.log(`Open month ${row.period}. Staff: ${row.staff.join(", ")}`);
  }
  await prisma.$disconnect();
}
