import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /home': ['student'],
  'GET /instruments': ['student'],
  'GET /check': ['student'],
  'POST /checks': ['student'],
  'GET /result': [...STAFF, 'student'],
  'POST /results/delete': ['student'],
  'POST /requests': ['student'],
  'POST /requests/withdraw': ['student'],
  'POST /appointments/cancel': [...STAFF, 'student'],
  'GET /queue': STAFF,
  'GET /case': STAFF,
  'POST /requests/accept': STAFF,
  'POST /requests/handover': STAFF,
  'POST /requests/close': STAFF,
  'POST /appointments': STAFF,
  'POST /appointments/record': STAFF,
  'POST /notes': STAFF,
  'GET /statistics': ADMIN,
  'GET /settings': ADMIN,
  'POST /settings': ADMIN,
  'POST /counsellors': ADMIN,
  'POST /counsellors/active': ADMIN,
  'POST /instruments': ADMIN,
  'POST /instruments/retire': ADMIN,
}
