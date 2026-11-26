import { audit, type withTenant } from '@campusos/db'
import type { Actor } from './operations'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * One audit event for an attendance control change (AUD-06), written in the
 * changing transaction. Details are IDs and saved settings only: never a device
 * hash or key, a signature, a secret or a coordinate.
 */
export function auditAttendance(
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
    moduleId: 'attendance',
    action,
    entity,
    entityId,
    reason,
    detail,
  })
}
