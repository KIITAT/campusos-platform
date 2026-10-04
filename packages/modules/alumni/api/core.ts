import { eq } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import type { PluginActor, Role } from '@campusos/module-framework'

export type Actor = PluginActor
export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
export const ADMIN: Role[] = ['institution_admin', 'super_admin']
export const MEMBERS: Role[] = [...ADMIN, 'hod', 'faculty', 'student', 'accounts_staff', 'library_staff', 'hostel_staff']
export class DomainError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message) }
}
export function tenant(actor: Actor, roles: Role[] = MEMBERS) {
  if (!actor.institutionId) throw new DomainError(400, 'no_institution', 'An institution is required.')
  if (!roles.includes(actor.role)) throw new DomainError(403, 'forbidden', 'Your role cannot perform this operation.')
  return actor.institutionId
}
export async function person(tx: Tx, id: string, role?: Role) {
  const [user] = await tx.select().from(users).where(eq(users.id, id)).for('update')
  if (!user || user.erasedAt || (role && user.role !== role)) throw new DomainError(404, 'no_such_person', 'No matching person in this institution.')
  return user
}
export const log = (tx: Tx, actor: Actor, action: string, entityId: string, reason: string) => audit(tx, { institutionId: actor.institutionId!, actorId: actor.id, actorEmail: actor.email, moduleId: 'alumni', action, entity: 'alumni', entityId, reason })
