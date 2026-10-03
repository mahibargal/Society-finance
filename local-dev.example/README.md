# Local dev tools (not on GitHub / Render)

Wipe, heal, and inspect scripts for **local databases only**. They are **not** in the production codebase.

## Setup (once per machine)

From the repo root:

**Windows PowerShell:**

```powershell
Copy-Item -Recurse -Force local-dev.example local-dev
```

**macOS / Linux:**

```bash
cp -r local-dev.example local-dev
```

The `local-dev/` folder is **gitignored**. Edit scripts there freely; templates stay in `local-dev.example/`.

Requires `server/.env.development` with `DATABASE_URL` (same as `npm run dev`). Run `npm run env:init` from repo root if missing.

## Commands (from repo root)

```bash
npm run wipe:kranti
npm run wipe:data
npm run wipe:data -- <societyId>
npm run dev:check-patil
npm run heal:kranti
```

Or run directly:

```bash
npx tsx local-dev/wipe-kranti-society.ts
```
