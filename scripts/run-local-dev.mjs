import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const localDevDir = path.join(repoRoot, "local-dev");
const scriptName = process.argv[2];

if (!scriptName) {
  console.error("Usage: node scripts/run-local-dev.mjs <script.ts> [args…]");
  process.exit(1);
}

const scriptPath = path.join(localDevDir, scriptName);
if (!fs.existsSync(scriptPath)) {
  console.error(`Missing ${scriptPath}`);
  console.error("One-time setup: copy local-dev.example → local-dev (see local-dev.example/README.md)");
  process.exit(1);
}

const extraArgs = process.argv.slice(3);
const result = spawnSync("npx", ["tsx", scriptPath, ...extraArgs], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    APP_ENV: process.env.APP_ENV ?? "development",
  },
});
process.exit(result.status ?? 1);
