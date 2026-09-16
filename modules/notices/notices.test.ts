import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog, authDb, db, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  NoticeError,
  board,
  createNotice,
  emailNotice,
  inbox,
  markRead,
  notify,
  publishNotice,
  readNotice,
  withdrawNotice,
  type Actor,
} from './api'
import { notices, notifications } from './schema'

const SLUG = 'notice-test'
const OTHER = 'notice-other'
let inst: string
let other: string
const ids = { adm: '', fac: '', s1: '', s2: '', pending: '' }
let deptId = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@notice.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const teacher = () => A({ id: ids.fac, email: 'fac@notice.test', role: 'faculty' })
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as NoticeError).code
const status = (e: unknown) => (e as NoticeError).status

/** Drizzle hangs the real Postgres message off .cause; look down the chain. */
const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

const post = (over: Record<string, unknown> = {}) =>
  createNotice(admin(), {
    title: 'Library closed on Friday',
    body: 'The library will be shut all day for stocktaking.',
    ...over,
  })

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Notice College', allowedEmailDomains: ['notice.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['noticeother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@notice.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'fac@notice.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 's1@notice.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@notice.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 'new@notice.test', institutionId: inst, role: 'pending', name: 'Not Approved' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.fac = people[1]!.id
  ids.s1 = people[2]!.id
  ids.s2 = people[3]!.id
  ids.pending = people[4]!.id

  deptId = (await academic.createDepartment(admin(), { code: 'cse', name: 'CSE' })).id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(notifications)
    await tx.delete(notices)
    await tx.delete(auditLog)
  })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- posting ---------------------------------------------------------------

test('a student cannot post a notice', async () => {
  await assert.rejects(
    () => createNotice(student(ids.s1), { title: 'x', body: 'y' }),
    (e: unknown) => status(e) === 403,
  )
})

test('a lecturer may address students but not the whole staff', async () => {
  const ok = await createNotice(teacher(), {
    title: 'Class moved',
    body: 'Thursday lecture is in room 204.',
    audienceRoles: ['student'],
  })
  assert.ok(ok.id)

  await assert.rejects(
    () =>
      createNotice(teacher(), {
        title: 'Staff meeting',
        body: 'All staff to attend.',
        audienceRoles: ['faculty', 'institution_admin'],
      }),
    (e: unknown) => code(e) === 'audience_too_wide',
  )
})

test('publishing delivers one inbox item per addressee', async () => {
  await post({ audienceRoles: ['student'] })

  const s1 = await inbox(student(ids.s1))
  const s2 = await inbox(student(ids.s2))
  const adm = await inbox(admin())
  assert.equal(s1.unread, 1)
  assert.equal(s2.unread, 1)
  assert.equal(adm.unread, 0, 'not addressed to administrators')
})

test('an empty audience means everybody, except accounts not yet approved', async () => {
  await post({ audienceRoles: [] })
  assert.equal((await inbox(admin())).unread, 1)
  assert.equal((await inbox(teacher())).unread, 1)
  assert.equal((await inbox(student(ids.s1))).unread, 1)

  const forPending = await withTenant(inst, (tx) =>
    tx.select().from(notifications).where(eq(notifications.userId, ids.pending)),
  )
  assert.equal(forPending.length, 0, 'a pending account is not an audience')
})

test('a draft notifies nobody until it is published', async () => {
  const draft = await post({ publish: false, audienceRoles: ['student'] })
  assert.equal(draft.publishedAt, null)
  assert.equal((await inbox(student(ids.s1))).unread, 0)

  const published = await publishNotice(admin(), { noticeId: draft.id })
  assert.equal(published.reach, 2)
  assert.equal((await inbox(student(ids.s1))).unread, 1)
})

test('publishing twice is refused rather than delivering twice', async () => {
  const draft = await post({ publish: false })
  await publishNotice(admin(), { noticeId: draft.id })
  await assert.rejects(
    () => publishNotice(admin(), { noticeId: draft.id }),
    (e: unknown) => code(e) === 'already_published',
  )
})

// --- reading ---------------------------------------------------------------

test('a reader sees what is addressed to them and not what is not', async () => {
  await post({ title: 'For students', audienceRoles: ['student'] })
  await post({ title: 'For staff', audienceRoles: ['faculty'] })

  const seen = (await board(student(ids.s1))).map((n) => n.title)
  assert.deepEqual(seen, ['For students'])
  assert.equal((await board(admin(), true)).length, 2, 'the office sees both')
})

test('a notice cannot be published already expired', async () => {
  await assert.rejects(
    () => post({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    saysDb(/notices_expiry/),
  )
})

test('an expired notice drops off the board', async () => {
  const n = await post({ title: 'Yesterday' })
  assert.equal((await board(student(ids.s1))).length, 1)

  await withTenant(inst, (tx) =>
    tx.update(notices).set({ expiresAt: new Date() }).where(eq(notices.id, n.id)),
  )
  assert.equal((await board(student(ids.s1))).length, 0)
})

test('a pinned notice sorts first', async () => {
  await post({ title: 'Ordinary' })
  await post({ title: 'Important', pinned: true })
  assert.equal((await board(student(ids.s1)))[0]!.title, 'Important')
})

test('a draft is invisible to a reader but visible to the office', async () => {
  await post({ title: 'Not yet', publish: false })
  assert.equal((await board(student(ids.s1))).length, 0)
  assert.equal((await board(admin(), true)).length, 1)
})

test('the board reports reach and how many have read it', async () => {
  const n = await post({ audienceRoles: ['student'] })
  const one = await inbox(student(ids.s1))
  await markRead(student(ids.s1), { notificationId: one.items[0]!.id })

  const row = await readNotice(admin(), n.id)
  assert.equal(row.reach, 2)
  assert.equal(row.readCount, 1)
})

// --- the inbox -------------------------------------------------------------

test('marking one read leaves the rest alone', async () => {
  await post({ title: 'First', audienceRoles: ['student'] })
  await post({ title: 'Second', audienceRoles: ['student'] })

  const before = await inbox(student(ids.s1))
  assert.equal(before.unread, 2)
  await markRead(student(ids.s1), { notificationId: before.items[0]!.id })
  assert.equal((await inbox(student(ids.s1))).unread, 1)
})

test('marking the whole inbox read clears it', async () => {
  await post({ title: 'First', audienceRoles: ['student'] })
  await post({ title: 'Second', audienceRoles: ['student'] })
  const r = await markRead(student(ids.s1), {})
  assert.equal(r.marked, 2)
  assert.equal((await inbox(student(ids.s1))).unread, 0)
})

test('one reader marking read does not mark it for another', async () => {
  await post({ audienceRoles: ['student'] })
  await markRead(student(ids.s1), {})
  assert.equal((await inbox(student(ids.s2))).unread, 1)
})

test('any module can write into the inbox, in its own transaction', async () => {
  const n = await withTenant(inst, (tx) =>
    notify(tx, inst, {
      userIds: [ids.s1, ids.s1, ids.s2],
      moduleId: 'fees',
      title: 'Fees due',
      body: 'Tuition for this term is due on the 15th.',
      link: '/fees/me',
    }),
  )
  assert.equal(n, 2, 'duplicate recipients collapse')

  const box = await inbox(student(ids.s1))
  assert.equal(box.items[0]!.moduleId, 'fees')
  assert.equal(box.items[0]!.link, '/fees/me')
})

test('an inbox link must be relative, and the database says so', async () => {
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(notifications).values({
          institutionId: inst,
          userId: ids.s1,
          moduleId: 'fees',
          title: 'Phishy',
          body: 'Click here',
          link: 'https://example.invalid/steal',
        }),
      ),
    saysDb(/notifications_link/),
  )
})

// --- withdrawing -----------------------------------------------------------

test('withdrawing takes the notice and its inbox copies away, and is audited', async () => {
  const n = await post({ audienceRoles: ['student'] })
  assert.equal((await inbox(student(ids.s1))).unread, 1)

  await withdrawNotice(admin(), { noticeId: n.id, reason: 'posted to the wrong cohort' })
  assert.equal((await inbox(student(ids.s1))).unread, 0)
  assert.equal((await board(student(ids.s1))).length, 0)

  const trail = await withTenant(inst, (tx) =>
    tx.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog),
  )
  assert.equal(trail[0]!.action, 'notice.withdrawn')
  assert.match(trail[0]!.reason!, /wrong cohort/)
})

test('a lecturer cannot withdraw somebody else s notice', async () => {
  const n = await post()
  await assert.rejects(
    () => withdrawNotice(teacher(), { noticeId: n.id, reason: 'not mine to remove' }),
    (e: unknown) => code(e) === 'not_yours',
  )
})

// --- email -----------------------------------------------------------------

test('without a mail provider, emailing reports that it sent nothing', async () => {
  const before = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  try {
    const n = await post({ audienceRoles: ['student'] })
    const r = await emailNotice(admin(), n.id)
    assert.equal(r.sent, 0)
    assert.equal(r.skipped, 'not_configured')
    assert.equal(r.queued, 2, 'the recipients are known; only delivery is absent')
    assert.equal((await inbox(student(ids.s1))).emailConfigured, false)
  } finally {
    if (before !== undefined) process.env.RESEND_API_KEY = before
  }
})

// --- tenancy ---------------------------------------------------------------

test('another institution sees none of this, and RLS not the query says so', async () => {
  await post()
  const seen = await withTenant(other, async (tx) => ({
    notices: await tx.select().from(notices),
    notifications: await tx.select().from(notifications),
  }))
  assert.deepEqual([seen.notices.length, seen.notifications.length], [0, 0])
})

test('a notice never reaches a reader in another institution', async () => {
  await post({ audienceRoles: [] })
  const delivered = await withTenant(inst, (tx) =>
    tx.select({ userId: notifications.userId }).from(notifications),
  )
  assert.ok(delivered.length > 0)
  assert.ok(
    delivered.every((d) => [ids.adm, ids.fac, ids.s1, ids.s2].includes(d.userId)),
    'the fan-out is scoped to this institution',
  )
})

test('a session with no tenant set reads nothing rather than erroring', async () => {
  await post()
  assert.equal((await db.select().from(notices)).length, 0)
})

test('a department-scoped notice records its department', async () => {
  const n = await post({ departmentId: deptId })
  const row = await readNotice(admin(), n.id)
  // academic normalises codes to upper case on the way in.
  assert.equal(row.departmentCode, 'CSE')
})
