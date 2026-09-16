import { sql } from 'drizzle-orm'
import { pgPolicy, pgRole } from 'drizzle-orm/pg-core'

/**
 * The role the app connects as. `.existing()` because its lifecycle (password,
 * grants) belongs to docker/init.sql locally and to the Neon console in
 * production -- drizzle only needs to name it in policies. Without this,
 * migrations emit CREATE ROLE and fail against a DB that already has it.
 */
export const appRole = pgRole('campusos_app').existing()

/**
 * Tenant predicate, reused by every RLS policy in every module. Hardcodes the
 * column name because every tenant-scoped table carries `institution_id` by
 * convention.
 *
 * `current_setting(..., true)` passes missing_ok so a never-set variable yields
 * NULL instead of raising. The nullif is not redundant: once withTenant() has
 * run on a pooled connection the GUC keeps existing and resets to the empty
 * string, and `''::uuid` raises. Without it, whether an untenanted query on a
 * tenant table returns zero rows or throws depends on which pooled connection
 * it lands on. Either way no data leaks, but only one of them is debuggable.
 *
 * NULL fails the comparison, so a query that skipped withTenant() sees zero
 * rows rather than every row. Fail closed.
 */
export const inCurrentTenant = () =>
  sql.raw(
    `institution_id = nullif(current_setting('app.institution_id', true), '')::uuid`,
  )

/**
 * The one policy every tenant-scoped table gets. A module calling this instead
 * of hand-writing pgPolicy is what keeps a hundred tables on one predicate --
 * and means a fix to that predicate is a one-line change, not a hundred.
 */
export const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    for: 'all',
    to: appRole,
    using: inCurrentTenant(),
    withCheck: inCurrentTenant(),
  })
