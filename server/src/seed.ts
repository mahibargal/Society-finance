import bcrypt from "bcryptjs";
import { MEMBERS, OPEN_PERIOD, PERIODS, PREVIOUS_BALANCE_NOTES, STATEMENT_DATES } from "./data/register.js";
import { buildSocietyPlan } from "./engine/register-plan.js";
import { deriveLoanStatus, money, sumMoney } from "./engine/finance.js";
import { utcDate } from "./lib/format.js";
import { dec, str } from "./lib/money-db.js";
import { appEnvironment } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";

export const DEMO = {
  ownerMobile: "9000000000",
  ownerPassword: "office@123",
  memberPassword: "Member@2026",
  mainPassword: "Main@2026",
};

function skipDemoSeed() {
  return process.env.NODE_ENV === "production" || process.env.SKIP_DEMO_SEED === "1";
}

/** Local `npm run start` uses embedded Postgres; real deploy uses an external URL. */
function localEmbeddedProduction() {
  if (appEnvironment() !== "production") return false;
  const url = (process.env.DATABASE_URL ?? "").trim();
  return !url || /:54331\//.test(url);
}

export async function seedIfEmpty() {
  if (skipDemoSeed()) return false;
  const existing = await prisma.society.count();
  if (existing > 0) return false;

  const plan = buildSocietyPlan();
  const ownerPassword = await bcrypt.hash(DEMO.ownerPassword, 10);
  const memberPassword = await bcrypt.hash(DEMO.memberPassword, 10);

  await prisma.$transaction(async (tx) => {
    const society = await tx.society.create({
      data: {
        name: "श्री क्रांतीसूर्य भगतसिंग क्रिड़ेट सोसायटी",
        interestRate: dec("0.010000"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
        interestCalculationFrequency: "MONTHLY",
        interestCalculationMethod: "PERCENT_OF_OUTSTANDING_PRINCIPAL",
        interestDistributionFrequency: "MONTHLY",
        interestEligibilityRule: "ALL_ACTIVE_MEMBERS",
        distributionMethod: "EQUAL",
        roundingPolicy: "UNIFORM_HALF_UP_REMAINDER",
        penaltyMethod: "MANUAL",
      },
    });

    const owner = await tx.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Society owner",
        username: "office",
        mobile: DEMO.ownerMobile,
        email: "",
        passwordHash: ownerPassword,
      },
    });

    const memberIds = new Map<string, string>();
    for (const member of MEMBERS) {
      const latest = [...plan.statements].reverse().find((row) => row.memberKey === member.key);
      const created = await tx.member.create({
        data: {
          societyId: society.id,
          memberNumber: member.number,
          name: member.name,
          nameLatin: member.nameLatin,
          mobile: String(9000000000 + member.number),
          joiningDate: utcDate("2026-06-01"),
          status: member.key === "godse" ? "INACTIVE" : "ACTIVE",
          monthlyShare: dec(latest?.monthlyShare ?? "500.00"),
          exitedAt: member.key === "godse" ? utcDate("2026-08-05") : null,
        },
      });
      memberIds.set(member.key, created.id);
      if (member.key !== "godse") {
        await tx.user.create({
          data: {
            societyId: society.id,
            memberId: created.id,
            role: "MEMBER",
            name: member.name,
            username: `m${member.number}`,
            mobile: String(9000000000 + member.number),
            passwordHash: memberPassword,
          },
        });
      }
    }

    for (const period of PERIODS) {
      const rows = plan.statements.filter((row) => row.period === period);
      await tx.accountingMonth.create({
        data: {
          societyId: society.id,
          period,
          status: period === OPEN_PERIOD ? "OPEN" : "CLOSED",
          statementDate: utcDate(STATEMENT_DATES[period]),
          closedAt: period === OPEN_PERIOD ? null : utcDate(STATEMENT_DATES[period]),
          closedById: period === OPEN_PERIOD ? null : owner.id,
          registerNote: PREVIOUS_BALANCE_NOTES[period]
            ? `मागील बाकी noted on the paper register: ${PREVIOUS_BALANCE_NOTES[period]}. The collection columns beside it were blank, so it is not a ledger balance.`
            : "",
          summary:
            period === OPEN_PERIOD
              ? undefined
              : {
                  shares: sumMoney(rows.map((row) => row.closingShares)),
                  loans: sumMoney(rows.map((row) => row.openingPrincipal)),
                  installment: sumMoney(rows.map((row) => row.totalInstallment)),
                  interest: sumMoney(rows.map((row) => row.currentInterest)),
                },
        },
      });
    }

    for (const member of MEMBERS) {
      const txns = plan.loanTransactions
        .filter((row) => row.memberKey === member.key)
        .sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
      if (txns.length === 0) continue;
      let balance = "0.00";
      const original = txns.find((row) => row.type === "DISBURSEMENT")?.amount ?? "0.00";
      for (const row of txns) {
        balance =
          row.type === "DISBURSEMENT" ? sumMoney([balance, row.amount]) : sumMoney([balance, `-${row.amount.replace("-", "")}`]);
        if (money(balance).isNegative()) throw new Error(`Loan balance went negative for ${member.key}`);
      }
      const outstanding = balance;
      const missed = missedPrincipalStreak(plan, member.key);
      const hasRepayment = txns.some((row) => row.type === "PRINCIPAL_REPAYMENT");
      const latest = [...plan.statements].reverse().find((row) => row.memberKey === member.key);
      const loan = await tx.loan.create({
        data: {
          societyId: society.id,
          memberId: memberIds.get(member.key)!,
          originalPrincipal: dec(original),
          loanDate: utcDate("2026-06-01"),
          interestRate: dec("0.010000"),
          interestType: "PERCENT_OF_OUTSTANDING_PRINCIPAL",
          outstandingPrincipal: dec(outstanding),
          scheduledPrincipal: dec(latest?.principalDue ?? "0.00"),
          status: deriveLoanStatus({ outstanding, missedPrincipalInstallments: missed, hasRepayment }),
          purpose: "Balance migrated from the June–October 2026 register",
          notes: txns
            .filter((row) => row.reference.startsWith("LOAN-"))
            .map((row) => row.reason)
            .join(" "),
        },
      });
      let running = "0.00";
      const ordered = [...txns].sort((a, b) => a.date.localeCompare(b.date) || Number(a.type !== "PRINCIPAL_REPAYMENT") - Number(b.type !== "PRINCIPAL_REPAYMENT"));
      for (const row of ordered) {
        running = row.type === "DISBURSEMENT" ? sumMoney([running, row.amount]) : money(running).minus(row.amount).toFixed(2);
        await tx.loanTransaction.create({
          data: {
            societyId: society.id,
            loanId: loan.id,
            memberId: memberIds.get(member.key)!,
            date: utcDate(row.date),
            period: row.period,
            type: row.type,
            amount: dec(row.amount),
            balanceAfter: dec(running),
            reason: row.reason,
            reference: row.reference,
            createdById: owner.id,
          },
        });
      }
    }

    await tx.shareTransaction.createMany({
      data: plan.shareTransactions.map((row) => ({
        societyId: society.id,
        memberId: memberIds.get(row.memberKey)!,
        date: utcDate(row.date),
        period: row.period,
        amount: dec(row.amount),
        cashEffect: dec(row.cashEffect),
        reason: row.reason,
        reference: row.reference,
        createdById: owner.id,
      })),
    });

    await tx.interestEvent.createMany({
      data: plan.interestEvents.map((row) => ({
        societyId: society.id,
        memberId: memberIds.get(row.memberKey)!,
        date: utcDate(row.date),
        period: row.period,
        kind: row.kind,
        amount: dec(row.amount),
        reason: row.reason,
        createdById: owner.id,
      })),
    });

    await tx.penalty.createMany({
      data: plan.penalties.map((row) => ({
        societyId: society.id,
        memberId: memberIds.get(row.memberKey)!,
        period: row.period,
        date: utcDate(row.date),
        amount: dec(row.amount),
        collectedAmount: dec(row.collected),
        source: row.source,
        reason: row.reason,
        createdById: owner.id,
      })),
    });

    await tx.memberMonth.createMany({
      data: plan.statements.map((row) => ({
        societyId: society.id,
        memberId: memberIds.get(row.memberKey)!,
        period: row.period,
        openingShares: dec(row.openingShares),
        monthlyShare: dec(row.monthlyShare),
        shareMovement: dec(row.shareMovement),
        arrearsCash: dec(row.arrearsCash),
        shareCashPending: dec(row.shareCashPending),
        closingShares: dec(row.closingShares),
        openingPrincipal: dec(row.openingPrincipal),
        principalDue: dec(row.principalDue),
        previousInterest: dec(row.previousInterest),
        currentInterest: dec(row.currentInterest),
        interestCollected: dec(row.interestCollected),
        interestOutstanding: dec(row.interestOutstanding),
        penalty: dec(row.penalty),
        totalInstallment: dec(row.totalInstallment),
      })),
    });

    const earned = new Map<string, string>();
    for (const distribution of plan.distributions) {
      const saved = await tx.interestDistribution.create({
        data: {
          societyId: society.id,
          code: distribution.code,
          period: distribution.period,
          totalAvailable: dec(distribution.available),
          eligibleCount: distribution.eligibleKeys.length,
          perMemberAmount: dec(distribution.perMember),
          totalDistributed: dec(distribution.totalDistributed),
          remaining: dec(distribution.remaining),
          roundingMode: distribution.roundingModeApplied,
          status: "CONFIRMED",
          reason: `Equal distribution of interest actually collected in ${distribution.period}.`,
          createdById: owner.id,
          confirmedAt: utcDate(`${distribution.period}-06`),
        },
      });
      await tx.interestDistributionEntry.createMany({
        data: distribution.eligibleKeys.map((key, index) => ({
          distributionId: saved.id,
          memberId: memberIds.get(key)!,
          amount: dec(distribution.amounts[index]),
          status: "CREDITED",
        })),
      });
      distribution.eligibleKeys.forEach((key, index) => {
        earned.set(key, sumMoney([earned.get(key) ?? "0.00", distribution.amounts[index]]));
      });
    }

    const ledger = ledgerRows(plan, society.id, owner.id, memberIds);
    await tx.ledgerEntry.createMany({ data: ledger });

    for (const member of MEMBERS) {
      const id = memberIds.get(member.key)!;
      const shareRows = plan.shareTransactions.filter((row) => row.memberKey === member.key);
      const shareBalance = sumMoney(shareRows.map((row) => row.cashEffect));
      const loanRows = plan.loanTransactions.filter((row) => row.memberKey === member.key);
      const disbursed = sumMoney(loanRows.filter((row) => row.type === "DISBURSEMENT").map((row) => row.amount));
      const repaid = sumMoney(loanRows.filter((row) => row.type === "PRINCIPAL_REPAYMENT").map((row) => row.amount));
      const loanOutstanding = money(disbursed).minus(repaid).toFixed(2);
      const interest = earned.get(member.key) ?? "0.00";
      await tx.member.update({
        where: { id },
        data: {
          shareBalance: dec(shareBalance),
          loanOutstanding: dec(loanOutstanding),
          interestEarned: dec(interest),
          interestBalance: dec(interest),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        societyId: society.id,
        actorId: owner.id,
        actorName: owner.name,
        action: "Migrated register",
        entityType: "Society",
        entityId: society.id,
        reason: "June to October 2026 register imported as transactions. Totals are calculated from member rows.",
        newValue: plan.totals,
      },
    });

    await tx.notification.create({
      data: {
        societyId: society.id,
        userId: owner.id,
        type: "MONTH_CLOSING",
        title: "Register migrated",
        body: "June to September are closed. October 2026 is open. Interest of ₹10,470 is accrued and not yet collected, so it is not in the distribution pool.",
      },
    });
  }, { timeout: 120000 });

  const shareSum = await prisma.shareTransaction.aggregate({ _sum: { amount: true } });
  const collected = await prisma.interestEvent.aggregate({ where: { kind: "COLLECTION" }, _sum: { amount: true } });
  if (str(shareSum._sum.amount) !== plan.totals.shares) {
    throw new Error(`Share ledger ${str(shareSum._sum.amount)} does not match ${plan.totals.shares}`);
  }
  if (str(collected._sum.amount) !== plan.totals.interestCollected) {
    throw new Error(`Collected interest ${str(collected._sum.amount)} does not match ${plan.totals.interestCollected}`);
  }
  return true;
}

function missedPrincipalStreak(plan: ReturnType<typeof buildSocietyPlan>, memberKey: string) {
  let streak = 0;
  for (const period of PERIODS) {
    if (period === OPEN_PERIOD) break;
    const statement = plan.statements.find((row) => row.memberKey === memberKey && row.period === period);
    if (!statement) continue;
    const repaid = plan.loanTransactions.some(
      (row) => row.memberKey === memberKey && row.period === period && row.type === "PRINCIPAL_REPAYMENT" && money(row.amount).greaterThan(0),
    );
    if (money(statement.principalDue).greaterThan(0) && !repaid) streak += 1;
    else streak = 0;
  }
  return streak;
}

function ledgerRows(
  plan: ReturnType<typeof buildSocietyPlan>,
  societyId: string,
  actorId: string,
  memberIds: Map<string, string>,
) {
  const rows: {
    societyId: string;
    memberId: string | null;
    date: Date;
    period: string;
    type:
      | "MEMBER_CONTRIBUTION"
      | "LOAN_DISBURSEMENT"
      | "PRINCIPAL_REPAYMENT"
      | "INTEREST_ACCRUAL"
      | "INTEREST_COLLECTION"
      | "INTEREST_DISTRIBUTION"
      | "PENALTY_COLLECTION"
      | "REFUND";
    debit: ReturnType<typeof dec>;
    credit: ReturnType<typeof dec>;
    amount: ReturnType<typeof dec>;
    cashEffect: "IN" | "OUT" | "NONE";
    reference: string;
    reason: string;
    createdById: string;
  }[] = [];

  const push = (
    memberKey: string | null,
    date: string,
    period: string,
    type: (typeof rows)[number]["type"],
    amount: string,
    direction: "IN" | "OUT" | "NONE",
    reference: string,
    reason: string,
  ) => {
    if (money(amount).isZero()) return;
    const abs = money(amount).abs().toFixed(2);
    rows.push({
      societyId,
      memberId: memberKey ? memberIds.get(memberKey)! : null,
      date: utcDate(date),
      period,
      type,
      debit: dec(direction === "OUT" ? abs : "0.00"),
      credit: dec(direction === "IN" ? abs : "0.00"),
      amount: dec(abs),
      cashEffect: direction,
      reference,
      reason,
      createdById: actorId,
    });
  };

  for (const row of plan.shareTransactions) {
    if (money(row.cashEffect).greaterThan(0)) {
      push(row.memberKey, row.date, row.period, "MEMBER_CONTRIBUTION", row.cashEffect, "IN", row.reference, row.reason);
    } else if (money(row.cashEffect).isNegative()) {
      push(row.memberKey, row.date, row.period, "REFUND", money(row.cashEffect).abs().toFixed(2), "OUT", row.reference, row.reason);
    } else if (money(row.amount).greaterThan(0)) {
      push(row.memberKey, row.date, row.period, "MEMBER_CONTRIBUTION", row.amount, "NONE", row.reference, row.reason);
    }
  }
  for (const row of plan.loanTransactions) {
    push(
      row.memberKey,
      row.date,
      row.period,
      row.type === "DISBURSEMENT" ? "LOAN_DISBURSEMENT" : "PRINCIPAL_REPAYMENT",
      row.amount,
      row.type === "DISBURSEMENT" ? "OUT" : "IN",
      row.reference,
      row.reason,
    );
  }
  for (const row of plan.interestEvents) {
    push(
      row.memberKey,
      row.date,
      row.period,
      row.kind === "ACCRUAL" ? "INTEREST_ACCRUAL" : "INTEREST_COLLECTION",
      row.amount,
      row.kind === "ACCRUAL" ? "NONE" : "IN",
      row.kind,
      row.reason,
    );
  }
  for (const row of plan.penalties) {
    push(row.memberKey, row.date, row.period, "PENALTY_COLLECTION", row.collected, "IN", row.source, row.reason);
  }
  for (const distribution of plan.distributions) {
    distribution.eligibleKeys.forEach((key, index) => {
      push(
        key,
        `${distribution.period}-06`,
        distribution.period,
        "INTEREST_DISTRIBUTION",
        distribution.amounts[index],
        "NONE",
        distribution.code,
        "Interest credit. Cash stays in the society until a member withdraws it.",
      );
    });
  }
  return rows;
}

/** Dev/local only: create main admin if missing (not on production deploy). */
export async function ensureMainAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: "MAIN_ADMIN" } });
  if (existing) return false;
  if (appEnvironment() === "production" && !localEmbeddedProduction()) return false;
  await prisma.user.create({
    data: {
      role: "MAIN_ADMIN",
      name: "Main admin",
      username: "main",
      passwordHash: await bcrypt.hash(DEMO.mainPassword, 10),
    },
  });
  console.log("Main admin is ready: username main (see DEMO.mainPassword in seed.ts)");
  return true;
}

export async function ensureAccess() {
  await ensureMainAdmin();
  if (skipDemoSeed()) return;
  const users = await prisma.user.findMany({ include: { member: true } });
  for (const user of users) {
    const generated = !user.username || /^c[a-z0-9]{20,}$/i.test(user.username);
    if (!generated && user.username !== user.mobile) continue;
    if (user.role === "OWNER" && user.mobile === DEMO.ownerMobile) {
      const clash = await prisma.user.findFirst({ where: { username: "office", NOT: { id: user.id } } });
      if (!clash) await prisma.user.update({ where: { id: user.id }, data: { username: "office" } });
      continue;
    }
    if (user.role === "MEMBER" && user.member) {
      const username = `m${user.member.memberNumber}`;
      const clash = await prisma.user.findFirst({ where: { username, NOT: { id: user.id } } });
      if (!clash) await prisma.user.update({ where: { id: user.id }, data: { username } });
    }
  }
}
