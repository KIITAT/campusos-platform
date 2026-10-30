import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb } from './client'
import { EXPORT_POLICY, HOST_TABLES, SAFE_COLUMNS, SECRET_LIKE } from './dpdp-policy'

/**
 * The export's classification is checked against the catalogue, not against
 * memory. These run on a database with every module migrated -- CI applies
 * them all before the suite -- so a module that adds a table naming a user
 * fails here, by name, before anybody exports a credential through it.
 */

type Executor = Pick<typeof authDb, 'execute'>

const referencingUsers = async (on: Executor) =>
  (
    await on.execute<{ t: string }>(sql`
      select distinct c.relname as t
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_class ref on ref.oid = con.confrelid
       where con.contype = 'f'
         and ref.relname = 'users'
         and c.relnamespace = 'public'::regnamespace
         and c.relname <> 'users'
       order by 1`)
  ).rows.map((r) => r.t)

const unclassified = (tables: string[]) => tables.filter((t) => !(t in EXPORT_POLICY))

test('every table that references a user is classified for export (SEC-01)', async () => {
  const missing = unclassified(await referencingUsers(authDb))
  assert.deepEqual(missing, [], `classify these in packages/db/src/dpdp-policy.ts: ${missing.join(', ')}`)
})

test('a new table naming a user fails the classification check by name', async () => {
  // Created and dropped in one transaction, so no other test ever sees it.
  const missing = await authDb.transaction(async (tx) => {
    await tx.execute(sql`create table dpdp_probe_unclassified (user_id text references users(id))`)
    const found = unclassified(await referencingUsers(tx))
    await tx.execute(sql`drop table dpdp_probe_unclassified`)
    return found
  })
  assert.deepEqual(missing, ['dpdp_probe_unclassified'])
})

test('every source a dpdp_subject view names is classified for export (AUD-03)', async () => {
  const views = await authDb.execute<{ def: string }>(sql`
    select pg_get_viewdef(c.oid) as def from pg_class c
     where c.relnamespace = 'dpdp_subject'::regnamespace and c.relkind = 'v'`)
  // a column named in 'row - col' is not a source
  const sources = new Set(views.rows.flatMap((r) => [...r.def.matchAll(/(?<!- )'([a-z][a-z0-9_]*)'::text/g)].map((m) => m[1]!)))
  assert.ok(sources.size > 0, 'no dpdp_subject view found')
  const missing = [...sources].filter((t) => !(t in EXPORT_POLICY)).sort()
  assert.deepEqual(missing, [], `classify these in packages/db/src/dpdp-policy.ts: ${missing.join(', ')}`)
})

test('the classification names no table that no longer exists', async () => {
  const existing = new Set(
    (
      await authDb.execute<{ t: string }>(sql`
        select relname as t from pg_class
         where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')`)
    ).rows.map((r) => r.t),
  )
  const stale = Object.keys(EXPORT_POLICY).filter((t) => !existing.has(t) && !HOST_TABLES.includes(t))
  assert.deepEqual(stale, [], `remove these from dpdp-policy.ts: ${stale.join(', ')}`)
})

test('every secret-looking column of an exported table has been reviewed (SEC-01, NEW-01)', async () => {
  const exported = Object.entries(EXPORT_POLICY).filter(([, rule]) => rule !== 'exclude').map(([t]) => t)
  const columns = await authDb.execute<{ t: string; c: string }>(sql`
    select table_name as t, column_name as c from information_schema.columns
     where table_schema = 'public'
       and table_name in (${sql.join(exported.map((t) => sql`${t}`), sql`, `)})`)
  const unreviewed = columns.rows
    .filter(({ c }) => SECRET_LIKE.test(c))
    .filter(({ t, c }) => {
      const rule = EXPORT_POLICY[t]!
      if (typeof rule === 'object' && 'only' in rule) return rule.only.includes(c) && !SAFE_COLUMNS.includes(`${t}.${c}`)
      if (typeof rule === 'object' && 'omit' in rule && rule.omit.includes(c)) return false
      return !SAFE_COLUMNS.includes(`${t}.${c}`)
    })
    .map(({ t, c }) => `${t}.${c}`)
  assert.deepEqual(unreviewed, [], `omit these in dpdp-policy.ts, or list them as safe: ${unreviewed.join(', ')}`)
})
