import { sql } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * The typed boundary the hostel reads (P2-22a, D1344): who is inside, who left
 * lately, and the outbox. Student ids go in as one text-array literal.
 */
const literal = (ids: string[]) => `{${ids.join(',')}}`

export interface LibraryEvent {
  id: number
  kind: 'session_started' | 'session_ended' | 'session_unconfirmed'
  studentId: string
  sessionId: string
  at: Date
  method: string | null
  createdAt: Date
}

/** Students of `studentIds` who are inside now, with the time they came in. */
export async function openSessionsAmong(tx: Tx, studentIds: string[]): Promise<Map<string, Date>> {
  if (studentIds.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select student_id, entered_at from library_sessions
     -- A session still open after the library closed (the closing sweep reported it) is no evidence of presence.
     where exited_at is null and unconfirmed_reported_at is null and student_id = any(${literal(studentIds)}::text[])`)).rows as { student_id: string; entered_at: Date | string }[]
  return new Map(rows.map((r) => [r.student_id, new Date(r.entered_at)]))
}

/** The latest exit the student made themselves (door or desk, not the clock's) since `since`. */
export async function lastExitsAmong(tx: Tx, studentIds: string[], since: Date): Promise<Map<string, Date>> {
  if (studentIds.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select student_id, max(exited_at) as at from library_sessions
     where exited_at >= ${since.toISOString()}::timestamptz and exit_method <> 'auto_close'
       and student_id = any(${literal(studentIds)}::text[])
     group by student_id`)).rows as { student_id: string; at: Date | string }[]
  return new Map(rows.map((r) => [r.student_id, new Date(r.at)]))
}

/**
 * Events after `afterId`, in id order. `settleSeconds` skips the newest rows: an
 * identity value can commit a moment after a later one, and a consumer that
 * reads too soon would move its cursor past it (D1334).
 */
export async function eventsSince(tx: Tx, afterId: number, limit: number, settleSeconds = 0): Promise<LibraryEvent[]> {
  const rows = (await tx.execute(sql`
    select id, kind, student_id, session_id, at, method, created_at from library_events
     where id > ${afterId} and created_at <= now() - make_interval(secs => ${settleSeconds})
     order by id limit ${limit}`)).rows as {
    id: string | number
    kind: LibraryEvent['kind']
    student_id: string
    session_id: string
    at: Date | string
    method: string | null
    created_at: Date | string
  }[]
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    studentId: r.student_id,
    sessionId: r.session_id,
    at: new Date(r.at),
    method: r.method,
    createdAt: new Date(r.created_at),
  }))
}
