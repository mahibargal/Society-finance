import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { AuthUser } from "../middleware/auth.js";
import { money } from "../engine/finance.js";
import { HttpError } from "../lib/http.js";
import { dec } from "../lib/money-db.js";
import { prisma } from "../lib/prisma.js";
import { calendarPeriod, statementDateFor, utcDate } from "../lib/format.js";

const USERNAME = /^[A-Za-z][A-Za-z0-9._-]{2,31}$/;

export function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!USERNAME.test(username)) {
    throw new HttpError(400, "Username must start with a letter and use 3–32 letters, numbers, dots, or hyphens");
  }
  return username;
}

async function assertUsernameFree(username: string, exceptUserId?: string) {
  const existing = await prisma.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } });
  if (existing && existing.id !== exceptUserId) throw new HttpError(409, `Username ${username} is already in use`);
}

export async function listPlatform() {
  const societies = await prisma.society.findMany({
    orderBy: { name: "asc" },
    include: {
      users: {
        where: { role: { in: ["OWNER", "ADMIN"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, username: true, role: true, isActive: true },
      },
      _count: { select: { members: true } },
    },
  });
  return {
    societies: societies.map((society) => ({
      id: society.id,
      name: society.name,
      members: society._count.members,
      admins: society.users,
    })),
  };
}

export async function createSocietyAdmin(
  auth: AuthUser,
  input: { societyId?: string; societyName?: string; name: string; username: string; password: string; monthlyShare?: string },
) {
  const username = normalizeUsername(input.username);
  await assertUsernameFree(username);
  const passwordHash = await bcrypt.hash(input.password, 10);
  const name = input.name.trim();
  if (name.length < 2) throw new HttpError(400, "Enter the admin's name");

  if (input.societyId) {
    const society = await prisma.society.findUnique({ where: { id: input.societyId } });
    if (!society) throw new HttpError(404, "Society not found");
    const admin = await prisma.user.create({
      data: {
        societyId: society.id,
        role: "ADMIN",
        name,
        username,
        passwordHash,
      },
    });
    await prisma.auditLog.create({
      data: {
        societyId: society.id,
        actorId: auth.userId,
        actorName: auth.name,
        action: "Created society admin",
        entityType: "User",
        entityId: admin.id,
        reason: "Main admin created a society admin",
        newValue: { username, name, society: society.name },
      },
    });
    return { id: admin.id, username, societyId: society.id, societyName: society.name, role: admin.role };
  }

  const societyName = input.societyName?.trim() ?? "";
  if (societyName.length < 2) throw new HttpError(400, "Choose an existing society or enter a new society name");
  const period = calendarPeriod();
  const created = await prisma.$transaction(async (tx) => {
    const society = await tx.society.create({
      data: {
        name: societyName,
        interestRate: dec("0.010000"),
        defaultMonthlyShare: dec(money(input.monthlyShare ?? "500.00").toFixed(2)),
        paymentAllocationOrder: "SHARE,PREVIOUS_INTEREST,CURRENT_INTEREST,PRINCIPAL,PENALTY",
      },
    });
    await tx.accountingMonth.create({
      data: {
        societyId: society.id,
        period,
        status: "OPEN",
        statementDate: utcDate(statementDateFor(period)),
      },
    });
    const admin = await tx.user.create({
      data: {
        societyId: society.id,
        role: "OWNER",
        name,
        username,
        passwordHash,
      },
    });
    await tx.auditLog.create({
      data: {
        societyId: society.id,
        actorId: auth.userId,
        actorName: auth.name,
        action: "Created society and admin",
        entityType: "Society",
        entityId: society.id,
        reason: "Main admin opened a society",
        newValue: { society: societyName, username, name },
      },
    });
    return { id: admin.id, username, societyId: society.id, societyName: society.name, role: admin.role };
  });
  return created;
}

/** Main admin sets a society admin password. The new password is never written to the audit log. */
export async function setSocietyAdminPassword(auth: AuthUser, userId: string, next: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { society: { select: { name: true } } },
  });
  if (!user || (user.role !== "OWNER" && user.role !== "ADMIN")) {
    throw new HttpError(404, "That society admin was not found");
  }
  if (!user.isActive) throw new HttpError(400, "This admin is not active");
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(next, 10), tokenVersion: { increment: 1 } },
  });
  await prisma.auditLog.create({
    data: {
      societyId: user.societyId ?? "",
      actorId: auth.userId,
      actorName: auth.name,
      action: "Reset society admin password",
      entityType: "User",
      entityId: user.id,
      reason: "Main admin set a new password",
      newValue: { username: user.username, society: user.society?.name ?? "" },
    },
  });
  return { id: user.id, username: user.username, societyName: user.society?.name ?? "" };
}

export async function setSocietyAdminActive(auth: AuthUser, userId: string, active: boolean, reason: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { society: { select: { name: true } } },
  });
  if (!user || (user.role !== "OWNER" && user.role !== "ADMIN")) {
    throw new HttpError(404, "That society admin was not found");
  }
  if (user.id === auth.userId) throw new HttpError(400, "You cannot change your own admin login here");
  if (user.isActive === active) {
    return { id: user.id, username: user.username, isActive: user.isActive, societyName: user.society?.name ?? "" };
  }
  if (!active && user.role === "OWNER" && user.societyId) {
    const otherOwners = await prisma.user.count({
      where: { societyId: user.societyId, role: "OWNER", isActive: true, id: { not: user.id } },
    });
    if (otherOwners === 0) {
      throw new HttpError(400, "Keep at least one lead admin active so the society can still sign in");
    }
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { isActive: active, tokenVersion: { increment: 1 } },
  });
  await prisma.auditLog.create({
    data: {
      societyId: user.societyId ?? "",
      actorId: auth.userId,
      actorName: auth.name,
      action: active ? "Activated society admin" : "Deactivated society admin",
      entityType: "User",
      entityId: user.id,
      reason,
      newValue: { username: user.username, society: user.society?.name ?? "", active },
    },
  });
  return { id: user.id, username: user.username, isActive: active, societyName: user.society?.name ?? "" };
}

function setupTokenMatches(provided: string) {
  const expected = (process.env.MAIN_ADMIN_SETUP_TOKEN ?? "").trim();
  if (expected.length < 16) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True when production has no main admin yet and MAIN_ADMIN_SETUP_TOKEN is configured. */
export async function mainAdminSetupStatus() {
  const needsMainAdmin = (await prisma.user.count({ where: { role: "MAIN_ADMIN" } })) === 0;
  const token = (process.env.MAIN_ADMIN_SETUP_TOKEN ?? "").trim();
  const tokenConfigured = token.length >= 16;
  return { needsMainAdmin, tokenConfigured, setupEnabled: needsMainAdmin && tokenConfigured };
}

/** One-time hosted setup — not a public signup; requires MAIN_ADMIN_SETUP_TOKEN. */
export async function setupMainAdmin(input: { setupToken: string; username: string; password: string; name?: string }) {
  const status = await mainAdminSetupStatus();
  if (!status.setupEnabled) {
    throw new HttpError(403, "Main admin setup is not available. Sign in, or ask whoever runs the server to create the account.");
  }
  if (!setupTokenMatches(input.setupToken.trim())) {
    throw new HttpError(403, "Setup token is incorrect.");
  }
  const username = normalizeUsername(input.username);
  await assertUsernameFree(username);
  if (input.password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  const name = (input.name?.trim() || "Main admin").slice(0, 80);
  return prisma.user.create({
    data: {
      role: "MAIN_ADMIN",
      name,
      username,
      passwordHash: await bcrypt.hash(input.password, 10),
    },
  });
}
