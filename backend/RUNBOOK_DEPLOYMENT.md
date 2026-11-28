# Deployment runbook

Deploy the database migrator first, the backend web process second, and the worker third. Provision PostgreSQL, Redis, object storage, CDN and the frontend host before starting production processes.

## Environment variables

| Name | Meaning |
|---|---|
| `NODE_ENV` | Set to `production`. |
| `DATABASE_URL` | Web process PostgreSQL URL. |
| `DATABASE_URL_WORKER` | Optional worker PostgreSQL URL; falls back to `DATABASE_URL`. |
| `DATABASE_URL_MIGRATOR` | Optional migrator PostgreSQL URL; falls back to `DATABASE_URL`. |
| `QUEUE_DATABASE_URL` | Optional worker queue URL; highest queue precedence. |
| `DATABASE_SSL` | Must be `verify-full`. |
| `DATABASE_CA_CERT` | Optional PEM certificate text. |
| `REDIS_URL` | Redis URL. |
| `JWT_ACCESS_SECRET` | External access-token signing secret. |
| `CORS_ORIGINS` | Exact comma-separated allowed frontend origins. |
| `TRUST_PROXY_HOPS` | Trusted proxy-hop count, integer 0–10. |
| `SHUTDOWN_TIMEOUT_MS` | Maximum graceful-shutdown deadline. |
| `EMAIL_PROVIDER_API_KEY` | Email provider credential. |
| `EMAIL_QUEUE_ENCRYPTION_SECRET` | Email-payload queue encryption secret. |
| `STAFF_TOTP_ENCRYPTION_SECRET` | Staff TOTP encryption secret. |
| `PAYOUT_ENCRYPTION_KEYS_JSON` | Payout encryption key map. |
| `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID` | Active payout encryption key ID. |
| `MEDIA_SIGNING_SECRET` | Private-media URL signing secret. |
| `CHALLENGE_PROVIDER_KEY` | Challenge provider credential. |
| `EMAIL_SENDER_ADAPTER` | Must be `provider` in production. |
| `CHALLENGE_VERIFIER_ADAPTER` | Must be `provider` in production. |
| `PUBLIC_BASE_URL` | Public frontend origin. |

On Vercel, import `frontend/vercel.json`. Replace the clearly marked `__API_ORIGIN__` and `__STORAGE_ORIGIN__` placeholders in `frontend/security-headers.json`, regenerate both output artifacts, and deploy.

For nginx, include `frontend/deploy/nginx-security-headers.conf.example` in the HTTPS server block and replace the placeholders before activation.

Before deployment, run `node frontend/scripts/build-header-configs.js --require-real-origins`. The command exits non-zero until `__API_ORIGIN__`, `__STORAGE_ORIGIN__`, and every other `__*__` placeholder are replaced with real origins.
