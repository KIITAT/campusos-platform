import { and, eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { courses, offerings, programs, sections, terms } from '@campusos/module-academic/schema'
import { examMarks, exams } from './schema'
import { enterMarks } from './api'

/**
 * Marks from the spreadsheet a teacher already keeps. Each row is one
 * student's mark in one exam, entered through the same operation as the marks
 * screen: a lecturer may only enter marks for their own classes, nothing above
 * the exam's maximum, and nothing once results are published -- a published
 * mark changes only by a revision with a reason.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const upper = (v: string) => v.trim().toUpperCase()

async function examFor(actor: PluginActor, v: Record<string, string>) {
  const rows = await withTenant(tenantOf(actor), (tx) =>
    tx
      .select({ id: exams.id, section: sections.label, program: programs.code, year: sections.admissionYear })
      .from(exams)
      .innerJoin(offerings, eq(offerings.id, exams.offeringId))
      .innerJoin(terms, eq(terms.id, offerings.termId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .where(and(eq(terms.code, upper(v.term!)), eq(courses.code, upper(v.course!)), sql`lower(${exams.name}) = ${v.exam!.trim().toLowerCase()}`)),
  )
  const matching = rows.filter(
    (r) =>
      (!v.program || r.program === upper(v.program)) &&
      (!v.admission_year || r.year === Number(v.admission_year)) &&
      (!v.section || r.section === upper(v.section)),
  )
  if (matching.length === 0) throw new Error(`no exam "${v.exam}" in ${upper(v.course!)} for ${upper(v.term!)}${v.section ? ` section ${upper(v.section)}` : ''}`)
  if (matching.length > 1) throw new Error(`${upper(v.course!)} has "${v.exam}" in several sections this term: give program, admission_year and section`)
  return matching[0]!.id
}

export const imports: ImportSpec[] = [
  {
    id: 'marks',
    title: 'Exam marks',
    note: 'One row per student per exam. The exam must already be set up for the class. Leave marks blank and write yes under absent for a student who did not sit it.',
    roles: ['faculty', 'hod', 'institution_admin', 'super_admin'],
    columns: [
      { name: 'term', required: true, note: 'The term code', example: 'AUT2026' },
      { name: 'course', required: true, note: 'The course code', example: 'CS101' },
      { name: 'exam', required: true, note: 'The exam’s name, as set up', example: 'Mid-semester' },
      { name: 'program', note: 'Only when the course is taught to several sections this term', example: 'BTCS' },
      { name: 'admission_year', note: 'Likewise', example: '2025' },
      { name: 'section', note: 'Likewise', example: 'A' },
      { name: 'email', required: true, note: 'The student’s email address', example: 'aarav@college.edu' },
      { name: 'marks', note: 'Marks obtained; blank to fill in later', example: '42.5' },
      { name: 'absent', note: 'yes for a student who did not sit it', example: '' },
    ],
    row: async (actor, { values: v }) => {
      const examId = await examFor(actor, v)
      const [student] = await withTenant(tenantOf(actor), (tx) =>
        tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${v.email!.toLowerCase()}`),
      )
      if (!student) throw new Error(`nobody here has the email ${v.email}`)
      const absent = ['yes', 'y', 'true', '1', 'absent', 'ab'].includes((v.absent ?? '').toLowerCase())
      if (!absent && v.marks && !/^\d+(\.\d+)?$/.test(v.marks)) throw new Error(`marks "${v.marks}" is not a number`)
      const [before] = await withTenant(tenantOf(actor), (tx) =>
        tx.select({ id: examMarks.id }).from(examMarks).where(and(eq(examMarks.examId, examId), eq(examMarks.studentId, student.id))),
      )
      await enterMarks(actor, { examId, marks: [{ studentId: student.id, obtained: absent || !v.marks ? null : Number(v.marks), absent }] })
      return before ? 'updated' : 'created'
    },
  },
]
