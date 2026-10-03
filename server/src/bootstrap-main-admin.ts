import { loadServerEnv } from "./lib/env.js";
import bcrypt from "bcryptjs";
import { DEMO, ensureMainAdmin } from "./seed.js";
import { prisma } from "./lib/prisma.js";

loadServerEnv();
const url = (process.env.DATABASE_URL ?? "").trim();
const localEmbedded = !url || /:54331\//.test(url);
if (process.env.NODE_ENV === "production" && !localEmbedded) {
  console.error("bootstrap:main is for local dev / embedded DB only (not hosted production).");
  process.exit(1);
}
const created = await ensureMainAdmin();
const main = await prisma.user.findFirst({ where: { role: "MAIN_ADMIN" } });
if (!main) {
  console.error("Could not create or find main admin.");
  process.exit(1);
}
const password = process.env.MAIN_ADMIN_PASSWORD ?? DEMO.mainPassword;
await prisma.user.update({
  where: { id: main.id },
  data: { passwordHash: await bcrypt.hash(password, 10), isActive: true, username: "main" },
});
console.log(`Main admin username: main`);
console.log(created ? "Created new main admin." : "Reset main admin password.");
await prisma.$disconnect();
