import { TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /courses': TEACHING,
  'GET /questions': TEACHING,
  'POST /questions': TEACHING,
  'POST /questions/revise': TEACHING,
  'POST /questions/retire': TEACHING,
  'GET /question': TEACHING,
  'GET /quizzes': TEACHING,
  'POST /quizzes': TEACHING,
  'POST /quizzes/update': TEACHING,
  'GET /quiz': TEACHING,
  'POST /quizzes/items': TEACHING,
  'POST /quizzes/items/remove': TEACHING,
  'POST /quizzes/publish': TEACHING,
  'POST /quizzes/withdraw': TEACHING,
  'POST /quizzes/revise': TEACHING,
  'POST /quizzes/extensions': TEACHING,
  'GET /me': ['student'],
  'POST /attempts/start': ['student'],
  'POST /attempts/answers': ['student'],
  'POST /attempts/submit': ['student'],
  'GET /attempt': [...TEACHING, 'student'],
  'POST /responses/override': TEACHING,
}
