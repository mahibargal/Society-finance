import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { SERVER_ROOT, activeEnvFilePath, appEnvironment } from "../lib/env.js";

const EMBEDDED_PORT = 54331;
const USER = "society";
const PASSWORD = "society";
const DATABASE = "society";

/** embedded-postgres stops when the instance is garbage-collected; keep one for the API process lifetime. */
let embedded: EmbeddedPostgres | null = null;

/** True only when the app should start the on-disk embedded cluster (port 54331). */
export function usesEmbeddedPostgres() {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) return true;
  return /:(54331)\//.test(url);
}

function ensureSecret() {
  if (appEnvironment() === "production") return;
  const envPath = activeEnvFilePath();
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (!process.env.JWT_SECRET) {
    const fromFile = existing.match(/^JWT_SECRET=(.+)$/m)?.[1]?.trim();
    process.env.JWT_SECRET = fromFile || crypto.randomBytes(32).toString("hex");
  }
  if (!existing.includes("JWT_SECRET=")) {
    const line = `JWT_SECRET=${process.env.JWT_SECRET}\n`;
    if (existing.length === 0) fs.writeFileSync(envPath, line);
    else fs.appendFileSync(envPath, `${existing.endsWith("\n") ? "" : "\n"}${line}`);
  }
}

function postgresAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(1000);
    socket.on("connect", () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      const answer = chunk.toString("utf8");
      finish(answer.startsWith("N") || answer.startsWith("S"));
    });
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPostgres(port: number, attempts = 45) {
  for (let index = 0; index < attempts; index += 1) {
    if (await postgresAlive(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function waitForDatabaseQueries(attempts = 60) {
  const { PrismaClient } = await import("@prisma/client");
  const probe = new PrismaClient();
  try {
    for (let index = 0; index < attempts; index += 1) {
      try {
        await probe.$queryRaw`SELECT 1`;
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

function postmasterPidPath(databaseDir: string) {
  return path.join(databaseDir, "postmaster.pid");
}

function removeStalePostmasterPid(databaseDir: string) {
  const pidPath = postmasterPidPath(databaseDir);
  if (!fs.existsSync(pidPath)) return;
  const pid = Number(fs.readFileSync(pidPath, "utf8").split("\n")[0]?.trim());
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      /* pid file is stale */
    }
  }
  fs.unlinkSync(pidPath);
}

function stopListenersOnPort(port: number) {
  if (process.platform === "win32") {
    const listed = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set<number>();
    for (const line of listed.stdout?.split("\n") ?? []) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const pid = Number(line.trim().split(/\s+/).at(-1));
      if (pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      spawnSync("taskkill", ["/F", "/PID", String(pid), "/T"], { stdio: "ignore" });
    }
    return;
  }
  try {
    execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
  } catch {
    /* none */
  }
}

async function bootCluster(databaseDir: string) {
  if (embedded) return;
  fs.mkdirSync(databaseDir, { recursive: true });
  removeStalePostmasterPid(databaseDir);
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: USER,
    password: PASSWORD,
    port: EMBEDDED_PORT,
    persistent: true,
    authMethod: "password",
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => {
      if (/FATAL|ERROR/.test(message)) console.error(message.trim());
    },
    onError: (message) => console.error(message),
  });
  if (!fs.existsSync(path.join(databaseDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  embedded = pg;
  await pg.createDatabase(DATABASE).catch((error: unknown) => {
    if (!/already exists/i.test(String(error))) throw error;
  });
}

export async function stopEmbeddedDatabase() {
  if (!embedded) return;
  await embedded.stop().catch(() => undefined);
  embedded = null;
}

function rememberEmbeddedUrl() {
  process.env.DATABASE_URL = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${EMBEDDED_PORT}/${DATABASE}?schema=public`;
  // Only persist embedded URL for local production preview — never rewrite .env.development.
  if (appEnvironment() !== "production") return;
  const envPath = path.join(SERVER_ROOT, ".env.production");
  const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `DATABASE_URL=${process.env.DATABASE_URL}`;
  if (!env.includes("DATABASE_URL=")) fs.appendFileSync(envPath, `${line}\n`);
  else if (!env.includes(process.env.DATABASE_URL)) fs.writeFileSync(envPath, env.replace(/^DATABASE_URL=.*$/m, line));
}

const LIVE_DATA = () => path.join(SERVER_ROOT, ".pgdata-live");

/** Restart embedded Postgres when the port is held by a dead or foreign process. */
export async function recoverDatabase() {
  ensureSecret();
  if (!usesEmbeddedPostgres()) {
    if (!(await waitForDatabaseQueries(20))) throw new Error("The database did not respond");
    return;
  }
  if (embedded) {
    await embedded.stop().catch(() => undefined);
    embedded = null;
  }
  stopListenersOnPort(EMBEDDED_PORT);
  removeStalePostmasterPid(LIVE_DATA());
  await bootCluster(LIVE_DATA());
  rememberEmbeddedUrl();
  if (!(await waitForPostgres(EMBEDDED_PORT, 60)) || !(await waitForDatabaseQueries(60))) {
    throw new Error("PostgreSQL did not recover");
  }
}

export async function ensureDatabase() {
  ensureSecret();
  if (!usesEmbeddedPostgres()) {
    if (!(await waitForDatabaseQueries(30))) {
      const url = process.env.DATABASE_URL ?? "";
      const hint =
        url.includes("@localhost:5432") || url.includes("@127.0.0.1:5432")
          ? " In pgAdmin on PostgreSQL 17: run server/sql/setup-external-db.sql (Part 1 on postgres, Part 2 on society), then npm run db:push -w server. Or set DATABASE_URL in server/.env to your postgres user, e.g. postgresql://postgres:YOUR_PASSWORD@localhost:5432/society"
          : " Check server/.env DATABASE_URL and that PostgreSQL is running.";
      throw new Error(`Could not connect to the database.${hint}`);
    }
    return;
  }

  if ((await postgresAlive(EMBEDDED_PORT)) || (await portListening(EMBEDDED_PORT))) {
    if ((await waitForPostgres(EMBEDDED_PORT, 20)) && (await waitForDatabaseQueries(10))) {
      rememberEmbeddedUrl();
      return;
    }
    console.error(`PostgreSQL on port ${EMBEDDED_PORT} is not healthy; recovering…`);
    await recoverDatabase();
    return;
  }

  const directories = [LIVE_DATA(), path.join(SERVER_ROOT, ".pgdata-fresh")];
  let lastError: unknown;
  for (const directory of directories) {
    try {
      removeStalePostmasterPid(directory);
      await bootCluster(directory);
      rememberEmbeddedUrl();
      if (!(await waitForPostgres(EMBEDDED_PORT, 60)) || !(await waitForDatabaseQueries())) {
        throw new Error("Embedded PostgreSQL did not accept connections");
      }
      return;
    } catch (error) {
      lastError = error;
      if (await postgresAlive(EMBEDDED_PORT) && (await waitForDatabaseQueries(5))) {
        rememberEmbeddedUrl();
        return;
      }
      console.error(`Could not open ${path.basename(directory)}.`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The local database did not start");
}

export function pushSchema() {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: process.env,
  });
}
