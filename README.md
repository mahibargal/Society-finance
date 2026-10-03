# Society Finance

Mobile-first PWA for member savings, lending, monthly collections, interest pool distribution, and society reports.

## Local development

```bash
npm install
npm run env:init
# Edit server/.env.development — DATABASE_URL, JWT_SECRET
npm run db:push -w server
npm run dev
```

### Environment files

| File | Purpose |
|------|--------|
| `server/.env.development.example` | Template — **commit to git** |
| `server/.env.development` | Your local DB and secrets — **gitignored** |
| `server/.env.production.example` | Template for Render / prod smoke tests — **commit** |
| `server/.env.production` | Optional local prod test file — **gitignored** |

- **`npm run dev`** loads `.env.development` (demo seed allowed when DB is empty).
- **`npm run start`** uses `NODE_ENV=production` and loads `.env.production` if present; on Render, use the dashboard env vars (they override the file).
- Fix bugs locally with dev env, then push code — production secrets stay on Render or in your local `.env.production` only.

Open http://127.0.0.1:5173 (API on port 4000).

### Demo login shortcuts (optional)

Hidden on the login page by default. In the browser console:

```js
localStorage.setItem("society.showDemoLogins", "1");
location.reload();
```

Local dev can auto-load a demo register when the database is empty (see `server/src/seed.ts`). Production skips that when `NODE_ENV=production` or `SKIP_DEMO_SEED=1`.

### Dev-only data scripts (wipe, heal)

**Not pushed to GitHub** — templates live in `local-dev.example/`; your copy goes in gitignored `local-dev/`.

```bash
npm run local-dev:init   # once: copies local-dev.example → local-dev
npm run wipe:kranti
npm run wipe:data
npm run wipe:data -- <societyId>
npm run dev:check-patil
npm run heal:kranti
```

See [local-dev.example/README.md](local-dev.example/README.md).

## Production / Render

Build and run:

```bash
npm run build
npm run start
```

The server serves `client/dist` and `/api`. Full steps: **[docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md)**, **[docs/GITHUB-AND-RENDER.md](docs/GITHUB-AND-RENDER.md)**, and optional **[render.yaml](render.yaml)**.

## Tests

```bash
npm test
```
