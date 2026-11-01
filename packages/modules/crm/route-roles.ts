import { ADMIN, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; each operation keeps its own check, because page
 * loaders call it in-process. A new route without an entry here fails at load.
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /settings': STAFF,
  'POST /stages': ADMIN,
  'POST /stages/update': ADMIN,
  'POST /lost-reasons': ADMIN,
  'POST /lost-reasons/archive': ADMIN,
  'POST /teams': ADMIN,
  'POST /teams/members': ADMIN,
  'POST /teams/members/remove': ADMIN,
}
