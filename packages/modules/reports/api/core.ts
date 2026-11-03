import { and, eq } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { ADMIN, STAFF, type PluginActor, type Role } from '@campusos/module-framework'
import { reports, type Report } from '../schema'
import { notAViewer, notPermitted, reportNotFound } from './errors'

export type Actor = PluginActor
export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
export { ADMIN, STAFF }

/** The role check every operation starts with (decision 442); returns the institution. */
export function tenant(actor: Actor, roles: readonly Role[]): string {
  if (!actor.institutionId || !roles.includes(actor.role)) throw notPermitted()
  return actor.institutionId
}

export const isAdmin = (actor: Actor) => ADMIN.includes(actor.role)

export const log = (tx: Tx, actor: Actor, action: string, entityId: string, detail: Record<string, unknown>) =>
  audit(tx, { institutionId: actor.institutionId!, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: 'reports', action, entity: 'report', entityId, reason: '', detail })

/** A report the actor's institution holds (row security hides other institutions' reports: 404). */
export async function loadReport(tx: Tx, institutionId: string, id: string, lock = false): Promise<Report> {
  const q = tx.select().from(reports).where(and(eq(reports.id, id), eq(reports.institutionId, institutionId)))
  const [r] = await (lock ? q.for('update') : q)
  if (!r) throw reportNotFound()
  return r
}

/** Administrators see every report; others the ones shared with their role (decision 442). */
export function mustView(actor: Actor, report: Report): void {
  if (!isAdmin(actor) && !report.viewerRoles.includes(actor.role)) throw notAViewer()
}
