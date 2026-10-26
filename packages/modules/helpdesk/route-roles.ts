import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /cases': [...STAFF, 'student'],
  'GET /cases/detail': [...STAFF, 'student'],
  'POST /cases': [...STAFF, 'student'],
  'POST /cases/assign': ADMIN,
  'POST /cases/messages': [...STAFF, 'student'],
  'POST /cases/resolve': [...STAFF, 'student'],
  'POST /cases/reopen': [...STAFF, 'student'],
}
