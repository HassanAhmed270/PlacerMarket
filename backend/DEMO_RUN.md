# Phase 3 local demo run

## Services and safety

This run used the existing localhost PostgreSQL development database
`poshaak_demo` (not `testing_only`) and Redis reachable at
`127.0.0.1:6379`. The development migrations had no pending work and
`db:seed` completed. The guarded `demo:seed` was intentionally not run: this
database already contains the Demo Admin and demo data, and the seed script
requires a clean database. Never reset this shared development database to
make the clean-seed command pass.

The API and worker used the development configuration from ignored
`.demo.env`. The worker uses Redis logical database 2. The smoke API was an
isolated API process on port 3001 with `RATE_LIMIT_SIGNUP_IP_MAX=10`; prior
failed demo attempts had consumed signup allowance on the existing port-3000
API. The frontend and the existing port-3000 API remained available.

Vite returned HTTP 200 for `/`, `/login`, `/register`, `/account`,
`/seller/listings`, `/moderation`, `/listing/demo-id`, `/about`,
`/how-it-works`, `/terms`, `/privacy`, `/help`, `/contact`, and
`/checkout/soon`. These are SPA fallback responses, not browser-level proof of
rendered UI. The smoke also fetched the checkout route and its screen module.
An API CORS preflight from `http://127.0.0.1:5173` to port 3000 returned 204
and allowed that origin.

## Exact PowerShell commands

Start local PostgreSQL with database `poshaak_demo` and Redis in WSL first.
Do not print or paste values from `.env` or `.demo.env`; they contain secrets.
Migrations and the idempotent platform seed were run as follows:

```powershell
Set-Location D:\Havuor\marketplace\backend
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run db:check-schema
```

Only run the clean-database demo seed on a disposable, empty local demo
database. It was not run against the existing `poshaak_demo` database:

```powershell
Set-Location D:\Havuor\marketplace\backend
npm.cmd run demo:seed
```

For a fresh seeded setup, start the API and worker in separate PowerShell
windows:

```powershell
Set-Location D:\Havuor\marketplace\backend
node --env-file-if-exists=.demo.env src/server.js
```

```powershell
Set-Location D:\Havuor\marketplace\backend
node --env-file-if-exists=.demo.env worker.js
```

Start the frontend in another window:

```powershell
Set-Location D:\Havuor\marketplace\frontend
$env:VITE_API_BASE_URL = 'http://127.0.0.1:3000/api'
$env:VITE_DEV_FAKES = '1'
npm.cmd run dev -- --host 127.0.0.1
```

On this machine, the smoke API process was started on port 3001 to avoid the
already-consumed signup-IP limit on port 3000. The command was:

```powershell
Set-Location D:\Havuor\marketplace\backend
$env:PORT = '3001'
$env:RATE_LIMIT_SIGNUP_IP_MAX = '10'
node --env-file-if-exists=.demo.env src/server.js
```

With PostgreSQL, Redis, API, worker, and Vite running, the smoke command was:

```powershell
Set-Location D:\Havuor\marketplace\backend
$env:DEMO_API_BASE_URL = 'http://127.0.0.1:3001/api'
npm.cmd run demo:smoke
```

The integration suite uses a separate, guarded `testing_only` database and
Redis logical database 15. The database URL is read from `.env` without
printing it; the guard refuses any other database target:

```powershell
Set-Location D:\Havuor\marketplace\backend
$settings = Get-Content .env
foreach ($line in $settings) {
  if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)\s*$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim('"'), 'Process')
  }
}
if (-not $env:TEST_DATABASE_URL) { throw 'TEST_DATABASE_URL is missing from backend/.env' }
$testDb = [Uri]$env:TEST_DATABASE_URL
if ($testDb.Host -notin @('localhost','127.0.0.1','::1') -or $testDb.AbsolutePath.TrimStart('/') -ne 'testing_only') {
  throw 'Integration tests refused an unexpected database target.'
}
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379/15'
npm.cmd run test:integration -- --runInBand
```

## URLs and accounts

- Frontend: `http://127.0.0.1:5173/`
- API: `http://127.0.0.1:3000/api` (demo smoke used
  `http://127.0.0.1:3001/api`)
- API CORS origin: `http://127.0.0.1:5173`
- Sitemap: `http://127.0.0.1:3000/sitemap.xml`
- Demo Admin: `demo-admin@poshaak.local`
- Seeded seller candidate: `demo-seller-candidate@poshaak.local`
- Seller created by the successful smoke:
  `demo-seller-1792922748797-6bf21c@example.test`

Admin passwords and TOTP seeds are only in ignored `backend/.demo.env`.
Generated passwords, verification codes, backup codes, and storage keys are
not part of the transcript.

## REAL vs FAKED

**REAL local behavior:** PostgreSQL migrations and data, Redis-backed queues
and counters, API authorization and CORS, worker processing, local-disk image
uploads and generated variants, listing search indexing, favorites and
messaging persistence, revision approval, snapshots, sitemap output, and
route cache headers.

**FAKED or development-only behavior:** email delivery uses the development
outbox; seller identity verification is manually simulated; the demo Admin
approval is a local demonstration; payout guard checks do not send money.
Checkout is only the “Checkout opens soon” placeholder. There is no live
payment provider, real payout, external email sender, or identity provider.

## Successful demo transcript

The following is the complete successful `npm.cmd run demo:smoke` output.
The generated seller email is non-secret; credentials, verification codes,
backup codes, and storage keys are omitted by the smoke.

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
15. The worker synced the listing into search; a buyer found it by keyword, by filters using an approved color, and by the Roman Urdu synonym.
16. The buyer favorited the listing.
17. Messaging blocked the phone-number attempt and accepted the price-only note; a stranger could not read the conversation.
18. The seller lowered the price by 20%; the new price was immediately live in search and detail.
19. The seller created a 40% price reduction that became a pending revision; the live listing remained unchanged while it awaited review.
20. The listing snapshot included the title, JSON-LD and canonical URL, and the sitemap listed it.
21. When the listing was marked sold, it left search and the detail page showed Sold with similar items.
22. A removed listing returned HTTP 410.
23. The Buy flow reached the checkout-open-soon route and the screen module was served.
24. The route cache policy held for the API and browser-facing public routes.
Demo seller: demo-seller-1792922748797-6bf21c@example.test. Demo Admin credentials remain in backend/.demo.env; secrets and codes were omitted.
```

## Verification results

Results from this S13 run:

```text
Backend unit:
  Set-Location D:\Havuor\marketplace\backend
  $env:EMAIL_CODE_RESEND_SECONDS = '60'
  npm.cmd test -- --runInBand
Test Suites: 46 passed, 46 total
Tests:       581 passed, 581 total

Backend integration: npm.cmd run test:integration -- --runInBand
Test Suites: 1 failed, 12 passed, 13 total
Tests:       2 failed, 123 passed, 125 total
Failures:    known-mismatches.test.js expects discovery.searchListings to
             return an array (descriptionResults.map is not a function);
             public discovery search returned HTTP 503 instead of 200.

Schema: npm.cmd run db:check-schema
Passed (exit 0)

Backend audit: npm.cmd audit
1 high severity vulnerability: body-parser 2.0.0–2.3.0

Frontend audit: npm.cmd audit
found 0 vulnerabilities

Frontend lint: npm.cmd run lint
Passed (oxlint, exit 0)
Frontend tests: npm.cmd test
16 passed, 0 failed

Frontend build: npm.cmd run build
Passed (35 modules transformed)

Frontend bundle: npm.cmd run check:bundle
Largest public route: 75.1 KB gzip (budget: 200 KB)

Frontend routes: all 14 listed routes returned HTTP 200
CORS: OPTIONS http://127.0.0.1:3000/api/users/cities from
      http://127.0.0.1:5173 returned HTTP 204 and allowed that origin
```

The first full unit attempt exposed a missing queue-producer mock in the worker
unit test and a test process with the demo resend override; the mock was
updated, and the full suite passed on rerun with the default resend interval
explicitly set to 60 seconds. The integration suite used `testing_only`; all
demo and migration/seed operations used `poshaak_demo`.
