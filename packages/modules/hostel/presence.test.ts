import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, recordGuardianConsent, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { enterSession, exitSession, type Actor as LibActor } from '@campusos/module-library/api'
import { notifications } from '@campusos/module-notices/schema'
import {
  addRooms, addScope, allocate, consumeLibraryEvents, createBlock, derivePresence, grantLeave, loadFacts, setPolicy,
  type Actor,
} from './api'
import {
  allocations, blocks, checkIns, curfewCases, eventCursors, lateStayWindows, latePasses, leaves, policy,
  presenceLog, rooms, visitors, wardenScopes,
} from './schema'

const SLUG = 'hpresence-test'
let inst: string
const ids = { adm: '', lib: '', w1: '', s1: '', s2: '', s3: '', fac: '' }
let blockId = ''
let roomId = ''

const A = (id: string, role: Actor['role']): Actor => ({ id, email: `${id}@hpresence.test`, role, institutionId: inst })
const admin = () => A(ids.adm, 'institution_admin')
const warden = () => A(ids.w1, 'hostel_staff')
const librarian = (): LibActor => ({ id: ids.lib, email: 'lib@hpresence.test', role: 'library_staff', institutionId: inst })

// Monday 2026-11-30, 10:00 India time, for the class tests; the library tests use the real clock.
const MON = new Date('2026-11-30T10:00:00+05:30')
const NIGHT_BEFORE_MON = '2026-11-29'

const facts = (id: string, now = new Date(), night = '2026-11-26') =>
  withTenant(inst, async (tx) => (await loadFacts(tx, inst, [id], now, night)).get(id)!)

const consent = (studentId: string, decision: 'given' | 'withdrawn' = 'given') =>
  withTenant(inst, (tx) =>
    recordGuardianConsent(tx, {
      institutionId: inst, studentId, purpose: 'hostel_presence', decision, basis: 'office_record',
      guardianId: null, recordedBy: ids.adm, note: 'office record for tests',
    }),
  )

const enable = (moduleId: string, enabled = true) =>
  authDb
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId, enabled })
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled } })

const settle = () =>
  withTenant(inst, (tx) => tx.execute(sql`update library_events set created_at = now() - interval '10 seconds'`))
const consume = () => withTenant(inst, (tx) => consumeLibraryEvents(tx, inst))
const logRows = () => withTenant(inst, (tx) => tx.select().from(presenceLog).orderBy(presenceLog.at))
const notesFor = (userId: string) => withTenant(inst, (tx) => tx.select().from(notifications).where(eq(notifications.userId, userId)))

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([{ slug: SLUG, name: 'Presence College', allowedEmailDomains: ['hpresence.test'] }])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hpresence.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'lib@hpresence.test', institutionId: inst, role: 'library_staff', name: 'Lib' },
      { email: 'w1@hpresence.test', institutionId: inst, role: 'hostel_staff', name: 'Warden One' },
      { email: 's1@hpresence.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@hpresence.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 's3@hpresence.test', institutionId: inst, role: 'student', name: 'Three Student' },
      { email: 'fac@hpresence.test', institutionId: inst, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.lib = people[1]!.id
  ids.w1 = people[2]!.id
  ids.s1 = people[3]!.id
  ids.s2 = people[4]!.id
  ids.s3 = people[5]!.id
  ids.fac = people[6]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(notifications)
    await tx.execute(sql`delete from library_events`)
    await tx.execute(sql`delete from library_sessions`)
    for (const t of [presenceLog, curfewCases, latePasses, lateStayWindows, wardenScopes, policy, eventCursors, checkIns, leaves, visitors, allocations, rooms, blocks]) {
      await tx.delete(t)
    }
  })
  await enable('hostel')
  await enable('library')
  // The consent ledger is append-only: start every test from "withdrawn".
  for (const s of [ids.s1, ids.s2, ids.s3]) await consent(s, 'withdrawn')
  blockId = (await createBlock(warden(), { code: 'a', name: 'A Block', kind: 'mens' })).id
  roomId = (await addRooms(warden(), { blockId, numbers: ['101'], floor: 2, capacity: 4 }))[0]!.id
  await allocate(warden(), { roomId, studentId: ids.s1 })
  await allocate(warden(), { roomId, studentId: ids.s2 })
  await addScope(admin(), { userId: ids.w1, level: 'floor', blockId, floor: 2 })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('consent absent: an open library session is not used', async () => {
  await enterSession(librarian(), { studentId: ids.s1 })
  const f = await facts(ids.s1)
  assert.equal(f.libraryOpen, false)
  assert.equal(derivePresence(f).status, 'unknown')
})

test('consent given for a resident: an open session shows In Library', async () => {
  await consent(ids.s1)
  await enterSession(librarian(), { studentId: ids.s1 })
  assert.deepEqual(derivePresence(await facts(ids.s1)), { status: 'in_library', label: 'In Library' })
  // Withdrawn again: back to unknown.
  await consent(ids.s1, 'withdrawn')
  assert.equal(derivePresence(await facts(ids.s1)).status, 'unknown')
})

async function timetable(withSlot: boolean) {
  const adm = admin() as unknown as academic.Actor
  const n = Math.floor(Math.random() * 1e6)
  const dept = await academic.createDepartment(adm, { code: `D${n}`, name: 'Dept' })
  const prog = await academic.createProgram(adm, { departmentId: dept.id, code: `P${n}`, name: 'Prog', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(adm, { code: `T${n}`, name: 'Autumn', startsOn: '2026-08-01', endsOn: '2027-01-31' })
  const room = await academic.createRoom(adm, { code: `R${n}`, capacity: 60 })
  const course = await academic.createCourse(adm, { departmentId: dept.id, code: `C${n}`, title: 'Course', credits: 3 })
  const sec = await academic.createSection(adm, { programId: prog.id, label: 'A', admissionYear: 2025 })
  await academic.addSectionMember(adm, { sectionId: sec.id, userId: ids.s1 })
  const off = await academic.createOffering(adm, { termId: term.id, courseId: course.id, sectionId: sec.id })
  const slot = withSlot ? await academic.createSlot(adm, { offeringId: off.id, roomId: room.id, dayOfWeek: 1, startsAt: '09:00', endsAt: '11:00' }) : null
  return { slot, room }
}

test('in class when a slot runs now; a cancelled or rescheduled slot does not count', async () => {
  await consent(ids.s1)
  const { slot, room } = await timetable(true)
  assert.equal((await facts(ids.s1, MON, NIGHT_BEFORE_MON)).inClass, true)
  assert.equal(derivePresence(await facts(ids.s1, MON, NIGHT_BEFORE_MON)).status, 'in_class')
  // Outside the slot.
  assert.equal((await facts(ids.s1, new Date('2026-11-30T12:00:00+05:30'), NIGHT_BEFORE_MON)).inClass, false)

  await withTenant(inst, (tx) =>
    tx.execute(sql`insert into academic_class_changes (institution_id, slot_id, on_date, kind, reason)
                   values (${inst}, ${slot!.id}, '2026-11-30', 'cancelled', 'cancelled for the test')`),
  )
  assert.equal((await facts(ids.s1, MON, NIGHT_BEFORE_MON)).inClass, false)

  await withTenant(inst, async (tx) => {
    await tx.execute(sql`update academic_class_changes set withdrawn_at = now(), withdrawn_by = ${ids.adm}, withdraw_reason = 'undo for the test' where slot_id = ${slot!.id}`)
  })
  assert.equal((await facts(ids.s1, MON, NIGHT_BEFORE_MON)).inClass, true)
  await withTenant(inst, (tx) =>
    tx.execute(sql`insert into academic_class_changes (institution_id, slot_id, on_date, kind, moved_on, moved_starts, moved_ends, moved_room_id, reason)
                   values (${inst}, ${slot!.id}, '2026-11-30', 'rescheduled', '2026-12-01', '09:00', '11:00', ${room.id}, 'moved for the test')`),
  )
  assert.equal((await facts(ids.s1, MON, NIGHT_BEFORE_MON)).inClass, false)
})

test('without consent a running class is not used', async () => {
  await timetable(true)
  assert.equal((await facts(ids.s1, MON, NIGHT_BEFORE_MON)).inClass, false)
})

test('a leave that covers today shows Out of Campus', async () => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
  await grantLeave(warden(), { studentId: ids.s1, fromOn: today, toOn: today, reason: 'home visit for a wedding' })
  assert.equal(derivePresence(await facts(ids.s1, new Date(), today)).status, 'out_of_campus')
})

test('the consumer logs entry and exit for a consenting resident and writes nothing for the rest', async () => {
  await consent(ids.s1) // s2 is a resident without consent; s3 is not a resident (consent or not)
  await consent(ids.s3)
  for (const s of [ids.s1, ids.s2, ids.s3]) await enterSession(librarian(), { studentId: s })
  await exitSession(librarian(), { studentId: ids.s1 })
  await settle()
  const r = await consume()
  assert.equal(r.read, 4)
  assert.equal(r.logged, 2)
  const rows = await logRows()
  assert.deepEqual(rows.map((x) => [x.studentId, x.kind]).sort(), [[ids.s1, 'library_entered'], [ids.s1, 'library_exited']].sort())
  assert.ok(rows.every((x) => x.source === 'library' && x.sourceRef !== null))

  // Running again changes nothing: the cursor moved, and the unique key backs it up.
  assert.deepEqual(await consume(), { read: 0, logged: 0, notified: 0 })
  assert.equal((await logRows()).length, 2)
  const [cur] = await withTenant(inst, (tx) => tx.select().from(eventCursors))
  assert.ok(cur!.lastId > 0)
  // Rewinding the cursor re-reads the events, and the unique key makes the repeat harmless.
  await withTenant(inst, (tx) => tx.execute(sql`update hostel_event_cursors set last_id = 0`))
  assert.equal((await consume()).logged, 0)
  assert.equal((await logRows()).length, 2)
})

test('the consumer ignores events younger than 5 seconds', async () => {
  await consent(ids.s1)
  await enterSession(librarian(), { studentId: ids.s1 })
  assert.equal((await consume()).read, 0)
  assert.equal((await logRows()).length, 0)
  await settle()
  assert.equal((await consume()).logged, 1)
})

test('an unconfirmed event notifies the floor warden with the closing text', async () => {
  await consent(ids.s1)
  const s = await enterSession(librarian(), { studentId: ids.s1 })
  await withTenant(inst, (tx) =>
    tx.execute(sql`insert into library_events (institution_id, kind, student_id, session_id, at) values (${inst}, 'session_unconfirmed', ${ids.s1}, ${s.id}, now())`),
  )
  await settle()
  const r = await consume()
  assert.equal(r.notified, 1)
  const notes = await notesFor(ids.w1)
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.title, 'Resident still in library')
  assert.equal(notes[0]!.body, 'One Student (a-101) had not checked out when the library closed at 20:00.')
  assert.equal(notes[0]!.moduleId, 'hostel_safety')
  assert.ok((await logRows()).some((x) => x.kind === 'library_unconfirmed'))
})

test('notify_warden_on_library_entry false: entry notifies nobody; true: the floor warden is told', async () => {
  await consent(ids.s1)
  await enterSession(librarian(), { studentId: ids.s1 })
  await settle()
  assert.equal((await consume()).notified, 0)
  assert.equal((await notesFor(ids.w1)).length, 0)

  await setPolicy(admin(), {
    curfewTime: '21:30', nudgeAfterMin: 10, wardenAfterMin: 30, womensWardenAfterMin: 15, guardianAfterMin: 60,
    walkBackMin: 20, caseWindowHours: 6, latePassLatestTime: '01:00', notifyWardenOnLibraryEntry: true,
    presenceRetentionDays: 90, reason: 'tell the warden on entry',
  })
  await exitSession(librarian(), { studentId: ids.s1 })
  await enterSession(librarian(), { studentId: ids.s1 })
  await settle()
  assert.equal((await consume()).notified, 1)
  assert.equal((await notesFor(ids.w1)).length, 1)
})
