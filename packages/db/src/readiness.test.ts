import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { authDb, db, institutions } from './index'
import { CORE_MIGRATED_AT, JOB_LAG_LIMIT_SECONDS, readiness } from './readiness'

/**
 * What /api/health reads (REL-02, decision D9 of plans/P0-11.md): the schema
 * level and how long the oldest due job has waited, through one definer
 * function, because the app role can see neither.
 */

const owner = () => new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })

test('a migrated database is ready, and the schema level is the journal\'s last entry (REL-02)', async () => {
  // Other tests leave queued jobs behind; a huge limit isolates the schema check.
  assert.deepEqual(await readiness({ jobLagLimitSeconds: 1_000_000_000 }), {
    status: 'ok', checks: { database: 'ok', migrations: 'ok', jobs: 'ok' },
  })
  const { rows } = await db.execute<{ core_migrated_at: string }>(sql`select core_migrated_at from campusos_readiness()`)
  assert.equal(rows[0]!.core_migrated_at, String(CORE_MIGRATED_AT))
  assert.equal(JOB_LAG_LIMIT_SECONDS, 900)
})

test('a due job older than the limit makes it degraded, not down (REL-02)', async () => {
  const slug = `readiness-${randomUUID().slice(0, 8)}`
  const [inst] = await authDb.insert(institutions).values({ slug, name: 'Readiness', allowedEmailDomains: [] }).returning()
  const client = owner()
  await client.connect()
  try {
    await client.query(
      `insert into background_jobs (institution_id, kind, dedupe_key, payload, run_after)
       values ($1, 'readiness.test', 'lag', '{}', now() - interval '1000 seconds')`,
      [inst!.id],
    )
    assert.deepEqual(await readiness({ jobLagLimitSeconds: 900 }), {
      status: 'degraded', checks: { database: 'ok', migrations: 'ok', jobs: 'lagging' },
    })
  } finally {
    await client.end()
    await authDb.delete(institutions).where(eq(institutions.slug, slug))
  }
})

test('a schema older than the build is down (REL-02)', async () => {
  assert.deepEqual(await readiness({ expectedMigratedAt: CORE_MIGRATED_AT + 1, jobLagLimitSeconds: 1_000_000_000 }), {
    status: 'down', checks: { database: 'ok', migrations: 'behind', jobs: 'ok' },
  })
})

test('an unreachable database is down (REL-02)', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://x:x@127.0.0.1:1/x', connectionTimeoutMillis: 1000 })
  try {
    assert.deepEqual(await readiness({ database: drizzle(pool) }), {
      status: 'down', checks: { database: 'fail', migrations: 'unknown', jobs: 'unknown' },
    })
  } finally {
    await pool.end().catch(() => {})
  }
})

test('only the app role may call it (REL-02)', async () => {
  const client = owner()
  await client.connect()
  try {
    const { rows } = await client.query(`
      select has_function_privilege('campusos_app', 'public.campusos_readiness()', 'EXECUTE') as app,
             has_function_privilege('public', 'public.campusos_readiness()', 'EXECUTE') as pub,
             p.prosecdef as definer, p.proconfig as config
        from pg_proc p where p.oid = 'public.campusos_readiness()'::regprocedure`)
    assert.deepEqual(rows[0], { app: true, pub: false, definer: true, config: ['search_path=pg_catalog, pg_temp'] })
  } finally {
    await client.end()
  }
})
