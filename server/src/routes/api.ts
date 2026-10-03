import bcrypt from "bcryptjs";
import Decimal from "decimal.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { sendPaymentReceiptPdf } from "../lib/payment-receipt-pdf.js";
import { paymentReceiptNoteLines } from "../services/payment-receipt-notes.js";
import { columnLabel, sendReportPdf, totalsRow } from "../lib/pdf-report.js";
import { z } from "zod";
import * as XLSX from "xlsx";
import { previewWorkedExample } from "../engine/finance.js";
import { calendarPeriod } from "../lib/format.js";
import { asyncRoute, HttpError } from "../lib/http.js";
import { indianMobileSchema } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { str } from "../lib/money-db.js";
import { assertOwnMember, readAuthUser, readSelectionToken, requireAuth, requireMainAdmin, requireOwner, requireStaff, signSelectionToken, signToken, type AuthUser } from "../middleware/auth.js";
import {
  addPenalty,
  confirmClose,
  confirmDistribution,
  createLoan,
  createMember,
  memberRegisterPolicy,
  activateMember,
  deactivateMember,
  memberDistributionWarning,
  setMemberAccess,
  distributionPreview,
  deletePayment,
  postPayment,
  previewClose,
  previewPayment,
  reopenPreviousMonth,
  reopenStatus,
  importRegister,
  importRollbackStatus,
  rollbackImportedRegister,
  reverseDistribution,
  updateMember,
  withdrawInterest,
} from "../services/books.js";
import { buildSampleWorkbook } from "../lib/import-sample.js";
import { parseWorkbook } from "../services/import-sheet.js";
import { createSocietyAdmin, listPlatform, setSocietyAdminActive, setSocietyAdminPassword } from "../services/platform.js";
import { listNotifications, markNotificationRead } from "../services/notifications.js";
import { adminDashboard, listMembers, loanHistory, memberStatement, memberTimelineReportRows, reportData, whatsAppDraft } from "../services/read.js";

const moneyString = z.string().regex(/^\d+(\.\d{1,2})?$/);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodString = z.string().regex(/^\d{4}-\d{2}$/);
const reasonString = z.string().trim().min(3).max(500);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls|csv)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("Upload an Excel or CSV file"));
  },
});

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.resolve("uploads");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `logo-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error("Logo must be a PNG, JPG, or WebP image"));
  },
});

function cookie(res: import("express").Response, token: string) {
  res.cookie("sf_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
}

function authOf(req: import("express").Request): AuthUser {
  if (!req.auth) throw new HttpError(401, "Sign in required");
  return req.auth;
}

export const api = Router();

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

api.get("/platform", requireAuth, requireMainAdmin, asyncRoute(async (_req, res) => res.json(await listPlatform())));

api.post(
  "/platform/admins",
  requireAuth,
  requireMainAdmin,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        societyId: z.string().optional(),
        societyName: z.string().trim().max(160).optional(),
        name: z.string().trim().min(2).max(80),
        username: z.string().trim().min(3).max(32),
        password: z.string().min(8).max(100),
        monthlyShare: moneyString.optional(),
      })
      .parse(req.body);
    res.status(201).json(await createSocietyAdmin(authOf(req), body));
  }),
);

api.post(
  "/platform/admins/:id/password",
  requireAuth,
  requireMainAdmin,
  asyncRoute(async (req, res) => {
    const body = z.object({ next: z.string().min(8).max(100) }).parse(req.body);
    res.json(await setSocietyAdminPassword(authOf(req), String(req.params.id), body.next));
  }),
);

api.post(
  "/platform/admins/:id/status",
  requireAuth,
  requireMainAdmin,
  asyncRoute(async (req, res) => {
    const body = z.object({ active: z.boolean(), reason: reasonString }).parse(req.body);
    res.json(await setSocietyAdminActive(authOf(req), String(req.params.id), body.active, body.reason));
  }),
);

api.get("/health", (_req, res) => {
  res.json({ ok: true, product: "Society Finance" });
});

api.post(
  "/auth/login",
  loginLimit,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        username: z.string().trim().min(2).max(40).optional(),
        mobile: z.string().trim().min(2).max(40).optional(),
        password: z.string().min(8).max(100),
      })
      .parse(req.body);
    const loginName = body.username || body.mobile || "";
    if (!loginName) throw new HttpError(400, "Enter your username");
    const candidates = await prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ username: { equals: loginName, mode: "insensitive" } }, { mobile: loginName }],
      },
      take: 20,
    });
    const matched = [];
    for (const candidate of candidates) {
      if (await bcrypt.compare(body.password, candidate.passwordHash)) matched.push(candidate);
    }
    if (matched.length === 0) throw new HttpError(401, "Username or password is incorrect");
    if (matched.length > 1) {
      res.json({ societies: await societyChoices(matched), selectionToken: signSelectionToken(matched.map((row) => row.id)) });
      return;
    }
    await signInAs(res, matched[0]);
  }),
);

type LoginUser = { id: string; societyId: string | null; role: AuthUser["role"]; memberId: string | null; name: string; username: string | null; tokenVersion: number };

async function loginSessionBody(user: LoginUser) {
  const society = user.societyId ? await prisma.society.findUnique({ where: { id: user.societyId } }) : null;
  return {
    user: {
      userId: user.id,
      name: user.name,
      role: user.role,
      memberId: user.memberId,
      username: user.username ?? "",
    },
    society: society
      ? { id: society.id, name: society.name, logoUrl: society.logoUrl }
      : { id: "", name: "All societies", logoUrl: null },
  };
}

async function signInAs(res: import("express").Response, user: LoginUser) {
  const auth: AuthUser = {
    userId: user.id,
    societyId: user.societyId ?? "",
    role: user.role,
    memberId: user.memberId,
    name: user.name,
    tokenVersion: user.tokenVersion,
  };
  cookie(res, signToken(auth));
  res.json(await loginSessionBody(user));
}

async function societyChoices(users: LoginUser[]) {
  const societies = await prisma.society.findMany({
    where: { id: { in: users.map((user) => user.societyId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true, logoUrl: true },
  });
  return users.map((user) => {
    const society = societies.find((row) => row.id === user.societyId);
    return {
      userId: user.id,
      role: user.role,
      name: user.name,
      societyName: society?.name ?? "All societies",
      logoUrl: society?.logoUrl ?? null,
    };
  });
}

/** Second step of a multi-society sign in: the password was already checked, so only the choice is confirmed. */
api.post(
  "/auth/login/select",
  loginLimit,
  asyncRoute(async (req, res) => {
    const body = z.object({ selectionToken: z.string().min(10), userId: z.string().min(1).max(64) }).parse(req.body);
    const allowed = readSelectionToken(body.selectionToken);
    if (!allowed.includes(body.userId)) throw new HttpError(403, "Choose one of the societies you signed in to");
    const user = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!user || !user.isActive) throw new HttpError(401, "This account is not active");
    await signInAs(res, user);
  }),
);

api.post("/auth/logout", (_req, res) => {
  res.clearCookie("sf_token", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  res.json({ ok: true });
});

api.get(
  "/auth/me",
  asyncRoute(async (req, res) => {
    const auth = await readAuthUser(req);
    if (!auth) {
      res.json({ user: null, society: null });
      return;
    }
    cookie(res, signToken(auth));
    const society = auth.societyId ? await prisma.society.findUnique({ where: { id: auth.societyId } }) : null;
    res.json({
      user: { ...auth, username: (await prisma.user.findUnique({ where: { id: auth.userId } }))?.username ?? "" },
      society: society
        ? { id: society.id, name: society.name, logoUrl: society.logoUrl }
        : { id: "", name: "All societies", logoUrl: null },
    });
  }),
);

api.post(
  "/auth/password",
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = z.object({ current: z.string().min(8), next: z.string().min(8).max(100) }).parse(req.body);
    const auth = authOf(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await bcrypt.compare(body.current, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(body.next, 10), tokenVersion: { increment: 1 } },
    });
    res.json({ ok: true });
  }),
);

api.get("/dashboard", requireAuth, requireStaff, asyncRoute(async (req, res) => res.json(await adminDashboard(authOf(req)))));

api.get("/members", requireAuth, asyncRoute(async (req, res) => res.json(await listMembers(authOf(req)))));

api.get(
  "/members/register-policy",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => res.json(await memberRegisterPolicy(authOf(req)))),
);

api.get(
  "/members/distribution-warning",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const action = z.enum(["deactivate", "activate", "add"]).parse(req.query.action ?? "add");
    const memberId = typeof req.query.memberId === "string" && req.query.memberId ? req.query.memberId : undefined;
    res.json(await memberDistributionWarning(authOf(req), { action, memberId }));
  }),
);

api.post(
  "/members",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120),
        nameLatin: z.string().max(120).optional(),
        mobile: indianMobileSchema(true),
        email: z.string().max(120).optional(),
        address: z.string().max(300).optional(),
        joiningDate: dateString,
        monthlyShare: moneyString,
        username: z.string().trim().min(3).max(32),
        password: z.string().min(8).max(100),
        reason: reasonString,
      })
      .parse(req.body);
    res.status(201).json(await createMember(authOf(req), body));
  }),
);

api.get(
  "/members/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await memberStatement(authOf(req), String(req.params.id)));
  }),
);

api.get("/members/:id/statement", requireAuth, asyncRoute(async (req, res) => res.json(await memberStatement(authOf(req), String(req.params.id)))));
api.get("/members/:id/interest-history", requireAuth, asyncRoute(async (req, res) => {
  const statement = await memberStatement(authOf(req), String(req.params.id));
  res.json(statement.interestHistory);
}));

api.patch(
  "/members/:id",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        nameLatin: z.string().max(120).optional(),
        mobile: indianMobileSchema(false).optional(),
        email: z.string().max(120).optional(),
        address: z.string().max(300).optional(),
        monthlyShare: moneyString.optional(),
        reason: reasonString,
      })
      .parse(req.body);
    res.json(await updateMember(authOf(req), String(req.params.id), body));
  }),
);

api.post(
  "/members/:id/login",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        username: z.string().trim().min(3).max(32),
        password: z.string().min(8).max(100).optional(),
        reason: reasonString,
      })
      .parse(req.body);
    res.json(await setMemberAccess(authOf(req), String(req.params.id), body));
  }),
);

api.post(
  "/members/:id/deactivate",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ reason: reasonString }).parse(req.body);
    res.json(await deactivateMember(authOf(req), String(req.params.id), body.reason));
  }),
);

api.post(
  "/members/:id/activate",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ reason: reasonString }).parse(req.body);
    res.json(await activateMember(authOf(req), String(req.params.id), body.reason));
  }),
);

api.get(
  "/members/:id/whatsapp",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = z.enum(["reminder", "receipt", "statement", "distribution"]).parse(req.query.kind ?? "reminder");
    res.json(await whatsAppDraft(authOf(req), String(req.params.id), kind));
  }),
);

api.get("/loans/history", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const period = typeof req.query.period === "string" && /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : undefined;
  const yearQuery = typeof req.query.year === "string" && /^\d{4}$/.test(req.query.year) ? req.query.year : undefined;
  const year = period ? period.slice(0, 4) : yearQuery ?? String(new Date().getFullYear());
  res.json(await loanHistory(authOf(req), period ? { period } : { year }));
}));

api.get("/loans", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const loans = await prisma.loan.findMany({
    where: { societyId: authOf(req).societyId, status: { not: "CANCELLED" } },
    include: { member: true },
    orderBy: { outstandingPrincipal: "desc" },
  });
  res.json(loans.map((loan) => ({
    id: loan.id,
    memberId: loan.memberId,
    member: loan.member.name,
    nameLatin: loan.member.nameLatin,
    originalPrincipal: str(loan.originalPrincipal),
    outstandingPrincipal: str(loan.outstandingPrincipal),
    scheduledPrincipal: str(loan.scheduledPrincipal),
    interestRate: loan.interestRate.toString(),
    status: loan.status,
    purpose: loan.purpose,
    loanDate: loan.loanDate,
  })));
}));

api.get("/loans/:id", requireAuth, asyncRoute(async (req, res) => {
  const loan = await prisma.loan.findFirst({
    where: { id: String(req.params.id), societyId: authOf(req).societyId },
    include: { transactions: { orderBy: { date: "asc" } }, member: true },
  });
  if (!loan) throw new HttpError(404, "Loan not found");
  assertOwnMember(authOf(req), loan.memberId);
  res.json({
    ...loan,
    originalPrincipal: str(loan.originalPrincipal),
    outstandingPrincipal: str(loan.outstandingPrincipal),
    scheduledPrincipal: str(loan.scheduledPrincipal),
    interestRate: loan.interestRate.toString(),
    transactions: loan.transactions.map((row) => ({ ...row, amount: str(row.amount), balanceAfter: str(row.balanceAfter) })),
  });
}));

api.post(
  "/loans",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        memberId: z.string().refine((value) => value.trim().length > 0, { message: "Please select a member." }),
        amount: moneyString,
        date: dateString,
        scheduledPrincipal: moneyString,
        purpose: z.string().max(200).optional(),
        notes: z.string().max(500).optional(),
        interestRate: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
        reason: reasonString,
      })
      .parse(req.body);
    res.status(201).json(await createLoan(authOf(req), body));
  }),
);

/** The dropdown needs every month and its total, but not every receipt. */
api.get("/payments/months", requireAuth, asyncRoute(async (req, res) => {
  const auth = authOf(req);
  const months = await prisma.payment.groupBy({
    by: ["period"],
    where: { societyId: auth.societyId, status: "RECORDED", ...(auth.role === "MEMBER" ? { memberId: auth.memberId ?? "none" } : {}) },
    _count: { _all: true },
    _sum: { amount: true },
    orderBy: { period: "desc" },
  });
  res.json(months.map((row) => ({ period: row.period, receipts: row._count._all, total: str(row._sum.amount) })));
}));

api.get("/payments", requireAuth, asyncRoute(async (req, res) => {
  const auth = authOf(req);
  const period = typeof req.query.period === "string" && /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : undefined;
  const open = await prisma.accountingMonth.findFirst({
    where: { societyId: auth.societyId, status: "OPEN" },
    orderBy: { period: "desc" },
  });
  const payments = await prisma.payment.findMany({
    where: {
      societyId: auth.societyId,
      status: "RECORDED",
      ...(period ? { period } : {}),
      ...(auth.role === "MEMBER" ? { memberId: auth.memberId ?? "none" } : {}),
    },
    include: { allocations: true, member: true },
    orderBy: [{ period: "desc" }, { paidOn: "desc" }],
    take: 500,
  });
  res.json(payments.map((payment) => ({
    id: payment.id,
    receiptNo: payment.receiptNo,
    memberId: payment.memberId,
    member: payment.member?.name ?? "Member",
    amount: str(payment.amount),
    paidOn: payment.paidOn,
    period: payment.period,
    status: payment.status,
    canDelete: auth.role !== "MEMBER" && payment.period === open?.period,
    allocations: payment.allocations.map((row) => ({ component: row.component, amount: str(row.amount) })),
  })));
}));

api.post(
  "/payments/preview",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        memberId: z.string(),
        period: periodString,
        amount: moneyString,
        penalty: moneyString.optional(),
        collectPenalty: z.boolean().optional(),
        collectPenaltyAmount: moneyString.optional(),
        nextMonthPenalty: moneyString.optional(),
        allocation: z.array(z.object({ component: z.enum(["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"]), amount: moneyString })).optional(),
      })
      .parse(req.body);
    res.json(await previewPayment(authOf(req), body));
  }),
);

api.post(
  "/payments",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        memberId: z.string(),
        period: periodString,
        amount: moneyString,
        paidOn: dateString,
        reason: reasonString,
        note: z.string().max(300).optional(),
        idempotencyKey: z.string().min(8).max(80),
        penalty: moneyString.optional(),
        collectPenalty: z.boolean().optional(),
        collectPenaltyAmount: moneyString.optional(),
        nextMonthPenalty: moneyString.optional(),
        allocation: z.array(z.object({ component: z.enum(["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"]), amount: moneyString })).optional(),
      })
      .parse(req.body);
    res.status(201).json(await postPayment(authOf(req), body));
  }),
);

api.get(
  "/payments/:id/receipt",
  requireAuth,
  asyncRoute(async (req, res) => {
    const auth = authOf(req);
    const payment = await prisma.payment.findFirst({
      where: { id: String(req.params.id), societyId: auth.societyId, status: "RECORDED" },
      include: { allocations: true, member: true, society: true },
    });
    if (!payment) throw new HttpError(404, "Receipt not found");
    if (auth.role === "MEMBER" && payment.memberId !== auth.memberId) {
      throw new HttpError(403, "You can only download your own receipts");
    }
    const noteLines = await paymentReceiptNoteLines({
      id: payment.id,
      societyId: payment.societyId,
      memberId: payment.memberId,
      period: payment.period,
      receiptNo: payment.receiptNo,
      createdAt: payment.createdAt,
      reason: payment.reason,
      note: payment.note ?? "",
    });
    sendPaymentReceiptPdf(res, {
      societyName: payment.society.name,
      societyAddress: payment.society.address,
      societyPhone: payment.society.phone,
      societyEmail: payment.society.email,
      logoUrl: payment.society.logoUrl,
      receiptNo: payment.receiptNo,
      memberName: payment.member.name,
      memberNumber: payment.member.memberNumber,
      period: payment.period,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: str(payment.amount),
      reason: payment.reason,
      note: payment.note ?? "",
      noteLines,
      allocations: payment.allocations.map((row) => ({ component: row.component, amount: str(row.amount) })),
    });
  }),
);

api.post(
  "/payments/:id/delete",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ reason: reasonString }).parse(req.body);
    res.json(await deletePayment(authOf(req), String(req.params.id), body.reason));
  }),
);

api.post(
  "/penalties",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({
      memberId: z.string(),
      period: periodString,
      amount: moneyString,
      date: dateString,
      reason: reasonString,
      nextMonth: z.boolean().optional(),
    }).parse(req.body);
    res.status(201).json(await addPenalty(authOf(req), body));
  }),
);

api.post(
  "/interest/withdrawals",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ memberId: z.string(), amount: moneyString, date: dateString, reason: reasonString }).parse(req.body);
    res.status(201).json(await withdrawInterest(authOf(req), body));
  }),
);

api.get("/interest/pool", requireAuth, asyncRoute(async (req, res) => {
  const dashboard = await adminDashboard(authOf(req).role === "MEMBER" ? { ...authOf(req), role: "OWNER" } : authOf(req));
  if (authOf(req).role === "MEMBER") {
    res.json({ interest: dashboard.interest, period: dashboard.period });
    return;
  }
  res.json(dashboard.interest);
}));

api.get("/interest/example", requireAuth, (_req, res) => {
  res.json(previewWorkedExample());
});

api.post(
  "/interest/distributions/preview",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ period: periodString.optional() }).parse(req.body);
    res.json(await distributionPreview(authOf(req), body.period));
  }),
);

api.post(
  "/interest/distributions/confirm",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        period: periodString,
        reason: reasonString,
        payouts: z
          .array(z.object({ memberId: z.string().min(1), payoutMethod: z.enum(["CASH", "SHARES"]) }))
          .optional(),
      })
      .parse(req.body);
    res.status(201).json(await confirmDistribution(authOf(req), body.period, body.reason, body.payouts));
  }),
);

api.post(
  "/interest/distributions/:id/reverse",
  requireAuth,
  requireOwner,
  asyncRoute(async (req, res) => {
    const body = z.object({ reason: reasonString }).parse(req.body);
    res.json(await reverseDistribution(authOf(req), String(req.params.id), body.reason));
  }),
);

api.get("/interest/distributions", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const rows = await prisma.interestDistribution.findMany({
    where: { societyId: authOf(req).societyId },
    include: { entries: { include: { member: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(rows.map((row) => ({
    id: row.id,
    code: row.code,
    period: row.period,
    status: row.status,
    totalAvailable: str(row.totalAvailable),
    eligibleCount: row.eligibleCount,
    perMemberAmount: str(row.perMemberAmount),
    totalDistributed: str(row.totalDistributed),
    interestPortion: str(row.interestPortion),
    penaltyPortion: str(row.penaltyPortion),
    remaining: str(row.remaining),
    reason: row.reason,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    entries: row.entries.map((entry) => ({
      member: entry.member.name,
      nameLatin: entry.member.nameLatin,
      amount: str(entry.amount),
      status: entry.status,
      payoutMethod: entry.payoutMethod,
    })),
  })));
}));

api.get("/ledger", requireAuth, requireStaff, asyncRoute(async (req, res) => res.json(await reportData(authOf(req), "ledger"))));

api.post("/monthly-close/preview", requireAuth, requireStaff, asyncRoute(async (req, res) => res.json(await previewClose(authOf(req)))));
api.get("/monthly-close/reopen", requireAuth, requireStaff, asyncRoute(async (req, res) => res.json(await reopenStatus(authOf(req)))));
api.post(
  "/monthly-close/confirm",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ reason: reasonString, confirm: z.literal(true) }).parse(req.body);
    res.json(await confirmClose(authOf(req), body.reason));
  }),
);
api.post(
  "/monthly-close/reopen",
  requireAuth,
  requireStaff,
  asyncRoute(async (req, res) => {
    const body = z.object({ reason: reasonString, confirm: z.literal(true) }).parse(req.body);
    res.json(await reopenPreviousMonth(authOf(req), body.reason));
  }),
);

function labelRows(rows: Record<string, unknown>[]) {
  const totals = rows.at(-1)?.label === "Total" ? null : totalsRow(rows);
  const withTotals = totals ? [...rows, totals] : rows;
  return withTotals.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [columnLabel(key), value])));
}

function excelSheet(societyName: string, title: string, rows: Record<string, unknown>[]) {
  const sheet = XLSX.utils.aoa_to_sheet([[societyName], [title], []]);
  const labelled = rows.length ? labelRows(rows) : [];
  if (labelled.length) XLSX.utils.sheet_add_json(sheet, labelled, { origin: "A4" });
  else XLSX.utils.sheet_add_aoa(sheet, [["No rows."]], { origin: "A4" });
  return sheet;
}

type MonthReportPayload = {
  kind?: string;
  month?: string;
  rows: Record<string, unknown>[];
  loansGiven?: Record<string, unknown>[];
};

/** Loans given block belongs only on the collected sheet when there were disbursements. */
function loansGivenForExport(reportType: string, sheet: MonthReportPayload) {
  if (reportType === "month-sheet" || sheet.kind === "due") return undefined;
  if (reportType !== "month-collected" || sheet.kind !== "collected") return undefined;
  const rows = sheet.loansGiven ?? [];
  return rows.length > 0 ? rows : undefined;
}

const REPORT_TITLES: Record<string, string> = {
  "month-sheet": "Month sheet to collect",
  "month-collected": "Month sheet collected",
  monthly: "Monthly collection",
  loans: "Loans outstanding",
  "interest-accrued": "Interest charged",
  "interest-collected": "Interest collected",
  "interest-distribution": "Interest distribution",
  penalties: "Penalties",
  // contributions: "Contributions",
  // ledger: "Society ledger",
  // "society-balance": "Society balance",
  // defaulters: "Defaulters",
  "monthly-closing": "Monthly closing",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Downloads are named "September_2026_Month_sheet" so a year of reports sorts and reads well in a folder. */
function reportFileName(type: string, period: string) {
  const [year, month] = period.split("-");
  const monthName = MONTH_NAMES[Number(month) - 1] ?? period;
  const label = (REPORT_TITLES[type] ?? type.replaceAll("-", " ")).replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_");
  return `${monthName}_${year}_${label}`;
}

/** Reports are the society's own books, so every member may read them. Only staff can change anything. */
api.get("/reports/:type", requireAuth, asyncRoute(async (req, res) => {
  const auth = authOf(req);
  if (!auth.societyId) throw new HttpError(403, "Sign in to a society to open its reports");
  const type = String(req.params.type).trim();
  const period = typeof req.query.period === "string" ? req.query.period : undefined;
  const rows = await reportData(auth, type, period);
  const format = String(req.query.format ?? "json");
  const sheetPeriod = rows && typeof rows === "object" && !Array.isArray(rows) && "period" in rows ? String((rows as { period: unknown }).period) : undefined;
  let named = period ?? sheetPeriod;
  if (!named) {
    const open = await prisma.accountingMonth.findFirst({ where: { societyId: auth.societyId, status: "OPEN" }, orderBy: { period: "desc" } });
    named = open?.period ?? calendarPeriod();
  }
  const fileName = reportFileName(type, named);
  const society = await prisma.society.findUnique({ where: { id: auth.societyId }, select: { name: true } });
  const societyName = society?.name || "Society Finance";
  if (format === "xlsx") {
    const book = XLSX.utils.book_new();
    if (rows && typeof rows === "object" && !Array.isArray(rows) && "rows" in rows) {
      const sheet = rows as MonthReportPayload;
      const month = sheet.month ? ` — ${sheet.month}` : "";
      const title = REPORT_TITLES[type] ?? "Month sheet";
      XLSX.utils.book_append_sheet(book, excelSheet(societyName, `${title}${month}`, sheet.rows), title.slice(0, 31));
      const loansGiven = loansGivenForExport(type, sheet);
      if (loansGiven) {
        XLSX.utils.book_append_sheet(
          book,
          excelSheet(societyName, `Loans given${month}`, loansGiven.length ? loansGiven : [{ member: "No loan was given this month", date: "", amount: "0.00" }]),
          "Loans given",
        );
      }
    } else {
      XLSX.utils.book_append_sheet(book, excelSheet(societyName, REPORT_TITLES[type] ?? type.replaceAll("-", " "), rows as Record<string, unknown>[]), "Report");
    }
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}.xlsx"`);
    res.send(buffer);
    return;
  }
  if (format === "pdf") {
    if (rows && typeof rows === "object" && !Array.isArray(rows) && "rows" in rows) {
      const sheet = rows as MonthReportPayload & { month: string };
      const title = REPORT_TITLES[type] ?? "Month sheet";
      const loansGiven = loansGivenForExport(type, sheet);
      sendReportPdf(res, `${title} — ${sheet.month}`, sheet.rows, {
        heading: loansGiven ? `Loans given in ${sheet.month}` : undefined,
        rows: loansGiven,
        fileName,
        societyName,
      });
      return;
    }
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    sendReportPdf(res, REPORT_TITLES[type] ?? type.replaceAll("-", " "), list, { fileName, societyName });
    return;
  }
  res.json(rows);
}));

api.get("/me", requireAuth, asyncRoute(async (req, res) => {
  const auth = authOf(req);
  if (!auth.memberId) throw new HttpError(403, "This account is not linked to a member");
  const statement = await memberStatement(auth, auth.memberId);
  const format = String(req.query.format ?? "json");
  if (format === "json") {
    res.json(statement);
    return;
  }
  const rows = memberTimelineReportRows(statement.timeline, statement.timelineTotals);
  const societyName = statement.society.name;
  const title = `My month report — ${statement.member.name}`;
  const safeName = statement.member.name.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_") || "Member";
  const fileName = `${safeName}_My_month_report`;
  if (format === "xlsx") {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, excelSheet(societyName, title, rows), "My month report");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}.xlsx"`);
    res.send(buffer);
    return;
  }
  if (format === "pdf") {
    sendReportPdf(res, title, rows, { fileName, societyName });
    return;
  }
  throw new HttpError(400, "Unknown format");
}));

api.get("/notifications", requireAuth, asyncRoute(async (req, res) => res.json(await listNotifications(authOf(req)))));

api.post("/notifications/:id/read", requireAuth, asyncRoute(async (req, res) => {
  await markNotificationRead(authOf(req), String(req.params.id));
  res.json({ ok: true });
}));

api.get("/audit", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const rows = await prisma.auditLog.findMany({ where: { societyId: authOf(req).societyId }, orderBy: { createdAt: "desc" }, take: 100 });
  res.json(rows);
}));

api.get("/settings", requireAuth, asyncRoute(async (req, res) => {
  const society = await prisma.society.findUniqueOrThrow({ where: { id: authOf(req).societyId } });
  res.json({
    name: society.name,
    address: society.address,
    phone: society.phone,
    email: society.email,
    logoUrl: society.logoUrl,
    interestRate: society.interestRate.toString(),
    defaultMonthlyShare: str(society.defaultMonthlyShare),
    interestCalculationFrequency: society.interestCalculationFrequency,
    interestCalculationMethod: society.interestCalculationMethod,
    interestDistributionFrequency: society.interestDistributionFrequency,
    interestEligibilityRule: society.interestEligibilityRule,
    distributionMethod: society.distributionMethod,
    roundingPolicy: society.roundingPolicy,
    paymentAllocationOrder: society.paymentAllocationOrder.split(","),
    penaltyMethod: society.penaltyMethod,
  });
}));

api.patch("/settings", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(160).optional(),
      address: z.string().max(300).optional(),
      phone: indianMobileSchema(false, "Phone").optional(),
      email: z.string().max(120).optional(),
      interestPercent: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
      interestRate: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
      defaultMonthlyShare: moneyString.optional(),
      paymentAllocationOrder: z.array(z.enum(["SHARE", "PREVIOUS_INTEREST", "CURRENT_INTEREST", "PRINCIPAL", "PENALTY"])).length(5).optional(),
      roundingPolicy: z.enum(["UNIFORM_HALF_UP_REMAINDER", "LARGEST_REMAINDER"]).optional(),
      reason: reasonString,
    })
    .parse(req.body);
  if (body.paymentAllocationOrder && new Set(body.paymentAllocationOrder).size !== 5) {
    throw new HttpError(400, "Allocation order must list each component once");
  }
  const auth = authOf(req);
  const percent = body.interestPercent ? new Decimal(body.interestPercent) : null;
  if (percent && (percent.isNegative() || percent.greaterThan(100))) {
    throw new HttpError(400, "Interest rate must be between 0 and 100 percent");
  }
  const interestRate = percent ? percent.div(100).toFixed(6) : body.interestRate;
  const current = await prisma.society.findUniqueOrThrow({ where: { id: auth.societyId } });
  const societyOnly = auth.role === "ADMIN";
  if (societyOnly && !interestRate) throw new HttpError(400, "Enter the monthly interest rate");
  const society = await prisma.society.update({
    where: { id: auth.societyId },
    data: societyOnly
      ? { interestRate }
      : {
          name: body.name,
          address: body.address,
          phone: body.phone,
          email: body.email,
          interestRate,
          defaultMonthlyShare: body.defaultMonthlyShare,
          paymentAllocationOrder: body.paymentAllocationOrder?.join(","),
          roundingPolicy: body.roundingPolicy,
        },
  });
  await prisma.auditLog.create({
    data: {
      societyId: auth.societyId,
      actorId: auth.userId,
      actorName: auth.name,
      action: "Updated society settings",
      entityType: "Society",
      entityId: society.id,
      reason: body.reason,
      oldValue: { name: current.name, interestRate: current.interestRate.toString(), paymentAllocationOrder: current.paymentAllocationOrder },
      newValue: { name: society.name, interestRate: society.interestRate.toString(), paymentAllocationOrder: society.paymentAllocationOrder },
    },
  });
  res.json({ name: society.name, interestRate: society.interestRate.toString() });
}));

api.post("/settings/logo", requireAuth, requireOwner, logoUpload.single("logo"), asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, "Choose an image");
  const society = await prisma.society.update({
    where: { id: authOf(req).societyId },
    data: { logoUrl: `/uploads/${req.file.filename}` },
  });
  res.json({ logoUrl: society.logoUrl });
}));

api.get("/import/sample", requireAuth, requireStaff, asyncRoute(async (_req, res) => {
  const buffer = buildSampleWorkbook();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="Society_register_sample.xlsx"');
  res.send(buffer);
}));

function importDraftPath() {
  return path.join(path.resolve("uploads"), "last-import.xlsx");
}

api.get("/import/rollback", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  res.json(await importRollbackStatus(authOf(req)));
}));

api.post("/import/rollback", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const body = z.object({ confirm: z.literal(true), reason: reasonString }).parse(req.body);
  const file = importDraftPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json(await rollbackImportedRegister(authOf(req), body.reason));
}));

api.delete("/import/draft", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const societyId = authOf(req).societyId;
  const members = await prisma.member.count({ where: { societyId } });
  if (members > 0) {
    throw new HttpError(409, "The register is already posted. The uploaded sheet cannot be removed.");
  }
  const file = importDraftPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ cleared: true });
}));

api.post("/import/preview", requireAuth, requireStaff, upload.single("file"), asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, "Choose an Excel file");
  const members = await prisma.member.count({ where: { societyId: authOf(req).societyId } });
  if (members > 0) {
    throw new HttpError(409, "This society already has members. Import is closed.");
  }
  const dir = path.dirname(importDraftPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(importDraftPath(), req.file.buffer);
  const society = await prisma.society.findUniqueOrThrow({ where: { id: authOf(req).societyId } });
  const preview = parseWorkbook(req.file.buffer, str(society.interestRate));
  const existing = await prisma.member.findMany({ where: { societyId: society.id }, select: { name: true } });
  const names = new Set(existing.map((member) => member.name));
  const duplicates = preview.rows.filter((row) => names.has(row.name)).map((row) => row.name);
  res.json({ ...preview, duplicates, canImport: existing.length === 0 && preview.validations.every((row) => row.level !== "error") });
}));

api.post("/import/confirm", requireAuth, requireStaff, asyncRoute(async (req, res) => {
  const body = z
    .object({
      confirm: z.literal(true),
      reason: reasonString,
      period: periodString,
      rows: z.array(z.object({
        name: z.string().min(1).max(120),
        totalShares: moneyString,
        loanOutstanding: moneyString,
        monthlyShare: moneyString,
        sharePending: moneyString.optional(),
        previousInterest: moneyString,
        currentInterest: moneyString,
        principal: moneyString,
        penalty: moneyString,
      })).min(1).max(500),
    })
    .parse(req.body);
  try {
    res.status(201).json(await importRegister(authOf(req), body));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : "The register could not be posted";
    if (message.includes("Unique constraint") || (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "P2002")) {
      throw new HttpError(409, "This society already has an open month for that date. Open Import again and post once more.");
    }
    throw new HttpError(400, message);
  }
}));

api.get("/backup", requireAuth, requireOwner, asyncRoute(async (req, res) => {
  const societyId = authOf(req).societyId;
  const [society, members, loans, payments, ledger, distributions, months] = await Promise.all([
    prisma.society.findUnique({ where: { id: societyId } }),
    prisma.member.findMany({ where: { societyId } }),
    prisma.loan.findMany({ where: { societyId }, include: { transactions: true } }),
    prisma.payment.findMany({ where: { societyId }, include: { allocations: true } }),
    prisma.ledgerEntry.findMany({ where: { societyId } }),
    prisma.interestDistribution.findMany({ where: { societyId }, include: { entries: true } }),
    prisma.accountingMonth.findMany({ where: { societyId } }),
  ]);
  res.setHeader("Content-Disposition", "attachment; filename=society-backup.json");
  res.json({ exportedAt: new Date().toISOString(), society, members, loans, payments, ledger, distributions, months });
}));
