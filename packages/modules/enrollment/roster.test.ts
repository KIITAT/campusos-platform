import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gte, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academicApi from '@campusos/module-academic/api'
import { sectionMembers } from '@campusos/module-academic/schema'
import * as api from './api'
import * as schema from './schema'
import { registrations } from './schema'

/**
 * FUNC-02 (P1-07a, decisions 701 to 706): a section an administrator marks to
 * follow registration keeps its membership in step with registrations, and
 * every registration change leaves an audit row. Unmarked sections are kept by
 * hand, as before.
 *
 * The slug prefix is not `enrol-`: enrollment.test.ts deletes `enrol-%` when it
 * finishes, and the two files run at the same time.
 */

let n = 0
const SLUG = 'rosterfeed-'

const day = (offset: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

type Actor = api.Actor & { email: string }

interface Campus {
  id: string
  admin: Actor
  faculty: Actor
  a: Actor
  b: Actor
  termId: string
  deptId: string
  /** The cohort section, kept by hand. */
  A: string
  /** The elective section. */
  ML: string
}

const academic = (a: Actor): academicApi.Actor => ({ id: a.id, role: a.role, institutionId: a.institutionId })

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Roster College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const who = [
    ['adm', 'institution_admin'],
    ['fac', 'faculty'],
    ['a', 'student'],
    ['b', 'student'],
  ] as const
  const people = await authDb
    .insert(users)
    .values(who.map(([w, role]) => ({ email: `${w}@${tag}.test`, institutionId: id, role, name: w })))
    .returning({ id: users.id, email: users.email, role: users.role })
  const [admin, faculty, a, b] = people.map((p) => ({ id: p.id, email: p.email!, role: p.role, institutionId: id }) as Actor)

  const dept = await academicApi.createDepartment(academic(admin!), { code: 'CSE', name: 'Computing' })
  const program = await academicApi.createProgram(academic(admin!), {
    departmentId: dept.id,
    code: 'BTCS',
    name: 'B.Tech Computing',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const A = await academicApi.createSection(academic(admin!), { programId: program.id, label: 'A', admissionYear: 2025 })
  const ML = await academicApi.createSection(academic(admin!), { programId: program.id, label: 'ML', admissionYear: 2025 })
  const t = await academicApi.createTerm(academic(admin!), { code: `T${++n}`, name: 'Autumn', startsOn: day(-30), endsOn: day(60) })
  await academicApi.setTermCalendar(academic(admin!), {
    termId: t.id,
    registrationOpensOn: day(-10),
    registrationClosesOn: day(10),
    addDropEndsOn: day(5),
    withdrawEndsOn: day(30),
  })
  return { id, admin: admin!, faculty: faculty!, a: a!, b: b!, termId: t.id, deptId: dept.id, A: A.id, ML: ML.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function offering(c: Campus, sectionId: string) {
  const course = await academicApi.createCourse(academic(c.admin), { departmentId: c.deptId, code: `C${++n}`, title: 'Elective', credits: 4 })
  return academicApi.createOffering(academic(c.admin), { termId: c.termId, courseId: course.id, sectionId })
}

async function member(c: Campus, sectionId: string, userId: string) {
  const rows = await withTenant(c.id, (tx) =>
    tx
      .select({ userId: sectionMembers.userId })
      .from(sectionMembers)
      .where(and(eq(sectionMembers.sectionId, sectionId), eq(sectionMembers.userId, userId))),
  )
  return rows.length > 0
}

const feed = (c: Campus, sectionId: string, fed: boolean) => api.setSectionFeed(c.admin, { sectionId, fed })

/** Until `n` sessions are waiting on a lock in a statement that matches (from academic/consents.test.ts). */
async function waitingOn(pattern: string, n = 1) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern}`)
    if (r.rows[0]!.n >= n) return
    if (Date.now() > deadline) throw new Error(`nobody is waiting on ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a registrant joins a section that follows registration, and leaves it on dropping', async () => {
  const c = await campus()
  const o = await offering(c, c.ML)
  assert.deepEqual(await feed(c, c.ML, true), { sectionId: c.ML, fed: true, added: 0 })
  await api.register(c.a, { offeringId: o.id })
  assert.equal(await member(c, c.ML, c.a.id), true)
  await api.drop(c.a, { offeringId: o.id })
  assert.equal(await member(c, c.ML, c.a.id), false)
})

test('a waitlisted student joins only when a place comes free', async () => {
  const c = await campus()
  const o = await offering(c, c.ML)
  await feed(c, c.ML, true)
  await api.setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1, waitlistCapacity: 1 })
  await api.register(c.a, { offeringId: o.id })
  const b = await api.register(c.b, { offeringId: o.id })
  assert.equal(b.status, 'waitlisted')
  assert.equal(await member(c, c.ML, c.b.id), false)
  await api.drop(c.a, { offeringId: o.id })
  assert.equal(await member(c, c.ML, c.b.id), true)
  assert.equal(await member(c, c.ML, c.a.id), false)
})

test('a student in two courses of the section stays until the last is dropped', async () => {
  const c = await campus()
  const o1 = await offering(c, c.ML)
  const o2 = await offering(c, c.ML)
  await feed(c, c.ML, true)
  await api.register(c.a, { offeringId: o1.id })
  await api.register(c.a, { offeringId: o2.id })
  await api.drop(c.a, { offeringId: o1.id })
  assert.equal(await member(c, c.ML, c.a.id), true)
  await api.drop(c.a, { offeringId: o2.id })
  assert.equal(await member(c, c.ML, c.a.id), false)
})

test('marking a section brings in those already registered, and unmarking removes nobody', async () => {
  const c = await campus()
  const o = await offering(c, c.ML)
  await api.register(c.a, { offeringId: o.id })
  assert.equal(await member(c, c.ML, c.a.id), false)
  const on = await feed(c, c.ML, true)
  assert.equal(on.added, 1)
  assert.equal(await member(c, c.ML, c.a.id), true)
  assert.deepEqual(await feed(c, c.ML, false), { sectionId: c.ML, fed: false, added: 0 })
  assert.equal(await member(c, c.ML, c.a.id), true)
  await api.drop(c.a, { offeringId: o.id })
  assert.equal(await member(c, c.ML, c.a.id), true)
})

test('a section that does not follow registration is untouched', async () => {
  const c = await campus()
  const o = await offering(c, c.A)
  await academicApi.addSectionMember(academic(c.admin), { sectionId: c.A, userId: c.b.id })
  await api.register(c.a, { offeringId: o.id })
  await api.register(c.b, { offeringId: o.id })
  assert.equal(await member(c, c.A, c.a.id), false)
  await api.drop(c.b, { offeringId: o.id })
  assert.equal(await member(c, c.A, c.b.id), true)
})

test('a drop waits for a registration in flight in the same section', async () => {
  const c = await campus()
  const o1 = await offering(c, c.ML)
  const o2 = await offering(c, c.ML)
  await feed(c, c.ML, true)
  await api.register(c.a, { offeringId: o1.id })

  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = withTenant(c.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'enrollment.member:' + c.ML + ':' + c.a.id}, 0))`)
    await tx.insert(registrations).values({ institutionId: c.id, studentId: c.a.id, offeringId: o2.id, termId: c.termId, status: 'registered', credits: 4 })
    holding()
    await held
  })
  await locked
  const dropping = api.drop(c.a, { offeringId: o1.id })
  try {
    await waitingOn('%pg_advisory_xact_lock%', 1)
  } finally {
    release()
    await holder
  }
  await dropping
  assert.equal(await member(c, c.ML, c.a.id), true)
})

test('every registration change is audited', async () => {
  const c = await campus()
  const [{ at }] = (await authDb.execute<{ at: string }>(sql`select clock_timestamp() as at`)).rows as [{ at: string }]
  const o = await offering(c, c.ML)
  await api.setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1, waitlistCapacity: 1 })
  await feed(c, c.ML, true)
  await api.register(c.a, { offeringId: o.id })
  await api.register(c.b, { offeringId: o.id })
  await api.drop(c.a, { offeringId: o.id })

  const rows = await authDb
    .select({ action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.moduleId, 'enrollment'), gte(auditLog.at, new Date(at))))
  assert.deepEqual(rows.map((r) => r.action).sort(), [
    'offering.limit_set',
    'registration.dropped',
    'registration.promoted',
    'registration.registered',
    'registration.waitlisted',
    'section.fed',
  ])
  const registered = rows.find((r) => r.action === 'registration.registered')!
  assert.equal((registered.detail as { joinedSection?: boolean }).joinedSection, true)
})

test("another institution neither sees nor marks this one's sections", async () => {
  const c = await campus()
  const d = await campus()
  await feed(c, c.ML, true)
  assert.deepEqual(await withTenant(d.id, (tx) => tx.select().from(schema.fedSections)), [])
  await assert.rejects(() =>
    withTenant(d.id, (tx) => tx.insert(schema.fedSections).values({ institutionId: c.id, sectionId: d.ML })),
  )
  await assert.rejects(
    () => api.setSectionFeed(d.admin, { sectionId: c.ML, fed: true }),
    (e: unknown) => (e as { code?: string }).code === 'no_such_section',
  )
})

test('a student or a lecturer cannot change how a section is kept', async () => {
  const c = await campus()
  for (const who of [c.a, c.faculty]) {
    await assert.rejects(
      () => api.setSectionFeed(who, { sectionId: c.ML, fed: true }),
      (e: unknown) => (e as { status?: number }).status === 403 && (e as { code?: string }).code === 'forbidden',
    )
  }
})
