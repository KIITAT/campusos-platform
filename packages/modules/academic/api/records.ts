import { and, eq, inArray } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import {
  courseCompletions,
  courseEquivalences,
  courses,
  curricula,
  prerequisiteWaivers,
  programs,
  requirementCourses,
  requirements,
  studentPrograms,
} from '../schema'
import { AcademicError, requireReader, requireWriter, type Actor } from './operations'
import {
  correctCompletionSchema,
  degreeAuditQuerySchema,
  type DegreeAudit,
} from './schemas'

/**
 * The record, read back: is this degree finished, and what is left.
 *
 * Also the seam the examinations module posts a finalised result through, so
 * that the registrar's numbers and the examiner's are the same numbers rather
 * than two derivations of the same marks that drift apart the first time one of
 * them is corrected.
 */

const MODULE = 'academic'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export interface CompletionPost {
  studentId: string
  courseId: string
  termId: string | null
  credits: number
  gradePoints: string | null
  gradeLabel: string | null
  passed: boolean
  note?: string | null
}

/**
 * Post a result into the academic record from inside the caller's transaction.
 *
 * Written for examinations to call when it finalises a course: the marks, the
 * completion and the audit row all land or none of them do. Correcting an
 * existing result bumps its revision and needs a reason, which the trigger on
 * the table enforces rather than trusting this function to remember.
 *
 * Returns whether anything actually changed, so a re-finalise that grades
 * everybody the same way again is silent rather than noise in the audit log.
 */
export async function postCompletionWithin(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  result: CompletionPost,
  reason: string,
): Promise<'created' | 'corrected' | 'unchanged'> {
  const [existing] = await tx
    .select()
    .from(courseCompletions)
    .where(
      and(
        eq(courseCompletions.studentId, result.studentId),
        eq(courseCompletions.courseId, result.courseId),
        result.termId
          ? eq(courseCompletions.termId, result.termId)
          : eq(courseCompletions.source, 'internal'),
      ),
    )

  if (!existing) {
    await tx.insert(courseCompletions).values({
      institutionId,
      studentId: result.studentId,
      courseId: result.courseId,
      termId: result.termId,
      credits: result.credits,
      gradePoints: result.gradePoints,
      gradeLabel: result.gradeLabel,
      passed: result.passed,
      source: 'internal',
      note: result.note ?? null,
      recordedBy: actorId,
    })
    return 'created'
  }

  const same =
    existing.gradePoints === result.gradePoints &&
    existing.gradeLabel === result.gradeLabel &&
    existing.passed === result.passed &&
    existing.credits === result.credits
  if (same) return 'unchanged'

  // The reason is set on the transaction by audit(), and the trigger on the
  // table refuses the update without it. Audited first, deliberately.
  await audit(tx, {
    institutionId,
    actorId,
    actorEmail: null,
    moduleId: MODULE,
    action: 'completion.corrected',
    entity: 'academic_course_completions',
    entityId: existing.id,
    reason,
    detail: {
      from: {
        gradePoints: existing.gradePoints,
        gradeLabel: existing.gradeLabel,
        passed: existing.passed,
        credits: existing.credits,
      },
      to: {
        gradePoints: result.gradePoints,
        gradeLabel: result.gradeLabel,
        passed: result.passed,
        credits: result.credits,
      },
    },
  })

  await tx
    .update(courseCompletions)
    .set({
      credits: result.credits,
      gradePoints: result.gradePoints,
      gradeLabel: result.gradeLabel,
      passed: result.passed,
      note: result.note ?? existing.note,
      revision: existing.revision + 1,
      recordedBy: actorId,
    })
    .where(eq(courseCompletions.id, existing.id))

  return 'corrected'
}

/** The same op, on its own transaction, for a registrar correcting by hand. */
export async function correctCompletion(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = correctCompletionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(courseCompletions)
      .where(eq(courseCompletions.id, data.completionId))
    if (!row) throw new AcademicError(404, 'no_such_completion', 'no such completion')

    return postCompletionWithin(
      tx,
      tenant,
      actor.id,
      {
        studentId: row.studentId,
        courseId: row.courseId,
        termId: row.termId,
        credits: data.credits ?? row.credits,
        gradePoints: data.gradePoints ?? row.gradePoints,
        gradeLabel: data.gradeLabel ?? row.gradeLabel,
        passed: data.passed ?? row.passed,
      },
      data.reason,
    )
  })
}

// --- the degree audit ------------------------------------------------------

/**
 * What is finished, what is outstanding, and what the average is.
 *
 * Each passed course is spent once. Requirements are filled in the order they
 * are the hardest to fill -- named courses first, then pools, then anything
 * that counts -- because a course that satisfies a core requirement and an open
 * one has to go to the core requirement or the degree stalls with an open
 * bucket full and a core bucket empty.
 *
 * ponytail: greedy allocation in that fixed order, not an optimal assignment.
 * It gets the common shapes right; a curriculum whose pools genuinely overlap
 * enough for the order to matter wants a real matching, and wants a registrar
 * to have asked for one first.
 *
 * The cumulative average is computed here rather than asked of examinations:
 * this table is the record, transfer credit is in it and has no marks behind
 * it, and a second derivation from marks would be the one that drifts.
 */
export async function degreeAudit(actor: Actor, input: unknown): Promise<DegreeAudit> {
  const data = degreeAuditQuerySchema.parse(input)
  const studentId = data.studentId
  const tenant = requireReader(actor)
  const staff =
    actor.role === 'institution_admin' ||
    actor.role === 'super_admin' ||
    actor.role === 'hod' ||
    actor.role === 'faculty'
  if (!staff && actor.id !== studentId) {
    throw new AcademicError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx): Promise<DegreeAudit> => {
    const [student] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, studentId))
    if (!student) throw new AcademicError(404, 'no_such_student', 'no such student')

    const declarations = await tx
      .select({
        id: studentPrograms.id,
        programId: studentPrograms.programId,
        programCode: programs.code,
        programName: programs.name,
        curriculumId: studentPrograms.curriculumId,
        status: studentPrograms.status,
        isPrimary: studentPrograms.isPrimary,
      })
      .from(studentPrograms)
      .innerJoin(programs, eq(programs.id, studentPrograms.programId))
      .where(eq(studentPrograms.studentId, studentId))

    const live = declarations.filter((d) => d.status === 'active')
    const chosen = data.studentProgramId
      ? declarations.find((d) => d.id === data.studentProgramId)
      : (live.find((d) => d.isPrimary) ?? live[0])
    if (!chosen) {
      throw new AcademicError(
        404,
        'no_declaration',
        'that student is not reading for a programme',
      )
    }

    const passes = await tx
      .select({
        courseId: courseCompletions.courseId,
        courseCode: courses.code,
        courseTitle: courses.title,
        credits: courseCompletions.credits,
        gradePoints: courseCompletions.gradePoints,
        passed: courseCompletions.passed,
        source: courseCompletions.source,
      })
      .from(courseCompletions)
      .innerJoin(courses, eq(courses.id, courseCompletions.courseId))
      .where(
        and(
          eq(courseCompletions.studentId, studentId),
          eq(courseCompletions.passed, true),
        ),
      )

    // Credit-weighted, over graded passes only. A transfer credit with no
    // grade counts towards the degree and not towards the average, which is
    // what a transcript that prints both has to mean.
    let weighted = 0
    let gradedCredits = 0
    for (const p of passes) {
      if (p.gradePoints === null) continue
      weighted += Number(p.gradePoints) * p.credits
      gradedCredits += p.credits
    }
    const cgpa = gradedCredits === 0 ? null : Math.round((weighted / gradedCredits) * 100) / 100
    const creditsEarned = passes.reduce((n, p) => n + p.credits, 0)

    const overrides = await tx
      .select({
        courseCode: courses.code,
        reason: prerequisiteWaivers.reason,
        approvedBy: prerequisiteWaivers.approvedBy,
      })
      .from(prerequisiteWaivers)
      .innerJoin(courses, eq(courses.id, prerequisiteWaivers.courseId))
      .where(eq(prerequisiteWaivers.studentId, studentId))

    if (!chosen.curriculumId) {
      return {
        studentId,
        studentName: student.name ?? null,
        programCode: chosen.programCode,
        programName: chosen.programName,
        catalogYear: null,
        totalCredits: null,
        creditsEarned,
        creditsRemaining: null,
        cgpa,
        complete: false,
        requirements: [],
        overrides,
        note: 'no curriculum was recorded at declaration, so there is nothing to audit against',
      }
    }

    const [curriculum] = await tx
      .select()
      .from(curricula)
      .where(eq(curricula.id, chosen.curriculumId))

    const rules = await tx
      .select()
      .from(requirements)
      .where(eq(requirements.curriculumId, chosen.curriculumId))
      .orderBy(requirements.code)

    const named = rules.length
      ? await tx
          .select({
            requirementId: requirementCourses.requirementId,
            courseId: requirementCourses.courseId,
            courseCode: courses.code,
            courseTitle: courses.title,
          })
          .from(requirementCourses)
          .innerJoin(courses, eq(courses.id, requirementCourses.courseId))
          .where(
            inArray(
              requirementCourses.requirementId,
              rules.map((r) => r.id),
            ),
          )
      : []

    const wanted = named.map((n) => n.courseId)
    const sameAs = wanted.length
      ? await tx
          .select({
            courseId: courseEquivalences.courseId,
            equivalentCourseId: courseEquivalences.equivalentCourseId,
          })
          .from(courseEquivalences)
      : []
    const standsFor = (required: string): string[] => [
      required,
      ...sameAs
        .filter((e) => e.courseId === required || e.equivalentCourseId === required)
        .map((e) => (e.courseId === required ? e.equivalentCourseId : e.courseId)),
    ]

    const spent = new Set<string>()
    const order = { core: 0, elective: 1, open: 2 }
    const inOrder = [...rules].sort((a, b) => order[a.kind] - order[b.kind])

    const audited = inOrder.map((rule) => {
      const mine = named.filter((n) => n.requirementId === rule.id)
      const pool =
        rule.kind === 'open'
          ? passes.filter((p) => !spent.has(p.courseId))
          : passes.filter(
              (p) =>
                !spent.has(p.courseId) &&
                mine.some((m) => standsFor(m.courseId).includes(p.courseId)),
            )

      let credits = 0
      let count = 0
      const used: string[] = []
      for (const p of pool) {
        // A pool stops taking once it has enough; the rest stay available to
        // the requirement behind it.
        if (
          rule.kind !== 'core' &&
          credits >= rule.minCredits &&
          count >= rule.minCourses
        ) {
          break
        }
        spent.add(p.courseId)
        used.push(p.courseCode)
        credits += p.credits
        count += 1
      }

      const outstanding =
        rule.kind === 'core'
          ? mine
              .filter((m) => !standsFor(m.courseId).some((id) => spent.has(id)))
              .map((m) => ({ courseCode: m.courseCode, courseTitle: m.courseTitle }))
          : []

      return {
        code: rule.code,
        title: rule.title,
        kind: rule.kind,
        minCredits: rule.minCredits,
        minCourses: rule.minCourses,
        creditsEarned: credits,
        coursesPassed: count,
        satisfied:
          credits >= rule.minCredits &&
          count >= rule.minCourses &&
          outstanding.length === 0,
        outstanding,
        counted: used,
      }
    })

    const total = curriculum?.totalCredits ?? null
    return {
      studentId,
      studentName: student.name ?? null,
      programCode: chosen.programCode,
      programName: chosen.programName,
      catalogYear: curriculum?.catalogYear ?? null,
      totalCredits: total,
      creditsEarned,
      creditsRemaining: total === null ? null : Math.max(0, total - creditsEarned),
      cgpa,
      complete:
        audited.every((r) => r.satisfied) && total !== null && creditsEarned >= total,
      requirements: audited,
      overrides,
      note: null,
    }
  })
}
