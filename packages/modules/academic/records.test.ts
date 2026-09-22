import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import {
  AcademicError,
  addEquivalence,
  correctCompletion,
  createCourse,
  createCurriculum,
  createDepartment,
  createProgram,
  createRequirement,
  createTerm,
  declareProgram,
  degreeAudit,
  listCompletions,
  recordCompletion,
  waivePrerequisite,
  type Actor,
} from './api'
import { courseCompletions } from './schema'

/**
 * The degree audit, and the corrections behind it.
 *
 * A fresh institution per test: an audit is a statement about everything a
 * student has done, so a fixture shared between tests would make each failure a
 * question about what some earlier test recorded.
 */

let n = 0
const SLUG = 'acad-rec-'

interface Campus {
  id: string
  admin: Actor
  student: Actor
  other: Actor
  deptId: string
  programId: string
  termId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Audit College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Two Student' },
    ])
    .returning({ id: users.id })

  const admin: Actor = { id: people[0]!.id, role: 'institution_admin', institutionId: id }
  const dept = await createDepartment(admin, { code: 'CSE', name: 'Computing' })
  const program = await createProgram(admin, {
    departmentId: dept.id,
    code: 'BTCS',
    name: 'B.Tech Computing',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const term = await createTerm(admin, {
    code: `T${++n}`,
    name: 'Autumn',
    startsOn: '2025-07-01',
    endsOn: '2025-12-15',
  })

  return {
    id,
    admin,
    student: { id: people[1]!.id, role: 'student', institutionId: id },
    other: { id: people[2]!.id, role: 'student', institutionId: id },
    deptId: dept.id,
    programId: program.id,
    termId: term.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const course = (c: Campus, title: string, credits = 4) =>
  createCourse(c.admin, { departmentId: c.deptId, code: `C${++n}`, title, credits })

const pass = (
  c: Campus,
  courseId: string,
  points: number | null = 8,
  extra: Record<string, unknown> = {},
) =>
  recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId,
    termId: c.termId,
    ...(points === null ? {} : { gradePoints: points }),
    ...extra,
  })

const errorCode = (e: unknown) => (e as AcademicError).code

// --- the audit -------------------------------------------------------------

test('a core requirement names what is still missing', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 8,
  })
  const one = await course(c, 'Algorithms')
  const two = await course(c, 'Databases')
  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'CORE',
    title: 'Core computing',
    kind: 'core',
    minCredits: 8,
    courseIds: [one.id, two.id],
  })
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })

  await pass(c, one.id)
  const half = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(half.complete, false)
  assert.equal(half.requirements[0]!.satisfied, false)
  assert.deepEqual(
    half.requirements[0]!.outstanding.map((o) => o.courseCode),
    [two.code],
  )
  assert.equal(half.creditsRemaining, 4)

  await pass(c, two.id)
  const done = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(done.requirements[0]!.satisfied, true)
  assert.equal(done.complete, true)
  assert.equal(done.creditsRemaining, 0)
})

test('a pool takes only what it needs, and leaves the rest for the bucket behind it', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 12,
  })
  const a = await course(c, 'Graphics')
  const b = await course(c, 'Networks')
  const d = await course(c, 'Philosophy')

  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'ELEC',
    title: 'Computing electives',
    kind: 'elective',
    minCredits: 4,
    courseIds: [a.id, b.id],
  })
  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'OPEN',
    title: 'Open electives',
    kind: 'open',
    minCredits: 8,
    courseIds: [],
  })
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })

  await pass(c, a.id)
  await pass(c, b.id)
  await pass(c, d.id)

  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  const elective = audit.requirements.find((r) => r.code === 'ELEC')!
  const open = audit.requirements.find((r) => r.code === 'OPEN')!

  // The pool wanted four credits and took one course, not both.
  assert.equal(elective.creditsEarned, 4)
  assert.equal(elective.satisfied, true)
  // Everything left over is open-elective credit, each course spent once.
  assert.equal(open.creditsEarned, 8)
  assert.equal(audit.creditsEarned, 12)
  assert.equal(audit.complete, true)
})

test('a course that would satisfy two requirements goes to the harder one', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 8,
  })
  const core = await course(c, 'Algorithms')

  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'OPEN',
    title: 'Open electives',
    kind: 'open',
    minCredits: 4,
    courseIds: [],
  })
  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'CORE',
    title: 'Core computing',
    kind: 'core',
    minCredits: 4,
    courseIds: [core.id],
  })
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })

  await pass(c, core.id)

  // Declared open-first; audited core-first, or the degree stalls with the open
  // bucket full and the core one empty.
  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(audit.requirements.find((r) => r.code === 'CORE')!.satisfied, true)
  assert.equal(audit.requirements.find((r) => r.code === 'OPEN')!.satisfied, false)
})

test('a cross-listed course satisfies the requirement it was listed under', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 4,
  })
  const cs = await course(c, 'Discrete Mathematics (CS)')
  const ma = await course(c, 'Discrete Mathematics (Maths)')
  await addEquivalence(c.admin, { courseId: cs.id, equivalentCourseId: ma.id })
  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'CORE',
    title: 'Core',
    kind: 'core',
    minCredits: 4,
    courseIds: [cs.id],
  })
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })

  await pass(c, ma.id)
  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(audit.requirements[0]!.satisfied, true)
})

test('transfer credit counts towards the degree and not towards the average', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 8,
  })
  const here = await course(c, 'Algorithms')
  const there = await course(c, 'Physics')
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })

  await pass(c, here.id, 9)
  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: there.id,
    source: 'transfer',
    credits: 4,
    note: 'Accepted on the transfer sheet',
  })

  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(audit.creditsEarned, 8)
  // Nine, not four and a half: the ungraded four credits are not in the mean.
  assert.equal(audit.cgpa, 9)
})

test('the average is credit-weighted, not a flat mean', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 6,
  })
  const heavy = await course(c, 'Algorithms', 4)
  const light = await course(c, 'Seminar', 2)
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })

  await pass(c, heavy.id, 9)
  await pass(c, light.id, 6)

  // (9*4 + 6*2) / 6 = 8, where a flat mean would say 7.5.
  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(audit.cgpa, 8)
})

test('a declaration with no catalogue says so rather than reporting a finished degree', async () => {
  const c = await campus()
  await declareProgram(c.admin, { studentId: c.student.id, programId: c.programId })

  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(audit.requirements.length, 0)
  assert.equal(audit.complete, false)
  assert.match(String(audit.note), /no curriculum/)
})

test('two degrees are audited one at a time, starting with the one that leads', async () => {
  const c = await campus()
  const second = await createProgram(c.admin, {
    departmentId: c.deptId,
    code: 'BAMATH',
    name: 'BA Mathematics',
    level: 'undergraduate',
    durationTerms: 6,
  })
  await declareProgram(c.admin, { studentId: c.student.id, programId: c.programId })
  const lead = await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: second.id,
    isPrimary: true,
  })

  const byDefault = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(byDefault.programCode, 'BAMATH')
  assert.equal(
    (await degreeAudit(c.admin, { studentId: c.student.id, studentProgramId: lead.id }))
      .programCode,
    'BAMATH',
  )
})

test('a student who has declared nothing has nothing to audit', async () => {
  const c = await campus()
  await assert.rejects(
    () => degreeAudit(c.admin, { studentId: c.student.id }),
    (e: unknown) => errorCode(e) === 'no_declaration',
  )
})

test('a student reads their own audit and nobody else’s', async () => {
  const c = await campus()
  await declareProgram(c.admin, { studentId: c.student.id, programId: c.programId })

  assert.equal((await degreeAudit(c.student, { studentId: c.student.id })).programCode, 'BTCS')
  await assert.rejects(
    () => degreeAudit(c.other, { studentId: c.student.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('the exceptions that got a student here are on the audit', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 4,
  })
  const algo = await course(c, 'Algorithms')
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })
  await waivePrerequisite(c.admin, {
    studentId: c.student.id,
    courseId: algo.id,
    reason: 'admitted with advanced standing',
  })

  const audit = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(audit.overrides.length, 1)
  assert.match(audit.overrides[0]!.reason, /advanced standing/)
})

// --- corrections -----------------------------------------------------------

test('a grade is corrected with a reason, and the correction is on the record', async () => {
  const c = await campus()
  const algo = await course(c, 'Algorithms')
  const posted = await pass(c, algo.id, 5, { gradeLabel: 'C' })

  const outcome = await correctCompletion(c.admin, {
    completionId: posted.id,
    gradePoints: 8,
    gradeLabel: 'A',
    reason: 'second examiner reinstated four marks on question three',
  })
  assert.equal(outcome, 'corrected')

  const [row] = await listCompletions(c.admin, { studentId: c.student.id })
  assert.equal(row!.gradeLabel, 'A')
  assert.equal(Number(row!.gradePoints), 8)

  const trail = await withTenant(c.id, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, posted.id), eq(auditLog.action, 'completion.corrected'))),
  )
  assert.equal(trail.length, 1)
  assert.match(String(trail[0]!.reason), /second examiner/)
  assert.equal((trail[0]!.detail as { from: { gradeLabel: string } }).from.gradeLabel, 'C')
})

test('a correction that changes nothing is silent', async () => {
  const c = await campus()
  const algo = await course(c, 'Algorithms')
  const posted = await pass(c, algo.id, 8, { gradeLabel: 'A' })

  const outcome = await correctCompletion(c.admin, {
    completionId: posted.id,
    reason: 'checked against the script bundle, no change',
  })
  assert.equal(outcome, 'unchanged')

  const trail = await withTenant(c.id, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'completion.corrected')),
  )
  assert.equal(trail.length, 0)
})

test('a completed course cannot be edited or deleted behind the audit trail', async () => {
  const c = await campus()
  const algo = await course(c, 'Algorithms')
  const posted = await pass(c, algo.id, 5)

  // Straight at the table, with no reason set on the transaction.
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx
        .update(courseCompletions)
        .set({ gradePoints: '10.00' })
        .where(eq(courseCompletions.id, posted.id)),
    ),
  )
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx.delete(courseCompletions).where(eq(courseCompletions.id, posted.id)),
    ),
  )

  const [row] = await listCompletions(c.admin, { studentId: c.student.id })
  assert.equal(Number(row!.gradePoints), 5)
})

test('a course wrongly credited is corrected to a fail, not removed', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 4,
  })
  const algo = await course(c, 'Algorithms')
  await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'CORE',
    title: 'Core',
    kind: 'core',
    minCredits: 4,
    courseIds: [algo.id],
  })
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
    curriculumId: cur.id,
  })
  const posted = await pass(c, algo.id, 4, { gradeLabel: 'P' })
  assert.equal((await degreeAudit(c.admin, { studentId: c.student.id })).complete, true)

  await correctCompletion(c.admin, {
    completionId: posted.id,
    passed: false,
    gradeLabel: 'F',
    gradePoints: 0,
    reason: 'malpractice upheld by the committee',
  })

  const after = await degreeAudit(c.admin, { studentId: c.student.id })
  assert.equal(after.complete, false)
  assert.equal(after.requirements[0]!.outstanding.length, 1)
  // The attempt is still on the record, where a registrar can explain it.
  assert.equal((await listCompletions(c.admin, { studentId: c.student.id })).length, 1)
})
