import { audit, type withTenant } from '@campusos/db'
import type { Actor } from './operations'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * One audit event for a structural write (AUD-06), in the writing transaction
 * so the change and its evidence commit or roll back together. Details are
 * allowlists of IDs and saved values, never free text.
 */
export function auditAcademic(
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
    moduleId: 'academic',
    action,
    entity,
    entityId,
    reason,
    detail,
  })
}
