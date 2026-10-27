import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { authDb, db } from './client'
import { RATE_LIMITS, rateLimit } from './rate-limit'

/**
 * The counter behind every sign-in limit (SEC-02).
 *
 * A fixed window per (bucket, subject), kept in Postgres so that several web
 * processes share it, and written only by one SECURITY DEFINER function. The
 * subject is an address or an e-mail, so the table holds its hash. Each test
 * uses a subject of its own: counters outlive a test run.
 */

const subject = () => `test-${randomUUID()}`

/** Postgres's message, which drizzle hangs off `.cause`. */
const says = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

const rowsFor = async (hashOf: string) =>
  (await authDb.execute<{ n: number }>(sql`select count(*)::int as n from rate_limit_counters where subject_hash = ${hashOf}`)).rows[0]!.n

test('an attempt within the limit is allowed and the one after it is told how long to wait (SEC-02)', async () => {
  const s = subject()
  for (let i = 1; i <= 10; i++) assert.equal(await rateLimit('pairing.ip', s), 0, `attempt ${i}`)
  const wait = await rateLimit('pairing.ip', s)
  assert.ok(wait >= 1 && wait <= 900, `told to wait ${wait} seconds`)
})

test('a new window starts once the old one has ended (SEC-02)', async () => {
  const s = subject()
  for (let i = 1; i <= 11; i++) await rateLimit('pairing.ip', s)
  await authDb.execute(sql`
    update rate_limit_counters set resets_at = clock_timestamp() - interval '1 second'
     where bucket = 'pairing.ip' and subject_hash = encode(sha256(convert_to(${s}, 'UTF8')), 'hex')`)
  assert.equal(await rateLimit('pairing.ip', s), 0)
})

test('buckets and subjects are counted separately (SEC-02)', async () => {
  const s = subject()
  const other = subject()
  for (let i = 1; i <= 10; i++) await rateLimit('pairing.ip', s)
  assert.ok((await rateLimit('pairing.ip', s)) > 0, 'the 11th attempt is refused')
  assert.equal(await rateLimit('pairing.ip', other), 0, 'another subject starts fresh')
  assert.equal(await rateLimit('signin.ip', s), 0, 'another bucket starts fresh')
})

test('the table holds a hash of the subject, never the subject (SEC-02)', async () => {
  const s = subject()
  await rateLimit('pairing.ip', s)
  assert.equal(await rowsFor(s), 0)
  const { rows } = await authDb.execute<{ n: number }>(sql`
    select count(*)::int as n from rate_limit_counters
     where subject_hash = encode(sha256(convert_to(${s}, 'UTF8')), 'hex')`)
  assert.equal(rows[0]!.n, 1)
})

test('concurrent attempts are counted exactly (SEC-02)', async () => {
  const s = subject()
  // Twenty connections, all open before any asks: they meet on one primary-key row.
  const clients = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
      await client.connect()
      return client
    }),
  )
  try {
    const waits = await Promise.all(
      clients.map(async (client) => {
        const { rows } = await client.query<{ wait: number }>('select public.campusos_rate_limit($1, $2, 10, 900) as wait', ['pairing.ip', s])
        return rows[0]!.wait
      }),
    )
    assert.equal(waits.filter((w) => w === 0).length, 10, 'ten are let through')
    assert.equal(waits.filter((w) => w > 0).length, 10, 'ten are told to wait')
  } finally {
    await Promise.all(clients.map((client) => client.end()))
  }
})

test('bad arguments are refused (SEC-02)', async () => {
  for (const args of ["'Bad Bucket', 'x', 1, 1", "'pairing.ip', 'x', 0, 1", "'pairing.ip', 'x', 1, 86401"]) {
    await assert.rejects(authDb.execute(sql.raw(`select public.campusos_rate_limit(${args})`)), says(/invalid arguments/), args)
  }
})

test('only the definer touches the counters; the application role can neither call it nor read them (SEC-02, D5)', async () => {
  await assert.rejects(db.execute(sql`select public.campusos_rate_limit('pairing.ip', 'x', 1, 1)`), says(/permission denied/))
  await assert.rejects(db.execute(sql`select * from rate_limit_counters`), says(/permission denied/))
  const { rows } = await authDb.execute<{ p: boolean }>(sql`
    select has_function_privilege('public', 'public.campusos_rate_limit(text,text,integer,integer)', 'EXECUTE') as p`)
  assert.equal(rows[0]!.p, false, 'not executable by PUBLIC')
})

test('RATE_LIMITS is the table in the plan', () => {
  assert.deepEqual(RATE_LIMITS, {
    'signin.ip': { limit: 120, windowSeconds: 600 },
    'magiclink.ip': { limit: 20, windowSeconds: 3600 },
    'magiclink.email': { limit: 5, windowSeconds: 3600 },
    'pairing.ip': { limit: 10, windowSeconds: 900 },
    'export.account': { limit: 5, windowSeconds: 3600 },
    'console.signin.ip': { limit: 10, windowSeconds: 900 },
    'console.signin.user': { limit: 5, windowSeconds: 900 },
    'console.totp': { limit: 1, windowSeconds: 90 },
  })
})
