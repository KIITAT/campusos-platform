import { eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { profiles } from './schema'
import { saveProfile } from './api'

/**
 * Graduates' records, from the alumni office's register. Publishing a profile
 * stays the graduate's own decision: an imported profile is private until they
 * consent, whatever the spreadsheet says.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)

export const imports: ImportSpec[] = [
  {
    id: 'profiles',
    title: 'Alumni profiles',
    note: 'One row per graduate. They need an account at this institution to be found by email. A row for someone who already has a profile updates it.',
    roles: ['institution_admin', 'super_admin'],
    columns: [
      { name: 'email', required: true, note: 'Their account’s email address', example: 'kavya@college.edu' },
      { name: 'graduation_year', required: true, note: 'The year they graduated', example: '2024' },
      { name: 'qualification', required: true, note: 'What they graduated with', example: 'B.Tech Computer Science' },
      { name: 'employer', note: 'Optional', example: 'Infosys' },
      { name: 'contact_email', note: 'A personal address to reach them at, shown only if they agree', example: 'kavya.nair@example.com' },
    ],
    row: async (actor, { values: v }) => {
      const [person] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${v.email!.toLowerCase()}`))
      if (!person) throw new Error(`nobody here has the email ${v.email}`)
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, person.id)))
      await saveProfile(actor, { userId: person.id, graduationYear: v.graduation_year, qualification: v.qualification, employer: blank(v.employer), contactEmail: blank(v.contact_email) })
      return existing ? 'updated' : 'created'
    },
  },
]
