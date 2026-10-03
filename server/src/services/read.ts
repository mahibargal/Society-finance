import type { AuthUser } from "../middleware/auth.js";
import {
  calculateInterestPool,
  money,
  netLedgerByType,
  poolAccruedForDashboard,
  shareDueOnBooks,
  shareOnSheet,
  sheetInstallmentTotal,
  societyBalanceFromLedger,
  sumInterestAccrualEvents,
  sumMoney,
  subtractMoney,
} from "../engine/finance.js";
import { formatINR, monthLabel, periodOf } from "../lib/format.js";
import { HttpError } from "../lib/http.js";
import { str } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";
import { assertOwnMember } from "../middleware/auth.js";
import {
  duesFor,
  ensureOpenStatements,
  interestPoolForSociety,
  openMonth,
  purgeInactiveMemberBalances,
  relocateNextMonthPenalties,
  syncOpenMonthInterestBooks,
} from "./books.js";

/** Open-month sheet shares (already booked) + share cash collected this month (books on the sheet next month). */
function memberCapitalFromOpenBooks(statements: { closingShares: Prisma.Decimal }[], openMonthShareCollected: string) {
  const onSheet = sumMoney(statements.map((row) => str(row.closingShares)));
  return sumMoney([onSheet, openMonthShareCollected]);
}

function inactiveMemberMoneyDisplay(status: string, field: string) {
  return status === "INACTIVE" ? "0.00" : field;
}

function societyCashFromComponents(input: {
  memberCapital: string;
  loansOutstanding: string;
  interestAvailable: string;
  penaltyAvailable: string;
}) {
  const total = subtractMoney(
    sumMoney([input.memberCapital, input.interestAvailable, input.penaltyAvailable]),
    input.loansOutstanding,
  );
  return {
    total,
    adds: [
      { name: "Member capital", amount: input.memberCapital },
      { name: "Interest earned (pool, undistributed)", amount: input.interestAvailable },
      { name: "Penalty earned (pool, undistributed)", amount: input.penaltyAvailable },
    ],
    less: [{ name: "Loans outstanding (active members)", amount: input.loansOutstanding }],
  };
}

function societyView(society: {
  id: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  logoUrl: string | null;
  currency: string;
  interestRate: { toString(): string };
  interestCalculationFrequency: string;
  interestCalculationMethod: string;
  interestDistributionFrequency: string;
  interestEligibilityRule: string;
  distributionMethod: string;
  roundingPolicy: string;
  paymentAllocationOrder: string;
  penaltyMethod: string;
}) {
  return {
    id: society.id,
    name: society.name,
    address: society.address,
    phone: society.phone,
    email: society.email,
    logoUrl: society.logoUrl,
    currency: society.currency,
    interestRate: society.interestRate.toString(),
    interestCalculationFrequency: society.interestCalculationFrequency,
    interestCalculationMethod: society.interestCalculationMethod,
    interestDistributionFrequency: society.interestDistributionFrequency,
    interestEligibilityRule: society.interestEligibilityRule,
    distributionMethod: society.distributionMethod,
    roundingPolicy: society.roundingPolicy,
    paymentAllocationOrder: society.paymentAllocationOrder.split(","),
    penaltyMethod: society.penaltyMethod,
  };
}

function distributionPenaltyPortion(row: { totalDistributed: unknown; interestPortion: unknown; penaltyPortion: unknown }) {
  const interest = str(row.interestPortion);
  const penalty = str(row.penaltyPortion);
  if (money(interest).greaterThan(0) || money(penalty).greaterThan(0)) return penalty;
  return "0.00";
}

function penaltyCollectedInPeriod(
  ledger: { period: string; type: string; cashEffect: string; credit: Prisma.Decimal; debit: Prisma.Decimal }[],
  period: string,
) {
  return netLedgerByType(
    ledger
      .filter((row) => row.period === period)
      .map((row) => ({
        type: row.type,
        cashEffect: row.cashEffect,
        credit: str(row.credit),
        debit: str(row.debit),
      })),
    "PENALTY_COLLECTION",
  );
}

function memberExitPeriod(member: { exitedAt: Date | null; updatedAt?: Date }) {
  const when = member.exitedAt ?? (member.updatedAt ? member.updatedAt : null);
  if (!when) return null;
  return periodOf(when.toISOString().slice(0, 10));
}

/** Inactive members stay on sheets through their exit month only; share capital shows 0 after payout. */
function memberOnSheetInPeriod(
  member: { status: string; exitedAt: Date | null; updatedAt?: Date },
  period: string,
) {
  if (member.status === "ACTIVE") return true;
  const exit = memberExitPeriod(member);
  if (!exit) return false;
  return period <= exit;
}

/** Member profile/history: rejoined members only see the open term; inactive members do not see months after exit. */
function memberHistoryIncludesPeriod(
  member: { status: string; shareBooksFromPeriod: string | null; exitedAt: Date | null; updatedAt?: Date },
  period: string,
) {
  if (!/^\d{4}-\d{2}$/.test(period)) return true;
  if (member.status === "ACTIVE" && member.shareBooksFromPeriod && period < member.shareBooksFromPeriod) return false;
  if (member.status === "INACTIVE") {
    const exit = memberExitPeriod(member);
    if (exit && period > exit) return false;
  }
  return true;
}

async function frozenMonthSheetReport(
  societyId: string,
  period: string | undefined,
  kind: "due" | "collected",
  options?: MonthSheetLoadOptions,
) {
  if (options?.snapshot) return null;
  const months = await prisma.accountingMonth.findMany({ where: { societyId }, orderBy: { period: "asc" } });
  const chosen = months.find((row) => row.period === period) ?? months.find((row) => row.status === "OPEN") ?? months.at(-1);
  if (!chosen || chosen.status !== "CLOSED" || !chosen.summary || typeof chosen.summary !== "object") return null;
  const snap = chosen.summary as { sheet?: MonthSheetReport; sheetCollected?: MonthSheetReport };
  const frozen = kind === "due" ? snap.sheet : snap.sheetCollected;
  if (!frozen || frozen.kind !== (kind === "due" ? "due" : "collected")) return null;
  return { ...frozen, periods: months.map((row) => row.period) };
}

function sheetSharesColumn(
  statement: { closingShares: Prisma.Decimal; member: { status: string; exitedAt: Date | null } },
) {
  if (statement.member.status === "ACTIVE") return str(statement.closingShares);
  return "0.00";
}

function sheetLoanColumn(
  statement: { openingPrincipal: Prisma.Decimal; member: { status: string; exitedAt: Date | null } },
) {
  if (statement.member.status === "ACTIVE") return str(statement.openingPrincipal);
  return "0.00";
}

function closedSeriesFromSummary(month: { period: string; status: string; summary: unknown }) {
  if (month.status !== "CLOSED" || !month.summary || typeof month.summary !== "object") return null;
  const snap = month.summary as {
    interestAccrued?: string;
    interestCollected?: string;
    interestDistributed?: string;
    penaltyAssessed?: string;
    penaltyCollected?: string;
    penaltyDistributed?: string;
    installment?: string;
    loansDisbursed?: string;
    principalRecovered?: string;
    parts?: { monthlyShare?: string; principal?: string; penalty?: string };
    sheet?: { totals?: { total?: string; monthlyShare?: string; principal?: string; penalty?: string } };
  };
  if (snap.installment == null && snap.sheet?.totals?.total == null) return null;
  return {
    period: month.period,
    label: monthLabel(month.period),
    interestAccrued: snap.interestAccrued ?? "0.00",
    interestCollected: snap.interestCollected ?? "0.00",
    interestDistributed: snap.interestDistributed ?? "0.00",
    penaltyAssessed: snap.penaltyAssessed ?? snap.parts?.penalty ?? snap.sheet?.totals?.penalty ?? "0.00",
    penaltyCollected: snap.penaltyCollected ?? "0.00",
    penaltyDistributed: snap.penaltyDistributed ?? "0.00",
    installment: snap.sheet?.totals?.total ?? snap.installment ?? "0.00",
    monthlyShare: snap.sheet?.totals?.monthlyShare ?? snap.parts?.monthlyShare ?? "0.00",
    principalDue: snap.sheet?.totals?.principal ?? snap.parts?.principal ?? "0.00",
    disbursed: snap.loansDisbursed ?? "0.00",
    principalRecovered: snap.principalRecovered ?? "0.00",
  };
}

export async function adminDashboard(auth: AuthUser) {
  try {
    await syncOpenMonthInterestBooks(auth);
  } catch {
    // Home still loads; accrued uses open-month statements even if sync is busy.
  }
  try {
    await purgeInactiveMemberBalances(auth.societyId);
  } catch {
    // Home still loads if a stale inactive row cannot be cleared right now.
  }
  const society = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  const month = await openMonth(auth.societyId);
  const members = await prisma.member.findMany({ where: { societyId: auth.societyId } });
  const months = await prisma.accountingMonth.findMany({ where: { societyId: auth.societyId }, orderBy: { period: "asc" } });
  const statementsAll = await prisma.memberMonth.findMany({
    where: { societyId: auth.societyId, period: month.period },
    include: { member: { select: { status: true } } },
  });
  const statements = statementsAll.filter((row) => row.member.status === "ACTIVE");
  const events = await prisma.interestEvent.findMany({ where: { societyId: auth.societyId } });
  const distributions = await prisma.interestDistribution.findMany({
    where: { societyId: auth.societyId, status: "CONFIRMED" },
    orderBy: { period: "asc" },
  });
  const ledger = await prisma.ledgerEntry.findMany({ where: { societyId: auth.societyId } });
  const loans = await prisma.loan.findMany({
    where: { societyId: auth.societyId, status: { not: "CANCELLED" } },
    include: { member: { select: { status: true } } },
  });
  const closedPeriods = months.filter((row) => row.status === "CLOSED").map((row) => row.period);
  const accrued = poolAccruedForDashboard({
    closedPeriods,
    openStatements: statements.map((row) => ({ currentInterest: str(row.currentInterest) })),
    events: events.map((row) => ({
      kind: row.kind,
      memberId: row.memberId,
      period: row.period,
      amount: str(row.amount),
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  });
  const poolDetail = await interestPoolForSociety(auth.societyId);
  const pool = calculateInterestPool({ accrued, collected: poolDetail.collected, distributed: poolDetail.distributed });
  const activeMemberIds = new Set(members.filter((member) => member.status === "ACTIVE").map((member) => member.id));
  const ledgerLines = ledger.map((row) => ({
    type: row.type,
    cashEffect: row.cashEffect,
    credit: str(row.credit),
    debit: str(row.debit),
  }));
  const societyCashLedger = societyBalanceFromLedger(ledgerLines).calculated;
  const allStatements = await prisma.memberMonth.findMany({
    where: { societyId: auth.societyId },
    include: { member: { select: { status: true, exitedAt: true } } },
  });
  const openMonthPayments = await prisma.payment.findMany({
    where: { societyId: auth.societyId, period: month.period, status: "RECORDED" },
    include: { allocations: true },
  });
  const openMonthPaymentsActive = openMonthPayments.filter((payment) => activeMemberIds.has(payment.memberId));
  const openMonthPaidByMember = paidByMember(openMonthPaymentsActive);
  const openMonthPaidRows = [...openMonthPaidByMember.values()];
  const monthCollected = {
    total: sumMoney(openMonthPaymentsActive.map((payment) => str(payment.amount))),
    share: sumMoney(openMonthPaidRows.map((row) => row.sharePaid)),
    interest: sumMoney(
      openMonthPaidRows.map((row) => sumMoney([row.previousInterestPaid, row.currentInterestPaid])),
    ),
    principal: sumMoney(openMonthPaidRows.map((row) => row.principalPaid)),
    penalty: sumMoney(openMonthPaidRows.map((row) => row.penaltyPaid)),
  };
  const memberCapital = memberCapitalFromOpenBooks(statements, monthCollected.share);
  const loansOutstanding = sumMoney(
    loans
      .filter((loan) => loan.member.status === "ACTIVE" && money(str(loan.outstandingPrincipal)).greaterThan(0))
      .map((loan) => str(loan.outstandingPrincipal)),
  );
  const cashBreakdown = societyCashFromComponents({
    memberCapital,
    loansOutstanding,
    interestAvailable: poolDetail.available,
    penaltyAvailable: poolDetail.penaltyAvailable,
  });
  const series = months.map((row) => {
    let statementRows = allStatements.filter((statement) => statement.period === row.period);
    statementRows = statementRows.filter((statement) => memberOnSheetInPeriod(statement.member, row.period));
    if (row.status === "OPEN") statementRows = statementRows.filter((statement) => activeMemberIds.has(statement.memberId));
    const periodEvents = events.filter((event) => event.period === row.period);
    const periodLoans = ledger.filter((entry) => entry.period === row.period);
    const penaltyAssessed = sumMoney(statementRows.map((statement) => str(statement.penalty)));
    const penaltyCollected = penaltyCollectedInPeriod(ledger, row.period);
    const penaltyDistributed = sumMoney(
      distributions
        .filter((distribution) => distribution.period === row.period)
        .map((distribution) => distributionPenaltyPortion(distribution)),
    );
    const live = { penaltyAssessed, penaltyCollected, penaltyDistributed };
    const frozen = closedSeriesFromSummary(row);
    if (frozen) {
      const liveInstallment = sumMoney(statementRows.map((statement) => str(statement.totalInstallment)));
      const liveMonthlyShare = sumMoney(statementRows.map((statement) => str(statement.monthlyShare)));
      const livePrincipalDue = sumMoney(statementRows.map((statement) => str(statement.principalDue)));
      return {
        ...frozen,
        installment: liveInstallment,
        monthlyShare: liveMonthlyShare,
        principalDue: livePrincipalDue,
        penaltyAssessed: money(frozen.penaltyAssessed).greaterThan(0) ? frozen.penaltyAssessed : live.penaltyAssessed,
        penaltyCollected: money(frozen.penaltyCollected).greaterThan(0) ? frozen.penaltyCollected : live.penaltyCollected,
        penaltyDistributed: money(frozen.penaltyDistributed).greaterThan(0) ? frozen.penaltyDistributed : live.penaltyDistributed,
      };
    }
    return {
      period: row.period,
      label: monthLabel(row.period),
      interestAccrued: sumInterestAccrualEvents(
        periodEvents.map((event) => ({
          kind: event.kind,
          memberId: event.memberId,
          period: event.period,
          amount: str(event.amount),
          reason: event.reason,
          createdAt: event.createdAt,
        })),
      ),
      interestCollected: sumMoney(periodEvents.filter((event) => event.kind === "COLLECTION").map((event) => str(event.amount))),
      interestDistributed: sumMoney(
        distributions.filter((distribution) => distribution.period === row.period).map((distribution) => str(distribution.totalDistributed)),
      ),
      ...live,
      installment: sumMoney(statementRows.map((statement) => str(statement.totalInstallment))),
      monthlyShare: sumMoney(statementRows.map((statement) => str(statement.monthlyShare))),
      principalDue: sumMoney(statementRows.map((statement) => str(statement.principalDue))),
      disbursed: sumMoney(periodLoans.filter((entry) => entry.type === "LOAN_DISBURSEMENT" && entry.cashEffect === "OUT").map((entry) => str(entry.amount))),
      principalRecovered: netLedgerByType(
        periodLoans.map((entry) => ({ type: entry.type, cashEffect: entry.cashEffect, credit: str(entry.credit), debit: str(entry.debit) })),
        "PRINCIPAL_REPAYMENT",
      ),
    };
  });
  const dues = await Promise.all(statements.map((row) => duesFor(auth.societyId, row.memberId, month.period)));
  const importedRegister = Boolean(
    await prisma.auditLog.findFirst({
      where: { societyId: auth.societyId, action: "Imported register" },
      select: { id: true },
    }),
  );
  return {
    society: societyView(society),
    period: month.period,
    month: monthLabel(month.period),
    members: { total: members.length, active: members.filter((member) => member.status === "ACTIVE").length },
    canAddMembers: closedPeriods.length === 0 && !importedRegister,
    importedRegister,
    shares: memberCapital,
    loansOutstanding,
    interest: {
      ...pool,
      available: poolDetail.available,
      combinedAvailable: poolDetail.combinedAvailable,
      penaltyCollected: poolDetail.penaltyCollected,
      penaltyDistributed: poolDetail.penaltyDistributed,
      penaltyAvailable: poolDetail.penaltyAvailable,
    },
    penaltyCollected: netLedgerByType(
      ledger.map((row) => ({ type: row.type, cashEffect: row.cashEffect, credit: str(row.credit), debit: str(row.debit) })),
      "PENALTY_COLLECTION",
    ),
    societyCash: cashBreakdown.total,
    societyCashBreakdown: cashBreakdown,
    societyCashLedger,
    monthCollected,
    installment: {
      monthlyShare: sumMoney(statements.map((row) => str(row.monthlyShare))),
      previousInterest: sumMoney(statements.map((row) => str(row.previousInterest))),
      currentInterest: sumMoney(statements.map((row) => str(row.currentInterest))),
      principal: sumMoney(statements.map((row) => str(row.principalDue))),
      penalty: sumMoney(statements.map((row) => str(row.penalty))),
      total: sumMoney(statements.map((row) => str(row.totalInstallment))),
      stillDue: sumMoney(dues.map((row) => row.totalDue)),
    },
    series,
    distributions: distributions.map((row) => ({
      id: row.id,
      code: row.code,
      period: row.period,
      month: monthLabel(row.period),
      totalDistributed: str(row.totalDistributed),
      remaining: str(row.remaining),
      status: row.status,
      confirmedAt: row.confirmedAt,
    })),
  };
}

export async function listMembers(auth: AuthUser) {
  if (auth.role === "MEMBER") {
    return prisma.member.findMany({ where: { id: auth.memberId ?? "none", societyId: auth.societyId } }).then((rows) => serializeMembers(auth, rows));
  }
  try {
    await ensureOpenStatements(auth);
  } catch {
    // Collect and Members still open even if a month-heal cannot finish.
  }
  const rows = await prisma.member.findMany({ where: { societyId: auth.societyId }, orderBy: { memberNumber: "asc" } });
  return serializeMembers(auth, rows);
}

/** Every loan given, newest first — top-ups stay as their own row with the date they were given. */
export async function loanHistory(auth: AuthUser, options?: { year?: string; period?: string }) {
  const rows = await prisma.loanTransaction.findMany({
    where: { societyId: auth.societyId, type: "DISBURSEMENT" },
    include: { loan: { include: { member: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  const all = rows.map((row) => ({
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    period: row.period,
    month: monthLabel(row.period),
    member: row.loan.member.name,
    amount: str(row.amount),
    opening: row.reference.startsWith("IMPORT-LOAN"),
    reason: row.reason,
  }));
  const years = [...new Set(all.map((row) => row.period.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const periods = [...new Set(all.map((row) => row.period))].sort((a, b) => b.localeCompare(a));
  let filtered = all;
  if (options?.period) filtered = all.filter((row) => row.period === options.period);
  else if (options?.year) filtered = all.filter((row) => row.period.startsWith(`${options.year}-`));
  return { years, periods, rows: filtered };
}

async function serializeMembers(auth: AuthUser, rows: Awaited<ReturnType<typeof prisma.member.findMany>>) {
  const month = await prisma.accountingMonth.findFirst({ where: { societyId: auth.societyId, status: "OPEN" } });
  const statements = month
    ? await prisma.memberMonth.findMany({ where: { societyId: auth.societyId, period: month.period } })
    : [];
  const logins = await prisma.user.findMany({
    where: { memberId: { in: rows.map((row) => row.id) } },
    select: { memberId: true, username: true },
  });
  const paidOpenMonth = month
    ? new Set(
        (
          await prisma.payment.findMany({
            where: { societyId: auth.societyId, period: month.period, status: "RECORDED", memberId: { in: rows.map((row) => row.id) } },
            select: { memberId: true },
          })
        ).map((row) => row.memberId),
      )
    : new Set<string>();
  const result = [];
  for (const member of rows) {
    const statement = statements.find((row) => row.memberId === member.id);
    const due = statement && month ? await duesFor(auth.societyId, member.id, month.period) : null;
    result.push({
      id: member.id,
      memberNumber: member.memberNumber,
      name: member.name,
      nameLatin: member.nameLatin,
      username: logins.find((row) => row.memberId === member.id)?.username ?? "",
      mobile: member.mobile,
      status: member.status,
      monthlyShare: str(member.monthlyShare),
      shareBalance: inactiveMemberMoneyDisplay(
        member.status,
        statement ? str(statement.closingShares) : str(member.shareBalance),
      ),
      loanOutstanding: inactiveMemberMoneyDisplay(member.status, str(member.loanOutstanding)),
      interestBalance: inactiveMemberMoneyDisplay(member.status, str(member.interestBalance)),
      interestEarned: inactiveMemberMoneyDisplay(member.status, str(member.interestEarned)),
      currentInterest: statement ? str(statement.currentInterest) : "0.00",
      shareDue: due?.shareLeft ?? "0.00",
      interestDue: due?.dues.CURRENT_INTEREST ?? "0.00",
      previousPending: due ? sumMoney([due.dues.PREVIOUS_INTEREST, due.arrearsLeft]) : "0.00",
      penaltyDue: due?.dues.PENALTY ?? "0.00",
      totalDue: due?.totalDue ?? "0.00",
      principalDue: due?.dues.PRINCIPAL ?? "0.00",
      scheduledPrincipal: statement ? str(statement.principalDue) : "0.00",
      collectedThisOpenMonth: month ? paidOpenMonth.has(member.id) : false,
    });
  }
  return result;
}

function memberHistoryRows(
  statements: {
    period: string;
    closingShares: Prisma.Decimal;
    openingPrincipal: Prisma.Decimal;
    currentInterest: Prisma.Decimal;
    previousInterest: Prisma.Decimal;
    monthlyShare: Prisma.Decimal;
    shareCashPending: Prisma.Decimal;
    principalDue: Prisma.Decimal;
    penalty: Prisma.Decimal;
    arrearsCash: Prisma.Decimal;
    totalInstallment: Prisma.Decimal;
    interestCollected: Prisma.Decimal;
    interestOutstanding: Prisma.Decimal;
  }[],
  payments: { period: string; amount: Prisma.Decimal }[],
  extraPeriods: string[],
  due: { totalDue: string } | null,
  openPeriod: string | null,
  poolShareByPeriod: Map<string, string>,
) {
  const periods = [...new Set([
    ...statements.map((row) => row.period),
    ...payments.map((row) => row.period),
    ...extraPeriods,
  ].filter((period) => /^\d{4}-\d{2}$/.test(period)))].sort();
  let lastShares = "0.00";
  let lastLoan = "0.00";
  const rows = periods.map((period) => {
    const row = statements.find((entry) => entry.period === period);
    const received = sumMoney(payments.filter((payment) => payment.period === period).map((payment) => str(payment.amount)));
    if (row) {
      lastShares = str(row.closingShares);
      lastLoan = str(row.openingPrincipal);
      const shareDue = shareDueOnBooks(str(row.shareCashPending), str(row.arrearsCash));
      const installment = sheetInstallmentTotal(str(row.totalInstallment), str(row.monthlyShare), shareDue);
      const leftover = subtractMoney(installment, received);
      const stillDue = due && openPeriod === period ? due.totalDue : money(leftover).isNegative() ? "0.00" : leftover;
      return {
        period,
        label: monthLabel(period),
        shares: lastShares,
        poolShareDistributed: poolShareByPeriod.get(period) ?? "0.00",
        loan: lastLoan,
        interest: str(row.currentInterest),
        previousInterest: str(row.previousInterest),
        monthlyShare: shareOnSheet(str(row.monthlyShare), shareDue),
        principal: str(row.principalDue),
        penalty: str(row.penalty),
        arrears: str(row.arrearsCash),
        total: installment,
        received,
        stillDue,
        interestCollected: str(row.interestCollected),
        interestOutstanding: str(row.interestOutstanding),
      };
    }
    return {
      period,
      label: monthLabel(period),
      shares: lastShares,
      poolShareDistributed: poolShareByPeriod.get(period) ?? "0.00",
      loan: lastLoan,
      interest: "0.00",
      previousInterest: "0.00",
      monthlyShare: "0.00",
      principal: "0.00",
      penalty: "0.00",
      arrears: "0.00",
      total: "0.00",
      received,
      stillDue: "0.00",
      interestCollected: "0.00",
      interestOutstanding: "0.00",
    };
  });
  return rows.map((row, index) => ({
    ...row,
    previousDue: index === 0 ? "0.00" : rows[index - 1]!.stillDue,
  }));
}

function memberHistoryTotals(rows: ReturnType<typeof memberHistoryRows>) {
  const last = rows.at(-1);
  return {
    shares: last?.shares ?? "0.00",
    poolShareDistributed: sumMoney(rows.map((row) => row.poolShareDistributed)),
    loan: last?.loan ?? "0.00",
    monthlyShare: sumMoney(rows.map((row) => row.monthlyShare)),
    previousInterest: sumMoney(rows.map((row) => row.previousInterest)),
    interest: sumMoney(rows.map((row) => row.interest)),
    principal: sumMoney(rows.map((row) => row.principal)),
    penalty: sumMoney(rows.map((row) => row.penalty)),
    previousDue: sumMoney(rows.map((row) => row.previousDue)),
    total: sumMoney(rows.map((row) => row.total)),
    received: sumMoney(rows.map((row) => row.received)),
    stillDue: last?.stillDue ?? "0.00",
  };
}

/** Rows for PDF/Excel on “My month report” — same columns as the member history table. */
export function memberTimelineReportRows(
  timeline: ReturnType<typeof memberHistoryRows>,
  totals: ReturnType<typeof memberHistoryTotals>,
) {
  const body = timeline.map((row) => ({
    label: row.label,
    shares: row.shares,
    poolShareDistributed: row.poolShareDistributed,
    loan: row.loan,
    previousDue: row.previousDue,
    monthlyShare: row.monthlyShare,
    previousInterest: row.previousInterest,
    interest: row.interest,
    principal: row.principal,
    penalty: row.penalty,
    total: row.total,
    received: row.received,
    stillDue: row.stillDue,
  }));
  return [
    ...body,
    {
      label: "Total",
      shares: totals.shares,
      poolShareDistributed: totals.poolShareDistributed,
      loan: totals.loan,
      previousDue: totals.previousDue,
      monthlyShare: totals.monthlyShare,
      previousInterest: totals.previousInterest,
      interest: totals.interest,
      principal: totals.principal,
      penalty: totals.penalty,
      total: totals.total,
      received: totals.received,
      stillDue: totals.stillDue,
    },
  ];
}

export async function memberStatement(auth: AuthUser, memberId: string) {
  assertOwnMember(auth, memberId);
  try {
    await ensureOpenStatements(auth);
  } catch {
    // A member statement still opens if a month-heal cannot finish.
  }
  const member = await prisma.member.findFirst({ where: { id: memberId, societyId: auth.societyId } });
  if (!member) throw new HttpError(404, "Member not found");
  const society = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  if (member.status === "INACTIVE") {
    const emptyTimeline: ReturnType<typeof memberHistoryRows> = [];
    return {
      society: societyView(society),
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        name: member.name,
        nameLatin: member.nameLatin,
        username: (await prisma.user.findFirst({ where: { memberId: member.id }, select: { username: true } }))?.username ?? "",
        mobile: member.mobile,
        email: member.email,
        address: member.address,
        status: member.status,
        joiningDate: member.joiningDate,
        monthlyShare: str(member.monthlyShare),
        shareBalance: "0.00",
        interestEarned: "0.00",
        interestWithdrawn: "0.00",
        interestBalance: "0.00",
        loanOutstanding: "0.00",
      },
      openPeriod: null,
      due: null,
      historyAvailable: false,
      timeline: emptyTimeline,
      timelineTotals: memberHistoryTotals(emptyTimeline),
      loans: [],
      payments: [],
      interestSummary: {
        earned: "0.00",
        withdrawn: "0.00",
        addedToShares: "0.00",
        paidInCash: "0.00",
        withdrawableBalance: "0.00",
      },
      interestHistory: [],
      ledger: [],
    };
  }
  const periodVisible = (period: string) => memberHistoryIncludesPeriod(member, period);
  const [monthsAll, books] = await Promise.all([
    prisma.memberMonth.findMany({ where: { societyId: auth.societyId, memberId }, orderBy: { period: "asc" } }),
    prisma.accountingMonth.findMany({ where: { societyId: auth.societyId }, orderBy: { period: "asc" } }),
  ]);
  const months = monthsAll.filter((row) => periodVisible(row.period));
  const open = books.find((row) => row.status === "OPEN") ?? await prisma.accountingMonth.findFirst({ where: { societyId: auth.societyId, status: "OPEN" } });
  const latest = months.at(-1);
  const due = latest && open && latest.period === open.period ? await duesFor(auth.societyId, memberId, open.period) : null;
  const loans = await prisma.loan.findMany({
    where: { societyId: auth.societyId, memberId },
    include: { transactions: { orderBy: { date: "asc" } } },
  });
  const payments = (
    await prisma.payment.findMany({
      where: { societyId: auth.societyId, memberId, status: "RECORDED" },
      include: { allocations: true },
      orderBy: { paidOn: "desc" },
    })
  ).filter((row) => periodVisible(row.period));
  const ledger = (
    await prisma.ledgerEntry.findMany({
      where: { societyId: auth.societyId, memberId },
      orderBy: { date: "asc" },
    })
  ).filter((row) => periodVisible(row.period));
  const credits = (
    await prisma.interestDistributionEntry.findMany({
      where: { memberId, distribution: { societyId: auth.societyId, status: "CONFIRMED" } },
      include: { distribution: true },
      orderBy: { distribution: { period: "desc" } },
    })
  ).filter((row) => periodVisible(row.distribution.period));
  const distributionPayoutMode = (entry: { payoutMethod: string; status: string }) => {
    if (entry.payoutMethod === "CASH" || entry.status === "PAID_CASH") return "CASH" as const;
    return "SHARES" as const;
  };
  const interestAddedToShares = sumMoney(
    credits.filter((row) => distributionPayoutMode(row) === "SHARES").map((row) => str(row.amount)),
  );
  const interestPaidInCash = sumMoney(
    credits.filter((row) => distributionPayoutMode(row) === "CASH").map((row) => str(row.amount)),
  );
  const poolShareByPeriod = await poolShareDistributedByPeriodForMember(auth.societyId, memberId);
  const extraPeriods = [
    ...ledger.map((row) => row.period),
    ...credits.map((row) => row.distribution.period),
    ...loans.flatMap((loan) => loan.transactions.map((row) => row.period)),
  ].filter((p) => periodVisible(p));
  const timeline = memberHistoryRows(
    months,
    payments,
    extraPeriods,
    due,
    open?.period ?? null,
    poolShareByPeriod,
  );
  return {
    society: societyView(society),
    member: {
      id: member.id,
      memberNumber: member.memberNumber,
      name: member.name,
      nameLatin: member.nameLatin,
      username: (await prisma.user.findFirst({ where: { memberId: member.id }, select: { username: true } }))?.username ?? "",
      mobile: member.mobile,
      email: member.email,
      address: member.address,
      status: member.status,
      joiningDate: member.joiningDate,
      monthlyShare: str(member.monthlyShare),
      shareBalance: inactiveMemberMoneyDisplay(
        member.status,
        latest ? str(latest.closingShares) : str(member.shareBalance),
      ),
      interestEarned: inactiveMemberMoneyDisplay(member.status, str(member.interestEarned)),
      interestWithdrawn: inactiveMemberMoneyDisplay(member.status, str(member.interestWithdrawn)),
      interestBalance: inactiveMemberMoneyDisplay(member.status, str(member.interestBalance)),
      loanOutstanding: inactiveMemberMoneyDisplay(member.status, str(member.loanOutstanding)),
    },
    openPeriod: open?.period ?? null,
    due: due
      ? {
          period: open!.period,
          assessed: due.assessed,
          totalDue: due.totalDue,
          dues: due.dues,
          paid: due.paid,
          currentInterest: str(due.statement.currentInterest),
          previousInterest: str(due.statement.previousInterest),
        }
      : null,
    historyAvailable: true,
    timeline,
    timelineTotals: memberHistoryTotals(timeline),
    loans: loans.map((loan) => ({
      id: loan.id,
      originalPrincipal: str(loan.originalPrincipal),
      outstandingPrincipal: str(loan.outstandingPrincipal),
      scheduledPrincipal: str(loan.scheduledPrincipal),
      interestRate: loan.interestRate.toString(),
      interestType: loan.interestType,
      status: loan.status,
      purpose: loan.purpose,
      notes: loan.notes,
      loanDate: loan.loanDate,
      transactions: loan.transactions.map((row) => ({
        id: row.id,
        date: row.date,
        type: row.type,
        amount: str(row.amount),
        balanceAfter: str(row.balanceAfter),
        reason: row.reason,
      })),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      receiptNo: payment.receiptNo,
      amount: str(payment.amount),
      paidOn: payment.paidOn,
      period: payment.period,
      status: payment.status,
      note: payment.note,
      allocations: payment.allocations.map((row) => ({ component: row.component, amount: str(row.amount) })),
    })),
    interestSummary: {
      earned: str(member.interestEarned),
      withdrawn: str(member.interestWithdrawn),
      addedToShares: interestAddedToShares,
      paidInCash: interestPaidInCash,
      withdrawableBalance: str(member.interestBalance),
    },
    interestHistory: credits.map((row) => {
      const mode = distributionPayoutMode(row);
      return {
        period: row.distribution.period,
        label: monthLabel(row.distribution.period),
        amount: str(row.amount),
        mode,
        payoutLabel: mode === "CASH" ? "Cash" : "Share",
        status: row.status,
        code: row.distribution.code,
        confirmedAt: row.distribution.confirmedAt,
      };
    }),
    ledger: ledger.map((row) => ({
      id: row.id,
      date: row.date,
      period: row.period,
      type: row.type,
      debit: str(row.debit),
      credit: str(row.credit),
      amount: str(row.amount),
      cashEffect: row.cashEffect,
      reference: row.reference,
      reason: row.reason,
    })),
  };
}

export async function whatsAppDraft(auth: AuthUser, memberId: string, kind: string) {
  assertOwnMember(auth, memberId);
  const statement = await memberStatement(auth, memberId);
  const month = statement.openPeriod ? monthLabel(statement.openPeriod) : "this month";
  const due = statement.due?.totalDue ?? "0.00";
  const loan = statement.member.loanOutstanding;
  const name = statement.member.name;
  if (kind === "reminder") {
    return {
      text: `Hello ${name},\n\nYour society payment for ${month} is ${formatINR(due)}.\n\nOutstanding loan: ${formatINR(loan)}.\n\nPlease make the payment before the due date.`,
    };
  }
  if (kind === "distribution") {
    const latest = [...statement.interestHistory].reverse().find((row) => row.status === "CREDITED");
    return {
      text: `Hello ${name},\n\nYour interest + penalty pool share${latest ? ` for ${latest.label} is ${formatINR(latest.amount)} (${latest.payoutLabel ?? "Share"})` : " will appear after the society distributes the pool"}.\n\nTotal earned from the pool: ${formatINR(statement.member.interestEarned)}.`,
    };
  }
  if (kind === "receipt") {
    const payment = statement.payments[0];
    return {
      text: payment
        ? `Hello ${name},\n\nReceipt ${payment.receiptNo} for ${formatINR(payment.amount)} was recorded on ${payment.paidOn.toISOString().slice(0, 10)}.`
        : `Hello ${name},\n\nNo receipt has been recorded yet.`,
    };
  }
  return {
    text: `Hello ${name},\n\n${month} statement\nShares: ${formatINR(statement.member.shareBalance)}\nLoan: ${formatINR(loan)}\nThis month due: ${formatINR(due)}\nInterest balance: ${formatINR(statement.member.interestBalance)}`,
  };
}

type MonthSheetBundle = {
  period: string;
  month: string;
  periods: string[];
  statements: (Prisma.MemberMonthGetPayload<{ include: { member: true } }>)[];
  payments: (Prisma.PaymentGetPayload<{ include: { allocations: true } }>)[];
  loansGiven: { number: number; member: string; date: string; amount: string }[];
};

export type MonthSheetLoadOptions = { /** Include inactive members when the month is still open (month-close snapshot). */ snapshot?: boolean };

async function loadMonthSheetBundle(auth: AuthUser, period?: string, options?: MonthSheetLoadOptions): Promise<MonthSheetBundle> {
  try {
    await relocateNextMonthPenalties(auth.societyId);
  } catch {
    // Penalty relocation must not block printing a month sheet.
  }
  const months = await prisma.accountingMonth.findMany({ where: { societyId: auth.societyId }, orderBy: { period: "asc" } });
  const chosen = months.find((row) => row.period === period) ?? months.find((row) => row.status === "OPEN") ?? months.at(-1);
  if (!chosen) throw new HttpError(404, "No month is open");
  if (chosen.status === "OPEN" && !options?.snapshot) {
    try {
      await ensureOpenStatements(auth);
    } catch {
      // A closed month still prints from its saved sheet if the open month cannot heal.
    }
  }
  const statementsAll = await prisma.memberMonth.findMany({
    where: { societyId: auth.societyId, period: chosen.period },
    include: { member: true },
    orderBy: { member: { memberNumber: "asc" } },
  });
  const paymentsAll = await prisma.payment.findMany({
    where: { societyId: auth.societyId, period: chosen.period, status: "RECORDED" },
    include: { allocations: true },
  });
  const liveOpenSheet = chosen.status === "OPEN" && !options?.snapshot;
  const statements = liveOpenSheet
    ? statementsAll.filter((row) => row.member.status === "ACTIVE")
    : statementsAll.filter((row) => memberOnSheetInPeriod(row.member, chosen.period));
  const statementIds = new Set(statements.map((row) => row.memberId));
  const payments = paymentsAll.filter((payment) => statementIds.has(payment.memberId));
  const given = await prisma.loanTransaction.findMany({
    where: {
      societyId: auth.societyId,
      period: chosen.period,
      type: "DISBURSEMENT",
      NOT: { reference: { startsWith: "IMPORT-LOAN" } },
    },
    include: { loan: { include: { member: true } } },
    orderBy: { date: "asc" },
  });
  const loansGiven = given.map((row, index) => ({
    number: index + 1,
    member: row.loan.member.name,
    date: row.date.toISOString().slice(0, 10),
    amount: str(row.amount),
  }));
  return {
    period: chosen.period,
    month: monthLabel(chosen.period),
    periods: months.map((row) => row.period),
    statements,
    payments,
    loansGiven,
  };
}

function installmentDueColumns(row: MonthSheetBundle["statements"][number]) {
  const shareDue = shareDueOnBooks(str(row.shareCashPending), str(row.arrearsCash));
  const share = shareOnSheet(str(row.monthlyShare), shareDue);
  const installment = sheetInstallmentTotal(str(row.totalInstallment), str(row.monthlyShare), shareDue);
  return {
    monthlyShare: share,
    previousInterest: str(row.previousInterest),
    currentInterest: str(row.currentInterest),
    principal: str(row.principalDue),
    penalty: str(row.penalty),
    total: installment,
  };
}

function paidByMember(payments: MonthSheetBundle["payments"]) {
  const empty = () => ({
    sharePaid: "0.00",
    previousInterestPaid: "0.00",
    currentInterestPaid: "0.00",
    principalPaid: "0.00",
    penaltyPaid: "0.00",
    totalReceived: "0.00",
  });
  const map = new Map<string, ReturnType<typeof empty>>();
  for (const payment of payments) {
    const current = map.get(payment.memberId) ?? empty();
    for (const row of payment.allocations) {
      const amount = str(row.amount);
      if (row.component === "SHARE") current.sharePaid = sumMoney([current.sharePaid, amount]);
      if (row.component === "PREVIOUS_INTEREST") current.previousInterestPaid = sumMoney([current.previousInterestPaid, amount]);
      if (row.component === "CURRENT_INTEREST") current.currentInterestPaid = sumMoney([current.currentInterestPaid, amount]);
      if (row.component === "PRINCIPAL") current.principalPaid = sumMoney([current.principalPaid, amount]);
      if (row.component === "PENALTY") current.penaltyPaid = sumMoney([current.penaltyPaid, amount]);
    }
    current.totalReceived = sumMoney([current.totalReceived, str(payment.amount)]);
    map.set(payment.memberId, current);
  }
  return map;
}

/** Per-month pool-to-shares credits for one member (DIST- share lines). */
async function poolShareDistributedByPeriodForMember(societyId: string, memberId: string) {
  const rows = await prisma.shareTransaction.findMany({
    where: { societyId, memberId, reference: { startsWith: "DIST-" } },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.period, sumMoney([map.get(row.period) ?? "0.00", str(row.cashEffect)]));
  }
  return map;
}

/** Interest + penalty pool credited to shares this month (DIST- share lines). */
async function poolShareDistributedByMember(societyId: string, period: string, memberIds: string[]) {
  if (memberIds.length === 0) return new Map<string, string>();
  const rows = await prisma.shareTransaction.findMany({
    where: {
      societyId,
      period,
      memberId: { in: memberIds },
      reference: { startsWith: "DIST-" },
    },
  });
  const map = new Map(memberIds.map((id) => [id, "0.00"]));
  for (const row of rows) {
    map.set(row.memberId, sumMoney([map.get(row.memberId) ?? "0.00", str(row.cashEffect)]));
  }
  return map;
}

/** What each member should pay this month (installment due). No receipts on this sheet. */
export async function monthSheet(auth: AuthUser, period?: string, options?: MonthSheetLoadOptions) {
  const frozen = await frozenMonthSheetReport(auth.societyId, period, "due", options);
  if (frozen) return frozen;
  const bundle = await loadMonthSheetBundle(auth, period, options);
  const memberIds = bundle.statements.map((row) => row.memberId);
  const poolShareByMember = await poolShareDistributedByMember(auth.societyId, bundle.period, memberIds);
  const rows = bundle.statements.map((row) => {
    const due = installmentDueColumns(row);
    return {
      number: row.member.memberNumber,
      member: row.member.name,
      shares: sheetSharesColumn(row),
      poolShareDistributed: poolShareByMember.get(row.memberId) ?? "0.00",
      loan: sheetLoanColumn(row),
      ...due,
    };
  });
  return {
    period: bundle.period,
    month: bundle.month,
    periods: bundle.periods,
    kind: "due" as const,
    rows,
    totals: {
      shares: sumMoney(rows.map((row) => row.shares)),
      poolShareDistributed: sumMoney(rows.map((row) => row.poolShareDistributed)),
      loan: sumMoney(rows.map((row) => row.loan)),
      monthlyShare: sumMoney(rows.map((row) => row.monthlyShare)),
      previousInterest: sumMoney(rows.map((row) => row.previousInterest)),
      currentInterest: sumMoney(rows.map((row) => row.currentInterest)),
      principal: sumMoney(rows.map((row) => row.principal)),
      penalty: sumMoney(rows.map((row) => row.penalty)),
      total: sumMoney(rows.map((row) => row.total)),
    },
  };
}

/** What was collected from each member this month, split by share, interest, principal, and penalty. */
export async function monthSheetCollected(auth: AuthUser, period?: string, options?: MonthSheetLoadOptions) {
  const frozen = await frozenMonthSheetReport(auth.societyId, period, "collected", options);
  if (frozen) return frozen;
  const bundle = await loadMonthSheetBundle(auth, period, options);
  const paid = paidByMember(bundle.payments);
  const memberIds = bundle.statements.map((row) => row.memberId);
  const poolShareByMember = await poolShareDistributedByMember(auth.societyId, bundle.period, memberIds);
  const rows = bundle.statements.map((row) => {
    const due = installmentDueColumns(row);
    const p =
      paid.get(row.memberId) ?? {
        sharePaid: "0.00",
        previousInterestPaid: "0.00",
        currentInterestPaid: "0.00",
        principalPaid: "0.00",
        penaltyPaid: "0.00",
        totalReceived: "0.00",
      };
    return {
      number: row.member.memberNumber,
      member: row.member.name,
      shares: sheetSharesColumn(row),
      poolShareDistributed: poolShareByMember.get(row.memberId) ?? "0.00",
      loan: sheetLoanColumn(row),
      monthlyShare: due.monthlyShare,
      previousInterest: due.previousInterest,
      currentInterest: due.currentInterest,
      principal: due.principal,
      penalty: due.penalty,
      sharePaid: p.sharePaid,
      previousInterestPaid: p.previousInterestPaid,
      currentInterestPaid: p.currentInterestPaid,
      principalPaid: p.principalPaid,
      penaltyPaid: p.penaltyPaid,
      total: due.total,
      totalReceived: p.totalReceived,
    };
  });
  return {
    period: bundle.period,
    month: bundle.month,
    periods: bundle.periods,
    kind: "collected" as const,
    rows,
    loansGiven: bundle.loansGiven,
    totals: {
      shares: sumMoney(rows.map((row) => row.shares)),
      poolShareDistributed: sumMoney(rows.map((row) => row.poolShareDistributed)),
      loan: sumMoney(rows.map((row) => row.loan)),
      monthlyShare: sumMoney(rows.map((row) => row.monthlyShare)),
      previousInterest: sumMoney(rows.map((row) => row.previousInterest)),
      currentInterest: sumMoney(rows.map((row) => row.currentInterest)),
      principal: sumMoney(rows.map((row) => row.principal)),
      penalty: sumMoney(rows.map((row) => row.penalty)),
      total: sumMoney(rows.map((row) => row.total)),
      sharePaid: sumMoney(rows.map((row) => row.sharePaid)),
      previousInterestPaid: sumMoney(rows.map((row) => row.previousInterestPaid)),
      currentInterestPaid: sumMoney(rows.map((row) => row.currentInterestPaid)),
      principalPaid: sumMoney(rows.map((row) => row.principalPaid)),
      penaltyPaid: sumMoney(rows.map((row) => row.penaltyPaid)),
      totalReceived: sumMoney(rows.map((row) => row.totalReceived)),
      loansGiven: sumMoney(bundle.loansGiven.map((row) => row.amount)),
    },
  };
}

function validReportPeriod(period?: string) {
  return period && /^\d{4}-\d{2}$/.test(period) ? period : undefined;
}

/** Reports that list rows with a `period` field — optional filter; no period returns every month. */
function filterRowsByPeriod<T extends { period?: string }>(rows: T[], period?: string) {
  const chosen = validReportPeriod(period);
  if (!chosen) return rows;
  return rows.filter((row) => row.period === chosen);
}

export async function reportData(auth: AuthUser, type: string, period?: string) {
  const societyId = auth.societyId;
  const month = validReportPeriod(period);
  if (type === "loans") {
    const loans = await prisma.loan.findMany({ where: { societyId }, include: { member: true }, orderBy: { outstandingPrincipal: "desc" } });
    return loans.map((loan) => ({
      member: loan.member.name,
      status: loan.status,
      original: str(loan.originalPrincipal),
      outstanding: str(loan.outstandingPrincipal),
      scheduledPrincipal: str(loan.scheduledPrincipal),
      rate: str(loan.interestRate),
    }));
  }
  if (type === "interest-accrued" || type === "interest-collected") {
    const kind = type === "interest-accrued" ? "ACCRUAL" : "COLLECTION";
    const rows = await prisma.interestEvent.findMany({
      where: { societyId, kind, ...(month ? { period: month } : {}) },
      include: { member: true },
      orderBy: [{ period: "asc" }, { member: { memberNumber: "asc" } }],
    });
    return rows.map((row) => ({ period: row.period, member: row.member.name, amount: str(row.amount), reason: row.reason }));
  }
  if (type === "interest-distribution") {
    const rows = await prisma.interestDistribution.findMany({
      where: { societyId, ...(month ? { period: month } : {}) },
      include: { entries: { include: { member: true } } },
      orderBy: { period: "asc" },
    });
    return rows.flatMap((row) =>
      row.entries.map((entry) => ({
        code: row.code,
        period: row.period,
        status: row.status,
        member: entry.member.name,
        amount: str(entry.amount),
        remaining: str(row.remaining),
      })),
    );
  }
  if (type === "penalties") {
    await relocateNextMonthPenalties(societyId);
    const rows = await prisma.penalty.findMany({
      where: { societyId, ...(month ? { period: month } : {}) },
      include: { member: true },
      orderBy: [{ period: "asc" }],
    });
    return rows.map((row) => ({
      period: row.period,
      member: row.member.name,
      assessed: str(row.amount),
      collected: str(row.collectedAmount),
      source: row.source === "NEXT_MONTH" ? "Next month" : row.source,
      reason: row.reason,
    }));
  }
  if (type === "contributions") {
    const rows = await prisma.shareTransaction.findMany({
      where: { societyId, ...(month ? { period: month } : {}) },
      include: { member: true },
      orderBy: { date: "asc" },
    });
    return rows.map((row) => {
      const cash = str(row.cashEffect);
      return {
        date: row.date.toISOString().slice(0, 10),
        period: row.period,
        member: row.member.name,
        received: money(cash).greaterThan(0) ? cash : "0.00",
        shareBooked: str(row.amount),
        cash,
        reason: row.reason,
      };
    });
  }
  if (type === "ledger" || type === "society-balance") {
    const rows = await prisma.ledgerEntry.findMany({ where: { societyId }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] });
    const byReference = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byReference.get(row.reference) ?? [];
      list.push(row);
      byReference.set(row.reference, list);
    }
    const cancelled = new Set<string>();
    for (const list of byReference.values()) {
      const cashIn = sumMoney(list.filter((row) => row.cashEffect === "IN").map((row) => str(row.credit)));
      const cashOut = sumMoney(list.filter((row) => row.cashEffect === "OUT").map((row) => str(row.debit)));
      if (money(cashIn).greaterThan(0) && cashIn === cashOut) {
        for (const row of list) {
          if (row.cashEffect === "IN" || row.cashEffect === "OUT") cancelled.add(row.id);
        }
      }
    }
    let running = "0.00";
    const ledgerRows = rows.filter((row) => !cancelled.has(row.id)).map((row) => {
      if (row.cashEffect === "IN") running = sumMoney([running, str(row.credit)]);
      if (row.cashEffect === "OUT") running = subtractMoney(running, str(row.debit));
      return {
        period: row.period,
        date: row.date.toISOString().slice(0, 10),
        type: row.type,
        debit: str(row.debit),
        credit: str(row.credit),
        cash: row.cashEffect,
        balance: running,
        reference: row.reference,
        reason: row.reason,
      };
    });
    return filterRowsByPeriod(ledgerRows, period);
  }
  if (type === "defaulters") {
    const loans = await prisma.loan.findMany({ where: { societyId, status: "OVERDUE" }, include: { member: true } });
    return loans.map((loan) => ({
      member: loan.member.name,
      outstanding: str(loan.outstandingPrincipal),
      scheduledPrincipal: str(loan.scheduledPrincipal),
      status: loan.status,
      note: "Scheduled principal was not recovered for consecutive closed months.",
    }));
  }
  if (type === "monthly" || type === "monthly-closing") {
    const dashboard = await adminDashboard(auth);
    return filterRowsByPeriod(dashboard.series, period);
  }
  if (type === "month-sheet") return monthSheet(auth, period);
  if (type === "month-collected") return monthSheetCollected(auth, period);
  throw new HttpError(404, "Unknown report");
}

export { societyView };
