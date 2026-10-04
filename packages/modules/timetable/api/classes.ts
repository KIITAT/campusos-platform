import { asc, eq, inArray, sql } from 'drizzle-orm'
import { users } from '@campusos/db'
import { courses, offerings, programs, sections, terms } from '@campusos/module-academic/schema'
import { eligibility, needs, sectionPlans } from '../schema'
import { TimetableError, yearOfStudy, type Tx } from './core'
import { settingsWithin } from './setup'

/**
 * A term's classes as the solver sees them: each offering with its course,
 * cohort, year of study, size, current teacher, weekly needs, and the teachers
 * who may take it with how keen each is.
 *
 * Eligibility is matched here, once: a row matches a class when every one of
 * course, department, programme and year it names matches; a teacher's
 * preference for a class is the highest of their matching rows.
 */

export interface TermClass {
  offeringId: string
  courseId: string
  courseCode: string
  courseTitle: string
  credits: number
  departmentId: string
  sectionId: string
  sectionName: string
  programId: string
  programCode: string
  admissionYear: number
  yearOfStudy: number
  size: number
  facultyUserId: string | null
  facultyName: string | null
  needs: { id: string; kind: string; periodsPerWeek: number; blockLength: number; roomKind: string | null; roomId: string | null }[]
  candidates: { userId: string; preference: number }[]
}

export async function termWithin(tx: Tx, termId: string) {
  const [t] = await tx.select().from(terms).where(eq(terms.id, termId))
  if (!t) throw new TimetableError(404, 'no_such_term', 'no such term')
  return t
}

export async function termClasses(tx: Tx, institutionId: string, termId: string): Promise<TermClass[]> {
  const term = await termWithin(tx, termId)
  const s = await settingsWithin(tx, institutionId)
  const rows = await tx
    .select({
      offeringId: offerings.id,
      courseId: courses.id,
      courseCode: courses.code,
      courseTitle: courses.title,
      credits: courses.credits,
      departmentId: courses.departmentId,
      sectionId: sections.id,
      sectionLabel: sections.label,
      programId: programs.id,
      programCode: programs.code,
      admissionYear: sections.admissionYear,
      expectedSize: sectionPlans.expectedSize,
      members: sql<number>`(select count(*)::int from academic_section_members m where m.section_id = academic_sections.id)`,
      facultyUserId: offerings.facultyUserId,
      facultyName: users.name,
    })
    .from(offerings)
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .innerJoin(sections, eq(sections.id, offerings.sectionId))
    .innerJoin(programs, eq(programs.id, sections.programId))
    .leftJoin(sectionPlans, eq(sectionPlans.sectionId, sections.id))
    .leftJoin(users, eq(users.id, offerings.facultyUserId))
    .where(eq(offerings.termId, termId))
    .orderBy(asc(programs.code), asc(sections.admissionYear), asc(sections.label), asc(courses.code))
  if (rows.length === 0) return []
  const needRows = await tx
    .select()
    .from(needs)
    .where(inArray(needs.offeringId, rows.map((r) => r.offeringId)))
    .orderBy(asc(needs.kind))
  const rules = await tx.select().from(eligibility)
  return rows.map((r) => {
    const year = yearOfStudy(r.admissionYear, term.startsOn, s.yearStartsMonth)
    const best = new Map<string, number>()
    for (const e of rules) {
      if (e.courseId && e.courseId !== r.courseId) continue
      if (e.departmentId && e.departmentId !== r.departmentId) continue
      if (e.programId && e.programId !== r.programId) continue
      if (e.yearOfStudy && e.yearOfStudy !== year) continue
      best.set(e.userId, Math.max(best.get(e.userId) ?? 0, e.preference))
    }
    return {
      offeringId: r.offeringId,
      courseId: r.courseId,
      courseCode: r.courseCode,
      courseTitle: r.courseTitle,
      credits: r.credits,
      departmentId: r.departmentId,
      sectionId: r.sectionId,
      sectionName: `${r.programCode} ${r.admissionYear} ${r.sectionLabel}`,
      programId: r.programId,
      programCode: r.programCode,
      admissionYear: r.admissionYear,
      yearOfStudy: year,
      size: r.expectedSize ?? r.members,
      facultyUserId: r.facultyUserId,
      facultyName: r.facultyName,
      needs: needRows
        .filter((n) => n.offeringId === r.offeringId)
        .map((n) => ({ id: n.id, kind: n.kind, periodsPerWeek: n.periodsPerWeek, blockLength: n.blockLength, roomKind: n.roomKind, roomId: n.roomId })),
      candidates: [...best].map(([userId, preference]) => ({ userId, preference })).sort((a, b) => b.preference - a.preference || a.userId.localeCompare(b.userId)),
    }
  })
}

/**
 * Pairs of the term's sections that may not overlap: they share a student,
 * or one is part of the other (a batch and its section, at any depth).
 */
export async function sectionConflicts(tx: Tx, sectionIds: string[]): Promise<[string, string][]> {
  if (sectionIds.length < 2) return []
  const ids = sql.join(sectionIds.map((id) => sql`${id}::uuid`), sql`, `)
  const shared = await tx.execute(sql`
    select distinct a.section_id as a, b.section_id as b
      from academic_section_members a
      join academic_section_members b on b.user_id = a.user_id and b.section_id > a.section_id
     where a.section_id in (${ids}) and b.section_id in (${ids})`)
  const pairs = new Set<string>()
  const out: [string, string][] = []
  const add = (a: string, b: string) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (a === b || pairs.has(key)) return
    pairs.add(key)
    out.push(a < b ? [a, b] : [b, a])
  }
  for (const row of shared.rows as { a: string; b: string }[]) add(row.a, row.b)
  const plans = await tx.select({ id: sectionPlans.sectionId, parent: sectionPlans.parentSectionId }).from(sectionPlans)
  const parentOf = new Map(plans.map((p) => [p.id, p.parent]))
  for (const s of sectionIds) {
    let up = parentOf.get(s) ?? null
    for (let hops = 0; up && hops < 20; hops++) {
      add(s, up)
      up = parentOf.get(up) ?? null
    }
  }
  return out
}
