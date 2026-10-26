import { HOSTEL, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /blocks': HOSTEL,
  'POST /blocks': HOSTEL,
  'GET /rooms': HOSTEL,
  'POST /rooms': HOSTEL,
  'POST /allocations': HOSTEL,
  'POST /allocations/vacate': HOSTEL,
  'POST /leave': HOSTEL,
  'GET /rollcall': HOSTEL,
  'GET /rollcall/qr': HOSTEL,
  'POST /rollcall/scan': [...HOSTEL, 'student'],
  'POST /rollcall/mark': HOSTEL,
  'GET /visitors': HOSTEL,
  'POST /visitors': HOSTEL,
  'POST /visitors/out': HOSTEL,
  'GET /me': [...HOSTEL, 'student'],
}
