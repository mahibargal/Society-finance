import "./load-env.js";
import { duesFor } from "../server/src/services/books.js";
import { str } from "../server/src/lib/money-db.js";
import { prisma } from "../server/src/lib/prisma.js";

const society = await prisma.society.findFirst({
  where: { name: { contains: "क्रांतीसूर्य" } },
  select: { id: true },
});
if (!society) throw new Error("society missing");
const member = await prisma.member.findFirst({
  where: { societyId: society.id, name: { contains: "पाटील" } },
});
if (!member) throw new Error("member missing");
const open = await prisma.accountingMonth.findFirst({
  where: { societyId: society.id, status: "OPEN" },
});
const statement = open
  ? await prisma.memberMonth.findUnique({
      where: { societyId_memberId_period: { societyId: society.id, memberId: member.id, period: open.period } },
    })
  : null;
const payments = await prisma.payment.findMany({
  where: { societyId: society.id, memberId: member.id },
  include: { allocations: true },
});
const due = open ? await duesFor(society.id, member.id, open.period) : null;
console.log(
  JSON.stringify(
    {
      name: member.name,
      status: member.status,
      open: open?.period,
      monthlyShare: str(member.monthlyShare),
      shareBalance: str(member.shareBalance),
      loanOutstanding: str(member.loanOutstanding),
      statement: statement && {
        period: statement.period,
        monthlyShare: str(statement.monthlyShare),
        shareCashPending: str(statement.shareCashPending),
        arrearsCash: str(statement.arrearsCash),
        previousInterest: str(statement.previousInterest),
        currentInterest: str(statement.currentInterest),
        principalDue: str(statement.principalDue),
        penalty: str(statement.penalty),
        totalInstallment: str(statement.totalInstallment),
      },
      due,
      payments: payments.map((row) => ({
        period: row.period,
        status: row.status,
        amount: str(row.amount),
        allocations: row.allocations.map((a) => ({ component: a.component, amount: str(a.amount) })),
      })),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
