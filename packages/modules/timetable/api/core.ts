import type { withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'

/**
 * Who may do what, and how a refusal reads.
 *
 * The office (institution and super admins) builds the timetable. A head of
 * department reads all of it. A teacher reads their own, and says when they
 * cannot teach.
 */

export interface Actor {
  id: string
  role: Role
  institutionId: string | null
  email?: string | null
}

export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export class TimetableError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export const OFFICE: Role[] = ['institution_admin', 'super_admin']
export const READERS: Role[] = ['institution_admin', 'super_admin', 'hod']
export const TEACHERS: Role[] = ['faculty', 'hod']

export function tenantOf(actor: Actor): string {
  if (!actor.institutionId) throw new TimetableError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
export function requireOffice(actor: Actor): string {
  const t = tenantOf(actor)
  if (!OFFICE.includes(actor.role)) throw new TimetableError(403, 'forbidden', 'only the office builds the timetable')
  return t
}
export function requireReader(actor: Actor): string {
  const t = tenantOf(actor)
  if (!READERS.includes(actor.role)) throw new TimetableError(403, 'forbidden', 'not permitted')
  return t
}
/** Anybody who teaches, or the office. */
export function requireTeacherOrOffice(actor: Actor): string {
  const t = tenantOf(actor)
  if (!READERS.includes(actor.role) && !TEACHERS.includes(actor.role)) throw new TimetableError(403, 'forbidden', 'not permitted')
  return t
}

const REFUSALS: Record<string, [400 | 409, string]> = {
  timetable_periods_identity: [409, 'that day already has a period with that number'],
  timetable_periods_no_overlap: [409, 'that period overlaps another on the same day'],
  timetable_periods_times: [400, 'a period ends after it starts'],
  timetable_eligibility_identity: [409, 'that teacher is already eligible for exactly that'],
  timetable_eligibility_names_something: [400, 'say what they may teach: a course, a department, a programme or a year'],
  timetable_needs_identity: [409, 'that class already has a need of that kind'],
  timetable_needs_periods: [400, 'periods a week must be a whole number of blocks'],
  timetable_runs_one_applied: [409, 'another timetable was applied to this term at the same moment'],
  timetable_unavailable_one: [400, 'name one teacher, room or cohort'],
  timetable_pins_something: [400, 'pin a teacher, a time, or both'],
  timetable_pins_time: [400, 'a pinned time needs both a day and a period'],
  academic_slots_room_no_overlap: [409, 'a room would be double-booked: something else was timetabled meanwhile'],
}

/** Database refusals, named for the person who caused them. */
export async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof TimetableError) throw e
    const cause = (e as { cause?: { constraint?: string; code?: string; message?: string } }).cause
    const constraint = cause?.constraint
    const known = constraint ? REFUSALS[constraint] : undefined
    if (known) throw new TimetableError(known[0], constraint!, known[1])
    if (cause?.code === '23P01') {
      throw new TimetableError(409, 'clash', cause.message ?? 'a teacher or a room would be double-booked')
    }
    if (cause?.code === '23503') throw new TimetableError(400, 'no_such_reference', 'something it names does not exist')
    if (cause?.code === '23514') throw new TimetableError(400, constraint ?? 'invalid', 'that is not allowed')
    throw e
  }
}

export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "09:00:00" -> "09:00". */
export const hm = (t: string) => t.slice(0, 5)
export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/**
 * A cohort's year of study in a term: admitted in 2025, a term starting in
 * August 2026 is their second year when the year turns over in July.
 */
export function yearOfStudy(admissionYear: number, termStartsOn: string, yearStartsMonth: number): number {
  const year = Number(termStartsOn.slice(0, 4))
  const month = Number(termStartsOn.slice(5, 7))
  return Math.max(1, year - admissionYear + (month >= yearStartsMonth ? 1 : 0))
}
