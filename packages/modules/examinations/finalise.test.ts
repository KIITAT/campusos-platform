import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  ExamError,
  createExam,
  createScheme,
  enterMarks,
  finaliseCourse,
  officialTranscript,
  publishExam,
  reviseMark,
  setProgramScheme,
  transcript,
  type Actor,
} from './api'

/**
 * Finalising: where a computed grade stops being a derivation and becomes the
 * academic record.
 *
 * A fresh institution per test. These write into another module's table through
 * an audited path, and a shared fixture would make every failure a question
 * about which test finalised what first.
 */

let n = 0
const SLUG = 'exam-final-'

interface Campus {
  id: string
  admin: Actor
  faculty: Actor
  a: string
  b: string
  programId: string
  termId: string
  courseId: string
  offeringId: string
}

const actor = (id: string, role: Actor['role'], institutionId: string): Actor => ({
  id,
  email: `${role}@test`,
  role,
  institutionId,
})

async function campus(credits = 4): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Finalising College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Lecturer' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Aiyla Student' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Bran Student' },
    ])
    .returning({ id: users.id })

  const admin = actor(people[0]!.id, 'institution_admin', id)
  const faculty = actor(people[1]!.id, 'faculty', id)

  const dept = await academic.createDepartment(admin, { code: 'CSE', name: 'Computing' })
  const program = await academic.createProgram(admin, {
    departmentId: dept.id,
    code: 'BTCS',
    name: 'B.Tech Computing',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const term = await academic.createTerm(admin, {
    code: `T${++n}`,
    name: 'Autumn',
    startsOn: '2025-07-01',
    endsOn: '2025-12-15',
  })
  const course = await academic.createCourse(admin, {
    departmentId: dept.id,
    code: `C${++n}`,
    title: 'Algorithms',
    credits,
  })
  const section = await academic.createSection(admin, {
    programId: program.id,
    label: 'A',
    admissionYear: 2025,
  })
  // Marks may only be entered for the cohort being taught, so the students
  // have to be in it before any of this is a course anybody sat.
  for (const student of [people[2]!.id, people[3]!.id]) {
    await academic.addSectionMember(admin, { sectionId: section.id, userId: student })
  }

  const offering = await academic.createOffering(admin, {
    termId: term.id,
    courseId: course.id,
    sectionId: section.id,
    facultyUserId: faculty.id,
  })

  return {
    id,
    admin,
    faculty,
    a: people[2]!.id,
    b: people[3]!.id,
    programId: program.id,
    termId: term.id,
    courseId: course.id,
    offeringId: offering.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** One exam worth the whole course, marked out of 100, published. */
async function wholeCourse(c: Campus, marks: { studentId: string; obtained: number }[]) {
  const exam = await createExam(c.faculty, {
    offeringId: c.offeringId,
    name: 'Final',
    kind: 'final',
    maxMarks: 100,
    weightPercent: 100,
  })
  await enterMarks(c.faculty, { examId: exam.id, marks })
  await publishExam(c.faculty, { examId: exam.id })
  return exam
}

const errorCode = (e: unknown) => (e as ExamError).code

// --- posting the record ----------------------------------------------------

test('finalising turns published marks into the academic record', async () => {
  const c = await campus()
  await wholeCourse(c, [
    { studentId: c.a, obtained: 82 },
    { studentId: c.b, obtained: 47 },
  ])

  const out = await finaliseCourse(c.admin, { offeringId: c.offeringId })
  assert.equal(out.created, 2)
  assert.equal(out.incomplete.length, 0)

  const [one] = await academic.listCompletions(c.admin, { studentId: c.a })
  assert.equal(one!.gradeLabel, 'A+')
  assert.equal(Number(one!.gradePoints), 9)
  assert.equal(one!.credits, 4)
  assert.equal(one!.passed, true)

  const [two] = await academic.listCompletions(c.admin, { studentId: c.b })
  assert.equal(two!.gradeLabel, 'C')
  assert.equal(two!.passed, true)
})

test('the record is what the prerequisite chain then reads', async () => {
  const c = await campus()
  const next = await academic.createCourse(c.admin, {
    departmentId: (await academic.listStructure(c.admin)).departments[0]!.id,
    code: `C${++n}`,
    title: 'Advanced Algorithms',
    credits: 4,
  })
  await academic.addPrerequisite(c.admin, {
    courseId: next.id,
    requiresCourseId: c.courseId,
    minGradePoints: 7,
  })

  await wholeCourse(c, [{ studentId: c.a, obtained: 82 }])

  const before = await academic.checkEligibility(c.admin, {
    studentId: c.a,
    courseId: next.id,
  })
  assert.equal(before.eligible, false)

  await finaliseCourse(c.admin, { offeringId: c.offeringId })

  // Nine points, against a chain asking for seven: the examiner's number and
  // the registrar's are now the same number.
  const after = await academic.checkEligibility(c.admin, {
    studentId: c.a,
    courseId: next.id,
  })
  assert.equal(after.eligible, true)
})

test('a course only part of which has been published is not a course anybody passed', async () => {
  const c = await campus()
  const mid = await createExam(c.faculty, {
    offeringId: c.offeringId,
    name: 'Midterm',
    kind: 'midterm',
    maxMarks: 50,
    weightPercent: 40,
  })
  await enterMarks(c.faculty, {
    examId: mid.id,
    marks: [{ studentId: c.a, obtained: 40 }],
  })
  await publishExam(c.faculty, { examId: mid.id })

  // Sixty percent of the course has not been examined. Forty out of fifty is a
  // fine midterm and not a grade.
  await assert.rejects(
    () => finaliseCourse(c.admin, { offeringId: c.offeringId }),
    (e: unknown) => errorCode(e) === 'weight_incomplete',
  )
  assert.equal((await academic.listCompletions(c.admin, { studentId: c.a })).length, 0)
})

test('one student’s pending script holds up that student, not the cohort', async () => {
  const c = await campus()
  const exam = await createExam(c.faculty, {
    offeringId: c.offeringId,
    name: 'Final',
    kind: 'final',
    maxMarks: 100,
    weightPercent: 100,
  })
  // Sat the exam, result pending: null is a genuine state, distinct from absent.
  await enterMarks(c.faculty, {
    examId: exam.id,
    marks: [
      { studentId: c.a, obtained: 82 },
      { studentId: c.b, obtained: null },
    ],
  })
  await publishExam(c.faculty, { examId: exam.id })

  const out = await finaliseCourse(c.admin, { offeringId: c.offeringId })
  assert.equal(out.created, 1)
  assert.deepEqual(out.incomplete, [c.b])
  assert.equal((await academic.listCompletions(c.admin, { studentId: c.b })).length, 0)
})

test('nothing published is nothing to finalise', async () => {
  const c = await campus()
  await createExam(c.faculty, {
    offeringId: c.offeringId,
    name: 'Final',
    kind: 'final',
    maxMarks: 100,
    weightPercent: 100,
  })

  await assert.rejects(
    () => finaliseCourse(c.admin, { offeringId: c.offeringId }),
    (e: unknown) => errorCode(e) === 'nothing_published',
  )
})

test('a lecturer grades their cohort; the registrar decides it is the record', async () => {
  const c = await campus()
  await wholeCourse(c, [{ studentId: c.a, obtained: 82 }])

  await assert.rejects(
    () => finaliseCourse(c.faculty, { offeringId: c.offeringId }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

// --- corrections -----------------------------------------------------------

test('a revised mark, finalised again, corrects the record with a reason', async () => {
  const c = await campus()
  const exam = await wholeCourse(c, [{ studentId: c.a, obtained: 47 }])
  await finaliseCourse(c.admin, { offeringId: c.offeringId })

  await reviseMark(c.faculty, {
    examId: exam.id,
    studentId: c.a,
    obtained: 82,
    reason: 'question three was marked against the wrong scheme',
  })

  const out = await finaliseCourse(c.admin, {
    offeringId: c.offeringId,
    reason: 'remarked after the moderation meeting',
  })
  assert.equal(out.corrected, 1)
  assert.equal(out.created, 0)

  const [row] = await academic.listCompletions(c.admin, { studentId: c.a })
  assert.equal(row!.gradeLabel, 'A+')

  const trail = await withTenant(c.id, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'completion.corrected')),
  )
  assert.equal(trail.length, 1)
  assert.match(String(trail[0]!.reason), /moderation meeting/)
  assert.equal((trail[0]!.detail as { from: { gradeLabel: string } }).from.gradeLabel, 'C')
})

test('finalising twice with nothing changed says so and writes nothing', async () => {
  const c = await campus()
  await wholeCourse(c, [{ studentId: c.a, obtained: 82 }])
  await finaliseCourse(c.admin, { offeringId: c.offeringId })

  const again = await finaliseCourse(c.admin, { offeringId: c.offeringId })
  assert.equal(again.unchanged, 1)
  assert.equal(again.corrected, 0)

  const trail = await withTenant(c.id, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'completion.corrected')),
  )
  assert.equal(trail.length, 0)
})

// --- the scale a programme grades on ---------------------------------------

test('a programme grades on its own scale, not the institution default', async () => {
  const c = await campus()
  await createScheme(c.admin, {
    name: 'Institution default',
    kind: 'gpa',
    bands: [
      { minPercent: 40, label: 'PASS', points: 5, isPass: true },
      { minPercent: 0, label: 'FAIL', points: 0, isPass: false },
    ],
    isDefault: true,
  })
  const strict = await createScheme(c.admin, {
    name: 'Engineering 10-point',
    kind: 'gpa',
    bands: [
      { minPercent: 80, label: 'A+', points: 9, isPass: true },
      { minPercent: 50, label: 'B', points: 6, isPass: true },
      { minPercent: 0, label: 'F', points: 0, isPass: false },
    ],
  })
  await setProgramScheme(c.admin, { programId: c.programId, schemeId: strict.id })

  await wholeCourse(c, [{ studentId: c.a, obtained: 82 }])
  await finaliseCourse(c.admin, { offeringId: c.offeringId })

  // The default would have said PASS at five points for the same paper.
  const [row] = await academic.listCompletions(c.admin, { studentId: c.a })
  assert.equal(row!.gradeLabel, 'A+')
  assert.equal(Number(row!.gradePoints), 9)
})

test('only an admin points a programme at a scale', async () => {
  const c = await campus()
  const scheme = await createScheme(c.admin, {
    name: 'Anything',
    kind: 'gpa',
    bands: [{ minPercent: 0, label: 'P', points: 1, isPass: true }],
  })
  await assert.rejects(
    () => setProgramScheme(c.faculty, { programId: c.programId, schemeId: scheme.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

// --- the two transcripts ---------------------------------------------------

test('the official transcript prints the record; the other prints the arithmetic', async () => {
  const c = await campus()
  await academic.declareProgram(c.admin, { studentId: c.a, programId: c.programId })
  await wholeCourse(c, [{ studentId: c.a, obtained: 82 }])

  // Marked and published, but not yet the record.
  const beforeOfficial = await officialTranscript(c.admin, c.a)
  assert.equal(beforeOfficial.terms.length, 0)
  assert.equal(beforeOfficial.provisional, false)

  await finaliseCourse(c.admin, { offeringId: c.offeringId })

  const official = await officialTranscript(c.admin, c.a)
  assert.equal(official.terms.length, 1)
  assert.equal(official.terms[0]!.grades[0]!.label, 'A+')
  assert.equal(official.cumulativeGpa, 9)
  assert.equal(official.totalCredits, 4)
  assert.equal(official.programCode, 'BTCS')
  assert.equal(official.provisional, false)
})

test('transfer credit is on the official transcript, under its own heading', async () => {
  const c = await campus()
  await academic.declareProgram(c.admin, { studentId: c.a, programId: c.programId })
  const elsewhere = await academic.createCourse(c.admin, {
    departmentId: (await academic.listStructure(c.admin)).departments[0]!.id,
    code: `C${++n}`,
    title: 'Physics',
    credits: 3,
  })
  await academic.recordCompletion(c.admin, {
    studentId: c.a,
    courseId: elsewhere.id,
    source: 'transfer',
    credits: 3,
    note: 'Accepted on the transfer sheet',
  })

  const official = await officialTranscript(c.admin, c.a)
  const transferred = official.terms.find((t) => t.termCode === 'TRANSFER')!
  assert.equal(transferred.grades[0]!.courseTitle, 'Physics')
  assert.equal(official.totalCredits, 3)
  // Credited, and deliberately not in the average: there is no grade behind it.
  assert.equal(official.cumulativeGpa, null)
})

test('a student reads their own transcripts and nobody else’s', async () => {
  const c = await campus()
  await wholeCourse(c, [{ studentId: c.a, obtained: 82 }])
  await finaliseCourse(c.admin, { offeringId: c.offeringId })

  const self = actor(c.a, 'student', c.id)
  assert.equal((await officialTranscript(self, c.a)).terms.length, 1)
  await assert.rejects(
    () => officialTranscript(self, c.b),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
  // The provisional one has always answered the same way, and still does.
  await assert.rejects(
    () => transcript(self, c.b),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('another institution cannot finalise into this one', async () => {
  const one = await campus()
  const two = await campus()
  await wholeCourse(one, [{ studentId: one.a, obtained: 82 }])

  await assert.rejects(
    () => finaliseCourse(two.admin, { offeringId: one.offeringId }),
    (e: unknown) => errorCode(e) === 'no_such_offering',
  )
  assert.equal((await academic.listCompletions(one.admin, { studentId: one.a })).length, 0)
})
