import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb } from './client'
import { institutions } from './schema'
import { publishReportPool, readFacts, withTenantRead } from './replica'

/** Read-only tenant reads on an optional report pool (P2-05, decision 438). */

let inst: string

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: `replica-${Date.now()}`, name: 'Replica', allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  inst = i!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.id, inst))
})

const probe = () =>
  withTenantRead(inst, async (tx) => {
    const r = await tx.execute(sql`select current_setting('transaction_read_only') as ro, current_setting('app.institution_id') as inst, current_setting('statement_timeout') as st, current_setting('application_name') as app`)
    return r.rows[0] as { ro: string; inst: string; st: string; app: string }
  })

test('withTenantRead runs read-only on the core pool when no report pool is published', async () => {
  const r = await probe()
  assert.equal(r.ro, 'on')
  assert.equal(r.inst, inst)
  assert.equal(r.st, '25s')
  assert.notEqual(r.app, 'campusos-reports')
})

test('a write inside withTenantRead fails as read-only', async () => {
  await assert.rejects(
    withTenantRead(inst, (tx) => tx.execute(sql`create temp table p205_x (a int)`)),
    (e: unknown) => (e as { code?: string; cause?: { code?: string } }).code === '25006' || (e as { cause?: { code?: string } }).cause?.code === '25006',
  )
})

test('readFacts on a primary', async () => {
  const f = await withTenantRead(inst, (tx) => readFacts(tx))
  assert.equal(f.onReplica, false)
  assert.ok(f.dataAsOf instanceof Date)
  assert.ok(Math.abs(Date.now() - f.dataAsOf.getTime()) < 5000)
})

test('publishReportPool routes withTenantRead to the report pool', async () => {
  publishReportPool(process.env.DATABASE_URL!)
  const first = (globalThis as { __campusosReportPool?: unknown }).__campusosReportPool
  assert.ok(first)
  assert.equal((await probe()).app, 'campusos-reports')
  publishReportPool(process.env.DATABASE_URL!)
  assert.equal((globalThis as { __campusosReportPool?: unknown }).__campusosReportPool, first)
})
