import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import {
  programs,
  sectionMembers,
  sections,
  studentPrograms,
  terms,
} from '@campusos/module-academic/schema'
import { feeInvoices, feePayments, studentCharges } from '../schema'

/**
 * Who is billed for a term, and for which programmes (ACC-19, decision 189).
 *
 * Fees follow the student's programme declarations, not section membership. A
 * section is a teaching cohort: nobody leaves one when they withdraw, an
 * elective puts a student in another programme's section, and an admitted
 * student may not be in one yet. A declaration is the record of what the
 * student reads, and it carries the dates they started and stopped.
 *
 * A declaration counts for a term when its dates overlap the term:
 *
 *   declared_on <= term ends  AND  (ended_on IS NULL OR ended_on > term starts)
 *   AND  (ended_on IS NULL OR ended_on > declared_on)
 *
 * The last clause drops a declaration ended the day it was made: a mistake
 * withdrawn at once, not a student who read the programme. So a student
 * withdrawn before the term is not billed for it, one who left
 * during it is (refund rules and drop credits handle the rest), and re-running
 * a past term next year gives the same roster. A school's class is a programme
 * until P1-13 decides otherwise; promotion ends one declaration and starts the
 * next, and the same rule bills the class the student is in.
 *
 * The one place the rule lives: the invoicing roster, the charges, the dues
 * report, scholarship assessment, the waiver check and the demand letter all
 * ask here, so they cannot disagree.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/** Declarations whose dates overlap the term, which the caller joins in as `terms`. */
const overlapsTerm = and(
  lte(studentPrograms.declaredOn, terms.endsOn),
  or(isNull(studentPrograms.endedOn), gt(studentPrograms.endedOn, terms.startsOn)),
  or(isNull(studentPrograms.endedOn), gt(studentPrograms.endedOn, studentPrograms.declaredOn)),
)

/** The programmes this student is enrolled in for this term, primary first. */
export async function enrolledPrograms(
  tx: Tx,
  studentId: string,
  termId: string,
): Promise<{ programId: string; code: string }[]> {
  const rows = await tx
    .select({ programId: studentPrograms.programId, code: programs.code, isPrimary: studentPrograms.isPrimary })
    .from(studentPrograms)
    .innerJoin(terms, eq(terms.id, termId))
    .innerJoin(programs, eq(programs.id, studentPrograms.programId))
    .where(and(eq(studentPrograms.studentId, studentId), overlapsTerm))
    .orderBy(desc(studentPrograms.isPrimary), asc(programs.code))
  const seen = new Set<string>()
  return rows.filter((r) => !seen.has(r.programId) && seen.add(r.programId))
}

/**
 * Everyone billed for a term: enrolled in it, or owing a charge of their own
 * for it -- a backlog paper sat after the programme ended is still billed.
 */
export async function termRoster(tx: Tx, termId: string, studentId?: string | null) {
  const enrolled = await tx
    .selectDistinct({ studentId: studentPrograms.studentId })
    .from(studentPrograms)
    .innerJoin(terms, eq(terms.id, termId))
    .where(and(overlapsTerm, studentId ? eq(studentPrograms.studentId, studentId) : undefined))
  const owing = await tx
    .selectDistinct({ studentId: studentCharges.studentId })
    .from(studentCharges)
    .where(
      and(
        eq(studentCharges.termId, termId),
        isNull(studentCharges.cancelledAt),
        studentId ? eq(studentCharges.studentId, studentId) : undefined,
      ),
    )
  return people(tx, [...enrolled, ...owing].map((r) => r.studentId))
}

/**
 * The dues report's roster: the term's roster, plus anyone the term has
 * already put money against -- invoiced, or paid -- so a student who left
 * owing stays on the defaulter list.
 */
export async function duesRoster(tx: Tx, termId: string) {
  const billed = await termRoster(tx, termId)
  const invoiced = await tx
    .selectDistinct({ studentId: feeInvoices.studentId })
    .from(feeInvoices)
    .where(eq(feeInvoices.termId, termId))
  const paid = await tx
    .selectDistinct({ studentId: feePayments.studentId })
    .from(feePayments)
    .where(eq(feePayments.termId, termId))
  return people(tx, [...billed.map((b) => b.studentId), ...invoiced.map((r) => r.studentId), ...paid.map((r) => r.studentId)])
}

async function people(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  return tx
    .select({ studentId: users.id, studentName: users.name, studentEmail: users.email })
    .from(users)
    .where(inArray(users.id, unique))
    .orderBy(asc(users.email))
}

/**
 * Students who sit in a section of a programme with charges this term, have
 * never been declared into that programme, and are enrolled in nothing else
 * this term. They are not billed, and the person issuing the term's charges is
 * told who they are: a forgotten declaration should be fixed, not silently go
 * unbilled. A student enrolled elsewhere and sitting in the section for an
 * elective is not one of them, and neither is one whose declaration ended.
 */
export async function notEnrolled(tx: Tx, termId: string, studentId?: string | null) {
  return tx
    .selectDistinct({
      studentId: sectionMembers.userId,
      studentName: users.name,
      studentEmail: users.email,
      programCode: programs.code,
    })
    .from(sectionMembers)
    .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
    .innerJoin(programs, eq(programs.id, sections.programId))
    .innerJoin(users, eq(users.id, sectionMembers.userId))
    .where(
      and(
        eq(users.role, 'student'),
        studentId ? eq(sectionMembers.userId, studentId) : undefined,
        // Plain SQL with table names: the outer row is named by its table,
        // never by a drizzle column (api-contracts' correlated-subquery guard).
        sql`exists (select 1 from fee_items f where f.program_id = academic_sections.program_id and f.term_id = ${termId})`,
        sql`not exists (
          select 1 from academic_student_programs sp
           where sp.student_id = academic_section_members.user_id and sp.program_id = academic_sections.program_id)`,
        sql`not exists (
          select 1 from academic_student_programs sp join academic_terms t on t.id = ${termId}
           where sp.student_id = academic_section_members.user_id
             and sp.declared_on <= t.ends_on and (sp.ended_on is null or sp.ended_on > t.starts_on)
             and (sp.ended_on is null or sp.ended_on > sp.declared_on))`,
      ),
    )
    .orderBy(asc(users.email), asc(programs.code))
}
