import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { audit, auditLog, users, withTenant } from '@campusos/db'
import { viewsOnBehalf, type Role, type ViewerScope } from '@campusos/module-framework'
import {
  courses,
  institutions,
  offerings,
  programs,
  sectionMembers,
  sections,
  terms,
} from './joins'
import { bands, examMarks, exams, schemePrograms, schemes } from '../schema'
import {
  createExamSchema,
  createSchemeSchema,
  enterMarksSchema,
  publishExamSchema,
  reviseMarkSchema,
  setProgramSchemeSchema,
  unpublishExamSchema,
  type Transcript,
} from './schemas'
import { DEFAULT_GPA_BANDS, gradeCourse, gpa, type Band } from './grading'

const MODULE = 'examinations'

export interface Actor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class ExamError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new ExamError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** Who may enter marks: the lecturer of the offering, and staff above. */
const canMark = (r: Role) =>
  r === 'faculty' || r === 'hod' || r === 'institution_admin' || r === 'super_admin'

const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'

const num = (v: string | null) => (v === null ? null : Number(v))

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * A lecturer may only touch their own offering. Checked in one place because
 * every write in this module needs it and forgetting it once would let any
 * lecturer grade any cohort.
 */
async function assertOwnsOffering(tx: Tx, actor: Actor, offeringId: string) {
  const [row] = await tx
    .select({ faculty: offerings.facultyUserId })
    .from(offerings)
    .where(eq(offerings.id, offeringId))
  if (!row) throw new ExamError(404, 'no_such_offering', 'no such offering')
  if (actor.role === 'faculty' && row.faculty !== actor.id) {
    throw new ExamError(403, 'not_your_offering', 'that is not your course')
  }
}

// --- grading schemes -------------------------------------------------------

export async function createScheme(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = createSchemeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    if (data.isDefault) {
      // The partial unique index permits one, so clear the old one first.
      await tx
        .update(schemes)
        .set({ isDefault: false })
        .where(eq(schemes.isDefault, true))
    }

    const [scheme] = await tx
      .insert(schemes)
      .values({
        institutionId: tenant,
        name: data.name,
        kind: data.kind,
        maxPoints: data.maxPoints?.toString() ?? null,
        isDefault: data.isDefault,
      })
      .onConflictDoNothing()
      .returning()
    if (!scheme) throw new ExamError(409, 'name_taken', `scheme ${data.name} exists`)

    if (data.bands.length) {
      await tx.insert(bands).values(
        data.bands.map((b) => ({
          institutionId: tenant,
          schemeId: scheme.id,
          minPercent: b.minPercent.toString(),
          label: b.label,
          points: b.points?.toString() ?? null,
          isPass: b.isPass,
        })),
      )
    }
    return scheme
  })
}

export async function listSchemes(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(schemes).orderBy(schemes.name)
    const all = rows.length
      ? await tx.select().from(bands).where(
          inArray(bands.schemeId, rows.map((r) => r.id)),
        )
      : []
    return rows.map((s) => ({
      ...s,
      bands: all
        .filter((b) => b.schemeId === s.id)
        .map((b) => ({
          minPercent: Number(b.minPercent),
          label: b.label,
          points: num(b.points),
          isPass: b.isPass,
        }))
        .sort((a, b) => b.minPercent - a.minPercent),
    }))
  })
}

/**
 * The scheme in force, for a programme if one is named and for the institution
 * otherwise. Falls back to a built-in 10-point scale rather than refusing to
 * grade: an institution that has not configured one still needs its transcripts
 * to say something, and the fallback is visible on the document.
 */
export async function schemeInForce(tx: Tx, programId?: string | null) {
  const [own] = programId
    ? await tx
        .select({ schemeId: schemePrograms.schemeId })
        .from(schemePrograms)
        .where(eq(schemePrograms.programId, programId))
        .limit(1)
    : []

  const [scheme] = own
    ? await tx.select().from(schemes).where(eq(schemes.id, own.schemeId)).limit(1)
    : await tx.select().from(schemes).where(eq(schemes.isDefault, true)).limit(1)
  if (!scheme) {
    return { name: 'Default 10-point scale', kind: 'gpa' as const, bands: DEFAULT_GPA_BANDS }
  }
  const rows = await tx.select().from(bands).where(eq(bands.schemeId, scheme.id))
  const list: Band[] = rows.map((b) => ({
    minPercent: Number(b.minPercent),
    label: b.label,
    points: num(b.points),
    isPass: b.isPass,
  }))
  return {
    name: scheme.name,
    kind: scheme.kind,
    bands: list.length ? list : DEFAULT_GPA_BANDS,
  }
}

/**
 * Point a programme at its own scale. Admin only: which scale a degree is
 * graded on is a regulation, not a lecturer's preference.
 */
export async function setProgramScheme(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = setProgramSchemeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [scheme] = await tx.select().from(schemes).where(eq(schemes.id, data.schemeId))
    if (!scheme) throw new ExamError(404, 'no_such_scheme', 'no such grading scheme')
    const [program] = await tx.select().from(programs).where(eq(programs.id, data.programId))
    if (!program) throw new ExamError(404, 'no_such_program', 'no such programme')

    await tx
      .insert(schemePrograms)
      .values({ institutionId: tenant, programId: data.programId, schemeId: data.schemeId })
      .onConflictDoUpdate({
        target: schemePrograms.programId,
        set: { schemeId: data.schemeId },
      })
  })
}

export async function listProgramSchemes(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        programId: schemePrograms.programId,
        programCode: programs.code,
        programName: programs.name,
        schemeId: schemePrograms.schemeId,
        schemeName: schemes.name,
        schemeKind: schemes.kind,
      })
      .from(schemePrograms)
      .innerJoin(programs, eq(programs.id, schemePrograms.programId))
      .innerJoin(schemes, eq(schemes.id, schemePrograms.schemeId))
      .orderBy(programs.code),
  )
}

// --- exams -----------------------------------------------------------------

export async function createExam(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = createExamSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    await assertOwnsOffering(tx, actor, data.offeringId)

    // Total weight across a course cannot exceed 100. Checked here rather than
    // by a constraint because it spans rows, and a lecturer adding a fifth quiz
    // should be told before the grades come out wrong.
    const existing = await tx
      .select({ weight: exams.weightPercent })
      .from(exams)
      .where(eq(exams.offeringId, data.offeringId))
    const total = existing.reduce((n, e) => n + Number(e.weight), 0) + data.weightPercent
    if (total > 100) {
      throw new ExamError(
        409,
        'weight_exceeded',
        `total weight would be ${total}% — reduce it to 100% or less`,
      )
    }

    const [row] = await tx
      .insert(exams)
      .values({
        institutionId: tenant,
        offeringId: data.offeringId,
        name: data.name,
        kind: data.kind,
        maxMarks: data.maxMarks.toString(),
        weightPercent: data.weightPercent.toString(),
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        roomId: data.roomId ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new ExamError(409, 'name_taken', `an exam called ${data.name} exists`)
    return row
  })
}

export async function listExams(actor: Actor, offeringId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select()
      .from(exams)
      .where(eq(exams.offeringId, offeringId))
      .orderBy(asc(exams.createdAt)),
  )
}

// --- marks -----------------------------------------------------------------

export async function enterMarks(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = enterMarksSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [exam] = await tx.select().from(exams).where(eq(exams.id, data.examId))
    if (!exam) throw new ExamError(404, 'no_such_exam', 'no such exam')
    await assertOwnsOffering(tx, actor, exam.offeringId)

    // Refused here with a usable message; the database trigger refuses it too,
    // which is what makes the guarantee rather than the convention.
    if (exam.publishedAt) {
      throw new ExamError(
        409,
        'published',
        'results are published — use a revision, which records a reason',
      )
    }

    const max = Number(exam.maxMarks)
    for (const m of data.marks) {
      if (m.obtained != null && m.obtained > max) {
        throw new ExamError(
          400,
          'above_max',
          `${m.obtained} exceeds the maximum of ${max} for this exam`,
        )
      }
    }

    // Only students in the cohort this offering is taught to.
    const [off] = await tx
      .select({ sectionId: offerings.sectionId })
      .from(offerings)
      .where(eq(offerings.id, exam.offeringId))
    const enrolled = new Set(
      (
        await tx
          .select({ id: sectionMembers.userId })
          .from(sectionMembers)
          .where(eq(sectionMembers.sectionId, off!.sectionId))
      ).map((r) => r.id),
    )
    const stranger = data.marks.find((m) => !enrolled.has(m.studentId))
    if (stranger) {
      throw new ExamError(404, 'not_enrolled', 'a listed student is not in this cohort')
    }

    for (const m of data.marks) {
      await tx
        .insert(examMarks)
        .values({
          institutionId: tenant,
          examId: data.examId,
          studentId: m.studentId,
          obtained: m.absent ? null : (m.obtained?.toString() ?? null),
          absent: m.absent,
          enteredBy: actor.id,
        })
        .onConflictDoUpdate({
          target: [examMarks.examId, examMarks.studentId],
          set: {
            obtained: m.absent ? null : (m.obtained?.toString() ?? null),
            absent: m.absent,
            enteredBy: actor.id,
            enteredAt: new Date(),
          },
        })
    }
  })
}

/**
 * Publishing is the lock. After this, every change to a mark under this exam
 * needs a reason, enforced by a trigger rather than by remembering to check.
 */
export async function publishExam(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const { examId } = publishExamSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [exam] = await tx.select().from(exams).where(eq(exams.id, examId))
    if (!exam) throw new ExamError(404, 'no_such_exam', 'no such exam')
    await assertOwnsOffering(tx, actor, exam.offeringId)
    if (exam.publishedAt) throw new ExamError(409, 'already_published', 'already published')

    await tx
      .update(exams)
      .set({ publishedAt: new Date(), publishedBy: actor.id })
      .where(eq(exams.id, examId))

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'exam.published',
      entity: 'exams',
      entityId: examId,
      reason: `results published for ${exam.name}`,
      detail: { examName: exam.name, offeringId: exam.offeringId },
    })
  })
}

/**
 * The only path that changes a published mark. audit() sets the reason the
 * trigger looks for, in the same transaction, so the audit row and the change
 * cannot come apart.
 */
export async function reviseMark(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = reviseMarkSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [exam] = await tx.select().from(exams).where(eq(exams.id, data.examId))
    if (!exam) throw new ExamError(404, 'no_such_exam', 'no such exam')
    await assertOwnsOffering(tx, actor, exam.offeringId)

    const max = Number(exam.maxMarks)
    if (data.obtained != null && data.obtained > max) {
      throw new ExamError(400, 'above_max', `${data.obtained} exceeds the maximum of ${max}`)
    }

    const [before] = await tx
      .select()
      .from(examMarks)
      .where(and(eq(examMarks.examId, data.examId), eq(examMarks.studentId, data.studentId)))
    if (!before) throw new ExamError(404, 'no_such_mark', 'no mark to revise')

    // Written first: it is what unlocks the row, and it means an aborted
    // transaction leaves neither the change nor a dangling audit entry.
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'mark.revised',
      entity: 'exam_marks',
      entityId: before.id,
      reason: data.reason,
      detail: {
        examName: exam.name,
        studentId: data.studentId,
        from: { obtained: num(before.obtained), absent: before.absent },
        to: { obtained: data.obtained ?? null, absent: data.absent },
        revision: before.revision + 1,
      },
    })

    await tx
      .update(examMarks)
      .set({
        obtained: data.absent ? null : (data.obtained?.toString() ?? null),
        absent: data.absent,
        enteredBy: actor.id,
        enteredAt: new Date(),
        revision: before.revision + 1,
      })
      .where(eq(examMarks.id, before.id))
  })
}

export async function unpublishExam(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = unpublishExamSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [exam] = await tx.select().from(exams).where(eq(exams.id, data.examId))
    if (!exam) throw new ExamError(404, 'no_such_exam', 'no such exam')
    if (!exam.publishedAt) throw new ExamError(409, 'not_published', 'not published')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'exam.unpublished',
      entity: 'exams',
      entityId: data.examId,
      reason: data.reason,
      detail: { examName: exam.name },
    })

    await tx
      .update(exams)
      .set({ publishedAt: null, publishedBy: null })
      .where(eq(exams.id, data.examId))
  })
}

/** The full history of one mark, which is what a dispute actually needs. */
export async function markHistory(actor: Actor, markId: string) {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')

  return withTenant(tenant, (tx) =>
    tx
      .select({
        at: auditLog.at,
        action: auditLog.action,
        reason: auditLog.reason,
        actorEmail: auditLog.actorEmail,
        detail: auditLog.detail,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'exam_marks'), eq(auditLog.entityId, markId)))
      .orderBy(asc(auditLog.at)),
  )
}

// --- grades and transcripts ------------------------------------------------

export async function sheet(actor: Actor, examId: string) {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')

  return withTenant(tenant, async (tx) => {
    const [exam] = await tx.select().from(exams).where(eq(exams.id, examId))
    if (!exam) throw new ExamError(404, 'no_such_exam', 'no such exam')
    await assertOwnsOffering(tx, actor, exam.offeringId)

    const [off] = await tx
      .select({ sectionId: offerings.sectionId })
      .from(offerings)
      .where(eq(offerings.id, exam.offeringId))

    const rows = await tx
      .select({
        studentId: sectionMembers.userId,
        name: users.name,
        email: users.email,
        markId: examMarks.id,
        obtained: examMarks.obtained,
        absent: examMarks.absent,
        revision: examMarks.revision,
      })
      .from(sectionMembers)
      .innerJoin(users, eq(users.id, sectionMembers.userId))
      .leftJoin(
        examMarks,
        and(eq(examMarks.studentId, sectionMembers.userId), eq(examMarks.examId, examId)),
      )
      .where(eq(sectionMembers.sectionId, off!.sectionId))
      .orderBy(users.email)

    return {
      exam: {
        id: exam.id,
        name: exam.name,
        kind: exam.kind,
        maxMarks: Number(exam.maxMarks),
        weightPercent: Number(exam.weightPercent),
        published: exam.publishedAt !== null,
      },
      entries: rows.map((r) => ({
        ...r,
        obtained: num(r.obtained),
        revision: r.revision ?? 0,
      })),
    }
  })
}

/**
 * A student's transcript. Grouped by term, because that is how it is read and
 * how a GPA is quoted.
 *
 * A student may read only their own; staff may read any within the institution.
 */
export async function transcript(actor: Actor, studentId: string): Promise<Transcript> {
  const tenant = tenantOf(actor)
  // A verified viewer -- a parent, via the Parent Portal -- reads exactly the
  // students they were cleared for, and nothing else changes for them.
  if (!viewsOnBehalf(actor, studentId)) {
    if (actor.role === 'student' && studentId !== actor.id) {
      throw new ExamError(403, 'forbidden', 'not permitted')
    }
    if (actor.role !== 'student' && !canMark(actor.role)) {
      throw new ExamError(403, 'forbidden', 'not permitted')
    }
  }

  return withTenant(tenant, async (tx): Promise<Transcript> => {
    const scheme = await schemeInForce(tx)

    const [student] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, studentId))
    if (!student) throw new ExamError(404, 'no_such_student', 'no such student')

    const [inst] = await tx
      .select({ name: institutions.name })
      .from(institutions)
      .where(eq(institutions.id, tenant))

    // Every offering this student's cohorts are taught, with its term.
    const rows = await tx
      .select({
        offeringId: offerings.id,
        courseCode: courses.code,
        courseTitle: courses.title,
        credits: courses.credits,
        termCode: terms.code,
        termName: terms.name,
        termStarts: terms.startsOn,
        programCode: programs.code,
      })
      .from(sectionMembers)
      .innerJoin(offerings, eq(offerings.sectionId, sectionMembers.sectionId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(terms, eq(terms.id, offerings.termId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .where(eq(sectionMembers.userId, studentId))
      .orderBy(asc(terms.startsOn), asc(courses.code))

    // Only published exams appear on a transcript. An unpublished mark is a
    // work in progress, and printing it as a grade is the fastest route to the
    // dispute this module exists to prevent.
    const marksRows = rows.length
      ? await tx
          .select({
            offeringId: exams.offeringId,
            examId: exams.id,
            maxMarks: exams.maxMarks,
            weightPercent: exams.weightPercent,
            obtained: examMarks.obtained,
            absent: examMarks.absent,
          })
          .from(exams)
          .leftJoin(
            examMarks,
            and(eq(examMarks.examId, exams.id), eq(examMarks.studentId, studentId)),
          )
          .where(
            and(
              inArray(exams.offeringId, rows.map((r) => r.offeringId)),
              isNotNull(exams.publishedAt),
            ),
          )
      : []

    const byTerm = new Map<string, Transcript['terms'][number]>()
    let provisional = false

    for (const r of rows) {
      const results = marksRows
        .filter((m) => m.offeringId === r.offeringId)
        .map((m) => ({
          examId: m.examId,
          maxMarks: Number(m.maxMarks),
          weightPercent: Number(m.weightPercent),
          obtained: num(m.obtained),
          absent: m.absent ?? false,
        }))

      // No published exam at all means the course is not yet on the transcript.
      if (results.length === 0) {
        provisional = true
        continue
      }

      const g = gradeCourse(scheme.bands, r.credits, results)
      if (!g.complete) provisional = true

      const term =
        byTerm.get(r.termCode) ??
        { termCode: r.termCode, termName: r.termName, grades: [], gpa: null, credits: 0 }
      term.grades.push({
        courseCode: r.courseCode,
        courseTitle: r.courseTitle,
        credits: r.credits,
        percent: g.percent,
        complete: g.complete,
        label: g.label,
        points: g.points,
        passed: g.passed,
      })
      byTerm.set(r.termCode, term)
    }

    const termList = [...byTerm.values()].map((t) => {
      const grades = t.grades.map((x) => ({
        percent: x.percent,
        complete: x.complete,
        label: x.label,
        points: x.points,
        passed: x.passed,
        credits: x.credits,
      }))
      const g = gpa(grades)
      return { ...t, gpa: g.value, credits: g.credits }
    })

    const all = termList.flatMap((t) =>
      t.grades.map((x) => ({
        percent: x.percent,
        complete: x.complete,
        label: x.label,
        points: x.points,
        passed: x.passed,
        credits: x.credits,
      })),
    )
    const cumulative = gpa(all)

    return {
      studentName: student.name,
      studentEmail: student.email,
      institutionName: inst?.name ?? '',
      programCode: rows[0]?.programCode ?? null,
      schemeName: scheme.name,
      schemeKind: scheme.kind,
      terms: termList,
      cumulativeGpa: cumulative.value,
      totalCredits: cumulative.credits,
      provisional,
    }
  })
}
