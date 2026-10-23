# Phase 2 local demo run (2026-10-23)

## Configuration and services

The final local values in `backend/.env` were used without changing them:
`DATABASE_URL` resolves to localhost database `poshaak_demo`; `JWT_ACCESS_SECRET`
is present and valid. Neither value is printed here. Migrations 001–012,
`db:seed`, and `demo:seed` completed against that development database. The
ignored `backend/.demo.env` holds generated demo credentials.

Redis at `127.0.0.1:6379` was reachable. The successful demo used logical DB 2
on the same local Redis service so existing hourly development rate-limit
counters were left untouched. The worker processed media across API/worker
processes using shared local-disk storage; fake media storage remains explicit
opt-in and development-only.

Vite routes returned HTTP 200: `/`, `/login`, `/register`, `/account`,
`/seller/listings`, `/moderation`, and `/listing/demo-id`. These are SPA fallback
responses, not browser-level proof that every screen renders correctly. A live
API CORS preflight to `http://127.0.0.1:3000/api/users/cities` from origin
`http://127.0.0.1:5173` returned 204 and allowed that exact origin; methods were
`GET, HEAD, POST, PATCH, DELETE`; headers were `authorization, content-type`.

## Exact PowerShell commands

These commands load configured values from `.env`; do not copy secrets into
shell history or this document. Start a local PostgreSQL database named
`poshaak_demo` and Redis at `127.0.0.1:6379` first.

```powershell
Set-Location D:\Havuor\marketplace\backend
$env:NODE_ENV = 'development'
$env:DEV_FAKES = '1'
node --env-file-if-exists=.env db/migrate.js
node --env-file-if-exists=.env db/seed.js
npm.cmd run demo:seed
```

Start API and worker in separate PowerShell terminals:

```powershell
Set-Location D:\Havuor\marketplace\backend
$env:REDIS_URL = 'redis://localhost:6379/2'
node --env-file-if-exists=.demo.env src/server.js
```

```powershell
Set-Location D:\Havuor\marketplace\backend
$env:REDIS_URL = 'redis://localhost:6379/2'
node --env-file-if-exists=.demo.env worker.js
```

Start Vite in another terminal:

```powershell
Set-Location D:\Havuor\marketplace\frontend
$env:VITE_API_BASE_URL = 'http://127.0.0.1:3000/api'
$env:VITE_DEV_FAKES = '1'
npm.cmd run dev -- --host 127.0.0.1
```

With API and worker running:

```powershell
Set-Location D:\Havuor\marketplace\backend
$env:REDIS_URL = 'redis://localhost:6379/2'
npm.cmd run demo:smoke
```

URLs: Vite `http://127.0.0.1:5173/`; login `/login`; account `/account`;
seller workspace `/seller/listings`; moderator workspace `/moderation`; public
detail `/listing/<listing-id>`; API base `http://127.0.0.1:3000/api`.

Demo Admin email is `demo-admin@poshaak.local`; the seeded candidate is
`demo-seller-candidate@poshaak.local`. Generated passwords and the Admin TOTP
seed remain only in ignored `.demo.env`. The smoke creates a unique seller;
the generated email appears on successful completion. Passwords, email/TOTP
codes, backup codes, and storage keys are omitted. Challenge/email delivery and
seller identity verification are faked/manual development flows. PostgreSQL,
HTTP routes, Redis counters/queue, local media storage, image processing,
moderation, revision concurrency, and public detail are real local services.
No hosted provider, CDN, payment gateway, or real identity provider is used.

## Successful smoke transcript

Earlier attempts on Redis logical DB 0 hit accumulated hourly rate limits. The
successful rerun used logical DB 2 and exited with code 0. No transcript
contains secrets, codes, or storage keys.

```text
> npm.cmd run demo:smoke
1. Registered a new buyer through the API with the seeded demo city.
2. Confirmed the registration email using the code delivered to the development outbox.
3. Completed email-factor login using the second code from the development outbox.
4. Submitted the seller application through the API.
5. Demo Admin signed in with TOTP and approved the seller application.
6. Approved seller signed in again with password and an email code from the development outbox.
7. Seller enrolled an authenticator; ten single-use backup codes were returned (codes omitted from transcript).
8. Seller completed authenticator step-up and saved encrypted bank details (API returned last four only).
9. Payout guard refused disbursement before identity verification.
10. Admin payout view shows changedRecently=true, idVerified=true, and masked last4=6702.
11. Payout guard allows the verified seller; manual ID verification is a development demonstration only.
12. Seller created a listing and uploaded tiny generated PNGs to Front, Back, and Other; the worker produced variants.
13. Moderator confirmed every required photo and approved the listing; public detail contains a processed variant URL and no private storage keys.
14. Concurrent price edit yielded exactly one pending revision; public detail stayed unchanged. Unverified above-threshold approval was refused. After email verification and moderator approval, public price updated and content_version incremented once.
Demo seller: demo-seller-1792751396872-d0d254@example.test. Demo Admin credentials remain in backend/.demo.env; secrets and codes were omitted.
```

Before success, the first run failed image processing because API and worker
used isolated in-memory media adapters. The default was corrected to shared
local disk. A later run exposed a detail-route typo; `demo-smoke.js` now calls
`/api/discovery/listings/:id`.

## Verification results

```text
Backend unit: npm.cmd test -- --runInBand
Test Suites: 39 passed, 39 total
Tests:       487 passed, 487 total

Focused storage regression: npm.cmd test -- --runInBand test/unit/media.service.test.js
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total

Integration: npm.cmd run test:integration -- --runInBand
Test Suites: 7 passed, 7 total
Tests:       98 passed, 98 total

Schema: npm.cmd run db:check-schema
Passed (exit 0)

Backend production audit: npm.cmd audit --omit=dev
found 0 vulnerabilities
Frontend production audit: npm.cmd audit --omit=dev
found 0 vulnerabilities
Backend full audit: npm.cmd audit
28 high severity vulnerabilities in the Jest 29 development dependency chain
Frontend full audit: npm.cmd audit
found 0 vulnerabilities

Frontend lint: npm.cmd run lint
Passed (oxlint, exit 0)
Frontend test: npm.cmd test
# tests 5
# pass 5
# fail 0
Frontend build: npm.cmd run build
Passed (20 modules, exit 0)
```

The integration harness used the separately guarded `testing_only` database;
the development migration/seed/demo run used `poshaak_demo`. The full Jest-chain
audit is owner-triaged under SEC-31; it does not stop Phase 2. Only a nonzero
`npm audit --omit=dev` in either package stops work. Keep Jest 29 through Phase
2; schedule Jest 29 -> 30 as the separate immediate follow-up.
