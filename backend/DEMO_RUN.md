# Phase 3 local demo run

Use frontend origin `http://127.0.0.1:5173` and API base `http://127.0.0.1:3000/api`.
Reason: keeping one hostname consistent lets the Secure, SameSite=Strict refresh cookie persist.

## Services and safety

This run used the existing 127.0.0.1 PostgreSQL development database
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
if ($testDb.Host -notin @('127.0.0.1','::1') -or $testDb.AbsolutePath.TrimStart('/') -ne 'testing_only') {
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
route cache headers. The fake payment flow also uses a verified signed webhook,
the PostgreSQL inbox/worker, and stored order/payment state.

**FAKED or development-only behavior:** email delivery uses the development
outbox; seller identity verification is manually simulated; the demo Admin
approval is a local demonstration; payout guard checks do not send money.
Checkout and system refunds use the local fake gateway only. There is no live
payment provider, real payout, external email sender, or identity provider.

## Run the buyer demo in the browser

Use only a disposable local demo database with a published, available listing
and a buyer account. Configure the ignored `.demo.env` as described below,
including the fake gateway, webhook, and `PUBLIC_BASE_URL` settings. Start the
API and worker in separate PowerShell terminals:

```powershell
Set-Location D:\Havuor\marketplace\backend
node --env-file-if-exists=.demo.env src/server.js
```

```powershell
Set-Location D:\Havuor\marketplace\backend
node --env-file-if-exists=.demo.env worker.js
```

Start Vite in another terminal:

```powershell
Set-Location D:\Havuor\marketplace\frontend
$env:VITE_API_BASE_URL = 'http://127.0.0.1:3000/api'
npm.cmd run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/listing/<listing-id>`, sign in as the buyer, and
select **Buy**. Complete the delivery address and reservation form; the order
screen shows the server-returned amounts. Select **Pay now**, then choose
**Pay (success)** on the local fake checkout. The browser returns to the
payment confirmation screen, which shows funded only after the worker accepts
the verified event. **My orders** is available in the header.

For failure, select **Fail** on the fake checkout. The return screen reports
the server's failed payment state; **Retry payment** opens the order screen,
where **Pay now** creates a retry. For the late-payment/refund variant, create
the payment intent and set that reservation's expiry into the past in the
disposable database before selecting **Pay (success)**. The browser reports
the server's late-payment refund state; use the SQL in the next section.
Returning from fake checkout never counts as proof of payment.

## Buy and reservation demo

Use only a disposable local demo database for payment demonstrations. Set
`PAYMENTS_ENABLED=1`, `PAYMENT_GATEWAY_PROVIDER=fake`,
`PUBLIC_BASE_URL=http://127.0.0.1:5173`, and
`PAYMENT_WEBHOOK_URL=http://127.0.0.1:3000/api/webhooks/payments/fake` for
both the API and worker. Generate a fresh `FAKE_GATEWAY_WEBHOOK_SECRET` locally
with at least 32 random bytes, use the same value in both processes, and keep it
only in ignored local configuration such as `backend/.demo.env`. Never commit
or paste the secret. Start PostgreSQL, Redis, the API, and worker as described
above. Sign in as a buyer and use the seeded `Lahore Demo` city, enabled by
`demo:seed`. Send the authenticated request to
`POST /api/listings/{listingId}/buy` with a delivery address:

```json
{
  "address": {
    "recipientName": "Demo Buyer",
    "phone": "+15551234567",
    "cityId": "<Lahore Demo city ID>",
    "addressLine1": "12 Demo Street"
  }
}
```

Expect HTTP 201 with `status: "reserved"`, an `orderId`, a `reservationId`,
`expiresAt`, and server-calculated `itemPrice`, `deliveryFee`, and `total`.
Then follow the successful fake-checkout path:

1. POST `/api/orders/{orderId}/payment`; the response contains the stored
   amount/currency and a local fake checkout URL.
2. Open that URL and select **Pay (success)**. The fake checkout signs the
   event and POSTs it to the real `/api/webhooks/payments/fake` route.
3. The route stores the verified event and durable worker job before returning
   success. Poll `GET /api/orders/{orderId}/payment` until `orderStatus` is
   `funded` and payment status is `succeeded`.

The failure-and-retry path is: choose **Fail** on the fake checkout, poll until
the payment status is `failed`, POST `/api/orders/{orderId}/payment` again to
create a new attempt with a new idempotency key, then use its checkout URL and
select **Pay (success)**.

For the late-payment path, first create the reservation and payment intent,
then—only in the disposable demo database—set that reservation's `expires_at`
into the past before selecting **Pay (success)**. The worker records the
payment as `late`, leaves the reservation/order unfunded, and creates one
full-amount `system_expiry` refund request, then enqueues it for the refund
worker. The worker executes it through the local fake gateway. Check that the
refund row is `succeeded` and that exactly one `ledger_entries` row exists for
it with `entry_type = 'refund'` and a negative amount. The order and reservation
remain unchanged by the refund worker.

Use the `reservationId` returned by Buy in this disposable-database SQL:

```sql
UPDATE reservations
SET expires_at = now() - INTERVAL '1 minute'
WHERE id = '<reservationId>' AND status = 'active';
```

Returning to the site or polling payment status never funds an order; only the
verified webhook worker does. The listing becomes sold after successful
funding and the transactional listing-search/page-snapshot sync jobs run.

## Scheduled money maintenance

The worker (not the API process) schedules reservation expiry every minute,
the unhanded-over funded-order refund sweep every five minutes, and money
reconciliation every ten minutes. The worker logs only processed, skipped, and
failed counts. To demonstrate expiry in a disposable demo database, temporarily
set `platform_settings.reservation_minutes` to `1`, create a reservation, and
wait for it to expire and the next worker sweep; restore the setting afterward.
To demonstrate the 72-hour sweep, use a funded order with no handover and move
its deadline into the past while preserving the database's 72-hour consistency
constraint:

```sql
UPDATE orders
SET funded_at = now() - INTERVAL '73 hours',
    handover_deadline_at = now() - INTERVAL '1 hour'
WHERE id = '<orderId>'
  AND status IN ('funded', 'seller_preparing')
  AND handed_over_at IS NULL;
```

Reconciliation requeues stale refund and webhook work and looks up old pending
payments through the selected fake gateway; any final outcome is still applied
by the normal webhook processing path. No real payment provider is used.

## Successful demo transcript

The following is a historical Phase 3 smoke transcript; its checkout-placeholder
line predates the fake hosted-checkout and webhook-worker flow documented above.
It is the complete successful `npm.cmd run demo:smoke` output from that run.
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

## Admin demo

On a local development setup, create an Admin interactively with the bootstrap
command. Follow its password and authenticator enrollment prompts; keep the
credentials and TOTP seed only in local secret storage:

```powershell
Set-Location D:\Havuor\marketplace\backend
npm.cmd run admin:create
```

With the API and frontend running, open `http://127.0.0.1:5173/admin/login`,
sign in with the Admin email and password, then enter the current authenticator
code. Use **Orders** to open a funded order and record its courier handover,
then open an eligible handed-over order and mark it delivered. After the hold
and complaint windows have elapsed, open the held order and use **Release
payout** to record the manual payout reference and note. Use **Exceptions** to
review and resolve an unresolved delivery exception. Use **Disputes** to review
the case and evidence, then record a supported full-release or full-refund
resolution. Dispute resolution records the decision; it does not itself issue a
refund or external payout.

### Completing a dispute refund

For a buyer-favour resolution, the Admin decision moves no money and records a
`dispute_refund_required` exception. The first Admin requests the full
refundable balance from the exception's **Request a refund** link, and a
different Admin approves it with a fresh authenticator step-up. After the
gateway refund succeeds, the worker marks the payment refunded and closes the
exception automatically with an audit note naming the refund; the payout hold
is unchanged and payout release remains blocked. A resolution note alone
cannot close this exception.

All six manual-refund Admin routes apply the `adminOps` limiter after their
permission check.
