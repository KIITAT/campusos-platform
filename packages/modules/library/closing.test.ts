import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { notifications } from '@campusos/module-notices/schema'
import {
  closingSweep,
  enterSession,
  eventsSince,
  exitSession,
  lastExitsAmong,
  openSessionsAmong,
  setSettings,
  type Actor,
} from './api'
import { events, sessions, settings } from './schema'

const SLUG = 'libclose-test'
let inst: string
const ids = { lib: '', s1: '', s2: '' }

const librarian = (): Actor => ({ id: ids.lib, email: 'lib@libclose.test', role: 'library_staff', institutionId: inst })
// Local India time on 2026-11-26, and the day after.
const at = (hhmm: string, day = '26') => new Date(`2026-11-${day}T${hhmm}:00+05:30`)
const sweep = (now: Date) => withTenant(inst, (tx) => closingSweep(tx, inst, now))
const enter = (studentId: string, when: Date) => enterSession(librarian(), { studentId }, when)

const base = {
  loanDays: 14, graceDays: 0, finePerDay: '1', maxConcurrentLoans: 3, maxRenewals: 1,
  blockAtOutstanding: '0', reason: 'closing sweep tests',
}

const eventsOf = (kind: string) =>
  withTenant(inst, (tx) => tx.select().from(events).where(eq(events.kind, kind)).orderBy(events.id))
const rowOf = (studentId: string) =>
  withTenant(inst, async (tx) => (await tx.select().from(sessions).where(eq(sessions.studentId, studentId)))[0]!)
const closingNotes = (userId: string) =>
  withTenant(inst, (tx) => tx.select().from(notifications).where(eq(notifications.userId, userId)))

const setLibrary = (enabled: boolean) =>
  authDb
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId: 'library', enabled })
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled } })

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([{ slug: SLUG, name: 'Closing College', allowedEmailDomains: ['libclose.test'] }])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'lib@libclose.test', institutionId: inst, role: 'library_staff', name: 'Lib' },
      { email: 's1@libclose.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@libclose.test', institutionId: inst, role: 'student', name: 'Two Student' },
    ])
    .returning({ id: users.id })
  ids.lib = people[0]!.id
  ids.s1 = people[1]!.id
  ids.s2 = people[2]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(notifications)
    await tx.delete(events)
    await tx.delete(sessions)
    await tx.delete(settings)
  })
  await setLibrary(true)
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('reminder goes out once, 15 minutes before closing', async () => {
  await enter(ids.s1, at('15:00'))
  assert.equal((await sweep(at('19:44'))).reminded, 0)
  assert.equal((await sweep(at('19:45'))).reminded, 1)
  const notes = await closingNotes(ids.s1)
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.title, 'Library closing soon')
  assert.equal(notes[0]!.body, 'The library closes at 20:00. Please check out at the door or the desk.')
  assert.equal(notes[0]!.moduleId, 'library')
  assert.equal((await sweep(at('19:46'))).reminded, 0)
  assert.equal((await closingNotes(ids.s1)).length, 1)
})

test('unconfirmed event at closing, once', async () => {
  await enter(ids.s1, at('15:00'))
  assert.equal((await sweep(at('19:59'))).reported, 0)
  assert.equal((await sweep(at('20:00'))).reported, 1)
  assert.equal((await sweep(at('20:01'))).reported, 0)
  assert.equal((await eventsOf('session_unconfirmed')).length, 1)
})

test('auto-close 30 minutes after closing', async () => {
  await enter(ids.s1, at('15:00'))
  assert.equal((await sweep(at('20:29'))).closed, 0)
  assert.equal((await rowOf(ids.s1)).exitedAt, null)
  assert.equal((await sweep(at('20:30'))).closed, 1)
  const row = await rowOf(ids.s1)
  assert.equal(row.exitMethod, 'auto_close')
  const ended = await eventsOf('session_ended')
  assert.equal(ended.length, 1)
  assert.equal(ended[0]!.method, 'auto_close')
})

test('auto_close_after_min = 0 never closes on the day', async () => {
  await setSettings(librarian(), { ...base, autoCloseAfterMin: 0 })
  await enter(ids.s1, at('15:00'))
  await sweep(at('23:59'))
  assert.equal((await rowOf(ids.s1)).exitedAt, null)
})

test('a session left from yesterday closes at the first sweep today', async () => {
  await enter(ids.s1, at('15:00'))
  assert.equal((await sweep(at('00:30', '27'))).closed, 1)
  assert.equal((await rowOf(ids.s1)).exitMethod, 'auto_close')
})

test('no reminder for a closed session', async () => {
  await enter(ids.s1, at('15:00'))
  await exitSession(librarian(), { studentId: ids.s1 }, at('18:00'))
  assert.deepEqual(await sweep(at('19:50')), { reminded: 0, reported: 0, closed: 0 })
})

test('a desk entry at 21:00 is not auto-closed at 21:01; the first sweep after local midnight closes it', async () => {
  await enter(ids.s1, at('21:00'))
  assert.deepEqual(await sweep(at('21:01')), { reminded: 1, reported: 1, closed: 0 })
  assert.deepEqual(await sweep(at('21:02')), { reminded: 0, reported: 0, closed: 0 })
  assert.equal((await sweep(at('00:05', '27'))).closed, 1)
})

test('a library that is not enabled for the tenant does nothing', async () => {
  await enter(ids.s1, at('15:00'))
  await setLibrary(false)
  assert.deepEqual(await sweep(at('21:00')), { reminded: 0, reported: 0, closed: 0 })
})

test('feed functions', async () => {
  await enter(ids.s1, at('15:00'))
  await enter(ids.s2, at('15:05'))
  await exitSession(librarian(), { studentId: ids.s2 }, at('16:00'))
  const feed = await withTenant(inst, (tx) => eventsSince(tx, 0, 10))
  assert.deepEqual(feed.map((e) => e.kind), ['session_started', 'session_started', 'session_ended'])
  assert.ok(feed[0]!.id < feed[1]!.id && feed[1]!.id < feed[2]!.id)
  assert.deepEqual((await withTenant(inst, (tx) => eventsSince(tx, feed[0]!.id, 10))).map((e) => e.id), [feed[1]!.id, feed[2]!.id])
  assert.equal((await withTenant(inst, (tx) => eventsSince(tx, 0, 1))).length, 1)

  const open = await withTenant(inst, (tx) => openSessionsAmong(tx, [ids.s1, ids.s2]))
  assert.deepEqual([...open.keys()], [ids.s1])

  // s1 is closed by the clock: that is not an exit the student made.
  await sweep(at('20:30'))
  const exits = await withTenant(inst, (tx) => lastExitsAmong(tx, [ids.s1, ids.s2], at('00:00')))
  assert.deepEqual([...exits.keys()], [ids.s2])
})
