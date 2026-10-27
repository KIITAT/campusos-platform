/**
 * SEC-07: who may read a student's records (decision 193), across every module
 * that holds them. One institution, two departments, one student, and around
 * them everyone who might ask: the class teacher, a lecturer who teaches the
 * student, the mentor, the student's HoD, another department's HoD, a lecturer
 * with no connection, the accounts office, a guardian, the student.
 *
 * A negative case must be refused with 403 by the operation itself, called
 * in-process as a page loader or another module would call it. A positive case
 * must get past the check: it may still fail for want of data (an admit card
 * with no enrolment is a 409), but never with 403.
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test scripts/student-access.test.ts
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, institutions, users, withTenant } from '../packages/db/src/index'
import * as academic from '../packages/modules/academic/api/index'
import * as exams from '../packages/modules/examinations/api/index'
import * as attendance from '../packages/modules/attendance/api/index'
import * as mentoring from '../packages/modules/mentoring/api/index'
import * as skills from '../packages/modules/skills/api/index'
import * as fees from '../packages/modules/fees/api/index'
import * as enrollment from '../packages/modules/enrollment/api/index'

type Who = 'admin' | 'accounts' | 'hodA' | 'hodB' | 'classTeacher' | 'lecturer' | 'mentor' | 'stranger' | 'student' | 'other'
const ROLE: Record<Who, string> = {
  admin: 'institution_admin', accounts: 'accounts_staff', hodA: 'hod', hodB: 'hod', classTeacher: 'faculty',
  lecturer: 'faculty', mentor: 'faculty', stranger: 'faculty', student: 'student', other: 'student',
}
let inst: string
let other: string
let termId: string
let deptAId: string
const ids = {} as Record<Who, string>
const as = (who: Who, over: Record<string, unknown> = {}) => ({ id: ids[who], email: `${who}@access.test`, role: ROLE[who], institutionId: inst, ...over }) as never
const S = () => ids.student

/** 403 from the operation, and nothing else. */
async function refused(label: string, call: () => Promise<unknown>) {
  await assert.rejects(call, (e: { status?: number }) => e?.status === 403, `${label} should be refused`)
}
/** Past the access check: success, or a failure that is not a refusal. */
async function admitted(label: string, call: () => Promise<unknown>) {
  try {
    await call()
  } catch (e) {
    assert.notEqual((e as { status?: number }).status, 403, `${label} was refused: ${(e as Error).message}`)
  }
}
const quietly = async (fn: () => Promise<void>) => {
  const original = console.error
  console.error = () => {}
  try { await fn() } finally { console.error = original }
}

before(async () => {
  for (const slug of ['student-access', 'student-access-other']) await authDb.delete(institutions).where(eq(institutions.slug, slug))
  const rows = await authDb.insert(institutions).values([
    { slug: 'student-access', name: 'Access College', allowedEmailDomains: [] },
    { slug: 'student-access-other', name: 'Other College', allowedEmailDomains: [] },
  ]).returning()
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb.insert(users).values((Object.keys(ROLE) as Who[]).map((who) => ({
    institutionId: inst, email: `${who}@access.test`, role: ROLE[who] as never, name: who,
  }))).returning()
  for (const p of people) ids[p.email!.split('@')[0] as Who] = p.id

  const admin = as('admin')
  const deptA = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const deptB = await academic.createDepartment(admin, { code: 'mech', name: 'Mechanical' })
  deptAId = deptA.id
  await academic.setDepartmentHead(admin, { departmentId: deptA.id, email: 'hodA@access.test' })
  await academic.setDepartmentHead(admin, { departmentId: deptB.id, email: 'hodB@access.test' })
  const prog = await academic.createProgram(admin, { departmentId: deptA.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const term = await academic.createTerm(admin, { code: 't1', name: 'Now', startsOn: iso(new Date(today.getTime() - 30 * 864e5)), endsOn: iso(new Date(today.getTime() + 90 * 864e5)) })
  termId = term.id
  const sec = await academic.createSection(admin, { programId: prog.id, label: 'a', admissionYear: 2026 })
  await academic.setClassTeacher(admin, { sectionId: sec.id, email: 'classTeacher@access.test' })
  await academic.addSectionMember(admin, { sectionId: sec.id, userId: S() })
  await academic.declareProgram(admin, { studentId: S(), programId: prog.id, declaredOn: '2025-07-01', isPrimary: true })
  const course = await academic.createCourse(admin, { departmentId: deptA.id, code: 'cs101', title: 'Programming', credits: 4 })
  await academic.createOffering(admin, { termId: term.id, courseId: course.id, sectionId: sec.id, facultyUserId: ids.lecturer })
  await mentoring.assignMentor(admin, { studentIds: [S()], mentorId: ids.mentor })
})

after(async () => {
  if (inst) await authDb.delete(institutions).where(eq(institutions.id, inst))
  if (other) await authDb.delete(institutions).where(eq(institutions.id, other))
})

test('profile (contact details): class teacher, mentor, own HoD, office, self; not a subject teacher', () => quietly(async () => {
  const read = (who: Who) => () => academic.studentProfile(as(who), S())
  for (const who of ['lecturer', 'stranger', 'hodB', 'accounts', 'other'] as Who[]) await refused(`profile as ${who}`, read(who))
  for (const who of ['classTeacher', 'mentor', 'hodA', 'admin', 'student'] as Who[]) await admitted(`profile as ${who}`, read(who))
  await admitted('profile as a verified guardian', () => academic.studentProfile(as('other', { role: 'parent', viewerOf: [S()] }), S()))
}))

test('the academic record: programmes, completions, eligibility, degree audit', () => quietly(async () => {
  const reads = (who: Who) => [
    () => academic.listStudentPrograms(as(who), { studentId: S() }),
    () => academic.listCompletions(as(who), { studentId: S() }),
    () => academic.degreeAudit(as(who), { studentId: S() }),
  ]
  for (const who of ['stranger', 'hodB', 'accounts'] as Who[]) for (const r of reads(who)) await refused(`record as ${who}`, r)
  for (const who of ['lecturer', 'classTeacher', 'mentor', 'hodA', 'admin', 'student'] as Who[]) for (const r of reads(who)) await admitted(`record as ${who}`, r)
}))

test('course registrations, credit load and add/drop events of one student (review)', () => quietly(async () => {
  const reads = (who: Who) => [
    () => enrollment.listRegistrations(as(who), { studentId: S() }),
    () => enrollment.creditLoad(as(who), { studentId: S(), termId }),
    () => enrollment.listRegistrationEvents(as(who), { studentId: S(), termId }),
  ]
  for (const who of ['stranger', 'hodB', 'other'] as Who[]) for (const r of reads(who)) await refused(`registrations as ${who}`, r)
  for (const who of ['hodA', 'admin', 'student'] as Who[]) for (const r of reads(who)) await admitted(`registrations as ${who}`, r)
  for (const who of ['lecturer', 'classTeacher', 'mentor'] as Who[]) for (const r of reads(who).slice(0, 2)) await admitted(`registrations as ${who}`, r)
}))

test('transcripts: a lecturer outside the student’s offerings cannot read them (acceptance)', () => quietly(async () => {
  for (const read of [exams.transcript, exams.officialTranscript]) {
    for (const who of ['stranger', 'hodB', 'accounts'] as Who[]) await refused(`${read.name} as ${who}`, () => read(as(who), S()))
    for (const who of ['lecturer', 'classTeacher', 'mentor', 'hodA', 'student'] as Who[]) await admitted(`${read.name} as ${who}`, () => read(as(who), S()))
  }
  await admitted('transcript as a verified guardian', () => exams.transcript(as('other', { role: 'parent', viewerOf: [S()] }), S()))
}))

test('admit card, grade report, performance', () => quietly(async () => {
  await refused('admit card as stranger', () => exams.admitCard(as('stranger'), S(), termId))
  await refused('admit card as a subject teacher', () => exams.admitCard(as('lecturer'), S(), termId))
  await admitted('admit card as class teacher', () => exams.admitCard(as('classTeacher'), S(), termId))
  await admitted('admit card as own HoD', () => exams.admitCard(as('hodA'), S(), termId))
  await refused('grade report as other HoD', () => exams.gradeReport(as('hodB'), S(), termId))
  await admitted('grade report as subject teacher', () => exams.gradeReport(as('lecturer'), S(), termId))
  await refused('performance as stranger', () => exams.studentPerformance(as('stranger'), S()))
  await admitted('performance as mentor', () => exams.studentPerformance(as('mentor'), S()))
}))

test('attendance summary', () => quietly(async () => {
  for (const who of ['stranger', 'hodB', 'accounts', 'other'] as Who[]) await refused(`attendance as ${who}`, () => attendance.attendanceSummary(as(who), S()))
  for (const who of ['lecturer', 'classTeacher', 'mentor', 'hodA', 'student'] as Who[]) await admitted(`attendance as ${who}`, () => attendance.attendanceSummary(as(who), S()))
}))

test('mentoring: another department’s HoD cannot read the mentee view (acceptance)', () => quietly(async () => {
  for (const who of ['hodB', 'stranger', 'lecturer', 'classTeacher'] as Who[]) await refused(`mentee view as ${who}`, () => mentoring.menteeView(as(who), S()))
  for (const who of ['mentor', 'hodA', 'admin'] as Who[]) await admitted(`mentee view as ${who}`, () => mentoring.menteeView(as(who), S()))
}))

test('skills: read and record', () => quietly(async () => {
  const assessment = { studentId: S(), skillId: '00000000-0000-4000-8000-000000000000', rank: 3, evidence: 'Led the lab well all term.' }
  for (const who of ['stranger', 'hodB'] as Who[]) {
    await refused(`skills profile as ${who}`, () => skills.profile(as(who), S()))
    await refused(`assess as ${who}`, () => skills.assess(as(who), assessment))
  }
  for (const who of ['lecturer', 'classTeacher', 'mentor', 'hodA', 'student'] as Who[]) await admitted(`skills profile as ${who}`, () => skills.profile(as(who), S()))
  await admitted('assess as subject teacher', () => skills.assess(as('lecturer'), assessment))
}))

test('fee ledger: another department’s HoD, a mentor and a lecturer are refused', () => quietly(async () => {
  const read = (who: Who, over = {}) => () => fees.studentLedger(as(who, over), S(), termId)
  for (const who of ['hodB', 'mentor', 'lecturer', 'classTeacher', 'stranger', 'other'] as Who[]) await refused(`ledger as ${who}`, read(who))
  for (const who of ['accounts', 'hodA', 'admin', 'student'] as Who[]) await admitted(`ledger as ${who}`, read(who))
  await admitted('ledger as a verified guardian', read('other', { role: 'parent', viewerOf: [S()] }))
}))

test('a relation in one institution is no relation in another (RLS on the views)', async () => {
  const ask = (tenant: string) => withTenant(tenant, async (tx) =>
    (await tx.execute(sql`select public.campusos_student_relation(${ids.classTeacher}, ${S()}, 'profile') as r`)).rows[0]!.r)
  assert.equal(await ask(inst), 'class_teacher')
  assert.equal(await ask(other), null)
})

test('a headship ends when it is cleared, and only a HoD can head', () => quietly(async () => {
  await academic.setDepartmentHead(as('admin'), { departmentId: deptAId })
  await refused('ledger as a former HoD', () => fees.studentLedger(as('hodA'), S(), termId))
  await assert.rejects(academic.setDepartmentHead(as('admin'), { departmentId: '00000000-0000-4000-8000-000000000000', email: 'stranger@access.test' }), (e: { code?: string }) => e.code === 'wrong_role')
}))
