import { ADMIN, TEACHING, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'POST /departments': ADMIN,
  'POST /programs': ADMIN,
  'POST /courses': ADMIN,
  'POST /rooms': ADMIN,
  'POST /terms': ADMIN,
  'POST /terms/current': ADMIN,
  'POST /sections': ADMIN,
  'POST /sections/members': ADMIN,
  'POST /offerings': ADMIN,
  'POST /slots': ADMIN,
  'GET /timetable': [...TEACHING, 'student'],
  'POST /terms/calendar': ADMIN,
  'POST /curricula': ADMIN,
  'POST /requirements': ADMIN,
  'POST /prerequisites': ADMIN,
  'POST /prerequisites/waivers': ADMIN,
  'POST /equivalences': ADMIN,
  'POST /students/programs': ADMIN,
  'POST /students/programs/end': ADMIN,
  'POST /completions': ADMIN,
  'POST /eligibility': [...TEACHING, 'student'],
  'POST /completions/correct': ADMIN,
  'POST /degree-audit': [...TEACHING, 'student'],
  'POST /profile': ADMIN,
  'POST /classes/change': TEACHING,
  'POST /classes/change/withdraw': TEACHING,
  'GET /week': [...TEACHING, 'student'],
  'GET /profile': [...TEACHING, 'student'],
  'GET /curricula': [...ADMIN, 'hod'],
  'GET /prerequisites': [...ADMIN, 'hod'],
  'GET /prerequisites/waivers': ADMIN,
  'GET /students/programs': [...TEACHING, 'student'],
  'GET /completions': [...TEACHING, 'student'],
}
