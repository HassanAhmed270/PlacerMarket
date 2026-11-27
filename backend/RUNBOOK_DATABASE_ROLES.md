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

GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migrator;

-- Apply to objects created later by the migrator role.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO web, worker;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO web, worker;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO migrator;
```

The `FOR ROLE migrator` clauses ensure these defaults apply to tables and sequences created by the migrator, not only by the role running the statement.

Apply these concrete revoke statements to append-only tables:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM web, worker;
REVOKE UPDATE, DELETE, TRUNCATE ON money_audit_events FROM web, worker;
REVOKE UPDATE, DELETE, TRUNCATE ON review_moderation_events FROM web, worker;
REVOKE UPDATE, DELETE, TRUNCATE ON consistency_findings FROM web, worker;
```

`webhook_inbox` is not included because the worker legitimately updates delivery status, attempts, and payment references. `refunds` is also not append-only: application code legitimately changes refund state. Migrator owns DDL and should not be used by web or worker processes.

## Verify

Run these read-only checks with the role-creating operator:

```sql
SELECT has_table_privilege('web', 'ledger_entries', 'UPDATE') AS web_can_update;
SELECT has_table_privilege('worker', 'money_audit_events', 'DELETE') AS worker_can_delete;
SELECT has_table_privilege('worker', 'webhook_inbox', 'UPDATE') AS worker_can_update_webhook;
```

Expected: the first two results are `false`; the webhook result is `true` because the worker owns inbox processing updates.
