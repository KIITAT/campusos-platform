import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'POST /scan/signed': ['student'],
  'POST /devices/key': ['student'],
  'GET /devices/mine': ['student'],
  'POST /devices/revoke': [...ADMIN, 'student'],
  'GET /offline/policy': ADMIN,
  'POST /offline/policy': ADMIN,
  'POST /sessions/prepare': TEACHING,
  'POST /sessions/held': TEACHING,
  'POST /sessions/prepare/revoke': TEACHING,
  'GET /rules': [...TEACHING, 'student'],
  'POST /rules': ADMIN,
  'GET /excuses': [...TEACHING, 'student'],
  'POST /excuses': TEACHING,
  'POST /excuses/revoke': TEACHING,
  'GET /absentees': TEACHING,
  'GET /summary': [...TEACHING, 'student'],
  'GET /sessions': TEACHING,
  'POST /sessions': TEACHING,
  'POST /sessions/close': TEACHING,
  'GET /sessions/qr': TEACHING,
  'GET /sessions/roster': TEACHING,
  'POST /scan': ['student'],
  'POST /override': TEACHING,
  'GET /devices': ADMIN,
  'POST /devices': ['student'],
  'POST /devices/approve': ADMIN,
  'POST /geofences': ADMIN,
  'GET /me': ['student'],
}
