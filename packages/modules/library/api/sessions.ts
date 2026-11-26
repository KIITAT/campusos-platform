import { createHmac } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import {
  cursorColumn,
  finishPage,
  keyset,
  moduleEnabled,
  orderKeys,
  readPage,
  type SortSpec,
} from '@campusos/module-framework'
import { currentQr, decodeQr, verifyToken } from '@campusos/module-attendance/api'
import { manifest as attendanceManifest } from '@campusos/module-attendance/manifest'
import { manifest as libraryManifest } from '../manifest'
import { events, sessions } from '../schema'
import { LibraryError, type Actor } from './operations'
import { localParts, presenceSettings, zoneIn } from './clock'
import { enterSchema, scanSchema } from './schemas'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MODULE = 'library'

/** Same window as the hostel's roll call: a queue at a door is slower than a classroom. */
export const DOOR_WINDOW_SECONDS = 20

/** The door code's secret, derived: one HMAC of AUTH_SECRET per institution, nothing stored (D1329). */
export function libraryDoorSecret(institutionId: string): string {
  const base = process.env.AUTH_SECRET
  if (!base) throw new Error('AUTH_SECRET is required to derive library door tokens')
  return createHmac('sha256', base).update(`library:${institutionId}`).digest('base64url')
}

export const doorKey = (day: string) => `library-door:${day}`

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) throw new LibraryError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}

const isDesk = (a: Actor) => a.role === 'library_staff' || a.role === 'institution_admin' || a.role === 'super_admin'

const requireDesk = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isDesk(actor)) throw new LibraryError(403, 'forbidden', 'not permitted')
  return tenant
}

const requireStudent = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new LibraryError(403, 'forbidden', 'not permitted')
  return tenant
}

export interface SessionRow {
  id: string
  studentId: string
  enteredAt: Date
  exitedAt: Date | null
  entryMethod: string
  exitMethod: string | null
}

const sessionColumns = {
  id: sessions.id,
  studentId: sessions.studentId,
  enteredAt: sessions.enteredAt,
  exitedAt: sessions.exitedAt,
  entryMethod: sessions.entryMethod,
  exitMethod: sessions.exitMethod,
}

/**
 * Take the person's row for update, so two entries for one student queue here
 * and the second sees the first. The partial unique index stays the backstop.
 */
async function lockStudent(tx: Tx, studentId: string): Promise<void> {
  const [row] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, studentId)).for('no key update')
  if (!row || row.role !== 'student') throw new LibraryError(404, 'no_such_student', 'no such student')
}

async function enterWithin(
  tx: Tx,
  tenant: string,
  studentId: string,
  method: 'door_qr' | 'desk',
  by: Actor,
  at: Date,
): Promise<SessionRow & { already: boolean }> {
  await lockStudent(tx, studentId)
  const [open] = await tx.select(sessionColumns).from(sessions).where(and(eq(sessions.studentId, studentId), isNull(sessions.exitedAt)))
  if (open) return { ...open, already: true }
  const [row] = await tx
    .insert(sessions)
    .values({ institutionId: tenant, studentId, enteredAt: at, entryMethod: method, recordedBy: by.id })
    .returning(sessionColumns)
  await tx.insert(events).values({ institutionId: tenant, kind: 'session_started', studentId, sessionId: row!.id, at, method })
  if (method === 'desk') {
    await audit(tx, {
      institutionId: tenant,
      actorId: by.id,
      actorEmail: by.email ?? null,
      moduleId: MODULE,
      action: 'library.session_entered_desk',
      entity: 'library_sessions',
      entityId: row!.id,
      reason: 'desk entry',
      detail: { studentId },
    })
  }
  return { ...row!, already: false }
}

async function exitWithin(
  tx: Tx,
  tenant: string,
  studentId: string,
  method: 'door_qr' | 'desk',
  by: Actor,
  at: Date,
): Promise<SessionRow> {
  await lockStudent(tx, studentId)
  const [open] = await tx.select(sessionColumns).from(sessions).where(and(eq(sessions.studentId, studentId), isNull(sessions.exitedAt)))
  if (!open) throw new LibraryError(409, 'not_inside', 'not inside the library')
  // An entry stamped later than this exit (a clock set back in a test) would break the order check.
  const exitedAt = at < open.enteredAt ? open.enteredAt : at
  const [row] = await tx
    .update(sessions)
    .set({ exitedAt, exitMethod: method, exitRecordedBy: by.id })
    .where(eq(sessions.id, open.id))
    .returning(sessionColumns)
  await tx.insert(events).values({ institutionId: tenant, kind: 'session_ended', studentId, sessionId: open.id, at: exitedAt, method })
  if (method === 'desk') {
    await audit(tx, {
      institutionId: tenant,
      actorId: by.id,
      actorEmail: by.email ?? null,
      moduleId: MODULE,
      action: 'library.session_exited_desk',
      entity: 'library_sessions',
      entityId: open.id,
      reason: 'desk exit',
      detail: { studentId },
    })
  }
  return row!
}

/** Desk entry: a librarian records a student walking in (D1330). Idempotent while the student is inside. */
export async function enterSession(actor: Actor, input: unknown, at = new Date()) {
  const tenant = requireDesk(actor)
  const d = enterSchema.parse(input)
  return withTenant(tenant, (tx) => enterWithin(tx, tenant, d.studentId, 'desk', actor, at))
}

/** Desk exit. Not being inside is a 409, not a silent success: the desk should know its list is off. */
export async function exitSession(actor: Actor, input: unknown, at = new Date()) {
  const tenant = requireDesk(actor)
  const d = enterSchema.parse(input)
  return withTenant(tenant, (tx) => exitWithin(tx, tenant, d.studentId, 'desk', actor, at))
}

const doorAvailable = (tenant: string) => moduleEnabled([libraryManifest, attendanceManifest], 'attendance', tenant)

const unavailable = () => new LibraryError(409, 'door_scan_unavailable', 'Door scan needs the Attendance module; use the desk.')

/** The code for the door screen: today's key, rotating every 20 seconds. */
export async function doorCode(actor: Actor, secret?: string, at = new Date()) {
  const tenant = requireDesk(actor)
  if (!(await doorAvailable(tenant))) throw unavailable()
  const day = await withTenant(tenant, async (tx) => (await localParts(tx, at, await zoneIn(tx, tenant))).day)
  return currentQr(secret ?? libraryDoorSecret(tenant), doorKey(day), DOOR_WINDOW_SECONDS, at.getTime())
}

/** A student scans the door code, in or out (D1329, D1331). */
export async function doorScan(actor: Actor, input: unknown, secret?: string, at = new Date()) {
  const tenant = requireStudent(actor)
  const d = scanSchema.parse(input)
  if (!(await doorAvailable(tenant))) throw unavailable()

  const presented = decodeQr(d.code)
  if (!presented) throw new LibraryError(400, 'malformed_code', 'that code is not readable')

  return withTenant(tenant, async (tx) => {
    const zone = await zoneIn(tx, tenant)
    const { day, time } = await localParts(tx, at, zone)
    if (presented.sessionId !== doorKey(day)) throw new LibraryError(400, 'wrong_code', 'that code is not the library door code')
    const verdict = verifyToken(secret ?? libraryDoorSecret(tenant), presented.sessionId, DOOR_WINDOW_SECONDS, presented, at.getTime())
    if (verdict !== 'ok') throw new LibraryError(409, verdict === 'stale' ? 'stale_code' : 'invalid_code', 'that code is no longer valid')

    const hours = await presenceSettings(tx, tenant)
    const [open] = (await tx.execute(sql`select (${time}::time >= ${hours.opensAt}::time - interval '15 minutes' and ${time}::time < ${hours.closesAt}::time) as open`)).rows as { open: boolean }[]
    if (!open?.open) throw new LibraryError(409, 'library_closed', 'The library is closed.')

    return d.direction === 'in'
      ? enterWithin(tx, tenant, actor.id, 'door_qr', actor, at)
      : exitWithin(tx, tenant, actor.id, 'door_qr', actor, at)
  })
}

const SESSION_SORTS: SortSpec = {
  entered: { dir: 'desc', keys: [{ sql: sql`${sessions.enteredAt}`, type: 'timestamptz' }, { sql: sql`${sessions.id}`, type: 'uuid' }] },
}
export const sessionPage = (req: Request, prefix: string) => readPage(req, prefix, SESSION_SORTS, 'entered', 50)

/** Who is inside now, newest first, a page at a time. */
export async function openSessions(actor: Actor, page = sessionPage(new Request('https://x/'), '')) {
  const tenant = requireDesk(actor)
  const keys = SESSION_SORTS[page.sort]!.keys
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ ...sessionColumns, name: users.name, _cursor: cursorColumn(keys) })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.studentId))
      .where(and(isNull(sessions.exitedAt), keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(sessions).where(isNull(sessions.exitedAt))) as [{ n: number }]
    return finishPage(rows, page, Number(n))
  })
}

/** The headcount for the desk. */
export async function occupancy(actor: Actor) {
  const tenant = requireDesk(actor)
  return withTenant(tenant, async (tx) => {
    const [r] = (await tx.select({ n: sql<number>`count(*)::int` }).from(sessions).where(isNull(sessions.exitedAt))) as [{ n: number }]
    return { inside: Number(r.n) }
  })
}

/** A student's own visits: inside now, and the last twenty. */
export async function mySessions(actor: Actor) {
  const tenant = requireStudent(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select(sessionColumns).from(sessions).where(eq(sessions.studentId, actor.id)).orderBy(desc(sessions.enteredAt)).limit(20)
    return { inside: rows.some((r) => r.exitedAt === null), rows }
  })
}
