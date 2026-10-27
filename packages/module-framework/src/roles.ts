import type { Role } from './types'

/**
 * The role groups every module used to define for itself (CQ-01): "admin" alone
 * was spelled out in more than fifteen places, and the copies had drifted. A
 * route's `roles` and an operation's own check now name the same group, so the
 * two cannot disagree by accident.
 *
 * Every role in the enum, in its order. `pending` is in the list because it is
 * a value a session can carry; no group below admits it, and the host refuses
 * it on every route (decision 192).
 */
export const ROLES: readonly Role[] = [
  'super_admin',
  'institution_admin',
  'hod',
  'faculty',
  'accounts_staff',
  'library_staff',
  'hostel_staff',
  'student',
  'parent',
  'pending',
]

/** Runs the institution. A school's head is its administrator. */
export const ADMIN: readonly Role[] = ['institution_admin', 'super_admin']
/** The accounts office: money in and out. */
export const OFFICE: readonly Role[] = [...ADMIN, 'accounts_staff']
/** Teaches, or heads those who do. */
export const TEACHING: readonly Role[] = [...ADMIN, 'hod', 'faculty']
/** The library desk. */
export const LIBRARY: readonly Role[] = [...ADMIN, 'library_staff']
/** The hostel office. */
export const HOSTEL: readonly Role[] = [...ADMIN, 'hostel_staff']
/** Everyone employed: every role but students, parents and pending accounts. */
export const STAFF: readonly Role[] = [
  ...ADMIN,
  'hod',
  'faculty',
  'accounts_staff',
  'library_staff',
  'hostel_staff',
]
/** Every approved member of the institution, staff, students and parents. */
export const MEMBERS: readonly Role[] = [...STAFF, 'student', 'parent']

export const hasRole = (role: Role, group: readonly Role[]): boolean => group.includes(role)
