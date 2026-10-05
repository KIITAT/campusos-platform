import { eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { staff } from './schema'
import { createStaff } from './api'

/**
 * The staff register, from the spreadsheet HR keeps today. A row whose
 * employee code is already here is left as it is. When a login exists at the
 * same email address the record is joined to it, so the person sees their own
 * leave and payslips; otherwise it can be joined later.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)

export const imports: ImportSpec[] = [
  {
    id: 'staff',
    title: 'Staff',
    note: 'One row per member of staff. Grades, pay and leave are set up on each record afterwards.',
    roles: ['institution_admin', 'super_admin'],
    columns: [
      { name: 'employee_code', required: true, note: 'Unique here', example: 'EMP-0042' },
      { name: 'name', required: true, note: 'Full name', example: 'Dr Anita Rao' },
      { name: 'designation', required: true, note: 'Job title', example: 'Assistant Professor' },
      { name: 'department', note: 'Optional, as written on the record', example: 'Computer Science' },
      { name: 'employment', note: 'permanent, contract, visiting or probation; blank is permanent', example: 'permanent' },
      { name: 'joined_on', required: true, note: 'YYYY-MM-DD', example: '2019-07-01' },
      { name: 'email', note: 'Work email; joins the record to the login at that address', example: 'rao@college.edu' },
      { name: 'phone', note: 'Optional', example: '+91 98765 43210' },
    ],
    row: async (actor, { values: v }) => {
      const tenant = tenantOf(actor)
      const [existing] = await withTenant(tenant, (tx) => tx.select({ id: staff.id }).from(staff).where(eq(staff.employeeCode, v.employee_code!)))
      if (existing) return 'skipped'
      let userId: string | undefined
      if (v.email) {
        const [login] = await withTenant(tenant, (tx) => tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${v.email!.toLowerCase()}`))
        if (login) {
          const [taken] = await withTenant(tenant, (tx) => tx.select({ code: staff.employeeCode }).from(staff).where(eq(staff.userId, login.id)))
          if (taken) throw new Error(`${v.email} already has staff record ${taken.code}`)
          userId = login.id
        }
      }
      await createStaff(actor, {
        employeeCode: v.employee_code, name: v.name, designation: v.designation, department: blank(v.department),
        employment: blank(v.employment?.toLowerCase()), joinedOn: v.joined_on, email: blank(v.email), phone: blank(v.phone), userId,
      })
      return 'created'
    },
  },
]
