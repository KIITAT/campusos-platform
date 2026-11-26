import { sql } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { lastExitsAmong, openSessionsAmong } from '@campusos/module-library/api'
import { addDays, entitled, localParts, zoneIn } from './clock'
import type { PresenceFacts } from './presence-rules'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

// One array literal, not one parameter per element; user ids are Auth.js text ids.
export const literal = (ids: string[]) => `{${ids.join(',')}}`

const date = (v: Date | string) => new Date(v)

/**
 * Everything the rules need about a set of residents, read in a handful of
 * queries (P2-22a, D1322 to D1325). `night` is the hostel night of `now` (D1321);
 * library and class facts are dropped for a resident whose `hostel_presence`
 * consent is not given.
 */
export async function loadFacts(
  tx: Tx,
  tenant: string,
  studentIds: string[],
  now: Date,
  night: string,
): Promise<Map<string, PresenceFacts>> {
  const out = new Map<string, PresenceFacts>()
  if (studentIds.length === 0) return out
  const ids = literal(studentIds)
  const zone = await zoneIn(tx, tenant)
  const { day, time } = await localParts(tx, now, zone)
  const next = await addDays(tx, night, 1)

  const sharing = new Set(
    ((await tx.execute(sql`
      select student_id from (
        select distinct on (student_id) student_id, decision from guardian_consents
         where purpose = 'hostel_presence' and student_id = any(${ids}::text[])
         order by student_id, recorded_at desc, id desc) c
       where decision = 'given'`)).rows as { student_id: string }[]).map((r) => r.student_id),
  )

  const checkedIn = new Set(
    ((await tx.execute(sql`
      select distinct student_id from hostel_check_ins
       where student_id = any(${ids}::text[]) and status in ('present', 'on_leave')
         and (on_night = ${night}::date
              or (on_night = ${next}::date and recorded_at < ((${next}::date + time '12:00') at time zone ${zone})))`)).rows as { student_id: string }[]).map((r) => r.student_id),
  )

  const onLeave = new Set(
    ((await tx.execute(sql`
      select distinct student_id from hostel_leaves
       where student_id = any(${ids}::text[])
         and ((from_on <= ${night}::date and to_on >= ${night}::date) or (from_on <= ${day}::date and to_on >= ${day}::date))`)).rows as { student_id: string }[]).map((r) => r.student_id),
  )

  const passes = new Map(
    ((await tx.execute(sql`
      select student_id, max(until_at) as until_at from hostel_late_passes
       where student_id = any(${ids}::text[]) and night = ${night}::date and status = 'approved'
       group by student_id`)).rows as { student_id: string; until_at: Date | string }[]).map((r) => [r.student_id, date(r.until_at)]),
  )

  let open = new Map<string, Date>()
  let exits = new Map<string, Date>()
  if (await entitled(tx, tenant, 'library')) {
    open = await openSessionsAmong(tx, studentIds)
    exits = await lastExitsAmong(tx, studentIds, new Date(now.getTime() - 90 * 60_000))
  }

  const inClass = new Set<string>()
  const [there] = (await tx.execute(sql`select to_regclass('public.academic_slots') is not null as there`)).rows as { there: boolean }[]
  if (there?.there) {
    const rows = (await tx.execute(sql`
      select distinct m.user_id
        from academic_section_members m
        join academic_offerings o on o.section_id = m.section_id
        join academic_terms t on t.id = o.term_id and ${day}::date between t.starts_on and t.ends_on
        join academic_slots s on s.offering_id = o.id and s.day_of_week = extract(isodow from ${day}::date)
       where m.user_id = any(${ids}::text[]) and ${time}::time >= s.starts_at and ${time}::time < s.ends_at
         and not exists (select 1 from academic_class_changes c
                          where c.slot_id = s.id and c.on_date = ${day}::date and c.kind in ('cancelled', 'rescheduled') and c.withdrawn_at is null)`)).rows as { user_id: string }[]
    for (const r of rows) inClass.add(r.user_id)
  }

  for (const id of studentIds) {
    const share = sharing.has(id)
    out.set(id, {
      sharing: share,
      checkedIn: checkedIn.has(id),
      onLeave: onLeave.has(id),
      lateUntil: passes.get(id) ?? null,
      libraryOpen: share && open.has(id),
      libraryLastExit: share ? (exits.get(id) ?? null) : null,
      inClass: share && inClass.has(id),
      pastCurfew: false,
    })
  }
  return out
}
