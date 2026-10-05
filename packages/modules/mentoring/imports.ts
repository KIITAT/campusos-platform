import { sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { assignMentor } from './api'

/**
 * Who mentors whom, for a whole intake at once. A student given a different
 * mentor here moves to them from today; the earlier assignment stays in the
 * history. A row that changes nothing is left as it is.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const STAFF = ['faculty', 'hod', 'institution_admin', 'super_admin']

const personByEmail = async (actor: PluginActor, email: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: users.id, role: users.role }).from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`))
  if (!row) throw new Error(`nobody here has the email ${email}`)
  return row
}

export const imports: ImportSpec[] = [
  {
    id: 'assignments',
    title: 'Mentor assignments',
    note: 'One row per student and their mentor, with a co-mentor if there is one.',
    roles: ['institution_admin', 'super_admin', 'hod'],
    columns: [
      { name: 'student_email', required: true, note: 'The student’s email address', example: 'aarav@college.edu' },
      { name: 'mentor_email', required: true, note: 'The mentor’s email address', example: 'rao@college.edu' },
      { name: 'co_mentor_email', note: 'Optional', example: '' },
      { name: 'reason', note: 'Optional, kept in the history', example: 'First-year allocation' },
    ],
    row: async (actor, { values: v }) => {
      const student = await personByEmail(actor, v.student_email!)
      if (student.role !== 'student') throw new Error(`${v.student_email} is not a student`)
      const mentor = await personByEmail(actor, v.mentor_email!)
      if (!STAFF.includes(mentor.role)) throw new Error(`${v.mentor_email} is not teaching staff`)
      const coMentor = v.co_mentor_email ? await personByEmail(actor, v.co_mentor_email) : undefined
      if (coMentor && !STAFF.includes(coMentor.role)) throw new Error(`${v.co_mentor_email} is not teaching staff`)
      const result = (await assignMentor(actor, { studentIds: [student.id], mentorId: mentor.id, coMentorId: coMentor?.id, reason: v.reason || undefined })) as { assigned: number }
      return result.assigned ? 'created' : 'skipped'
    },
  },
]
