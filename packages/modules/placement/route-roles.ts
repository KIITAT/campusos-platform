import { ADMIN, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /workspace': [...ADMIN, 'student'],
  'GET /statistics': ADMIN,
  'POST /officers': ADMIN,
  'POST /companies': ADMIN,
  'POST /drives': ADMIN,
  'POST /drives/state': ADMIN,
  'POST /apply': ['student'],
  'POST /withdraw': ['student'],
  'POST /rounds': ADMIN,
  'POST /results': ADMIN,
  'POST /offers': ADMIN,
  'POST /offers/respond': ['student'],
}
