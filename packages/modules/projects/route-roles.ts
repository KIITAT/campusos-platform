import { OFFICE, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role before the handler runs; the
 * operation keeps its own check, because page loaders and other modules call it in-process. A new route
 * without an entry here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /projects': STAFF,
  'GET /projects/detail': STAFF,
  'POST /projects': OFFICE,
  'POST /projects/update': OFFICE,
  'POST /projects/status': OFFICE,
  'POST /members': STAFF,
  'POST /members/remove': STAFF,
  'POST /stages': STAFF,
  'POST /milestones': STAFF,
  'POST /milestones/reached': STAFF,
  'GET /tasks': STAFF,
  'POST /tasks': STAFF,
  'POST /tasks/update': STAFF,
  'GET /timesheets': STAFF,
  'POST /timesheets': STAFF,
  'POST /timesheets/update': STAFF,
  'POST /timesheets/delete': STAFF,
  'POST /timesheets/decide': STAFF,
  'POST /timesheets/reopen': STAFF,
  'GET /cost-rates': OFFICE,
  'POST /cost-rates': OFFICE,
  'GET /billings': OFFICE,
  'POST /billings': OFFICE,
  'GET /costings': OFFICE,
  'POST /costings': OFFICE,
  'POST /costings/reverse': OFFICE,
  'GET /profitability': OFFICE,
}
