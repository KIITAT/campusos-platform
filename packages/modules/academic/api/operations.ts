import { and, eq, inArray, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  courses,
  departments,
  offerings,
  programs,
  rooms,
  sectionMembers,
  sections,
  slots,
  terms,
} from '../schema'
import {
  addSectionMemberSchema,
  createCourseSchema,
  createDepartmentSchema,
  createOfferingSchema,
  createProgramSchema,
  createRoomSchema,
  createSectionSchema,
  createSlotSchema,
  createTermSchema,
  setCurrentTermSchema,
  setTermCalendarSchema,
  type Timetable,
} from './schemas'

/**
 * Every operation checks its own authorisation and runs inside withTenant(), so
 * cross-tenant access is prevented by RLS rather than by a WHERE clause any of
 * these could forget.
 */

export interface Actor {
  id: string
  role: Role
  institutionId: string | null
}

export class AcademicError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Structural writes are institution_admin only. The spec's role matrix gives
 * HOD oversight of a department -- timetable, faculty, analytics -- not the
 * right to create programmes or courses, so HOD is read-only here.
 */
export function requireWriter(actor: Actor): string {
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') {
    throw new AcademicError(403, 'forbidden', 'not permitted')
  }
  if (!actor.institutionId) {
    throw new AcademicError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

export function requireReader(actor: Actor): string {
  if (!actor.institutionId) {
    throw new AcademicError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** Postgres raises 23505 for an exclusion violation and 23505/23P01 for unique. */
export function rethrowConflict(e: unknown, code: string, message: string): never {
  const pg = (e as { cause?: { code?: string } }).cause?.code
  if (pg === '23505' || pg === '23P01' || pg === '23514') {
    throw new AcademicError(409, code, message)
  }
  throw e
}

// --- structure -------------------------------------------------------------

export async function createDepartment(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createDepartmentSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(departments)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'code_taken', `department ${data.code} exists`)
    return row
  })
}

export async function createProgram(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createProgramSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(programs)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'code_taken', `programme ${data.code} exists`)
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'programme rejected by a constraint'))
}

export async function createCourse(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createCourseSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(courses)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'code_taken', `course ${data.code} exists`)
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'course rejected by a constraint'))
}

export async function createRoom(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createRoomSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(rooms)
      .values({
        institutionId: tenant,
        code: data.code,
        building: data.building ?? null,
        capacity: data.capacity ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'code_taken', `room ${data.code} exists`)
    return row
  })
}

// --- terms -----------------------------------------------------------------

export async function createTerm(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createTermSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(terms)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'code_taken', `term ${data.code} exists`)
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'term rejected by a constraint'))
}

/**
 * Clears the previous current term in the same transaction as setting the new
 * one. The partial unique index makes two current terms impossible, so doing
 * these separately would fail rather than silently produce a second one.
 */
export async function setCurrentTerm(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const { termId } = setCurrentTermSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.update(terms).set({ isCurrent: false }).where(eq(terms.isCurrent, true))
    const [row] = await tx
      .update(terms)
      .set({ isCurrent: true })
      .where(eq(terms.id, termId))
      .returning({ id: terms.id })
    if (!row) throw new AcademicError(404, 'no_such_term', 'no such term')
  })
}

/**
 * The registration and drop dates, set once the committee has met. Kept apart
 * from createTerm because a term is usually created before its calendar is
 * agreed, and because this is the field enrollment and refunds read.
 */
export async function setTermCalendar(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const { termId, ...dates } = setTermCalendarSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .update(terms)
      .set({
        registrationOpensOn: dates.registrationOpensOn ?? null,
        registrationClosesOn: dates.registrationClosesOn ?? null,
        addDropEndsOn: dates.addDropEndsOn ?? null,
        withdrawEndsOn: dates.withdrawEndsOn ?? null,
      })
      .where(eq(terms.id, termId))
      .returning()
    if (!row) throw new AcademicError(404, 'no_such_term', 'no such term')
    return row
  }).catch((e) =>
    rethrowConflict(
      e,
      'invalid',
      'those dates fall outside the term, or run backwards',
    ),
  )
}

// --- cohorts ---------------------------------------------------------------

export async function createSection(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createSectionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(sections)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new AcademicError(409, 'exists', 'that cohort already exists')
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'cohort rejected by a constraint'))
}

export async function addSectionMember(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = addSectionMemberSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    // The user must be visible inside this tenant. RLS on users makes another
    // institution's student non-existent here, so this cannot enrol across
    // tenants even if an id from elsewhere is supplied.
    const [target] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, data.userId))
    if (!target) throw new AcademicError(404, 'no_such_user', 'no such user')
    if (target.role !== 'student') {
      throw new AcademicError(400, 'not_a_student', 'only students join a cohort')
    }

    await tx
      .insert(sectionMembers)
      .values({ institutionId: tenant, sectionId: data.sectionId, userId: data.userId })
      .onConflictDoNothing()
  })
}

// --- offerings and slots ---------------------------------------------------

export async function createOffering(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createOfferingSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(offerings)
      .values({
        institutionId: tenant,
        termId: data.termId,
        courseId: data.courseId,
        sectionId: data.sectionId,
        facultyUserId: data.facultyUserId ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new AcademicError(409, 'exists', 'that course is already offered to that cohort')
    }
    return row
  }).catch((e) => rethrowConflict(e, 'invalid', 'offering rejected by a constraint'))
}

export async function createSlot(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const data = createSlotSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(slots)
      .values({ institutionId: tenant, ...data })
      .returning()
    return row!
  }).catch((e) =>
    // The exclusion constraints named here are created in migration 0001.
    rethrowConflict(
      e,
      'clash',
      'that room or that lecturer is already booked in an overlapping slot',
    ),
  )
}

// --- reads -----------------------------------------------------------------

export async function listStructure(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => ({
    departments: await tx.select().from(departments).orderBy(departments.code),
    programs: await tx.select().from(programs).orderBy(programs.code),
    courses: await tx.select().from(courses).orderBy(courses.code),
    rooms: await tx.select().from(rooms).orderBy(rooms.code),
    terms: await tx.select().from(terms).orderBy(terms.startsOn),
  }))
}

export async function listSections(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: sections.id,
        label: sections.label,
        admissionYear: sections.admissionYear,
        programCode: programs.code,
        programName: programs.name,
        members: sql<number>`count(${sectionMembers.userId})`.mapWith(Number),
      })
      .from(sections)
      .innerJoin(programs, eq(programs.id, sections.programId))
      .leftJoin(sectionMembers, eq(sectionMembers.sectionId, sections.id))
      .groupBy(sections.id, programs.code, programs.name)
      .orderBy(programs.code, sections.admissionYear, sections.label),
  )
}

export async function listOfferings(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: offerings.id,
        courseCode: courses.code,
        courseTitle: courses.title,
        sectionLabel: sections.label,
        programCode: programs.code,
        termCode: terms.code,
        facultyName: users.name,
      })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .innerJoin(terms, eq(terms.id, offerings.termId))
      .leftJoin(users, eq(users.id, offerings.facultyUserId))
      .orderBy(terms.code, courses.code),
  )
}

/**
 * The weekly timetable, scoped by who is asking:
 *
 * - a student sees the slots of every cohort they belong to, electives included
 * - a lecturer sees what they teach
 * - an admin or HOD sees the whole institution
 *
 * Always the current term. Returns an empty timetable rather than an error when
 * no term is marked current, because "the registrar has not opened the semester
 * yet" is an ordinary state, not a fault.
 */
export async function getTimetable(actor: Actor): Promise<Timetable> {
  const tenant = requireReader(actor)

  return withTenant(tenant, async (tx): Promise<Timetable> => {
    const [term] = await tx
      .select({ id: terms.id, code: terms.code })
      .from(terms)
      .where(eq(terms.isCurrent, true))
      .limit(1)
    if (!term) return { termCode: null, entries: [] }

    const scope =
      actor.role === 'student'
        ? inArray(
            offerings.sectionId,
            tx
              .select({ id: sectionMembers.sectionId })
              .from(sectionMembers)
              .where(eq(sectionMembers.userId, actor.id)),
          )
        : actor.role === 'faculty'
          ? eq(offerings.facultyUserId, actor.id)
          : undefined

    const entries = await tx
      .select({
        slotId: slots.id,
        dayOfWeek: slots.dayOfWeek,
        startsAt: slots.startsAt,
        endsAt: slots.endsAt,
        courseCode: courses.code,
        courseTitle: courses.title,
        sectionLabel: sections.label,
        programCode: programs.code,
        roomCode: rooms.code,
        facultyName: users.name,
      })
      .from(slots)
      .innerJoin(offerings, eq(offerings.id, slots.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .innerJoin(rooms, eq(rooms.id, slots.roomId))
      .leftJoin(users, eq(users.id, offerings.facultyUserId))
      .where(and(eq(offerings.termId, term.id), scope))
      .orderBy(slots.dayOfWeek, slots.startsAt)

    return { termCode: term.code, entries }
  })
}
