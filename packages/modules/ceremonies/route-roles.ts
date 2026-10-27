import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /ceremonies': [...ADMIN, 'hod'],
  'POST /ceremonies': ADMIN,
  'POST /ceremonies/status': ADMIN,
  'POST /ceremonies/eligibility': ADMIN,
  'GET /candidates': [...ADMIN, 'hod'],
  'GET /holds': [...ADMIN, 'hod'],
  'POST /holds': ADMIN,
  'POST /holds/clear': ADMIN,
  'POST /respond': ['student'],
  'POST /checkin': TEACHING,
  'GET /me': ['student'],
  'GET /certificates': [...ADMIN, 'hod'],
  'POST /certificates/issue': ADMIN,
  'POST /certificates/revoke': ADMIN,
  'POST /certificates/reissue': ADMIN,
  'GET /certificate': [...ADMIN, 'hod', 'student'],
  'GET /certificate.pdf': [...ADMIN, 'hod', 'student'],
  'GET /verify': TEACHING,
}
