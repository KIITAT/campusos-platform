import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, users, withTenant } from '@campusos/db'
import { ticked } from '@campusos/module-framework'
import { courses, offerings, sections, slots } from '@campusos/module-academic/schema'
import { pins, runEntries, runs, unavailable } from '../schema'
import { sectionConflicts, termClasses, termWithin, type TermClass } from './classes'
import { TimetableError, hm, named, requireOffice, requireReader, toMinutes, type Actor, type Tx } from './core'
import { periodsFor, roomsWithin, settingsWithin, teachersWithin } from './setup'
import { solve, type SolverBusy, type SolverFixed, type SolverInput, type SolverIssue, type SolverResult } from './solver'
import { runWithin } from './views'

/**
 * Drafting a timetable and making it the live one.
 *
 * A run reads everything the solver needs for a term -- classes with needs,
 * the week, rooms, teachers, eligibility, unavailability, pins, and the live
 * slots -- solves, and keeps the answer as a draft. Nothing live changes until
 * the office applies it; then, in one transaction, the term's slots for the
 * classes it covered are replaced and each class gets its teacher, with the
 * academic core's own constraints checking every slot as it is written.
 *
 * A meeting that has history -- attendance taken against it, or a class change
 * on it -- is never moved: it goes into the run as a locked block, and apply
 * keeps it as it is.
 */

interface Built {
  input: SolverInput
  scope: TermClass[]
  issues: SolverIssue[]
}

/** Every live slot the term's dates overlap, and whether it has history. */
async function liveSlots(tx: Tx, startsOn: string, endsOn: string) {
  const [has] = (await tx.execute(sql`select to_regclass('attendance_sessions') is not null as has`)).rows as { has: boolean }[]
  const attended = has?.has ? sql`or exists (select 1 from attendance_sessions a where a.slot_id = s.id)` : sql``
  const res = await tx.execute(sql`
    select s.id, s.offering_id as "offeringId", s.room_id as "roomId", s.day_of_week as "dayOfWeek",
           s.starts_at::text as "startsAt", s.ends_at::text as "endsAt",
           o.section_id as "sectionId", o.faculty_user_id as "facultyUserId", o.term_id as "termId",
           (exists (select 1 from academic_class_changes c where c.slot_id = s.id) ${attended}) as history
      from academic_slots s
      join academic_offerings o on o.id = s.offering_id
     where s.term_dates && daterange(${startsOn}::date, ${endsOn}::date, '[]')`)
  return res.rows as {
    id: string
    offeringId: string
    roomId: string
    dayOfWeek: number
    startsAt: string
    endsAt: string
    sectionId: string
    facultyUserId: string | null
    termId: string
    history: boolean
  }[]
}

export async function buildInput(
  tx: Tx,
  institutionId: string,
  termId: string,
  opts: { keepTeachers: boolean; keepLive: boolean },
): Promise<Built> {
  const term = await termWithin(tx, termId)
  const classes = await termClasses(tx, institutionId, termId)
  const scope = classes.filter((c) => c.needs.length > 0)
  const week = (await periodsFor(tx, termId)).rows
  if (week.length === 0) throw new TimetableError(409, 'no_periods', 'lay out the week’s periods first')
  if (scope.length === 0) throw new TimetableError(409, 'nothing_to_place', 'no class of this term has a weekly need')
  const s = await settingsWithin(tx, institutionId)
  const issues: SolverIssue[] = []

  const periods = week.map((p) => ({ day: p.dayOfWeek, index: p.index, startsAt: hm(p.startsAt), endsAt: hm(p.endsAt) }))
  /** The periods a time span covers on a day. */
  const covered = (day: number, start: string, end: string) =>
    periods.filter((p) => p.day === day && toMinutes(p.startsAt) < toMinutes(end) && toMinutes(start) < toMinutes(p.endsAt))

  const roomRows = await roomsWithin(tx)
  const busy: SolverBusy[] = []
  for (const r of roomRows) if (!r.available) for (const d of new Set(periods.map((p) => p.day))) busy.push({ roomId: r.id, day: d })

  const teacherRows = await teachersWithin(tx, institutionId)
  const teachers = teacherRows.map((t) => ({ id: t.userId, ...t.effective }))
  const known = new Set(teachers.map((t) => t.id))

  const scopeIds = new Set(scope.map((c) => c.offeringId))
  const pinRows = scope.length
    ? await tx.select().from(pins).where(inArray(pins.offeringId, [...scopeIds]))
    : []
  const teacherPin = new Map(pinRows.filter((p) => p.facultyUserId).map((p) => [p.offeringId, p.facultyUserId!]))

  const live = await liveSlots(tx, term.startsOn, term.endsOn)
  const fixed: SolverFixed[] = []
  const lockedTeacher = new Map<string, string | null>()
  const needOf = (c: TermClass, length: number, kind?: string | null) =>
    c.needs.find((n) => (kind ? n.kind === kind : n.blockLength === length)) ?? c.needs[0]!
  const byId = new Map(scope.map((c) => [c.offeringId, c]))
  const extraSections = new Set<string>()
  for (const slot of live) {
    const c = slot.termId === termId ? byId.get(slot.offeringId) : undefined
    const span = covered(slot.dayOfWeek, hm(slot.startsAt), hm(slot.endsAt))
    const aligned =
      span.length > 0 && span[0]!.startsAt === hm(slot.startsAt) && span[span.length - 1]!.endsAt === hm(slot.endsAt)
    if (c && (slot.history || opts.keepLive)) {
      if (slot.history) lockedTeacher.set(c.offeringId, slot.facultyUserId)
      if (aligned) {
        fixed.push({ needId: needOf(c, span.length).id, day: slot.dayOfWeek, index: span[0]!.index, roomId: slot.roomId, locked: slot.history })
        continue
      }
      issues.push({ offeringId: c.offeringId, code: 'pin_refused', message: `a meeting at ${hm(slot.startsAt)} on day ${slot.dayOfWeek} is off the period grid and is kept as it is` })
    } else if (c) {
      // A meeting with no history in a class being timetabled: it will be replaced.
      continue
    }
    // Everything else stays where it is, so nothing may be put on top of it.
    for (const p of span) {
      busy.push({ roomId: slot.roomId, day: p.day, index: p.index })
      busy.push({ sectionId: slot.sectionId, day: p.day, index: p.index })
      if (slot.facultyUserId) busy.push({ teacherId: slot.facultyUserId, day: p.day, index: p.index })
    }
    extraSections.add(slot.sectionId)
  }

  for (const p of pinRows) {
    if (p.dayOfWeek === null || p.period === null) continue
    const c = byId.get(p.offeringId)!
    const n = needOf(c, 1, p.needKind)
    fixed.push({ needId: n.id, day: p.dayOfWeek, index: p.period, roomId: p.roomId })
  }

  const offeringsIn = scope.map((c) => {
    const teacher =
      teacherPin.get(c.offeringId) ??
      (lockedTeacher.has(c.offeringId) ? lockedTeacher.get(c.offeringId) : undefined) ??
      (opts.keepTeachers ? c.facultyUserId : null) ??
      null
    for (const id of [teacher, ...c.candidates.map((x) => x.userId)]) {
      if (id && !known.has(id)) {
        known.add(id)
        teachers.push({ id, maxPerDay: s.maxPerDay, maxPerWeek: s.maxPerWeek, maxConsecutive: s.maxConsecutive })
      }
    }
    return {
      id: c.offeringId,
      sectionId: c.sectionId,
      size: c.size,
      teachers: c.candidates.map((x) => ({ id: x.userId, preference: x.preference })),
      teacher,
    }
  })

  const needsIn = scope.flatMap((c) =>
    c.needs.map((n) => ({
      id: n.id,
      offeringId: c.offeringId,
      kind: n.kind,
      blocks: n.periodsPerWeek / n.blockLength,
      length: n.blockLength,
      roomKind: n.roomKind ?? 'classroom',
      roomId: n.roomId,
    })),
  )

  // Unavailability: teachers, rooms, cohorts.
  for (const u of await tx.select().from(unavailable)) {
    busy.push({ teacherId: u.userId ?? undefined, roomId: u.roomId ?? undefined, sectionId: u.sectionId ?? undefined, day: u.dayOfWeek, index: u.period })
  }

  // Cohorts that share students, or are batches of one another. A cohort busy
  // with something outside the run makes its batches busy too.
  const sectionIds = [...new Set([...scope.map((c) => c.sectionId), ...extraSections])]
  const conflicts = await sectionConflicts(tx, sectionIds)
  const inScope = new Set(scope.map((c) => c.sectionId))
  const spread: SolverBusy[] = []
  for (const b of busy) {
    if (!b.sectionId) continue
    for (const [x, y] of conflicts) {
      const other = x === b.sectionId ? y : y === b.sectionId ? x : null
      if (other && inScope.has(other)) spread.push({ ...b, sectionId: other })
    }
  }

  return {
    input: {
      periods,
      rooms: roomRows.map((r) => ({ id: r.id, capacity: r.capacity, kind: r.kind })),
      teachers,
      offerings: offeringsIn,
      needs: needsIn,
      busy: [...busy, ...spread],
      fixed,
      sectionConflicts: conflicts.filter(([x, y]) => inScope.has(x) && inScope.has(y)),
      options: { timeLimitMs: s.timeLimitSeconds * 1000 },
    },
    scope,
    issues,
  }
}

export const runSchema = z
  .object({
    termId: z.uuid(),
    seed: z.union([z.literal('').transform(() => undefined), z.coerce.number().int().min(0).max(2 ** 31 - 1)]).optional(),
    iterations: z.union([z.literal('').transform(() => undefined), z.coerce.number().int().min(0).max(300_000)]).optional(),
    /** Keep the teachers classes already have (default), or let the solver choose them all. */
    keepTeachers: z.preprocess(ticked, z.boolean()).default(true),
    /** Keep live meetings where they are, timetabling only around them. */
    keepLive: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'TimetableRun' })

/** Draft a timetable for a term. Nothing live changes. */
export async function generateRun(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = runSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const built = await buildInput(tx, tenant, data.termId, { keepTeachers: data.keepTeachers, keepLive: data.keepLive })
      const seed = data.seed ?? (Math.floor(Math.random() * 2 ** 31) >>> 0)
      const result: SolverResult = solve({
        ...built.input,
        options: { ...built.input.options, seed, ...(data.iterations !== undefined ? { iterations: data.iterations } : {}) },
      })
      const kindOf = new Map(built.input.needs.map((n) => [n.id, n.kind]))
      const [run] = await tx
        .insert(runs)
        .values({
          institutionId: tenant,
          termId: data.termId,
          seed,
          options: { keepTeachers: data.keepTeachers, keepLive: data.keepLive, iterations: data.iterations ?? null, offeringIds: built.scope.map((c) => c.offeringId) },
          teachers: result.teachers,
          cost: result.cost,
          stats: result.stats,
          issues: [...built.issues, ...result.issues],
          unplaced: result.unplaced,
          createdBy: actor.id,
        })
        .returning()
      if (result.placements.length) {
        await tx.insert(runEntries).values(
          result.placements.map((p) => ({
            institutionId: tenant,
            runId: run!.id,
            offeringId: p.offeringId,
            needKind: kindOf.get(p.needId) ?? 'lecture',
            facultyUserId: p.teacherId,
            roomId: p.roomId,
            dayOfWeek: p.day,
            period: p.index,
            length: p.length,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            fixed: p.fixed,
            locked: p.locked,
          })),
        )
      }
      const left = result.unplaced.reduce((n, u) => n + u.count, 0)
      return {
        id: run!.id,
        placed: result.stats.placed,
        blocks: result.stats.blocks,
        unplaced: left,
        notice: left
          ? `Drafted: ${result.stats.placed} of ${result.stats.blocks} blocks placed; ${left} could not be -- see why.`
          : `Drafted: all ${result.stats.blocks} blocks placed. Review it, then apply.`,
        next: `/m/timetable/run?id=${run!.id}`,
      }
    }),
  )
}

export async function listRuns(actor: Actor, input: { termId?: string } = {}) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: runs.id,
        termId: runs.termId,
        status: runs.status,
        seed: runs.seed,
        stats: runs.stats,
        cost: runs.cost,
        unplaced: runs.unplaced,
        issues: runs.issues,
        createdAt: runs.createdAt,
        createdBy: users.name,
        appliedAt: runs.appliedAt,
      })
      .from(runs)
      .leftJoin(users, eq(users.id, runs.createdBy))
      .where(input.termId ? eq(runs.termId, input.termId) : undefined)
      .orderBy(desc(runs.createdAt))
      .limit(100)
    return rows.map(({ stats, cost, unplaced, issues, ...r }) => ({
      ...r,
      blocks: Number(stats.blocks ?? 0),
      placed: Number(stats.placed ?? 0),
      unplacedBlocks: unplaced.reduce((n, u) => n + u.count, 0),
      issues: issues.length,
      score: Number(cost.total ?? 0),
      seconds: Math.round(Number(stats.ms ?? 0) / 100) / 10,
    }))
  })
}

/** One draft: what it placed, what it could not and why, and what it changes. */
export async function runDetail(actor: Actor, input: { runId: string }) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const run = await runWithin(tx, input.runId)
    const term = await termWithin(tx, run.termId)
    const ids = (run.options.offeringIds as string[] | undefined) ?? []
    const names = ids.length
      ? await tx
          .select({ id: offerings.id, course: courses.code, section: sections.label, facultyUserId: offerings.facultyUserId })
          .from(offerings)
          .innerJoin(courses, eq(courses.id, offerings.courseId))
          .innerJoin(sections, eq(sections.id, offerings.sectionId))
          .where(inArray(offerings.id, ids))
      : []
    const nameOf = new Map(names.map((n) => [n.id, `${n.course} (${n.section})`]))
    const people = await tx.select({ id: users.id, name: users.name }).from(users)
    const person = new Map(people.map((p) => [p.id, p.name]))
    const changes = names
      .filter((n) => (run.teachers[n.id] ?? null) !== n.facultyUserId)
      .map((n) => ({
        offeringId: n.id,
        class: nameOf.get(n.id)!,
        from: n.facultyUserId ? (person.get(n.facultyUserId) ?? n.facultyUserId) : null,
        to: run.teachers[n.id] ? (person.get(run.teachers[n.id]!) ?? run.teachers[n.id]) : null,
      }))
    return {
      run,
      term,
      unplaced: run.unplaced.map((u) => ({ ...u, class: nameOf.get(u.offeringId) ?? u.offeringId })),
      issues: run.issues.map((i) => ({ ...i, class: nameOf.get(i.offeringId) ?? i.offeringId })),
      teacherChanges: changes,
      classes: ids.length,
    }
  })
}

/**
 * Make a draft the live timetable: replace the term's slots for the classes it
 * covered (keeping any that already match, and every meeting with history),
 * give each class its teacher, and mark the run applied -- or change nothing.
 */
export async function applyRun(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const { runId } = z.object({ runId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update')
      if (!run) throw new TimetableError(404, 'no_such_run', 'no such timetable')
      if (run.status !== 'draft') throw new TimetableError(409, 'not_a_draft', `this timetable is ${run.status}`)
      const scope = (run.options.offeringIds as string[] | undefined) ?? []
      const entries = await tx.select().from(runEntries).where(eq(runEntries.runId, runId))
      const term = await termWithin(tx, run.termId)
      const live = (await liveSlots(tx, term.startsOn, term.endsOn)).filter((s) => s.termId === run.termId && scope.includes(s.offeringId))

      const key = (o: string, d: number, a: string, b: string, r: string) => `${o}|${d}|${hm(a)}|${hm(b)}|${r}`
      const wanted = new Map<string, number>()
      for (const e of entries) {
        const k = key(e.offeringId, e.dayOfWeek, e.startsAt, e.endsAt, e.roomId)
        wanted.set(k, (wanted.get(k) ?? 0) + 1)
      }
      const removed: string[] = []
      for (const s of live) {
        const k = key(s.offeringId, s.dayOfWeek, s.startsAt, s.endsAt, s.roomId)
        if ((wanted.get(k) ?? 0) > 0) {
          wanted.set(k, wanted.get(k)! - 1)
          continue
        }
        if (s.history) {
          throw new TimetableError(
            409,
            'slot_has_history',
            'a meeting with attendance or a class change on it would be removed: draft the timetable again',
          )
        }
        removed.push(s.id)
      }
      if (removed.length) await tx.delete(slots).where(inArray(slots.id, removed))

      // Teachers: clear the ones that change first, then give each its new one,
      // so two classes trading teachers never meet in between.
      const current = scope.length
        ? await tx.select({ id: offerings.id, faculty: offerings.facultyUserId }).from(offerings).where(inArray(offerings.id, scope))
        : []
      const changing = current.filter((o) => (run.teachers[o.id] ?? null) !== o.faculty)
      if (changing.length) {
        await tx.update(offerings).set({ facultyUserId: null }).where(inArray(offerings.id, changing.map((o) => o.id)))
        for (const o of changing) {
          const t = run.teachers[o.id] ?? null
          if (t) await tx.update(offerings).set({ facultyUserId: t }).where(eq(offerings.id, o.id))
        }
      }

      // New slots: every wanted meeting not already live.
      const toInsert = entries.filter((e) => {
        const k = key(e.offeringId, e.dayOfWeek, e.startsAt, e.endsAt, e.roomId)
        if ((wanted.get(k) ?? 0) > 0) {
          wanted.set(k, wanted.get(k)! - 1)
          return true
        }
        return false
      })
      for (const e of toInsert) {
        await tx.insert(slots).values({
          institutionId: tenant,
          offeringId: e.offeringId,
          roomId: e.roomId,
          dayOfWeek: e.dayOfWeek,
          startsAt: hm(e.startsAt),
          endsAt: hm(e.endsAt),
        })
      }

      await tx
        .update(runs)
        .set({ status: 'superseded', closedAt: new Date() })
        .where(and(eq(runs.termId, run.termId), eq(runs.status, 'applied')))
      await tx.update(runs).set({ status: 'applied', appliedAt: new Date(), appliedBy: actor.id }).where(eq(runs.id, runId))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'timetable',
        action: 'apply',
        entity: 'timetable_run',
        entityId: runId,
        reason: 'a drafted timetable made the live one',
        detail: { removed: removed.length, added: toInsert.length, teachers: changing.length },
      })
      return {
        removed: removed.length,
        added: toInsert.length,
        teachersChanged: changing.length,
        notice: `Applied: ${toInsert.length} meeting(s) added, ${removed.length} removed, ${changing.length} class(es) given a new teacher.`,
        next: `/m/timetable/live?termId=${run.termId}`,
      }
    }),
  )
}

export async function discardRun(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const { runId } = z.object({ runId: z.uuid() }).parse(input)
  return withTenant(tenant, async (tx) => {
    const run = await runWithin(tx, runId)
    if (run.status !== 'draft') throw new TimetableError(409, 'not_a_draft', `this timetable is ${run.status}`)
    await tx.update(runs).set({ status: 'discarded', closedAt: new Date() }).where(eq(runs.id, runId))
    return { notice: 'Draft discarded.', next: `/m/timetable/runs?termId=${run.termId}` }
  })
}

export const pinEntrySchema = z
  .object({
    entryId: z.uuid(),
    /** What to keep: the time (and room), the teacher, or both. */
    keep: z.enum(['time', 'teacher', 'both']).default('time'),
  })
  .meta({ id: 'TimetablePinEntry' })

/** Keep one meeting of a draft -- its time and room, its teacher, or both -- for the next run. */
export async function pinEntry(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = pinEntrySchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [e] = await tx.select().from(runEntries).where(eq(runEntries.id, data.entryId))
      if (!e) throw new TimetableError(404, 'no_such_entry', 'no such meeting')
      const time = data.keep !== 'teacher'
      const teacher = data.keep !== 'time' && e.facultyUserId
      if (teacher) {
        await tx.delete(pins).where(and(eq(pins.offeringId, e.offeringId), sql`${pins.facultyUserId} is not null`, sql`${pins.dayOfWeek} is null`))
      }
      await tx.insert(pins).values({
        institutionId: tenant,
        offeringId: e.offeringId,
        needKind: time ? e.needKind : null,
        facultyUserId: teacher ? e.facultyUserId : null,
        dayOfWeek: time ? e.dayOfWeek : null,
        period: time ? e.period : null,
        roomId: time ? e.roomId : null,
        createdBy: actor.id,
        note: 'kept from a draft',
      })
      return { notice: 'Pinned for the next run.' }
    }),
  )
}
