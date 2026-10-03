# Deploy on Render

One **Web Service** serves the API and the built client (`client/dist`). A **PostgreSQL** database holds production data.

## 1. PostgreSQL

1. In Render: **New → PostgreSQL** (note the **Internal Database URL**).
2. Use that as `DATABASE_URL` on the web service.

## 2. Web service

**New → Web Service** → connect your GitHub repo.

| Setting | Value |
|--------|--------|
| **Root directory** | *(repo root)* |
| **Runtime** | Node |
| **Build command** | `npm install --include=dev && npm run build` |
| **Start command** | `npm run start` |
| **Instance type** | Free or paid |

### Environment variables

Match `server/.env.production.example` in the Render dashboard (no need to upload a file):

| Key | Value |
|-----|--------|
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` |
| `SKIP_DEMO_SEED` | `1` |
| `DATABASE_URL` | Internal URL from Render Postgres |
| `JWT_SECRET` | Long random string (Render “Generate” is fine) |
| `CLIENT_ORIGIN` | `https://<your-service>.onrender.com` |
| `SKIP_PRISMA_GENERATE` | `1` (optional; build already runs `prisma generate`) |

Local production smoke test: copy `server/.env.production.example` → `server/.env.production`, fill values, run `npm run start`.

On start, the server runs `prisma db push` against `DATABASE_URL` and does **not** load the June–October demo register.

## 3. First login (main admin)

Production does not auto-create `main`. Pick **one** method:

### A — Setup page (recommended on Render)

1. In the web service **Environment**, add `MAIN_ADMIN_SETUP_TOKEN` (at least 16 random characters). Save and redeploy.
2. Open `https://YOUR-SERVICE.onrender.com/setup` (link also appears on the login page).
3. Enter the token, choose username/password, submit → you land on **Societies** (`/platform`).
4. **Remove** `MAIN_ADMIN_SETUP_TOKEN` from Render and redeploy so the page cannot be used again.

### B — Bootstrap from your PC

```powershell
cd server
$env:DATABASE_URL = "PASTE_RENDER_EXTERNAL_DATABASE_URL"
$env:NODE_ENV = "development"
$env:APP_ENV = "development"
npx tsx src/bootstrap-main-admin.ts
```

Sign in as username `main`, password `Main@2026` (change after login).

## 4. Society admin (office / abc / …)

Sign in as **main admin** → **Societies** → **Add a society admin** → choose **New society** or **Existing society**. That user signs in at `/` and uses `/app` (not `/platform`).

## 5. Optional: client on a separate Static Site

If you split UI and API:

1. **Static Site**: build `npm run build -w client`, publish `client/dist`.
2. Set the static site’s API base URL (would require a small client change to use `VITE_API_URL`); the default build expects **same origin** (`/api` on the web service).

Recommended: **single web service** (API + static files) as configured in `server/src/app.ts`.

## 6. Local dev scripts (wipe, heal)

Not deployed. See [local-dev.example/README.md](../local-dev.example/README.md).
