import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import * as database from './index'

let tenant: string
let other: string
const ROLLBACK = new Error('roll back')

before(async () => {
  const rows = await database.authDb
    .insert(database.institutions)
    .values([
      { slug: 'batch-test', name: 'Batch', allowedEmailDomains: [] },
      { slug: 'batch-other', name: 'Other batch', allowedEmailDomains: [] },
    ])
    .returning()
  tenant = rows[0]!.id
  other = rows[1]!.id
})

after(async () => {
  await database.authDb.delete(database.institutions).where(eq(database.institutions.slug, 'batch-test'))
  await database.authDb.delete(database.institutions).where(eq(database.institutions.slug, 'batch-other'))
})

// What a module's create operation looks like from the inside: its own withTenant.
const addPerson = (email: string) =>
  database.withTenant(tenant, (tx) =>
    tx.insert(database.users).values({ institutionId: tenant, email, role: 'student' }).returning(),
  )
const people = () =>
  database.withTenant(tenant, (tx) =>
    tx.select({ email: database.users.email }).from(database.users).where(eq(database.users.institutionId, tenant)),
  )

test('a failed step is rolled back alone, and later steps see the earlier ones', async () => {
  const seen = await database.withTenantBatch(tenant, async (step) => {
    await step(() => addPerson('one@batch.test'))
    await assert.rejects(step(() => addPerson('one@batch.test')))
    await step(() => addPerson('two@batch.test'))
    return step(async () => (await people()).map((p) => p.email).sort())
  })
  assert.deepEqual(seen, ['one@batch.test', 'two@batch.test'])
  assert.deepEqual((await people()).map((p) => p.email).sort(), ['one@batch.test', 'two@batch.test'])
})

test('throwing from the batch leaves nothing behind', async () => {
  await assert.rejects(
    database.withTenantBatch(tenant, async (step) => {
      await step(() => addPerson('dry@batch.test'))
      assert.equal((await people()).some((p) => p.email === 'dry@batch.test'), true)
      throw ROLLBACK
    }),
    (e) => e === ROLLBACK,
  )
  const [row] = await database.withTenant(tenant, (tx) =>
    tx.select().from(database.users).where(and(eq(database.users.institutionId, tenant), eq(database.users.email, 'dry@batch.test'))),
  )
  assert.equal(row, undefined)
})

test('a batch stays inside its institution and cannot nest', async () => {
  await assert.rejects(
    database.withTenantBatch(tenant, (step) => step(() => database.withTenant(other, async () => 1))),
    /another institution/,
  )
  await assert.rejects(
    database.withTenantBatch(tenant, () => database.withTenantBatch(tenant, async () => 1)),
    /inside another/,
  )
})

test('ordinary calls outside a batch keep their own transactions', async () => {
  await assert.rejects(addPerson('one@batch.test'))
  const [row] = await addPerson('three@batch.test')
  assert.equal(row!.email, 'three@batch.test')
})
