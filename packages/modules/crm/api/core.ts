import { audit, type withTenant } from '@campusos/db'
import { ADMIN, STAFF, type PluginActor, type Role } from '@campusos/module-framework'

export type Actor = PluginActor
export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
export { ADMIN, STAFF }
export class CrmError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message) }
}
export function tenant(actor: Actor, roles: readonly Role[] = STAFF) {
  if (!actor.institutionId) throw new CrmError(400, 'no_institution', 'An institution is required.')
  if (!roles.includes(actor.role)) throw new CrmError(403, 'forbidden', 'Your role cannot perform this operation.')
  return actor.institutionId
}
export const log = (tx: Tx, actor: Actor, action: string, entityId: string, reason: string) =>
  audit(tx, { institutionId: actor.institutionId!, actorId: actor.id, actorEmail: actor.email, moduleId: 'crm', action, entity: 'crm', entityId, reason })

const UNIQUE: Record<string, [string, string]> = {
  crm_stages_name: ['stage_exists', 'A stage with this name already exists.'],
  crm_lost_reasons_name: ['reason_exists', 'A lost reason with this name already exists.'],
  crm_teams_name: ['team_exists', 'A team with this name already exists.'],
  crm_team_members_user: ['already_in_team', 'This person is already in a sales team.'],
  finance_parties_code: ['party_code_taken', 'A party with this code already exists. Choose another code.'],
}
/** Maps a database unique violation to a CrmError; anything else passes through. */
export function refuse(error: unknown): unknown {
  const e = error as { cause?: { constraint?: string; constraint_name?: string }; constraint?: string; constraint_name?: string }
  const name = e?.cause?.constraint ?? e?.cause?.constraint_name ?? e?.constraint ?? e?.constraint_name
  const hit = name ? UNIQUE[name] : undefined
  return hit ? new CrmError(409, hit[0], hit[1]) : error
}
