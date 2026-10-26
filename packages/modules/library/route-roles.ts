import { ADMIN, LIBRARY, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /titles': [...TEACHING, 'library_staff', 'student'],
  'POST /titles': LIBRARY,
  'GET /copies': [...TEACHING, 'library_staff', 'student'],
  'POST /copies': LIBRARY,
  'POST /copies/status': LIBRARY,
  'GET /loans': LIBRARY,
  'POST /loans/issue': LIBRARY,
  'POST /loans/return': LIBRARY,
  'POST /loans/renew': [...TEACHING, 'library_staff', 'student'],
  'POST /fines/waive': ADMIN,
  'POST /fines/settle': LIBRARY,
  'GET /status': [...TEACHING, 'library_staff', 'student'],
  'GET /overdue': LIBRARY,
  'GET /settings': LIBRARY,
  'PUT /settings': LIBRARY,
}
