import { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import type { Actor } from './api/core'

const created: string[] = []
after(async () => { if (created.length) await authDb.delete(institutions).where(inArray(institutions.id, created)) })
export async function college() {
  const tag = 'alumni-test-' + randomUUID()
  const [institution] = await authDb.insert(institutions).values({ name: 'Test college', slug: tag }).returning()
  created.push(institution!.id)
  const roles = ['institution_admin', 'faculty', 'student', 'student'] as const
  const people = await authDb.insert(users).values(roles.map((role, index) => ({ role, institutionId: institution!.id, email: index + '@' + tag + '.test', name: 'Person ' + index }))).returning()
  const actor = (index: number): Actor => ({ id: people[index]!.id, role: roles[index]!, institutionId: institution!.id, email: people[index]!.email })
  return { id: institution!.id, admin: actor(0), faculty: actor(1), student: actor(2), other: actor(3) }
}
