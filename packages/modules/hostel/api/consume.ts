import { sql } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { eventsSince } from '@campusos/module-library/api'
import { notify } from '@campusos/module-notices/api'
import { entitled, localParts, zoneIn } from './clock'
import { literal } from './presence'
import { loadPolicy } from './policy'
import { recipientsFor } from './wardens'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const KIND = {
  session_started: 'library_entered',
  session_ended: 'library_exited',
  session_unconfirmed: 'library_unconfirmed',
} as const

/** Events younger than this may still be followed by one with a lower id that has not committed (D1334). */
const SETTLE_SECONDS = 5
const BATCH = 500
/** A warden is not told about an event older than this: after the module was off for a while the backlog is history, not news. */
const STALE_MINUTES = 60

/**
 * Library outbox to hostel timeline (P2-22a, D1334, D1335).
 *
 * At-least-once and idempotent: the cursor row is locked so two workers take
 * turns, every log row has a unique key on its source event, and a warden is
 * told only for a row this run actually inserted. Residents without consent, and
 * people who are not residents, advance the cursor and write nothing.
 */
export async function consumeLibraryEvents(
  tx: Tx,
  tenant: string,
  now = new Date(),
): Promise<{ read: number; logged: number; notified: number }> {
  const none = { read: 0, logged: 0, notified: 0 }
  if (!(await entitled(tx, tenant, 'hostel')) || !(await entitled(tx, tenant, 'library'))) return none
  const [there] = (await tx.execute(sql`select to_regclass('public.library_events') is not null as there`)).rows as { there: boolean }[]
  if (!there?.there) return none

  await tx.execute(sql`insert into hostel_event_cursors (institution_id, source) values (${tenant}, 'library') on conflict do nothing`)
  const [cursor] = (await tx.execute(sql`select last_id from hostel_event_cursors where institution_id = ${tenant} and source = 'library' for update`)).rows as { last_id: string | number }[]
  const events = await eventsSince(tx, Number(cursor!.last_id), BATCH, SETTLE_SECONDS)
  if (events.length === 0) return none

  const ids = literal([...new Set(events.map((e) => e.studentId))])
  const eligible = new Set(
    ((await tx.execute(sql`
      select a.student_id from hostel_allocations a
       where a.vacated_on is null and a.student_id = any(${ids}::text[])
         and exists (select 1 from (
               select distinct on (student_id) student_id, decision from guardian_consents
                where purpose = 'hostel_presence' and student_id = a.student_id
                order by student_id, recorded_at desc, id desc) c
              where c.decision = 'given')`)).rows as { student_id: string }[]).map((r) => r.student_id),
  )

  const policy = await loadPolicy(tx, tenant)
  const zone = await zoneIn(tx, tenant)
  // The library's own closing time, as it would print it (D1346).
  const closesAt = (((await tx.execute(sql`select closes_at::text as t from library_settings where institution_id = ${tenant}`)).rows as { t: string }[])[0]?.t ?? '20:00').slice(0, 5)
  let logged = 0
  let notified = 0
  for (const e of events) {
    if (!eligible.has(e.studentId)) continue
    const kind = KIND[e.kind]
    const inserted = (await tx.execute(sql`
      insert into hostel_presence_log (institution_id, student_id, at, kind, source, source_ref, detail)
      values (${tenant}, ${e.studentId}, ${e.at.toISOString()}::timestamptz, ${kind}, 'library', ${String(e.id)},
              ${JSON.stringify({ sessionId: e.sessionId, method: e.method })}::jsonb)
      on conflict (institution_id, source, source_ref, kind) where source_ref is not null do nothing
      returning id`)).rows
    if (inserted.length === 0) continue
    logged++

    if (now.getTime() - e.at.getTime() > STALE_MINUTES * 60_000) continue
    const unconfirmed = e.kind === 'session_unconfirmed'
    if (!unconfirmed && !(e.kind === 'session_started' && policy.notifyWardenOnLibraryEntry)) continue
    const r = await recipientsFor(tx, tenant, e.studentId, 'floor')
    const where = `${r.studentName} (${r.blockCode}-${r.room})`
    const hhmm = unconfirmed ? closesAt : (await localParts(tx, e.at, zone)).time.slice(0, 5)
    notified += await notify(tx, tenant, {
      userIds: r.userIds,
      moduleId: unconfirmed ? 'hostel_safety' : 'hostel',
      title: unconfirmed ? 'Resident still in library' : 'Resident in library',
      body: unconfirmed
        ? `${where} had not checked out when the library closed at ${hhmm}.`
        : `${where} entered the library at ${hhmm}.`,
      link: '/m/hostel/presence',
    })
  }

  await tx.execute(sql`update hostel_event_cursors set last_id = ${events[events.length - 1]!.id} where institution_id = ${tenant} and source = 'library'`)
  return { read: events.length, logged, notified }
}
