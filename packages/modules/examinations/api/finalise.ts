import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { postCompletionWithin } from '@campusos/module-academic/api'
import {
  courseCompletions,
  courses,
  institutions,
  offerings,
  programs,
  sections,
  studentPrograms,
  terms,
  users,
} from './joins'
import { examMarks, exams } from '../schema'
import { ExamError, schemeInForce, type Actor } from './operations'
import { finaliseCourseSchema, type Transcript } from './schemas'
import { gpa, gradeCourse } from './grading'

/**
 * Where marks stop being this module's business and become the record.
 *
 * Until a course is finalised, a grade is a derivation: every reader recomputes
 * it from weights and bands, and two readers on either side of a revision get
 * two answers. Finalising writes one row per student into the academic core's
 * completions -- the same table transfer credit lives in -- and from then on the
 * prerequisite check, the degree audit and the official transcript all read the
 * same number.
 *
 * It is deliberately re-runnable. A remark, a disputed paper, a script that
 * turns up in July: revise the mark through the audited path, finalise again,
 * and the completion is corrected with a reason attached and its revision
 * bumped. Nothing is deleted, and the audit log says who and why.
 */

const MODULE = 'examinations'

const num = (v: string | null) => (v === null ? null : Number(v))

export interface Finalised {
  offeringId: string
  courseCode: string
  created: number
  corrected: number
  unchanged: number
  /** Students whose course still has unmarked weight; nothing is posted for them. */
  incomplete: string[]
}

export async function finaliseCourse(actor: Actor, input: unknown): Promise<Finalised> {
  const tenant = actor.institutionId
  if (!tenant) throw new ExamError(400, 'no_institution', 'no institution for this session')
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') {
    // Deliberately narrower than entering marks: a lecturer grades their own
    // cohort, and the registrar decides when a grade becomes the record.
    throw new ExamError(403, 'forbidden', 'only the registrar finalises a course')
  }
  const data = finaliseCourseSchema.parse(input)

  return withTenant(tenant, async (tx): Promise<Finalised> => {
    const [offering] = await tx
      .select({
        id: offerings.id,
        termId: offerings.termId,
        courseId: offerings.courseId,
        courseCode: courses.code,
        courseTitle: courses.title,
        credits: courses.credits,
        programId: sections.programId,
      })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .where(eq(offerings.id, data.offeringId))
    if (!offering) throw new ExamError(404, 'no_such_offering', 'no such offering')

    // The scale the programme is graded on, which is not always the
    // institution's default.
    const scheme = await schemeInForce(tx, offering.programId)

    const published = await tx
      .select({
        id: exams.id,
        maxMarks: exams.maxMarks,
        weightPercent: exams.weightPercent,
      })
      .from(exams)
      .where(and(eq(exams.offeringId, data.offeringId), isNotNull(exams.publishedAt)))
    if (published.length === 0) {
      throw new ExamError(
        409,
        'nothing_published',
        'no results have been published for that course yet',
      )
    }

    // A course is finalised when all of it has been examined and published,
    // not when some of it has. Grading 40% of a course and calling the result a
    // grade is the fastest route to the dispute this module exists to prevent,
    // and unlike a single pending mark it is the registrar's problem rather
    // than one student's.
    const weight = published.reduce((n, e) => n + Number(e.weightPercent), 0)
    if (weight < 100) {
      throw new ExamError(
        409,
        'weight_incomplete',
        `only ${weight}% of that course has been published`,
      )
    }

    const marks = await tx
      .select({
        examId: examMarks.examId,
        studentId: examMarks.studentId,
        obtained: examMarks.obtained,
        absent: examMarks.absent,
      })
      .from(examMarks)
      .where(
        inArray(
          examMarks.examId,
          published.map((e) => e.id),
        ),
      )

    const students = [...new Set(marks.map((m) => m.studentId))]
    const out: Finalised = {
      offeringId: offering.id,
      courseCode: offering.courseCode,
      created: 0,
      corrected: 0,
      unchanged: 0,
      incomplete: [],
    }

    for (const studentId of students) {
      const results = published.map((e) => {
        const m = marks.find((x) => x.examId === e.id && x.studentId === studentId)
        return {
          examId: e.id,
          maxMarks: Number(e.maxMarks),
          weightPercent: Number(e.weightPercent),
          obtained: m ? num(m.obtained) : null,
          absent: m?.absent ?? false,
        }
      })

      const grade = gradeCourse(scheme.bands, offering.credits, results)
      if (!grade.complete) {
        // A partial total printed as a final grade is how a provisional mark
        // becomes a dispute. It stays out of the record until it is whole.
        out.incomplete.push(studentId)
        continue
      }

      const outcome = await postCompletionWithin(
        tx,
        tenant,
        actor.id,
        {
          studentId,
          courseId: offering.courseId,
          termId: offering.termId,
          credits: offering.credits,
          gradePoints: grade.points === null ? null : grade.points.toFixed(2),
          gradeLabel: grade.label,
          passed: grade.passed,
          note: `${offering.courseCode}, graded on ${scheme.name}`,
        },
        data.reason ?? `results finalised for ${offering.courseCode}`,
      )
      out[outcome] += 1
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'course.finalised',
      entity: 'academic_offerings',
      entityId: offering.id,
      reason: data.reason ?? `results finalised for ${offering.courseCode}`,
      detail: {
        courseCode: offering.courseCode,
        scheme: scheme.name,
        created: out.created,
        corrected: out.corrected,
        incomplete: out.incomplete.length,
      },
    })

    return out
  })
}

/**
 * The official transcript: what the record says, not what the marks currently
 * compute to.
 *
 * The difference matters on exactly the day it matters. `transcript()` recomputes
 * from live marks and is honest about being provisional -- useful to a student
 * halfway through a term, and the right thing to show a lecturer. This one
 * prints only finalised courses, transfer credit included, and its averages are
 * the ones the degree audit uses. Two documents, two purposes, and neither
 * pretending to be the other.
 */
export async function officialTranscript(
  actor: Actor,
  studentId: string,
): Promise<Transcript> {
  const tenant = actor.institutionId
  if (!tenant) throw new ExamError(400, 'no_institution', 'no institution for this session')
  const staff =
    actor.role === 'institution_admin' ||
    actor.role === 'super_admin' ||
    actor.role === 'hod' ||
    actor.role === 'faculty'
  if (!staff && actor.id !== studentId) {
    throw new ExamError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx): Promise<Transcript> => {
    const [student] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, studentId))
    if (!student) throw new ExamError(404, 'no_such_student', 'no such student')

    const [inst] = await tx
      .select({ name: institutions.name })
      .from(institutions)
      .where(eq(institutions.id, tenant))

    // The programme the transcript is issued against, which is also the one
    // whose grading scale it was graded on. The leading declaration when there
    // are two, because a transcript has one letterhead.
    const [declared] = await tx
      .select({ programId: programs.id, programCode: programs.code })
      .from(studentPrograms)
      .innerJoin(programs, eq(programs.id, studentPrograms.programId))
      .where(eq(studentPrograms.studentId, studentId))
      .orderBy(asc(studentPrograms.declaredOn))
      .limit(1)

    const scheme = await schemeInForce(tx, declared?.programId ?? null)

    const rows = await tx
      .select({
        courseCode: courses.code,
        courseTitle: courses.title,
        credits: courseCompletions.credits,
        gradePoints: courseCompletions.gradePoints,
        gradeLabel: courseCompletions.gradeLabel,
        passed: courseCompletions.passed,
        source: courseCompletions.source,
        termCode: terms.code,
        termName: terms.name,
        termStarts: terms.startsOn,
      })
      .from(courseCompletions)
      .innerJoin(courses, eq(courses.id, courseCompletions.courseId))
      .leftJoin(terms, eq(terms.id, courseCompletions.termId))
      .where(eq(courseCompletions.studentId, studentId))
      .orderBy(asc(terms.startsOn), asc(courses.code))

    const byTerm = new Map<string, Transcript['terms'][number]>()
    for (const r of rows) {
      // Transfer credit was not earned in one of our terms, and saying so is
      // the point -- it is on the degree and not in the average.
      const code = r.termCode ?? 'TRANSFER'
      const term =
        byTerm.get(code) ??
        {
          termCode: code,
          termName: r.termName ?? 'Accepted in transfer',
          grades: [],
          gpa: null,
          credits: 0,
        }
      term.grades.push({
        courseCode: r.courseCode,
        courseTitle: r.courseTitle,
        credits: r.credits,
        // The record keeps points and a label, not the percentage behind them:
        // a corrected grade is a corrected grade, and reprinting the arithmetic
        // invites a second argument about the same paper.
        percent: 0,
        complete: true,
        label: r.gradeLabel,
        points: r.gradePoints === null ? null : Number(r.gradePoints),
        passed: r.passed,
      })
      byTerm.set(code, term)
    }

    const shaped = [...byTerm.values()].map((t) => {
      const g = gpa(
        t.grades.map((x) => ({
          percent: x.percent,
          complete: true,
          label: x.label,
          points: x.points,
          passed: x.passed,
          credits: x.credits,
        })),
      )
      return { ...t, gpa: g.value, credits: g.credits }
    })

    const cumulative = gpa(
      shaped.flatMap((t) =>
        t.grades.map((x) => ({
          percent: x.percent,
          complete: true,
          label: x.label,
          points: x.points,
          passed: x.passed,
          credits: x.credits,
        })),
      ),
    )

    return {
      studentName: student.name,
      studentEmail: student.email,
      institutionName: inst?.name ?? '',
      programCode: declared?.programCode ?? null,
      schemeName: scheme.name,
      schemeKind: scheme.kind,
      terms: shaped,
      cumulativeGpa: cumulative.value,
      totalCredits: rows.filter((r) => r.passed).reduce((n, r) => n + r.credits, 0),
      // Nothing here is provisional: every line was finalised.
      provisional: false,
    }
  })
}
