/**
 * Capture Society Finance UI screenshots for docs/client-flow-guide/.
 * Prereqs: API running (npm run start -w server), client built (npm run build -w client).
 *
 *   node docs/scripts/capture-flow-screenshots.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(ROOT, "server/.env") });
const prisma = new PrismaClient();
const OUT_DIR = path.resolve(__dirname, "../client-flow-guide/screenshots");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4000";
const VIEWPORT = { width: 1280, height: 900 };

/** @type {{ id: string; title: string; path?: string; staff?: boolean; member?: boolean; before?: (page: import('playwright').Page) => Promise<void> }[]} */
const STEPS = [
  { id: "01-login", title: "Sign-in screen", path: "/" },
  {
    id: "02-staff-home",
    title: "Staff dashboard (open month & totals)",
    path: "/app",
    staff: true,
  },
  { id: "03-members", title: "Member register", path: "/app/members", staff: true },
  {
    id: "04-member-detail",
    title: "Member profile & month-wise history",
    staff: true,
    before: async (page, ctx) => {
      if (!ctx.staff) {
        await logout(page);
        await signInStaff(page.context(), page);
        ctx.staff = true;
      }
      await page.goto(`${BASE}/app/members`, { waitUntil: "networkidle" });
      await page.locator('a[href^="/app/members/"]').first().click({ timeout: 15_000 });
      await page.waitForURL(/\/app\/members\//, { timeout: 10_000 });
    },
  },
  { id: "05-collect", title: "Collect payment", path: "/app/pay", staff: true },
  { id: "06-payments", title: "Payment receipts", path: "/app/payments", staff: true },
  { id: "07-loans", title: "Loans", path: "/app/loans", staff: true },
  { id: "08-interest", title: "Interest pool & distribution", path: "/app/interest", staff: true },
  { id: "09-close-month", title: "Monthly close", path: "/app/close", staff: true },
  { id: "10-reports", title: "Reports hub", path: "/app/reports", staff: true },
  { id: "11-month-sheet", title: "Month sheet (dues)", path: "/app/month-sheet", staff: true },
  { id: "12-settings", title: "Society settings", path: "/app/settings", staff: true },
  { id: "13-platform", title: "Main admin — societies", path: "/platform", before: async (page, ctx) => {
    ctx.staff = false;
    await logout(page);
    await signInMainAdmin(page.context(), page);
  }},
  {
    id: "14-member-home",
    title: "Member home (my dues)",
    path: "/me",
    before: async (page, ctx) => {
      ctx.staff = false;
      await logout(page);
      await signInMember(page.context(), page);
    },
  },
  { id: "15-member-reports", title: "Member reports (read-only)", path: "/me/reports" },
];

async function logout(page) {
  await page.context().clearCookies();
}

function signSession(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing in server/.env");
  return jwt.sign(
    {
      sub: user.id,
      societyId: user.societyId,
      role: user.role,
      memberId: user.memberId,
      name: user.name,
      tv: user.tokenVersion,
    },
    secret,
    { expiresIn: "1h" },
  );
}

async function setSession(context, user) {
  if (!user) throw new Error("No user for session");
  const token = signSession(user);
  await context.addCookies([{ name: "sf_token", value: token, url: BASE }]);
}

async function findStaffUser() {
  if (process.env.SCREENSHOT_STAFF_USER) {
    return prisma.user.findFirst({ where: { username: process.env.SCREENSHOT_STAFF_USER, isActive: true } });
  }
  return prisma.user.findFirst({
    where: { role: { in: ["OWNER", "ADMIN"] }, isActive: true, societyId: { not: null } },
    orderBy: { username: "asc" },
  });
}

async function findMemberUser() {
  if (process.env.SCREENSHOT_MEMBER_USER) {
    return prisma.user.findFirst({ where: { username: process.env.SCREENSHOT_MEMBER_USER, isActive: true } });
  }
  return prisma.user.findFirst({
    where: { role: "MEMBER", isActive: true, memberId: { not: null } },
    orderBy: { username: "asc" },
  });
}

async function findMainAdmin() {
  return prisma.user.findFirst({ where: { role: "MAIN_ADMIN", isActive: true } });
}

async function signInStaff(context, page) {
  await setSession(context, await findStaffUser());
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
}

async function signInMember(context, page) {
  await setSession(context, await findMemberUser());
  await page.goto(`${BASE}/me`, { waitUntil: "networkidle" });
}

async function signInMainAdmin(context, page) {
  await setSession(context, await findMainAdmin());
  await page.goto(`${BASE}/platform`, { waitUntil: "networkidle" });
}


async function shot(page, file) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: file, fullPage: true });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  const manifest = [];

  const session = { staff: false };

  for (const step of STEPS) {
    const file = path.join(OUT_DIR, `${step.id}.png`);
    try {
      if (step.before) {
        await step.before(page, session);
        if (step.path) await page.goto(`${BASE}${step.path}`, { waitUntil: "networkidle" });
      } else if (step.staff) {
        if (!session.staff) {
          await logout(page);
          await signInStaff(page.context(), page);
          session.staff = true;
        }
        if (step.path) await page.goto(`${BASE}${step.path}`, { waitUntil: "networkidle" });
      } else if (step.path) {
        await page.goto(`${BASE}${step.path}`, { waitUntil: "networkidle" });
      }
      await shot(page, file);
      manifest.push({ ...step, file: `screenshots/${step.id}.png`, ok: true });
      console.log(`OK  ${step.id}`);
    } catch (err) {
      manifest.push({ ...step, file: `screenshots/${step.id}.png`, ok: false, error: String(err) });
      console.error(`FAIL ${step.id}`, err);
    }
  }

  await writeFile(
    path.resolve(__dirname, "../client-flow-guide/screenshots-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  await browser.close();
  await prisma.$disconnect();
  console.log(`\nSaved to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
