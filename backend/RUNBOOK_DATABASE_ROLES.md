# Database roles runbook

The owner creates the database roles listed below. Poshaak does not provision or grant database roles itself.

Configure `DATABASE_URL_WORKER` and `DATABASE_URL_MIGRATOR`; each may be omitted to fall back to `DATABASE_URL`.
The queue keeps `QUEUE_DATABASE_URL` highest precedence, then `DATABASE_URL_WORKER`, then `DATABASE_URL`.

```sql
CREATE ROLE web LOGIN;
CREATE ROLE worker LOGIN;
CREATE ROLE migrator LOGIN;
CREATE ROLE readonly LOGIN;

GRANT USAGE ON SCHEMA public TO web, worker, migrator, readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO web, worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web, worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO web, worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO web, worker;

GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO migrator;
```

Restrict web and worker from updating or deleting append-only tables and ledgers (for example, money audit, ledger, and webhook inbox tables) with the database role's policy or separate non-superuser ownership rules. Migrator owns DDL and should not be used by web or worker processes.
