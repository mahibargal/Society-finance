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

## 3. First login

With demo seed disabled, create access manually:

1. Insert a **MAIN_ADMIN** user (or run `npm run seed -w server` **once** locally against a copy of prod — not recommended on prod).
2. Sign in as main admin → create society owner accounts.

For a fresh production society, use the platform UI after main admin exists, or seed only in local dev.

## 4. Optional: client on a separate Static Site

If you split UI and API:

1. **Static Site**: build `npm run build -w client`, publish `client/dist`.
2. Set the static site’s API base URL (would require a small client change to use `VITE_API_URL`); the default build expects **same origin** (`/api` on the web service).

Recommended: **single web service** (API + static files) as configured in `server/src/app.ts`.

## 5. Local dev scripts (wipe, heal)

Not deployed. See [local-dev.example/README.md](../local-dev.example/README.md).
