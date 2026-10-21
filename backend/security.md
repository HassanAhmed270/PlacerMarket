# security.md — security checklist

Read alongside `rules.md` (Section 9 makes this binding). Same convention as
`specs.md`: **every row has a checkbox**, ticked only when that job is done.

**Legend:** `[ ]` = not done · `[x]` = done

**Enforced by** says what keeps a ticked row true:
- `test` — a Jest test whose `describe`/`test` title names the SEC code
- `hook` — a git hook (`hooks/`)
- `review` — a human checks it at review time; tick only with a dated note in the row
- `n/a-yet` — guards code that doesn't exist yet; can't be ticked until it does

**Tick rule:** tick a row only when (a) the requirement actually holds in the
code, and (b) its enforcement is in place. "I looked and it seemed fine" does
not tick a `test` row. Never weaken or reword a row to make a change pass —
propose the change to the human instead (`rules.md` Sections 1 and 9).

**"Today"** = verified against the delivered code on 2026-10-11 (grep and
`npm audit`), not assumed. Rows marked *(added)* are not on the original
20-item list; they are the same class of problem and were added because
the backend needs them.

**Scope:** this is the backend repo. Rows tagged **Frontend repo** can't be
verified here — they exist so the rule is written down once and copied into
the frontend harness.

**Decided:** auth uses a **JWT in the `Authorization` header** and two-factor on
every login. Buyer email codes, staff TOTP, and first-admin TOTP enrollment are
confirmed; recovery after loss of all factors, seller factors, and step-up remain
parked (specs.md FR-83h, FR-83k). Phase 0 limits are recorded in FR-83d/FR-84b.

**Decided:** the payment model is **escrow through a payment gateway**
(2026-10-13, replaces COD) — see `Phases.md`. Section F covers webhooks and
money integrity; expect a payments section here once Phase 4 starts.

---

## A. Authentication & sessions (JWT in Authorization header)

- [ ] **SEC-01 Passwords hashed server-side.** argon2id (or bcrypt, cost ≥ 12). The client sends the password over TLS, never a hash; `password_hash` never appears in any response or log.
  *Enforced by:* tests `test/unit/users.service.test.js`, `test/smoke/app.test.js`, and `test/integration/known-mismatches.test.js` — FR-01/SEC-01 tests prove server-side Argon2id hashing and no hash in responses. **Partial:** production TLS hosting remains a live check, so this row stays unticked.
- [ ] **SEC-02 JWT secret/keys are strong and external.** ≥ 32 random bytes (HS256) or an RS256 keypair, loaded from env, never committed, never a real value in `.env.example`. The app refuses to start if it's missing or too short. A rotation plan exists.
  *Enforced by:* test · *Partial:* access-token key validation is tested; signing-key rotation awaits the deployment runbook.
- [x] **SEC-03 JWT verification is pinned and strict.** Fixed algorithm (reject `none` and algorithm switching), verify `exp`, `iss`, `aud`; short access-token lifetime (values are configurable; approved defaults in specs.md FR-84a — access token 15 minutes).
  *Enforced by:* `test/unit/jwt.test.js` — SEC-03 verifies pinned algorithm, issuer, audience and expiry.
- [x] **SEC-04 Token transport is the Authorization header.** `Authorization: Bearer …` on every API request. The only cookie is the refresh-token cookie, scoped to the refresh endpoint and never accepted for authorization anywhere else (decided 2026-10-17). SEC-05 depends on that.
  *Enforced by:* `test/unit/users.auth.routes.test.js` and `frontend/src/lib/api.test.js` — SEC-04/05 assert bearer-only protected requests and cookie-only refresh.
- [x] **SEC-05 CSRF.** Live on the refresh endpoint only (rotating refresh-token cookie, decided 2026-10-17): SameSite=Strict plus an Origin check. No other endpoint accepts a cookie, so no other endpoint needs CSRF protection.
  *Enforced by:* `test/unit/users.auth.routes.test.js` — refresh rejects missing/unlisted Origin and asserts secure cookie attributes and scope.
- [ ] **SEC-06 Client-side token storage.** The access token is held in memory only — never `localStorage`/`sessionStorage`. **Frontend repo.** Decided 2026-10-17: a rotating refresh-token cookie (httpOnly, Secure, SameSite=Strict, refresh endpoint only) renews it, so a page reload does not force a new login; the second factor is needed at sign-in only.
  *Enforced by:* review · *Today:* n/a-yet (no auth code yet).
- [x] **SEC-07 Suspended users are rejected immediately** (FR-10), even with a valid unexpired token: check user status on each request, or keep lifetimes short enough that revocation is acceptable (decide and write it down).
  *Enforced by:* `test/integration/known-mismatches.test.js` — SEC-07 rechecks current suspension state in PostgreSQL.
- [ ] **SEC-08 Brute-force protection on login/register/reset.** Redis limits are per IP and per account; responses and timing class do not reveal whether an account exists. Email codes: 3 attempts per code, 60-second resend cooldown, 5/hour and 10/day per address, soft signal at 30/hour per IP (never a block), and 10 failed verifications/hour causes a 15-minute lock. All values are configurable (FR-83d, owner-approved 2026-10-21).
  *Enforced by:* `test/unit/rate-limit.test.js`, `test/unit/email-code-delivery.test.js`, `test/unit/users.email.routes.test.js`, `test/integration/known-mismatches.test.js`, and `test/integration/rate-limit.test.js` (real Redis test requires `TEST_REDIS_URL`). **Partial:** signup/login/reset request limits and email-code verification/send limits are implemented; real Redis verification, live email delivery, global/dispute coverage and proxy forwarding remain pending.
- [x] **SEC-09 Two-factor authentication on every login.** Every login needs a second factor: email codes for ordinary buyers and TOTP for admins/moderators (never email); the first admin enrolls TOTP during the one-time bootstrap command. Passkeys come later (FR-83h). Seller requirements, step-up and recovery after loss of all factors remain parked (FR-83b, FR-83c, FR-83f, FR-83k).
  *Enforced by:* `test/integration/known-mismatches.test.js` — FR-83h/SEC-09 exercises staff TOTP, replay protection and first-admin enrollment.
- [x] **SEC-10 No default or seeded credentials.** The first admin is created by a one-time command run on the server (`npm run admin:create`, decided 2026-10-14), never by an endpoint or a hardcoded password.
  *Enforced by:* `test/integration/known-mismatches.test.js` — FR-84/SEC-10 verifies bootstrap and rejects reruns.

## B. Authorization

- [ ] **SEC-11 Every non-public route is permission-checked on the server** (`requireAuth` + `requirePermission`); hiding a button client-side is never a control.
  *Enforced by:* test · *Today:* **PARTIAL** — the admin router is fully gated and tested. `payments` (`expected-amount`, `confirm-collection`, `reconcile`) and delivery `POST /orders/:id/status` need only a login. No courier/ops role exists in `lib/roles.js`; decided 2026-10-13: only an admin marks Delivered, through a new `order.mark_delivered` permission, and the COD payment routes are replaced in Phase 4.
- [ ] **SEC-12 Object-level authorization (BOLA).** Every handler that takes an id (order, offer, dispute, notification, conversation, listing, …) verifies the caller is a party to it or holds a permission. Test pattern: user A cannot read or change user B's object, on every `:id` route.
  *Enforced by:* test · *Today:* **FAILS** — no ownership check in `getDeliveryTracking`, `getNegotiationHistory` (returns every message and offer on a listing), `notifications.markRead`, and `acceptOffer` (doesn't check the caller is the other party).
- [ ] **SEC-13 No mass assignment.** Handlers pick named fields from `req.body`; the client can never set `role`, `status`, `seller_id`, `buyer_id`, prices after agreement, or any column list. `role` changes only through admin paths.
  *Enforced by:* review · *Today:* needs an audit — services destructure named fields, but several routes spread `...req.body` into service arguments.
- [ ] **SEC-14 Row-level security (Postgres RLS).** Evaluated, **not adopted**: one DB role plus a modular monolith means RLS needs a per-request context on every query. Revisit if app-layer ownership tests (SEC-12) prove hard to keep complete. Awaiting your confirmation.
  *Enforced by:* n/a-yet · *Today:* not adopted (recommendation only).

## C. Input, injection & uploads

- [ ] **SEC-15 SQL injection.** Every value is a bound parameter. Never concatenate or interpolate user input into SQL. A template-literal query is allowed only when built from fixed internal strings, and carries a comment saying so.
  *Enforced by:* test (planned) · *Today:* **PASSES** — all queries parameterized. Two template-literal queries (`discovery.filterListings`, `orders.setOrderStatus`) are safe today but fragile.
- [ ] **SEC-16 Input validation at the route boundary** *(added)*. Types, lengths, enums, UUID ids, positive amounts, rating range, pagination caps — reject before the service runs.
  *Enforced by:* test · *Today:* **FAILS** — services trust their input.
- [ ] **SEC-17 XSS.** The API returns JSON only; user text (listing descriptions, messages, dispute reasons, reviews) is stored raw and escaped at render; CSP and security headers set (SEC-23). **Frontend repo:** never `dangerouslySetInnerHTML`/`innerHTML` on user text.
  *Enforced by:* review · *Today:* no helmet/CSP (see SEC-23).
- [ ] **SEC-18 File upload validation (when built).** Allowlist MIME **and** check magic bytes, size cap, server-generated random names, no user-controlled paths, strip EXIF (GPS) from images, store in object storage — private bucket plus short-lived signed URLs for sensitive files (`id_verification_doc_url`, dispute evidence).
  *Enforced by:* test · *Today:* n/a-yet (no upload code; the schema stores URLs only).
- [ ] **SEC-19 User-supplied URLs.** Image/evidence URLs are accepted only if they point at our own storage host; never an arbitrary URL.
  *Enforced by:* test · *Today:* **FAILS** — `addListingImages` and `submitAuthenticityEvidence` store whatever URL the client sends.
- [ ] **SEC-20 SSRF.** The backend never fetches a user-supplied URL. If that ever changes: host allowlist, block private/link-local ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`, `::1`), don't follow redirects, resolve then pin the IP.
  *Enforced by:* review · *Today:* n/a-yet (no outbound fetches anywhere).

## D. Transport, headers & abuse

- [ ] **SEC-21 HTTPS only in production**, HSTS on, Postgres connection over TLS. *(added)*
  *Enforced by:* review · *Today:* n/a-yet (no deployment).
- [x] **SEC-22 CORS is a strict allowlist.** The frontend origin(s) from env; never `*`, never reflect the `Origin` header; minimal methods and headers.
  *Enforced by:* `test/unit/http-hardening.test.js` — SEC-22 rejects wildcard, path and unlisted origins.
- [x] **SEC-23 Security headers.** `helmet` with a real CSP.
  *Enforced by:* `test/smoke/app.test.js` — SEC-23 asserts Helmet security headers and CSP.
- [ ] **SEC-24 Rate limiting.** Global limit, stricter on auth, messaging, offers and dispute filing; correct `trust proxy` setting behind a proxy.
  *Enforced by:* `test/unit/rate-limit.test.js` and `test/integration/rate-limit.test.js` (real Redis test requires `TEST_REDIS_URL`). **Partial:** auth signup/login and message/offer writes are covered; global/dispute limits and deployed proxy configuration remain pending.
- [x] **SEC-25 Explicit request-size limit** *(added)*. `express.json({ limit })` set deliberately.
  *Enforced by:* `test/smoke/app.test.js` — SEC-25 rejects bodies over the explicit one-megabyte limit.

## E. Secrets, logging & data exposure

- [ ] **SEC-26 Secrets and API keys server-side only.** None in the repo or in the frontend bundle (`VITE_*` variables are public). `.env` is never committed.
  *Enforced by:* hook (`.env`/`node_modules`/`coverage` blocked in `pre-commit`) + review for the frontend · *Today:* holds for this repo.
- [ ] **SEC-27 Sensitive data stays out of logs.** Never log `req.body`, the `Authorization` header, passwords or hashes, JWTs, ID documents, payout bank/wallet numbers, or phone/email in clear.
  *Enforced by:* `test/unit/http-hardening.test.js` — SEC-27/28 confirms request error logs omit raw error text. **Partial:** `payout.service.js` still logs an error object; SEC-27 remains unticked.
- [x] **SEC-28 Error responses don't leak internals** *(added)*. 5xx returns a generic message plus a request id; the raw message is returned only for our own typed errors (4xx / 501).
  *Enforced by:* `test/unit/http-hardening.test.js` — SEC-27/28 asserts generic 500 response, request ID and no internal error text.
- [ ] **SEC-29 Responses never include internal columns** *(added)*. No `RETURNING *` / `SELECT *` passed straight to a client on `users`; payout fields only to the owner or a permitted admin role; explicit column lists.
  *Enforced by:* review/test pending. **Partial:** registration returns named safe fields and password-hash tests pass; audit all user and payout responses before ticking.
- [ ] **SEC-30 Payout and ID data protection.** `payout_bank_account`, `payout_wallet_number` and `id_verification_doc_url` are visible only to the owner and permitted roles. Application-level encryption of CNIC numbers and payout account details is decided (ciphertext + last digits for display + a blind index if lookup is needed — specs.md FR-79f); key management is open.
  *Enforced by:* review · *Today:* plain `TEXT` columns, access control not yet verified.

## F. Supply chain, webhooks & money

- [ ] **SEC-31 Dependencies.** `npm audit --omit=dev` is clean before every release; dev-tree findings are triaged; the lockfile is committed.
  *Enforced by:* review (no CI yet) · *Today:* production deps **0 vulnerabilities**; dev tree **33** (5 moderate, 28 high), all in the jest/supertest chain, never shipped.
- [ ] **SEC-32 Source maps.** The production frontend build ships no public source maps. **Frontend repo.**
  *Enforced by:* review · *Today:* n/a here.
- [ ] **SEC-33 Webhook signature verification (when a provider is added).** HMAC over the **raw** body, constant-time comparison, reject stale timestamps (replay), idempotency keys, parse only after verification. Decided design (specs.md FR-77b): verify the signature, store the raw event under a unique gateway event ID (an inbox), enqueue, return 200, process in the worker. Escrow is decided (a payment gateway, 2026-10-13), so this row goes live in Phase 4.
  *Enforced by:* test · *Today:* n/a-yet (no webhooks; courier updates are manual).
- [ ] **SEC-34 Money integrity** *(added; matters most under escrow)*. Amounts are `NUMERIC`/integer minor units, never floats; every money-state change runs inside `db.withTransaction`; operations are idempotent; the client never supplies an amount — price comes from the accepted offer. Decided (FR-79f): ledger and audit tables are append-only — the application role cannot update or delete, and corrections are reversing entries; payment creation uses idempotency keys (FR-63a, DISCUSS).
  *Enforced by:* review + test · *Today:* needs an audit once Phase 4 starts.
- [ ] **SEC-35 Payout-detail changes are protected** *(added)*. Changing payout details requires re-entering the password, notifies the seller on every change, and shows the admin a "details changed recently" flag when a payout is processed. No cool-off (decided 2026-10-13). The no-cool-off decision relies on this row, FR-83c and FR-83f being confirmed: otherwise a hijacked account can change payout details and be paid (for ordinary buyers email is both the second factor and, presumably, the recovery channel).
  *Enforced by:* test · *Today:* **FAILS** — `updateSellerPayoutMethod` changes details with no re-authentication and no notification.

- [ ] **SEC-36 Private, money and auth routes are never cached** *(added)*. They send `Cache-Control: private, no-store`; public routes never set cookies; money values are never read from a cache (specs.md FR-73b–FR-73d, DISCUSS).
  *Enforced by:* test (a route walker, planned) · *Today:* n/a-yet (no caching layer yet).
- [ ] **SEC-37 The database is locked down** *(added)*. Private network only, TLS with certificate verification, least-privilege roles (web, worker, migrator, read-only, backup), no PII in logs or slow-query logs, staging never receives raw production data (specs.md FR-79g, decided).
  *Enforced by:* review · *Today:* n/a-yet (no deployment).

- [x] **SEC-38 Refresh tokens rotate and are revocable** *(added)*. Every refresh issues a new single-use token; reuse of an old one revokes its whole family and forces sign-in; absolute and inactivity expiry are enforced server-side; tokens are stored hashed (specs.md FR-84, FR-84a, approved 2026-10-17).
  *Enforced by:* `test/integration/known-mismatches.test.js` — FR-84/FR-84a/SEC-38 tests concurrent refresh reuse and family revocation.

---

## Open security decisions

Logged in `open-questions.md`; an agent must not guess these (`rules.md` Section 1):
recovery after loss of all second factors (FR-83k), seller factor requirements
(FR-83c), step-up behavior (FR-83f), key management for encrypted fields
(SEC-30), and RLS (SEC-14).
