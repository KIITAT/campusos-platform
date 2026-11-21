import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { authDb, institutions, jobs, users, withTenant } from '@campusos/db'
import { createNotice, inbox, notify, publishNotice } from './api'
import { plugin } from './plugin'

const slug = 'notice-email-channel-test'
let tenant: string
let adminId: string
let studentId: string

before(async () => {
  const [institution] = await authDb.insert(institutions).values({ slug, name: 'Email channel test' }).returning()
  tenant = institution!.id
  const [admin, student] = await authDb.insert(users).values([
    { institutionId: tenant, email: 'admin@notice-channel.example', role: 'institution_admin' },
    { institutionId: tenant, email: 'student@notice-channel.example', role: 'student' },
  ]).returning()
  adminId = admin!.id
  studentId = student!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, slug))
})

const student = () => ({ id: studentId, institutionId: tenant, role: 'student' as const })
const emailJobs = () => withTenant(tenant, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'notices.email')))

async function withEmailEnabled(run: () => Promise<void>) {
  const previous = process.env.CAMPUSOS_NOTIFICATION_EMAIL
  process.env.CAMPUSOS_NOTIFICATION_EMAIL = '1'
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.CAMPUSOS_NOTIFICATION_EMAIL
    else process.env.CAMPUSOS_NOTIFICATION_EMAIL = previous
  }
}

test('a committed inbox notification queues exactly one opaque email job', () => withEmailEnabled(async () => {
  const title = 'Fee event for email queue test'
  const before = (await emailJobs()).length
  const made = await withTenant(tenant, (tx) => notify(tx, tenant, {
    userIds: [studentId, studentId], moduleId: 'fees', title, body: 'Example private receipt details',
  }))
  assert.equal(made, 1)
  const item = (await inbox(student())).items.find((row) => row.title === title)
  assert.ok(item, 'the notification reached the inbox')
  const queued = await emailJobs()
  assert.equal(queued.length, before + 1, 'committed inbox write queues one email')
  const job = queued.find((row) => row.dedupeKey === `notices.email:${item.id}`)
  assert.ok(job)
  assert.equal(job.actorId, null)
  assert.equal(job.maxAttempts, 5)
  assert.deepEqual(job.payload, { notificationId: item.id })
}))

test('a published notice queues email and the member opt-out removes only email', () => withEmailEnabled(async () => {
  const preference = plugin.routes.find((route) => route.method === 'POST' && route.path === '/preferences/email')
  assert.ok(preference, 'members have a notification email opt-out route')
  const actor = { id: adminId, institutionId: tenant, role: 'institution_admin' as const }
  const publish = async (title: string) => {
    const draft = await createNotice(actor, { title, body: 'Example board notice', publish: false, audienceRoles: ['student'] })
    const published = await publishNotice(actor, { noticeId: draft.id })
    assert.equal(published.reach, 1)
    assert.ok((await inbox(student())).items.some((row) => row.title === title))
  }
  const setOptOut = (optedOut: boolean) => preference.handler(student(), new Request('http://localhost/preferences/email', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optedOut }),
  }))
  const before = (await emailJobs()).length
  await publish('Email preference before opting out')
  assert.equal((await emailJobs()).length, before + 1)
  await setOptOut(true)
  try {
    await publish('Email preference after opting out')
    assert.equal((await emailJobs()).length, before + 1, 'opt-out suppresses mail while the inbox still receives the notice')
  } finally {
    await setOptOut(false)
  }
}))
