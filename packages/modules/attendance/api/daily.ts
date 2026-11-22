import { sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, withTenant } from '@campusos/db'
import { notify } from '@campusos/module-notices/api'
import { AttendanceError, rulesOf, type Actor } from './operations'

/**
 * A section's register, once a day, kept by its class teacher (P1-13a): the
 * school's roll call beside period attendance. One submission is the whole
 * section -- everyone not ticked absent is present -- and saving again
 * corrects it. Absentees and their guardians are told once.
 */

const MODULE = 'attendance'
/** How far back a register may be marked or corrected, in days (D9). */
export const DAILY_BACKDATE_DAYS = 7

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new AttendanceError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Actor['role']) => r === 'institution_admin' || r === 'super_admin'
const mayKeep = (r: Actor['role']) => isAdmin(r) || r === 'faculty' || r === 'hod'
// One array literal, not one parameter per element (as notices/api/operations.ts).
const literal = (ids: string[]) => `{${ids.join(',')}}`

export const markDaySchema = z
  .object({
    sectionId: z.uuid(),
    onDate: z.iso.date(),
    /** The students absent; everyone else in the section is present. */
    absent: z.preprocess(
      (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]),
      z.array(z.string().min(1)).max(500),
    ),
  })
  .meta({ id: 'AttendanceMarkDay' })

const sheetQuery = z.object({ sectionId: z.uuid().nullable().optional(), onDate: z.iso.date().nullable().optional() })

interface Section { id: string; class_teacher_id: string | null; name: string }
interface Pupil { id: string; name: string; roll_no: string | null }

async function sectionFor(tx: Tx, actor: Actor, sectionId: string): Promise<Section> {
  const [s] = (await tx.execute(sql`
    select s.id, s.class_teacher_id, p.code || '-' || s.label as name
      from academic_sections s join academic_programs p on p.id = s.program_id
     where s.id = ${sectionId}`)).rows as unknown as Section[]
  if (!s) throw new AttendanceError(404, 'no_such_section', 'no such section')
  if (!isAdmin(actor.role) && s.class_teacher_id !== actor.id) {
    throw new AttendanceError(403, 'not_class_teacher', 'only the section’s class teacher marks its daily attendance')
  }
  return s
}

async function today(tx: Tx, tenant: string): Promise<string> {
  const { timeZone } = await rulesOf(tx, tenant)
  const [r] = (await tx.execute(sql`select ((now() at time zone ${timeZone})::date)::text as d`)).rows as { d: string }[]
  return r!.d
}

/** A school section promoted on or before `onDate` keeps its members for the record but is no register (P1-13c): they sit in the next section. */
async function pupilsOf(tx: Tx, sectionId: string, onDate: string): Promise<Pupil[]> {
  return (await tx.execute(sql`
    select u.id, coalesce(u.name, u.email) as name, p.roll_no
      from academic_section_members m
      join users u on u.id = m.user_id and u.role = 'student' and u.erased_at is null
      left join academic_student_profiles p on p.student_id = u.id
     where m.section_id = ${sectionId}
       and not exists (select 1 from academic_sections s where s.id = m.section_id
                          and (s.school_promoted_at at time zone 'Asia/Kolkata')::date <= ${onDate}::date)
     order by p.roll_no nulls last, name, u.id`)).rows as unknown as Pupil[]
}

/** Mark a section's day: everyone not listed absent is present (D10 to D12). */
export async function markDay(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!mayKeep(actor.role)) throw new AttendanceError(403, 'forbidden', 'not permitted')
  const d = markDaySchema.parse(input)
  const absent = new Set(d.absent)
  return withTenant(tenant, async (tx) => {
    const section = await sectionFor(tx, actor, d.sectionId)
    const now = await today(tx, tenant)
    const [ok] = (await tx.execute(sql`
      select ${d.onDate}::date between ${now}::date - ${DAILY_BACKDATE_DAYS}::int and ${now}::date as ok`)).rows as { ok: boolean }[]
    if (!ok!.ok) throw new AttendanceError(400, 'day_out_of_range', `attendance is marked for today or the ${DAILY_BACKDATE_DAYS} days before it`)
    // Two saves of one register serialise here, so an absentee is told once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance.daily:${d.sectionId}:${d.onDate}`}, 0))`)
    const pupils = await pupilsOf(tx, d.sectionId, d.onDate)
    if (pupils.length === 0) throw new AttendanceError(409, 'empty_section', 'the section has no students')
    const ids = new Set(pupils.map((p) => p.id))
    if ([...absent].some((id) => !ids.has(id))) throw new AttendanceError(400, 'not_in_section', 'one of those students is not in this section')
    const before = new Map(
      ((await tx.execute(sql`
        select student_id, present from attendance_daily_marks
         where section_id = ${d.sectionId} and on_date = ${d.onDate}::date`)).rows as { student_id: string; present: boolean }[]).map((r) => [r.student_id, r.present]),
    )
    const corrected = pupils.filter((p) => before.has(p.id) && before.get(p.id) !== !absent.has(p.id)).length
    await tx.execute(sql`
      insert into attendance_daily_marks (institution_id, section_id, on_date, student_id, present, marked_by)
      select ${tenant}::uuid, ${d.sectionId}::uuid, ${d.onDate}::date, x.id, not (x.id = any(${literal([...absent])}::text[])), ${actor.id}
        from unnest(${literal(pupils.map((p) => p.id))}::text[]) as x(id)
      on conflict (section_id, on_date, student_id) do update
         set present = excluded.present, marked_by = excluded.marked_by, marked_at = now()
       where attendance_daily_marks.present is distinct from excluded.present`)

    const newlyAbsent = pupils.filter((p) => absent.has(p.id) && before.get(p.id) !== false)
    if (newlyAbsent.length) {
      const excused = new Set(
        ((await tx.execute(sql`
          select distinct student_id from attendance_excuses
           where student_id = any(${literal(newlyAbsent.map((p) => p.id))}::text[])
             and revoked_at is null and offering_id is null
             and ${d.onDate}::date between from_on and to_on`)).rows as { student_id: string }[]).map((r) => r.student_id),
      )
      const when = new Date(`${d.onDate}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', dateStyle: 'medium' })
      // ponytail: one notify per absentee, as tellAbsentees; batch if a section passes a few hundred.
      for (const p of newlyAbsent) {
        if (excused.has(p.id)) continue
        await notify(tx, tenant, {
          userIds: [p.id],
          moduleId: MODULE,
          title: `Absent on ${when}`,
          body: `${p.name} was marked absent in ${section.name} on ${when}.`,
          link: '/m/attendance/me',
          alsoGuardians: { link: '/m/parents' },
        })
      }
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'attendance.daily_marked',
      entity: 'attendance_daily_marks',
      entityId: `${d.sectionId}:${d.onDate}`,
      reason: `${absent.size} absent of ${pupils.length}; ${corrected} corrected`,
      detail: { sectionId: d.sectionId, onDate: d.onDate, absent: [...absent], corrected },
    })
    const present = pupils.length - absent.size
    return { sectionId: d.sectionId, onDate: d.onDate, present, absent: absent.size, corrected, notice: `Saved: ${present} present, ${absent.size} absent.` }
  })
}

/** The register for one section and day, and the sections the reader keeps (D13). */
export async function dailySheet(actor: Actor, sectionId?: string | null, onDate?: string | null) {
  const tenant = tenantOf(actor)
  if (!mayKeep(actor.role)) throw new AttendanceError(403, 'forbidden', 'not permitted')
  const q = sheetQuery.parse({ sectionId: sectionId || null, onDate: onDate || null })
  return withTenant(tenant, async (tx) => {
    const now = await today(tx, tenant)
    const sections = ((await tx.execute(sql`
      select s.id as value, p.code || '-' || s.label || ' (' || s.admission_year || ')' as label
        from academic_sections s join academic_programs p on p.id = s.program_id
       where ${isAdmin(actor.role)} or s.class_teacher_id = ${actor.id}
       order by s.admission_year desc, p.code, s.label`)).rows as { value: string; label: string }[])
    if (q.sectionId && !sections.some((s) => s.value === q.sectionId)) await sectionFor(tx, actor, q.sectionId)
    const id = q.sectionId ?? sections[0]?.value ?? null
    const day = q.onDate ?? now
    if (!id) return { sections, sectionId: null, onDate: day, today: now, students: [], absent: [] as string[], marked: false }
    const pupils = await pupilsOf(tx, id, day)
    const marks = (await tx.execute(sql`
      select student_id, present from attendance_daily_marks where section_id = ${id} and on_date = ${day}::date`)).rows as { student_id: string; present: boolean }[]
    return {
      sections,
      sectionId: id,
      onDate: day,
      today: now,
      students: pupils.map((p) => ({ value: p.id, label: p.roll_no ? `${p.name} (${p.roll_no})` : p.name })),
      absent: marks.filter((m) => !m.present).map((m) => m.student_id),
      marked: marks.length > 0,
    }
  })
}
