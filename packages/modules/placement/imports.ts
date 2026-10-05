import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { companies } from './schema'
import { createCompany } from './api/operations'

/**
 * The recruiters a placement office already works with. Only an administrator
 * or an appointed placement officer may import, as with the form.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)

export const imports: ImportSpec[] = [
  {
    id: 'companies',
    title: 'Companies',
    note: 'One row per employer. A company already listed under the same name is left as it is.',
    roles: ['institution_admin', 'super_admin', 'faculty', 'hod'],
    columns: [
      { name: 'name', required: true, note: 'The company’s name', example: 'Tata Consultancy Services' },
      { name: 'website', note: 'Optional; must start with https://', example: 'https://www.tcs.com' },
    ],
    row: async (actor, { values: v }) => {
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: companies.id }).from(companies).where(sql`lower(${companies.name}) = ${v.name!.toLowerCase()}`))
      if (existing) return 'skipped'
      await createCompany(actor, { name: v.name, website: blank(v.website) })
      return 'created'
    },
  },
]
