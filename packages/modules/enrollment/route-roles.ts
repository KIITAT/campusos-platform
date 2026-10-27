import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'POST /register': [...ADMIN, 'hod', 'student'],
  'POST /drop': [...ADMIN, 'hod', 'student'],
  'POST /seats': [...ADMIN, 'hod'],
  'GET /seats': [...ADMIN, 'hod'],
  'GET /roster': TEACHING,
  'GET /registrations': [...TEACHING, 'student'],
  'GET /credit-load': [...TEACHING, 'student'],
  'GET /events': [...ADMIN, 'hod', 'student'],
}
