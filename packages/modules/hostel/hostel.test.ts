import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import {
  auditLog,
  authDb,
  db,
  institutionModules,
  institutions,
  users,
  withTenant,
} from '@campusos/db'
import {
  HostelError,
  ROLL_CALL_WINDOW_SECONDS,
  addRooms,
  allocate,
  createBlock,
  encodeQr,
  grantLeave,
  listRooms,
  mark,
  myHostel,
  rollCall,
  rollCallCode,
  rollCallMode,
  scanCheckIn,
  vacate,
  visitorIn,
  visitorLog,
  visitorOut,
  type Actor,
} from './api'
import { allocations, blocks, checkIns, leaves, rooms, visitors } from './schema'

const SLUG = 'hostel-test'
const OTHER = 'hostel-other'
const SECRET = 'roll-call-secret-for-tests-only-0123456789'
let inst: string
let other: string
const ids = { warden: '', adm: '', s1: '', s2: '', s3: '', fac: '' }
let blockId = ''
let roomA = ''
let roomB = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.warden,
  email: 'warden@hostel.test',
  role: 'hostel_staff',
  institutionId: inst,
  ...over,
})
const warden = () => A({})
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as HostelError).code
const status = (e: unknown) => (e as HostelError).status

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

const today = () => new Date().toISOString().slice(0, 10)

/** Turn the Attendance entitlement on or off for this institution. */
async function setAttendance(on: boolean) {
  await db
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId: 'attendance', enabled: on })
    .onConflictDoUpdate({
      target: [institutionModules.institutionId, institutionModules.moduleId],
      set: { enabled: on },
    })
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Hostel College', allowedEmailDomains: ['hostel.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['hostelother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'warden@hostel.test', institutionId: inst, role: 'hostel_staff', name: 'Warden' },
      { email: 'adm@hostel.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@hostel.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@hostel.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 's3@hostel.test', institutionId: inst, role: 'student', name: 'Three Student' },
      { email: 'fac@hostel.test', institutionId: inst, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  ids.warden = people[0]!.id
  ids.adm = people[1]!.id
  ids.s1 = people[2]!.id
  ids.s2 = people[3]!.id
  ids.s3 = people[4]!.id
  ids.fac = people[5]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(checkIns)
    await tx.delete(leaves)
    await tx.delete(visitors)
    await tx.delete(allocations)
    await tx.delete(rooms)
    await tx.delete(blocks)
    await tx.delete(auditLog)
  })
  await setAttendance(false)

  const b = await createBlock(warden(), { code: 'a', name: 'A Block', kind: 'mens' })
  blockId = b.id
  const made = await addRooms(warden(), {
    blockId,
    numbers: ['101', '102'],
    floor: 1,
    capacity: 2,
  })
  roomA = made[0]!.id
  roomB = made[1]!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- who may do what -------------------------------------------------------

test('a student cannot create a block or allocate a bed', async () => {
  await assert.rejects(
    () => createBlock(student(ids.s1), { code: 'x', name: 'X' }),
    (e: unknown) => status(e) === 403,
  )
  await assert.rejects(
    () => allocate(student(ids.s1), { roomId: roomA, studentId: ids.s1 }),
    (e: unknown) => status(e) === 403,
  )
})

test('a student sees their own room and not another student s', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const mine = await myHostel(student(ids.s1))
  assert.equal(mine.roomNumber, '101')
  await assert.rejects(
    () => myHostel(student(ids.s1), ids.s2),
    (e: unknown) => status(e) === 403,
  )
})

// --- allocation ------------------------------------------------------------

test('a room fills to capacity and then refuses', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await allocate(warden(), { roomId: roomA, studentId: ids.s2 })
  await assert.rejects(
    () => allocate(warden(), { roomId: roomA, studentId: ids.s3 }),
    saysDb(/that room is full/),
  )
})

test('the database refuses an over-allocation even with the app check bypassed', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await allocate(warden(), { roomId: roomA, studentId: ids.s2 })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(allocations).values({
          institutionId: inst,
          roomId: roomA,
          studentId: ids.s3,
          allocatedOn: today(),
        }),
      ),
    saysDb(/that room is full/),
  )
})

test('a student cannot hold two beds at once', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await assert.rejects(
    () => allocate(warden(), { roomId: roomB, studentId: ids.s1 }),
    (e: unknown) => code(e) === 'already_allocated',
  )
  // ...and the database says so too
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(allocations).values({
          institutionId: inst,
          roomId: roomB,
          studentId: ids.s1,
          allocatedOn: today(),
        }),
      ),
    saysDb(/hostel_allocations_one_open|duplicate key/),
  )
})

test('only a student is allocated a bed', async () => {
  await assert.rejects(
    () => allocate(warden(), { roomId: roomA, studentId: ids.fac }),
    (e: unknown) => code(e) === 'not_a_student',
  )
})

test('vacating frees the bed, is audited, and keeps the history', async () => {
  const a = await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await allocate(warden(), { roomId: roomA, studentId: ids.s2 })
  await vacate(warden(), { allocationId: a.id, reason: 'moved to the new block' })

  const free = await allocate(warden(), { roomId: roomA, studentId: ids.s3 })
  assert.ok(free.id)

  const rowsNow = await listRooms(warden(), blockId)
  const room = rowsNow.find((r) => r.id === roomA)!
  assert.equal(room.occupied, 2)

  const trail = await withTenant(inst, (tx) =>
    tx.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog),
  )
  assert.equal(trail[0]!.action, 'hostel.vacated')
  assert.match(trail[0]!.reason!, /new block/)

  // The closed allocation is still there: who slept where is a record.
  const history = await withTenant(inst, (tx) =>
    tx.select().from(allocations).where(eq(allocations.studentId, ids.s1)),
  )
  assert.equal(history.length, 1)
  assert.ok(history[0]!.vacatedOn)
})

test('vacating twice is refused', async () => {
  const a = await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await vacate(warden(), { allocationId: a.id, reason: 'left the hostel' })
  await assert.rejects(
    () => vacate(warden(), { allocationId: a.id, reason: 'left again somehow' }),
    (e: unknown) => code(e) === 'already_vacated',
  )
})

test('an allocation cannot be re-pointed at another student without a reason', async () => {
  const a = await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(allocations).set({ studentId: ids.s2 }).where(eq(allocations.id, a.id)),
      ),
    saysDb(/cannot be re-pointed/),
  )
})

// --- leave -----------------------------------------------------------------

test('overlapping leave for one student is refused by the database', async () => {
  await grantLeave(warden(), {
    studentId: ids.s1,
    fromOn: '2026-10-04',
    toOn: '2026-10-08',
    reason: 'family wedding at home',
  })
  await assert.rejects(
    () =>
      grantLeave(warden(), {
        studentId: ids.s1,
        fromOn: '2026-10-08',
        toOn: '2026-10-10',
        reason: 'overlaps the last day',
      }),
    saysDb(/hostel_leaves_no_overlap|conflicting key/),
  )
  // Adjacent, not overlapping, is fine.
  const ok = await grantLeave(warden(), {
    studentId: ids.s1,
    fromOn: '2026-10-09',
    toOn: '2026-10-11',
    reason: 'travel back the long way',
  })
  assert.ok(ok.id)
})

test('two students may be on leave over the same dates', async () => {
  const span = { fromOn: '2026-11-01', toOn: '2026-11-05', reason: 'diwali break at home' }
  await grantLeave(warden(), { studentId: ids.s1, ...span })
  const ok = await grantLeave(warden(), { studentId: ids.s2, ...span })
  assert.ok(ok.id)
})

// --- roll call -------------------------------------------------------------

test('without Attendance the roll call is manual, and says so', async () => {
  assert.equal(await rollCallMode(inst), 'manual')
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })

  const r = await rollCall(warden(), blockId)
  assert.equal(r.mode, 'manual')
  assert.equal(r.rows.length, 1)
  assert.equal(r.unmarked, 1)

  // ...and the QR refuses rather than handing back a code nobody can scan
  await assert.rejects(
    () => rollCallCode(warden(), blockId, SECRET),
    (e: unknown) => code(e) === 'attendance_not_enabled',
  )
})

test('with Attendance enabled the same block switches to scan', async () => {
  await setAttendance(true)
  assert.equal(await rollCallMode(inst), 'scan')
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })

  const r = await rollCall(warden(), blockId)
  assert.equal(r.mode, 'scan')

  const qr = await rollCallCode(warden(), blockId, SECRET)
  assert.equal(qr.sessionId, `${blockId}:${today()}`)
  assert.ok(qr.token.length > 0)
})

test('a resident scans in and is marked present', async () => {
  await setAttendance(true)
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const qr = await rollCallCode(warden(), blockId, SECRET)

  const row = await scanCheckIn(student(ids.s1), { code: encodeQr(qr), blockId }, SECRET)
  assert.equal(row.status, 'present')
  assert.equal(row.method, 'scan')

  const r = await rollCall(warden(), blockId)
  assert.equal(r.present, 1)
  assert.equal(r.unmarked, 0)
})

test('a code from another block does not work here', async () => {
  await setAttendance(true)
  const b2 = await createBlock(warden(), { code: 'b', name: 'B Block' })
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const qr = await rollCallCode(warden(), b2.id, SECRET)

  await assert.rejects(
    () => scanCheckIn(student(ids.s1), { code: encodeQr(qr), blockId }, SECRET),
    (e: unknown) => code(e) === 'wrong_block',
  )
})

test('a forged code is refused', async () => {
  await setAttendance(true)
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const qr = await rollCallCode(warden(), blockId, SECRET)

  await assert.rejects(
    () =>
      scanCheckIn(
        student(ids.s1),
        { code: encodeQr({ ...qr, token: 'aaaaaaaaaaaa' }), blockId },
        SECRET,
      ),
    (e: unknown) => code(e) === 'invalid_code',
  )
})

test('a code from a past window is stale, not accepted forever', async () => {
  await setAttendance(true)
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const qr = await rollCallCode(warden(), blockId, SECRET)

  await assert.rejects(
    () =>
      scanCheckIn(
        student(ids.s1),
        { code: encodeQr({ ...qr, window: qr.window - 5 }), blockId },
        SECRET,
      ),
    (e: unknown) => code(e) === 'stale_code',
  )
  assert.equal(ROLL_CALL_WINDOW_SECONDS, 20)
})

test('scanning without the Attendance module is refused outright', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await assert.rejects(
    () => scanCheckIn(student(ids.s1), { code: 'a.1.b', blockId }, SECRET),
    (e: unknown) => code(e) === 'attendance_not_enabled',
  )
})

test('the manual register works whether or not Attendance is enabled', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const row = await mark(warden(), { blockId, studentId: ids.s1, status: 'absent', note: 'bed empty at 23:00' })
  assert.equal(row.status, 'absent')
  assert.equal(row.method, 'manual')

  const r = await rollCall(warden(), blockId)
  assert.equal(r.absent, 1)
})

test('a warden can correct a scan, but a scan cannot overwrite a warden', async () => {
  await setAttendance(true)
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const qr = await rollCallCode(warden(), blockId, SECRET)
  await scanCheckIn(student(ids.s1), { code: encodeQr(qr), blockId }, SECRET)

  // The warden saw the bed empty: the register overrides the scan.
  const corrected = await mark(warden(), {
    blockId,
    studentId: ids.s1,
    status: 'absent',
    note: 'scanned at the gate then left',
  })
  assert.equal(corrected.status, 'absent')

  // A second scan cannot quietly undo that.
  await assert.rejects(
    () => scanCheckIn(student(ids.s1), { code: encodeQr(qr), blockId }, SECRET),
    (e: unknown) => code(e) === 'already_marked',
  )
  assert.equal((await rollCall(warden(), blockId)).absent, 1)
})

test('a student not resident in the block cannot be marked there', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await assert.rejects(
    () => mark(warden(), { blockId, studentId: ids.s2, status: 'present' }),
    saysDb(/not resident in this block/),
  )
})

test('leave shows on the roll call, so an empty bed is expected not missing', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await grantLeave(warden(), {
    studentId: ids.s1,
    fromOn: today(),
    toOn: today(),
    reason: 'medical appointment at home',
  })
  const r = await rollCall(warden(), blockId)
  assert.equal(r.rows[0]!.onLeave, true)
  assert.equal(r.onLeave, 1)
  assert.equal(r.unmarked, 0, 'a student on leave is not an unexplained gap')
})

test('the roll call lists every resident, marked or not', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await allocate(warden(), { roomId: roomB, studentId: ids.s2 })
  await mark(warden(), { blockId, studentId: ids.s1, status: 'present' })

  const r = await rollCall(warden(), blockId)
  assert.equal(r.rows.length, 2)
  assert.equal(r.present, 1)
  assert.equal(r.unmarked, 1)
})

test('a student who has moved out does not appear on tonight s roll call', async () => {
  const a = await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await vacate(warden(), { allocationId: a.id, reason: 'left at the end of term' })
  assert.equal((await rollCall(warden(), blockId)).rows.length, 0)
})

// --- visitors --------------------------------------------------------------

test('a visitor is signed in and out, and the open register shows who is inside', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const v = await visitorIn(warden(), {
    blockId,
    studentId: ids.s1,
    name: 'A Parent',
    phone: '9000000000',
    relation: 'father',
  })
  assert.equal((await visitorLog(warden(), blockId, true)).length, 1)

  await visitorOut(warden(), { visitorId: v.id })
  assert.equal((await visitorLog(warden(), blockId, true)).length, 0)
  assert.equal((await visitorLog(warden(), blockId)).length, 1)
})

test('signing a visitor out twice is refused', async () => {
  const v = await visitorIn(warden(), { blockId, name: 'A Visitor' })
  await visitorOut(warden(), { visitorId: v.id })
  await assert.rejects(
    () => visitorOut(warden(), { visitorId: v.id }),
    (e: unknown) => code(e) === 'already_out',
  )
})

test('a student cannot read the visitor register', async () => {
  await assert.rejects(
    () => visitorLog(student(ids.s1)),
    (e: unknown) => status(e) === 403,
  )
})

// --- the student's own view ------------------------------------------------

test('my hostel shows the room, the roommates and the nights', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  await allocate(warden(), { roomId: roomA, studentId: ids.s2 })
  await mark(warden(), { blockId, studentId: ids.s1, status: 'present' })

  const mine = await myHostel(student(ids.s1))
  assert.equal(mine.allocated, true)
  assert.equal(mine.blockCode, 'a')
  assert.equal(mine.roomNumber, '101')
  assert.deepEqual(
    mine.roommates.map((r) => r.studentId),
    [ids.s2],
  )
  assert.equal(mine.recentNights.length, 1)
})

test('an unallocated student gets an honest empty answer, not an error', async () => {
  const mine = await myHostel(student(ids.s3))
  assert.equal(mine.allocated, false)
  assert.equal(mine.roomNumber, null)
})

// --- tenancy ---------------------------------------------------------------

test('another institution sees none of this, and RLS not the query says so', async () => {
  await allocate(warden(), { roomId: roomA, studentId: ids.s1 })
  const seen = await withTenant(other, async (tx) => ({
    blocks: await tx.select().from(blocks),
    rooms: await tx.select().from(rooms),
    allocations: await tx.select().from(allocations),
  }))
  assert.deepEqual([seen.blocks.length, seen.rooms.length, seen.allocations.length], [0, 0, 0])
})

test('a warden of another institution cannot reach into this one', async () => {
  await assert.rejects(
    () => allocate(A({ institutionId: other }), { roomId: roomA, studentId: ids.s1 }),
    (e: unknown) => code(e) === 'no_such_student',
  )
})

test('a session with no tenant set reads nothing rather than erroring', async () => {
  assert.equal((await db.select().from(blocks)).length, 0)
})
