import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /assignments': [...ADMIN, 'hod'],
  'POST /assign': [...ADMIN, 'hod'],
  'POST /assignments/end': [...ADMIN, 'hod'],
  'GET /mentees': TEACHING,
  'GET /mentee': TEACHING,
  'POST /notes': TEACHING,
  'POST /messages': [...TEACHING, 'student'],
  'GET /leave-types': [...TEACHING, 'student'],
  'POST /leave-types': [...ADMIN, 'hod'],
  'POST /leave-types/retire': [...ADMIN, 'hod'],
  'POST /leave': ['student'],
  'GET /leave/pending': TEACHING,
  'POST /leave/decide': TEACHING,
  'POST /leave/cancel': ['student'],
  'GET /leave/document.pdf': [...TEACHING, 'student'],
  'GET /me': ['student'],
}
