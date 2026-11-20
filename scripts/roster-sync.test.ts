/**
 * FUNC-02 (P1-07a): a student who registers for a course in a section kept for
 * an elective must reach the rosters the other modules read -- the marks sheet
 * and the attendance summary both read section membership.
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test scripts/roster-sync.test.ts
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, institutions, users } from '../packages/db/src/index'
import * as academic from '../packages/modules/academic/api/index'
import * as exams from '../packages/modules/examinations/api/index'
import * as attendance from '../packages/modules/attendance/api/index'
import * as enrollment from '../packages/modules/enrollment/api/index'

const SLUG = 'roster-sync'
let admin: never
let lecturer: never
let studentId: string
let termId: string
let offeringId: string
let ML: string

const iso = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10)

before(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  const [inst] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Roster Sync College', allowedEmailDomains: [] }).returning()
  const people = await authDb.insert(users).values([
    { institutionId: inst!.id, email: 'admin@roster-sync.test', role: 'institution_admin', name: 'Admin' },
    { institutionId: inst!.id, email: 'lecturer@roster-sync.test', role: 'faculty', name: 'Lecturer' },
    { institutionId: inst!.id, email: 'student@roster-sync.test', role: 'student', name: 'Student' },
  ]).returning()
  const as = (p: (typeof people)[number]) => ({ id: p.id, email: p.email, role: p.role, institutionId: inst!.id }) as never
  admin = as(people[0]!)
  lecturer = as(people[1]!)
  studentId = people[2]!.id

  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const prog = await academic.createProgram(admin, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  await academic.createSection(admin, { programId: prog.id, label: 'A', admissionYear: 2025 })
  ML = (await academic.createSection(admin, { programId: prog.id, label: 'ML', admissionYear: 2025 })).id
  const term = await academic.createTerm(admin, { code: 't1', name: 'Now', startsOn: iso(-30), endsOn: iso(60) })
  termId = term.id
  await academic.setTermCalendar(admin, { termId, registrationOpensOn: iso(-10), registrationClosesOn: iso(10), addDropEndsOn: iso(5), withdrawEndsOn: iso(30) })
  const course = await academic.createCourse(admin, { departmentId: dept.id, code: 'ML101', title: 'Machine Learning', credits: 4 })
  offeringId = (await academic.createOffering(admin, { termId, courseId: course.id, sectionId: ML, facultyUserId: people[1]!.id })).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('an elective registrant appears in attendance and marks', async () => {
  await enrollment.setSectionFeed(admin, { sectionId: ML, fed: true })
  await enrollment.register(admin, { studentId, offeringId })
  const exam = await exams.createExam(lecturer, { offeringId, name: 'Mid', kind: 'midterm', maxMarks: 50, weightPercent: 30 })
  await exams.enterMarks(lecturer, { examId: exam.id, marks: [{ studentId, obtained: 40 }] })
  const { entries } = await exams.sheet(lecturer, exam.id)
  assert.equal(entries.some((e) => e.studentId === studentId && e.obtained === 40), true)
  const summary = await attendance.attendanceSummary(admin, studentId, termId)
  assert.equal(summary.some((l) => l.offeringId === offeringId), true)
})
