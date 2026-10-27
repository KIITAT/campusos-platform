import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /frameworks': TEACHING,
  'POST /frameworks': ADMIN,
  'GET /framework': TEACHING,
  'POST /levels': ADMIN,
  'POST /skills': ADMIN,
  'POST /skills/retire': ADMIN,
  'GET /students': TEACHING,
  'GET /profile': [...TEACHING, 'student'],
  'GET /me': ['student'],
  'POST /assess': TEACHING,
  'POST /self-assess': ['student'],
  'GET /coverage': TEACHING,
}
