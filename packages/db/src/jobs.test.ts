import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import pg from 'pg'
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
    // Any tenant row will do as the job's effect; institutions is read-only to
    // the application role now (SEC-05), so the actor's own row stands in.
    await tx.update(database.users).set({ name: 'Committed with job' }).where(eq(database.users.id, actorId))
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
      await tx.update(database.users).set({ name: 'Must roll back' }).where(eq(database.users.id, actorId))
      throw new Error('simulated handler failure')
    }))
    const failed = await database.failJob(tenant, job.id, claimed!.leaseToken!, 'handler_failed')
    assert.equal(failed.status, attempt === 2 ? 'dead' : 'queued')
    if (attempt === 1) {
      assert.equal(await database.claimJob(tenant, 'too-early', 30), null)
      await database.withTenant(tenant, (tx) => tx.update(database.jobs).set({ runAfter: new Date(0) }).where(eq(database.jobs.id, job.id)))
    }
  }
  const [person] = await database.authDb.select().from(database.users).where(eq(database.users.id, actorId))
  assert.equal(person!.name, 'Committed with job')
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

async function freshInstitution(slug: string, suspended = false) {
  const [inst] = await database.authDb.insert(database.institutions).values({ slug, name: slug, allowedEmailDomains: [], suspendedAt: suspended ? new Date() : null }).returning()
  const [person] = await database.authDb.insert(database.users).values({ institutionId: inst!.id, email: `${slug}@example.test`, role: 'institution_admin' }).returning()
  return { id: inst!.id, actorId: person!.id }
}

const enqueueIn = (t: { id: string; actorId: string }, key: string, runAfter?: Date) =>
  database.withTenant(t.id, (tx) => database.enqueueJob(tx, { institutionId: t.id, actorId: t.actorId, kind: 'test.discovery', dedupeKey: key, payload: {}, runAfter }))

test('tenants with due work are found without a binding (REL-05)', async () => {
  const active = await freshInstitution('jobs-due-active')
  const suspended = await freshInstitution('jobs-due-suspended', true)
  const later = await freshInstitution('jobs-due-later')
  try {
    await enqueueIn(active, 'now')
    await enqueueIn(suspended, 'now')
    await enqueueIn(later, 'later', new Date(Date.now() + 3_600_000))
    const found = await database.dueTenants()
    assert.ok(found.includes(active.id))
    assert.ok(!found.includes(suspended.id))
    assert.ok(!found.includes(later.id))
  } finally {
    for (const slug of ['jobs-due-active', 'jobs-due-suspended', 'jobs-due-later']) await database.authDb.delete(database.institutions).where(eq(database.institutions.slug, slug))
  }
})

test('finished jobs are purged after their time, live ones never (REL-05)', async () => {
  const t = await freshInstitution('jobs-purge')
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await c.connect()
  try {
    const ids: string[] = []
    for (const key of ['old-succeeded', 'new-succeeded', 'old-dead', 'live']) ids.push((await enqueueIn(t, key)).id)
    await c.query(`update background_jobs set status = 'succeeded', completed_at = now() - interval '8 days' where id = $1`, [ids[0]])
    await c.query(`update background_jobs set status = 'succeeded', completed_at = now() - interval '1 day' where id = $1`, [ids[1]])
    await c.query(`update background_jobs set status = 'dead', completed_at = now() - interval '31 days' where id = $1`, [ids[2]])
    assert.ok((await database.purgeJobs()) >= 2)
    const { rows } = await c.query<{ id: string }>('select id from background_jobs where institution_id = $1', [t.id])
    assert.deepEqual(rows.map((r) => r.id).sort(), [ids[1], ids[3]].sort())
  } finally {
    await c.end()
    await database.authDb.delete(database.institutions).where(eq(database.institutions.slug, 'jobs-purge'))
  }
})
