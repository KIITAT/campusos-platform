import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { authDb, claimJob, failJob, institutions, jobActor, runClaimedJob, users, withTenant } from '@campusos/db'
import { createNotice, inbox, publishNotice, type Actor } from './api'
import { notices } from './schema'
import { plugin } from './plugin'

let actor: Actor
before(async () => {
  const [tenant] = await authDb.insert(institutions).values({ slug: 'notice-worker-test', name: 'Notice jobs', allowedEmailDomains: [] }).returning()
  const [user] = await authDb.insert(users).values({ institutionId: tenant!.id, email: 'notice-worker@example.test', role: 'institution_admin' }).returning()
  actor = { id: user!.id, institutionId: tenant!.id, role: 'institution_admin' }
})
after(async () => { await authDb.delete(institutions).where(eq(institutions.slug, 'notice-worker-test')) })

test('queued notice delivery rolls back with failed acknowledgement and retries exactly once', async () => {
  const notice = await createNotice(actor, { title: 'Queued notification', body: 'Delivered by the local worker.', publish: false })
  await publishNotice(actor, { noticeId: notice.id, queued: true })
  assert.equal((await inbox(actor)).items.length, 0)
  const first = await claimJob(actor.institutionId!, 'notices-worker')
  assert.ok(first)
  const handler = plugin.jobs!.find((job) => job.kind === first.kind)!
  assert.ok(handler)
  const execute = (fail: boolean) => runClaimedJob(actor.institutionId!, first.id, first.leaseToken!, async (tx, job) => {
    const current = await jobActor(tx, actor.institutionId!, job.actorId, 'notices', handler.roles, true)
    const result = await handler.run(current, tx, job.payload)
    if (fail) throw new Error('crash before acknowledgement')
    return result
  })
  await assert.rejects(execute(true))
  assert.equal((await inbox(actor)).items.length, 0)
  await execute(false)
  assert.equal((await inbox(actor)).items.length, 1)
  await assert.rejects(execute(false), /lease/)
  assert.equal((await inbox(actor)).items.length, 1)
})

test('queued notice checks live posting authority and leaves draft unpublished', async () => {
  const notice = await createNotice(actor, { title: 'Revoked publisher', body: 'Must not publish.', publish: false })
  await publishNotice(actor, { noticeId: notice.id, queued: true })
  const job = await claimJob(actor.institutionId!, 'notices-worker')
  await authDb.update(users).set({ role: 'student' }).where(eq(users.id, actor.id))
  await assert.rejects(runClaimedJob(actor.institutionId!, job!.id, job!.leaseToken!, async (tx, claimed) => {
    const handler = plugin.jobs![0]!
    const current = await jobActor(tx, actor.institutionId!, claimed.actorId, 'notices', handler.roles, true)
    return handler.run(current, tx, claimed.payload)
  }), /authorized/)
  await failJob(actor.institutionId!, job!.id, job!.leaseToken!, 'not_authorized')
  const [draft] = await withTenant(actor.institutionId!, (tx) => tx.select().from(notices).where(eq(notices.id, notice.id)))
  assert.equal(draft!.publishedAt, null)
})
