import { ADMIN, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /enquiries': ADMIN,
  'GET /applications': ADMIN,
  'POST /enquiries': ADMIN,
  'POST /applications': ADMIN,
  'POST /applications/decision': ADMIN,
  'POST /applications/accept': ADMIN,
}
