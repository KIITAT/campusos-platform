import { sql } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { notify } from '@campusos/module-notices/api'
import { entitled, localInstant, localParts, presenceSettings, zoneIn } from './clock'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * The closing sweep (P2-22a, D1333), run every minute by the job worker.
 *
 *  1. a reminder to each student still inside, `closing_reminder_min` before closing;
 *  2. at closing, one `session_unconfirmed` event for each (the hostel is told);
 *  3. `auto_close_after_min` after closing, or at local midnight for a session
 *     from an earlier day, the clock closes the session.
 *
 * The clock is the `now` argument, never SQL `now()`, so a test can set it. A
 * session opened after closing (desk entry is allowed at any hour) gets 1 and 2
 * on the next tick and is closed only by the earlier-day rule.
 */
export async function closingSweep(
  tx: Tx,
  tenant: string,
  now = new Date(),
): Promise<{ reminded: number; reported: number; closed: number }> {
  const none = { reminded: 0, reported: 0, closed: 0 }
  // The job's own transaction, not the global pool (FACTS: a job uses only its tx).
  if (!(await entitled(tx, tenant, 'library'))) return none

  const s = await presenceSettings(tx, tenant)
  const zone = await zoneIn(tx, tenant)
  const { day } = await localParts(tx, now, zone)
  const closesAt = await localInstant(tx, day, s.closesAt, zone)
  const midnight = await localInstant(tx, day, '00:00', zone)
  const nowIso = now.toISOString()

  let reminded = 0
  if (now.getTime() >= closesAt.getTime() - s.closingReminderMin * 60_000) {
    const rows = (await tx.execute(sql`
      update library_sessions set reminder_sent_at = ${nowIso}::timestamptz
       where institution_id = ${tenant} and exited_at is null and reminder_sent_at is null
      returning student_id`)).rows as { student_id: string }[]
    reminded = rows.length
    if (rows.length > 0) {
      await notify(tx, tenant, {
        userIds: rows.map((r) => r.student_id),
        moduleId: 'library',
        title: 'Library closing soon',
        body: `The library closes at ${s.closesAt.slice(0, 5)}. Please check out at the door or the desk.`,
        link: '/m/library/me',
      })
    }
  }

  let reported = 0
  if (now.getTime() >= closesAt.getTime()) {
    const rows = (await tx.execute(sql`
      update library_sessions set unconfirmed_reported_at = ${nowIso}::timestamptz
       where institution_id = ${tenant} and exited_at is null and unconfirmed_reported_at is null
      returning id, student_id`)).rows as { id: string; student_id: string }[]
    reported = rows.length
    for (const r of rows) {
      await tx.execute(sql`
        insert into library_events (institution_id, kind, student_id, session_id, at, method)
        values (${tenant}, 'session_unconfirmed', ${r.student_id}, ${r.id}, ${nowIso}::timestamptz, null)`)
    }
  }

  const graceUntil = new Date(closesAt.getTime() + s.autoCloseAfterMin * 60_000).toISOString()
  const closedRows = (await tx.execute(sql`
    update library_sessions
       set exited_at = greatest(${nowIso}::timestamptz, entered_at), exit_method = 'auto_close'
     where institution_id = ${tenant} and exited_at is null
       and ((${s.autoCloseAfterMin} > 0 and entered_at < ${closesAt.toISOString()}::timestamptz and ${nowIso}::timestamptz >= ${graceUntil}::timestamptz)
            or entered_at < ${midnight.toISOString()}::timestamptz)
    returning id, student_id, exited_at`)).rows as { id: string; student_id: string; exited_at: Date | string }[]
  for (const r of closedRows) {
    await tx.execute(sql`
      insert into library_events (institution_id, kind, student_id, session_id, at, method)
      values (${tenant}, 'session_ended', ${r.student_id}, ${r.id}, ${new Date(r.exited_at).toISOString()}::timestamptz, 'auto_close')`)
  }

  return { ...none, reminded, reported, closed: closedRows.length }
}
