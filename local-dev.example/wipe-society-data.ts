import "./load-env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../server/src/lib/prisma.js";
import { wipeAllSocietyBooks, wipeSocietyBooks } from "../server/src/scripts/wipe-society-books.js";

async function main() {
  const societyId = process.argv[2];
  const wiped = societyId ? [await wipeSocietyBooks(societyId)] : await wipeAllSocietyBooks();
  for (const row of wiped) {
    console.log(`Cleared books for ${row.name}`);
    console.log(`Open month ${row.period}. Interest rate ${row.interestRate} unchanged.`);
    console.log(`Staff logins kept: ${row.staff.join(", ")}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
