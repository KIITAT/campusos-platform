import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { assertCanAccessStudent, type Role } from '@campusos/module-framework'
import { checkEligibility } from '@campusos/module-academic/api'
import { courses, offerings, programs, sectionMembers, sections, terms } from '@campusos/module-academic/schema'
import { fedSections, offeringLimits, registrationEvents, registrations } from '../schema'
import {
  creditLoadQuerySchema,
  dropSchema,
  eventsQuerySchema,
  registerSchema,
  registrationsQuerySchema,
  rosterQuerySchema,
  sectionFeedSchema,
  setOfferingLimitSchema,
  type CreditLoad,
} from './schemas'

/**
 * Registration as it actually goes: a window that is open or is not, a chain
 * that has to be satisfied or waived, a seat that exists or does not, and a
 * queue behind it. Every change leaves a dated event, because the fee refund in
 * Student Financials is prorated against that date rather than against the fact
 * that a course is no longer on a list.
 *
 * Every operation checks its own authorisation and runs inside withTenant(), so
 * cross-tenant access is prevented by RLS rather than by a WHERE clause any of
 * these could forget.
 */

export interface Actor {
  id: string
  role: Role
  institutionId: string | null
  email?: string | null
}

export class EnrollmentError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

const STAFF: Role[] = ['institution_admin', 'super_admin', 'hod']

function requireStaff(actor: Actor): string {
  if (!STAFF.includes(actor.role)) {
    throw new EnrollmentError(403, 'forbidden', 'not permitted')
  }
  if (!actor.institutionId) {
    throw new EnrollmentError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

function requireMember(actor: Actor): string {
  if (!actor.institutionId) {
    throw new EnrollmentError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** Staff act for anyone; everyone else acts for themselves. */
function subjectOf(actor: Actor, asked: string | undefined): string {
  const staff = STAFF.includes(actor.role)
  if (!staff && asked && asked !== actor.id) {
    throw new EnrollmentError(403, 'forbidden', 'not permitted')
  }
  return staff ? (asked ?? actor.id) : actor.id
}

/** Faculty read a roster; they do not register anyone into it. */
function requireReader(actor: Actor, studentId: string): string {
  const tenant = requireMember(actor)
  if (!STAFF.includes(actor.role) && actor.role !== 'faculty' && actor.id !== studentId) {
    throw new EnrollmentError(403, 'forbidden', 'not permitted')
  }
  return tenant
}

const today = () => new Date().toISOString().slice(0, 10)

function rethrowConflict(e: unknown, code: string, message: string): never {
  const pg = (e as { cause?: { code?: string } }).cause?.code
  if (pg === '23505' || pg === '23514' || pg === '23P01') {
    throw new EnrollmentError(409, code, message)
  }
  throw e
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/** The offering, the course it teaches and the term's calendar, in one read. */
async function offeringDetail(tx: Tx, offeringId: string) {
  const [row] = await tx
    .select({
      id: offerings.id,
      termId: offerings.termId,
      courseId: offerings.courseId,
      sectionId: offerings.sectionId,
      courseCode: courses.code,
      courseTitle: courses.title,
      credits: courses.credits,
      registrationOpensOn: terms.registrationOpensOn,
      registrationClosesOn: terms.registrationClosesOn,
      addDropEndsOn: terms.addDropEndsOn,
      withdrawEndsOn: terms.withdrawEndsOn,
    })
    .from(offerings)
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .innerJoin(terms, eq(terms.id, offerings.termId))
    .where(eq(offerings.id, offeringId))
  if (!row) throw new EnrollmentError(404, 'no_such_offering', 'no such offering')
  return row
}

const MODULE = 'enrollment'

/** The section's mark, read under a shared lock that marking it takes exclusively (decision 704). */
async function followsRegistration(tx: Tx, sectionId: string): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'enrollment.section:' + sectionId}, 0))`)
  const [row] = await tx.select({ id: fedSections.sectionId }).from(fedSections).where(eq(fedSections.sectionId, sectionId))
  return row !== undefined
}

/** One student's place in one section changes under this lock, and only under it. */
async function lockMember(tx: Tx, sectionId: string, studentId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'enrollment.member:' + sectionId + ':' + studentId}, 0))`)
}

/** A registered student joins a section that follows registration. True when it does. */
async function joinSection(tx: Tx, tenant: string, sectionId: string, studentId: string): Promise<boolean> {
  if (!(await followsRegistration(tx, sectionId))) return false
  await lockMember(tx, sectionId, studentId)
  await tx.insert(sectionMembers).values({ institutionId: tenant, sectionId, userId: studentId }).onConflictDoNothing({ target: [sectionMembers.sectionId, sectionMembers.userId] })
  return true
}

/**
 * The student leaves the section, unless another registration in it still
 * holds them there. Called after the ended registration's status is written,
 * so it does not count itself. True when the membership was removed.
 */
async function leaveSection(tx: Tx, sectionId: string, studentId: string): Promise<boolean> {
  if (!(await followsRegistration(tx, sectionId))) return false
  await lockMember(tx, sectionId, studentId)
  const [still] = await tx
    .select({ id: registrations.id })
    .from(registrations)
    .innerJoin(offerings, eq(offerings.id, registrations.offeringId))
    .where(and(eq(registrations.studentId, studentId), eq(registrations.status, 'registered'), eq(offerings.sectionId, sectionId)))
    .limit(1)
  if (still) return false
  await tx.delete(sectionMembers).where(and(eq(sectionMembers.sectionId, sectionId), eq(sectionMembers.userId, studentId)))
  return true
}

// --- seats -----------------------------------------------------------------

export async function setOfferingLimit(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const data = setOfferingLimitSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await offeringDetail(tx, data.offeringId)
    const [row] = await tx
      .insert(offeringLimits)
      .values({
        institutionId: tenant,
        offeringId: data.offeringId,
        capacity: data.capacity,
        waitlistCapacity: data.waitlistCapacity,
      })
      .onConflictDoUpdate({
        target: offeringLimits.offeringId,
        set: { capacity: data.capacity, waitlistCapacity: data.waitlistCapacity },
      })
      .returning()
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'offering.limit_set',
      entity: 'enrollment_offering_limits',
      entityId: data.offeringId,
      reason: `capacity ${data.capacity}, waiting list ${data.waitlistCapacity}`,
      detail: { capacity: data.capacity, waitlistCapacity: data.waitlistCapacity },
    })
    return row!
  }).catch((e) =>
    // Lowering a cap below what is already taken is refused by the same trigger
    // that stops the seat being sold twice.
    rethrowConflict(e, 'invalid', 'that limit is not possible for this offering'),
  )
}

export async function listSeats(actor: Actor) {
  const tenant = requireMember(actor)
  return withTenant(tenant, async (tx) => {
    const limits = await tx
      .select({
        offeringId: offeringLimits.offeringId,
        capacity: offeringLimits.capacity,
        waitlistCapacity: offeringLimits.waitlistCapacity,
        courseCode: courses.code,
        courseTitle: courses.title,
      })
      .from(offeringLimits)
      .innerJoin(offerings, eq(offerings.id, offeringLimits.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .orderBy(courses.code)

    const counted = await tx
      .select({
        offeringId: registrations.offeringId,
        status: registrations.status,
        n: sql<number>`count(*)::int`,
      })
      .from(registrations)
      .groupBy(registrations.offeringId, registrations.status)

    const count = (offeringId: string, status: string) =>
      counted.find((c) => c.offeringId === offeringId && c.status === status)?.n ?? 0

    return limits.map((l) => ({
      ...l,
      taken: count(l.offeringId, 'registered'),
      queued: count(l.offeringId, 'waitlisted'),
      free: Math.max(0, l.capacity - count(l.offeringId, 'registered')),
    }))
  })
}

// --- registering -----------------------------------------------------------

/**
 * Four questions, in this order, because the order is the explanation a student
 * gets when the answer is no: is the window open, does the chain allow it, is
 * there a seat, and is there a queue.
 *
 * Staff may act outside the window -- somebody has to be able to fix a late
 * admission -- and the event records who did. Nobody, staff included, gets past
 * the prerequisite chain here: that is what a waiver in the academic core is
 * for, and it carries a reason and an approver.
 */
export async function register(actor: Actor, input: unknown) {
  const tenant = requireMember(actor)
  const data = registerSchema.parse(input)
  const studentId = subjectOf(actor, data.studentId)
  const staff = STAFF.includes(actor.role)
  const on = staff ? (data.effectiveOn ?? today()) : today()

  const detail = await withTenant(tenant, async (tx) => {
    const [student] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, studentId))
    if (!student) throw new EnrollmentError(404, 'no_such_user', 'no such user')
    if (student.role !== 'student') {
      throw new EnrollmentError(400, 'not_a_student', 'only students register for courses')
    }
    return offeringDetail(tx, data.offeringId)
  })

  const windowOpen =
    detail.registrationOpensOn !== null &&
    detail.registrationClosesOn !== null &&
    on >= detail.registrationOpensOn &&
    on <= detail.registrationClosesOn
  if (!windowOpen && !staff) {
    throw new EnrollmentError(
      409,
      'registration_closed',
      'registration for that term is not open',
    )
  }

  // Asked of the academic core rather than answered here: the chain, its
  // overrides and its cross-listings are the registrar's, and duplicating the
  // rule would be duplicating the part that goes stale.
  const eligibility = await checkEligibility(
    { id: actor.id, role: actor.role, institutionId: tenant },
    { studentId, courseId: detail.courseId },
  )
  if (!eligibility.eligible) {
    throw new EnrollmentError(
      409,
      'prerequisites_unmet',
      'the prerequisites for that course have not been met',
      eligibility.missing,
    )
  }

  return withTenant(tenant, async (tx) => {
    const [limit] = await tx
      .select({
        capacity: offeringLimits.capacity,
        waitlistCapacity: offeringLimits.waitlistCapacity,
      })
      .from(offeringLimits)
      .where(eq(offeringLimits.offeringId, data.offeringId))

    let status: 'registered' | 'waitlisted' = 'registered'
    if (limit) {
      const [taken] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(registrations)
        .where(
          and(
            eq(registrations.offeringId, data.offeringId),
            eq(registrations.status, 'registered'),
          ),
        )
      if ((taken?.n ?? 0) >= limit.capacity) {
        if (limit.waitlistCapacity === 0) {
          throw new EnrollmentError(409, 'full', 'that class is full')
        }
        status = 'waitlisted'
      }
    }

    const [existing] = await tx
      .select({ id: registrations.id, status: registrations.status })
      .from(registrations)
      .where(
        and(
          eq(registrations.studentId, studentId),
          eq(registrations.offeringId, data.offeringId),
        ),
      )

    if (existing && (existing.status === 'registered' || existing.status === 'waitlisted')) {
      throw new EnrollmentError(409, 'already_registered', 'already on this course')
    }

    // A student who drops and comes back is the same registration returning,
    // not a second one. Both moves stay in the event log.
    const row = existing
      ? (
          await tx
            .update(registrations)
            .set({ status, credits: detail.credits, registeredAt: new Date(), endedOn: null })
            .where(eq(registrations.id, existing.id))
            .returning()
        )[0]!
      : (
          await tx
            .insert(registrations)
            .values({
              institutionId: tenant,
              studentId,
              offeringId: data.offeringId,
              termId: detail.termId,
              status,
              credits: detail.credits,
            })
            .returning()
        )[0]!

    await tx.insert(registrationEvents).values({
      institutionId: tenant,
      registrationId: row.id,
      kind: status,
      effectiveOn: on,
      reason: data.reason ?? (windowOpen ? null : 'outside the registration window'),
      actorId: actor.id,
    })

    const joinedSection = status === 'registered' ? await joinSection(tx, tenant, detail.sectionId, studentId) : false
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: `registration.${status}`,
      entity: 'enrollment_registrations',
      entityId: row.id,
      reason:
        data.reason ??
        (windowOpen
          ? status === 'registered'
            ? 'registered for the course'
            : 'joined the waiting list'
          : 'outside the registration window'),
      detail: { studentId, offeringId: data.offeringId, effectiveOn: on, joinedSection },
    })

    return { ...row, courseCode: detail.courseCode, courseTitle: detail.courseTitle }
  }).catch((e) => rethrowConflict(e, 'full', 'that class filled while you were registering'))
}

/**
 * Leaving a course, by whichever of the two doors the calendar has open.
 *
 * Inside add/drop it is a drop and leaves no mark. After it, and up to the
 * withdrawal deadline, it is a withdrawal and the transcript says so. After
 * that there is no door: the course is graded.
 *
 * A term with no calendar has no deadline to be past, so a drop is a drop. That
 * is the honest reading of "nobody has set the dates yet", and it is why the
 * calendar is worth setting.
 */
export async function drop(actor: Actor, input: unknown) {
  const tenant = requireMember(actor)
  const data = dropSchema.parse(input)
  const studentId = subjectOf(actor, data.studentId)
  const staff = STAFF.includes(actor.role)
  const on = staff ? (data.effectiveOn ?? today()) : today()

  return withTenant(tenant, async (tx) => {
    const detail = await offeringDetail(tx, data.offeringId)

    const [row] = await tx
      .select({ id: registrations.id, status: registrations.status })
      .from(registrations)
      .where(
        and(
          eq(registrations.studentId, studentId),
          eq(registrations.offeringId, data.offeringId),
        ),
      )
    if (!row) throw new EnrollmentError(404, 'not_registered', 'not on that course')
    if (row.status !== 'registered' && row.status !== 'waitlisted') {
      throw new EnrollmentError(409, 'not_registered', 'that registration has already ended')
    }

    // Leaving a queue is never a withdrawal: nothing was ever attended.
    let kind: 'dropped' | 'withdrawn'
    if (row.status === 'waitlisted' || !detail.addDropEndsOn || on <= detail.addDropEndsOn) {
      kind = 'dropped'
    } else if (detail.withdrawEndsOn && on <= detail.withdrawEndsOn) {
      kind = 'withdrawn'
    } else {
      throw new EnrollmentError(
        409,
        'too_late',
        'the withdrawal deadline for that term has passed',
      )
    }

    const [ended] = await tx
      .update(registrations)
      .set({ status: kind, endedOn: on })
      .where(eq(registrations.id, row.id))
      .returning()

    await tx.insert(registrationEvents).values({
      institutionId: tenant,
      registrationId: row.id,
      kind,
      effectiveOn: on,
      reason: data.reason ?? null,
      actorId: actor.id,
    })

    // A queue place never made anyone a member, so leaving one removes nobody.
    const leftSection = row.status === 'registered' && (await leaveSection(tx, detail.sectionId, studentId))
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: `registration.${kind}`,
      entity: 'enrollment_registrations',
      entityId: row.id,
      reason: data.reason ?? (kind === 'dropped' ? 'dropped the course' : 'withdrew from the course'),
      detail: { studentId, offeringId: data.offeringId, effectiveOn: on, leftSection },
    })

    // A seat came free, so the queue moves. Longest wait first, which is the
    // only ordering anybody will accept.
    // ponytail: two member locks in one drop (the leaver's, then the promoted student's); a deadlock needs two drops promoting each other in one section at once, and Postgres then aborts one (retry).
    let promoted: string | null = null
    if (row.status === 'registered') {
      const [next] = await tx
        .select({ id: registrations.id, studentId: registrations.studentId })
        .from(registrations)
        .where(
          and(
            eq(registrations.offeringId, data.offeringId),
            eq(registrations.status, 'waitlisted'),
          ),
        )
        .orderBy(asc(registrations.registeredAt))
        .limit(1)

      if (next) {
        await tx
          .update(registrations)
          .set({ status: 'registered', registeredAt: new Date() })
          .where(eq(registrations.id, next.id))
        await tx.insert(registrationEvents).values({
          institutionId: tenant,
          registrationId: next.id,
          kind: 'promoted',
          effectiveOn: on,
          reason: 'a place came free',
          actorId: actor.id,
        })
        const joinedSection = await joinSection(tx, tenant, detail.sectionId, next.studentId)
        await audit(tx, {
          institutionId: tenant,
          actorId: actor.id,
          actorEmail: actor.email ?? null,
          moduleId: MODULE,
          action: 'registration.promoted',
          entity: 'enrollment_registrations',
          entityId: next.id,
          reason: 'a place came free',
          detail: { studentId: next.studentId, offeringId: data.offeringId, joinedSection },
        })
        promoted = next.studentId
      }
    }

    return { ...ended!, promoted }
  })
}

// --- sections that follow registration ---------------------------------------

/** Whether a section's membership follows registration (decision 705). Staff only. */
export async function setSectionFeed(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const data = sectionFeedSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [section] = await tx.select({ id: sections.id }).from(sections).where(eq(sections.id, data.sectionId))
    if (!section) throw new EnrollmentError(404, 'no_such_section', 'no such section')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'enrollment.section:' + data.sectionId}, 0))`)
    let added = 0
    if (data.fed) {
      await tx.insert(fedSections).values({ institutionId: tenant, sectionId: data.sectionId }).onConflictDoNothing()
      const done = await tx.execute(sql`
        insert into academic_section_members (institution_id, section_id, user_id)
        select distinct ${tenant}::uuid, o.section_id, r.student_id
          from enrollment_registrations r join academic_offerings o on o.id = r.offering_id
         where o.section_id = ${data.sectionId} and r.status = 'registered'
        on conflict (section_id, user_id) do nothing`)
      added = done.rowCount ?? 0
    } else {
      await tx.delete(fedSections).where(eq(fedSections.sectionId, data.sectionId))
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: data.fed ? 'section.fed' : 'section.unfed',
      entity: 'enrollment_fed_sections',
      entityId: data.sectionId,
      reason: data.fed ? 'section membership now follows registration' : 'section membership no longer follows registration',
      detail: { added },
    })
    return { sectionId: data.sectionId, fed: data.fed, added }
  })
}

/** The sections marked to follow registration, for the seats page. */
export async function listFedSections(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({ sectionId: fedSections.sectionId, label: sections.label, admissionYear: sections.admissionYear, programCode: programs.code })
      .from(fedSections)
      .innerJoin(sections, eq(sections.id, fedSections.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .orderBy(programs.code, sections.admissionYear, sections.label),
  )
}

// --- reads -----------------------------------------------------------------

export async function listRoster(actor: Actor, input: unknown) {
  const tenant = requireMember(actor)
  const { offeringId } = rosterQuerySchema.parse(input)
  if (!STAFF.includes(actor.role) && actor.role !== 'faculty') {
    throw new EnrollmentError(403, 'forbidden', 'not permitted')
  }
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        registrationId: registrations.id,
        studentId: registrations.studentId,
        studentName: users.name,
        status: registrations.status,
        credits: registrations.credits,
        registeredAt: registrations.registeredAt,
        endedOn: registrations.endedOn,
      })
      .from(registrations)
      .innerJoin(users, eq(users.id, registrations.studentId))
      .where(eq(registrations.offeringId, offeringId))
      .orderBy(registrations.status, asc(registrations.registeredAt))

    // The queue position is derived, never stored: a stored position is a
    // renumbering bug waiting for the first person to leave the middle of it.
    let place = 0
    return rows.map((r) => ({
      ...r,
      place: r.status === 'waitlisted' ? ++place : null,
    }))
  })
}

export async function listRegistrations(actor: Actor, input: unknown) {
  const data = registrationsQuerySchema.parse(input ?? {})
  const studentId = data.studentId ?? actor.id
  const tenant = requireReader(actor, studentId)

  return withTenant(tenant, async (tx) => {
    await assertCanAccessStudent(tx, actor, studentId, 'academic_record')
    return tx
      .select({
        id: registrations.id,
        studentId: registrations.studentId,
        offeringId: registrations.offeringId,
        termId: registrations.termId,
        termCode: terms.code,
        status: registrations.status,
        credits: registrations.credits,
        courseCode: courses.code,
        courseTitle: courses.title,
        registeredAt: registrations.registeredAt,
        endedOn: registrations.endedOn,
      })
      .from(registrations)
      .innerJoin(offerings, eq(offerings.id, registrations.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(terms, eq(terms.id, registrations.termId))
      .where(
        data.termId
          ? and(
              eq(registrations.studentId, studentId),
              eq(registrations.termId, data.termId),
            )
          : eq(registrations.studentId, studentId),
      )
      .orderBy(courses.code)
  })
}

/**
 * What a student is carrying this term, which is the number financial aid
 * eligibility is computed from. Registered only: a waitlisted course is a hope,
 * not a load, and a dropped one stopped counting on the day it was dropped.
 */
export async function creditLoad(actor: Actor, input: unknown): Promise<CreditLoad> {
  const data = creditLoadQuerySchema.parse(input)
  const studentId = data.studentId ?? actor.id
  const tenant = requireReader(actor, studentId)

  return withTenant(tenant, async (tx) => {
    await assertCanAccessStudent(tx, actor, studentId, 'academic_record')
    const [row] = await tx
      .select({
        credits: sql<number>`coalesce(sum(${registrations.credits}), 0)::int`,
        courses: sql<number>`count(*)::int`,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.studentId, studentId),
          eq(registrations.termId, data.termId),
          eq(registrations.status, 'registered'),
        ),
      )
    return {
      studentId,
      termId: data.termId,
      credits: row?.credits ?? 0,
      courses: row?.courses ?? 0,
    }
  })
}

/**
 * Every add and drop in a term, with the date each counts from.
 *
 * This is the read Student Financials prorates against. It returns events
 * rather than current statuses on purpose: a course added in week one and
 * dropped in week nine has to be billable for those nine weeks, and a status of
 * "dropped" cannot say that.
 */
export async function listRegistrationEvents(actor: Actor, input: unknown) {
  const tenant = requireMember(actor)
  const data = eventsQuerySchema.parse(input)
  if (!STAFF.includes(actor.role) && data.studentId !== actor.id) {
    throw new EnrollmentError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx) => {
    if (data.studentId) await assertCanAccessStudent(tx, actor, data.studentId, 'academic_record')
    const live = tx
      .select({ id: registrations.id })
      .from(registrations)
      .where(
        data.studentId
          ? and(
              eq(registrations.termId, data.termId),
              eq(registrations.studentId, data.studentId),
            )
          : eq(registrations.termId, data.termId),
      )

    return tx
      .select({
        id: registrationEvents.id,
        registrationId: registrationEvents.registrationId,
        studentId: registrations.studentId,
        offeringId: registrations.offeringId,
        courseCode: courses.code,
        credits: registrations.credits,
        kind: registrationEvents.kind,
        effectiveOn: registrationEvents.effectiveOn,
        reason: registrationEvents.reason,
        createdAt: registrationEvents.createdAt,
      })
      .from(registrationEvents)
      .innerJoin(registrations, eq(registrations.id, registrationEvents.registrationId))
      .innerJoin(offerings, eq(offerings.id, registrations.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .where(inArray(registrationEvents.registrationId, live))
      .orderBy(desc(registrationEvents.effectiveOn), desc(registrationEvents.createdAt))
  })
}
