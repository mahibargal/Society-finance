import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthUser } from "../middleware/auth.js";
import { calendarPeriod, nextPeriod, statementDateFor, utcDate } from "../lib/format.js";
import { money, subtractMoney, sumMoney } from "../engine/finance.js";
import { dec, str } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import { createApp } from "../app.js";
import { createServer } from "node:http";
import {
  activateMember,
  addPenalty,
  confirmClose,
  markMissingReceiptsForOpenMonth,
  confirmDistribution,
  createLoan,
  createMember,
  deactivateMember,
  deletePayment,
  duesFor,
  ensureOpenStatements,
  postPayment,
  previewClose,
  previewPayment,
  syncOpenMonthInterestBooks,
} from "./books.js";
import { adminDashboard, listMembers, memberStatement, monthSheet, monthSheetCollected } from "./read.js";

const MARK = "__member_status_test__";

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

describe("member active and inactive", () => {
  it("blocks collect, loan and login while inactive, keeps closed books, and opens a statement again on activate", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Status Owner",
        username: `mso${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const staying = await createMember(auth, {
      name: "Staying Member",
      mobile: "9833333301",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `mss${stamp}`,
      password: "Member@2026",
      reason: "Active throughout",
    });
    const leaving = await createMember(auth, {
      name: "Leaving Member",
      mobile: "9833333302",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `msl${stamp}`,
      password: "Member@2026",
      reason: "Will be deactivated",
    });

    await postPayment(auth, {
      memberId: staying.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "Staying share",
      idempotencyKey: `stay-share-${stamp}`,
    });
    await postPayment(auth, {
      memberId: leaving.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "Leaving share",
      idempotencyKey: `leave-share-${stamp}`,
    });
    await createLoan(auth, {
      memberId: leaving.id,
      amount: "300.00",
      date: `${start}-10`,
      scheduledPrincipal: "100.00",
      reason: "Loan before leaving",
    });

    const before = await memberStatement(auth, leaving.id);
    expect(before.member.status).toBe("ACTIVE");
    expect(before.member.shareBalance).toBe("0.00");
    expect(before.member.loanOutstanding).toBe("300.00");
    expect(before.payments).toHaveLength(1);

    await expect(deactivateMember(auth, leaving.id, "Member left the society")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/loan is still outstanding/i),
    });

    await confirmClose(auth, "Close month after collections");
    const opened = nextPeriod(start);
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await prisma.member.findUniqueOrThrow({ where: { id: leaving.id } });
      const loanLeft = str(row.loanOutstanding);
      if (!money(loanLeft).greaterThan(0)) break;
      const dueBeforeExit = await duesFor(society.id, leaving.id, opened);
      const extraPrincipal = subtractMoney(loanLeft, dueBeforeExit.dues.PRINCIPAL);
      let pay = sumMoney([
        dueBeforeExit.totalDue,
        money(extraPrincipal).greaterThan(0) ? extraPrincipal : "0.00",
      ]);
      if (!money(pay).greaterThan(0)) pay = loanLeft;
      const preview = await previewPayment(auth, {
        memberId: leaving.id,
        period: opened,
        amount: pay,
      });
      if (money(preview.unapplied).greaterThan(0)) {
        pay = subtractMoney(pay, preview.unapplied);
      }
      if (!money(pay).greaterThan(0)) break;
      await postPayment(auth, {
        memberId: leaving.id,
        period: opened,
        amount: pay,
        paidOn: `${opened}-0${5 + attempt}`,
        reason: "Pay open month and clear loan before deactivation",
        idempotencyKey: `leave-clear-loan-${stamp}-${attempt}`,
      });
    }
    expect(str((await prisma.member.findUniqueOrThrow({ where: { id: leaving.id } })).loanOutstanding)).toBe("0.00");
    const stayDueInOpened = await duesFor(society.id, staying.id, opened);
    if (money(stayDueInOpened.totalDue).greaterThan(0)) {
      await postPayment(auth, {
        memberId: staying.id,
        period: opened,
        amount: stayDueInOpened.totalDue,
        paidOn: `${opened}-20`,
        reason: "Staying member share for month close",
        idempotencyKey: `stay-open-${stamp}`,
      });
    }
    await confirmClose(auth, "Close month after clearing loan");
    const openForExit = nextPeriod(opened);
    await deactivateMember(auth, leaving.id, "Member left the society");

    const openDueSheet = await monthSheet(auth, openForExit);
    expect(openDueSheet.rows.some((row) => row.member === "Leaving Member")).toBe(false);
    expect(openDueSheet.rows.some((row) => row.member === "Staying Member")).toBe(true);
    const openCollected = await monthSheetCollected(auth, openForExit);
    expect(openCollected.rows.some((row) => row.member === "Leaving Member")).toBe(false);
    expect(openCollected.rows.some((row) => row.member === "Staying Member")).toBe(true);
    const exitMonthCollected = await monthSheetCollected(auth, opened);
    const leavingClosed = exitMonthCollected.rows.find((row) => row.member === "Leaving Member");
    if (leavingClosed) {
      expect(Number(leavingClosed.totalReceived)).toBeGreaterThan(0);
    }

    const listed = await listMembers(auth);
    expect(listed.find((row) => row.id === leaving.id)?.status).toBe("INACTIVE");
    expect(listed.find((row) => row.id === staying.id)?.status).toBe("ACTIVE");
    const home = await adminDashboard(auth);
    expect(home.members.total).toBe(2);
    expect(home.members.active).toBe(1);

    await expect(
      postPayment(auth, {
        memberId: leaving.id,
        period: openForExit,
        amount: "100.00",
        paidOn: `${openForExit}-18`,
        reason: "Must not collect from inactive",
        idempotencyKey: `leave-blocked-${stamp}`,
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/left the society/i) });

    await expect(
      previewPayment(auth, { memberId: leaving.id, period: openForExit, amount: "100.00" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/left the society|no installment/i) });

    await expect(
      createLoan(auth, {
        memberId: leaving.id,
        amount: "50.00",
        date: `${start}-20`,
        scheduledPrincipal: "10.00",
        reason: "Must not lend to inactive",
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/loan cannot be disbursed/i) });

    const frozen = await memberStatement(auth, leaving.id);
    expect(frozen.member.status).toBe("INACTIVE");
    expect(frozen.member.shareBalance).toBe("0.00");
    expect(frozen.member.loanOutstanding).toBe("0.00");
    expect(frozen.historyAvailable).toBe(false);
    expect(frozen.timeline).toHaveLength(0);
    expect(frozen.payments).toHaveLength(0);
    expect(frozen.loans).toHaveLength(0);
    expect(frozen.member.loanOutstanding).toBe("0.00");

    const preview = await previewClose(auth);
    expect(preview.checks.ok).toBe(true);
    const closedDueSheet = await monthSheet(auth, start);
    expect(closedDueSheet.rows.some((row) => row.member === "Leaving Member")).toBe(true);
    const closedCollected = await monthSheetCollected(auth, start);
    expect(closedCollected.rows.find((row) => row.member === "Leaving Member")?.totalReceived).toBe("500.00");

    const inactiveNext = await prisma.memberMonth.findUnique({
      where: { societyId_memberId_period: { societyId: society.id, memberId: leaving.id, period: opened } },
    });
    expect(inactiveNext).toBeTruthy();
    const stayingNext = await prisma.memberMonth.findUnique({
      where: { societyId_memberId_period: { societyId: society.id, memberId: staying.id, period: opened } },
    });
    expect(stayingNext).toBeTruthy();

    const closedHistory = await memberStatement(auth, leaving.id);
    expect(closedHistory.historyAvailable).toBe(false);
    expect(closedHistory.timeline).toHaveLength(0);
    expect(closedHistory.member.shareBalance).toBe("0.00");
    expect(closedHistory.member.loanOutstanding).toBe("0.00");

    await activateMember(auth, leaving.id, "Member rejoined the society");
    const reopenedSheet = await monthSheet(auth, openForExit);
    expect(reopenedSheet.rows.some((row) => row.member === "Leaving Member")).toBe(true);
    expect(Number(reopenedSheet.totals.total)).toBeGreaterThan(0);

    const back = await memberStatement(auth, leaving.id);
    expect(back.member.status).toBe("ACTIVE");
    expect(back.openPeriod).toBe(openForExit);
    expect(back.due).toBeTruthy();
    expect(back.historyAvailable).toBe(true);
    expect(back.timeline.some((row) => row.period === start)).toBe(false);
    expect(back.timeline.some((row) => row.period === opened)).toBe(false);
    expect(back.timeline.some((row) => row.period === openForExit)).toBe(true);
    expect(back.member.shareBalance).toBe("0.00");
    expect(back.member.loanOutstanding).toBe("0.00");

    const openDue = await duesFor(society.id, leaving.id, openForExit);
    expect(openDue.totalDue).not.toBe("0.00");
    await postPayment(auth, {
      memberId: leaving.id,
      period: openForExit,
      amount: openDue.dues.SHARE,
      paidOn: `${openForExit}-12`,
      reason: "Collect after activate",
      idempotencyKey: `leave-back-${stamp}`,
      allocation: [{ component: "SHARE", amount: openDue.dues.SHARE }],
    });

    if (openDue.dues.CURRENT_INTEREST !== "0.00") {
      await postPayment(auth, {
        memberId: leaving.id,
        period: openForExit,
        amount: openDue.dues.CURRENT_INTEREST,
        paidOn: `${openForExit}-13`,
        reason: "Interest after activate",
        idempotencyKey: `leave-int-${stamp}`,
        allocation: [{ component: "CURRENT_INTEREST", amount: openDue.dues.CURRENT_INTEREST }],
      });
      for (const memberId of [leaving.id, staying.id]) {
        const due = await duesFor(society.id, memberId, openForExit);
        if (money(due.totalDue).greaterThan(0)) {
          await postPayment(auth, {
            memberId,
            period: openForExit,
            amount: due.totalDue,
            paidOn: `${openForExit}-14`,
            reason: "Clear open month before pool",
            idempotencyKey: `leave-pool-clear-${memberId}-${stamp}`,
          });
        }
      }
      const dist = await confirmDistribution(auth, openForExit, "Share after return", [
        { memberId: leaving.id, payoutMethod: "CASH" },
        { memberId: staying.id, payoutMethod: "CASH" },
      ]);
      expect(dist.entries.some((row) => row.memberId === leaving.id)).toBe(true);
    }

    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const login = async (username: string, password: string) => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      return res.status;
    };
    expect(await login(`msl${stamp}`, "Member@2026")).toBe(200);
    await expect(deactivateMember(auth, leaving.id, "Left again")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/collected from Leaving Member/i),
    });
    const openBeforeSecondClose = (await prisma.accountingMonth.findFirstOrThrow({
      where: { societyId: society.id, status: "OPEN" },
    })).period;
    for (const memberId of [leaving.id, staying.id]) {
      const due = await duesFor(society.id, memberId, openBeforeSecondClose);
      if (money(due.totalDue).greaterThan(0)) {
        await postPayment(auth, {
          memberId,
          period: openBeforeSecondClose,
          amount: due.totalDue,
          paidOn: `${openBeforeSecondClose}-17`,
          reason: "Clear open month before second close",
          idempotencyKey: `leave-second-close-${memberId}-${stamp}`,
        });
      }
    }
    await syncOpenMonthInterestBooks(auth);
    const closeAfterReturn = await previewClose(auth);
    expect(closeAfterReturn.checks.ok).toBe(true);
    await confirmClose(auth, "Close month before deactivate after return");
    const openAfterReturn = await prisma.accountingMonth.findFirstOrThrow({
      where: { societyId: society.id, status: "OPEN" },
    });
    const leavingBeforeExit = await prisma.member.findUniqueOrThrow({ where: { id: leaving.id } });
    const exitCashNeed = sumMoney([str(leavingBeforeExit.shareBalance), str(leavingBeforeExit.interestBalance)]);
    const ledgerRows = await prisma.ledgerEntry.findMany({ where: { societyId: society.id } });
    const cashIn = sumMoney(ledgerRows.filter((row) => row.cashEffect === "IN").map((row) => str(row.credit)));
    const cashOut = sumMoney(ledgerRows.filter((row) => row.cashEffect === "OUT").map((row) => str(row.debit)));
    const cashOnHand = subtractMoney(cashIn, cashOut);
    const cashShortfall = subtractMoney(exitCashNeed, cashOnHand);
    if (money(cashShortfall).greaterThan(0)) {
      await addPenalty(auth, {
        memberId: staying.id,
        period: openAfterReturn.period,
        amount: cashShortfall,
        date: `${openAfterReturn.period}-15`,
        reason: "Top up society cash before member exit settlement",
      });
      const stayDueAfterClose = await duesFor(society.id, staying.id, openAfterReturn.period);
      await postPayment(auth, {
        memberId: staying.id,
        period: openAfterReturn.period,
        amount: stayDueAfterClose.totalDue,
        paidOn: `${openAfterReturn.period}-16`,
        reason: "Collect float before exit settlement",
        idempotencyKey: `exit-float-${stamp}`,
      });
    }
    await deactivateMember(auth, leaving.id, "Left again");
    expect(await login(`msl${stamp}`, "Member@2026")).toBe(401);
    await activateMember(auth, leaving.id, "Back again");
    expect(await login(`msl${stamp}`, "Member@2026")).toBe(200);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

    await wipeSociety(society.id);
  }, 60000);

  it("starts rejoined members at zero shares even after open-month heal", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}reentry${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Reentry Owner",
        username: `mro${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const peer = await createMember(auth, {
      name: "Peer Member",
      mobile: "9833333391",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `mrp${stamp}`,
      password: "Member@2026",
      reason: "Stays active",
    });
    const returning = await createMember(auth, {
      name: "Returning Member",
      mobile: "9833333392",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `mrr${stamp}`,
      password: "Member@2026",
      reason: "Will leave and return",
    });
    for (const memberId of [peer.id, returning.id]) {
      await postPayment(auth, {
        memberId,
        period: start,
        amount: "500.00",
        paidOn: `${start}-08`,
        reason: "Share",
        idempotencyKey: `reentry-share-${memberId}-${stamp}`,
      });
    }
    await confirmClose(auth, "Close before exit");
    const openExit = (await prisma.accountingMonth.findFirstOrThrow({ where: { societyId: society.id, status: "OPEN" } }))
      .period;
    const peerDue = await duesFor(society.id, peer.id, openExit);
    if (money(peerDue.totalDue).greaterThan(0)) {
      await postPayment(auth, {
        memberId: peer.id,
        period: openExit,
        amount: peerDue.totalDue,
        paidOn: `${openExit}-10`,
        reason: "Peer only — returning has no receipt this month",
        idempotencyKey: `reentry-peer-${stamp}`,
      });
    }
    await deactivateMember(auth, returning.id, "Left with share payout");
    expect((await listMembers(auth)).find((row) => row.id === returning.id)?.shareBalance).toBe("0.00");
    await activateMember(auth, returning.id, "Rejoined");
    await ensureOpenStatements(auth);
    expect((await listMembers(auth)).find((row) => row.id === returning.id)?.shareBalance).toBe("0.00");
    const sheet = await monthSheet(auth, openExit);
    const row = sheet.rows.find((r) => r.member === "Returning Member");
    expect(row?.shares).toBe("0.00");
    const stmt = await memberStatement(auth, returning.id);
    expect(stmt.timeline.every((r) => r.period >= openExit)).toBe(true);
    expect(stmt.payments).toHaveLength(0);
    const closedCollected = await monthSheetCollected(auth, start);
    expect(closedCollected.rows.some((r) => r.member === "Returning Member")).toBe(true);
    await wipeSociety(society.id);
  }, 60000);

  it("still lists members when share cash is higher than assessments", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}gap${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Gap Owner",
        username: `mgo${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Gap Member",
      mobile: "9833333399",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `mgm${stamp}`,
      password: "Member@2026",
      reason: "Share cash gap",
    });
    await prisma.ledgerEntry.create({
      data: {
        societyId: society.id,
        memberId: member.id,
        date: utcDate(`${start}-11`),
        period: start,
        type: "MEMBER_CONTRIBUTION",
        debit: dec("0.00"),
        credit: dec("300.00"),
        amount: dec("300.00"),
        cashEffect: "IN",
        reference: "EXTRA",
        reason: "Cash beyond the assessment",
        createdById: owner.id,
      },
    });
    const rows = await listMembers(auth);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Gap Member");
    await wipeSociety(society.id);
  });

  it("receives due penalty and can leave a next-month penalty on a short payment", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}pen${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Penalty Owner",
        username: `mpo${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Penalty Member",
      mobile: "9844444499",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `mpm${stamp}`,
      password: "Member@2026",
      reason: "Penalty options",
    });
    await addPenalty(auth, {
      memberId: member.id,
      period: start,
      amount: "50.00",
      date: `${start}-08`,
      reason: "Late last meeting",
    });
    const preview = await previewPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "150.00",
      collectPenalty: true,
      nextMonthPenalty: "20.00",
    });
    expect(preview.allocation.find((row) => row.component === "PENALTY")?.amount).toBe("50.00");
    expect(preview.allocation.find((row) => row.component === "SHARE")?.amount).toBe("100.00");
    expect(preview.nextMonthPenalty).toBe("20.00");
    await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "150.00",
      paidOn: `${start}-09`,
      reason: "Short payment",
      idempotencyKey: `pen-opt-${stamp}`,
      collectPenalty: true,
      nextMonthPenalty: "20.00",
    });
    const due = await duesFor(society.id, member.id, start);
    expect(due.dues.PENALTY).toBe("0.00");
    expect(due.dues.SHARE).toBe("400.00");
    const scheduled = await prisma.penalty.findMany({ where: { societyId: society.id, memberId: member.id, source: "NEXT_MONTH" } });
    expect(scheduled).toHaveLength(1);
    expect(str(scheduled[0].amount)).toBe("20.00");
    expect(scheduled[0].period).toBe(nextPeriod(start));
    await wipeSociety(society.id);
  });

  it("adds unpaid penalty and a next-month penalty, and accepts a partial receipt", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}pcarry${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Carry Owner",
        username: `pco${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Carry Penalty",
      mobile: "9844444411",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `pcm${stamp}`,
      password: "Member@2026",
      reason: "Penalty carry member",
    });
    await addPenalty(auth, {
      memberId: member.id,
      period: start,
      amount: "100.00",
      date: `${start}-08`,
      reason: "June penalty unpaid",
    });
    await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-10`,
      reason: "Share only, penalty left",
      idempotencyKey: `pcarry-share-${stamp}`,
      nextMonthPenalty: "100.00",
    });
    expect((await duesFor(society.id, member.id, start)).dues.PENALTY).toBe("100.00");
    await confirmClose(auth, "Close after unpaid penalty");
    const july = (await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } }))!.period;
    const julyDue = await duesFor(society.id, member.id, july);
    expect(julyDue.dues.PENALTY).toBe("200.00");
    await postPayment(auth, {
      memberId: member.id,
      period: july,
      amount: "580.00",
      paidOn: `${july}-10`,
      reason: "Share and part penalty",
      idempotencyKey: `pcarry-part-${stamp}`,
      collectPenalty: true,
      collectPenaltyAmount: "80.00",
    });
    expect((await duesFor(society.id, member.id, july)).dues.PENALTY).toBe("120.00");
    await confirmClose(auth, "Close after partial penalty");
    const august = (await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } }))!.period;
    expect((await duesFor(society.id, member.id, august)).dues.PENALTY).toBe("120.00");
    await wipeSociety(society.id);
  });
});

describe("remove mistaken payment", () => {
  it("restores dues in the open month and refuses a closed month", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}void${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Void Owner",
        username: `vso${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Void Member",
      mobile: "9844444401",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `vsm${stamp}`,
      password: "Member@2026",
      reason: "Void payment member",
    });
    const first = await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "Wrong amount",
      idempotencyKey: `void-first-${stamp}`,
    });
    expect((await duesFor(society.id, member.id, start)).totalDue).toBe("0.00");
    await deletePayment(auth, first.id, "Entered by mistake");
    expect((await duesFor(society.id, member.id, start)).dues.SHARE).toBe("500.00");
    const again = await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-09`,
      reason: "Correct amount",
      idempotencyKey: `void-again-${stamp}`,
    });
    expect(again.status).toBe("RECORDED");
    expect((await duesFor(society.id, member.id, start)).totalDue).toBe("0.00");
    await createLoan(auth, {
      memberId: member.id,
      amount: "400.00",
      date: `${start}-12`,
      scheduledPrincipal: "100.00",
      reason: "Loan after corrected receipt",
    });
    await confirmClose(auth, "Close after corrected share");
    await expect(deletePayment(auth, again.id, "Too late")).rejects.toThrow(/still open/);
    const opened = (await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } }))!.period;
    const due = await duesFor(society.id, member.id, opened);
    const second = await postPayment(auth, {
      memberId: member.id,
      period: opened,
      amount: due.totalDue,
      paidOn: `${opened}-10`,
      reason: "Full installment then remove",
      idempotencyKey: `void-second-${stamp}`,
    });
    const loanBefore = await prisma.loan.findFirst({ where: { societyId: society.id, memberId: member.id } });
    expect(str(loanBefore!.outstandingPrincipal)).toBe("300.00");
    await deletePayment(auth, second.id, "Entered by mistake");
    const restored = await duesFor(society.id, member.id, opened);
    expect(restored.totalDue).toBe(due.totalDue);
    const loanAfter = await prisma.loan.findFirst({ where: { societyId: society.id, memberId: member.id } });
    expect(str(loanAfter!.outstandingPrincipal)).toBe("400.00");
    const close = await previewClose(auth);
    expect(close.checks.ok).toBe(true);
    await wipeSociety(society.id);
  });

  it("adds a further loan onto the same book so the next month shows the new outstanding", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}topup${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Topup Owner",
        username: `tso${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Topup Member",
      mobile: "9844444402",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `tsm${stamp}`,
      password: "Member@2026",
      reason: "Top-up loan member",
    });
    await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "First share",
      idempotencyKey: `topup-share-${stamp}`,
    });
    await createLoan(auth, {
      memberId: member.id,
      amount: "400.00",
      date: `${start}-10`,
      scheduledPrincipal: "100.00",
      reason: "First loan",
    });
    await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "100.00",
      paidOn: `${start}-12`,
      reason: "Principal in the same month",
      idempotencyKey: `topup-prin-${stamp}`,
    });
    const added = await createLoan(auth, {
      memberId: member.id,
      amount: "150.00",
      date: `${start}-15`,
      scheduledPrincipal: "150.00",
      reason: "Further loan",
    });
    const live = await prisma.loan.findMany({
      where: { societyId: society.id, memberId: member.id, status: { not: "CANCELLED" } },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(added.id);
    expect(str(live[0].outstandingPrincipal)).toBe("450.00");
    expect(str(live[0].scheduledPrincipal)).toBe("150.00");
    await confirmClose(auth, "Close after top-up");
    const opened = (await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } }))!.period;
    const due = await duesFor(society.id, member.id, opened);
    expect(str(due.statement.openingPrincipal)).toBe("450.00");
    expect(due.dues.CURRENT_INTEREST).toBe("4.50");
    expect(due.dues.PRINCIPAL).toBe("150.00");
    await wipeSociety(society.id);
  });

  it("keeps this month's principal column until the next month after a loan or schedule change", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}prin${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Principal Owner",
        username: `pso${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Principal Member",
      mobile: "9844444403",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `psm${stamp}`,
      password: "Member@2026",
      reason: "Principal next-month member",
    });
    const other = await createMember(auth, {
      name: "Cash Member",
      mobile: "9844444404",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `psc${stamp}`,
      password: "Member@2026",
      reason: "Share cash for the loan",
    });
    await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "First share",
      idempotencyKey: `prin-share-${stamp}`,
    });
    await postPayment(auth, {
      memberId: other.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "Other share",
      idempotencyKey: `prin-other-${stamp}`,
    });
    await createLoan(auth, {
      memberId: member.id,
      amount: "400.00",
      date: `${start}-10`,
      scheduledPrincipal: "100.00",
      reason: "First loan",
    });
    await listMembers(auth);
    expect((await duesFor(society.id, member.id, start)).dues.PRINCIPAL).toBe("0.00");
    await confirmClose(auth, "Close first loan month");
    const second = nextPeriod(start);
    const afterClose = await duesFor(society.id, member.id, second);
    expect(str(afterClose.statement.openingPrincipal)).toBe("400.00");
    expect(afterClose.dues.PRINCIPAL).toBe("100.00");
    await createLoan(auth, {
      memberId: member.id,
      amount: "150.00",
      date: `${second}-12`,
      scheduledPrincipal: "250.00",
      reason: "Top-up with a new schedule",
    });
    const listed = await listMembers(auth);
    const sameMonth = await duesFor(society.id, member.id, second);
    expect(str(sameMonth.statement.openingPrincipal)).toBe("400.00");
    expect(sameMonth.dues.PRINCIPAL).toBe("100.00");
    expect(listed.find((row) => row.id === member.id)?.principalDue).toBe("100.00");
    expect(listed.find((row) => row.id === member.id)?.scheduledPrincipal).toBe("100.00");
    await markMissingReceiptsForOpenMonth(auth);
    await confirmClose(auth, "Close after schedule change");
    const third = nextPeriod(second);
    const nextMonth = await duesFor(society.id, member.id, third);
    expect(str(nextMonth.statement.openingPrincipal)).toBe("550.00");
    expect(nextMonth.dues.CURRENT_INTEREST).toBe("5.50");
    expect(nextMonth.dues.PRINCIPAL).toBe("250.00");
    await wipeSociety(society.id);
  });

  it("does not add unpaid monthly share to the share column", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}share${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Share Owner",
        username: `sho${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const paid = await createMember(auth, {
      name: "Paid Share",
      mobile: "9844444411",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `shp${stamp}`,
      password: "Member@2026",
      reason: "Pays share",
    });
    const unpaid = await createMember(auth, {
      name: "Unpaid Share",
      mobile: "9844444412",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `shu${stamp}`,
      password: "Member@2026",
      reason: "Misses share",
    });
    await postPayment(auth, {
      memberId: paid.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "Paid share",
      idempotencyKey: `share-paid-${stamp}`,
    });
    await postPayment(auth, {
      memberId: unpaid.id,
      period: start,
      amount: "0.00",
      paidOn: `${start}-09`,
      reason: "Marked collected at ₹0",
      idempotencyKey: `share-unpaid-marked-${stamp}`,
      allocation: [
        { component: "SHARE", amount: "0.00" },
        { component: "CURRENT_INTEREST", amount: "0.00" },
        { component: "PREVIOUS_INTEREST", amount: "0.00" },
      ],
    });
    const sheet = await monthSheet(auth, start);
    const paidRow = sheet.rows.find((row: { member: string }) => row.member === "Paid Share");
    const unpaidRow = sheet.rows.find((row: { member: string }) => row.member === "Unpaid Share");
    expect(paidRow.shares).toBe("0.00");
    expect(unpaidRow.shares).toBe("0.00");
    expect((await listMembers(auth)).find((row) => row.id === paid.id)?.shareBalance).toBe("0.00");
    expect((await listMembers(auth)).find((row) => row.id === unpaid.id)?.shareBalance).toBe("0.00");
    await confirmClose(auth, "Close with one unpaid share");
    const next = nextPeriod(start);
    const nextSheet = await monthSheet(auth, next);
    expect(nextSheet.rows.find((row: { member: string }) => row.member === "Unpaid Share").shares).toBe("0.00");
    expect(nextSheet.rows.find((row: { member: string }) => row.member === "Paid Share").shares).toBe("500.00");
    await wipeSociety(society.id);
  });

  it("collects imported share arrears without a missing-assessment error", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}arrears${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: start, status: "OPEN", statementDate: utcDate(statementDateFor(start)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Arrears Owner",
        username: `aro${stamp}`,
        passwordHash: await bcrypt.hash("Owner@2026", 10),
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
    const member = await createMember(auth, {
      name: "Rajput Arrears",
      mobile: "9844444413",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `ara${stamp}`,
      password: "Member@2026",
      reason: "Has unpaid share from the register",
    });
    await prisma.memberMonth.update({
      where: { societyId_memberId_period: { societyId: society.id, memberId: member.id, period: start } },
      data: { arrearsCash: dec("1500.00"), shareCashPending: dec("500.00") },
    });
    const paid = await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "2000.00",
      paidOn: `${start}-08`,
      reason: "Share plus arrears",
      idempotencyKey: `arrears-pay-${stamp}`,
      allocation: [{ component: "SHARE", amount: "2000.00" }],
    });
    expect(str(paid.amount)).toBe("2000.00");
    expect((await listMembers(auth)).find((row) => row.id === member.id)?.shareBalance).toBe("0.00");
    const collected = await monthSheetCollected(auth, start);
    expect(collected.rows.find((row: { member: string }) => row.member === "Rajput Arrears")?.sharePaid).toBe("2000.00");
    await wipeSociety(society.id);
  });
});
