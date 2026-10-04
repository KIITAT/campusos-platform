import { and, asc, eq, notInArray, sql } from 'drizzle-orm'
import * as z from 'zod'
import { users, withTenant } from '@campusos/db'
import { courses, offerings, rooms, sections } from '@campusos/module-academic/schema'
import { needs, pins } from '../schema'
import { termClasses, termWithin } from './classes'
import { TimetableError, named, requireOffice, requireReader, type Actor } from './core'
import { periodsFor, roomsWithin, teachersWithin } from './setup'

/**
 * What each class needs a week, what the office has pinned, and whether a
 * term is ready to be timetabled at all.
 */

const uuid = z.uuid()
const optionalId = z.uuid().optional().or(z.literal('').transform(() => undefined))
const optionalInt = (min: number, max: number) =>
  z.union([z.literal('').transform(() => undefined), z.coerce.number().int().min(min).max(max)]).optional()
const kindOf = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,23}$/, 'a short word: lecture, lab, tutorial')

const summary = (n: { kind: string; periodsPerWeek: number; blockLength: number }) =>
  n.blockLength === 1 ? `${n.periodsPerWeek} ${n.kind}` : `${n.periodsPerWeek / n.blockLength}x${n.blockLength} ${n.kind}`

// --- needs ---------------------------------------------------------------------------

export async function listNeeds(actor: Actor, input: { termId: string }) {
  const tenant = requireReader(actor)
  if (!input.termId) throw new TimetableError(400, 'term_required', 'say which term')
  return withTenant(tenant, async (tx) => {
    const classes = await termClasses(tx, tenant, input.termId)
    return classes.map((c) => ({
      offeringId: c.offeringId,
      course: c.courseCode,
      courseTitle: c.courseTitle,
      credits: c.credits,
      section: c.sectionName,
      sectionId: c.sectionId,
      yearOfStudy: c.yearOfStudy,
      size: c.size,
      teacher: c.facultyName,
      facultyUserId: c.facultyUserId,
      candidates: c.candidates.length,
      needs: c.needs,
      summary: c.needs.map(summary).join(', '),
      periodsPerWeek: c.needs.reduce((n, x) => n + x.periodsPerWeek, 0),
    }))
  })
}

export const needSchema = z
  .object({
    offeringId: uuid,
    kind: kindOf.default('lecture'),
    periodsPerWeek: z.coerce.number().int().min(1).max(40),
    blockLength: z.coerce.number().int().min(1).max(6).default(1),
    roomKind: z
      .string()
      .trim()
      .toLowerCase()
      .max(40)
      .optional()
      .transform((v) => (v ? v : undefined)),
    roomId: optionalId,
  })
  .meta({ id: 'TimetableNeed' })

/** Set a class's need of one kind -- four lecture periods, one two-period lab. */
export async function setNeed(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = needSchema.parse(input)
  if (data.periodsPerWeek % data.blockLength !== 0) {
    throw new TimetableError(400, 'timetable_needs_periods', `${data.periodsPerWeek} periods do not make blocks of ${data.blockLength}`)
  }
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [o] = await tx.select({ id: offerings.id }).from(offerings).where(eq(offerings.id, data.offeringId))
      if (!o) throw new TimetableError(404, 'no_such_class', 'no such class')
      const values = {
        periodsPerWeek: data.periodsPerWeek,
        blockLength: data.blockLength,
        roomKind: data.roomKind ?? null,
        roomId: data.roomId ?? null,
      }
      const [row] = await tx
        .insert(needs)
        .values({ institutionId: tenant, offeringId: data.offeringId, kind: data.kind, ...values })
        .onConflictDoUpdate({ target: [needs.offeringId, needs.kind], set: values })
        .returning()
      return { ...row!, notice: `Needs ${summary(row!)} a week.` }
    }),
  )
}

export async function deleteNeed(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const { needId } = z.object({ needId: uuid }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(needs).where(eq(needs.id, needId))
    return { notice: 'Removed.' }
  })
}

export const defaultNeedsSchema = z
  .object({
    termId: uuid,
    periodsPerCredit: z.coerce.number().int().min(1).max(4).default(1),
    kind: kindOf.default('lecture'),
    roomKind: z.string().trim().toLowerCase().max(40).default('classroom'),
  })
  .meta({ id: 'TimetableDefaultNeeds' })

/**
 * A lecture need for every class of the term that has none yet: a period a
 * week for each credit, by default. A starting point to adjust, not a rule.
 */
export async function defaultNeeds(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = defaultNeedsSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await termWithin(tx, data.termId)
      const have = tx.select({ id: needs.offeringId }).from(needs)
      const bare = await tx
        .select({ id: offerings.id, credits: courses.credits })
        .from(offerings)
        .innerJoin(courses, eq(courses.id, offerings.courseId))
        .where(and(eq(offerings.termId, data.termId), notInArray(offerings.id, have)))
      const rows = bare
        .filter((o) => o.credits > 0)
        .map((o) => ({
          institutionId: tenant,
          offeringId: o.id,
          kind: data.kind,
          periodsPerWeek: Math.min(40, o.credits * data.periodsPerCredit),
          blockLength: 1,
          roomKind: data.roomKind === 'classroom' ? null : data.roomKind,
        }))
      if (rows.length) await tx.insert(needs).values(rows)
      return { added: rows.length, notice: rows.length ? `${rows.length} class(es) given a need from their credits.` : 'Every class already has a need.' }
    }),
  )
}

// --- pins ----------------------------------------------------------------------------

export async function listPins(actor: Actor, input: { termId: string }) {
  const tenant = requireReader(actor)
  if (!input.termId) throw new TimetableError(400, 'term_required', 'say which term')
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: pins.id,
        offeringId: pins.offeringId,
        course: courses.code,
        section: sections.label,
        needKind: pins.needKind,
        facultyUserId: pins.facultyUserId,
        teacher: users.name,
        dayOfWeek: pins.dayOfWeek,
        period: pins.period,
        roomId: pins.roomId,
        room: rooms.code,
        note: pins.note,
      })
      .from(pins)
      .innerJoin(offerings, eq(offerings.id, pins.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .leftJoin(users, eq(users.id, pins.facultyUserId))
      .leftJoin(rooms, eq(rooms.id, pins.roomId))
      .where(eq(offerings.termId, input.termId))
      .orderBy(asc(courses.code), asc(pins.dayOfWeek), asc(pins.period)),
  )
}

export const pinSchema = z
  .object({
    offeringId: uuid,
    needKind: kindOf.optional().or(z.literal('').transform(() => undefined)),
    facultyUserId: z.string().trim().max(100).optional().transform((v) => (v ? v : undefined)),
    dayOfWeek: optionalInt(1, 7),
    period: optionalInt(1, 30),
    roomId: optionalId,
    note: z.string().trim().max(200).optional().transform((v) => (v ? v : undefined)),
  })
  .meta({ id: 'TimetablePin' })

/**
 * Keep something the solver must not change: a class's teacher, a block's
 * time, its room -- the time and room for one block of the named kind.
 */
export async function addPin(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = pinSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const classNeeds = await tx.select().from(needs).where(eq(needs.offeringId, data.offeringId))
      if (data.dayOfWeek !== undefined) {
        if (classNeeds.length === 0) throw new TimetableError(409, 'no_need', 'give the class its weekly need before pinning a time')
        if (data.needKind && !classNeeds.some((n) => n.kind === data.needKind)) {
          throw new TimetableError(409, 'no_need', `the class has no ${data.needKind} need`)
        }
      }
      if (data.facultyUserId) {
        const [u] = await tx.select({ role: users.role }).from(users).where(eq(users.id, data.facultyUserId))
        if (!u || ['student', 'parent', 'pending'].includes(u.role)) throw new TimetableError(409, 'not_staff', 'only staff teach')
        // One teacher per class: a new teacher pin replaces any other.
        await tx
          .update(pins)
          .set({ facultyUserId: null })
          .where(and(eq(pins.offeringId, data.offeringId), sql`${pins.facultyUserId} is not null`, sql`${pins.dayOfWeek} is not null`))
        await tx.delete(pins).where(and(eq(pins.offeringId, data.offeringId), sql`${pins.facultyUserId} is not null`, sql`${pins.dayOfWeek} is null`))
      }
      const [row] = await tx
        .insert(pins)
        .values({
          institutionId: tenant,
          offeringId: data.offeringId,
          needKind: data.needKind ?? null,
          facultyUserId: data.facultyUserId ?? null,
          dayOfWeek: data.dayOfWeek ?? null,
          period: data.period ?? null,
          roomId: data.roomId ?? null,
          note: data.note ?? null,
          createdBy: actor.id,
        })
        .returning()
      return { ...row!, notice: 'Pinned.' }
    }),
  )
}

export async function deletePin(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const { pinId } = z.object({ pinId: uuid }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(pins).where(eq(pins.id, pinId))
    return { notice: 'Unpinned.' }
  })
}

// --- is the term ready? ----------------------------------------------------------------

/**
 * Before the solver runs: what would stop it, and what it will have to leave
 * out. Capacity is compared in periods -- what the classes ask for against
 * what the week, the rooms and the teachers can give.
 */
export async function checkTerm(actor: Actor, input: { termId: string }) {
  const tenant = requireReader(actor)
  if (!input.termId) throw new TimetableError(400, 'term_required', 'say which term')
  return withTenant(tenant, async (tx) => {
    const classes = await termClasses(tx, tenant, input.termId)
    const week = await periodsFor(tx, input.termId)
    const roomList = (await roomsWithin(tx)).filter((r) => r.available)
    const teachers = await teachersWithin(tx, tenant)

    const problems: { level: 'stop' | 'warn'; text: string }[] = []
    const perWeek = week.rows.length
    if (perWeek === 0) problems.push({ level: 'stop', text: 'there are no periods: lay out the week first' })

    const withNeeds = classes.filter((c) => c.needs.length > 0)
    const bare = classes.filter((c) => c.needs.length === 0)
    if (classes.length === 0) problems.push({ level: 'stop', text: 'the term has no classes' })
    if (bare.length) problems.push({ level: 'warn', text: `${bare.length} class(es) have no weekly need and will be left as they are` })

    const nobody = withNeeds.filter((c) => c.candidates.length === 0 && !c.facultyUserId)
    for (const c of nobody) problems.push({ level: 'warn', text: `${c.courseCode} for ${c.sectionName}: nobody is eligible to teach it` })

    // Each cohort's week against the periods there are.
    const bySection = new Map<string, { name: string; periods: number }>()
    for (const c of withNeeds) {
      const s = bySection.get(c.sectionId) ?? { name: c.sectionName, periods: 0 }
      s.periods += c.needs.reduce((n, x) => n + x.periodsPerWeek, 0)
      bySection.set(c.sectionId, s)
    }
    for (const s of bySection.values()) {
      if (s.periods > perWeek) problems.push({ level: 'stop', text: `${s.name} needs ${s.periods} periods a week; the week has ${perWeek}` })
    }

    // Rooms of each kind: periods asked for against room-periods available.
    const demand = new Map<string, { periods: number; largest: number }>()
    for (const c of withNeeds) {
      for (const n of c.needs) {
        if (n.roomId) continue
        const kind = n.roomKind ?? 'classroom'
        const d = demand.get(kind) ?? { periods: 0, largest: 0 }
        d.periods += n.periodsPerWeek
        d.largest = Math.max(d.largest, c.size)
        demand.set(kind, d)
      }
    }
    const roomsByKind = [...demand].map(([kind, d]) => {
      const fit = roomList.filter((r) => r.kind === kind)
      const supply = fit.length * perWeek
      const seats = Math.max(0, ...fit.map((r) => r.capacity ?? 100000))
      if (fit.length === 0) problems.push({ level: 'stop', text: `classes need a ${kind} and there is none` })
      else if (d.periods > supply) problems.push({ level: 'stop', text: `${kind}s: ${d.periods} periods asked for, ${supply} available` })
      else if (d.periods > supply * 0.85) problems.push({ level: 'warn', text: `${kind}s are ${Math.round((100 * d.periods) / supply)}% booked: little room to move` })
      if (fit.length && seats < d.largest) problems.push({ level: 'warn', text: `the largest ${kind} seats ${seats}; a class of ${d.largest} will not fit` })
      return { kind, rooms: fit.length, asked: d.periods, available: supply }
    })

    // Teaching: periods asked for against teachers' weeks.
    const asked = withNeeds.reduce((n, c) => n + c.needs.reduce((m, x) => m + x.periodsPerWeek, 0), 0)
    const eligible = new Set(withNeeds.flatMap((c) => c.candidates.map((x) => x.userId)))
    const capacity = teachers.filter((t) => eligible.has(t.userId)).reduce((n, t) => n + t.effective.maxPerWeek, 0)
    if (asked > capacity) problems.push({ level: 'warn', text: `teaching asked for is ${asked} periods; eligible teachers can give ${capacity}` })

    return {
      termId: input.termId,
      ready: !problems.some((p) => p.level === 'stop'),
      periodsPerWeek: perWeek,
      days: [...new Set(week.rows.map((p) => p.dayOfWeek))],
      classes: classes.length,
      classesWithNeeds: withNeeds.length,
      blocks: withNeeds.reduce((n, c) => n + c.needs.reduce((m, x) => m + x.periodsPerWeek / x.blockLength, 0), 0),
      teachingAsked: asked,
      teachingCapacity: capacity,
      rooms: roomsByKind,
      problems,
    }
  })
}
