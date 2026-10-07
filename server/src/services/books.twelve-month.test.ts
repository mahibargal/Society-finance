import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it } from "vitest";
import type { AllocationComponent } from "../engine/finance.js";
import { calculateLoanBalance, isZero, money, netLedgerByType, societyBalanceFromLedger, sumMoney, subtractMoney } from "../engine/finance.js";
import { nextPeriod, statementDateFor, utcDate } from "../lib/format.js";
import { dec, str } from "../lib/money-db.js";
import type { AuthUser } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { adminDashboard, listMembers, memberStatement, monthSheet, reportData } from "./read.js";
import {
  addPenalty,
  confirmClose,
  markMissingReceiptsForOpenMonth,
  confirmDistribution,
  createLoan,
  createMember,
  duesFor,
  ensureMemberStatement,
  postPayment,
  previewClose,
  withdrawInterest,
} from "./books.js";

const MARK = "__twelve_month_test__";
const START = "2025-01";

async function wipeSociety(societyId: string) {
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
  await prisma.notification.deleteMany({ where: { societyId } });
  await prisma.auditLog.deleteMany({ where: { societyId } });
  await prisma.user.deleteMany({ where: { societyId } });
  await prisma.member.deleteMany({ where: { societyId } });
  await prisma.accountingMonth.deleteMany({ where: { societyId } });
  await prisma.society.delete({ where: { id: societyId } });
}

afterAll(async () => {
  const leftover = await prisma.society.findMany({ where: { name: { startsWith: MARK } } });
  for (const row of leftover) await wipeSociety(row.id);
  await prisma.$disconnect();
});

async function pay(
  auth: AuthUser,
  memberId: string,
  period: string,
  amount: string,
  reason: string,
  extra?: { penalty?: string; allocation?: { component: AllocationComponent; amount: string }[] },
) {
  if (isZero(amount)) return;
  await postPayment(auth, {
    memberId,
    period,
    amount,
    paidOn: `${period}-18`,
    reason,
    idempotencyKey: `${reason}-${memberId}-${period}-${amount}`,
    penalty: extra?.penalty,
    allocation: extra?.allocation,
  });
}

async function payDue(auth: AuthUser, memberId: string, period: string, reason: string) {
  const due = await duesFor(auth.societyId, memberId, period);
  await pay(auth, memberId, period, due.totalDue, reason);
}

async function payShareOnly(auth: AuthUser, memberId: string, period: string, amount: string, reason: string) {
  const due = await duesFor(auth.societyId, memberId, period);
  const share = money(amount).lessThan(due.dues.SHARE) ? amount : due.dues.SHARE;
  await pay(auth, memberId, period, share, reason, {
    allocation: [{ component: "SHARE", amount: share }],
  });
}

async function payEveryoneStillDue(auth: AuthUser, people: Record<string, string>, period: string, tag: string) {
  for (const memberId of Object.values(people)) {
    const due = await duesFor(auth.societyId, memberId, period);
    if (money(due.totalDue).greaterThan(0)) await payDue(auth, memberId, period, `${tag}-${memberId}`);
  }
}

async function payInterestOnly(auth: AuthUser, memberId: string, period: string, reason: string) {
  const due = await duesFor(auth.societyId, memberId, period);
  const interest = sumMoney([due.dues.PREVIOUS_INTEREST, due.dues.CURRENT_INTEREST]);
  if (isZero(interest)) return;
  await pay(auth, memberId, period, interest, reason, {
    allocation: [
      { component: "PREVIOUS_INTEREST", amount: due.dues.PREVIOUS_INTEREST },
      { component: "CURRENT_INTEREST", amount: due.dues.CURRENT_INTEREST },
    ],
  });
}

async function assertBooks(auth: AuthUser, label: string) {
  const preview = await previewClose(auth);
  const broken = preview.checks.checks.filter((row) => !row.ok);
  expect(broken, `${label} close checks ${JSON.stringify(broken)}`).toEqual([]);

  const [ledger, loans, loanTx, events, distributions, shares, members] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: { societyId: auth.societyId } }),
    prisma.loan.findMany({ where: { societyId: auth.societyId, status: { not: "CANCELLED" } } }),
    prisma.loanTransaction.findMany({ where: { societyId: auth.societyId } }),
    prisma.interestEvent.findMany({ where: { societyId: auth.societyId } }),
    prisma.interestDistribution.findMany({ where: { societyId: auth.societyId, status: "CONFIRMED" } }),
    prisma.shareTransaction.findMany({ where: { societyId: auth.societyId } }),
    prisma.member.findMany({ where: { societyId: auth.societyId } }),
  ]);
  const cash = societyBalanceFromLedger(
    ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
  );
  expect(cash.expected, `${label} society cash`).toBe(cash.calculated);
  expect(money(cash.calculated).isNegative(), `${label} cash went negative`).toBe(false);

  const disbursed = sumMoney(loanTx.filter((row) => row.type === "DISBURSEMENT").map((row) => str(row.amount)));
  const repaid = sumMoney(loanTx.filter((row) => row.type === "PRINCIPAL_REPAYMENT").map((row) => str(row.amount)));
  const outstanding = sumMoney(loans.map((row) => str(row.outstandingPrincipal)));
  expect(outstanding, `${label} loan outstanding`).toBe(calculateLoanBalance("0.00", disbursed, repaid));

  const accrued = sumMoney(events.filter((row) => row.kind === "ACCRUAL").map((row) => str(row.amount)));
  const collected = sumMoney(events.filter((row) => row.kind === "COLLECTION").map((row) => str(row.amount)));
  expect(money(collected).greaterThan(accrued), `${label} collected interest ${collected} > accrued ${accrued}`).toBe(false);
  const distributed = sumMoney(distributions.map((row) => str(row.totalDistributed)));
  const penaltyCollected = netLedgerByType(
    ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
    "PENALTY_COLLECTION",
  );
  const poolFunding = sumMoney([collected, penaltyCollected]);
  expect(money(distributed).greaterThan(poolFunding), `${label} distributed ${distributed} > pool ${poolFunding}`).toBe(false);

  const shareBook = sumMoney(shares.map((row) => str(row.cashEffect)));
  const shareMembers = sumMoney(members.map((row) => str(row.shareBalance)));
  expect(shareBook, `${label} share register`).toBe(shareMembers);

  const poolLeft = subtractMoney(poolFunding, distributed);
  const credited = sumMoney(
    (
      await prisma.interestDistributionEntry.findMany({
        where: {
          status: { in: ["CREDITED", "ADDED_TO_SHARES", "PAID_CASH"] },
          distribution: { societyId: auth.societyId, status: "CONFIRMED" },
        },
      })
    ).map((row) => str(row.amount)),
  );
  expect(credited, `${label} credits`).toBe(distributed);
  const legacyCredited = sumMoney(
    (
      await prisma.interestDistributionEntry.findMany({
        where: { status: "CREDITED", distribution: { societyId: auth.societyId, status: "CONFIRMED" } },
      })
    ).map((row) => str(row.amount)),
  );
  const withdrawn = sumMoney(ledger.filter((row) => row.type === "WITHDRAWAL" && row.cashEffect === "OUT").map((row) => str(row.debit)));
  const interestOnMembers = sumMoney(members.map((row) => str(row.interestBalance)));
  expect(interestOnMembers, `${label} interest balances`).toBe(subtractMoney(legacyCredited, withdrawn));
  expect(poolLeft, `${label} undistributed pool`).toBe(subtractMoney(poolFunding, credited));
}

describe("12-month society books", () => {
  it("stays reconciled across loans, dues, penalties, interest-only and share-only months", async () => {
    const stamp = Date.now().toString(36);
    const society = await prisma.society.create({
      data: {
        name: `${MARK}${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: START, status: "OPEN", statementDate: utcDate(statementDateFor(START)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Twelve Month Owner",
        username: `tmo${stamp}`,
        passwordHash: await bcrypt.hash("Test@2026", 10),
      },
    });
    const auth: AuthUser = {
      userId: owner.id,
      societyId: society.id,
      role: "OWNER",
      memberId: null,
      name: owner.name,
      tokenVersion: owner.tokenVersion,
    };

    const asha = await prisma.member.create({
      data: {
        societyId: society.id,
        memberNumber: 1,
        name: "Asha Regular",
        mobile: "9811111101",
        joiningDate: utcDate(`${START}-01`),
        monthlyShare: dec("500.00"),
      },
    });
    await prisma.user.create({
      data: {
        societyId: society.id,
        memberId: asha.id,
        role: "MEMBER",
        name: asha.name,
        username: `tma${stamp}`,
        mobile: asha.mobile,
        passwordHash: await bcrypt.hash("Member@2026", 10),
      },
    });
    await prisma.$transaction((tx) => ensureMemberStatement(tx, auth, asha.id, START));
    expect(await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } })).toMatchObject({ period: START });

    const bharat = await createMember(auth, {
      name: "Bharat Borrower",
      mobile: "9811111102",
      joiningDate: `${START}-01`,
      monthlyShare: "500.00",
      username: `tmb${stamp}`,
      password: "Member@2026",
      reason: "12-month borrower",
    });
    const chitra = await createMember(auth, {
      name: "Chitra Partial",
      mobile: "9811111103",
      joiningDate: `${START}-01`,
      monthlyShare: "500.00",
      username: `tmc${stamp}`,
      password: "Member@2026",
      reason: "12-month partial payer",
    });
    const deepak = await createMember(auth, {
      name: "Deepak Penalty",
      mobile: "9811111104",
      joiningDate: `${START}-01`,
      monthlyShare: "500.00",
      username: `tmd${stamp}`,
      password: "Member@2026",
      reason: "12-month penalty case",
    });
    const esha = await createMember(auth, {
      name: "Esha Share",
      mobile: "9811111105",
      joiningDate: `${START}-01`,
      monthlyShare: "500.00",
      username: `tme${stamp}`,
      password: "Member@2026",
      reason: "12-month share-only case",
    });

    const people = { asha: asha.id, bharat: bharat.id, chitra: chitra.id, deepak: deepak.id, esha: esha.id };
    let period = START;

    async function close(label: string) {
      await assertBooks(auth, `${label} before close`);
      await adminDashboard(auth);
      await listMembers(auth);
      await monthSheet(auth, period);
      const preview = await previewClose(auth);
      expect(preview.period).toBe(period);
      await markMissingReceiptsForOpenMonth(auth);
      await confirmClose(auth, `Close ${label}`);
      period = nextPeriod(period);
      await assertBooks(auth, `${label} next month open`);
    }

    // 1 Jan — everyone pays the monthly share, no loans
    await payDue(auth, people.asha, period, "jan-asha-full");
    await payDue(auth, people.bharat, period, "jan-bharat-full");
    await payDue(auth, people.chitra, period, "jan-chitra-full");
    await payDue(auth, people.deepak, period, "jan-deepak-full");
    await payDue(auth, people.esha, period, "jan-esha-full");
    await close("January share only");
    await expect(
      postPayment(auth, {
        memberId: people.asha,
        period: START,
        amount: "500.00",
        paidOn: `${START}-20`,
        reason: "must not write a closed month",
        idempotencyKey: `closed-${stamp}`,
      }),
    ).rejects.toThrow(/open month/i);

    // 2 Feb — lend to Bharat; interest starts next month; others pay share
    await createLoan(auth, {
      memberId: people.bharat,
      amount: "2000.00",
      date: `${period}-08`,
      scheduledPrincipal: "200.00",
      reason: "February loan to Bharat",
    });
    await payDue(auth, people.asha, period, "feb-asha-full");
    await payShareOnly(auth, people.bharat, period, "500.00", "feb-bharat-share");
    await payDue(auth, people.chitra, period, "feb-chitra-full");
    await payDue(auth, people.deepak, period, "feb-deepak-full");
    await payDue(auth, people.esha, period, "feb-esha-full");
    await close("February loan disbursed");

    // 3 Mar — Bharat pays only interest; Deepak misses; others full
    await payDue(auth, people.asha, period, "mar-asha-full");
    await payInterestOnly(auth, people.bharat, period, "mar-bharat-interest-only");
    await payDue(auth, people.chitra, period, "mar-chitra-full");
    await payDue(auth, people.esha, period, "mar-esha-full");
    await payEveryoneStillDue(auth, people, period, "mar-before-pool");
    await confirmDistribution(auth, period, "March collected interest shared");
    await close("March interest-only and a miss");

    // 4 Apr — Deepak pays only last-month share arrears; Bharat share+interest skip principal
    await payDue(auth, people.asha, period, "apr-asha-full");
    {
      const due = await duesFor(auth.societyId, people.bharat, period);
      const amount = sumMoney([due.dues.SHARE, due.dues.PREVIOUS_INTEREST, due.dues.CURRENT_INTEREST]);
      await pay(auth, people.bharat, period, amount, "apr-bharat-share-and-interest", {
        allocation: [
          { component: "SHARE", amount: due.dues.SHARE },
          { component: "PREVIOUS_INTEREST", amount: due.dues.PREVIOUS_INTEREST },
          { component: "CURRENT_INTEREST", amount: due.dues.CURRENT_INTEREST },
        ],
      });
    }
    await payDue(auth, people.chitra, period, "apr-chitra-full");
    await payShareOnly(auth, people.deepak, period, "500.00", "apr-deepak-arrears-share");
    await payDue(auth, people.esha, period, "apr-esha-full");
    await close("April arrears and skipped principal");

    // 5 May — penalty on Deepak, partial collect; Bharat pays full installment
    await addPenalty(auth, { memberId: people.deepak, period, amount: "100.00", date: `${period}-06`, reason: "May late penalty" });
    await payDue(auth, people.asha, period, "may-asha-full");
    await payDue(auth, people.bharat, period, "may-bharat-full");
    await payDue(auth, people.chitra, period, "may-chitra-full");
    await pay(auth, people.deepak, period, "200.00", "may-deepak-partial");
    await payDue(auth, people.esha, period, "may-esha-full");
    await close("May penalty and partial");

    // 6 Jun — catch-up Deepak including carried penalty; distribute; Esha share only
    await payDue(auth, people.asha, period, "jun-asha-full");
    await payDue(auth, people.bharat, period, "jun-bharat-full");
    await payDue(auth, people.chitra, period, "jun-chitra-full");
    await payDue(auth, people.deepak, period, "jun-deepak-catchup");
    await payShareOnly(auth, people.esha, period, "500.00", "jun-esha-share-only");
    await payEveryoneStillDue(auth, people, period, "jun-before-pool");
    await confirmDistribution(auth, period, "June interest pool");
    await close("June catch-up and distribution");

    // 7 Jul — Bharat pays extra principal; Chitra misses
    await payDue(auth, people.asha, period, "jul-asha-full");
    {
      const due = await duesFor(auth.societyId, people.bharat, period);
      await pay(auth, people.bharat, period, sumMoney([due.totalDue, "500.00"]), "jul-bharat-extra-principal");
    }
    await payDue(auth, people.deepak, period, "jul-deepak-full");
    await payDue(auth, people.esha, period, "jul-esha-full");
    await close("July extra principal and a miss");

    // 8 Aug — Chitra catch-up with collect-time penalty; Bharat interest only
    await payDue(auth, people.asha, period, "aug-asha-full");
    await payInterestOnly(auth, people.bharat, period, "aug-bharat-interest-only");
    {
      const due = await duesFor(auth.societyId, people.chitra, period);
      await pay(auth, people.chitra, period, sumMoney([due.totalDue, "50.00"]), "aug-chitra-catchup-penalty", { penalty: "50.00" });
    }
    await payDue(auth, people.deepak, period, "aug-deepak-full");
    await payDue(auth, people.esha, period, "aug-esha-full");
    await payEveryoneStillDue(auth, people, period, "aug-before-pool");
    await confirmDistribution(auth, period, "August interest pool");
    await close("August catch-up penalty and interest-only");

    // 9 Sep — everyone full except Esha share-only
    await payDue(auth, people.asha, period, "sep-asha-full");
    await payDue(auth, people.bharat, period, "sep-bharat-full");
    await payDue(auth, people.chitra, period, "sep-chitra-full");
    await payDue(auth, people.deepak, period, "sep-deepak-full");
    await payShareOnly(auth, people.esha, period, "500.00", "sep-esha-share-only");
    await close("September mixed full and share-only");

    // 10 Oct — second loan to Chitra; Deepak misses; Bharat interest only
    await createLoan(auth, {
      memberId: people.chitra,
      amount: "1000.00",
      date: `${period}-09`,
      scheduledPrincipal: "100.00",
      reason: "October loan to Chitra",
    });
    await payDue(auth, people.asha, period, "oct-asha-full");
    await payInterestOnly(auth, people.bharat, period, "oct-bharat-interest-only");
    await payShareOnly(auth, people.chitra, period, "500.00", "oct-chitra-share");
    await payDue(auth, people.esha, period, "oct-esha-full");
    await close("October second loan");

    // 11 Nov — Chitra interest starts; Deepak penalty leftover; withdraw credited interest
    await addPenalty(auth, { memberId: people.deepak, period, amount: "75.00", date: `${period}-04`, reason: "November leftover penalty" });
    await payDue(auth, people.asha, period, "nov-asha-full");
    await payDue(auth, people.bharat, period, "nov-bharat-full");
    {
      const due = await duesFor(auth.societyId, people.chitra, period);
      const amount = sumMoney([due.dues.SHARE, due.dues.CURRENT_INTEREST, due.dues.PREVIOUS_INTEREST]);
      await pay(auth, people.chitra, period, amount, "nov-chitra-share-and-interest", {
        allocation: [
          { component: "SHARE", amount: due.dues.SHARE },
          { component: "PREVIOUS_INTEREST", amount: due.dues.PREVIOUS_INTEREST },
          { component: "CURRENT_INTEREST", amount: due.dues.CURRENT_INTEREST },
        ],
      });
    }
    await pay(auth, people.deepak, period, "300.00", "nov-deepak-partial-with-penalty");
    await payShareOnly(auth, people.esha, period, "500.00", "nov-esha-share-only");
    await payEveryoneStillDue(auth, people, period, "nov-before-pool");
    await confirmDistribution(auth, period, "November interest pool");
    const ashaAfter = await prisma.member.findUniqueOrThrow({ where: { id: people.asha } });
    if (money(str(ashaAfter.interestBalance)).greaterThan(0)) {
      const take = money(str(ashaAfter.interestBalance)).lessThan("5.00") ? str(ashaAfter.interestBalance) : "5.00";
      await withdrawInterest(auth, { memberId: people.asha, amount: take, date: `${period}-22`, reason: "Asha withdraws interest" });
    }
    await close("November mixed loan dues and withdrawal");

    // 12 Dec — pay remaining dues on everyone
    await payDue(auth, people.asha, period, "dec-asha-full");
    await payDue(auth, people.bharat, period, "dec-bharat-full");
    await payDue(auth, people.chitra, period, "dec-chitra-full");
    await payDue(auth, people.deepak, period, "dec-deepak-full");
    await payDue(auth, people.esha, period, "dec-esha-full");
    await assertBooks(auth, "December full settlement");
    await memberStatement(auth, people.bharat);
    await memberStatement(auth, people.chitra);
    await reportData(auth, "society-balance");
    const last = await previewClose(auth);
    expect(last.period).toBe("2025-12");
    expect(last.checks.ok).toBe(true);
    await confirmClose(auth, "Close December");

    const months = await prisma.accountingMonth.findMany({ where: { societyId: society.id }, orderBy: { period: "asc" } });
    expect(months.filter((row) => row.status === "CLOSED").map((row) => row.period)).toEqual([
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
    ]);
    expect(months.find((row) => row.status === "OPEN")?.period).toBe("2026-01");
    await assertBooks(auth, "January 2026 opened after 12 months");

    await wipeSociety(society.id);
  }, 180000);
});
