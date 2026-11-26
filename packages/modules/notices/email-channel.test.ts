import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { authDb, claimJob, institutions, jobActor, jobs, runClaimedJob, users, withTenant } from '@campusos/db'
import { createNotice, inbox, notify, publishNotice, setEmailPreference, setMandatory, setPreference } from './api'
import { emailNotificationChannel } from './api/email-channel'
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
const admin = () => ({ id: adminId, institutionId: tenant, role: 'institution_admin' as const })
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
  await withTenant(tenant, (tx) => emailNotificationChannel.deliver(tx, [{
    notificationId: item.id, institutionId: tenant, userId: studentId, moduleId: 'fees', title, body: 'Fixture', link: null,
  }]))
  assert.equal((await emailJobs()).length, before + 1, 'redispatching the same inbox row cannot enqueue it twice')
}))

test('a published notice queues email and the member opt-out removes only email', () => withEmailEnabled(async () => {
  const preference = plugin.routes.find((route) => route.method === 'POST' && route.path === '/preferences/email')
  assert.ok(preference, 'members have a notification email opt-out route')
  const actor = admin()
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

test('email enqueue rolls back with the producer transaction', () => withEmailEnabled(async () => {
  const before = (await emailJobs()).length
  const title = 'A rolled-back fee event'
  await assert.rejects(withTenant(tenant, async (tx) => {
    await notify(tx, tenant, { userIds: [studentId], moduleId: 'fees', title, body: 'An example fee event' })
    const queued = await tx.select().from(jobs).where(eq(jobs.kind, 'notices.email'))
    assert.equal(queued.length, before + 1)
    throw new Error('rollback fixture')
  }), /rollback fixture/)
  assert.equal((await emailJobs()).length, before)
  assert.ok(!(await inbox(student())).items.some((item) => item.title === title))
}))

test('category mutes control inbox delivery and the email opt-out even applies to mandatory categories', () => withEmailEnabled(async () => {
  const before = (await emailJobs()).length
  const deliver = (title: string) => withTenant(tenant, (tx) =>
    notify(tx, tenant, { userIds: [studentId], moduleId: 'fees', title, body: 'An example fee event' }))
  const setFeeMandatory = (mandatory: boolean) => setMandatory(admin(), { moduleId: 'fees', mandatory, reason: 'Email fixture' })
  await setPreference(student(), { moduleId: 'fees', muted: true })
  try {
    assert.equal(await deliver('A muted notification'), 0)
    await setFeeMandatory(true)
    await setEmailPreference(student(), { optedOut: true })
    assert.equal(await deliver('A mandatory notification'), 1)
    assert.equal((await emailJobs()).length, before)
    assert.ok((await inbox(student())).items.some((item) => item.title === 'A mandatory notification'))
  } finally {
    await setEmailPreference(student(), { optedOut: false })
    await setFeeMandatory(false)
    await setPreference(student(), { moduleId: 'fees', muted: false })
  }
}))

test('queued publish reuses its pending job and emits one email for the recipient', () => withEmailEnabled(async () => {
  const [isolated] = await authDb.insert(institutions).values({ slug: 'notice-email-queued-test', name: 'Queued email test' }).returning()
  const institutionId = isolated!.id
  try {
    const [poster] = await authDb.insert(users).values({ institutionId, email: 'poster@queued-email.example', role: 'institution_admin' }).returning()
    const actor = { institutionId, id: poster!.id, role: 'institution_admin' as const }
    const draft = await createNotice(actor, { title: 'Queued email', body: 'Example notice', publish: false })
    const publish = () => publishNotice(actor, { noticeId: draft.id, queued: true })
    assert.deepEqual(await publish(), await publish())
    const claimed = await claimJob(institutionId, 'notices-email-test')
    assert.equal(claimed?.kind, 'notices.publish')
    const handler = plugin.jobs!.find((job) => job.kind === claimed!.kind)!
    const run = () => runClaimedJob(institutionId, claimed!.id, claimed!.leaseToken!, async (tx, job) => {
      const current = await jobActor(tx, institutionId, job.actorId, 'notices', handler.roles, true)
      return handler.run(current, tx, job.payload)
    })
    await run()
    await assert.rejects(run(), /lease/)
    const queued = await withTenant(institutionId, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'notices.email')))
    assert.equal(queued.length, 1)
    assert.equal((await inbox(actor)).items.length, 1)
    assert.ok(!(await emailJobs()).some((row) => row.id === queued[0]!.id))
  } finally {
    await authDb.delete(institutions).where(eq(institutions.id, institutionId))
  }
}))

test('guardian delivery uses the same email channel and leaves private details in the inbox', () => withEmailEnabled(async () => {
  const [parent] = await authDb.insert(users).values({ institutionId: tenant, email: 'parent@notice-channel.example', role: 'parent' }).returning()
  const parentId = parent!.id
  await authDb.execute(sql`insert into parent_links (institution_id, parent_id, student_id, relation, verified_at)
    values (${tenant}, ${parentId}, ${studentId}, 'mother', now())`)
  try {
    const title = 'Example attendance detail'
    const delivered = await withTenant(tenant, (tx) => notify(tx, tenant, {
      userIds: [studentId], moduleId: 'attendance', title, body: 'Private student data', alsoGuardians: { link: '/m/parents' },
    }))
    assert.equal(delivered, 2)
    const parentNotice = (await inbox({ institutionId: tenant, id: parentId, role: 'parent' })).items.find((item) => item.title === title)
    assert.equal(parentNotice?.link, '/m/parents')
    const parentJob = (await emailJobs()).find((job) => job.dedupeKey === `notices.email:${parentNotice!.id}`)
    assert.deepEqual(parentJob?.payload, { notificationId: parentNotice!.id })
  } finally {
    await authDb.delete(users).where(eq(users.id, parentId))
  }
}))

test('a 30,000-person board fan-out queues the eligible audience in one bulk operation', () => withEmailEnabled(async () => {
  // Roll back the whole fixture to avoid firing every module's user-delete
  // triggers for 30,000 people. Publication itself runs as the app role.
  const rollback = new Error('bulk fixture complete')
  await assert.rejects(authDb.transaction(async (tx) => {
    const [isolated] = await tx.insert(institutions).values({ slug: 'notice-email-bulk-test', name: 'Bulk email test' }).returning()
    const institutionId = isolated!.id
    const [poster] = await tx.insert(users).values({ institutionId, email: 'poster@bulk-email.example', role: 'institution_admin' }).returning()
    await tx.execute(sql`insert into users (id, institution_id, email, role)
      select 'email-bulk-' || n, ${institutionId}, 'student-' || n || '@bulk-email.example', 'student'
      from generate_series(1, 30000) as n`)
    const actor = { institutionId, id: poster!.id, role: 'institution_admin' as const }
    const { rows: [draft] } = await tx.execute<{ id: string }>(sql`
      insert into notices (institution_id, title, body, audience_roles, author_id)
      values (${institutionId}, 'Bulk notice', 'Example notice', array['student']::role[], ${actor.id}) returning id`)
    await tx.execute(sql`set local role campusos_app`)
    await tx.execute(sql`select set_config('app.institution_id', ${institutionId}, true)`)
    const handler = plugin.jobs!.find((job) => job.kind === 'notices.publish')!
    // The owner handle erases the type of the core schema it gets at runtime.
    const outcome = await handler.run(actor, tx as Parameters<typeof handler.run>[1], { noticeId: draft!.id })
    assert.equal((outcome as { reach: number }).reach, 30000)
    const { rows: [queued] } = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from background_jobs where kind = 'notices.email'`)
    assert.equal(queued!.count, 30000)
    throw rollback
  }), (error: unknown) => error === rollback)
}))

test('an enqueue that really fails never fails the producer transaction (review note)', () => withEmailEnabled(async () => {
  // A trigger stands in for an older Notices whose e-mail tables are missing: the e-mail insert fails for real.
  // The test database role is the owner here (AUTH_DATABASE_URL unset), so `authDb` may run DDL.
  await authDb.execute(sql`create or replace function test_fail_email() returns trigger language plpgsql as $$
    begin raise exception 'simulated missing e-mail table'; end $$`)
  await authDb.execute(sql`create trigger test_fail_email before insert on background_jobs for each row
    when (new.kind = 'notices.email') execute function test_fail_email()`)
  const warnings: string[] = []
  const original = console.warn
  console.warn = (line: unknown) => { warnings.push(String(line)) }
  const title = 'Producer survives a failed e-mail enqueue'
  const queuedBefore = (await emailJobs()).length
  try {
    await withTenant(tenant, async (tx) => {
      assert.equal(await notify(tx, tenant, { userIds: [studentId], moduleId: 'fees', title, body: 'Example' }), 1)
      const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from notifications where title = ${title}`)
      assert.equal(rows[0]!.n, 1, 'the inbox row is in the producer transaction after the failed enqueue')
    })
  } finally {
    console.warn = original
    await authDb.execute(sql`drop trigger test_fail_email on background_jobs`)
    await authDb.execute(sql`drop function test_fail_email()`)
  }
  assert.equal((await inbox(student())).items.filter((row) => row.title === title).length, 1, 'the inbox row committed')
  assert.equal((await emailJobs()).length, queuedBefore, 'no queue row for the failed enqueue')
  assert.deepEqual(warnings.map((line) => JSON.parse(line)), [{ event: 'notices.email_enqueue_skipped' }])
}))

test('a hostel_safety notification is e-mailed even when the member has switched notification e-mail off', () => withEmailEnabled(async () => {
  const preference = plugin.routes.find((route) => route.method === 'POST' && route.path === '/preferences/email')!
  const setOptOut = (optedOut: boolean) => preference.handler(student(), new Request('http://localhost/preferences/email', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optedOut }),
  }))
  const deliver = (moduleId: string, title: string) => withTenant(tenant, (tx) =>
    notify(tx, tenant, { userIds: [studentId], moduleId, title, body: 'Example safety text' }))
  await setOptOut(true)
  try {
    const before = (await emailJobs()).length
    await deliver('fees', 'Opted out fee mail')
    assert.equal((await emailJobs()).length, before, 'an ordinary category stays silent')
    await deliver('hostel_safety', 'Safety mail past an opt-out')
    assert.equal((await emailJobs()).length, before + 1, 'a hostel_safety alert is still queued for e-mail')
  } finally {
    await setOptOut(false)
  }
}))
