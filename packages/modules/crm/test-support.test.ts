import { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import type { Actor } from './api/core'

const created: string[] = []
after(async () => { if (created.length) await authDb.delete(institutions).where(inArray(institutions.id, created)) })
/** A fresh institution with an administrator, a manager, two reps, an outsider and an accounts clerk. */
export async function college() {
  const tag = 'crm-test-' + randomUUID()
  const [institution] = await authDb.insert(institutions).values({ name: 'Test company', slug: tag }).returning()
  created.push(institution!.id)
  const roles = ['institution_admin', 'faculty', 'faculty', 'faculty', 'faculty', 'accounts_staff'] as const
  const names = ['admin', 'manager', 'rep', 'rep2', 'outsider', 'clerk'] as const
  const people = await authDb.insert(users).values(roles.map((role, index) => ({ role, institutionId: institution!.id, email: names[index] + '@' + tag + '.test', name: 'Person ' + names[index] }))).returning()
  const actor = (index: number): Actor => ({ id: people[index]!.id, role: roles[index]!, institutionId: institution!.id, email: people[index]!.email })
  return { id: institution!.id, admin: actor(0), manager: actor(1), rep: actor(2), rep2: actor(3), outsider: actor(4), clerk: actor(5) }
}
export type College = Awaited<ReturnType<typeof college>>
