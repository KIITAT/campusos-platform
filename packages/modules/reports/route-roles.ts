import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role before the handler runs; the
 * operation keeps its own check, because page loaders and other modules call it in-process. A new route
 * without an entry here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /datasets': ADMIN,
  'GET /reports': STAFF,
  'GET /reports/detail': STAFF,
  'POST /reports': ADMIN,
  'POST /reports/update': ADMIN,
  'POST /reports/archive': ADMIN,
  'POST /reports/run': STAFF,
  'GET /runs/csv': STAFF,
  'GET /reports/parquet': ADMIN,
  'GET /dashboard': STAFF,
}
