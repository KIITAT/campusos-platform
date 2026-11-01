import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; each operation keeps its own check, because page
 * loaders call it in-process. A new route without an entry here fails at load.
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /settings': STAFF,
  'GET /pipeline': STAFF,
  'GET /leads/detail': STAFF,
  'POST /stages': ADMIN,
  'POST /stages/update': ADMIN,
  'POST /lost-reasons': ADMIN,
  'POST /lost-reasons/archive': ADMIN,
  'POST /teams': ADMIN,
  'POST /teams/members': ADMIN,
  'POST /teams/members/remove': ADMIN,
  'POST /leads': STAFF,
  'POST /leads/update': STAFF,
  'POST /leads/qualify': STAFF,
  'POST /leads/stage': STAFF,
  'POST /leads/assign': STAFF,
  'POST /leads/won': STAFF,
  'POST /leads/lost': STAFF,
  'POST /leads/reopen': STAFF,
  'POST /activities': STAFF,
  'POST /activities/done': STAFF,
}
