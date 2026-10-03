import bcrypt from "bcryptjs";
import * as XLSX from "xlsx";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthUser } from "../middleware/auth.js";
import { calendarPeriod, importEarliestPeriod, previousPeriod, statementDateFor, utcDate } from "../lib/format.js";
import { dec } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { importRegister, importRollbackStatus, postPayment } from "./books.js";
import { parseWorkbook } from "./import-sheet.js";

const MARK = "__import_test__";

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

describe("importRegister", () => {
  it("opens the previous calendar month when the empty society had only the current month open", async () => {
    const stamp = Date.now().toString(36);
    const open = calendarPeriod();
    const importPeriod = previousPeriod(open);
    const society = await prisma.society.create({
      data: {
        name: `${MARK}${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: open, status: "OPEN", statementDate: utcDate(statementDateFor(open)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Import Owner",
        username: `imp${stamp}`,
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

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["सभासद नाव", "एकूण शेअर्स", "शिल्लक कर्ज", "मासिक शेअर्स", "मासिक शेअर बाकी", "मागील व्याज", "चालू व्याज", "मुद्दल", "दंड", "एकूण हप्ता"],
        ["महाजन डी", "74379.00", "71000.00", "500.00", "0.00", "0.00", "710.00", "2000.00", "0.00", "3210.00"],
        ["राजपुत मंगल.", "73879.00", "151500.00", "500.00", "2000.00", "4545.00", "1515.00", "2500.00", "300.00", "10860.00"],
      ]),
      "Register",
    );
    const preview = parseWorkbook(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer, "0.01");
    expect(preview.validations.filter((row) => row.level === "error")).toEqual([]);

    const result = await importRegister(auth, {
      period: importPeriod,
      reason: "Previous-month register test",
      rows: preview.rows.map((row) => ({
        name: row.name,
        totalShares: row.totalShares,
        loanOutstanding: row.loanOutstanding,
        monthlyShare: row.monthlyShare,
        sharePending: row.sharePending,
        previousInterest: row.previousInterest,
        currentInterest: row.currentInterest,
        principal: row.principal,
        penalty: row.penalty,
      })),
    });
    expect(result.members).toBe(2);

    const months = await prisma.accountingMonth.findMany({ where: { societyId: society.id }, orderBy: { period: "asc" } });
    expect(months).toEqual([expect.objectContaining({ period: importPeriod, status: "OPEN" })]);

    const rollbackBefore = await importRollbackStatus(auth);
    expect(rollbackBefore).toMatchObject({ imported: true, canRollback: true });

    const member = await prisma.member.findFirstOrThrow({ where: { societyId: society.id } });
    await postPayment(auth, {
      memberId: member.id,
      period: importPeriod,
      amount: "100.00",
      paidOn: `${importPeriod}-10`,
      reason: "Blocks import rollback",
      idempotencyKey: `rollback-block-${stamp}`,
    });
    const rollbackAfter = await importRollbackStatus(auth);
    expect(rollbackAfter.canRollback).toBe(false);

    await wipeSociety(society.id);
  });

  it("rejects a sheet month older than the last three calendar months", async () => {
    const stamp = Date.now().toString(36);
    const current = calendarPeriod();
    const tooOld = previousPeriod(importEarliestPeriod(current));
    const society = await prisma.society.create({
      data: {
        name: `${MARK}${stamp}`,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec("500.00"),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await prisma.accountingMonth.create({
      data: { societyId: society.id, period: current, status: "OPEN", statementDate: utcDate(statementDateFor(current)) },
    });
    const owner = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name: "Import Owner",
        username: `imp2${stamp}`,
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
    await expect(
      importRegister(auth, {
        period: tooOld,
        reason: "Too old",
        rows: [{
          name: "Test",
          totalShares: "1000.00",
          loanOutstanding: "0.00",
          monthlyShare: "500.00",
          sharePending: "500.00",
          previousInterest: "0.00",
          currentInterest: "0.00",
          principal: "0.00",
          penalty: "0.00",
        }],
      }),
    ).rejects.toBeInstanceOf(HttpError);
    await wipeSociety(society.id);
  });
});
