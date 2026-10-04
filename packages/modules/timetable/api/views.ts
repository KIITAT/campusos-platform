import { asc, eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { courses, offerings, programs, rooms, sections, slots, terms } from '@campusos/module-academic/schema'
import { runEntries, runs } from '../schema'
import { termWithin } from './classes'
import { DAY_SHORT, TimetableError, hm, requireReader, requireTeacherOrOffice, toMinutes, type Actor, type Tx } from './core'
import { periodsFor } from './setup'

/**
 * Timetables to read: a cohort's week, a teacher's, a room's -- from a draft
 * run or from the live slots -- as a grid of periods by days, and teachers'
 * loads. The same grid feeds the screens and the printed PDFs.
 */

export interface Meeting {
  /** The draft's entry id, or the live slot's id. */
  entryId: string
  offeringId: string
  course: string
  courseTitle: string
  sectionId: string
  section: string
  facultyUserId: string | null
  teacher: string | null
  roomId: string
  room: string
  needKind: string | null
  dayOfWeek: number
  startsAt: string
  endsAt: string
}

export type Lens = { by: 'section' | 'teacher' | 'room'; id: string }

export interface Grid {
  title: string
  subtitle: string
  days: { day: number; label: string }[]
  /** One row per period: `period`, `time`, and `d1`..`d7` holding each day's cell text. */
  rows: Record<string, string>[]
  meetings: Meeting[]
}

/** Which meetings a lens sees: a cohort's, a teacher's, a room's. */
export function through(lens: Lens, meetings: Meeting[]) {
  return meetings.filter((m) =>
    lens.by === 'section' ? m.sectionId === lens.id : lens.by === 'teacher' ? m.facultyUserId === lens.id : m.roomId === lens.id,
  )
}

/** What a cell says, for the lens it is seen through: no point naming the teacher on their own timetable. */
function cell(m: Meeting, lens: Lens['by']) {
  const kind = m.needKind && m.needKind !== 'lecture' ? ` (${m.needKind})` : ''
  const parts = [`${m.course}${kind}`]
  if (lens !== 'section') parts.push(m.section)
  if (lens !== 'teacher') parts.push(m.teacher ?? 'no teacher')
  if (lens !== 'room') parts.push(m.room)
  return parts.join(' · ')
}

/**
 * A week as rows of periods. Rows are the week's periods by start time; a
 * meeting off the period grid (a slot made by hand) gets a row of its own.
 * A meeting of several periods fills each of them.
 */
export function gridOf(
  title: string,
  subtitle: string,
  lens: Lens,
  meetings: Meeting[],
  week: { dayOfWeek: number; index: number; startsAt: string; endsAt: string }[],
): Grid {
  const mine = through(lens, meetings)
  const days = [...new Set([...week.map((p) => p.dayOfWeek), ...mine.map((m) => m.dayOfWeek)])].sort()
  const starts = new Map<string, { time: string; period: string }>()
  for (const p of week) {
    const key = hm(p.startsAt)
    if (!starts.has(key)) starts.set(key, { time: `${hm(p.startsAt)}-${hm(p.endsAt)}`, period: String(p.index) })
  }
  for (const m of mine) {
    const key = hm(m.startsAt)
    if (!starts.has(key) && !week.some((p) => p.dayOfWeek === m.dayOfWeek && toMinutes(p.startsAt) < toMinutes(m.startsAt) && toMinutes(m.startsAt) < toMinutes(p.endsAt))) {
      starts.set(key, { time: `${hm(m.startsAt)}-${hm(m.endsAt)}`, period: '' })
    }
  }
  const order = [...starts.keys()].sort((a, b) => toMinutes(a) - toMinutes(b))
  const rows = order.map((start) => {
    const row: Record<string, string> = { period: starts.get(start)!.period, time: starts.get(start)!.time }
    for (const d of days) {
      const here = mine.filter(
        (m) => m.dayOfWeek === d && toMinutes(m.startsAt) <= toMinutes(start) && toMinutes(start) < toMinutes(m.endsAt),
      )
      row[`d${d}`] = here.map((m) => cell(m, lens.by)).join(' / ')
    }
    return row
  })
  return { title, subtitle, days: days.map((d) => ({ day: d, label: DAY_SHORT[d]! })), rows, meetings: mine }
}

// --- reading meetings ------------------------------------------------------------------

export async function runMeetings(tx: Tx, runId: string): Promise<Meeting[]> {
  const rows = await tx
    .select({
      entryId: runEntries.id,
      offeringId: runEntries.offeringId,
      course: courses.code,
      courseTitle: courses.title,
      sectionId: sections.id,
      sectionLabel: sections.label,
      admissionYear: sections.admissionYear,
      programCode: programs.code,
      facultyUserId: runEntries.facultyUserId,
      teacher: users.name,
      roomId: runEntries.roomId,
      room: rooms.code,
      needKind: runEntries.needKind,
      dayOfWeek: runEntries.dayOfWeek,
      startsAt: runEntries.startsAt,
      endsAt: runEntries.endsAt,
    })
    .from(runEntries)
    .innerJoin(offerings, eq(offerings.id, runEntries.offeringId))
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .innerJoin(sections, eq(sections.id, offerings.sectionId))
    .innerJoin(programs, eq(programs.id, sections.programId))
    .innerJoin(rooms, eq(rooms.id, runEntries.roomId))
    .leftJoin(users, eq(users.id, runEntries.facultyUserId))
    .where(eq(runEntries.runId, runId))
    .orderBy(asc(runEntries.dayOfWeek), asc(runEntries.startsAt))
  return rows.map(({ sectionLabel, admissionYear, programCode, ...r }) => ({
    ...r,
    section: `${programCode} ${admissionYear} ${sectionLabel}`,
    startsAt: hm(r.startsAt),
    endsAt: hm(r.endsAt),
  }))
}

export async function liveMeetings(tx: Tx, termId: string): Promise<Meeting[]> {
  const rows = await tx
    .select({
      entryId: slots.id,
      offeringId: offerings.id,
      course: courses.code,
      courseTitle: courses.title,
      sectionId: sections.id,
      sectionLabel: sections.label,
      admissionYear: sections.admissionYear,
      programCode: programs.code,
      facultyUserId: offerings.facultyUserId,
      teacher: users.name,
      roomId: slots.roomId,
      room: rooms.code,
      dayOfWeek: slots.dayOfWeek,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
    })
    .from(slots)
    .innerJoin(offerings, eq(offerings.id, slots.offeringId))
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .innerJoin(sections, eq(sections.id, offerings.sectionId))
    .innerJoin(programs, eq(programs.id, sections.programId))
    .innerJoin(rooms, eq(rooms.id, slots.roomId))
    .leftJoin(users, eq(users.id, offerings.facultyUserId))
    .where(eq(offerings.termId, termId))
    .orderBy(asc(slots.dayOfWeek), asc(slots.startsAt))
  return rows.map(({ sectionLabel, admissionYear, programCode, ...r }) => ({
    ...r,
    needKind: null,
    section: `${programCode} ${admissionYear} ${sectionLabel}`,
    startsAt: hm(r.startsAt),
    endsAt: hm(r.endsAt),
  }))
}

export async function runWithin(tx: Tx, runId: string) {
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId))
  if (!run) throw new TimetableError(404, 'no_such_run', 'no such timetable')
  return run
}

async function currentTermId(tx: Tx) {
  const [t] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.isCurrent, true)).limit(1)
  if (!t) throw new TimetableError(404, 'no_current_term', 'no term is current: say which term')
  return t.id
}

/** A lens from a query: sectionId, teacherId or roomId. */
export function lensOf(q: { sectionId?: string; teacherId?: string; roomId?: string }): Lens | null {
  if (q.sectionId) return { by: 'section', id: q.sectionId }
  if (q.teacherId) return { by: 'teacher', id: q.teacherId }
  if (q.roomId) return { by: 'room', id: q.roomId }
  return null
}

async function titleOf(tx: Tx, lens: Lens, meetings: Meeting[]) {
  if (lens.by === 'section') {
    const m = meetings.find((x) => x.sectionId === lens.id)
    if (m) return m.section
    const [s] = await tx
      .select({ label: sections.label, year: sections.admissionYear, program: programs.code })
      .from(sections)
      .innerJoin(programs, eq(programs.id, sections.programId))
      .where(eq(sections.id, lens.id))
    if (!s) throw new TimetableError(404, 'no_such_section', 'no such cohort')
    return `${s.program} ${s.year} ${s.label}`
  }
  if (lens.by === 'teacher') {
    const [u] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, lens.id))
    if (!u) throw new TimetableError(404, 'no_such_teacher', 'no such teacher')
    return u.name ?? u.email ?? 'Teacher'
  }
  const [r] = await tx.select({ code: rooms.code }).from(rooms).where(eq(rooms.id, lens.id))
  if (!r) throw new TimetableError(404, 'no_such_room', 'no such room')
  return `Room ${r.code}`
}

/** Everybody the timetable has: each cohort, teacher and room, with their meetings and hours a week. */
export function index(meetings: Meeting[]) {
  const count = (key: (m: Meeting) => string | null, name: (m: Meeting) => string) => {
    const out = new Map<string, { id: string; name: string; meetings: number; minutes: number }>()
    for (const m of meetings) {
      const k = key(m)
      if (!k) continue
      const e = out.get(k) ?? { id: k, name: name(m), meetings: 0, minutes: 0 }
      e.meetings += 1
      e.minutes += toMinutes(m.endsAt) - toMinutes(m.startsAt)
      out.set(k, e)
    }
    return [...out.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ minutes, ...e }) => ({ ...e, hours: Math.round(minutes / 6) / 10 }))
  }
  return {
    sections: count((m) => m.sectionId, (m) => m.section),
    teachers: count((m) => m.facultyUserId, (m) => m.teacher ?? ''),
    rooms: count((m) => m.roomId, (m) => m.room),
  }
}

// --- the operations --------------------------------------------------------------------

/** A draft timetable seen through a cohort, a teacher or a room. */
export async function runGrid(actor: Actor, q: { runId: string; sectionId?: string; teacherId?: string; roomId?: string }) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const run = await runWithin(tx, q.runId)
    const meetings = await runMeetings(tx, run.id)
    const lens = lensOf(q)
    const term = await termWithin(tx, run.termId)
    if (!lens) return { run, term, index: index(meetings), grid: null }
    const week = (await periodsFor(tx, run.termId)).rows
    const grid = gridOf(await titleOf(tx, lens, meetings), `${term.name} · draft of ${run.createdAt.toISOString().slice(0, 10)}`, lens, meetings, week)
    return { run, term, index: index(meetings), grid }
  })
}

/** The live timetable -- what the academic core holds -- seen through a cohort, a teacher or a room. */
export async function liveGrid(actor: Actor, q: { termId?: string; sectionId?: string; teacherId?: string; roomId?: string }) {
  const tenant = requireTeacherOrOffice(actor)
  return withTenant(tenant, async (tx) => {
    const termId = q.termId || (await currentTermId(tx))
    const term = await termWithin(tx, termId)
    let lens = lensOf(q)
    // A teacher reads their own; a head or the office reads anybody's.
    if (actor.role === 'faculty') lens = { by: 'teacher', id: actor.id }
    const meetings = await liveMeetings(tx, termId)
    if (!lens) return { term, index: index(meetings), grid: null }
    const week = (await periodsFor(tx, termId)).rows
    const grid = gridOf(await titleOf(tx, lens, meetings), term.name, lens, meetings, week)
    return { term, index: index(meetings), grid }
  })
}

/** A teacher's own week, live. */
export async function myTimetable(actor: Actor) {
  return liveGrid(actor, { teacherId: actor.id })
}

/**
 * Each teacher's load in a draft (or the live timetable): periods a week and
 * by day, how many classes, against their limits.
 */
export async function workload(actor: Actor, q: { runId?: string; termId?: string }) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    let meetings: Meeting[]
    let termId: string
    if (q.runId) {
      const run = await runWithin(tx, q.runId)
      termId = run.termId
      meetings = await runMeetings(tx, run.id)
    } else {
      termId = q.termId || (await currentTermId(tx))
      meetings = await liveMeetings(tx, termId)
    }
    const week = (await periodsFor(tx, termId)).rows
    const lengthOf = (m: Meeting) =>
      Math.max(1, week.filter((p) => p.dayOfWeek === m.dayOfWeek && hm(p.startsAt) >= m.startsAt && hm(p.endsAt) <= m.endsAt).length)
    const limits = await tx.execute(sql`
      select u.id, coalesce(t.max_per_week, s.max_per_week, 24) as max_per_week, coalesce(t.max_per_day, s.max_per_day, 6) as max_per_day
        from users u
        left join timetable_teachers t on t.user_id = u.id
        left join timetable_settings s on s.institution_id = u.institution_id`)
    const limit = new Map((limits.rows as { id: string; max_per_week: number; max_per_day: number }[]).map((r) => [r.id, r]))
    const by = new Map<string, { teacherId: string; teacher: string; periods: number; classes: Set<string>; days: Record<number, number> }>()
    for (const m of meetings) {
      if (!m.facultyUserId) continue
      const e = by.get(m.facultyUserId) ?? { teacherId: m.facultyUserId, teacher: m.teacher ?? '', periods: 0, classes: new Set(), days: {} }
      const n = lengthOf(m)
      e.periods += n
      e.classes.add(m.offeringId)
      e.days[m.dayOfWeek] = (e.days[m.dayOfWeek] ?? 0) + n
      by.set(m.facultyUserId, e)
    }
    const unstaffed = new Set(meetings.filter((m) => !m.facultyUserId).map((m) => m.offeringId)).size
    const rows = [...by.values()]
      .map((e) => {
        const l = limit.get(e.teacherId)
        const row: Record<string, unknown> = {
          teacherId: e.teacherId,
          teacher: e.teacher,
          periods: e.periods,
          classes: e.classes.size,
          maxPerWeek: l?.max_per_week ?? null,
          busiestDay: Math.max(0, ...Object.values(e.days)),
          maxPerDay: l?.max_per_day ?? null,
          utilisation: l?.max_per_week ? Math.round((100 * e.periods) / Number(l.max_per_week)) : null,
        }
        for (let d = 1; d <= 7; d++) row[`d${d}`] = e.days[d] ?? 0
        return row
      })
      .sort((a, b) => String(a.teacher).localeCompare(String(b.teacher)))
    return { termId, rows, unstaffed }
  })
}
