import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import * as database from './index'

let tenant: string
let other: string
let actorId: string

before(async () => {
  const rows = await database.authDb.insert(database.institutions).values([{ slug: 'jobs-test', name: 'Jobs', allowedEmailDomains: [] }, { slug: 'jobs-other', name: 'Other jobs', allowedEmailDomains: [] }]).returning()
  tenant = rows[0]!.id
  other = rows[1]!.id
  const [person] = await database.authDb.insert(database.users).values({ institutionId: tenant, email: 'jobs@example.test', role: 'institution_admin' }).returning()
  actorId = person!.id
})

after(async () => {
  await database.authDb.delete(database.institutions).where(eq(database.institutions.slug, 'jobs-test'))
  await database.authDb.delete(database.institutions).where(eq(database.institutions.slug, 'jobs-other'))
})

test('queue supports transactional deduplication and tenant isolation', async () => {
  assert.equal(typeof database.enqueueJob, 'function')
  const enqueue = () => database.withTenant(tenant, (tx) => database.enqueueJob(tx, { institutionId: tenant, actorId, kind: 'finance.recurring', dedupeKey: 'daily', payload: { on: '2026-10-05' } }))
  const [first, second] = await Promise.all([enqueue(), enqueue()])
  assert.equal(first.id, second.id)
  assert.deepEqual(await database.withTenant(other, (tx) => tx.select().from(database.jobs)), [])
  await assert.rejects(database.withTenant(other, (tx) => database.enqueueJob(tx, { institutionId: tenant, actorId, kind: 'finance.recurring', dedupeKey: 'foreign', payload: {} })))
})

test('concurrent claims return one owner and a stale lease cannot complete it', async () => {
  const claims = await Promise.all([database.claimJob(tenant, 'worker-one', 30), database.claimJob(tenant, 'worker-two', 30)])
  const claimed = claims.find(Boolean)!
  assert.equal(claims.filter(Boolean).length, 1)
  await assert.rejects(database.runClaimedJob(tenant, claimed.id, '00000000-0000-4000-8000-000000000000', async () => ({})), /lease/)
  const result = await database.runClaimedJob(tenant, claimed.id, claimed.leaseToken!, async (tx) => {
    await tx.update(database.institutions).set({ name: 'Committed with job' }).where(eq(database.institutions.id, tenant))
    return { posted: true }
  })
  assert.deepEqual(result, { posted: true })
  const [row] = await database.withTenant(tenant, (tx) => tx.select().from(database.jobs).where(eq(database.jobs.id, claimed.id)))
  assert.equal(row!.status, 'succeeded')
})

test('failed effects roll back and bounded retries eventually become dead', async () => {
  const job = await database.withTenant(tenant, (tx) => database.enqueueJob(tx, { institutionId: tenant, actorId, kind: 'test.failure', dedupeKey: 'failure', payload: {}, maxAttempts: 2 }))
  for (const attempt of [1, 2]) {
    const claimed = await database.claimJob(tenant, 'failure-worker', 30)
    assert.equal(claimed!.id, job.id)
    await assert.rejects(database.runClaimedJob(tenant, job.id, claimed!.leaseToken!, async (tx) => {
      await tx.update(database.institutions).set({ name: 'Must roll back' }).where(eq(database.institutions.id, tenant))
      throw new Error('simulated handler failure')
    }))
    const failed = await database.failJob(tenant, job.id, claimed!.leaseToken!, 'handler_failed')
    assert.equal(failed.status, attempt === 2 ? 'dead' : 'queued')
    if (attempt === 1) {
      assert.equal(await database.claimJob(tenant, 'too-early', 30), null)
      await database.withTenant(tenant, (tx) => tx.update(database.jobs).set({ runAfter: new Date(0) }).where(eq(database.jobs.id, job.id)))
    }
  }
  const [institution] = await database.authDb.select().from(database.institutions).where(eq(database.institutions.id, tenant))
  assert.equal(institution!.name, 'Committed with job')
})

test('abandoned leases recover and exhausted abandoned jobs become dead', async () => {
  const job = await database.withTenant(tenant, (tx) => database.enqueueJob(tx, { institutionId: tenant, actorId, kind: 'test.recover', dedupeKey: 'recover', payload: {}, maxAttempts: 2 }))
  const first = await database.claimJob(tenant, 'crashed', 30)
  await database.withTenant(tenant, (tx) => tx.update(database.jobs).set({ leaseUntil: new Date(0) }).where(eq(database.jobs.id, job.id)))
  const second = await database.claimJob(tenant, 'replacement', 30)
  assert.equal(second!.id, first!.id)
  assert.notEqual(second!.leaseToken, first!.leaseToken)
  await assert.rejects(database.failJob(tenant, job.id, first!.leaseToken!, 'stale'), /lease/)
  await database.withTenant(tenant, (tx) => tx.update(database.jobs).set({ leaseUntil: new Date(0) }).where(eq(database.jobs.id, job.id)))
  assert.equal(await database.claimJob(tenant, 'third', 30), null)
  const [dead] = await database.withTenant(tenant, (tx) => tx.select().from(database.jobs).where(eq(database.jobs.id, job.id)))
  assert.equal(dead!.status, 'dead')
})

test('an execution authorizes the live actor and enabled module inside its transaction', async () => {
  await database.authDb.insert(database.institutionModules).values({ institutionId: tenant, moduleId: 'finance', enabled: true })
  const authorized = await database.withTenant(tenant, (tx) => database.jobActor(tx, tenant, actorId, 'finance', ['institution_admin']))
  assert.equal(authorized.id, actorId)
  await database.authDb.update(database.users).set({ role: 'student' }).where(eq(database.users.id, actorId))
  await assert.rejects(database.withTenant(tenant, (tx) => database.jobActor(tx, tenant, actorId, 'finance', ['institution_admin'])), /authorized/)
  await database.authDb.update(database.users).set({ role: 'institution_admin' }).where(eq(database.users.id, actorId))
  await database.authDb.update(database.institutionModules).set({ enabled: false }).where(eq(database.institutionModules.institutionId, tenant))
  await assert.rejects(database.withTenant(tenant, (tx) => database.jobActor(tx, tenant, actorId, 'finance', ['institution_admin'])), /enabled/)
  await database.withTenant(tenant, (tx) => tx.execute(sql`select 1`))
})

test('erasure, suspension and foreign actors prevent job execution', async () => {
  await database.authDb.update(database.users).set({ erasedAt: new Date() }).where(eq(database.users.id, actorId))
  await assert.rejects(database.withTenant(tenant, (tx) => database.jobActor(tx, tenant, actorId, 'notices', ['institution_admin'], true)), /authorized/)
  await database.authDb.update(database.users).set({ erasedAt: null }).where(eq(database.users.id, actorId))
  await database.authDb.update(database.institutions).set({ suspendedAt: new Date() }).where(eq(database.institutions.id, tenant))
  await assert.rejects(database.withTenant(tenant, (tx) => database.jobActor(tx, tenant, actorId, 'notices', ['institution_admin'], true)), /authorized/)
  await database.authDb.update(database.institutions).set({ suspendedAt: null }).where(eq(database.institutions.id, tenant))
  await assert.rejects(database.withTenant(other, (tx) => database.jobActor(tx, other, actorId, 'notices', ['institution_admin'], true)), /authorized/)
})

test('an executing transaction cannot be stolen after its lease expires', async () => {
  await database.withTenant(tenant, (tx) => database.enqueueJob(tx, { institutionId: tenant, actorId, kind: 'test.slow', dedupeKey: 'slow', payload: { second: 2, first: 1 } }))
  await database.withTenant(tenant, (tx) => database.enqueueJob(tx, { institutionId: tenant, actorId, kind: 'test.slow', dedupeKey: 'slow', payload: { first: 1, second: 2 } }))
  const claimed = await database.claimJob(tenant, 'slow-worker', 1)
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const running = database.runClaimedJob(tenant, claimed!.id, claimed!.leaseToken!, async () => { started(); await gate; return { done: true } })
  await entered
  try {
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(await database.claimJob(tenant, 'competing-worker'), null)
  } finally { release() }
  await running
})
