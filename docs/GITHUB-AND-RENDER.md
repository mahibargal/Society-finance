# GitHub and Render

## What goes to GitHub

- Application code (`client/`, `server/src/`, shared config).
- Templates: `server/.env.*.example`, `local-dev.example/` (dev script **templates** only).
- **Not** committed: `node_modules`, `local-dev/`, `.env` files, uploads, embedded Postgres data, or dev wipe/heal scripts under `server/src/scripts/` (see `.gitignore`).

Before the first push, confirm no secrets:

```bash
git status
# Must not list server/.env.development, server/.env.production, or JWT/DB passwords in tracked files
```

## Push to GitHub

```bash
git init -b main
git add -A
git status   # review
git commit -m "Initial production-ready society finance app"
```

Create an empty repo on GitHub (no README if you already have one), then:

```bash
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

Or with GitHub CLI:

```bash
gh auth login
gh repo create YOUR_REPO --private --source=. --remote=origin --push
```

## Connect Render

1. [Render](https://render.com) → **New → Blueprint** and point at `render.yaml`, **or** **New → Web Service** and connect the GitHub repo manually.
2. Add **PostgreSQL**; set `DATABASE_URL` on the web service (internal URL).
3. Set env vars from `server/.env.production.example` (see [DEPLOY-RENDER.md](./DEPLOY-RENDER.md)).
4. **Build:** `npm install && npm run build`
5. **Start:** `npm run start`
6. **Health check path:** `/api/health`

After deploy, set `CLIENT_ORIGIN` to your `https://….onrender.com` URL and redeploy if needed.

## Local dev scripts after clone

```bash
npm run local-dev:init
npm run wipe:kranti   # only on your machine, uses local-dev/
```
