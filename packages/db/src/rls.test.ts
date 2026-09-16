import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, db, withTenant } from './client'
import { institutions, users } from './schema'

// Proves tenant isolation is enforced by Postgres, not by application WHERE
// clauses. If this passes while connected as the table owner it proves nothing,
// so it asserts the connected role first.

let a: string
let b: string

before(async () => {
  ;[a, b] = (
    await authDb
      .insert(institutions)
      .values([
        { slug: 'rls-a', name: 'A', allowedEmailDomains: ['a.test'] },
        { slug: 'rls-b', name: 'B', allowedEmailDomains: ['b.test'] },
      ])
      .returning({ id: institutions.id })
  ).map((r) => r.id) as [string, string]

  await authDb.insert(users).values([
    { email: 'u@a.test', institutionId: a, role: 'student' },
    { email: 'u@b.test', institutionId: b, role: 'student' },
  ])
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, 'rls-a'))
  await authDb.delete(institutions).where(eq(institutions.slug, 'rls-b'))
})

test('app connects as a non-owner role, so RLS is not bypassed', async () => {
  const [row] = (await db.execute<{ role: string; bypass: boolean }>(
    sql`select current_user as role, rolbypassrls as bypass
        from pg_roles where rolname = current_user`,
  )).rows
  assert.equal(row?.role, 'campusos_app')
  assert.equal(row?.bypass, false)
})

test('tenant A sees only its own users', async () => {
  const rows = await withTenant(a, (tx) => tx.select().from(users))
  assert.deepEqual(
    rows.map((r) => r.email),
    ['u@a.test'],
  )
})

test('tenant B sees only its own users', async () => {
  const rows = await withTenant(b, (tx) => tx.select().from(users))
  assert.deepEqual(
    rows.map((r) => r.email),
    ['u@b.test'],
  )
})

test('no tenant context returns zero rows, not every row', async () => {
  assert.deepEqual(await db.select().from(users), [])
})

test('cannot insert a user into another tenant', async () => {
  await assert.rejects(
    () =>
      withTenant(a, (tx) =>
        tx.insert(users).values({ email: 'x@b.test', institutionId: b }),
      ),
    // drizzle wraps the pg error, so the policy message is on .cause
    (e: unknown) => /row-level security/i.test(String((e as Error).cause ?? e)),
  )
})
