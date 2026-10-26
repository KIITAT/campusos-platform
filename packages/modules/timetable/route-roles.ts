import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /settings': TEACHING,
  'POST /settings': ADMIN,
  'GET /periods': TEACHING,
  'POST /periods/generate': ADMIN,
  'POST /periods': ADMIN,
  'POST /periods/delete': ADMIN,
  'GET /rooms': [...ADMIN, 'hod'],
  'POST /rooms': ADMIN,
  'GET /sections': [...ADMIN, 'hod'],
  'POST /sections': ADMIN,
  'GET /teachers': [...ADMIN, 'hod'],
  'POST /teachers': ADMIN,
  'GET /eligibility': TEACHING,
  'POST /eligibility': ADMIN,
  'POST /eligibility/delete': ADMIN,
  'POST /eligibility/import': ADMIN,
  'GET /unavailable': TEACHING,
  'POST /unavailable': TEACHING,
  'POST /unavailable/delete': TEACHING,
  'GET /needs': [...ADMIN, 'hod'],
  'POST /needs': ADMIN,
  'POST /needs/delete': ADMIN,
  'POST /needs/defaults': ADMIN,
  'GET /pins': [...ADMIN, 'hod'],
  'POST /pins': ADMIN,
  'POST /pins/delete': ADMIN,
  'GET /check': [...ADMIN, 'hod'],
  'POST /runs': ADMIN,
  'GET /runs': [...ADMIN, 'hod'],
  'GET /runs/detail': [...ADMIN, 'hod'],
  'GET /runs/grid': [...ADMIN, 'hod'],
  'GET /runs/workload': [...ADMIN, 'hod'],
  'POST /runs/apply': ADMIN,
  'POST /runs/discard': ADMIN,
  'POST /runs/pin': ADMIN,
  'GET /runs/pdf': [...ADMIN, 'hod'],
  'GET /live': TEACHING,
  'GET /live/workload': [...ADMIN, 'hod'],
  'GET /live/pdf': TEACHING,
  'GET /my': TEACHING,
  'GET /my/pdf': TEACHING,
}
