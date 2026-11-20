import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import * as attendance from '@campusos/module-attendance/api'
import * as fees from '@campusos/module-fees/api'
import * as exams from './api'
import { plugin } from './plugin'
import { cyclePages } from './cycle-pages'

/**
 * The exam gate (FUNC-01, P1-07b): an enrolment and an admit card need the
 * attendance the institution requires and no posted dues for the term, unless
 * the examination cell has waived that check, with a reason, on the record.
 * Each test builds its own institution; modules are switched on per test.
 */

const SLUG = 'exam-eligibility-'
let n = 0
const H = 3600_000
const DAY = 86_400_000
const IST = 330 * 60_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const day = (offset: number) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10)
const REASON = 'Administrative: agreed with the principal'

type Actor = exams.Actor
const code = (e: unknown) => (e as exams.ExamError).code
const status = (e: unknown) => (e as exams.ExamError).status
const settle = <T>(p: Promise<T>) => p.then(() => ({ ok: true as const, error: null as unknown }), (error: unknown) => ({ ok: false as const, error }))
const enable = (institutionId: string, ...ids: string[]) =>
  !ids.length ? Promise.resolve() : authDb
    .insert(institutionModules)
    .values(ids.map((moduleId) => ({ institutionId, moduleId, enabled: true })))
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

interface Opts {
  attendance?: boolean
  fees?: boolean
  school?: boolean
}

/** A fresh institution: one programme, a current term around today, two classes of one section, an open enrolment window. */
async function campus(o: Opts = {}) {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb.insert(institutions).values({ slug: tag, name: 'Gate University', allowedEmailDomains: [`${tag}.test`] }).returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Exam Cell' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `hod@${tag}.test`, institutionId: id, role: 'hod', name: 'Head' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Roy' },
      { email: `bilal@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan' },
    ])
    .returning({ id: users.id })
  const [adm, t, hod, clerk, asha, bilal] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'CSE', name: 'Computing' })
  const prog = await academic.createProgram(a, {
    departmentId: dept.id,
    code: o.school ? 'CLS6' : 'BTCS',
    name: o.school ? 'Class 6' : 'B.Tech CSE',
    level: o.school ? 'school' : 'undergraduate',
    durationTerms: 8,
  })
  const past = await academic.createTerm(a, { code: `P${n}`, name: 'Past', startsOn: day(-200), endsOn: day(-100) })
  const term = await academic.createTerm(a, { code: `C${n}`, name: 'Current', startsOn: o.school ? day(-1) : day(-60), endsOn: day(60) })
  await academic.setCurrentTerm(a, { termId: term.id })
  const ds = await academic.createCourse(a, { departmentId: dept.id, code: `DS${n}`, title: 'Data Structures', credits: 4 })
  const ps = await academic.createCourse(a, { departmentId: dept.id, code: `PS${n}`, title: 'Probability', credits: 3 })
  const room = await academic.createRoom(a, { code: `LH-${n}` })
  const sec = await academic.createSection(a, { programId: prog.id, label: 'A', admissionYear: 2026 })
  for (const s of [asha, bilal]) await academic.addSectionMember(a, { sectionId: sec.id, userId: s })
  const offDs = await academic.createOffering(a, { termId: term.id, courseId: ds.id, sectionId: sec.id, facultyUserId: t })
  const offPs = await academic.createOffering(a, { termId: term.id, courseId: ps.id, sectionId: sec.id, facultyUserId: t })
  const slotDs = await academic.createSlot(a, { offeringId: offDs.id, roomId: room.id, dayOfWeek: 1, startsAt: '09:00', endsAt: '10:00' })
  await academic.setStudentProfile(a, { studentId: asha, rollNo: `R${n}001`, registrationNo: `REG${n}001`, phone: '+91 98765 43210', addressLine: '12 Patia Road', city: 'Bhubaneswar', state: 'Odisha', postalCode: '751024' })
  for (const s of [asha, bilal]) await academic.declareProgram(a, { studentId: s, programId: prog.id, declaredOn: '2025-07-01' })
  await enable(id, ...(o.attendance ? ['attendance'] : []), ...(o.fees ? ['finance', 'fees'] : []))
  await exams.setWindow(admin, { termId: term.id, kind: 'enrolment', opensAt: iso(-H), closesAt: iso(24 * H) })
  const actor = (uid: string, role: Actor['role']) => ({ id: uid, email: `${uid}@x.test`, role, institutionId: id }) as Actor
  return {
    id,
    tag,
    admin,
    a,
    programId: prog.id,
    teacher: actor(t, 'faculty'),
    hod: actor(hod, 'hod'),
    clerk: actor(clerk, 'accounts_staff'),
    asha: actor(asha, 'student'),
    bilal: actor(bilal, 'student'),
    ashaId: asha,
    bilalId: bilal,
    teacherId: t,
    sectionId: sec.id,
    termId: term.id,
    pastTermId: past.id,
    offDs: offDs.id,
    offPs: offPs.id,
    slot: slotDs.id,
    deptId: dept.id,
  }
}
type Campus = Awaited<ReturnType<typeof campus>>

const enrolWith = (c: Campus, who: Actor = c.asha) => exams.enrol(who, { termId: c.termId, confirm: true })
const counts = async (c: Campus) =>
  (
    await withTenant(c.id, (tx) =>
      tx.execute<{ e: number; p: number }>(sql`select (select count(*)::int from exam_enrolments) as e, (select count(*)::int from exam_enrolment_papers) as p`),
    )
  ).rows[0]!

/** Closed period sessions for an offering; the student is present in those marked true. */
async function register(c: Campus, offeringId: string, slotId: string, present: boolean[], student = c.ashaId) {
  const ids: string[] = []
  await withTenant(c.id, async (tx) => {
    for (const here of present) {
      const r = await tx.execute<{ id: string }>(sql`
        insert into attendance_sessions (institution_id, slot_id, offering_id, opened_by, token_secret, closed_at)
        values (${c.id}, ${slotId}, ${offeringId}, ${c.teacherId}, 'fixture', now()) returning id`)
      const sid = r.rows[0]!.id
      ids.push(sid)
      if (here) await markHere(tx, c, sid, student)
    }
  })
  return ids
}
const markHere = (tx: Parameters<Parameters<typeof withTenant>[1]>[0], c: Campus, sessionId: string, student: string) =>
  tx.execute(sql`
    insert into attendance_records (institution_id, session_id, student_id, method, override_reason, marked_by)
    values (${c.id}, ${sessionId}, ${student}, 'manual_override', 'fixture', ${c.teacherId})`)

const waive = (c: Campus, check: 'attendance' | 'dues', action: 'grant' | 'revoke', over: Record<string, unknown> = {}) =>
  // Namespace call: the operation does not exist before the item.
  (exams as unknown as { setEligibilityWaiver(a: Actor, i: unknown): Promise<{ changed: boolean; waived: boolean; notice: string }> }).setEligibilityWaiver(c.admin, {
    termId: c.termId,
    studentId: c.ashaId,
    check,
    action,
    reason: REASON,
    ...over,
  })

async function owe(c: Campus, termId = c.termId, amount = '45000') {
  await fees.createFeeItem(c.admin as unknown as fees.Actor, { programId: c.programId, termId, label: 'Tuition', amount })
  await fees.issueInvoices(c.admin as unknown as fees.Actor, { termId })
}
const pay = (c: Campus, amount: string, termId = c.termId) =>
  fees.recordPayment(c.clerk as unknown as fees.Actor, { studentId: c.ashaId, termId, amount, method: 'cash' })

// --- 1. attendance ---------------------------------------------------------------

test('enrolment needs the attendance the institution requires, counted exactly', async () => {
  const c = await campus({ attendance: true })
  const sessions = await register(c, c.offDs, c.slot, [true, true, false, false])
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_short' && status(e) === 409)
  assert.deepEqual(await counts(c), { e: 0, p: 0 }, 'a refusal writes no enrolment and no paper')
  await withTenant(c.id, (tx) => markHere(tx, c, sessions[2]!, c.ashaId))
  const e = await enrolWith(c)
  assert.match(e.notice, /Enrolled for 2 papers/)
})

test('the boundary is exact: 2,999 of 4,000 reads 75.0 and still fails', () => {
  const lines = [{ kind: 'period', offeringId: 'o', courseCode: 'X', courseTitle: 'X', teacher: null, term: 't', held: 4000, present: 2999, excused: 0, absent: 1001, percent: 75, short: false, needed: 0 }]
  const rules = { minimumPercent: 75, excusedCounts: true, timeZone: 'Asia/Kolkata' }
  const d = exams.attendanceDecision(lines as never, rules, { kind: 'period', offeringIds: ['o'] })
  assert.equal(d.state, 'failed')
  assert.equal(d.percent, 75)
  assert.equal(d.held, 4000)
  assert.equal(d.counted, 2999)
  const ok = exams.attendanceDecision([{ ...lines[0]!, present: 3000 }] as never, rules, { kind: 'period', offeringIds: ['o'] })
  assert.equal(ok.state, 'passed')
  assert.equal(exams.attendanceDecision([] as never, rules, { kind: 'ambiguous' }).state, 'unavailable')
})

test('an empty register is unavailable, not passed', async () => {
  const c = await campus({ attendance: true })
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_unavailable' && status(e) === 409)
  assert.deepEqual(await counts(c), { e: 0, p: 0 })
})

test('excused absences count only when the institution says so', async () => {
  const c = await campus({ attendance: true })
  await attendance.setAttendanceRules(c.admin as unknown as attendance.Actor, { minimumPercent: 75, excusedCounts: false, timeZone: 'Asia/Kolkata' })
  await register(c, c.offDs, c.slot, [true, true, false, false])
  await attendance.grantExcuse(c.admin as unknown as attendance.Actor, { studentId: c.ashaId, fromOn: day(0), toOn: day(0), kind: 'medical', reason: 'fever, doctor’s note seen' })
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_short')
  await attendance.setAttendanceRules(c.admin as unknown as attendance.Actor, { minimumPercent: 75, excusedCounts: true, timeZone: 'Asia/Kolkata' })
  await enrolWith(c)
})

test('with Attendance off the check is skipped, whatever the old sessions say', async () => {
  const c = await campus({})
  await register(c, c.offDs, c.slot, [false, false, false, false])
  await enrolWith(c)
})

test('a period mark in another term does not count', async () => {
  const c = await campus({ attendance: true })
  await register(c, c.offDs, c.slot, [true, false, false, false])
  const a = c.a
  const old = await academic.createOffering(a, { termId: c.pastTermId, courseId: (await academic.createCourse(a, { departmentId: c.deptId, code: `OLD${n}`, title: 'Old', credits: 2 })).id, sectionId: c.sectionId, facultyUserId: c.teacherId })
  const slot = await academic.createSlot(a, { offeringId: old.id, roomId: (await academic.createRoom(a, { code: `OLD-${n}` })).id, dayOfWeek: 2, startsAt: '09:00', endsAt: '10:00' })
  await register(c, old.id, slot.id, [true, true, true, true, true, true, true, true])
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_short')
})

// --- 2. dues -------------------------------------------------------------------------

test('posted dues for the term block enrolment and a directly requested card', async () => {
  const c = await campus({ fees: true })
  await fees.createFeeItem(c.admin as unknown as fees.Actor, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '45000' })
  await enrolWith(c) // price list only: nothing is owed until the term is issued
  await fees.issueInvoices(c.admin as unknown as fees.Actor, { termId: c.termId })
  await assert.rejects(exams.admitCard(c.asha, c.ashaId, c.termId), (e) => code(e) === 'exam_dues_outstanding' && status(e) === 409)
  await pay(c, '45000')
  await exams.admitCard(c.asha, c.ashaId, c.termId)
  await pay(c, '1000') // a credit clears too
  await exams.admitCard(c.asha, c.ashaId, c.termId)
  // The student cannot enrol while owing.
  const d = await campus({ fees: true })
  await owe(d)
  await assert.rejects(enrolWith(d), (e) => code(e) === 'exam_dues_outstanding')
  assert.deepEqual(await counts(d), { e: 0, p: 0 })
})

test('a balance in another term does not block this one', async () => {
  const c = await campus({ fees: true })
  await owe(c, c.pastTermId)
  await enrolWith(c)
})

// --- 3. who may print while held ----------------------------------------------------------

test('a hold stops every permitted reader, and access is checked first', async () => {
  const c = await campus({ fees: true })
  await enrolWith(c)
  await owe(c)
  await assert.rejects(exams.admitCard(c.asha, c.ashaId, c.termId), (e) => code(e) === 'exam_dues_outstanding')
  await assert.rejects(exams.admitCard(c.admin, c.ashaId, c.termId), (e) => code(e) === 'exam_dues_outstanding')
  // A lecturer has no admit-card access today; that refusal comes first, before any eligibility state.
  await assert.rejects(exams.admitCard(c.teacher, c.ashaId, c.termId), (e) => code(e) === 'not_your_student')
  await assert.rejects(exams.admitCard(c.bilal, c.ashaId, c.termId), (e) => code(e) === 'not_your_student')
  const other = await campus({})
  await assert.rejects(exams.admitCard(other.teacher, c.ashaId, c.termId), (e) => code(e) === 'not_your_student')
  const route = plugin.routes.find((r) => r.path === '/admit-card.pdf')!
  await assert.rejects(
    Promise.resolve(route.handler(c.asha, new Request(`http://x/?termId=${c.termId}&studentId=${c.ashaId}`)) as Promise<Response>),
    (e) => code(e) === 'exam_dues_outstanding' && status(e) === 409,
  )
})

// --- 4. school registers -----------------------------------------------------------------

test('a school section is judged by its daily register, not its periods', async () => {
  const c = await campus({ attendance: true, school: true })
  await academic.setClassTeacher(c.a, { sectionId: c.sectionId, email: `t@${c.tag}.test` })
  const m = (d: number, absent: string[]) => attendance.markDay(c.admin as unknown as attendance.Actor, { sectionId: c.sectionId, onDate: day(d), absent })
  await m(0, [c.ashaId])
  await m(-1, [c.ashaId])
  for (const d of [-2, -3, -4, -5, -6, -7]) await m(d, []) // before the term began: not counted
  await register(c, c.offDs, c.slot, [true, true, true, true])
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_short')
})

test('a mixed or two-section roster has no single attendance and is unavailable', async () => {
  const c = await campus({ attendance: true, school: true })
  await register(c, c.offDs, c.slot, [true, true, true, true])
  const a = c.a
  const ug = await academic.createProgram(a, { departmentId: c.deptId, code: 'UGX', name: 'UG', level: 'undergraduate', durationTerms: 8 })
  const sec2 = await academic.createSection(a, { programId: ug.id, label: 'B', admissionYear: 2026 })
  await academic.addSectionMember(a, { sectionId: sec2.id, userId: c.ashaId })
  const co = await academic.createCourse(a, { departmentId: c.deptId, code: `MIX${n}`, title: 'Mixed', credits: 2 })
  await academic.createOffering(a, { termId: c.termId, courseId: co.id, sectionId: sec2.id, facultyUserId: c.teacherId })
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_unavailable')
})

// --- 5. waivers -----------------------------------------------------------------------------

test('waivers override only their own dimension, and revoking takes the card back', async () => {
  const c = await campus({ attendance: true, fees: true })
  await register(c, c.offDs, c.slot, [true, false, false, false])
  await owe(c)
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_attendance_short')
  const w = await waive(c, 'attendance', 'grant')
  assert.deepEqual([w.waived, w.changed, w.notice], [true, true, 'Eligibility waiver saved.'])
  await assert.rejects(enrolWith(c), (e) => code(e) === 'exam_dues_outstanding')
  await waive(c, 'dues', 'grant')
  await enrolWith(c)
  await exams.admitCard(c.asha, c.ashaId, c.termId)
  const r = await waive(c, 'dues', 'revoke')
  assert.deepEqual([r.waived, r.changed, r.notice], [false, true, 'Eligibility waiver revoked.'])
  await assert.rejects(exams.admitCard(c.asha, c.ashaId, c.termId), (e) => code(e) === 'exam_dues_outstanding')
  assert.equal((await counts(c)).e, 1, 'the enrolment survives')
  await waive(c, 'attendance', 'revoke')
  await assert.rejects(exams.admitCard(c.asha, c.ashaId, c.termId), (e) => code(e) === 'exam_attendance_short')
})

test('only the examination cell waives, and only for its own students and terms', async () => {
  const c = await campus({ fees: true })
  const call = (who: Actor, over: Record<string, unknown> = {}) =>
    (exams as unknown as { setEligibilityWaiver(a: Actor, i: unknown): Promise<unknown> }).setEligibilityWaiver(who, { termId: c.termId, studentId: c.ashaId, check: 'dues', action: 'grant', reason: REASON, ...over })
  for (const who of [c.teacher, c.hod, c.asha]) await assert.rejects(call(who), (e) => code(e) === 'forbidden' && status(e) === 403)
  const other = await campus({})
  const before = await authDb.select().from(auditLog).where(eq(auditLog.institutionId, c.id))
  await assert.rejects(call(c.admin, { studentId: other.ashaId }), (e) => code(e) === 'no_such_exam_candidate' && status(e) === 404)
  await assert.rejects(call(c.admin, { termId: other.termId }), (e) => code(e) === 'no_such_exam_candidate')
  await assert.rejects(call(other.admin), (e) => code(e) === 'no_such_exam_candidate')
  const after = await authDb.select().from(auditLog).where(eq(auditLog.institutionId, c.id))
  assert.equal(after.length, before.length, 'a refusal writes no audit event')
})

// --- 6. isolation, audit, concurrency ---------------------------------------------------------

test('waivers are tenant-private and a repeat changes and audits nothing', async () => {
  const c = await campus({ fees: true })
  const other = await campus({})
  assert.equal((await waive(c, 'dues', 'grant')).changed, true)
  assert.equal((await waive(c, 'dues', 'grant')).changed, false)
  assert.equal((await waive(c, 'dues', 'revoke')).changed, true)
  assert.equal((await waive(c, 'dues', 'revoke')).changed, false)
  const rows = await authDb.select().from(auditLog).where(and(eq(auditLog.institutionId, c.id), eq(auditLog.moduleId, 'examinations')))
  assert.deepEqual(rows.map((r) => r.action).filter((a) => a.startsWith('eligibility.')).sort(), ['eligibility.waiver_granted', 'eligibility.waiver_revoked'])
  await waive(c, 'dues', 'grant')
  const seen = await withTenant(other.id, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from exam_eligibility_waivers`))
  assert.equal(seen.rows[0]!.n, 0)
  await assert.rejects(
    withTenant(other.id, (tx) =>
      tx.execute(sql`insert into exam_eligibility_waivers (institution_id, term_id, student_id, check_kind) values (${c.id}, ${c.termId}, ${c.ashaId}, 'attendance')`),
    ),
    (e) => /row-level security/.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message)),
  )
})

const { Client } = createRequire(new URL('../../db/package.json', import.meta.url))('pg') as {
  Client: new (o: { connectionString?: string }) => { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<unknown>; end(): Promise<void> }
}
async function waiters(atLeast: number) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`)
    if (r.rows[0]!.n >= atLeast) return
    if (Date.now() > deadline) throw new Error('timed out waiting on the eligibility lock')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('two grants at once change one row and audit once', async () => {
  const c = await campus({ fees: true })
  const key = `examinations.eligibility:${c.id}:${c.termId}:${c.ashaId}`
  const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await owner.connect()
  try {
    await owner.query('select pg_advisory_lock(hashtextextended($1, 0))', [key])
    const run = () => waive(c, 'dues', 'grant').then((r) => ({ ok: true as const, changed: r.changed }), (error: unknown) => ({ ok: false as const, changed: null, error }))
    const both = [run(), run()]
    await waiters(2)
    await owner.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
    const done = await Promise.all(both)
    assert.deepEqual(done.map((d) => d.ok), [true, true])
    assert.deepEqual(done.map((d) => d.changed).sort(), [false, true])
  } finally {
    await owner.query('select pg_advisory_unlock_all()').catch(() => {})
    await owner.end()
  }
  const rows = await authDb.select().from(auditLog).where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'eligibility.waiver_granted')))
  assert.equal(rows.length, 1)
  const live = await withTenant(c.id, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from exam_eligibility_waivers`))
  assert.equal(live.rows[0]!.n, 1)
})

test('a card request waits for a revoke in flight and then refuses', async () => {
  const c = await campus({ fees: true })
  await owe(c)
  await waive(c, 'dues', 'grant')
  await enrolWith(c)
  let card: Promise<{ ok: boolean; error: unknown }> | undefined
  await withTenant(c.id, async (tx) => {
    await (exams as unknown as { lockEligibility(tx: unknown, t: string, s: string, term: string): Promise<void> }).lockEligibility(tx, c.id, c.ashaId, c.termId)
    await tx.execute(sql`delete from exam_eligibility_waivers where student_id = ${c.ashaId}`)
    card = settle(exams.admitCard(c.asha, c.ashaId, c.termId))
    await waiters(1)
  })
  const r = await card!
  assert.equal(r.ok, false)
  assert.equal(code(r.error), 'exam_dues_outstanding')
})

// --- 7. the pages --------------------------------------------------------------------------

const pageOf = (path: string) => cyclePages.find((p) => p.path === path)!
const sectionsFor = async (path: string, who: Actor, query = '') => {
  const page = pageOf(path)
  const data = await page.load!(who as never, new Request(`http://x/${query}`))
  return JSON.stringify({ sections: page.sections!(data as never), data })
}

test('Booking shows the gate, hides the controls while held, and gives them back on a waiver', async () => {
  const c = await campus({ fees: true })
  await owe(c)
  let held = await sectionsFor('/booking', c.asha)
  assert.match(held, /Exam eligibility/)
  assert.match(held, /Posted fees/)
  assert.match(held, /Blocked/)
  assert.ok(held.includes('Posted fees are outstanding for this term.'))
  assert.ok(!held.includes('"path":"/enrol"'), 'no enrol form while held')
  await waive(c, 'dues', 'grant')
  const open = await sectionsFor('/booking', c.asha)
  assert.match(open, /Waived/)
  assert.ok(open.includes('"path":"/enrol"'))
  await enrolWith(c)
  assert.ok((await sectionsFor('/booking', c.asha)).includes('admit-card.pdf'))
  await waive(c, 'dues', 'revoke')
  held = await sectionsFor('/booking', c.asha)
  assert.ok(!held.includes('admit-card.pdf'), 'no card link while held')
  assert.match(held, /Posted fees are outstanding/)
})

test('Booking shows attendance as a percentage against the minimum', async () => {
  const c = await campus({ attendance: true })
  await register(c, c.offDs, c.slot, [true, true, true, false])
  const text = await sectionsFor('/booking', c.asha)
  assert.match(text, /Cleared/)
  assert.ok(text.includes('75.0% / 75% required'))
  const d = await campus({})
  assert.match(await sectionsFor('/booking', d.asha), /Not applicable/)
})

test('only the examination cell gets the waiver form', async () => {
  const c = await campus({ fees: true })
  const sections = async (who: Actor) => {
    const page = pageOf('/cycle')
    const data = await page.load!(who as never, new Request('http://x/'))
    return page.sections!(data as never) as { kind: string; title?: string; path?: string; submit?: string; roles?: string[]; note?: string; fields?: { name: string; label: string; options?: unknown }[] }[]
  }
  const form = (await sections(c.admin)).find((x) => x.kind === 'form' && x.path === '/eligibility/waiver')
  assert.ok(form, 'the cell sees the form')
  assert.equal(form.title, 'Set eligibility waiver')
  assert.equal(form.submit, 'Save waiver')
  assert.deepEqual(form.roles, ['institution_admin', 'super_admin'])
  assert.ok(!form.roles!.includes('hod'), 'a head of department does not')
  assert.ok((form.note ?? '').includes('Use an administrative reason. Leave out medical and payment details.'))
  assert.deepEqual(form.fields!.map((f) => f.label).filter(Boolean), ['Student', 'Check', 'Action', 'Reason'])
})
