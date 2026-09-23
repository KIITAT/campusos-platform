import type { withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'

/**
 * Who is asking, what goes wrong, and who is allowed to do it.
 *
 * Pulled out of operations.ts when HR stopped being one file: payroll, the
 * employment lifecycle, recruitment and the rest all need the same three
 * answers, and the alternative is either a circular import or four slightly
 * different copies of "is this person allowed".
 */

export const MODULE = 'hr'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class HrError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new HrError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** The HR desk: administration and the finance office that pays people. */
export const isHr = (r: Role) =>
  r === 'accounts_staff' || r === 'institution_admin' || r === 'super_admin'

/** Hiring, ending employment and setting pay are administrative decisions. */
export const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'

export const requireHr = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isHr(actor.role)) throw new HrError(403, 'forbidden', 'not permitted')
  return tenant
}

export const requireAdmin = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new HrError(403, 'forbidden', 'not permitted')
  return tenant
}

export const today = () => new Date().toISOString().slice(0, 10)

/** Inclusive day count between two ISO dates. */
export const spanDays = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  ) + 1

/** An ISO date shifted by whole days, still as an ISO date. */
export const shiftDays = (from: string, days: number) => {
  const d = new Date(`${from}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
