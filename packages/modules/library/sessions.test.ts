import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import {
  LibraryError,
  doorCode,
  doorScan,
  enterSession,
  exitSession,
  setSettings,
  type Actor,
} from './api'
import { encodeQr } from '@campusos/module-attendance/api'
import { events, sessions, settings } from './schema'

const SLUG = 'libsess-test'
const OTHER = 'libsess-other'
const SECRET = 'library-door-secret-for-tests-only-0123456789'
let inst: string
let other: string
const ids = { lib: '', adm: '', s1: '', s2: '' }

const A = (over: Partial<Actor>): Actor => ({
  id: ids.lib,
  email: 'lib@libsess.test',
  role: 'library_staff',
  institutionId: inst,
  ...over,
})
const librarian = () => A({})
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as LibraryError).code
const status = (e: unknown) => (e as LibraryError).status

// 12:00 in India on a fixed day: inside the default 09:00 to 20:00 hours, and the local day is 2026-11-26.
const NOON = new Date('2026-11-26T06:30:00Z')
const at = (hhmmIst: string) => new Date(`2026-11-26T${hhmmIst}:00+05:30`)

async function setAttendance(on: boolean) {
  await authDb
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId: 'attendance', enabled: on })
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: on } })
}

const count = (table: typeof sessions | typeof events) =>
  withTenant(inst, async (tx) => Number((await tx.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n))

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Library Sessions College', allowedEmailDomains: ['libsess.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['libsessother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'lib@libsess.test', institutionId: inst, role: 'library_staff', name: 'Lib' },
      { email: 'adm@libsess.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@libsess.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@libsess.test', institutionId: inst, role: 'student', name: 'Two Student' },
    ])
    .returning({ id: users.id })
  ids.lib = people[0]!.id
  ids.adm = people[1]!.id
  ids.s1 = people[2]!.id
  ids.s2 = people[3]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(events)
    await tx.delete(sessions)
    await tx.delete(settings)
  })
  await setAttendance(true)
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

test('desk entry opens a session and writes a started event', async () => {
  const s = await enterSession(librarian(), { studentId: ids.s1 })
  assert.equal(s.exitedAt, null)
  const rows = await withTenant(inst, (tx) => tx.select().from(sessions))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.entryMethod, 'desk')
  const ev = await withTenant(inst, (tx) => tx.select().from(events))
  assert.equal(ev.length, 1)
  assert.equal(ev[0]!.kind, 'session_started')
  assert.equal(ev[0]!.method, 'desk')
})

test('entering twice returns the same session', async () => {
  const a = await enterSession(librarian(), { studentId: ids.s1 })
  const b = await enterSession(librarian(), { studentId: ids.s1 })
  assert.equal(a.id, b.id)
  assert.equal(await count(sessions), 1)
  assert.equal(await count(events), 1)
})

test('exit closes it and writes an ended event; exit when not inside is 409 not_inside', async () => {
  await enterSession(librarian(), { studentId: ids.s1 })
  const out = await exitSession(librarian(), { studentId: ids.s1 })
  assert.notEqual(out.exitedAt, null)
  assert.equal(out.exitMethod, 'desk')
  const ev = await withTenant(inst, (tx) => tx.select().from(events).orderBy(events.id))
  assert.deepEqual(ev.map((e) => e.kind), ['session_started', 'session_ended'])
  await assert.rejects(
    () => exitSession(librarian(), { studentId: ids.s1 }),
    (e: unknown) => status(e) === 409 && code(e) === 'not_inside',
  )
})

test('two parallel entries make one session', async () => {
  const [a, b] = await Promise.all([
    enterSession(librarian(), { studentId: ids.s2 }),
    enterSession(librarian(), { studentId: ids.s2 }),
  ])
  assert.equal(a.id, b.id)
  assert.equal(await count(sessions), 1)
})

test('door scan in then out', async () => {
  const qr = await doorCode(librarian(), SECRET, NOON)
  const scanned = encodeQr(qr)
  const inn = await doorScan(student(ids.s1), { code: scanned, direction: 'in' }, SECRET, NOON)
  assert.equal(inn.entryMethod, 'door_qr')
  const out = await doorScan(student(ids.s1), { code: scanned, direction: 'out' }, SECRET, NOON)
  assert.equal(out.exitMethod, 'door_qr')
  assert.equal(await count(events), 2)
  await assert.rejects(
    () => doorScan(student(ids.s1), { code: scanned, direction: 'out' }, SECRET, NOON),
    (e: unknown) => code(e) === 'not_inside',
  )
})

test('door scan with a stale code is refused', async () => {
  const qr = await doorCode(librarian(), SECRET, NOON)
  await assert.rejects(
    () => doorScan(student(ids.s1), { code: encodeQr({ ...qr, window: qr.window - 5 }), direction: 'in' }, SECRET, NOON),
    (e: unknown) => code(e) === 'stale_code',
  )
})

test('door scan outside opening hours is 409 library_closed', async () => {
  const late = at('21:00')
  const qr = await doorCode(librarian(), SECRET, late)
  await assert.rejects(
    () => doorScan(student(ids.s1), { code: encodeQr(qr), direction: 'in' }, SECRET, late),
    (e: unknown) => status(e) === 409 && code(e) === 'library_closed',
  )
  // Fifteen minutes before opening is allowed.
  const early = at('08:45')
  const qr2 = await doorCode(librarian(), SECRET, early)
  const s = await doorScan(student(ids.s1), { code: encodeQr(qr2), direction: 'in' }, SECRET, early)
  assert.equal(s.entryMethod, 'door_qr')
})

test('door scan without attendance enabled is 409 door_scan_unavailable', async () => {
  await setAttendance(false)
  await assert.rejects(
    () => doorScan(student(ids.s1), { code: 'a.1.b', direction: 'in' }, SECRET, NOON),
    (e: unknown) => status(e) === 409 && code(e) === 'door_scan_unavailable',
  )
})

test('a student cannot call the desk', async () => {
  await assert.rejects(
    () => enterSession(student(ids.s1), { studentId: ids.s1 }),
    (e: unknown) => status(e) === 403 && code(e) === 'forbidden',
  )
})

test('desk entry for someone who is not a student is 404 no_such_student', async () => {
  await assert.rejects(
    () => enterSession(librarian(), { studentId: ids.adm }),
    (e: unknown) => status(e) === 404 && code(e) === 'no_such_student',
  )
})

test('tenant isolation: a session of one institution is invisible to another', async () => {
  await enterSession(librarian(), { studentId: ids.s1 })
  const seen = await withTenant(other, async (tx) => ({
    sessions: Number((await tx.select({ n: sql<number>`count(*)::int` }).from(sessions))[0]!.n),
    events: Number((await tx.select({ n: sql<number>`count(*)::int` }).from(events))[0]!.n),
  }))
  assert.deepEqual(seen, { sessions: 0, events: 0 })
})

test('settings reject bad hours', async () => {
  const base = {
    loanDays: 14, graceDays: 0, finePerDay: '1', maxConcurrentLoans: 3, maxRenewals: 1,
    blockAtOutstanding: '0', reason: 'door hours test',
  }
  await assert.rejects(() => setSettings(librarian(), { ...base, opensAt: '18:00', closesAt: '09:00' }))
  await assert.rejects(() => setSettings(librarian(), { ...base, closesAt: '08:00' }), (e: unknown) => code(e) === 'bad_input')
  const row = await setSettings(librarian(), { ...base, opensAt: '08:00', closesAt: '21:00', closingReminderMin: 10 })
  assert.equal(row.closingReminderMin, 10)
})
