import "./load-env.js";
import { ensureOpenStatements } from "../server/src/services/books.js";
import { prisma } from "../server/src/lib/prisma.js";

const society = await prisma.society.findFirst({
  where: { name: { contains: "क्रांती" } },
  select: { id: true, name: true },
});
if (!society) throw new Error("Kranti society not found");
const owner = await prisma.user.findFirst({
  where: { societyId: society.id, role: "OWNER", username: "office" },
});
if (!owner) throw new Error("office user not found");
await ensureOpenStatements({
  userId: owner.id,
  societyId: society.id,
  role: "OWNER",
  memberId: null,
  name: owner.name,
  tokenVersion: owner.tokenVersion,
});
console.log("Healed", society.name);
await prisma.$disconnect();
