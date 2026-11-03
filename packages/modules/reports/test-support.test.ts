import { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import type { PluginActor, Role } from '@campusos/module-framework'

export type Actor = PluginActor & { institutionId: string; email: string; role: Role }
export type Fixture = Awaited<ReturnType<typeof fixture>>

const created: string[] = []
after(async () => { if (created.length) await authDb.delete(institutions).where(inArray(institutions.id, created)) })

/** An institution with the listed modules enabled, an administrator, an accounts clerk, a teacher and a student. */
export async function fixture(modules: string[] = ['finance', 'fees', 'hr', 'notices', 'reports']) {
  const slug = `reports-test-${randomUUID()}`
  const [institution] = await authDb.insert(institutions).values({ slug, name: 'Reports test college', allowedEmailDomains: [`${slug}.test`] }).returning()
  const id = institution!.id
  created.push(id)
  for (const m of modules) await authDb.execute(sql`insert into institution_modules (institution_id, module_id, enabled, enabled_at) values (${id}, ${m}, true, now()) on conflict (institution_id, module_id) do update set enabled = true`)
  const roles = ['institution_admin', 'accounts_staff', 'faculty', 'student'] as const
  const names = ['Admin', 'Clerk', 'Teacher', 'Student']
  const people = await authDb.insert(users).values(roles.map((role, i) => ({ role, institutionId: id, email: `${names[i]!.toLowerCase()}@${slug}.test`, name: names[i] }))).returning()
  const actor = (i: number): Actor => ({ id: people[i]!.id, role: roles[i]!, institutionId: id, email: people[i]!.email ?? '' })
  const [admin, clerk, teacher, student] = [0, 1, 2, 3].map(actor) as [Actor, Actor, Actor, Actor]
  return { id, admin, clerk, teacher, student }
}
