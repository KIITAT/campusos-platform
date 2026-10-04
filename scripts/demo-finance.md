# Synthetic finance demo

This operator-run development script creates one new synthetic institution and exercises existing Finance APIs. It changes no finance source, creates no authentication bypass, and is not bundled into a production plugin. Never use it against a working college database.

## Prerequisites and safeguards

- Use a fresh, disposable PostgreSQL database whose name ends in `_demo` or `_test`, with core and Finance migrations already applied. The standard `scripts/apply-module-migrations.mjs` procedure may install the complete module set on a fresh database.
- `DATABASE_URL` must use the normal RLS application role. `MIGRATION_DATABASE_URL` must have permission to provision the new institution and synthetic users. Both must explicitly name the same host, port and database; only the `sslmode` URL query option is accepted.
- Unset `AUTH_DATABASE_URL`, so an unrelated auth connection cannot provision elsewhere. `NODE_ENV=production` is refused.
- The CLI requires the exact confirmation below. A fixed tenant slug or synthetic email collision causes a refusal, not reuse or overwriting. Tenant, synthetic identities and Finance entitlement provisioning are one transaction.
- Each business operation uses the existing module API and its own transactional accounting rules. If a later step fails, a partial **new demo** tenant can remain. Reruns refuse it before creating duplicate effects; inspect or recreate the disposable database rather than bypassing append-only ledger rules.

## Run

From the `campusos-platform` repository after installing the workspace and preparing the disposable database:

```sh
export DATABASE_URL='postgresql://campusos_app:YOUR_APP_PASSWORD@127.0.0.1:55433/campusos_demo'
export MIGRATION_DATABASE_URL='postgresql://postgres:YOUR_OWNER_PASSWORD@127.0.0.1:55433/campusos_demo'
env -u AUTH_DATABASE_URL NODE_ENV=development \
  CONFIRM_FINANCE_DEMO=CREATE_SYNTHETIC_FINANCE_DEMO \
  node --import ./packages/db/node_modules/tsx/dist/loader.mjs scripts/demo-finance.ts
```

Do not reuse the example placeholders as real passwords. Keep credentials in your operator-controlled environment, not Git. The script prints document identifiers, reconciliation values and relative UI links, never connection URLs or passwords.

## Expected walkthrough

Tenant: `campusos-finance-demo-v1`, named **CampusOS Finance Demo — Synthetic**. The administrator and accountant use reserved `.invalid` email addresses; no login tokens, sessions or passwords are generated. Browser exploration requires a normally authorized test account in this disposable tenant, admitted using the usual institution setup rather than a seed-specific sign-in route.

All documents are dated **2026-10-05**, in INR, in the April-start financial year and `Asia/Kolkata` timezone:

1. Default balanced chart and legal/fiscal settings.
2. Synthetic customer and workshop service; submitted sales invoice for two services at ₹10,000 each, total **₹20,000**. No GST/TDS identifiers or tax claims are invented.
3. Submitted bank receipt for **₹20,000**, allocated to that invoice; invoice is **paid**, outstanding **₹0**.
4. Submitted balanced journal voucher: workshop supplies expense **₹5,000**, credited to bank.
5. Trial balance difference **₹0**; bank balance **₹15,000**; income/expenditure surplus **₹15,000**; balance-sheet difference **₹0**.

The result lists the created invoice/payment pages and date-filtered reports. The default fiscal year is created by the first real posting, not inserted behind the accounting API.

## Focused verification

```sh
node --import ./packages/db/node_modules/tsx/dist/loader.mjs \
  --test --test-isolation=none scripts/demo-finance.test.ts
```

Tests require the usual isolated Docker test database URLs. They test the CLI guard independently and run the financial workflow in a narrowly named fixture tenant; they remove only identities/tenant IDs they created. Tests refuse collisions with pre-existing fixtures. The integration fixture is deliberately separate from the CLI's `_demo`/`_test` database-name guard so the existing isolated `campusos` test database remains usable.

The script is standalone; no root package command or finance module changes are necessary.
