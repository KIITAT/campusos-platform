import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { users, withTenant } from '@campusos/db'
import {
  courseCompletions,
  courseEquivalences,
  courses,
  curricula,
  prerequisiteWaivers,
  prerequisites,
  programs,
  requirementCourses,
  requirements,
  studentPrograms,
} from '../schema'
import {
  AcademicError,
  requireReader,
  requireWriter,
  rethrowConflict,
  type Actor,
} from './operations'
import {
  addEquivalenceSchema,
  addPrerequisiteSchema,
  createCurriculumSchema,
  createRequirementSchema,
  declareProgramSchema,
  endStudentProgramSchema,
  eligibilitySchema,
  recordCompletionSchema,
  studentRefSchema,
  waivePrerequisiteSchema,
  type Eligibility,
} from './schemas'

/**
 * The half of the academic core a registrar works from: what a degree requires,
 * what a course requires, which of those a named person was excused from, and
 * what a student has actually passed.
 *
 * Kept beside operations.ts rather than inside it because the two are read at
 * different times -- one builds the timetable, the other answers questions
 * about a student -- and because a 700-line file is a file nobody opens.
 */

/** Anyone may read their own record; staff read anyone's. */
function requireStudentView(actor: Actor, studentId: string): string {
  const tenant = requireReader(actor)
  const staff =
    actor.role === 'institution_admin' ||
    actor.role === 'super_admin' ||
    actor.role === 'hod' ||
    actor.role === 'faculty'
  if (!staff && actor.id !== studentId) {
    throw new AcademicError(403, 'forbidden', 'not permitted')
  }
  return tenant
}

// --- curricula -------------------------------------------------------------

export async function createCurriculum(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createCurriculumSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(curricula)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new AcademicError(
        409,
        'exists',
        'that programme already has a curriculum for that catalogue year',
      )
    }
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'curriculum rejected by a constraint'))
}

/**
 * A requirement and the courses that can satisfy it, in one call: a bucket with
 * no courses and no `open` kind is a rule nobody can meet, so writing them
 * separately only creates a window in which the curriculum is wrong.
 */
export async function createRequirement(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createRequirementSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(requirements)
      .values({
        institutionId: tenant,
        curriculumId: data.curriculumId,
        code: data.code,
        title: data.title,
        kind: data.kind,
        minCredits: data.minCredits ?? 0,
        minCourses: data.minCourses ?? 0,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new AcademicError(409, 'exists', 'that requirement code is already in this curriculum')
    }

    if (data.courseIds.length > 0) {
      await tx.insert(requirementCourses).values(
        data.courseIds.map((courseId) => ({
          institutionId: tenant,
          requirementId: row.id,
          courseId,
        })),
      )
    }
    return { ...row, courseIds: data.courseIds }
  }).catch((e) => rethrowConflict(e, 'invalid', 'requirement rejected by a constraint'))
}

export async function listCurricula(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: curricula.id,
        programId: curricula.programId,
        programCode: programs.code,
        programName: programs.name,
        catalogYear: curricula.catalogYear,
        totalCredits: curricula.totalCredits,
        isActive: curricula.isActive,
      })
      .from(curricula)
      .innerJoin(programs, eq(programs.id, curricula.programId))
      .orderBy(programs.code, curricula.catalogYear)

    const reqs = await tx
      .select({
        id: requirements.id,
        curriculumId: requirements.curriculumId,
        code: requirements.code,
        title: requirements.title,
        kind: requirements.kind,
        minCredits: requirements.minCredits,
        minCourses: requirements.minCourses,
      })
      .from(requirements)
      .orderBy(requirements.code)

    return rows.map((c) => ({
      ...c,
      requirements: reqs.filter((r) => r.curriculumId === c.id),
    }))
  })
}

// --- the prerequisite graph ------------------------------------------------

export async function addPrerequisite(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = addPrerequisiteSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(prerequisites)
      .values({
        institutionId: tenant,
        courseId: data.courseId,
        requiresCourseId: data.requiresCourseId,
        kind: data.kind,
        minGradePoints: data.minGradePoints ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'exists', 'that prerequisite is already recorded')
    return row
  }).catch((e) =>
    // The cycle trigger raises 23514, which rethrowConflict turns into a 409.
    rethrowConflict(e, 'cycle', 'that prerequisite closes a loop in the chain'),
  )
}

export async function addEquivalence(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = addEquivalenceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .insert(courseEquivalences)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
  }).catch((e) => rethrowConflict(e, 'invalid', 'equivalence rejected by a constraint'))
}

/**
 * The override. Blanket when no single prerequisite is named, which is what a
 * dean's letter usually amounts to; otherwise one edge, which is the more
 * honest version and the one a degree audit can explain.
 */
export async function waivePrerequisite(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = waivePrerequisiteSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(prerequisiteWaivers)
      .values({
        institutionId: tenant,
        studentId: data.studentId,
        courseId: data.courseId,
        requiresCourseId: data.requiresCourseId ?? null,
        reason: data.reason,
        approvedBy: actor.id,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'exists', 'that waiver is already on file')
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'waiver rejected by a constraint'))
}

// --- a student's programmes ------------------------------------------------

export async function declareProgram(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = declareProgramSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [student] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, data.studentId))
    if (!student) throw new AcademicError(404, 'no_such_user', 'no such user')
    if (student.role !== 'student') {
      throw new AcademicError(400, 'not_a_student', 'only a student reads for a degree')
    }

    // A second degree is a second declaration, so which one leads has to be
    // settled here rather than by whichever insert lost the race to the
    // partial unique index.
    if (data.isPrimary) {
      await tx
        .update(studentPrograms)
        .set({ isPrimary: false })
        .where(
          and(
            eq(studentPrograms.studentId, data.studentId),
            eq(studentPrograms.status, 'active'),
          ),
        )
    }

    const [row] = await tx
      .insert(studentPrograms)
      .values({
        institutionId: tenant,
        studentId: data.studentId,
        programId: data.programId,
        curriculumId: data.curriculumId ?? null,
        isPrimary: data.isPrimary,
        ...(data.declaredOn ? { declaredOn: data.declaredOn } : {}),
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new AcademicError(409, 'exists', 'that student is already reading that programme')
    }
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'declaration rejected by a constraint'))
}

/**
 * Leaving a programme, by whichever door. Never a delete: a withdrawal is part
 * of the record, and the transcript has to be able to say what happened.
 */
export async function endStudentProgram(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = endStudentProgramSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .update(studentPrograms)
      .set({
        status: data.status,
        endedOn: data.endedOn ?? new Date().toISOString().slice(0, 10),
        isPrimary: false,
      })
      .where(
        and(
          eq(studentPrograms.id, data.studentProgramId),
          eq(studentPrograms.status, 'active'),
        ),
      )
      .returning()
    if (!row) {
      throw new AcademicError(404, 'not_active', 'no live declaration with that id')
    }
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'rejected by a constraint'))
}

export async function listStudentPrograms(actor: Actor, input: unknown) {
  const studentId = studentRefSchema.parse(input ?? {}).studentId ?? actor.id
  const tenant = requireStudentView(actor, studentId)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: studentPrograms.id,
        programId: studentPrograms.programId,
        programCode: programs.code,
        programName: programs.name,
        curriculumId: studentPrograms.curriculumId,
        status: studentPrograms.status,
        isPrimary: studentPrograms.isPrimary,
        declaredOn: studentPrograms.declaredOn,
        endedOn: studentPrograms.endedOn,
      })
      .from(studentPrograms)
      .innerJoin(programs, eq(programs.id, studentPrograms.programId))
      .where(eq(studentPrograms.studentId, studentId))
      .orderBy(studentPrograms.declaredOn),
  )
}

// --- what a student has done -----------------------------------------------

/**
 * One row of a student's record. Written here by hand for transfer credit, and
 * by the examinations module when a result is finalised -- same table either
 * way, because the prerequisite check and the degree audit must not have to ask
 * where a pass came from.
 *
 * Credits default to the course's current value and are then frozen on the row:
 * re-pricing a course in credits next year must not rewrite what was earned.
 */
export async function recordCompletion(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = recordCompletionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [course] = await tx
      .select({ credits: courses.credits })
      .from(courses)
      .where(eq(courses.id, data.courseId))
    if (!course) throw new AcademicError(404, 'no_such_course', 'no such course')

    if (data.source === 'transfer' && data.termId) {
      throw new AcademicError(
        400,
        'transfer_has_no_term',
        'a transferred course was not earned in one of our terms',
      )
    }

    const [row] = await tx
      .insert(courseCompletions)
      .values({
        institutionId: tenant,
        studentId: data.studentId,
        courseId: data.courseId,
        termId: data.termId ?? null,
        credits: data.credits ?? course.credits,
        gradePoints: data.gradePoints ?? null,
        gradeLabel: data.gradeLabel ?? null,
        passed: data.passed,
        source: data.source,
        note: data.note ?? null,
        recordedBy: actor.id,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new AcademicError(
        409,
        'exists',
        'that attempt is already on the record for that term',
      )
    }
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'completion rejected by a constraint'))
}

export async function listCompletions(actor: Actor, input: unknown) {
  const studentId = studentRefSchema.parse(input ?? {}).studentId ?? actor.id
  const tenant = requireStudentView(actor, studentId)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: courseCompletions.id,
        courseId: courseCompletions.courseId,
        courseCode: courses.code,
        courseTitle: courses.title,
        termId: courseCompletions.termId,
        credits: courseCompletions.credits,
        gradePoints: courseCompletions.gradePoints,
        gradeLabel: courseCompletions.gradeLabel,
        passed: courseCompletions.passed,
        source: courseCompletions.source,
        note: courseCompletions.note,
      })
      .from(courseCompletions)
      .innerJoin(courses, eq(courses.id, courseCompletions.courseId))
      .where(eq(courseCompletions.studentId, studentId))
      .orderBy(courses.code),
  )
}

// --- eligibility -----------------------------------------------------------

/**
 * May this student take that course?
 *
 * Four things decide it, and the answer names which:
 *
 *   * a pass on the required course, or on anything cross-listed with it or
 *     accepted as equivalent to it
 *   * a minimum grade, when the calendar states one. A pass carrying no grade
 *     at all -- which is most transfer credit -- does not clear a stated
 *     minimum: there is nothing to compare, and inventing a comparison is how a
 *     registrar ends up defending a number they never entered. It needs a
 *     waiver, which is a person's name against a reason.
 *   * a waiver, blanket or on one edge
 *   * corequisites, which are reported rather than enforced: they may be taken
 *     alongside, and whether one actually was is registration's question, not
 *     this one's.
 */
export async function checkEligibility(actor: Actor, input: unknown): Promise<Eligibility> {
  const data = eligibilitySchema.parse(input)
  const tenant = requireStudentView(actor, data.studentId)

  return withTenant(tenant, async (tx) => {
    const [course] = await tx
      .select({ id: courses.id, code: courses.code, title: courses.title })
      .from(courses)
      .where(eq(courses.id, data.courseId))
    if (!course) throw new AcademicError(404, 'no_such_course', 'no such course')

    const edges = await tx
      .select({
        requiresCourseId: prerequisites.requiresCourseId,
        kind: prerequisites.kind,
        minGradePoints: prerequisites.minGradePoints,
        code: courses.code,
        title: courses.title,
      })
      .from(prerequisites)
      .innerJoin(courses, eq(courses.id, prerequisites.requiresCourseId))
      .where(eq(prerequisites.courseId, data.courseId))

    if (edges.length === 0) {
      return {
        courseId: course.id,
        courseCode: course.code,
        eligible: true,
        missing: [],
        corequisites: [],
      }
    }

    const waivers = await tx
      .select({ requiresCourseId: prerequisiteWaivers.requiresCourseId })
      .from(prerequisiteWaivers)
      .where(
        and(
          eq(prerequisiteWaivers.studentId, data.studentId),
          eq(prerequisiteWaivers.courseId, data.courseId),
        ),
      )
    const blanket = waivers.some((w) => w.requiresCourseId === null)
    const waived = new Set(waivers.map((w) => w.requiresCourseId).filter(Boolean) as string[])

    const wanted = edges.map((e) => e.requiresCourseId)
    // Cross-listing works in both directions, and the registrar states it once.
    const sameAs = await tx
      .select({
        courseId: courseEquivalences.courseId,
        equivalentCourseId: courseEquivalences.equivalentCourseId,
      })
      .from(courseEquivalences)
      .where(
        or(
          inArray(courseEquivalences.courseId, wanted),
          inArray(courseEquivalences.equivalentCourseId, wanted),
        ),
      )
    const standsFor = (required: string): string[] => [
      required,
      ...sameAs
        .filter((e) => e.courseId === required || e.equivalentCourseId === required)
        .map((e) => (e.courseId === required ? e.equivalentCourseId : e.courseId)),
    ]

    const passes = await tx
      .select({
        courseId: courseCompletions.courseId,
        gradePoints: courseCompletions.gradePoints,
      })
      .from(courseCompletions)
      .where(
        and(
          eq(courseCompletions.studentId, data.studentId),
          eq(courseCompletions.passed, true),
        ),
      )

    const best = (courseIds: string[]): { passed: boolean; points: number | null } => {
      const mine = passes.filter((p) => courseIds.includes(p.courseId))
      if (mine.length === 0) return { passed: false, points: null }
      const graded = mine
        .map((p) => (p.gradePoints === null ? null : Number(p.gradePoints)))
        .filter((n): n is number => n !== null)
      return { passed: true, points: graded.length > 0 ? Math.max(...graded) : null }
    }

    const missing: Eligibility['missing'] = []
    const corequisites: Eligibility['corequisites'] = []

    for (const edge of edges) {
      const need = edge.minGradePoints === null ? null : Number(edge.minGradePoints)
      const got = best(standsFor(edge.requiresCourseId))
      const met =
        got.passed && (need === null || (got.points !== null && got.points >= need))

      if (met) continue
      if (blanket || waived.has(edge.requiresCourseId)) continue

      const why = !got.passed
        ? ('not_passed' as const)
        : got.points === null
          ? ('no_grade_on_record' as const)
          : ('below_minimum' as const)

      const entry = {
        courseId: edge.requiresCourseId,
        courseCode: edge.code,
        courseTitle: edge.title,
        minGradePoints: edge.minGradePoints,
        reason: why,
      }
      if (edge.kind === 'corequisite') corequisites.push(entry)
      else missing.push(entry)
    }

    return {
      courseId: course.id,
      courseCode: course.code,
      eligible: missing.length === 0,
      missing,
      corequisites,
    }
  })
}

/** Every prerequisite edge in the institution, for the curriculum page. */
export async function listPrerequisites(actor: Actor) {
  const tenant = requireReader(actor)
  const required = alias(courses, 'required')
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: prerequisites.id,
        courseCode: courses.code,
        courseTitle: courses.title,
        requiresCode: required.code,
        requiresTitle: required.title,
        kind: prerequisites.kind,
        minGradePoints: prerequisites.minGradePoints,
      })
      .from(prerequisites)
      .innerJoin(courses, eq(courses.id, prerequisites.courseId))
      .innerJoin(required, eq(required.id, prerequisites.requiresCourseId))
      .orderBy(courses.code, required.code),
  )
}

/** Waivers on file, newest first: the exceptions register. */
export async function listWaivers(actor: Actor) {
  const tenant = requireWriter(actor)
  const required = alias(courses, 'required')
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: prerequisiteWaivers.id,
        studentId: prerequisiteWaivers.studentId,
        studentName: users.name,
        courseCode: courses.code,
        requiresCode: required.code,
        reason: prerequisiteWaivers.reason,
        approvedBy: prerequisiteWaivers.approvedBy,
        createdAt: prerequisiteWaivers.createdAt,
      })
      .from(prerequisiteWaivers)
      .innerJoin(users, eq(users.id, prerequisiteWaivers.studentId))
      .innerJoin(courses, eq(courses.id, prerequisiteWaivers.courseId))
      // Left, because a blanket waiver names no single prerequisite.
      .leftJoin(required, eq(required.id, prerequisiteWaivers.requiresCourseId))
      .orderBy(desc(prerequisiteWaivers.createdAt)),
  )
}
