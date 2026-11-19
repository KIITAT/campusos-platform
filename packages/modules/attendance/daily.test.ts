import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { and, eq, gte, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { AttendanceError, attendanceSummary, dailySheet, grantExcuse, markDay, type Actor } from './api'

/**
 * A section's daily register, kept by its class teacher (P1-13a): one
 * submission marks the whole section, absentees and their guardians are told
 * once, and only the class teacher or the office keeps it.
 */

const SLUG = 'att-daily'
let inst = ''
let since = new Date(0)
const ids = { ct: '', other: '', adm: '', s1: '', s2: '', s3: '', section: '', term: '', guardian: '' }
const names = { program: '', section: '' }

const A = (id: string, role: Actor['role']): Actor => ({ id, role, institutionId: inst }) as Actor
const ct = () => A(ids.ct, 'faculty')
const admin = () => A(ids.adm, 'institution_admin')

const DAY = 86_400_000
const IST = 330 * 60_000
const daysAgo = (n: number) => new Date(Date.now() + IST - n * DAY).toISOString().slice(0, 10)
const today = () => daysAgo(0)
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', dateStyle: 'medium' })

const code = (e: unknown) => (e as AttendanceError).code
const status = (e: unknown) => (e as AttendanceError).status

const inboxOf = async (id: string) =>
  (await withTenant(inst, (tx) => tx.execute(sql`select title, link from notifications where user_id = ${id} order by created_at`))).rows as { title: string; link: string }[]
const absences = async (id: string) => (await inboxOf(id)).filter((m) => /^Absent on /.test(m.title))

const marks = async (day = today()) =>
  (
    await withTenant(inst, (tx) =>
      tx.execute(sql`select student_id, present from attendance_daily_marks where section_id = ${ids.section} and on_date = ${day}::date order by student_id`),
    )
  ).rows as { student_id: string; present: boolean }[]

const expected = (absent: string[]) =>
  [ids.s1, ids.s2].sort().map((id) => ({ student_id: id, present: !absent.includes(id) }))

const settle = <T>(p: Promise<T>) =>
  p.then(() => ({ ok: true as const, error: null as unknown }), (error: unknown) => ({ ok: false as const, error }))

before(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Daily School', allowedEmailDomains: [`${SLUG}.test`] })
    .returning({ id: institutions.id })
  inst = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `ct@${SLUG}.test`, institutionId: inst, role: 'faculty', name: 'Class Teacher' },
      { email: `other@${SLUG}.test`, institutionId: inst, role: 'faculty', name: 'Other' },
      { email: `adm@${SLUG}.test`, institutionId: inst, role: 'institution_admin', name: 'Office' },
      { email: `s1@${SLUG}.test`, institutionId: inst, role: 'student', name: 'Asha' },
      { email: `s2@${SLUG}.test`, institutionId: inst, role: 'student', name: 'Bilal' },
      { email: `s3@${SLUG}.test`, institutionId: inst, role: 'student', name: 'Chitra' },
    ])
    .returning({ id: users.id })
  ;[ids.ct, ids.other, ids.adm, ids.s1, ids.s2, ids.s3] = people.map((p) => p.id) as [string, string, string, string, string, string]

  const setup = admin()
  const dept = await academic.createDepartment(setup, { code: 'sch', name: 'School' })
  const prog = await academic.createProgram(setup, { departmentId: dept.id, code: 'class-6', name: 'Class 6', level: 'school', durationTerms: 2 })
  const term = await academic.createTerm(setup, { code: '2026-t1', name: '2026-27 term 1', startsOn: '2026-04-01', endsOn: '2027-03-31' })
  await academic.setCurrentTerm(setup, { termId: term.id })
  ids.term = term.id
  const section = await academic.createSection(setup, { programId: prog.id, label: 'A', admissionYear: 2026 })
  ids.section = section.id
  names.program = prog.code
  names.section = section.label
  await academic.setClassTeacher(setup, { sectionId: section.id, email: `ct@${SLUG}.test` })
  await academic.addSectionMember(setup, { sectionId: section.id, userId: ids.s1 })
  await academic.addSectionMember(setup, { sectionId: section.id, userId: ids.s2 })

  // A parent the office has verified for s2.
  const [par] = await authDb.insert(users).values({ email: `par@${SLUG}.test`, institutionId: inst, role: 'parent', name: 'Par' }).returning({ id: users.id })
  await authDb.execute(sql`insert into parent_links (institution_id, parent_id, student_id, relation, verified_at) values (${inst}, ${par!.id}, ${ids.s2}, 'mother', now())`)
  ids.guardian = par!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`delete from attendance_daily_marks`)
    await tx.execute(sql`delete from notifications`)
    await tx.execute(sql`update attendance_excuses set revoked_at = now(), revoked_by = ${ids.adm}, revoke_reason = 'test reset' where revoked_at is null`)
    since = new Date(Math.floor(Number((await tx.execute<{ ms: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as ms`)).rows[0]!.ms)))
  })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('the class teacher marks a section’s day in one submission', async () => {
  const r = await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] })
  assert.equal(r.present, 1)
  assert.equal(r.absent, 1)
  assert.deepEqual(await marks(), expected([ids.s2]))
})

test('an absent student and their guardian are told, once', async () => {
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] })
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] })
  const mine = await absences(ids.s2)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.title, `Absent on ${fmt(today())}`)
  assert.equal(mine[0]!.link, '/m/attendance/me')
  const theirs = await absences(ids.guardian)
  assert.equal(theirs.length, 1)
  assert.equal(theirs[0]!.link, '/m/parents')
  assert.equal((await absences(ids.s1)).length, 0)
})

test('a correction tells only the newly absent', async () => {
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [] })
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s1] })
  assert.equal((await absences(ids.s1)).length, 1)
  assert.equal((await absences(ids.s2)).length, 0)
  assert.deepEqual(await marks(), expected([ids.s1]))
})

test('a student excused for the day is marked absent but not told', async () => {
  await grantExcuse(admin(), { studentId: ids.s2, fromOn: today(), toOn: today(), kind: 'medical', reason: 'fever, doctor’s note seen' })
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] })
  assert.equal((await absences(ids.s2)).length, 0)
  assert.deepEqual(await marks(), expected([ids.s2]))
})

test('only the class teacher or the office marks the register', async () => {
  const input = { sectionId: ids.section, onDate: today(), absent: [ids.s2] }
  await assert.rejects(markDay(A(ids.other, 'faculty'), input), (e) => status(e) === 403 && code(e) === 'not_class_teacher')
  await assert.rejects(markDay(A(ids.s1, 'student'), input), (e) => status(e) === 403 && code(e) === 'forbidden')
  await markDay(admin(), input)
  await assert.rejects(dailySheet(A(ids.other, 'faculty'), ids.section), (e) => status(e) === 403 && code(e) === 'not_class_teacher')
})

test('a student outside the section cannot be marked', async () => {
  await assert.rejects(
    markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s3] }),
    (e) => status(e) === 400 && code(e) === 'not_in_section',
  )
  assert.deepEqual(await marks(), [])
})

test('a day in the future or more than a week back is refused', async () => {
  for (const onDate of [daysAgo(-1), daysAgo(8)]) {
    await assert.rejects(
      markDay(ct(), { sectionId: ids.section, onDate, absent: [] }),
      (e) => status(e) === 400 && code(e) === 'day_out_of_range',
    )
  }
  await markDay(ct(), { sectionId: ids.section, onDate: daysAgo(7), absent: [] })
})

test('each submission is on the audit trail', async () => {
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [] })
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] })
  const rows = await withTenant(inst, (tx) =>
    tx
      .select({ reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'attendance.daily_marked'), eq(auditLog.entityId, `${ids.section}:${today()}`), gte(auditLog.at, since)))
      .orderBy(auditLog.at),
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[1]!.reason, '1 absent of 2; 1 corrected')
})

test('two saves at once tell an absentee once', async () => {
  const key = `attendance.daily:${ids.section}:${today()}`
  const { Client } = createRequire(new URL('../../db/package.json', import.meta.url))('pg') as { Client: new (o: { connectionString?: string }) => { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<unknown>; end(): Promise<void> } }
  const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await owner.connect()
  try {
    await owner.query('select pg_advisory_lock(hashtextextended($1, 0))', [key])
    const one = settle(markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] }))
    const two = settle(markDay(admin(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] }))
    const deadline = Date.now() + 10_000
    for (;;) {
      const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`)
      if (r.rows[0]!.n >= 2) break
      if (Date.now() > deadline) throw new Error('timed out waiting for both saves to wait on the register lock')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await owner.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
    const results = await Promise.all([one, two])
    assert.deepEqual(results.map((r) => r.ok), [true, true], String(results.find((r) => !r.ok)?.error))
    assert.equal((await absences(ids.s2)).length, 1)
  } finally {
    await owner.query('select pg_advisory_unlock_all()').catch(() => {})
    await owner.end()
  }
})

test('another institution sees none of the register', async () => {
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [] })
  const [o] = await authDb
    .insert(institutions)
    .values({ slug: `${SLUG}-other`, name: 'Other School', allowedEmailDomains: [`${SLUG}-other.test`] })
    .returning({ id: institutions.id })
  try {
    const r = await withTenant(o!.id, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from attendance_daily_marks`))
    assert.equal(r.rows[0]!.n, 0)
    await assert.rejects(
      withTenant(o!.id, (tx) =>
        tx.execute(sql`insert into attendance_daily_marks (institution_id, section_id, on_date, student_id, present) values (${inst}, ${ids.section}, ${today()}::date, ${ids.s1}, true)`),
      ),
    )
  } finally {
    await authDb.delete(institutions).where(eq(institutions.slug, `${SLUG}-other`))
  }
})

test('the daily sheet lists the section’s students and who is absent', async () => {
  await markDay(ct(), { sectionId: ids.section, onDate: today(), absent: [ids.s2] })
  const v = await dailySheet(ct(), ids.section, today())
  assert.deepEqual(v.sections, [{ value: ids.section, label: `${names.program}-${names.section} (2026)` }])
  assert.deepEqual(v.students.map((s) => s.value), [ids.s1, ids.s2])
  assert.deepEqual(v.absent, [ids.s2])
  assert.equal(v.marked, true)
  const office = await dailySheet(admin())
  assert.ok(office.sections.some((s) => s.value === ids.section))
})

test('the attendance summary carries the register', async () => {
  await markDay(ct(), { sectionId: ids.section, onDate: daysAgo(2), absent: [ids.s2] })
  await markDay(ct(), { sectionId: ids.section, onDate: daysAgo(1), absent: [] })
  const check = (lines: Awaited<ReturnType<typeof attendanceSummary>>, term: string) => {
    const d = lines.find((l) => l.kind === 'daily')
    assert.ok(d, 'a daily line')
    assert.equal(d.offeringId, ids.section)
    assert.equal(d.courseCode, 'Daily')
    assert.equal(d.held, 2)
    assert.equal(d.present, 1)
    assert.equal(d.excused, 0)
    assert.equal(d.absent, 1)
    assert.equal(d.percent, 50)
    assert.equal(d.teacher, 'Class Teacher')
    assert.equal(d.term, term)
    assert.ok(lines.filter((l) => l !== d).every((l) => l.kind === 'period'))
  }
  check(await attendanceSummary(admin(), ids.s2), '')
  check(await attendanceSummary(admin(), ids.s2, ids.term), '2026-t1')
})
