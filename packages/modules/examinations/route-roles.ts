import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /exams': TEACHING,
  'POST /exams': TEACHING,
  'POST /exams/publish': TEACHING,
  'POST /exams/unpublish': ADMIN,
  'GET /marks': TEACHING,
  'POST /marks': TEACHING,
  'POST /marks/revise': TEACHING,
  'POST /finalise': ADMIN,
  'GET /scales': ADMIN,
  'GET /scales/programs': ADMIN,
  'POST /scales/programs': ADMIN,
  'POST /scales': ADMIN,
  'GET /transcript': [...TEACHING, 'student'],
  'GET /transcript/official': [...TEACHING, 'student'],
  'GET /transcript.pdf': [...TEACHING, 'student'],
  'GET /cycle/settings': TEACHING,
  'POST /cycle/settings': ADMIN,
  'GET /windows': TEACHING,
  'POST /windows': ADMIN,
  'GET /booking': ['student'],
  'POST /enrol': ['student'],
  'GET /enrolments': TEACHING,
  'POST /enrolments/cancel': ADMIN,
  'GET /admit-card.pdf': [...TEACHING, 'student'],
  'POST /backlogs': ['student'],
  'POST /backlogs/cancel': [...ADMIN, 'student'],
  'GET /backlogs': TEACHING,
  'GET /grade-report.pdf': [...TEACHING, 'student'],
  'POST /papers': TEACHING,
  'GET /papers': TEACHING,
  'GET /paper.pdf': ADMIN,
  'GET /stats': TEACHING,
  'GET /performance': [...TEACHING, 'student'],
}
