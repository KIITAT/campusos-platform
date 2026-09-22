import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  AcademicError,
  addEquivalence,
  addPrerequisite,
  checkEligibility,
  createCourse,
  createCurriculum,
  createDepartment,
  createProgram,
  createRequirement,
  createTerm,
  declareProgram,
  endStudentProgram,
  listCompletions,
  listCurricula,
  listPrerequisites,
  listStudentPrograms,
  listWaivers,
  recordCompletion,
  setTermCalendar,
  waivePrerequisite,
  type Actor,
} from './api'
import { courses } from './schema'

/**
 * The registrar's half of the academic core: what a degree requires, what a
 * course requires, who was excused from it, and what a student has actually
 * passed.
 *
 * A fresh institution per test. These write to the same few tables from
 * several directions -- a waiver, a transfer credit, a cross-listing -- and a
 * shared fixture would make every failure a question about which test ran
 * first.
 */

let n = 0
const SLUG = 'acad-curr-'

interface Campus {
  id: string
  admin: Actor
  student: Actor
  other: Actor
  deptId: string
  programId: string
}

const code = (prefix: string) => `${prefix}${++n}`

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Curriculum College', allowedEmailDomains: [`${tag}.test`] })
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

  return {
    id,
    admin,
    student: { id: people[1]!.id, role: 'student', institutionId: id },
    other: { id: people[2]!.id, role: 'student', institutionId: id },
    deptId: dept.id,
    programId: program.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const course = (c: Campus, title: string, credits = 4) =>
  createCourse(c.admin, { departmentId: c.deptId, code: code('C'), title, credits })

const term = (c: Campus, name = 'Autumn', starts = '2025-07-01', ends = '2025-12-15') =>
  createTerm(c.admin, { code: code('T'), name, startsOn: starts, endsOn: ends })

const errorCode = (e: unknown) => (e as AcademicError).code

// --- curricula -------------------------------------------------------------

test('a curriculum belongs to a catalogue year, and only one does', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 160,
  })
  assert.equal(cur.catalogYear, 2025)

  await assert.rejects(
    () => createCurriculum(c.admin, { programId: c.programId, catalogYear: 2025, totalCredits: 170 }),
    (e: unknown) => errorCode(e) === 'exists',
  )

  // Next year's rules are a different row, which is the whole point.
  const next = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2026,
    totalCredits: 158,
  })
  assert.notEqual(next.id, cur.id)
})

test('a requirement names the courses that satisfy it', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 160,
  })
  const maths = await course(c, 'Discrete Mathematics')
  const algo = await course(c, 'Algorithms')

  const req = await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'CORE',
    title: 'Core computing',
    kind: 'core',
    minCredits: 8,
    courseIds: [maths.id, algo.id],
  })
  assert.equal(req.courseIds.length, 2)

  const listed = await listCurricula(c.admin)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.requirements.length, 1)
  assert.equal(listed[0]!.requirements[0]!.minCredits, 8)
})

test('a core requirement with no courses is refused before it reaches the database', async () => {
  const c = await campus()
  const cur = await createCurriculum(c.admin, {
    programId: c.programId,
    catalogYear: 2025,
    totalCredits: 160,
  })

  await assert.rejects(() =>
    createRequirement(c.admin, {
      curriculumId: cur.id,
      code: 'CORE',
      title: 'Core, allegedly',
      kind: 'core',
      minCredits: 8,
      courseIds: [],
    }),
  )

  // An open requirement is the honest way to say "anything that counts".
  const open = await createRequirement(c.admin, {
    curriculumId: cur.id,
    code: 'OPEN',
    title: 'Open electives',
    kind: 'open',
    minCredits: 12,
    courseIds: [],
  })
  assert.equal(open.kind, 'open')
})

// --- the chain -------------------------------------------------------------

test('a course with no prerequisites is open to anyone', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: intro.id })
  assert.equal(e.eligible, true)
  assert.equal(e.missing.length, 0)
})

test('a prerequisite not passed is the reason the answer is no', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: intro.id })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, false)
  assert.equal(e.missing.length, 1)
  assert.equal(e.missing[0]!.reason, 'not_passed')
  assert.equal(e.missing[0]!.courseCode, intro.code)
})

test('a pass on the required course opens the next one', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  const t = await term(c)
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: intro.id })

  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    termId: t.id,
    gradePoints: 7,
    gradeLabel: 'B',
  })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, true)
})

test('a stated minimum grade is a minimum, not a suggestion', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  const t = await term(c)
  await addPrerequisite(c.admin, {
    courseId: algo.id,
    requiresCourseId: intro.id,
    minGradePoints: 6,
  })

  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    termId: t.id,
    gradePoints: 5,
    gradeLabel: 'D',
  })
  const scraped = await checkEligibility(c.admin, {
    studentId: c.student.id,
    courseId: algo.id,
  })
  assert.equal(scraped.eligible, false)
  assert.equal(scraped.missing[0]!.reason, 'below_minimum')
  assert.equal(scraped.missing[0]!.minGradePoints, '6.00')

  // A second, better attempt in a later term is the one that counts.
  const t2 = await term(c, 'Spring', '2026-01-05', '2026-05-30')
  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    termId: t2.id,
    gradePoints: 8,
    gradeLabel: 'A',
  })
  const repeated = await checkEligibility(c.admin, {
    studentId: c.student.id,
    courseId: algo.id,
  })
  assert.equal(repeated.eligible, true)
})

test('a transfer credit carrying no grade does not clear a stated minimum on its own', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  await addPrerequisite(c.admin, {
    courseId: algo.id,
    requiresCourseId: intro.id,
    minGradePoints: 6,
  })

  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    source: 'transfer',
    credits: 3,
    note: 'Accepted from another university, letter on file',
  })

  // There is nothing to compare, and a comparison invented here is one the
  // registrar would have to defend later.
  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, false)
  assert.equal(e.missing[0]!.reason, 'no_grade_on_record')

  // The named exception is how it gets through, and it says who said so.
  await waivePrerequisite(c.admin, {
    studentId: c.student.id,
    courseId: algo.id,
    requiresCourseId: intro.id,
    reason: 'transfer credit accepted at the same level',
  })
  const after = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(after.eligible, true)
})

test('a transfer credit with no minimum to clear simply counts', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: intro.id })

  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    source: 'transfer',
    credits: 3,
    note: 'Transcript on file',
  })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, true)
})

test('a blanket waiver excuses the whole chain, and is on the register', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const maths = await course(c, 'Discrete Mathematics')
  const algo = await course(c, 'Algorithms')
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: intro.id })
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: maths.id })

  const before = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(before.missing.length, 2)

  await waivePrerequisite(c.admin, {
    studentId: c.student.id,
    courseId: algo.id,
    reason: 'admitted with advanced standing by the dean',
  })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, true)

  const register = await listWaivers(c.admin)
  assert.equal(register.length, 1)
  assert.equal(register[0]!.requiresCode, null)
  assert.match(register[0]!.reason, /advanced standing/)

  // A waiver is one person's decision, recorded once.
  await assert.rejects(
    () =>
      waivePrerequisite(c.admin, {
        studentId: c.student.id,
        courseId: algo.id,
        reason: 'the dean, again',
      }),
    (e: unknown) => errorCode(e) === 'exists',
  )
})

test('a waiver is for one student, not for the course', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: intro.id })
  await waivePrerequisite(c.admin, {
    studentId: c.student.id,
    courseId: algo.id,
    reason: 'sat the equivalent paper at another institution',
  })

  const mine = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  const theirs = await checkEligibility(c.admin, { studentId: c.other.id, courseId: algo.id })
  assert.equal(mine.eligible, true)
  assert.equal(theirs.eligible, false)
})

test('a cross-listed course is the same course to the chain', async () => {
  const c = await campus()
  const csMaths = await course(c, 'Discrete Mathematics (CS)')
  const maMaths = await course(c, 'Discrete Mathematics (Maths)')
  const algo = await course(c, 'Algorithms')
  const t = await term(c)

  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: csMaths.id })
  await addEquivalence(c.admin, {
    courseId: csMaths.id,
    equivalentCourseId: maMaths.id,
    note: 'Cross-listed, taught once',
  })

  // Passed under the mathematics code, required under the computing one.
  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: maMaths.id,
    termId: t.id,
    gradePoints: 7,
  })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, true)
})

test('a corequisite is reported, not enforced', async () => {
  const c = await campus()
  const lab = await course(c, 'Physics Laboratory', 2)
  const physics = await course(c, 'Physics')
  await addPrerequisite(c.admin, {
    courseId: physics.id,
    requiresCourseId: lab.id,
    kind: 'corequisite',
  })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: physics.id })
  assert.equal(e.eligible, true)
  assert.equal(e.missing.length, 0)
  assert.equal(e.corequisites.length, 1)
  assert.equal(e.corequisites[0]!.courseCode, lab.code)
})

test('the chain cannot close a loop, however long the way round', async () => {
  const c = await campus()
  const a = await course(c, 'A')
  const b = await course(c, 'B')
  const d = await course(c, 'D')

  await addPrerequisite(c.admin, { courseId: b.id, requiresCourseId: a.id })
  await addPrerequisite(c.admin, { courseId: d.id, requiresCourseId: b.id })

  // The short way round.
  await assert.rejects(
    () => addPrerequisite(c.admin, { courseId: a.id, requiresCourseId: b.id }),
    (e: unknown) => errorCode(e) === 'cycle',
  )
  // And the long one: A needs D, which needs B, which needs A.
  await assert.rejects(
    () => addPrerequisite(c.admin, { courseId: a.id, requiresCourseId: d.id }),
    (e: unknown) => errorCode(e) === 'cycle',
  )

  // A course requiring itself never reaches the database.
  await assert.rejects(() => addPrerequisite(c.admin, { courseId: a.id, requiresCourseId: a.id }))

  assert.equal((await listPrerequisites(c.admin)).length, 2)
})

// --- programmes ------------------------------------------------------------

test('a student can read two degrees at once, and one of them leads', async () => {
  const c = await campus()
  const second = await createProgram(c.admin, {
    departmentId: c.deptId,
    code: 'BAMATH',
    name: 'BA Mathematics',
    level: 'undergraduate',
    durationTerms: 6,
  })

  await declareProgram(c.admin, { studentId: c.student.id, programId: c.programId })
  await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: second.id,
    isPrimary: true,
  })

  const mine = await listStudentPrograms(c.admin, { studentId: c.student.id })
  assert.equal(mine.length, 2)
  assert.equal(mine.filter((p) => p.isPrimary).length, 1)
  assert.equal(mine.find((p) => p.isPrimary)!.programCode, 'BAMATH')
})

test('the same degree twice at once is refused; after withdrawing it is not', async () => {
  const c = await campus()
  const first = await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
  })

  await assert.rejects(
    () => declareProgram(c.admin, { studentId: c.student.id, programId: c.programId }),
    (e: unknown) => errorCode(e) === 'exists',
  )

  const ended = await endStudentProgram(c.admin, {
    studentProgramId: first.id,
    status: 'withdrawn',
    endedOn: '2025-11-30',
  })
  assert.equal(ended.status, 'withdrawn')
  assert.equal(ended.endedOn, '2025-11-30')

  // Coming back years later is a second row, not an edit of the first.
  const again = await declareProgram(c.admin, {
    studentId: c.student.id,
    programId: c.programId,
  })
  assert.notEqual(again.id, first.id)
  assert.equal((await listStudentPrograms(c.admin, { studentId: c.student.id })).length, 2)
})

test('only a student reads for a degree', async () => {
  const c = await campus()
  await assert.rejects(
    () => declareProgram(c.admin, { studentId: c.admin.id, programId: c.programId }),
    (e: unknown) => errorCode(e) === 'not_a_student',
  )
})

// --- the record ------------------------------------------------------------

test('a course is credited at what was agreed, not at what it costs today', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing', 4)

  const transferred = await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    source: 'transfer',
    credits: 3,
    note: 'Three credits agreed on the transfer sheet',
  })
  assert.equal(transferred.credits, 3)

  // Re-pricing the course does not rewrite what was earned.
  await withTenant(c.id, (tx) =>
    tx.update(courses).set({ credits: 5 }).where(eq(courses.id, intro.id)),
  )
  const record = await listCompletions(c.admin, { studentId: c.student.id })
  assert.equal(record[0]!.credits, 3)
})

test('a term is where a pass happened, so a transfer has none', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const t = await term(c)

  await assert.rejects(
    () =>
      recordCompletion(c.admin, {
        studentId: c.student.id,
        courseId: intro.id,
        termId: t.id,
        source: 'transfer',
      }),
    (e: unknown) => errorCode(e) === 'transfer_has_no_term',
  )

  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    termId: t.id,
  })
  await assert.rejects(
    () =>
      recordCompletion(c.admin, {
        studentId: c.student.id,
        courseId: intro.id,
        termId: t.id,
      }),
    (e: unknown) => errorCode(e) === 'exists',
  )
})

test('a failed attempt stays on the record and satisfies nothing', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const algo = await course(c, 'Algorithms')
  const t = await term(c)
  await addPrerequisite(c.admin, { courseId: algo.id, requiresCourseId: intro.id })

  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    termId: t.id,
    passed: false,
    gradePoints: 2,
    gradeLabel: 'F',
  })

  const e = await checkEligibility(c.admin, { studentId: c.student.id, courseId: algo.id })
  assert.equal(e.eligible, false)
  assert.equal((await listCompletions(c.admin, { studentId: c.student.id })).length, 1)
})

test('a student reads their own record and nobody else’s', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  const t = await term(c)
  await recordCompletion(c.admin, {
    studentId: c.student.id,
    courseId: intro.id,
    termId: t.id,
  })

  const mine = await listCompletions(c.student, {})
  assert.equal(mine.length, 1)

  await assert.rejects(
    () => listCompletions(c.other, { studentId: c.student.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
  await assert.rejects(
    () => checkEligibility(c.other, { studentId: c.student.id, courseId: intro.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('a student cannot write their own record', async () => {
  const c = await campus()
  const intro = await course(c, 'Introduction to Computing')
  await assert.rejects(
    () =>
      recordCompletion(c.student, {
        studentId: c.student.id,
        courseId: intro.id,
        source: 'transfer',
        credits: 4,
      }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
  await assert.rejects(
    () => declareProgram(c.student, { studentId: c.student.id, programId: c.programId }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('another institution cannot see, or reach into, this one', async () => {
  const a = await campus()
  const b = await campus()
  const intro = await course(a, 'Introduction to Computing')
  const t = await term(a)
  await recordCompletion(a.admin, {
    studentId: a.student.id,
    courseId: intro.id,
    termId: t.id,
  })
  await createCurriculum(a.admin, {
    programId: a.programId,
    catalogYear: 2025,
    totalCredits: 160,
  })

  // RLS, not a WHERE clause: B's admin is inside B's transaction throughout.
  assert.equal((await listCurricula(b.admin)).length, 0)
  assert.equal((await listCompletions(b.admin, { studentId: a.student.id })).length, 0)
  await assert.rejects(
    () => checkEligibility(b.admin, { studentId: a.student.id, courseId: intro.id }),
    (e: unknown) => errorCode(e) === 'no_such_course',
  )
})

// --- the calendar ----------------------------------------------------------

test('a summer term is its own kind of term, with its own calendar', async () => {
  const c = await campus()
  const summer = await createTerm(c.admin, {
    code: code('SUM'),
    name: 'Summer',
    kind: 'summer',
    startsOn: '2026-05-04',
    endsOn: '2026-06-26',
  })
  assert.equal(summer.kind, 'summer')

  const dated = await setTermCalendar(c.admin, {
    termId: summer.id,
    registrationOpensOn: '2026-04-06',
    registrationClosesOn: '2026-05-08',
    addDropEndsOn: '2026-05-11',
    withdrawEndsOn: '2026-06-05',
  })
  assert.equal(dated.addDropEndsOn, '2026-05-11')
  assert.equal(dated.withdrawEndsOn, '2026-06-05')
})

test('a calendar that runs backwards is refused', async () => {
  const c = await campus()
  const t = await term(c)

  // Registration closing before it opens.
  await assert.rejects(() =>
    setTermCalendar(c.admin, {
      termId: t.id,
      registrationOpensOn: '2025-06-01',
      registrationClosesOn: '2025-05-01',
    }),
  )
  // Withdrawal after the term has ended, which the database refuses even
  // though the two dates are in the right order relative to each other.
  await assert.rejects(
    () =>
      setTermCalendar(c.admin, {
        termId: t.id,
        addDropEndsOn: '2025-07-20',
        withdrawEndsOn: '2026-03-01',
      }),
    (e: unknown) => errorCode(e) === 'invalid',
  )
})

test('an unset window is closed, not open', async () => {
  const c = await campus()
  const t = await term(c)
  // Nothing is assumed on creation: a term with no registration dates has not
  // opened, which is what enrollment will read in the next phase.
  assert.equal(t.registrationOpensOn, null)
  assert.equal(t.addDropEndsOn, null)
  assert.equal(t.kind, 'regular')
})
