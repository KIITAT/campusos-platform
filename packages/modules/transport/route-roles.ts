import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /vehicles': ADMIN,
  'GET /routes': [...STAFF, 'student'],
  'GET /stops': [...STAFF, 'student'],
  'GET /assignments': [...STAFF, 'student'],
  'POST /vehicles': ADMIN,
  'POST /routes': ADMIN,
  'POST /stops': ADMIN,
  'POST /assignments': ADMIN,
  'POST /assignments/release': ADMIN,
}
