import { MEMBERS, STAFF, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /board': MEMBERS,
  'POST /board': STAFF,
  'POST /board/publish': STAFF,
  'POST /board/withdraw': STAFF,
  'POST /board/email': STAFF,
  'GET /board/notice': MEMBERS,
  'POST /board/attachments': STAFF,
  'POST /board/attachments/remove': STAFF,
  'GET /board/attachment': MEMBERS,
  'GET /inbox': MEMBERS,
  'POST /inbox': MEMBERS,
}
