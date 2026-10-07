import { loadServerEnv } from "./lib/env.js";

loadServerEnv();
import { execSync } from "node:child_process";
import { ensureDatabase, pushSchema, recoverDatabase } from "./db/ensure.js";

if (!process.env.SKIP_PRISMA_GENERATE && process.env.NODE_ENV !== "development") {
  execSync("npx prisma generate", { stdio: "inherit" });
}
await ensureDatabase();
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    pushSchema();
    break;
  } catch (error) {
    if (attempt === 7) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    await recoverDatabase();
  }
}

const { reconnectPrisma } = await import("./lib/prisma.js");
const { ensureAccess, seedIfEmpty } = await import("./seed.js");
const { isDbConnectionError } = await import("./lib/db-connection.js");

async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isDbConnectionError(error)) throw error;
      await reconnectPrisma();
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw last;
}

const seeded = await withDbRetry(() => seedIfEmpty());
await withDbRetry(() => ensureAccess());
const { createApp } = await import("./app.js");
const app = createApp();
const port = Number(process.env.PORT ?? 4087);
app.listen(port, () => {
  console.log(`Society Finance is running at http://localhost:${port}`);
  if (seeded && process.env.NODE_ENV !== "production") console.log("Loaded the demo register (local dev only).");
});
