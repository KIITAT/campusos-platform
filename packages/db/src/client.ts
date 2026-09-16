import './env'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from './schema'

// One driver, one code path. node-postgres speaks the standard Postgres wire
// protocol, so local Docker and Neon differ only by DATABASE_URL. Point it at
// Neon's *-pooler host in production; SET LOCAL is transaction-scoped and
// therefore safe under PgBouncer transaction pooling.
/**
 * The one seam a plugin shares with its host.
 *
 * An installed plugin carries its own copy of this package -- it is bundled, so
 * that it can be loaded by plain Node without a build step at the institution.
 * What it must *not* carry is a second connection pool: two pools against the
 * same database would double the connection count and, worse, make "how many
 * connections is CampusOS using" unanswerable from either side.
 *
 * So the host publishes its pool on a global before loading any plugin, and a
 * plugin's copy of this file finds it there. Everything else in the plugin --
 * drizzle, the table definitions, withTenant -- is its own, and none of it
 * crosses the boundary: a handler takes a plain actor and a Request and returns
 * JSON. The pool is the only shared object, and a pool is designed to be shared.
 */
const shared = (globalThis as { __campusosPool?: Pool }).__campusosPool

const pool =
  shared ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5, // ponytail: fine for serverless + local; tune if pool waits show up in traces
  })

/** Called once by the host, before the first plugin is loaded. */
export function useSharedPool(p: Pool): void {
  ;(globalThis as { __campusosPool?: Pool }).__campusosPool = p
}

/** The pool this process is using, for the host to publish to its plugins. */
export const corePool = pool

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
let ownerDb: ReturnType<typeof drizzle> | null = null

const owner = () =>
  (ownerDb ??= drizzle(
    new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 }),
    { schema },
  ))

/**
 * Constructed on first use rather than at import.
 *
 * Eagerly, this opened an owner-role pool in every process that imported the
 * package -- including an installed plugin, which has no business holding one
 * and no owner credentials to hold it with. Nothing that reaches for `authDb`
 * is on a hot path, so the lazy handle costs nothing and the bypass now exists
 * only where it is actually used.
 */
export const authDb = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    const instance = owner()
    const value = Reflect.get(instance, prop) as unknown
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

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
