import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /profiles': [...STAFF, 'student'],
  'GET /events': [...STAFF, 'student'],
  'GET /registrations': [...STAFF, 'student'],
  'POST /profiles': ADMIN,
  'POST /profiles/consent': [...STAFF, 'student'],
  'POST /events': ADMIN,
  'POST /events/transition': ADMIN,
  'POST /registrations': [...STAFF, 'student'],
  'POST /registrations/cancel': [...STAFF, 'student'],
}
