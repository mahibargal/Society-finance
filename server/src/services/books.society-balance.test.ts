import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import type { AuthUser } from "../middleware/auth.js";
import { calendarPeriod, nextPeriod, statementDateFor, utcDate } from "../lib/format.js";
import { dec } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import { confirmClose, createMember, deletePayment, postPayment, previewClose, reopenPreviousMonth, reopenStatus } from "./books.js";

const MARK = "__close_balance_test__";

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

describe("month-close society balance", () => {
  it("stays matched after unpaid share is collected in the next month", async () => {
    const stamp = Date.now().toString(36);
    const period = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period, status: "OPEN", statementDate: utcDate(statementDateFor(period)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Close Test Owner",
        username: `zct${stamp}`,
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
    const member = await createMember(auth, {
      name: "Arrears Member",
      mobile: "9876543210",
      joiningDate: `${period}-01`,
      monthlyShare: "500.00",
      username: `zcm${stamp}`,
      password: "Member@2026",
      reason: "Close-balance test member",
    });
    await postPayment(auth, {
      memberId: member.id,
      period,
      amount: "200.00",
      paidOn: `${period}-10`,
      reason: "Partial share",
      idempotencyKey: `close-test-1-${stamp}`,
    });
    const closed = await confirmClose(auth, "Close first month with unpaid share");
    expect(closed.opened).toBe(nextPeriod(period));
    await postPayment(auth, {
      memberId: member.id,
      period: closed.opened,
      amount: "400.00",
      paidOn: `${closed.opened}-10`,
      reason: "Arrears plus part of this month",
      idempotencyKey: `close-test-2-${stamp}`,
    });
    const preview = await previewClose(auth);
    const balance = preview.checks.checks.find((row) => row.name === "Society balance");
    expect(balance?.expected).toBe("600.00");
    expect(balance?.calculated).toBe("600.00");
    expect(balance?.ok).toBe(true);
    expect(preview.checks.ok).toBe(true);
    await wipeSociety(society.id);
  }, 30_000);

  it("lists every member paid and unpaid on close, unpaid first", async () => {
    const stamp = Date.now().toString(36);
    const period = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}cols${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period, status: "OPEN", statementDate: utcDate(statementDateFor(period)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Collections Owner",
        username: `zco${stamp}`,
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
    const unpaid = await createMember(auth, {
      name: "Unpaid Member",
      mobile: "9876543291",
      joiningDate: `${period}-01`,
      monthlyShare: "500.00",
      username: `zcu${stamp}`,
      password: "Member@2026",
      reason: "Leaves share unpaid",
    });
    const paid = await createMember(auth, {
      name: "Paid Member",
      mobile: "9876543292",
      joiningDate: `${period}-01`,
      monthlyShare: "500.00",
      username: `zcp${stamp}`,
      password: "Member@2026",
      reason: "Pays in full",
    });
    await postPayment(auth, {
      memberId: paid.id,
      period,
      amount: "500.00",
      paidOn: `${period}-10`,
      reason: "Full share",
      idempotencyKey: `cols-paid-${stamp}`,
    });
    const preview = await previewClose(auth);
    expect(preview.collections.map((row) => row.name)).toEqual(["Unpaid Member", "Paid Member"]);
    expect(preview.collections[0]).toMatchObject({ memberId: unpaid.id, paid: "0.00", unpaid: "500.00" });
    expect(preview.collections[1]).toMatchObject({ memberId: paid.id, paid: "500.00", unpaid: "0.00" });
    await wipeSociety(society.id);
  });

  it("reopens only the last closed month so a wrong collection can be changed", async () => {
    const stamp = Date.now().toString(36);
    const start = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}reopen${stamp}`,
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
        name: "Reopen Owner",
        username: `zro${stamp}`,
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
    const member = await createMember(auth, {
      name: "Reopen Member",
      mobile: "9876543293",
      joiningDate: `${start}-01`,
      monthlyShare: "500.00",
      username: `zrm${stamp}`,
      password: "Member@2026",
      reason: "Pays then needs a correction",
    });
    expect((await reopenStatus(auth)).canReopen).toBe(false);
    const first = await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-08`,
      reason: "First receipt",
      idempotencyKey: `reopen-1-${stamp}`,
    });
    await confirmClose(auth, "Close so the next month opens");
    const opened = (await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } }))!.period;
    expect(opened).toBe(nextPeriod(start));
    expect((await reopenStatus(auth)).canReopen).toBe(true);
    const result = await reopenPreviousMonth(auth, "Receipt was wrong");
    expect(result).toEqual({ opened: start, removed: opened });
    expect((await prisma.accountingMonth.findFirst({ where: { societyId: society.id, status: "OPEN" } }))?.period).toBe(start);
    expect(await prisma.memberMonth.count({ where: { societyId: society.id, period: opened } })).toBe(0);
    expect((await prisma.payment.findUnique({ where: { id: first.id } }))?.status).toBe("RECORDED");
    await deletePayment(auth, first.id, "Remove the wrong receipt");
    expect((await prisma.payment.findUnique({ where: { id: first.id } }))?.status).toBe("REVERSED");
    await postPayment(auth, {
      memberId: member.id,
      period: start,
      amount: "500.00",
      paidOn: `${start}-09`,
      reason: "Corrected receipt",
      idempotencyKey: `reopen-2-${stamp}`,
    });
    await confirmClose(auth, "Close after the correction");
    const again = nextPeriod(start);
    await postPayment(auth, {
      memberId: member.id,
      period: again,
      amount: "500.00",
      paidOn: `${again}-08`,
      reason: "Next month already collected",
      idempotencyKey: `reopen-3-${stamp}`,
    });
    expect((await reopenStatus(auth)).canReopen).toBe(false);
    await expect(reopenPreviousMonth(auth, "Too late")).rejects.toThrow(/already has collections/);
    await wipeSociety(society.id);
  });

  it("blocks adding members after the first month is closed", async () => {
    const stamp = Date.now().toString(36);
    const period = calendarPeriod();
    const society = await prisma.society.create({
      data: {
        name: `${MARK}add${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period, status: "OPEN", statementDate: utcDate(statementDateFor(period)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Register Owner",
        username: `zra${stamp}`,
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
    const first = await createMember(auth, {
      name: "First Member",
      mobile: "9876543201",
      joiningDate: `${period}-01`,
      monthlyShare: "500.00",
      username: `zrf${stamp}`,
      password: "Member@2026",
      reason: "Before close",
    });
    await postPayment(auth, {
      memberId: first.id,
      period,
      amount: "0.00",
      paidOn: `${period}-10`,
      reason: "Marked collected at ₹0",
      idempotencyKey: `mark-first-${stamp}`,
      allocation: [
        { component: "SHARE", amount: "0.00" },
        { component: "CURRENT_INTEREST", amount: "0.00" },
        { component: "PREVIOUS_INTEREST", amount: "0.00" },
      ],
    });
    await confirmClose(auth, "Close first month");
    await expect(
      createMember(auth, {
        name: "Late Member",
        mobile: "9876543202",
        joiningDate: `${period}-01`,
        monthlyShare: "500.00",
        username: `zrl${stamp}`,
        password: "Member@2026",
        reason: "After close",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await wipeSociety(society.id);
  }, 30_000);

  it("matches on Mahesh Society with the cash already collected", async () => {
    const society = await prisma.society.findFirst({ where: { name: { contains: "Mahesh", mode: "insensitive" } } });
    if (!society) return;
    const owner = await prisma.user.findFirst({ where: { societyId: society.id, role: { in: ["OWNER", "ADMIN"] } } });
    if (!owner) return;
    const preview = await previewClose({
      userId: owner.id,
      societyId: society.id,
      role: owner.role as "OWNER",
      memberId: owner.memberId,
      name: owner.name,
      tokenVersion: owner.tokenVersion,
    });
    const balance = preview.checks.checks.find((row) => row.name === "Society balance");
    expect(balance?.ok).toBe(true);
    expect(balance?.expected).toBe(balance?.calculated);
  });
});
