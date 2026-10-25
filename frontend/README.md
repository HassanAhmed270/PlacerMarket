# Poshaak frontend

React and Vite frontend for the Poshaak marketplace. It provides public browsing,
protected customer messaging/favorites/notifications, seller listing tools, and
moderation queues using the backend API.

## Requirements

- Node.js 22.12 or newer (the backend also requires Node.js 22.12+).
- The package lockfile is committed; use `npm ci` for a clean dependency install.

## Run locally on Windows PowerShell

Start local PostgreSQL and Redis. Create a dedicated, empty **development**
database for the backend; do not use `testing_only`, which is reserved for
disposable integration tests. In PowerShell terminal 1, configure the ignored
backend `.env` with that development `DATABASE_URL`,
`REDIS_URL=redis://localhost:6379`, and
`CORS_ORIGINS=http://localhost:5173`. Keep `TEST_DATABASE_URL` on
`testing_only`. See the backend README for the database setup details.

Then set up and start the backend:

```powershell
Set-Location D:\Havuor\marketplace\backend
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci
npm.cmd run db:setup
$jwtBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($jwtBytes)
$env:JWT_ACCESS_SECRET = [Convert]::ToBase64String($jwtBytes)
[Array]::Clear($jwtBytes, 0, $jwtBytes.Length)
npm.cmd run dev
```

`db:setup` runs migrations and seeds the configured development database, so
confirm the `DATABASE_URL` target before running it. The JWT secret is
generated without printing it and is valid only in this PowerShell session;
generate it again in a new terminal or use a secure local secret store. Never
put it in frontend `VITE_*` variables or commit it.

In PowerShell terminal 2, run the frontend:

```powershell
Set-Location D:\Havuor\marketplace\frontend
npm.cmd ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev
```

Open <http://localhost:5173>. Vite is configured to bind to `127.0.0.1:5173`
and fail if that port is already in use.

`VITE_API_BASE_URL` is a public API origin and defaults to
`http://localhost:3000/api`; see `.env.example`. Vite exposes `VITE_*` values in
the browser bundle, so never put credentials, tokens, or other secrets there.

The backend requires Redis to be reachable at the configured `REDIS_URL` before
it starts. Its `CORS_ORIGINS` allowlist must include `http://localhost:5173`.
The frontend remains viewable if the API is down; the category section will
show an unavailable state.

## Screens

- `/favorites`, `/inbox`, `/inbox/:conversationId`, and `/notifications` require
  an authenticated session.
- Open chats poll every 15 seconds; inbox and unread notification data refresh
  every 60 seconds.
- `/seller/listings` offers managed color, brand, and fabric choices plus custom
  values that remain pending until approved. SEO recommendations are labeled
  as recommendations from seller details; custom text is checked for length
  and replica rules before submission.
- `/moderation` includes listing/revision SEO review and the custom-attribute
  approval queue, subject to API permissions.
- `/about`, `/how-it-works`, `/terms`, `/privacy`, `/help`, and `/contact` are
  clearly marked drafts and set `noindex,follow`. Their text makes no refund,
  return, or payment promises.

## Checks

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run check:bundle
```

The tests use Node's built-in test runner and require no additional dependency.
The production build does not emit source maps.
