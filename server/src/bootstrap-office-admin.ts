import { loadServerEnv } from "./lib/env.js";
import bcrypt from "bcryptjs";
import { DEMO } from "./seed.js";
import { prisma } from "./lib/prisma.js";

loadServerEnv();
const url = (process.env.DATABASE_URL ?? "").trim();
const localEmbedded = !url || /:54331\//.test(url);
if (process.env.NODE_ENV === "production" && !localEmbedded) {
  console.error("bootstrap:office is for local dev / embedded DB only (not hosted production).");
  process.exit(1);
}

const password = process.env.SOCIETY_OFFICE_PASSWORD ?? DEMO.ownerPassword;
const office =
  (await prisma.user.findFirst({ where: { username: "office", role: "OWNER" } })) ??
  (await prisma.user.findFirst({ where: { mobile: DEMO.ownerMobile, role: "OWNER" } }));

if (!office) {
  console.error("No society office user found. Load the demo register (empty DB + npm run dev) or create a society first.");
  process.exit(1);
}

await prisma.user.update({
  where: { id: office.id },
  data: {
    username: "office",
    passwordHash: await bcrypt.hash(password, 10),
    isActive: true,
  },
});
console.log(`Society admin username: office`);
console.log("Reset office password.");
await prisma.$disconnect();
