import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  AttendanceError,
  approveDevice,
  closeSession,
  currentQrFor,
  encodeQr,
  listPendingDevices,
  myAttendance,
  openSession,
  openSessions,
  override,
  registerDevice,
  roster,
  scan,
  setGeofence,
  type Actor,
} from './api'
import { devices, records, sessions } from './schema'

const SLUG = 'att-test'
const ROOM = { latitude: 20.2961, longitude: 85.8245 }
const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)

let inst: string
const ids = { slot: '', room: '', section: '', s1: '', s2: '', s3: '', fac: '', adm: '' }

const A = (over: Partial<Actor>): Actor => ({
  id: ids.fac,
  role: 'faculty',
  institutionId: inst,
  ...over,
})
// A real row, because approved_by is a foreign key to users.
const admin = () => A({ id: ids.adm, role: 'institution_admin' })
const student = (id: string) => A({ id, role: 'student' })

/** Whatever QR is current for this session right now. */
const liveQr = async (sessionId: string) =>
  (await currentQrFor(A({}), sessionId)).qr

const scanAs = (id: string, qr: string, over: Partial<Record<string, unknown>> = {}) =>
  scan(student(id), {
    qr,
    latitude: ROOM.latitude,
    longitude: ROOM.longitude,
    accuracyM: 12,
    deviceHash: HASH_A,
    deviceLockConfirmed: true,
    ...over,
  })

const code = (e: unknown) => (e as AttendanceError).code

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Att', allowedEmailDomains: ['att.test'] })
    .returning({ id: institutions.id })
  inst = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'f@att.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 'adm@att.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@att.test', institutionId: inst, role: 'student', name: 'S1' },
      { email: 's2@att.test', institutionId: inst, role: 'student', name: 'S2' },
      { email: 's3@att.test', institutionId: inst, role: 'student', name: 'S3' },
    ])
    .returning({ id: users.id })
  ids.fac = people[0]!.id
  ids.adm = people[1]!.id
  ids.s1 = people[2]!.id
  ids.s2 = people[3]!.id
  ids.s3 = people[4]!.id

  const setup = admin()
  const dept = await academic.createDepartment(setup, { code: 'cse', name: 'CSE' })
  const prog = await academic.createProgram(setup, {
    departmentId: dept.id,
    code: 'btech',
    name: 'BTech',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const course = await academic.createCourse(setup, {
    departmentId: dept.id,
    code: 'cs301',
    title: 'OS',
    credits: 4,
  })
  const room = await academic.createRoom(setup, { code: 'lt-1' })
  ids.room = room.id
  const term = await academic.createTerm(setup, {
    code: 't1',
    name: 'T1',
    startsOn: '2026-07-01',
    endsOn: '2026-12-01',
  })
  await academic.setCurrentTerm(setup, { termId: term.id })
  const section = await academic.createSection(setup, {
    programId: prog.id,
    label: 'a',
    admissionYear: 2026,
  })
  ids.section = section.id
  // s1 and s2 are enrolled; s3 deliberately is not.
  await academic.addSectionMember(setup, { sectionId: section.id, userId: ids.s1 })
  await academic.addSectionMember(setup, { sectionId: section.id, userId: ids.s2 })

  const offering = await academic.createOffering(setup, {
    termId: term.id,
    courseId: course.id,
    sectionId: section.id,
    facultyUserId: ids.fac,
  })
  const slot = await academic.createSlot(setup, {
    offeringId: offering.id,
    roomId: room.id,
    dayOfWeek: 1,
    startsAt: '09:00',
    endsAt: '10:00',
  })
  ids.slot = slot.id

  await setGeofence(admin(), { ...ROOM, roomId: ids.room, radiusM: 100 })
})

beforeEach(async () => {
  // Each test starts from no sessions, no records, no devices.
  await withTenant(inst, async (tx) => {
    await tx.delete(records)
    await tx.delete(sessions)
    await tx.delete(devices)
    await tx.delete(auditLog)
  })
  // s1 has an approved device by default; s2 has none.
  const d = await registerDevice(student(ids.s1), { deviceHash: HASH_A })
  await approveDevice(admin(), { deviceId: d.id })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

// --- sessions --------------------------------------------------------------

test('a student cannot open a session', async () => {
  await assert.rejects(
    () => openSession(student(ids.s1), { slotId: ids.slot }),
    (e: unknown) => e instanceof AttendanceError && e.status === 403,
  )
})

test('a lecturer cannot open somebody else’s class', async () => {
  await assert.rejects(
    () => openSession(A({ id: 'other-faculty' }), { slotId: ids.slot }),
    (e: unknown) => code(e) === 'not_your_class',
  )
})

test('an admin can open any class', async () => {
  const s = await openSession(admin(), { slotId: ids.slot })
  assert.ok(s.id)
})

test('only one session can be open per slot', async () => {
  await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    () => openSession(A({}), { slotId: ids.slot }),
    (e: unknown) => code(e) === 'already_open',
  )
})

test('closing frees the slot for a new session', async () => {
  const first = await openSession(A({}), { slotId: ids.slot })
  await closeSession(A({}), { sessionId: first.id })
  const second = await openSession(A({}), { slotId: ids.slot })
  assert.notEqual(second.id, first.id)
})

test('the open-sessions list shows the class', async () => {
  await openSession(A({}), { slotId: ids.slot })
  const open = await openSessions(A({}))
  assert.equal(open.length, 1)
  assert.equal(open[0]!.courseCode, 'CS301')
  assert.equal(open[0]!.roomCode, 'LT-1')
})

// --- the happy path --------------------------------------------------------

test('an enrolled student in the room on their device is marked present', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const r = await scanAs(ids.s1, await liveQr(s.id))
  assert.equal(r.status, 'present')
  assert.equal(r.courseCode, 'CS301')
})

test('fifty students can use the same current token', async () => {
  // The point of the design: the token is shared within its window, and the
  // unique index -- not single-use -- is what stops double marking.
  const s = await openSession(A({}), { slotId: ids.slot })
  const qr = await liveQr(s.id)

  const d2 = await registerDevice(student(ids.s2), { deviceHash: HASH_B })
  await approveDevice(admin(), { deviceId: d2.id })

  await scanAs(ids.s1, qr)
  await scanAs(ids.s2, qr, { deviceHash: HASH_B })

  const view = await roster(A({}), s.id)
  assert.equal(view.present, 2)
  assert.equal(view.total, 2)
})

test('a second scan by the same student is refused', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await scanAs(ids.s1, await liveQr(s.id))
  await assert.rejects(
    async () => scanAs(ids.s1, await liveQr(s.id)),
    (e: unknown) => code(e) === 'already_marked',
  )
})

// --- validation order ------------------------------------------------------

test('a malformed code is rejected before anything else', async () => {
  await assert.rejects(
    () => scanAs(ids.s1, 'not-a-campusos-code'),
    (e: unknown) => code(e) === 'malformed_qr',
  )
})

test('an unknown session is rejected', async () => {
  const fake = encodeQr({
    sessionId: '99999999-9999-9999-9999-999999999999',
    window: 1,
    token: 'AAAAAAAAAAAA',
    expiresInMs: 0,
  })
  await assert.rejects(() => scanAs(ids.s1, fake), (e: unknown) => code(e) === 'no_such_session')
})

test('a closed session refuses scans', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const qr = await liveQr(s.id)
  await closeSession(A({}), { sessionId: s.id })
  await assert.rejects(() => scanAs(ids.s1, qr), (e: unknown) => code(e) === 'session_closed')
})

test('a forged token in a live session is rejected', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const real = await liveQr(s.id)
  const forged = real.replace(/\.[^.]+$/, '.AAAAAAAAAAAA')
  await assert.rejects(() => scanAs(ids.s1, forged), (e: unknown) => code(e) === 'token_invalid')
})

test('a token from another session does not work here', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const qr = await liveQr(s.id)
  // Re-point the same token at a different session id.
  const other = qr.replace(s.id, '99999999-9999-9999-9999-999999999999')
  await assert.rejects(() => scanAs(ids.s1, other), (e: unknown) => code(e) === 'no_such_session')
})

test('token failure is reported before enrolment, so the endpoint cannot enumerate a cohort', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const forged = (await liveQr(s.id)).replace(/\.[^.]+$/, '.AAAAAAAAAAAA')
  // s3 is not enrolled, but the token verdict must come first.
  await assert.rejects(() => scanAs(ids.s3, forged), (e: unknown) => code(e) === 'token_invalid')
})

test('a student not in the section is refused', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const d = await registerDevice(student(ids.s3), { deviceHash: HASH_B })
  await approveDevice(admin(), { deviceId: d.id })
  await assert.rejects(
    async () => scanAs(ids.s3, await liveQr(s.id), { deviceHash: HASH_B }),
    (e: unknown) => code(e) === 'not_enrolled',
  )
})

// --- location --------------------------------------------------------------

test('a student outside the geofence is refused, with the distance', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  try {
    await scanAs(ids.s1, await liveQr(s.id), { latitude: ROOM.latitude + 0.01 })
    assert.fail('expected rejection')
  } catch (e) {
    assert.equal(code(e), 'outside_geofence')
    const d = (e as AttendanceError).detail?.distanceM as number
    assert.ok(d > 900 && d < 1300, `${d}`)
  }
})

test('poor accuracy is allowed as slack rather than punished at the edge', async () => {
  // 120 m out with a 100 m fence would fail, but a 60 m accuracy fix makes it
  // plausible that the student is inside.
  const s = await openSession(A({}), { slotId: ids.slot })
  const r = await scanAs(ids.s1, await liveQr(s.id), {
    latitude: ROOM.latitude + 0.00108,
    accuracyM: 60,
  })
  assert.equal(r.status, 'present')
})

test('an unusable fix is refused rather than accepted blindly', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () => scanAs(ids.s1, await liveQr(s.id), { accuracyM: 5000 }),
    (e: unknown) => code(e) === 'location_too_vague',
  )
})

test('an unmapped room is flagged, not blocked', async () => {
  const room = await academic.createRoom(admin(), { code: 'unmapped' })
  const [offering] = await academic.listOfferings(admin())
  const slot = await academic.createSlot(admin(), {
    offeringId: offering!.id,
    roomId: room.id,
    dayOfWeek: 5,
    startsAt: '14:00',
    endsAt: '15:00',
  })
  const s = await openSession(A({}), { slotId: slot.id })
  const r = await scanAs(ids.s1, await liveQr(s.id))
  assert.equal(r.status, 'present')

  const view = await roster(A({}), s.id)
  const mine = view.entries.find((e) => e.studentId === ids.s1)!
  assert.ok(mine.anomalies.includes('room_has_no_geofence'), mine.anomalies.join(','))
})

// --- device binding --------------------------------------------------------

test('a student with no device cannot scan', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () => scanAs(ids.s2, await liveQr(s.id), { deviceHash: HASH_B }),
    (e: unknown) => code(e) === 'no_registered_device',
  )
})

test('an unapproved device cannot scan, and says so specifically', async () => {
  await registerDevice(student(ids.s2), { deviceHash: HASH_B })
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () => scanAs(ids.s2, await liveQr(s.id), { deviceHash: HASH_B }),
    (e: unknown) => code(e) === 'device_pending_approval',
  )
})

test('a scan that never proved the screen lock is refused', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () => scanAs(ids.s1, await liveQr(s.id), { deviceLockConfirmed: false }),
    (e: unknown) => code(e) === 'device_not_confirmed',
  )
})

test('an older client that omits the confirmation gets the same refusal, not a schema error', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () =>
      scan(student(ids.s1), {
        qr: await liveQr(s.id),
        latitude: ROOM.latitude,
        longitude: ROOM.longitude,
        accuracyM: 12,
        deviceHash: HASH_A,
      }),
    (e: unknown) => code(e) === 'device_not_confirmed',
  )
})

test('scanning from a different handset than the registered one is refused', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () => scanAs(ids.s1, await liveQr(s.id), { deviceHash: HASH_B }),
    (e: unknown) => code(e) === 'wrong_device',
  )
})

test('a student can only have one active device, and approval revokes the old one', async () => {
  const replacement = await registerDevice(student(ids.s1), { deviceHash: HASH_B })
  await approveDevice(admin(), { deviceId: replacement.id })

  const rows = await withTenant(inst, (tx) =>
    tx.select({ hash: devices.deviceHash, status: devices.status }).from(devices),
  )
  assert.deepEqual(
    rows.filter((r) => r.status === 'active').map((r) => r.hash),
    [HASH_B],
  )
  assert.equal(rows.filter((r) => r.status === 'revoked').length, 1)

  // the old handset stops working immediately
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    async () => scanAs(ids.s1, await liveQr(s.id)),
    (e: unknown) => code(e) === 'wrong_device',
  )
})

test('re-registering a known device does not duplicate it', async () => {
  const again = await registerDevice(student(ids.s1), { deviceHash: HASH_A })
  const rows = await withTenant(inst, (tx) => tx.select().from(devices))
  assert.equal(rows.length, 1)
  assert.equal(again.status, 'active')
})

test('only a student registers a device, and only an admin approves one', async () => {
  await assert.rejects(
    () => registerDevice(A({}), { deviceHash: HASH_B }),
    (e: unknown) => (e as AttendanceError).status === 403,
  )
  await registerDevice(student(ids.s2), { deviceHash: HASH_B })
  const [pending] = await listPendingDevices(admin())
  await assert.rejects(
    () => approveDevice(A({}), { deviceId: pending!.id }),
    (e: unknown) => (e as AttendanceError).status === 403,
  )
})

test('a lecturer cannot see the pending-device queue', async () => {
  await assert.rejects(
    () => listPendingDevices(A({})),
    (e: unknown) => (e as AttendanceError).status === 403,
  )
})

// --- anomalies -------------------------------------------------------------

test('a second student at identical coordinates is flagged, not blocked', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  const d2 = await registerDevice(student(ids.s2), { deviceHash: HASH_B })
  await approveDevice(admin(), { deviceId: d2.id })

  await scanAs(ids.s1, await liveQr(s.id))
  const second = await scanAs(ids.s2, await liveQr(s.id), { deviceHash: HASH_B })
  assert.equal(second.status, 'present')

  const view = await roster(A({}), s.id)
  const flagged = view.entries.find((e) => e.studentId === ids.s2)!
  assert.ok(flagged.anomalies.includes('identical_coordinates'), flagged.anomalies.join(','))
})

test('an implausibly precise fix is flagged', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await scanAs(ids.s1, await liveQr(s.id), { accuracyM: 1 })
  const view = await roster(A({}), s.id)
  const mine = view.entries.find((e) => e.studentId === ids.s1)!
  assert.ok(mine.anomalies.includes('implausible_accuracy'), mine.anomalies.join(','))
})

// --- manual override ------------------------------------------------------

test('an override requires a substantive reason', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  for (const reason of ['', '  ', 'x']) {
    await assert.rejects(() =>
      override(A({}), { sessionId: s.id, studentId: ids.s2, reason }),
    )
  }
})

test('an override writes a row in the shared audit log', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await override(A({ email: 'fac@att.test' }), {
    sessionId: s.id,
    studentId: ids.s2,
    reason: 'verified in person, handset left at home',
  })
  const trail = await withTenant(inst, (tx) => tx.select().from(auditLog))
  assert.equal(trail.length, 1)
  assert.equal(trail[0]!.moduleId, 'attendance')
  assert.equal(trail[0]!.action, 'attendance.override')
  assert.equal(trail[0]!.entity, 'attendance_records')
  assert.match(trail[0]!.reason, /handset left at home/)
})

test('an override marks the student and records who and why', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await override(A({}), {
    sessionId: s.id,
    studentId: ids.s2,
    reason: 'phone battery died, verified in person',
  })
  const view = await roster(A({}), s.id)
  const e = view.entries.find((x) => x.studentId === ids.s2)!
  assert.equal(e.status, 'present')
  assert.equal(e.method, 'manual_override')
  assert.match(e.overrideReason!, /battery died/)
})

test('an override cannot invent attendance for someone not in the class', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    () => override(A({}), { sessionId: s.id, studentId: ids.s3, reason: 'not in this class' }),
    (e: unknown) => code(e) === 'not_enrolled',
  )
})

test('a student cannot override', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    () => override(student(ids.s1), { sessionId: s.id, studentId: ids.s1, reason: 'please' }),
    (e: unknown) => (e as AttendanceError).status === 403,
  )
})

// --- reads -----------------------------------------------------------------

test('the roster lists absent students too, so it is usable as a register', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await scanAs(ids.s1, await liveQr(s.id))
  const view = await roster(A({}), s.id)
  assert.equal(view.total, 2)
  assert.equal(view.present, 1)
  assert.deepEqual(
    view.entries.map((e) => e.status),
    ['present', 'absent'],
  )
})

test('a student cannot read a roster', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await assert.rejects(
    () => roster(student(ids.s1), s.id),
    (e: unknown) => (e as AttendanceError).status === 403,
  )
})

test('a student sees only their own history', async () => {
  const s = await openSession(A({}), { slotId: ids.slot })
  await scanAs(ids.s1, await liveQr(s.id))
  assert.equal((await myAttendance(student(ids.s1))).length, 1)
  assert.equal((await myAttendance(student(ids.s2))).length, 0)
})

// --- tenant isolation ------------------------------------------------------

test('another institution sees none of this', async () => {
  const [other] = await authDb
    .insert(institutions)
    .values({ slug: 'att-other', name: 'Other', allowedEmailDomains: ['other.test'] })
    .returning({ id: institutions.id })
  try {
    await openSession(A({}), { slotId: ids.slot })
    const seen = await openSessions(A({ institutionId: other!.id }))
    assert.deepEqual(seen, [])
  } finally {
    await authDb.delete(institutions).where(eq(institutions.slug, 'att-other'))
  }
})

test('a session id from another institution is not readable', async () => {
  const [other] = await authDb
    .insert(institutions)
    .values({ slug: 'att-other2', name: 'Other2', allowedEmailDomains: ['other2.test'] })
    .returning({ id: institutions.id })
  try {
    const s = await openSession(A({}), { slotId: ids.slot })
    await assert.rejects(
      () => roster(A({ institutionId: other!.id }), s.id),
      (e: unknown) => code(e) === 'no_such_session',
    )
  } finally {
    await authDb.delete(institutions).where(eq(institutions.slug, 'att-other2'))
  }
})
