import { ADMIN, MEMBERS, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; each operation also rechecks the record (D852),
 * because a role is only the way in.
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /files': MEMBERS,
  'GET /file': MEMBERS,
  'GET /receipt.pdf': MEMBERS,
  'POST /verify': MEMBERS,
  'POST /upload': ADMIN,
  'POST /request': ADMIN,
  'POST /sign': MEMBERS,
  'POST /close': MEMBERS,
}
