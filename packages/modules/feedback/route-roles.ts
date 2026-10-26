import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /forms': [...ADMIN, 'hod'],
  'POST /forms': [...ADMIN, 'hod'],
  'GET /form': [...ADMIN, 'hod'],
  'POST /forms/publish': [...ADMIN, 'hod'],
  'POST /forms/retire': [...ADMIN, 'hod'],
  'POST /questions': [...ADMIN, 'hod'],
  'POST /questions/scale': [...ADMIN, 'hod'],
  'POST /questions/remove': [...ADMIN, 'hod'],
  'GET /windows': [...ADMIN, 'hod'],
  'POST /windows': [...ADMIN, 'hod'],
  'GET /window': [...ADMIN, 'hod'],
  'POST /windows/publish': [...ADMIN, 'hod'],
  'POST /windows/withdraw': [...ADMIN, 'hod'],
  'GET /class': TEACHING,
  'GET /results': TEACHING,
  'GET /me': ['student'],
  'GET /give': ['student'],
  'POST /give': ['student'],
  'GET /completion': [...TEACHING, 'student'],
}
