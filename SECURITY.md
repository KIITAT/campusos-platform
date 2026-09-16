# Security

## Reporting a vulnerability

Report privately through GitHub's **Security → Report a vulnerability** on this
repository. Do not open a public issue.

Include what you did, what happened, and what you expected. A tenancy bug — one
institution able to observe or alter another's data — is the highest severity
class in this product; say so in the title if that is what you have found.

## The boundaries this product defends

**Tenant isolation is enforced by Postgres, not by application code.** Every
tenant-scoped table carries a row-level security policy keyed to a
transaction-local `app.institution_id` setting. The application connects as
`campusos_app`, which owns no tables and has no `BYPASSRLS`; the owner role is
used only to run migrations and by the Auth.js adapter, which must read across
tenants to resolve a sign-in. A missing tenant context returns zero rows, never
every row.

**Entitlements are a billing boundary, not a security one.** `requireModule()`
decides what an institution has paid for. It is never the only thing standing
between a user and another institution's data.

**Authorisation lives in the operations, not in the routes.** The JSON API and
the server actions are two entry points onto the same functions, so they cannot
drift apart.

**Sensitive writes state a reason.** Published marks, fee waivers, payment
reconciliation and attendance overrides all write to a shared audit log, and the
database refuses the write outright when the reason is absent.

## Secrets

No credential belongs in the repository. `.env*` is ignored except
`.env.example`, which carries names and never values. Production connection
strings and OAuth secrets live only in the host's environment configuration.

Local development and CI talk to a disposable Postgres container. CI has no
access to any hosted database, by design.
