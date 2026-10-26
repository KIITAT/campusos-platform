import { ADMIN, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /links': ADMIN,
  'POST /links': [...ADMIN, 'parent'],
  'POST /links/decide': ADMIN,
  'POST /links/revoke': ADMIN,
  'GET /guardians': ADMIN,
  'POST /guardians/invite': ADMIN,
  'POST /guardians/withdraw': ADMIN,
  'GET /children': [...ADMIN, 'parent'],
  'GET /child': [...ADMIN, 'parent'],
}
