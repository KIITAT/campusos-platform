import './env'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from './schema'

// One driver, one code path. node-postgres speaks the standard Postgres wire
// protocol, so local Docker and Neon differ only by DATABASE_URL. Point it at
// Neon's *-pooler host in production; SET LOCAL is transaction-scoped and
// therefore safe under PgBouncer transaction pooling.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, // ponytail: fine for serverless + local; tune if pool waits show up in traces
})

/** Restricted role. RLS applies. Use withTenant() for anything tenant-scoped. */
export const db = drizzle(pool, { schema })

/**
 * Owner role. Bypasses RLS -- for the Auth.js adapter only.
 *
 * Sign-in looks a user up by email before any subdomain-derived tenant context
 * exists, so it cannot run under the users RLS policy. Confining that to one
 * exported handle keeps the bypass to a single, greppable code path; every
 * other query path must use `db`.
 */
export const authDb = drizzle(
  new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 }),
  { schema },
)

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs `fn` in a transaction scoped to one institution. RLS policies read
 * `app.institution_id`, so every tenant query must go through here.
 */
export function withTenant<T>(
  institutionId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config, not `SET LOCAL` -- SET does not take bind parameters, so the
    // interpolated form would be injectable. Third arg `true` makes it
    // transaction-local: a session-level set would leak this tenant to the
    // next request that reuses the pooled connection.
    await tx.execute(
      sql`select set_config('app.institution_id', ${institutionId}, true)`,
    )
    return fn(tx)
  })
}
