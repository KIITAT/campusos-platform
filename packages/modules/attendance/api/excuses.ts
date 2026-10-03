import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import * as z from 'zod'
import { audit, users, withTenant } from '@campusos/db'
import { courses, offerings, sections } from '@campusos/module-academic/schema'
import { excuses, settings } from '../schema'
import { AttendanceError, line, rulesOf, type Actor, type AttendanceLine } from './operations'

/**
 * Excused absence, the institution's attendance rules, and the absentees in a
 * class -- KIIT's "No. of Excuses" column, and its faculty self-service "view
 * the absentees in his/her subject".
 */

const MODULE = 'attendance'
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new AttendanceError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Actor['role']) => r === 'institution_admin' || r === 'super_admin'
const runs = (r: Actor['role']) => isAdmin(r) || r === 'hod'

export const rulesSchema = z
  .object({
    minimumPercent: z.coerce.number().int().min(0).max(100),
    excusedCounts: z.preprocess((v) => (v === 'true' || v === 'on' ? true : v === 'false' ? false : v), z.boolean()),
    timeZone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  })
  .meta({ id: 'AttendanceRules' })

export const grantExcuseSchema = z
  .object({
    studentId: z.string().min(1),
    /** One class, or every class when left out. */
    offeringId: z.preprocess(blank, z.uuid().optional()),
    fromOn: z.iso.date(),
    toOn: z.iso.date(),
    kind: z.enum(['medical', 'on_duty', 'leave', 'other']),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'AttendanceExcuseGrant' })

export const revokeExcuseSchema = z
  .object({ excuseId: z.uuid(), reason: z.string().trim().min(5).max(500) })
  .meta({ id: 'AttendanceExcuseRevoke' })

const REFUSALS: Record<string, [400 | 403 | 409, string]> = {
  attendance_excuse_student: [400, 'an excuse is for a student'],
  attendance_excuse_class: [400, 'that is not one of the student’s classes'],
  attendance_excuse_fixed: [409, 'an excuse is only revoked, once'],
  attendance_excuse_kept: [409, 'an excuse is revoked, not deleted'],
  attendance_excuses_dates: [400, 'an excuse ends on or after the day it starts'],
  attendance_excuses_source: [409, 'that is already excused'],
  attendance_settings_minimum: [400, 'a minimum between 0 and 100'],
}

function named(e: unknown): never {
  const c = (e as { cause?: { constraint?: string } }).cause?.constraint
  const known = c ? REFUSALS[c] : undefined
  if (known) throw new AttendanceError(known[0] as 400 | 403 | 409, c!, known[1])
  throw e
}

// --- rules ------------------------------------------------------------------------

export async function attendanceRules(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) => rulesOf(tx, tenant))
}

export async function setAttendanceRules(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new AttendanceError(403, 'forbidden', 'not permitted')
  const d = rulesSchema.parse(input)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: d.timeZone })
  } catch {
    throw new AttendanceError(400, 'bad_time_zone', `${d.timeZone} is not a time zone`)
  }
  return withTenant(tenant, async (tx) => {
    const values = { minimumPercent: d.minimumPercent, excusedCounts: d.excusedCounts, timeZone: d.timeZone }
    await tx.insert(settings).values({ institutionId: tenant, ...values }).onConflictDoUpdate({ target: settings.institutionId, set: values }).catch(named)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'attendance.rules',
      entity: 'attendance_settings',
      entityId: tenant,
      reason: `minimum ${d.minimumPercent}%, excused ${d.excusedCounts ? 'counts' : 'does not count'}, ${d.timeZone}`,
    })
    return { notice: 'Saved. Every figure is read by the new rule from now.' }
  })
}

// --- excuses ------------------------------------------------------------------------

export interface ExcuseInput {
  studentId: string
  offeringId?: string | null
  fromOn: string
  toOn: string
  kind: 'medical' | 'on_duty' | 'leave' | 'other'
  reason: string
  sourceModule?: string
  sourceId?: string
}

/** Excuse absence in the caller's transaction: what mentoring does for approved leave. */
export async function excuseWithin(tx: Tx, tenant: string, grantedBy: string, x: ExcuseInput) {
  try {
    const [row] = await tx
      .insert(excuses)
      .values({
        institutionId: tenant,
        studentId: x.studentId,
        offeringId: x.offeringId ?? null,
        fromOn: x.fromOn,
        toOn: x.toOn,
        kind: x.kind,
        reason: x.reason,
        grantedBy,
        sourceModule: x.sourceModule ?? null,
        sourceId: x.sourceId ?? null,
      })
      .returning({ id: excuses.id })
    return row!.id
  } catch (e) {
    named(e)
  }
}

/** Take back what another module excused, when the reason for it is withdrawn there. */
export async function revokeExcuseForSourceWithin(tx: Tx, sourceModule: string, sourceId: string, revokedBy: string, reason: string) {
  const rows = await tx
    .update(excuses)
    .set({ revokedAt: new Date(), revokedBy, revokeReason: reason })
    .where(and(eq(excuses.sourceModule, sourceModule), eq(excuses.sourceId, sourceId), isNull(excuses.revokedAt)))
    .returning({ id: excuses.id })
  return rows.length
}

/**
 * Who may excuse: the office for any class or for all of a student's classes;
 * a teacher for their own class only.
 */
async function assertMayExcuse(tx: Tx, actor: Actor, offeringId: string | null | undefined) {
  if (runs(actor.role)) return
  if (actor.role !== 'faculty' || !offeringId) throw new AttendanceError(403, 'forbidden', 'a teacher excuses absence from their own class')
  const [o] = await tx.select({ faculty: offerings.facultyUserId }).from(offerings).where(eq(offerings.id, offeringId))
  if (o?.faculty !== actor.id) throw new AttendanceError(403, 'not_your_class', 'that is not your class')
}

export async function grantExcuse(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = grantExcuseSchema.parse(input)
  if (d.toOn < d.fromOn) throw new AttendanceError(400, 'attendance_excuses_dates', 'an excuse ends on or after the day it starts')
  return withTenant(tenant, async (tx) => {
    await assertMayExcuse(tx, actor, d.offeringId)
    const id = await excuseWithin(tx, tenant, actor.id, d)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'attendance.excused',
      entity: 'attendance_excuses',
      entityId: id,
      reason: d.reason,
    })
    return { id, notice: `Excused, ${d.fromOn} to ${d.toOn}.` }
  })
}

export async function revokeExcuse(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = revokeExcuseSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [x] = await tx.select().from(excuses).where(eq(excuses.id, d.excuseId))
    if (!x) throw new AttendanceError(404, 'no_such_excuse', 'no such excuse')
    await assertMayExcuse(tx, actor, x.offeringId)
    if (x.sourceModule) throw new AttendanceError(409, 'not_ours', `that was excused by ${x.sourceModule}; withdraw it there`)
    await tx
      .update(excuses)
      .set({ revokedAt: new Date(), revokedBy: actor.id, revokeReason: d.reason })
      .where(eq(excuses.id, d.excuseId))
      .catch(named)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'attendance.excuse_revoked',
      entity: 'attendance_excuses',
      entityId: d.excuseId,
      reason: d.reason,
    })
    return { notice: 'Revoked. Those classes count as absent again.' }
  })
}

/** Excuses: a student's own, a teacher's classes', or everybody's for the office. */
export async function listExcuses(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const scope =
      actor.role === 'student'
        ? eq(excuses.studentId, actor.id)
        : runs(actor.role)
          ? undefined
          : actor.role === 'faculty'
            ? sql`${excuses.offeringId} in (select id from academic_offerings where faculty_user_id = ${actor.id})`
            : sql`false`
    const granter = alias(users, 'granter')
    const rows = await tx
      .select({ x: excuses, student: users.name, email: users.email, course: courses.code, by: granter.name, byEmail: granter.email })
      .from(excuses)
      .innerJoin(users, eq(users.id, excuses.studentId))
      .leftJoin(granter, eq(granter.id, excuses.grantedBy))
      .leftJoin(offerings, eq(offerings.id, excuses.offeringId))
      .leftJoin(courses, eq(courses.id, offerings.courseId))
      .where(scope)
      .orderBy(desc(excuses.fromOn))
    return rows.map((r) => {
      const who = r.by ?? r.byEmail ?? 'the office'
      return {
        ...r.x,
        student: r.student ?? r.email ?? r.x.studentId,
        course: r.course ?? 'every class',
        state: r.x.revokedAt ? 'revoked' : 'excused',
        by: r.x.sourceModule ? `${who}, approving leave in ${r.x.sourceModule}` : who,
      }
    })
  })
}

// --- a class's absentees --------------------------------------------------------------

/**
 * Everybody in a class, their attendance by the institution's rule, those short
 * of the minimum first; and who missed the last session. For the teacher of the
 * class and the office.
 */
export async function classAbsentees(actor: Actor, offeringId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [o] = await tx
      .select({ id: offerings.id, faculty: offerings.facultyUserId, code: courses.code, title: courses.title, section: sections.label })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .where(eq(offerings.id, offeringId))
    if (!o) throw new AttendanceError(404, 'no_such_class', 'no such class')
    if (!runs(actor.role) && !(actor.role === 'faculty' && o.faculty === actor.id)) {
      throw new AttendanceError(403, 'not_your_class', 'that is not your class')
    }
    const rules = await rulesOf(tx, tenant)
    const rows = await tx.execute(sql`
      select u.id as student_id, coalesce(u.name, u.email) as name, p.roll_no,
             (select count(*)::int from attendance_sessions s where s.offering_id = o.id) as held,
             (select count(*)::int from attendance_records r join attendance_sessions s on s.id = r.session_id
               where s.offering_id = o.id and r.student_id = u.id) as present,
             (select count(*)::int from attendance_sessions s
               where s.offering_id = o.id
                 and not exists (select 1 from attendance_records r where r.session_id = s.id and r.student_id = u.id)
                 and exists (select 1 from attendance_excuses e
                              where e.student_id = u.id and e.revoked_at is null
                                and (e.offering_id is null or e.offering_id = o.id)
                                and (s.opened_at at time zone ${rules.timeZone})::date between e.from_on and e.to_on)) as excused
        from academic_offerings o
        join academic_section_members m on m.section_id = o.section_id
        join users u on u.id = m.user_id and u.role = 'student'
        left join academic_student_profiles p on p.student_id = u.id
       where o.id = ${offeringId}
       order by name`)
    const students = (rows.rows as { student_id: string; name: string; roll_no: string | null; held: number; present: number; excused: number }[]).map((r) => {
      const l: AttendanceLine = line({ offering_id: offeringId, code: o.code, title: o.title, teacher: null, term: '', ...r }, rules)
      return { studentId: r.student_id, name: r.name, rollNo: r.roll_no, ...l }
    })
    students.sort((a, b) => Number(b.short) - Number(a.short) || (a.percent ?? 101) - (b.percent ?? 101))
    const last = await tx.execute(sql`
      select s.id, s.opened_at,
             array(select coalesce(u.name, u.email) from academic_section_members m
                     join users u on u.id = m.user_id and u.role = 'student'
                    where m.section_id = o.section_id
                      and not exists (select 1 from attendance_records r where r.session_id = s.id and r.student_id = u.id)
                    order by 1) as missing
        from attendance_sessions s join academic_offerings o on o.id = s.offering_id
       where s.offering_id = ${offeringId}
       order by s.opened_at desc limit 1`)
    const ls = last.rows[0] as { id: string; opened_at: Date; missing: string[] } | undefined
    return {
      class: { id: o.id, course: `${o.code} ${o.title}`, section: o.section },
      rules,
      students,
      short: students.filter((s) => s.short).length,
      lastSession: ls ? { openedAt: new Date(ls.opened_at), missing: ls.missing } : null,
    }
  })
}

/** The classes a reader may look into: their own, or every one for the office. */
export async function classChoices(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: offerings.id, code: courses.code, section: sections.label })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .where(
        and(
          sql`${offerings.termId} in (select id from academic_terms where is_current)`,
          runs(actor.role) ? undefined : eq(offerings.facultyUserId, actor.id),
        ),
      )
    return rows.map((r) => ({ value: r.id, label: `${r.code} ${r.section}` }))
  })
}

/** Students a reader may excuse: every student for the office, a teacher's own students. */
export async function excusableStudents(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      select distinct u.id, coalesce(u.name, u.email) as name, p.roll_no
        from users u
        left join academic_student_profiles p on p.student_id = u.id
       where u.role = 'student'
         and (${runs(actor.role)} or exists (
               select 1 from academic_section_members m
                 join academic_offerings o on o.section_id = m.section_id and o.faculty_user_id = ${actor.id}
                where m.user_id = u.id))
       order by name`)
    return (rows.rows as { id: string; name: string; roll_no: string | null }[]).map((r) => ({
      value: r.id,
      label: r.roll_no ? `${r.name} (${r.roll_no})` : r.name,
    }))
  })
}
