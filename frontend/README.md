# Poshaak frontend

React and Vite frontend workspace. It currently provides a responsive development
preview and reads public main-category data from the backend when the API is
available. Authentication and protected seller/admin actions are intentionally
not implemented here.

## Requirements

- Node.js 22.12 or newer (the backend also requires Node.js 22.12+).
- The package lockfile is committed; use `npm ci` for a clean dependency install.

## Run locally on Windows PowerShell

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

For live API requests, start the backend separately and configure its local
`CORS_ORIGINS` allowlist to include `http://localhost:5173`. Configure the
backend's development `DATABASE_URL`, `REDIS_URL`, and `JWT_ACCESS_SECRET` only
in its ignored local `.env`; do not use the disposable `testing_only` database
as the application database. The frontend remains viewable if the API is down;
the category section will show an unavailable state.

## Checks

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

The tests use Node's built-in test runner and require no additional dependency.
The production build does not emit source maps. SEO titles, descriptions, URL
rules, and search-oriented headings remain subject to the project SEO discussion
gate; the HTML document title is still the Vite starter default for now.
