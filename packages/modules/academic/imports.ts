import { and, eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { courses, departments, offerings, programs, rooms, sectionMembers, sections, studentPrograms, terms } from './schema'
import {
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createTerm,
  declareProgram,
} from './api'

/**
 * What an institution loads from a spreadsheet when it starts: its structure,
 * its catalogue, its cohorts and who is in them. Every row goes through the
 * operation the admin screens use. A row naming something that is already
 * here -- a department code, a term, a student already in the section -- is
 * left as it is, so the same file can be uploaded twice.
 */

const ADMIN = ['institution_admin', 'super_admin'] as const
const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)
const upper = (v: string) => v.trim().toUpperCase()

async function one<T>(actor: PluginActor, query: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T[]>): Promise<T | undefined> {
  const [row] = await withTenant(tenantOf(actor), query)
  return row
}

const departmentId = async (actor: PluginActor, code: string) => {
  const row = await one(actor, (tx) => tx.select({ id: departments.id }).from(departments).where(eq(departments.code, upper(code))))
  if (!row) throw new Error(`no department ${upper(code)}`)
  return row.id
}
const programId = async (actor: PluginActor, code: string) => {
  const row = await one(actor, (tx) => tx.select({ id: programs.id }).from(programs).where(eq(programs.code, upper(code))))
  if (!row) throw new Error(`no programme ${upper(code)}`)
  return row.id
}
const termId = async (actor: PluginActor, code: string) => {
  const row = await one(actor, (tx) => tx.select({ id: terms.id }).from(terms).where(eq(terms.code, upper(code))))
  if (!row) throw new Error(`no term ${upper(code)}`)
  return row.id
}
const courseId = async (actor: PluginActor, code: string) => {
  const row = await one(actor, (tx) => tx.select({ id: courses.id }).from(courses).where(eq(courses.code, upper(code))))
  if (!row) throw new Error(`no course ${upper(code)}`)
  return row.id
}
const sectionId = async (actor: PluginActor, program: string, year: string, label: string) => {
  const pid = await programId(actor, program)
  const row = await one(actor, (tx) =>
    tx.select({ id: sections.id }).from(sections).where(and(eq(sections.programId, pid), eq(sections.admissionYear, Number(year)), eq(sections.label, upper(label)))),
  )
  if (!row) throw new Error(`no section ${upper(program)} ${year} ${upper(label)}`)
  return row.id
}
const personByEmail = async (actor: PluginActor, email: string) => {
  const row = await one(actor, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`),
  )
  if (!row) throw new Error(`nobody here has the email ${email}; import them under Administration, Import people`)
  return row
}

const cohortColumns = [
  { name: 'program', required: true, note: 'The programme code', example: 'BTCS' },
  { name: 'admission_year', required: true, note: 'The year the cohort was admitted', example: '2025' },
  { name: 'section', required: true, note: 'The section label', example: 'A' },
]

export const imports: ImportSpec[] = [
  {
    id: 'departments',
    title: 'Departments',
    note: 'One row per department.',
    roles: [...ADMIN],
    columns: [
      { name: 'code', required: true, note: 'Short code, unique here', example: 'CSE' },
      { name: 'name', required: true, note: 'The full name', example: 'Computer Science and Engineering' },
    ],
    row: async (actor, { values: v }) => {
      if (await one(actor, (tx) => tx.select({ id: departments.id }).from(departments).where(eq(departments.code, upper(v.code!))))) return 'skipped'
      await createDepartment(actor, { code: v.code, name: v.name })
      return 'created'
    },
  },
  {
    id: 'programs',
    title: 'Programmes',
    note: 'One row per programme, in a department already imported.',
    roles: [...ADMIN],
    columns: [
      { name: 'code', required: true, note: 'Short code, unique here', example: 'BTCS' },
      { name: 'name', required: true, note: 'The full name', example: 'B.Tech Computer Science' },
      { name: 'department', required: true, note: 'The department code', example: 'CSE' },
      { name: 'level', required: true, note: 'certificate, diploma, undergraduate, postgraduate or doctoral', example: 'undergraduate' },
      { name: 'duration_terms', required: true, note: 'Terms to complete it', example: '8' },
    ],
    row: async (actor, { values: v }) => {
      if (await one(actor, (tx) => tx.select({ id: programs.id }).from(programs).where(eq(programs.code, upper(v.code!))))) return 'skipped'
      await createProgram(actor, { code: v.code, name: v.name, departmentId: await departmentId(actor, v.department!), level: v.level!.toLowerCase(), durationTerms: v.duration_terms })
      return 'created'
    },
  },
  {
    id: 'courses',
    title: 'Courses',
    note: 'The catalogue: one row per course.',
    roles: [...ADMIN],
    columns: [
      { name: 'code', required: true, note: 'Course code, unique here', example: 'CS101' },
      { name: 'title', required: true, note: 'The course title', example: 'Programming Fundamentals' },
      { name: 'department', required: true, note: 'The department code', example: 'CSE' },
      { name: 'credits', required: true, note: 'Credits, 0 to 30', example: '4' },
    ],
    row: async (actor, { values: v }) => {
      if (await one(actor, (tx) => tx.select({ id: courses.id }).from(courses).where(eq(courses.code, upper(v.code!))))) return 'skipped'
      await createCourse(actor, { code: v.code, title: v.title, departmentId: await departmentId(actor, v.department!), credits: v.credits })
      return 'created'
    },
  },
  {
    id: 'terms',
    title: 'Terms',
    note: 'One row per term. Dates are YYYY-MM-DD; the registration and drop dates may be left blank and set later.',
    roles: [...ADMIN],
    columns: [
      { name: 'code', required: true, note: 'Short code, unique here', example: 'AUT2026' },
      { name: 'name', required: true, note: 'The name people see', example: 'Autumn 2026' },
      { name: 'starts_on', required: true, note: 'First day', example: '2026-07-20' },
      { name: 'ends_on', required: true, note: 'Last day', example: '2026-12-05' },
      { name: 'kind', note: 'regular, summer or winter; blank is regular', example: 'regular' },
      { name: 'registration_opens_on', note: 'Optional', example: '2026-07-01' },
      { name: 'registration_closes_on', note: 'Optional', example: '2026-07-18' },
      { name: 'add_drop_ends_on', note: 'Optional', example: '2026-08-03' },
      { name: 'withdraw_ends_on', note: 'Optional', example: '2026-10-15' },
    ],
    row: async (actor, { values: v }) => {
      if (await one(actor, (tx) => tx.select({ id: terms.id }).from(terms).where(eq(terms.code, upper(v.code!))))) return 'skipped'
      await createTerm(actor, {
        code: v.code, name: v.name, startsOn: v.starts_on, endsOn: v.ends_on, kind: blank(v.kind?.toLowerCase()),
        registrationOpensOn: blank(v.registration_opens_on), registrationClosesOn: blank(v.registration_closes_on),
        addDropEndsOn: blank(v.add_drop_ends_on), withdrawEndsOn: blank(v.withdraw_ends_on),
      })
      return 'created'
    },
  },
  {
    id: 'rooms',
    title: 'Rooms',
    note: 'Classrooms, labs and halls: one row per room.',
    roles: [...ADMIN],
    columns: [
      { name: 'code', required: true, note: 'Room code, unique here', example: 'CR-101' },
      { name: 'building', note: 'Optional', example: 'Main block' },
      { name: 'capacity', note: 'Seats; optional', example: '60' },
    ],
    row: async (actor, { values: v }) => {
      if (await one(actor, (tx) => tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.code, upper(v.code!))))) return 'skipped'
      await createRoom(actor, { code: v.code, building: blank(v.building), capacity: blank(v.capacity) })
      return 'created'
    },
  },
  {
    id: 'sections',
    title: 'Sections',
    note: 'Cohorts: one row per section of a programme’s intake.',
    roles: [...ADMIN],
    columns: [
      { name: 'program', required: true, note: 'The programme code', example: 'BTCS' },
      { name: 'admission_year', required: true, note: 'The year the cohort was admitted', example: '2025' },
      { name: 'label', required: true, note: 'The section label', example: 'A' },
    ],
    row: async (actor, { values: v }) => {
      const pid = await programId(actor, v.program!)
      const year = Number(v.admission_year)
      if (Number.isInteger(year) && (await one(actor, (tx) => tx.select({ id: sections.id }).from(sections).where(and(eq(sections.programId, pid), eq(sections.admissionYear, year), eq(sections.label, upper(v.label!))))))) return 'skipped'
      await createSection(actor, { programId: pid, admissionYear: v.admission_year, label: v.label })
      return 'created'
    },
  },
  {
    id: 'section-members',
    title: 'Students into sections',
    note: 'One row per student and the section they belong to. The student must already have an account.',
    roles: [...ADMIN],
    columns: [{ name: 'email', required: true, note: 'The student’s email address', example: 'aarav@college.edu' }, ...cohortColumns],
    row: async (actor, { values: v }) => {
      const person = await personByEmail(actor, v.email!)
      const sid = await sectionId(actor, v.program!, v.admission_year!, v.section!)
      if (await one(actor, (tx) => tx.select({ id: sectionMembers.userId }).from(sectionMembers).where(and(eq(sectionMembers.sectionId, sid), eq(sectionMembers.userId, person.id))))) return 'skipped'
      await addSectionMember(actor, { sectionId: sid, userId: person.id })
      return 'created'
    },
  },
  {
    id: 'student-programs',
    title: 'Students into programmes',
    note: 'Declares which programme each student is studying: what their degree audit and eligibility are read against.',
    roles: [...ADMIN],
    columns: [
      { name: 'email', required: true, note: 'The student’s email address', example: 'aarav@college.edu' },
      { name: 'program', required: true, note: 'The programme code', example: 'BTCS' },
      { name: 'declared_on', note: 'YYYY-MM-DD; blank is today', example: '2025-07-21' },
      { name: 'primary', note: 'yes or no; blank is yes', example: 'yes' },
    ],
    row: async (actor, { values: v }) => {
      const person = await personByEmail(actor, v.email!)
      const pid = await programId(actor, v.program!)
      const active = await one(actor, (tx) =>
        tx.select({ id: studentPrograms.id }).from(studentPrograms).where(and(eq(studentPrograms.studentId, person.id), eq(studentPrograms.programId, pid), eq(studentPrograms.status, 'active'))),
      )
      if (active) return 'skipped'
      const primary = v.primary ? ['yes', 'y', 'true', '1'].includes(v.primary.toLowerCase()) : true
      await declareProgram(actor, { studentId: person.id, programId: pid, isPrimary: primary, declaredOn: blank(v.declared_on) })
      return 'created'
    },
  },
  {
    id: 'offerings',
    title: 'Class offerings',
    note: 'Which course each section takes in a term, and who teaches it. The teacher may be left blank and assigned later, or by the timetable.',
    roles: [...ADMIN],
    columns: [
      { name: 'term', required: true, note: 'The term code', example: 'AUT2026' },
      { name: 'course', required: true, note: 'The course code', example: 'CS101' },
      ...cohortColumns,
      { name: 'teacher_email', note: 'Optional: the teacher’s email address', example: 'rao@college.edu' },
    ],
    row: async (actor, { values: v }) => {
      const tid = await termId(actor, v.term!)
      const cid = await courseId(actor, v.course!)
      const sid = await sectionId(actor, v.program!, v.admission_year!, v.section!)
      const teacher = v.teacher_email ? await personByEmail(actor, v.teacher_email) : null
      if (teacher && !['faculty', 'hod', 'institution_admin', 'super_admin'].includes(teacher.role)) throw new Error(`${v.teacher_email} is not teaching staff`)
      const existing = await one(actor, (tx) =>
        tx.select({ id: offerings.id }).from(offerings).where(and(eq(offerings.termId, tid), eq(offerings.courseId, cid), eq(offerings.sectionId, sid))),
      )
      if (existing) return 'skipped'
      await createOffering(actor, { termId: tid, courseId: cid, sectionId: sid, facultyUserId: teacher?.id ?? null })
      return 'created'
    },
  },
]
