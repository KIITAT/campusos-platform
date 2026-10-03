import { and, eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, users, withTenant } from '@campusos/db'
import { classChanges, offerings, slots } from '../schema'
import { AcademicError, requireReader, type Actor } from './operations'

/**
 * One meeting of a weekly class, changed -- what a lecturer does when they
 * "adjust the class timings" on KIIT's faculty calendar: cancel Thursday's
 * class, move it to Friday afternoon in another room, or have a colleague take
 * it. The weekly slot is untouched; the week a student or teacher sees has the
 * change applied.
 */

const MODULE = 'academic'
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const clock = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'a time, HH:MM')

export const changeClassSchema = z
  .object({
    slotId: z.uuid(),
    onDate: z.iso.date(),
    kind: z.enum(['cancelled', 'rescheduled', 'substitute']),
    movedOn: z.preprocess(blank, z.iso.date().optional()),
    movedStarts: z.preprocess(blank, clock.optional()),
    movedEnds: z.preprocess(blank, clock.optional()),
    movedRoomId: z.preprocess(blank, z.uuid().optional()),
    substituteId: z.preprocess(blank, z.string().min(1).optional()),
    reason: z.string().trim().min(5).max(300),
  })
  .meta({ id: 'AcademicClassChange' })

export const withdrawChangeSchema = z
  .object({ changeId: z.uuid(), reason: z.string().trim().min(5).max(300) })
  .meta({ id: 'AcademicClassChangeWithdraw' })

const REFUSALS: Record<string, [400 | 403 | 409, string]> = {
  academic_class_changes_once: [409, 'that class already has a change on that date; withdraw it first'],
  academic_class_changes_shape: [400, 'a move needs a date, times and a room; a substitute needs a teacher'],
  academic_class_change_day: [400, 'the class does not meet on that day of the week'],
  academic_class_change_term: [400, 'that date is outside the term'],
  academic_class_change_substitute: [400, 'a substitute is a teacher other than the lecturer'],
  academic_class_change_room_clash: [409, 'that room is taken then'],
  academic_class_change_teacher_clash: [409, 'that teacher is teaching then'],
  academic_class_change_fixed: [409, 'a change is only withdrawn, once'],
  academic_class_change_kept: [409, 'a change is withdrawn, not deleted'],
}

function named(e: unknown): never {
  const c = (e as { cause?: { constraint?: string } }).cause?.constraint
  const known = c ? REFUSALS[c] : undefined
  if (known) throw new AcademicError(known[0], c!, known[1])
  throw e
}

const runs = (r: Actor['role']) => r === 'institution_admin' || r === 'super_admin' || r === 'hod'

async function assertMayChange(tx: Parameters<Parameters<typeof withTenant>[1]>[0], actor: Actor, slotId: string) {
  const [s] = await tx
    .select({ faculty: offerings.facultyUserId })
    .from(slots)
    .innerJoin(offerings, eq(offerings.id, slots.offeringId))
    .where(eq(slots.id, slotId))
  if (!s) throw new AcademicError(404, 'no_such_slot', 'no such class')
  if (runs(actor.role)) return
  if (actor.role !== 'faculty' || s.faculty !== actor.id) throw new AcademicError(403, 'forbidden', 'that is not your class')
}

export async function changeClass(actor: Actor, input: unknown) {
  const tenant = requireReader(actor)
  const d = changeClassSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await assertMayChange(tx, actor, d.slotId)
    const [row] = await tx
      .insert(classChanges)
      .values({
        institutionId: tenant,
        slotId: d.slotId,
        onDate: d.onDate,
        kind: d.kind,
        movedOn: d.kind === 'rescheduled' ? (d.movedOn ?? null) : null,
        movedStarts: d.kind === 'rescheduled' ? (d.movedStarts ?? null) : null,
        movedEnds: d.kind === 'rescheduled' ? (d.movedEnds ?? null) : null,
        movedRoomId: d.kind === 'rescheduled' ? (d.movedRoomId ?? null) : null,
        substituteId: d.kind === 'substitute' ? (d.substituteId ?? null) : null,
        reason: d.reason,
        createdBy: actor.id,
      })
      .returning()
      .catch(named)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      moduleId: MODULE,
      action: `class.${d.kind}`,
      entity: 'academic_class_changes',
      entityId: row!.id,
      reason: d.reason,
    })
    const words = { cancelled: 'Cancelled', rescheduled: 'Moved', substitute: 'A substitute takes it' }[d.kind]
    return { ...row!, notice: `${words}. Students and the teacher see it on their week.` }
  })
}

export async function withdrawChange(actor: Actor, input: unknown) {
  const tenant = requireReader(actor)
  const d = withdrawChangeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [c] = await tx.select().from(classChanges).where(eq(classChanges.id, d.changeId))
    if (!c) throw new AcademicError(404, 'no_such_change', 'no such change')
    await assertMayChange(tx, actor, c.slotId)
    await tx
      .update(classChanges)
      .set({ withdrawnAt: new Date(), withdrawnBy: actor.id, withdrawReason: d.reason })
      .where(eq(classChanges.id, d.changeId))
      .catch(named)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      moduleId: MODULE,
      action: 'class.change_withdrawn',
      entity: 'academic_class_changes',
      entityId: d.changeId,
      reason: d.reason,
    })
    return { id: d.changeId, notice: 'Withdrawn: the class meets as usual.' }
  })
}

export interface Occurrence {
  date: string
  slotId: string
  starts: string
  ends: string
  courseCode: string
  courseTitle: string
  section: string
  room: string
  teacher: string | null
  /** As timetabled, or what changed. */
  status: 'as_timetabled' | 'cancelled' | 'moved_away' | 'moved_here' | 'substitute'
  note: string | null
  changeId: string | null
}

/**
 * The week containing a date, as the reader's timetable says it should run,
 * with the changes applied: a cancelled class marked, a moved class shown on
 * its old day as moved and on its new day where it now meets, a substitute
 * named. A student sees their sections' classes; a teacher their own and any
 * they substitute in; the office everything.
 */
export async function weekView(actor: Actor, date?: string | null) {
  const tenant = requireReader(actor)
  const anchor = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : new Date()
  const iso = (anchor.getUTCDay() + 6) % 7 // Monday is 0
  const monday = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - iso))
  const days = Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10))
  const scope =
    actor.role === 'student'
      ? sql`o.section_id in (select section_id from academic_section_members where user_id = ${actor.id})`
      : actor.role === 'faculty'
        ? sql`(o.faculty_user_id = ${actor.id} or exists (select 1 from academic_class_changes x
                 where x.slot_id = s.id and x.substitute_id = ${actor.id} and x.withdrawn_at is null
                   and x.on_date between ${days[0]}::date and ${days[6]}::date))`
        : sql`true`
  return withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      with week as (select d::date as day from generate_series(${days[0]}::date, ${days[6]}::date, interval '1 day') d)
      select w.day, s.id as slot_id, s.starts_at, s.ends_at, c.code, c.title, sec.label as section, r.code as room,
             coalesce(f.name, f.email) as teacher,
             ch.id as change_id, ch.kind::text as kind, ch.reason, ch.moved_on, ch.moved_starts, ch.moved_ends, mr.code as moved_room,
             coalesce(sf.name, sf.email) as substitute
        from week w
        join academic_slots s on s.day_of_week = extract(isodow from w.day)
        join academic_offerings o on o.id = s.offering_id
        join academic_terms t on t.id = o.term_id and w.day between t.starts_on and t.ends_on
        join academic_courses c on c.id = o.course_id
        join academic_sections sec on sec.id = o.section_id
        join academic_rooms r on r.id = s.room_id
        left join users f on f.id = o.faculty_user_id
        left join academic_class_changes ch on ch.slot_id = s.id and ch.on_date = w.day and ch.withdrawn_at is null
        left join academic_rooms mr on mr.id = ch.moved_room_id
        left join users sf on sf.id = ch.substitute_id
       where ${scope}
      union all
      select ch.moved_on, s.id, ch.moved_starts, ch.moved_ends, c.code, c.title, sec.label, mr.code,
             coalesce(f.name, f.email), ch.id, 'moved_here', ch.reason, ch.on_date, null, null, null, null
        from academic_class_changes ch
        join academic_slots s on s.id = ch.slot_id
        join academic_offerings o on o.id = s.offering_id
        join academic_courses c on c.id = o.course_id
        join academic_sections sec on sec.id = o.section_id
        join academic_rooms mr on mr.id = ch.moved_room_id
        left join users f on f.id = o.faculty_user_id
       where ch.kind = 'rescheduled' and ch.withdrawn_at is null
         and ch.moved_on between ${days[0]}::date and ${days[6]}::date
         and ${scope}
       order by 1, 3`)
    const hhmm = (t: unknown) => String(t ?? '').slice(0, 5)
    const occurrences: Occurrence[] = (rows.rows as Record<string, unknown>[]).map((r) => {
      const kind = r.kind as string | null
      const status: Occurrence['status'] =
        kind === 'moved_here' ? 'moved_here' : kind === 'cancelled' ? 'cancelled' : kind === 'rescheduled' ? 'moved_away' : kind === 'substitute' ? 'substitute' : 'as_timetabled'
      const note =
        status === 'cancelled'
          ? `Cancelled: ${r.reason}`
          : status === 'moved_away'
            ? `Moved to ${String(r.moved_on).slice(0, 10)} ${hhmm(r.moved_starts)}-${hhmm(r.moved_ends)} in ${r.moved_room}: ${r.reason}`
            : status === 'moved_here'
              ? `Moved here from ${String(r.moved_on).slice(0, 10)}: ${r.reason}`
              : status === 'substitute'
                ? `${r.substitute} takes it: ${r.reason}`
                : null
      return {
        date: String(r.day).slice(0, 10),
        slotId: String(r.slot_id),
        starts: hhmm(r.starts_at),
        ends: hhmm(r.ends_at),
        courseCode: String(r.code),
        courseTitle: String(r.title),
        section: String(r.section),
        room: String(r.room),
        teacher: status === 'substitute' ? (r.substitute as string) : ((r.teacher as string | null) ?? null),
        status,
        note,
        changeId: (r.change_id as string | null) ?? null,
      }
    })
    return { weekOf: days[0]!, days, occurrences }
  })
}

/** Slots the reader may change, for a picker: their own classes, or all for the office. */
export async function changeableSlots(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      select s.id, s.day_of_week, s.starts_at, c.code, sec.label
        from academic_slots s
        join academic_offerings o on o.id = s.offering_id
        join academic_terms t on t.id = o.term_id and t.is_current
        join academic_courses c on c.id = o.course_id
        join academic_sections sec on sec.id = o.section_id
       where ${runs(actor.role) ? sql`true` : sql`o.faculty_user_id = ${actor.id}`}
       order by s.day_of_week, s.starts_at`)
    const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    return (rows.rows as { id: string; day_of_week: number; starts_at: string; code: string; label: string }[]).map((r) => ({
      value: r.id,
      label: `${r.code} ${r.label}, ${DAY[r.day_of_week]} ${String(r.starts_at).slice(0, 5)}`,
    }))
  })
}

export async function teacherChoices(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(sql`${users.role} in ('faculty', 'hod')`))
    return rows.map((u) => ({ value: u.id, label: u.name ?? u.email ?? u.id }))
  })
}
