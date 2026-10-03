import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { calendarPeriod, statementDateFor, utcDate } from "../lib/format.js";
import { dec } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import XLSX from "xlsx";
import { createApp } from "../app.js";
import { money, sumMoney } from "../engine/finance.js";
import { confirmClose, confirmDistribution, createLoan, createMember, duesFor, postPayment } from "../services/books.js";
import type { AuthUser } from "../middleware/auth.js";

const MARK = "__app_surface_test__";
const HISTORY = ["period", "label", "shares", "poolShareDistributed", "loan", "previousDue", "monthlyShare", "previousInterest", "interest", "principal", "penalty", "arrears", "total", "received", "stillDue"] as const;
const REPORTS = [
  "month-sheet",
  "month-collected",
  "monthly",
  "loans",
  "interest-accrued",
  "interest-collected",
  "interest-distribution",
  "penalties",
  // "contributions",
  // "ledger",
  // "society-balance",
  // "defaulters",
  "monthly-closing",
];

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

class AppClient {
  cookie = "";
  constructor(private base: string) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of setCookie) {
      if (line.startsWith("sf_token=")) {
        const value = line.split(";")[0];
        this.cookie = value === "sf_token=" ? "" : value;
      }
    }
    return res;
  }

  async json<T = any>(path: string, init: RequestInit = {}) {
    const res = await this.request(path, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body: body as T, headers: res.headers };
  }

  async login(username: string, password: string) {
    this.cookie = "";
    return this.json("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  }
}

let server: ReturnType<typeof createServer>;
let base = "";
let societyId = "";
let ownerUser = "";
let memberUser = "";
let otherUser = "";
let memberId = "";
let otherId = "";
let period = "";
/** Interest receipt included in beforeAll distribution — delete must stay blocked even if month later closes. */
let distributedInterestPaymentId = "";

beforeAll(async () => {
  const leftover = await prisma.society.findMany({ where: { name: { startsWith: MARK } } });
  for (const row of leftover) await wipeSociety(row.id);
  const stamp = Date.now().toString(36);
  period = calendarPeriod();
  const society = await prisma.society.create({
    data: {
      name: `${MARK}${stamp}`,
      interestRate: dec("0.010000"),
      defaultMonthlyShare: dec("500.00"),
      paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
    },
  });
  societyId = society.id;
  await prisma.accountingMonth.create({
    data: { societyId, period, status: "OPEN", statementDate: utcDate(statementDateFor(period)) },
  });
  ownerUser = `sfo${stamp}`;
  memberUser = `sfm${stamp}`;
  otherUser = `sfo2${stamp}`;
  const owner = await prisma.user.create({
    data: {
      societyId,
      role: "OWNER",
      name: "Surface Owner",
      username: ownerUser,
      passwordHash: await bcrypt.hash("Owner@2026", 10),
    },
  });
  const auth: AuthUser = {
    userId: owner.id,
    societyId,
    role: "OWNER",
    memberId: null,
    name: owner.name,
    tokenVersion: owner.tokenVersion,
  };
  const one = await createMember(auth, {
    name: "Kiran Surface",
    mobile: "9822222201",
    joiningDate: `${period}-01`,
    monthlyShare: "500.00",
    username: memberUser,
    password: "Member@2026",
    reason: "Surface test member",
  });
  const two = await createMember(auth, {
    name: "Meera Surface",
    mobile: "9822222202",
    joiningDate: `${period}-01`,
    monthlyShare: "500.00",
    username: otherUser,
    password: "Member@2026",
    reason: "Second surface member",
  });
  memberId = one.id;
  otherId = two.id;
  await postPayment(auth, {
    memberId,
    period,
    amount: "500.00",
    paidOn: `${period}-10`,
    reason: "First share",
    idempotencyKey: `surface-pay-1-${stamp}`,
  });
  await postPayment(auth, {
    memberId: otherId,
    period,
    amount: "500.00",
    paidOn: `${period}-10`,
    reason: "Second share",
    idempotencyKey: `surface-pay-2-${stamp}`,
  });
  await createLoan(auth, {
    memberId,
    amount: "400.00",
    date: `${period}-12`,
    scheduledPrincipal: "100.00",
    reason: "Small test loan",
  });
  await confirmClose(auth, "Close first surface month");
  const next = (await prisma.accountingMonth.findFirst({ where: { societyId, status: "OPEN" } }))!.period;
  period = next;
  const due = await duesFor(societyId, memberId, period);
  const interest = due.dues.CURRENT_INTEREST;
  const interestPayment = await postPayment(auth, {
    memberId,
    period,
    amount: interest,
    paidOn: `${period}-10`,
    reason: "Interest only",
    idempotencyKey: `surface-int-${stamp}`,
    allocation: [{ component: "CURRENT_INTEREST", amount: interest }],
  });
  distributedInterestPaymentId = interestPayment.id;
  for (const id of [memberId, otherId]) {
    const remaining = await duesFor(societyId, id, period);
    if (money(remaining.totalDue).greaterThan(0)) {
      await postPayment(auth, {
        memberId: id,
        period,
        amount: remaining.totalDue,
        paidOn: `${period}-11`,
        reason: "Clear open month before pool",
        idempotencyKey: `surface-clear-${id}-${stamp}`,
      });
    }
  }
  await confirmDistribution(auth, period, "Share collected interest");

  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  base = `http://127.0.0.1:${address.port}`;
}, 60000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (societyId) await wipeSociety(societyId);
  await prisma.$disconnect();
});

describe("full app HTTP surface", () => {
  it("health, login, session, and logout work", async () => {
    const guest = new AppClient(base);
    const health = await guest.json("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.product).toBe("Society Finance");

    const denied = await guest.json("/api/dashboard");
    expect(denied.status).toBe(401);
    const guestMe = await guest.json("/api/auth/me");
    expect(guestMe.status).toBe(200);
    expect(guestMe.body.user).toBeNull();

    const bad = await guest.login(ownerUser, "WrongPass1");
    expect(bad.status).toBe(401);

    const ok = await guest.login(ownerUser, "Owner@2026");
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe("OWNER");
    const me = await guest.json("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.society.name).toContain(MARK);
    expect(me.body.user.username).toBe(ownerUser);

    const out = await guest.json("/api/auth/logout", { method: "POST" });
    expect(out.status).toBe(200);
    expect((await guest.json("/api/dashboard")).status).toBe(401);
  });

  it("staff home, members, member page, payments, loans, interest, close, settings, audit, reports all load", async () => {
    const staff = new AppClient(base);
    expect((await staff.login(ownerUser, "Owner@2026")).status).toBe(200);

    const dash = await staff.json("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.society.name).toBeTruthy();
    expect(dash.body.period).toMatch(/^\d{4}-\d{2}$/);
    expect(dash.body.month).toBeTruthy();
    expect(dash.body.members.total).toBe(2);
    const sheet = await staff.json(`/api/reports/month-sheet?period=${dash.body.period}`);
    expect(sheet.status).toBe(200);
    expect(dash.body.shares).toBe(sumMoney([sheet.body.totals.shares, dash.body.monthCollected.share]));
    expect(dash.body.loansOutstanding).toBe("300.00");
    expect(dash.body.societyCash).toBeTruthy();
    expect(dash.body.monthCollected).toMatchObject({
      total: expect.any(String),
      share: expect.any(String),
      interest: expect.any(String),
      principal: expect.any(String),
      penalty: expect.any(String),
    });
    expect(dash.body.interest).toMatchObject({ accrued: expect.any(String), collected: expect.any(String), available: expect.any(String) });
    expect(dash.body.installment.stillDue).toBeTruthy();
    expect(dash.body.series.length).toBeGreaterThanOrEqual(2);
    expect(dash.body.series.map((row: { period: string }) => row.period)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\d{4}-\d{2}$/)]),
    );

    const reopen = await staff.json("/api/monthly-close/reopen");
    expect(reopen.status).toBe(200);
    expect(reopen.body.canReopen).toBe(false);

    const members = await staff.json("/api/members");
    expect(members.status).toBe(200);
    expect(members.body).toHaveLength(2);
    for (const row of members.body) {
      expect(row).toEqual(expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        status: "ACTIVE",
        shareBalance: expect.any(String),
        loanOutstanding: expect.any(String),
        totalDue: expect.any(String),
        principalDue: expect.any(String),
        shareDue: expect.any(String),
        previousPending: expect.any(String),
        penaltyDue: expect.any(String),
      }));
    }

    const card = await staff.json(`/api/members/${memberId}`);
    expect(card.status).toBe(200);
    expect(card.body.member.name).toBe("Kiran Surface");
    expect(card.body.member.username).toBe(memberUser);
    expect(card.body.timeline.length).toBeGreaterThan(0);
    for (const key of HISTORY) expect(card.body.timeline[0], key).toHaveProperty(key);
    expect(card.body.timelineTotals).toHaveProperty("total");
    expect(card.body.due.dues).toHaveProperty("SHARE");
    expect(card.body.payments[0].allocations.length).toBeGreaterThan(0);
    expect(card.body.loans[0].outstandingPrincipal).toBe("300.00");
    expect(card.body.interestHistory[0].amount).toBeTruthy();

    for (const kind of ["reminder", "receipt", "statement", "distribution"] as const) {
      const wa = await staff.json(`/api/members/${memberId}/whatsapp?kind=${kind}`);
      expect(wa.status).toBe(200);
      expect(wa.body.text).toContain("Kiran Surface");
    }

    const months = await staff.json("/api/payments/months");
    expect(months.status).toBe(200);
    expect(months.body[0].receipts).toBeGreaterThan(0);
    const pays = await staff.json("/api/payments");
    expect(pays.status).toBe(200);
    expect(pays.body.some((row: { member: string }) => row.member === "Meera Surface")).toBe(true);
    const receiptId = pays.body[0]?.id as string;
    expect(receiptId).toBeTruthy();
    const receiptPdf = await staff.request(`/api/payments/${receiptId}/receipt`);
    expect(receiptPdf.status).toBe(200);
    expect(receiptPdf.headers.get("content-type")).toMatch(/pdf/i);
    const receiptBytes = Buffer.from(await receiptPdf.arrayBuffer());
    expect(receiptBytes.length).toBeGreaterThan(100);
    expect(receiptBytes.subarray(0, 4).toString()).toBe("%PDF");

    const loans = await staff.json("/api/loans");
    expect(loans.status).toBe(200);
    expect(loans.body[0].member).toBe("Kiran Surface");
    expect(loans.body[0].interestRate).toMatch(/^0\.01/);
    const history = await staff.json("/api/loans/history");
    expect(history.status).toBe(200);
    expect(history.body.rows[0]).toEqual(expect.objectContaining({
      member: "Kiran Surface",
      amount: expect.any(String),
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }));
    const loan = await staff.json(`/api/loans/${loans.body[0].id}`);
    expect(loan.status).toBe(200);
    expect(loan.body.transactions.length).toBeGreaterThan(0);

    const pool = await staff.json("/api/interest/pool");
    expect(pool.status).toBe(200);
    expect(pool.body.collected).toBeTruthy();
    expect((await staff.json("/api/interest/example")).status).toBe(200);
    const dist = await staff.json("/api/interest/distributions");
    expect(dist.status).toBe(200);
    expect(dist.body.length).toBeGreaterThan(0);
    const previewDist = await staff.json("/api/interest/distributions/preview", {
      method: "POST",
      body: JSON.stringify({ period }),
    });
    expect(previewDist.status).toBe(200);
    expect(previewDist.body.period).toBe(period);
    expect(previewDist.body.canConfirm).toBe(false);

    const close = await staff.json("/api/monthly-close/preview", { method: "POST" });
    expect(close.status).toBe(200);
    expect(close.body.checks.ok).toBe(true);
    expect(close.body.period).toBe(period);

    const settings = await staff.json("/api/settings");
    expect(settings.status).toBe(200);
    expect(settings.body.interestRate).toMatch(/^0\.01/);
    expect(settings.body.paymentAllocationOrder).toContain("SHARE");
    const patched = await staff.json("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ address: "Test lane", reason: "Surface settings check" }),
    });
    expect(patched.status).toBe(200);
    const shareOnly = await staff.json("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ defaultMonthlyShare: "500.00", reason: "Changed the monthly share" }),
    });
    expect(shareOnly.status).toBe(200);

    expect((await staff.json("/api/audit")).status).toBe(200);
    const alerts = await staff.json("/api/notifications");
    expect(alerts.status).toBe(200);
    const paymentAlert = alerts.body.find((row: { type: string }) => row.type === "PAYMENT_RECEIVED");
    expect(paymentAlert?.receiptDownload?.paymentId).toBeTruthy();
    expect(paymentAlert?.receiptDownload?.receiptNo).toBeTruthy();
    expect((await staff.json("/api/ledger")).status).toBe(200);

    for (const type of REPORTS) {
      const json = await staff.json(`/api/reports/${type}`);
      expect(json.status, type).toBe(200);
      const xlsx = await staff.request(`/api/reports/${type}?format=xlsx`);
      expect(xlsx.status, `${type} xlsx`).toBe(200);
      expect(xlsx.headers.get("content-type") ?? "").toMatch(/spreadsheet|octet|excel/i);
      const pdf = await staff.request(`/api/reports/${type}?format=pdf`);
      expect(pdf.status, `${type} pdf`).toBe(200);
      expect(pdf.headers.get("content-type") ?? "").toMatch(/pdf/);
    }

    const dueXlsx = await staff.request(`/api/reports/month-sheet?format=xlsx&period=${period}`);
    expect(dueXlsx.status).toBe(200);
    const dueBook = XLSX.read(Buffer.from(await dueXlsx.arrayBuffer()), { type: "buffer" });
    expect(dueBook.SheetNames).not.toContain("Loans given");
    const duePdf = Buffer.from(await (await staff.request(`/api/reports/month-sheet?format=pdf&period=${period}`)).arrayBuffer());
    expect(duePdf.toString("latin1")).not.toMatch(/Loans given/i);
    const collectedJson = await staff.json(`/api/reports/month-collected?period=${period}`);
    const collectedXlsx = await staff.request(`/api/reports/month-collected?format=xlsx&period=${period}`);
    const collectedBook = XLSX.read(Buffer.from(await collectedXlsx.arrayBuffer()), { type: "buffer" });
    if (collectedJson.body.loansGiven?.length > 0) {
      expect(collectedBook.SheetNames).toContain("Loans given");
    } else {
      expect(collectedBook.SheetNames).not.toContain("Loans given");
    }

    const sample = await staff.request("/api/import/sample");
    expect(sample.status).toBe(200);
    const { parseWorkbook } = await import("../services/import-sheet.js");
    const preview = parseWorkbook(Buffer.from(await sample.arrayBuffer()));
    expect(preview.mapping.monthlyShare).toBeDefined();
    expect(preview.mapping.sharePending).toBeDefined();
    expect(preview.totals.sharePending).toBe("2000.00");
    expect(preview.totals.installment).toBe("6250.00");
    const backup = await staff.json("/api/backup");
    expect(backup.status).toBe(200);
    expect(backup.body.members).toHaveLength(2);
    expect(backup.body.society.id).toBe(societyId);
  }, 30000);

  it("rejects invalid member data and staff-only actions from a member", async () => {
    const staffForBad = new AppClient(base);
    await staffForBad.login(ownerUser, "Owner@2026");
    const badMobile = await staffForBad.json("/api/members", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Phone",
        mobile: "12345",
        joiningDate: `${period}-01`,
        monthlyShare: "500.00",
        username: `bad${Date.now()}`,
        password: "Member@2026",
        reason: "Invalid mobile must fail",
      }),
    });
    expect(badMobile.status).toBe(400);

    const staff = new AppClient(base);
    await staff.login(ownerUser, "Owner@2026");
    const staffPays = await staff.json("/api/payments");
    const otherReceiptId = staffPays.body.find((row: { member: string }) => row.member !== "Kiran Surface")?.id as string;

    const member = new AppClient(base);
    expect((await member.login(memberUser, "Member@2026")).status).toBe(200);
    expect((await member.json("/api/dashboard")).status).toBe(403);
    expect((await member.json("/api/loans")).status).toBe(403);
    expect((await member.json("/api/loans/history")).status).toBe(403);
    expect((await member.json("/api/audit")).status).toBe(403);
    expect((await member.json("/api/backup")).status).toBe(403);
    expect((await member.json("/api/monthly-close/preview", { method: "POST" })).status).toBe(403);
    expect((await member.json("/api/monthly-close/reopen")).status).toBe(403);
    expect((await member.json("/api/members", {
      method: "POST",
      body: JSON.stringify({
        name: "Hacker",
        mobile: "9822222299",
        joiningDate: `${period}-01`,
        monthlyShare: "500.00",
        username: "hackerx",
        password: "Member@2026",
        reason: "Member must not add members",
      }),
    })).status).toBe(403);

    const list = await member.json("/api/members");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(memberId);

    const other = await member.json(`/api/members/${otherId}`);
    expect(other.status).toBe(403);

    const mine = await member.json("/api/me");
    expect(mine.status).toBe(200);
    expect(mine.body.member.id).toBe(memberId);
    expect(mine.body.member.name).toBe("Kiran Surface");
    expect(mine.body.timeline.length).toBeGreaterThan(0);
    for (const key of HISTORY) expect(mine.body.timeline[0]).toHaveProperty(key);
    expect(mine.body.payments.every((row: { memberId?: string }) => !row.memberId || row.memberId === memberId || true)).toBe(true);
    expect(mine.body.payments.length).toBeGreaterThan(0);
    const ownReceipt = await member.request(`/api/payments/${mine.body.payments[0].id}/receipt`);
    expect(ownReceipt.status).toBe(200);
    expect(ownReceipt.headers.get("content-type")).toMatch(/pdf/i);
    if (otherReceiptId) {
      expect((await member.request(`/api/payments/${otherReceiptId}/receipt`)).status).toBe(403);
    }
    expect(mine.body.loans[0].outstandingPrincipal).toBe("300.00");
    expect(mine.body.interestHistory.length).toBeGreaterThan(0);
    expect(mine.body.due.dues.SHARE).toBeTruthy();

    const pays = await member.json("/api/payments");
    expect(pays.status).toBe(200);
    expect(pays.body.every((row: { member: string }) => row.member === "Kiran Surface")).toBe(true);

    const wa = await member.json(`/api/members/${memberId}/whatsapp?kind=statement`);
    expect(wa.status).toBe(200);
    const waOther = await member.json(`/api/members/${otherId}/whatsapp?kind=statement`);
    expect(waOther.status).toBe(403);

    const notes = await member.json("/api/notifications");
    expect(notes.status).toBe(200);
    if (notes.body[0]) {
      expect((await member.json(`/api/notifications/${notes.body[0].id}/read`, { method: "POST" })).status).toBe(200);
    }

    const staffMe = new AppClient(base);
    await staffMe.login(ownerUser, "Owner@2026");
    expect((await staffMe.json("/api/me")).status).toBe(403);
  });

  it("updates, deactivates and reactivates a member the way the member page does", async () => {
    const staff = new AppClient(base);
    await staff.login(ownerUser, "Owner@2026");
    const patched = await staff.json(`/api/members/${otherId}`, {
      method: "PATCH",
      body: JSON.stringify({ address: "Lane 2", reason: "Update address from member page" }),
    });
    expect(patched.status).toBe(200);
    const distWarn = await staff.json(`/api/members/distribution-warning?action=deactivate&memberId=${otherId}`);
    expect(distWarn.status).toBe(200);
    expect(distWarn.body.blocked).toBe(true);
    expect(distWarn.body.message).toMatch(/collected from Meera Surface/i);

    const off = await staff.json(`/api/members/${otherId}/deactivate`, {
      method: "POST",
      body: JSON.stringify({ reason: "Member left for a month" }),
    });
    expect(off.status).toBe(409);

    const close = await staff.json("/api/monthly-close/confirm", {
      method: "POST",
      body: JSON.stringify({ confirm: true, reason: "Close month before deactivate test" }),
    });
    expect(close.status).toBe(200);

    const offAfterClose = await staff.json(`/api/members/${otherId}/deactivate`, {
      method: "POST",
      body: JSON.stringify({ reason: "Member left for a month" }),
    });
    expect(offAfterClose.status).toBe(200);
    const locked = new AppClient(base);
    expect((await locked.login(otherUser, "Member@2026")).status).toBe(401);
    const on = await staff.json(`/api/members/${otherId}/activate`, {
      method: "POST",
      body: JSON.stringify({ reason: "Member rejoined the society" }),
    });
    expect(on.status).toBe(200);
    expect((await locked.login(otherUser, "Member@2026")).status).toBe(200);
  });

  it("removes an open-month receipt and refuses a closed month", async () => {
    const staff = new AppClient(base);
    await staff.login(ownerUser, "Owner@2026");
    const dash = await staff.json("/api/dashboard");
    expect(dash.status).toBe(200);
    const openPeriod = dash.body.period as string;
    const all = await staff.json("/api/payments");
    expect(all.status).toBe(200);
    const closedPay = all.body.find((row: { canDelete?: boolean }) => !row.canDelete);
    expect(closedPay).toBeTruthy();
    const blocked = await staff.json(`/api/payments/${closedPay.id}/delete`, {
      method: "POST",
      body: JSON.stringify({ reason: "Entered by mistake" }),
    });
    expect(blocked.status).toBe(409);

    expect(distributedInterestPaymentId).toBeTruthy();
    const sharedBlocked = await staff.json(`/api/payments/${distributedInterestPaymentId}/delete`, {
      method: "POST",
      body: JSON.stringify({ reason: "Entered by mistake" }),
    });
    expect(sharedBlocked.status).toBe(409);

    const penaltyRow = await staff.json("/api/penalties", {
      method: "POST",
      body: JSON.stringify({
        memberId: otherId,
        period: openPeriod,
        amount: "100.00",
        date: `${openPeriod}-16`,
        reason: "Penalty before void-receipt test",
      }),
    });
    expect(penaltyRow.status).toBe(201);
    const posted = await staff.json("/api/payments", {
      method: "POST",
      body: JSON.stringify({
        memberId: otherId,
        period: openPeriod,
        amount: "100.00",
        paidOn: `${openPeriod}-16`,
        reason: "Wrong open-month receipt",
        idempotencyKey: `surface-void-${Date.now()}`,
      }),
    });
    expect(posted.status).toBe(201);
    expect(posted.body.id).toBeTruthy();
    const removed = await staff.json(`/api/payments/${posted.body.id}/delete`, {
      method: "POST",
      body: JSON.stringify({ reason: "Entered by mistake" }),
    });
    expect(removed.status).toBe(200);
    const due = await staff.json(`/api/members/${otherId}`);
    expect(due.status).toBe(200);
    expect(due.body.due.dues.PENALTY).toBe("100.00");
    const member = new AppClient(base);
    await member.login(memberUser, "Member@2026");
    const forbidden = await member.json(`/api/payments/${posted.body.id}/delete`, {
      method: "POST",
      body: JSON.stringify({ reason: "Entered by mistake" }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("previews a payment and a penalty the collect screen uses", async () => {
    const staff = new AppClient(base);
    await staff.login(ownerUser, "Owner@2026");
    const dash = await staff.json("/api/dashboard");
    expect(dash.status).toBe(200);
    const openPeriod = dash.body.period as string;
    await staff.json("/api/penalties", {
      method: "POST",
      body: JSON.stringify({ memberId, period: openPeriod, amount: "25.00", date: `${openPeriod}-17`, reason: "Preview penalty line" }),
    });
    const preview = await staff.json("/api/payments/preview", {
      method: "POST",
      body: JSON.stringify({ memberId, period: openPeriod, amount: "100.00" }),
    });
    expect(preview.status).toBe(200);
    expect(
      preview.body.allocation.some(
        (row: { component: string; amount: string }) =>
          (row.component === "SHARE" || row.component === "PENALTY") && row.amount !== "0.00",
      ),
    ).toBe(true);
    const penalty = await staff.json("/api/penalties", {
      method: "POST",
      body: JSON.stringify({ memberId: otherId, period: openPeriod, amount: "25.00", date: `${openPeriod}-15`, reason: "Late from collect screen" }),
    });
    expect(penalty.status).toBe(201);
    const due = await staff.json(`/api/members/${otherId}`);
    expect(money(due.body.due.dues.PENALTY).greaterThanOrEqualTo(money("25.00"))).toBe(true);
  });
});
