import { audit } from '@campusos/db'
import type { Actor, Tx } from './core'

/**
 * One audit event for a timetable control change (AUD-06), written in the
 * changing transaction. Details are the IDs and saved values of the change,
 * never free text such as notes or reasons.
 */
export function auditTimetable(
  tx: Tx,
  actor: Actor,
  tenant: string,
  action: string,
  entity: string,
  entityId: string,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  return audit(tx, {
    institutionId: tenant,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    moduleId: 'timetable',
    action,
    entity,
    entityId,
    reason,
    detail,
  })
}
