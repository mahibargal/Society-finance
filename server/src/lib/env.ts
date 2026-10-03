import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type AppEnvironment = "development" | "production" | "test";

/** Which env file set to load. Render sets NODE_ENV=production; local dev uses development. */
export function appEnvironment(): AppEnvironment {
  const raw = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

/** Active gitignored file (not the `.example` template). */
export function activeEnvFileName(): string {
  const mode = appEnvironment();
  if (mode === "production") return ".env.production";
  if (mode === "test") return ".env.development";
  return ".env.development";
}

export function activeEnvFilePath(): string {
  return path.join(SERVER_ROOT, activeEnvFileName());
}

let envLoaded = false;

/** Load server env files without overriding variables already set (e.g. Render dashboard). */
export function loadServerEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const mode = appEnvironment();
  const candidates =
    mode === "production"
      ? [".env.production"]
      : [".env.development", ".env"];
  for (const name of candidates) {
    dotenv.config({ path: path.join(SERVER_ROOT, name), override: false });
  }
}

if (process.env.VITEST !== "true") {
  loadServerEnv();
}
