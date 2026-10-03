import "./load-env.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appEnvironment, SERVER_ROOT } from "../server/src/lib/env.js";
import { prisma } from "../server/src/lib/prisma.js";
import { wipeSocietyBooks } from "../server/src/scripts/wipe-society-books.js";

const LOCAL_DEV_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** श्री क्रांतीसूर्य भगतसिंह क्रिड़ेट सोसायटी — loose match for ड़/ड/िंग/िंह spelling. */
const NAME_MARK = "क्रांतीसूर्य";
const NAME_MARK_ALT = "भगतसिं";

export async function wipeKrantiSocietyData() {
  const societies = await prisma.society.findMany({
    where: {
      AND: [{ name: { contains: NAME_MARK } }, { name: { contains: NAME_MARK_ALT } }],
    },
    select: { id: true, name: true },
  });
  if (societies.length === 0) {
    const fallback = await prisma.society.findMany({
      where: { name: { contains: NAME_MARK } },
      select: { id: true, name: true },
    });
    if (fallback.length === 0) throw new Error(`No society name contains ${NAME_MARK}`);
    if (fallback.length > 1) {
      throw new Error(
        `Multiple societies match ${NAME_MARK}: ${fallback.map((row) => row.name).join(" | ")}. Pass society id to wipe:data instead.`,
      );
    }
    societies.push(fallback[0]!);
  }
  const results = [];
  for (const society of societies) {
    results.push({ ...(await wipeSocietyBooks(society.id)), matchedName: society.name });
  }
  return results;
}

function databaseUrlFromEnvFile(name: string) {
  const file = path.join(SERVER_ROOT, name);
  if (!fs.existsSync(file)) return null;
  const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL=(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function maskDatabaseUrl(url: string) {
  return url.replace(/:([^:@/]+)@/, ":***@");
}

async function printWipeResults(wiped: Awaited<ReturnType<typeof wipeKrantiSocietyData>>) {
  for (const row of wiped) {
    console.log(`Cleared ${"matchedName" in row ? row.matchedName : row.name}`);
    console.log(`Open month ${row.period}. Rate ${row.interestRate} unchanged.`);
    console.log(`Staff still signed in: ${row.staff.join(", ")}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const once = process.argv.includes("--once") || process.env.WIPE_KRANTI_ONCE === "1";

  if (!once && appEnvironment() === "development") {
    const urls = [
      ...new Set(
        [
          databaseUrlFromEnvFile(".env.development"),
          databaseUrlFromEnvFile(".env.production"),
          process.env.DATABASE_URL,
        ].filter(Boolean),
      ),
    ] as string[];
    if (urls.length <= 1) {
      const wiped = await wipeKrantiSocietyData();
      await printWipeResults(wiped);
    } else {
      for (const url of urls) {
        console.log(`\n--- ${maskDatabaseUrl(url)} ---`);
        const result = spawnSync(
          "npx",
          ["tsx", path.join(LOCAL_DEV_ROOT, "wipe-kranti-society.ts"), "--once"],
          {
            cwd: path.join(LOCAL_DEV_ROOT, ".."),
            stdio: "inherit",
            shell: true,
            env: { ...process.env, DATABASE_URL: url, WIPE_KRANTI_ONCE: "1" },
          },
        );
        if (result.status !== 0) process.exitCode = result.status ?? 1;
      }
      await prisma.$disconnect();
      process.exit(process.exitCode ?? 0);
    }
  } else {
    const wiped = await wipeKrantiSocietyData();
    await printWipeResults(wiped);
  }
  await prisma.$disconnect();
}
