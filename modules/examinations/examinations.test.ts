import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  ExamError,
  createExam,
  createScheme,
  enterMarks,
  listSchemes,
  markHistory,
  publishExam,
  reviseMark,
  sheet,
  transcript,
  transcriptPdf,
  unpublishExam,
  type Actor,
} from './api'
import { examMarks, exams, schemes } from './schema'

const SLUG = 'exam-test'
let inst: string
const ids = { offering: '', offering2: '', term: '', term2: '', s1: '', s2: '', s3: '', fac: '', adm: '' }

const A = (over: Partial<Actor>): Actor => ({
  id: ids.fac,
  email: 'f@exam.test',
  role: 'faculty',
  institutionId: inst,
  ...over,
})
const admin = () => A({ id: ids.adm, email: 'adm@exam.test', role: 'institution_admin' })
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as ExamError).code

const mkExam = (over: Record<string, unknown> = {}) =>
  createExam(A({}), {
    offeringId: ids.offering,
    name: 'Midterm',
    kind: 'midterm',
    maxMarks: 50,
    weightPercent: 40,
    ...over,
  })

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Exam College', allowedEmailDomains: ['exam.test'] })
    .returning({ id: institutions.id })
  inst = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'f@exam.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 'adm@exam.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@exam.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@exam.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 's3@exam.test', institutionId: inst, role: 'student', name: 'Three Student' },
    ])
    .returning({ id: users.id })
  ids.fac = people[0]!.id
  ids.adm = people[1]!.id
  ids.s1 = people[2]!.id
  ids.s2 = people[3]!.id
  ids.s3 = people[4]!.id

  const st = admin()
  const dept = await academic.createDepartment(st, { code: 'cse', name: 'CSE' })
  const prog = await academic.createProgram(st, {
    departmentId: dept.id,
    code: 'btech',
    name: 'BTech',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const c1 = await academic.createCourse(st, {
    departmentId: dept.id,
    code: 'cs301',
    title: 'Operating Systems',
    credits: 4,
  })
  const c2 = await academic.createCourse(st, {
    departmentId: dept.id,
    code: 'cs302',
    title: 'Databases',
    credits: 3,
  })
  const t1 = await academic.createTerm(st, {
    code: 't1',
    name: 'Sem 1',
    startsOn: '2026-01-05',
    endsOn: '2026-05-30',
  })
  const t2 = await academic.createTerm(st, {
    code: 't2',
    name: 'Sem 2',
    startsOn: '2026-07-01',
    endsOn: '2026-12-01',
  })
  ids.term = t1.id
  ids.term2 = t2.id
  const section = await academic.createSection(st, {
    programId: prog.id,
    label: 'a',
    admissionYear: 2026,
  })
  // s1 and s2 enrolled; s3 not.
  await academic.addSectionMember(st, { sectionId: section.id, userId: ids.s1 })
  await academic.addSectionMember(st, { sectionId: section.id, userId: ids.s2 })

  ids.offering = (
    await academic.createOffering(st, {
      termId: t1.id,
      courseId: c1.id,
      sectionId: section.id,
      facultyUserId: ids.fac,
    })
  ).id
  ids.offering2 = (
    await academic.createOffering(st, {
      termId: t2.id,
      courseId: c2.id,
      sectionId: section.id,
      facultyUserId: ids.fac,
    })
  ).id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    // exam_marks first: the delete guard refuses published rows, so exams go last.
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.update(exams).set({ publishedAt: null, publishedBy: null })
    await tx.delete(examMarks)
    await tx.delete(exams)
    await tx.delete(auditLog)
    await tx.delete(schemes)
  })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

// --- exams -----------------------------------------------------------------

test('a student cannot create an exam', async () => {
  await assert.rejects(
    () => createExam(student(ids.s1), { offeringId: ids.offering, name: 'X', kind: 'quiz', maxMarks: 10, weightPercent: 10 }),
    (e: unknown) => (e as ExamError).status === 403,
  )
})

test('a lecturer cannot examine somebody else’s offering', async () => {
  await assert.rejects(
    () => createExam(A({ id: 'someone-else' }), {
      offeringId: ids.offering, name: 'X', kind: 'quiz', maxMarks: 10, weightPercent: 10,
    }),
    (e: unknown) => code(e) === 'not_your_offering',
  )
})

test('total weight across a course cannot exceed 100', async () => {
  await mkExam({ name: 'A', weightPercent: 60 })
  await mkExam({ name: 'B', weightPercent: 40 })
  await assert.rejects(
    () => mkExam({ name: 'C', weightPercent: 1 }),
    (e: unknown) => code(e) === 'weight_exceeded',
  )
})

test('a duplicate exam name in one offering is refused', async () => {
  await mkExam()
  await assert.rejects(() => mkExam({ weightPercent: 10 }), (e: unknown) => code(e) === 'name_taken')
})

// --- marks entry -----------------------------------------------------------

test('marks above the maximum are refused', async () => {
  const e = await mkExam()
  await assert.rejects(
    () => enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 51 }] }),
    (err: unknown) => code(err) === 'above_max',
  )
})

test('a student outside the cohort cannot be given marks', async () => {
  const e = await mkExam()
  await assert.rejects(
    () => enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s3, obtained: 10 }] }),
    (err: unknown) => code(err) === 'not_enrolled',
  )
})

test('marks can be entered and amended freely before publication', async () => {
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 35 }] })
  const s = await sheet(A({}), e.id)
  assert.equal(s.entries.find((x) => x.studentId === ids.s1)?.obtained, 35)
  // No audit rows: an unpublished amendment is ordinary work, not a revision.
  const trail = await withTenant(inst, (tx) => tx.select().from(auditLog))
  assert.equal(trail.length, 0)
})

test('absent and a null score are different states', async () => {
  const e = await mkExam()
  await enterMarks(A({}), {
    examId: e.id,
    marks: [
      { studentId: ids.s1, absent: true },
      { studentId: ids.s2, obtained: null },
    ],
  })
  const s = await sheet(A({}), e.id)
  const a = s.entries.find((x) => x.studentId === ids.s1)!
  const b = s.entries.find((x) => x.studentId === ids.s2)!
  assert.equal(a.absent, true)
  assert.equal(a.obtained, null)
  assert.equal(b.absent, false)
  assert.equal(b.obtained, null)
})

test('an absent student cannot also carry a score', async () => {
  const e = await mkExam()
  await assert.rejects(() =>
    enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 10, absent: true }] }),
  )
})

// --- the publish lock ------------------------------------------------------

test('publishing locks ordinary marks entry', async () => {
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await publishExam(A({}), { examId: e.id })

  await assert.rejects(
    () => enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 45 }] }),
    (err: unknown) => code(err) === 'published',
  )
})

test('the database refuses a published-mark edit even when the app check is bypassed', async () => {
  // This is the guarantee rather than the convention: a direct UPDATE, exactly
  // what a future code path or a psql session would do, must still fail.
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await publishExam(A({}), { examId: e.id })

  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(examMarks).set({ obtained: '50' }).where(eq(examMarks.examId, e.id)),
      ),
    (err: unknown) => /audited revision/i.test(String((err as Error).cause ?? err)),
  )

  const after = await withTenant(inst, (tx) => tx.select().from(examMarks))
  assert.equal(Number(after[0]!.obtained), 30, 'the mark must be unchanged')
})

test('the database refuses inserting a fresh mark into a published exam', async () => {
  const e = await mkExam()
  await publishExam(A({}), { examId: e.id })
  await assert.rejects(() =>
    withTenant(inst, (tx) =>
      tx.insert(examMarks).values({
        institutionId: inst,
        examId: e.id,
        studentId: ids.s2,
        obtained: '40',
      }),
    ),
  )
})

test('a published mark cannot be deleted', async () => {
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await publishExam(A({}), { examId: e.id })
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.delete(examMarks).where(eq(examMarks.examId, e.id))),
    (err: unknown) => /cannot be deleted/i.test(String((err as Error).cause ?? err)),
  )
})

test('publishing twice is refused', async () => {
  const e = await mkExam()
  await publishExam(A({}), { examId: e.id })
  await assert.rejects(
    () => publishExam(A({}), { examId: e.id }),
    (err: unknown) => code(err) === 'already_published',
  )
})

// --- the audited revision path --------------------------------------------

test('a revision changes the mark, bumps the revision, and writes the trail', async () => {
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await publishExam(A({}), { examId: e.id })

  await reviseMark(A({}), {
    examId: e.id,
    studentId: ids.s1,
    obtained: 42,
    reason: 'question 4 was mis-totalled during first marking',
  })

  const s = await sheet(A({}), e.id)
  const row = s.entries.find((x) => x.studentId === ids.s1)!
  assert.equal(row.obtained, 42)
  assert.equal(row.revision, 1)

  const trail = await markHistory(A({}), row.markId!)
  assert.equal(trail.length, 1)
  assert.equal(trail[0]!.action, 'mark.revised')
  assert.match(trail[0]!.reason, /mis-totalled/)
  assert.equal(trail[0]!.actorEmail, 'f@exam.test')
  assert.deepEqual(
    (trail[0]!.detail as { from: unknown }).from,
    { obtained: 30, absent: false },
  )
  assert.deepEqual((trail[0]!.detail as { to: unknown }).to, { obtained: 42, absent: false })
})

test('a revision without a real reason is refused', async () => {
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await publishExam(A({}), { examId: e.id })
  for (const reason of ['', 'oops', '   spaces   ']) {
    await assert.rejects(() =>
      reviseMark(A({}), { examId: e.id, studentId: ids.s1, obtained: 40, reason }),
    )
  }
})

test('successive revisions each leave a row, so the whole history survives', async () => {
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 10 }] })
  await publishExam(A({}), { examId: e.id })

  for (const [to, why] of [
    [20, 'first recount after student query'],
    [30, 'second recount, moderation applied'],
    [25, 'moderation reversed on appeal'],
  ] as [number, string][]) {
    await reviseMark(A({}), { examId: e.id, studentId: ids.s1, obtained: to, reason: why })
  }

  const s = await sheet(A({}), e.id)
  const row = s.entries.find((x) => x.studentId === ids.s1)!
  assert.equal(row.obtained, 25)
  assert.equal(row.revision, 3)

  const trail = await markHistory(A({}), row.markId!)
  assert.equal(trail.length, 3)
  assert.deepEqual(
    trail.map((t) => (t.detail as { to: { obtained: number } }).to.obtained),
    [20, 30, 25],
  )
})

test('the reason does not leak into a later transaction on the same connection', async () => {
  // set_config is transaction-local; if it were not, the next write to a
  // published exam would sail through with no reason at all.
  const e = await mkExam()
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 30 }] })
  await publishExam(A({}), { examId: e.id })
  await reviseMark(A({}), {
    examId: e.id,
    studentId: ids.s1,
    obtained: 40,
    reason: 'legitimate correction to establish a reason in one transaction',
  })

  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(examMarks).set({ obtained: '50' }).where(eq(examMarks.examId, e.id)),
      ),
    (err: unknown) => /audited revision/i.test(String((err as Error).cause ?? err)),
  )
})

test('unpublishing is admin only, needs a reason, and is audited', async () => {
  const e = await mkExam()
  await publishExam(A({}), { examId: e.id })

  await assert.rejects(
    () => unpublishExam(A({}), { examId: e.id, reason: 'lecturer should not be able to' }),
    (err: unknown) => (err as ExamError).status === 403,
  )

  await unpublishExam(admin(), {
    examId: e.id,
    reason: 'published against the wrong cohort, withdrawing',
  })

  const trail = await withTenant(inst, (tx) => tx.select().from(auditLog))
  assert.equal(trail.length, 2) // published, then unpublished
  assert.equal(trail[1]!.action, 'exam.unpublished')

  // and marks are editable again
  await enterMarks(A({}), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 11 }] })
})

test('the database refuses unpublishing without a reason in scope', async () => {
  const e = await mkExam()
  await publishExam(A({}), { examId: e.id })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(exams).set({ publishedAt: null }).where(eq(exams.id, e.id)),
      ),
    (err: unknown) => /audited reason/i.test(String((err as Error).cause ?? err)),
  )
})

// --- grading schemes -------------------------------------------------------

test('a gpa scheme needs bands; a percentage scheme does not', async () => {
  await assert.rejects(() =>
    createScheme(admin(), { name: 'Empty GPA', kind: 'gpa', bands: [] }),
  )
  const pct = await createScheme(admin(), { name: 'Percent', kind: 'percentage', bands: [] })
  assert.equal(pct.kind, 'percentage')
})

test('two bands cannot share a floor', async () => {
  await assert.rejects(() =>
    createScheme(admin(), {
      name: 'Dup',
      kind: 'custom',
      bands: [
        { minPercent: 50, label: 'A' },
        { minPercent: 50, label: 'B' },
      ],
    }),
  )
})

test('only one scheme is default, and setting a new one clears the old', async () => {
  await createScheme(admin(), {
    name: 'First', kind: 'gpa', isDefault: true,
    bands: [{ minPercent: 0, label: 'P', points: 4 }],
  })
  await createScheme(admin(), {
    name: 'Second', kind: 'gpa', isDefault: true,
    bands: [{ minPercent: 0, label: 'Q', points: 5 }],
  })
  const list = await listSchemes(admin())
  assert.deepEqual(list.filter((s) => s.isDefault).map((s) => s.name), ['Second'])
})

test('a lecturer cannot define grading schemes', async () => {
  await assert.rejects(
    () => createScheme(A({}), { name: 'Nope', kind: 'percentage', bands: [] }),
    (e: unknown) => (e as ExamError).status === 403,
  )
})

// --- transcript ------------------------------------------------------------

async function fullyGradedCourse() {
  const mid = await mkExam({ name: 'Mid', weightPercent: 40, maxMarks: 50 })
  const fin = await createExam(A({}), {
    offeringId: ids.offering,
    name: 'Final',
    kind: 'final',
    maxMarks: 100,
    weightPercent: 60,
  })
  // s1: 45/50 = 90% at 40%, 72/100 = 72% at 60% -> 79.2 -> A
  await enterMarks(A({}), { examId: mid.id, marks: [{ studentId: ids.s1, obtained: 45 }, { studentId: ids.s2, obtained: 20 }] })
  await enterMarks(A({}), { examId: fin.id, marks: [{ studentId: ids.s1, obtained: 72 }, { studentId: ids.s2, obtained: 30 }] })
  await publishExam(A({}), { examId: mid.id })
  await publishExam(A({}), { examId: fin.id })
  return { mid, fin }
}

test('a transcript grades published exams on the scheme in force', async () => {
  await fullyGradedCourse()
  const t = await transcript(A({}), ids.s1)
  assert.equal(t.studentName, 'One Student')
  assert.equal(t.institutionName, 'Exam College')
  assert.equal(t.terms.length, 1)
  const g = t.terms[0]!.grades[0]!
  assert.equal(g.courseCode, 'CS301')
  assert.equal(g.percent, 79.2)
  assert.equal(g.label, 'A')
  assert.equal(g.points, 8)
  assert.equal(t.terms[0]!.gpa, 8)
  assert.equal(t.cumulativeGpa, 8)
  assert.equal(t.totalCredits, 4)
  // Provisional, and correctly so: this student is also enrolled in CS302,
  // which has no published exam yet.
  assert.equal(t.provisional, true)
})

test('a transcript stops being provisional once every enrolled course is published', async () => {
  await fullyGradedCourse()
  const other = await createExam(A({}), {
    offeringId: ids.offering2, name: 'Only', kind: 'final', maxMarks: 100, weightPercent: 100,
  })
  await enterMarks(A({}), { examId: other.id, marks: [{ studentId: ids.s1, obtained: 60 }] })
  await publishExam(A({}), { examId: other.id })

  const t = await transcript(A({}), ids.s1)
  assert.equal(t.provisional, false)
  assert.equal(t.terms.length, 2)
})

test('an unpublished exam does not appear on a transcript', async () => {
  const mid = await mkExam({ name: 'Mid', weightPercent: 100, maxMarks: 50 })
  await enterMarks(A({}), { examId: mid.id, marks: [{ studentId: ids.s1, obtained: 45 }] })
  const t = await transcript(A({}), ids.s1)
  assert.equal(t.terms.length, 0)
  assert.equal(t.provisional, true, 'and it says so')
})

test('a partly-published course is marked provisional, not presented as final', async () => {
  const mid = await mkExam({ name: 'Mid', weightPercent: 40, maxMarks: 50 })
  await createExam(A({}), {
    offeringId: ids.offering, name: 'Final', kind: 'final', maxMarks: 100, weightPercent: 60,
  })
  await enterMarks(A({}), { examId: mid.id, marks: [{ studentId: ids.s1, obtained: 45 }] })
  await publishExam(A({}), { examId: mid.id })

  const t = await transcript(A({}), ids.s1)
  assert.equal(t.provisional, true)
  assert.equal(t.terms[0]!.grades[0]!.complete, true, 'complete over the published weight')
  // The unpublished final is simply absent, so the GPA is over what exists.
  assert.equal(t.terms[0]!.grades.length, 1)
})

test('a failing student earns no credits towards the gpa', async () => {
  await fullyGradedCourse()
  // s2: 40% at 40 weight, 30% at 60 -> 16 + 18 = 34 -> F
  const t = await transcript(A({}), ids.s2)
  const g = t.terms[0]!.grades[0]!
  assert.equal(g.label, 'F')
  assert.equal(g.passed, false)
  assert.equal(t.cumulativeGpa, null)
  assert.equal(t.totalCredits, 0)
})

test('a student may read their own transcript and no one else’s', async () => {
  await fullyGradedCourse()
  const mine = await transcript(student(ids.s1), ids.s1)
  assert.equal(mine.studentName, 'One Student')
  await assert.rejects(
    () => transcript(student(ids.s1), ids.s2),
    (e: unknown) => (e as ExamError).status === 403,
  )
})

test('a custom scheme is honoured over the built-in default', async () => {
  await createScheme(admin(), {
    name: 'Two-tier',
    kind: 'custom',
    isDefault: true,
    bands: [
      { minPercent: 75, label: 'DIST', points: 2, isPass: true },
      { minPercent: 0, label: 'FAIL', points: 0, isPass: false },
    ],
  })
  await fullyGradedCourse()
  const t = await transcript(A({}), ids.s1)
  assert.equal(t.schemeName, 'Two-tier')
  assert.equal(t.terms[0]!.grades[0]!.label, 'DIST')
  assert.equal(t.terms[0]!.gpa, 2)
})

test('terms are separate sections of the transcript', async () => {
  await fullyGradedCourse()
  const e2 = await createExam(A({}), {
    offeringId: ids.offering2, name: 'Only', kind: 'final', maxMarks: 100, weightPercent: 100,
  })
  await enterMarks(A({}), { examId: e2.id, marks: [{ studentId: ids.s1, obtained: 95 }] })
  await publishExam(A({}), { examId: e2.id })

  const t = await transcript(A({}), ids.s1)
  assert.deepEqual(t.terms.map((x) => x.termCode), ['T1', 'T2'])
  assert.equal(t.terms[1]!.grades[0]!.label, 'O')
  // (8*4 + 10*3) / 7 = 8.86
  assert.equal(t.cumulativeGpa, 8.86)
  assert.equal(t.totalCredits, 7)
})

// --- pdf -------------------------------------------------------------------

test('the transcript renders to a real PDF', async () => {
  await fullyGradedCourse()
  const t = await transcript(A({}), ids.s1)
  const bytes = await transcriptPdf(t)
  assert.ok(bytes.byteLength > 1000, `${bytes.byteLength} bytes`)
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-')
  // The trailer must be present, or a viewer will reject it.
  assert.match(Buffer.from(bytes).toString('latin1').slice(-1024), /%%EOF/)
})

test('a provisional transcript still renders', async () => {
  const t = await transcript(A({}), ids.s3)
  const bytes = await transcriptPdf(t)
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-')
})

// --- tenant isolation ------------------------------------------------------

test('another institution sees none of these exams', async () => {
  const e = await mkExam()
  const [other] = await authDb
    .insert(institutions)
    .values({ slug: 'exam-other', name: 'Other', allowedEmailDomains: ['exo.test'] })
    .returning({ id: institutions.id })
  try {
    await assert.rejects(
      () => sheet(A({ institutionId: other!.id }), e.id),
      (err: unknown) => code(err) === 'no_such_exam',
    )
  } finally {
    await authDb.delete(institutions).where(eq(institutions.slug, 'exam-other'))
  }
})
