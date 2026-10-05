import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { enquiries } from './schema'
import { addEnquiry } from './api'

/**
 * Enquiries gathered elsewhere -- a fair's sign-up sheet, a web form's
 * export -- brought in to be followed up. An address that already has an
 * enquiry is left as it is.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)

export const imports: ImportSpec[] = [
  {
    id: 'enquiries',
    title: 'Enquiries',
    note: 'One row per person who asked about admission.',
    roles: ['institution_admin', 'super_admin'],
    columns: [
      { name: 'name', required: true, note: 'Their name', example: 'Riya Kapoor' },
      { name: 'email', required: true, note: 'Their email address', example: 'riya.kapoor@example.com' },
      { name: 'phone', note: 'Optional', example: '+91 98450 12345' },
      { name: 'note', note: 'What they asked about', example: 'B.Tech CS, hostel needed' },
    ],
    row: async (actor, { values: v }) => {
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: enquiries.id }).from(enquiries).where(sql`lower(${enquiries.email}) = ${v.email!.toLowerCase()}`))
      if (existing) return 'skipped'
      await addEnquiry(actor, { name: v.name, email: v.email, phone: blank(v.phone), note: blank(v.note) })
      return 'created'
    },
  },
]
