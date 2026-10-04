import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import * as attendance from './api'
import { devices, offlineCredentials, records, sessions, settings } from './schema'
import { pages } from './pages'

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const deviceHash = 'signed-device-identifier-1234'
const today = new Date().toISOString().slice(0, 10)
let tenant: string
let otherTenant: string
let student: attendance.Actor
let teacher: attendance.Actor
let administrator: attendance.Actor
let deviceId: string
let slotId: string
const failure = (code: string) => (error: unknown) => (error as attendance.AttendanceError).code === code

function enrollment(key = publicKey, hash = deviceHash, privateKey = keys.privateKey) {
  const message = attendance.enrollmentMessage(tenant, student.id, hash, key)
  return { deviceHash: hash, publicKey: key, proof: sign('sha256', Buffer.from(message), privateKey).toString('base64url') }
}

function envelope(qr: string, overrides: Record<string, unknown> = {}) {
  const body = { version: 1, institutionId: tenant, studentId: student.id, deviceId, qr, capturedAt: new Date().toISOString(), nonce: randomUUID(), latitude: 20, longitude: 85, accuracyM: 12, ...overrides }
  const bytes = Buffer.from(JSON.stringify(body))
  return { payload: bytes.toString('base64url'), signature: sign('sha256', bytes, keys.privateKey).toString('base64url') }
}

async function online() {
  const session = await attendance.openSession(teacher, { slotId })
  return { session, qr: (await attendance.currentQrFor(teacher, session.id)).qr }
}

before(async () => {
  const created = await authDb.insert(institutions).values([{ slug: 'offline-test', name: 'Offline', allowedEmailDomains: ['offline.test'] }, { slug: 'offline-other', name: 'Other', allowedEmailDomains: ['offline-other.test'] }]).returning()
  tenant = created[0]!.id
  otherTenant = created[1]!.id
  const people = await authDb.insert(users).values([
    { institutionId: tenant, email: 'student@offline.test', role: 'student' },
    { institutionId: tenant, email: 'teacher@offline.test', role: 'faculty' },
    { institutionId: tenant, email: 'admin@offline.test', role: 'institution_admin' },
  ]).returning()
  student = { id: people[0]!.id, institutionId: tenant, role: 'student' }
  teacher = { id: people[1]!.id, institutionId: tenant, role: 'faculty' }
  administrator = { id: people[2]!.id, institutionId: tenant, role: 'institution_admin' }
  const department = await academic.createDepartment(administrator, { code: 'OFF', name: 'Offline' })
  const program = await academic.createProgram(administrator, { departmentId: department.id, code: 'OFF', name: 'Offline', level: 'undergraduate', durationTerms: 8 })
  const course = await academic.createCourse(administrator, { departmentId: department.id, code: 'OF1', title: 'Offline', credits: 3 })
  const room = await academic.createRoom(administrator, { code: 'OFF' })
  const year = new Date().getUTCFullYear()
  const term = await academic.createTerm(administrator, { code: 'OFF', name: 'Offline', startsOn: `${year}-01-01`, endsOn: `${year}-12-31` })
  const section = await academic.createSection(administrator, { programId: program.id, label: 'A', admissionYear: year })
  await academic.addSectionMember(administrator, { sectionId: section.id, userId: student.id })
  const offering = await academic.createOffering(administrator, { termId: term.id, courseId: course.id, sectionId: section.id, facultyUserId: teacher.id })
  slotId = (await academic.createSlot(administrator, { offeringId: offering.id, roomId: room.id, dayOfWeek: new Date().getUTCDay() || 7, startsAt: '00:00', endsAt: '23:59' })).id
  await withTenant(tenant, (tx) => tx.insert(settings).values({ institutionId: tenant, timeZone: 'UTC' }))
})

beforeEach(async () => {
  await withTenant(tenant, async (tx) => {
    await tx.delete(records)
    await tx.delete(sessions)
    await tx.delete(offlineCredentials)
    await tx.delete(devices)
    await tx.delete(auditLog)
    await tx.update(settings).set({ requireSignedScans: true, acceptLateSync: true, maxLateSyncHours: 24, clockSkewSeconds: 60 })
  })
  assert.equal(typeof attendance.registerDeviceKey, 'function')
  const device = await attendance.registerDeviceKey(student, enrollment())
  deviceId = device.id
  await attendance.approveDevice(administrator, { deviceId })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, 'offline-test'))
  await authDb.delete(institutions).where(eq(institutions.slug, 'offline-other'))
})

test('signed scans mark attendance and concurrent exact retries are idempotent', async () => {
  const { qr } = await online()
  const request = envelope(qr)
  const results = await Promise.all([attendance.signedScan(student, request), attendance.signedScan(student, request)])
  assert.deepEqual(results[0], results[1])
  assert.equal(results[0]!.status, 'present')
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(records))).length, 1)
})

test('payload tampering and account substitution cannot reuse a signature', async () => {
  const { qr } = await online()
  const original = envelope(qr)
  const changed = JSON.parse(Buffer.from(original.payload, 'base64url').toString())
  changed.latitude = 50
  await assert.rejects(attendance.signedScan(student, { ...original, payload: Buffer.from(JSON.stringify(changed)).toString('base64url') }), failure('signature_invalid'))
  await assert.rejects(attendance.signedScan(student, envelope(qr, { studentId: teacher.id })), failure('wrong_identity'))
  await assert.rejects(attendance.signedScan({ ...student, institutionId: otherTenant }, original), failure('wrong_identity'))
})

test('a nonce cannot be reused for a different signed payload', async () => {
  const { qr } = await online()
  const nonce = randomUUID()
  await attendance.signedScan(student, envelope(qr, { nonce }))
  await assert.rejects(attendance.signedScan(student, envelope(qr, { nonce, accuracyM: 15 })), failure('nonce_reused'))
})

test('late sync after closing is accepted and flagged, but capture after closing is refused', async () => {
  const { session } = await online()
  const capturedAt = new Date(Date.now() - 3600000)
  const [updated] = await withTenant(tenant, (tx) => tx.update(sessions).set({ openedAt: new Date(capturedAt.getTime() - 60000), closedAt: new Date(capturedAt.getTime() + 60000) }).where(eq(sessions.id, session.id)).returning())
  const qr = attendance.encodeQr(attendance.currentQr(updated!.tokenSecret, session.id, 7, capturedAt.getTime()))
  const result = await attendance.signedScan(student, envelope(qr, { capturedAt: capturedAt.toISOString() }))
  assert.ok(result.anomalies.includes('late_sync'))
  const laterQr = attendance.encodeQr(attendance.currentQr(updated!.tokenSecret, session.id, 7))
  await assert.rejects(attendance.signedScan(student, envelope(laterQr)), failure('outside_session_window'))
})

test('late-sync policy and maximum age reject unaccepted offline records', async () => {
  const { qr } = await online()
  await attendance.setOfflinePolicy(administrator, { acceptLateSync: false })
  await assert.rejects(attendance.signedScan(student, envelope(qr, { capturedAt: new Date(Date.now() - 3600000).toISOString() })), failure('sync_too_late'))
  await attendance.setOfflinePolicy(administrator, {})
  await assert.rejects(attendance.signedScan(student, envelope(qr, { capturedAt: new Date(Date.now() - 25 * 3600000).toISOString() })), failure('sync_too_late'))
  await assert.rejects(attendance.setOfflinePolicy(student, {}), failure('forbidden'))
})

test('future clocks and QR windows outside the capture time are refused', async () => {
  const { qr, session } = await online()
  await assert.rejects(attendance.signedScan(student, envelope(qr, { capturedAt: new Date(Date.now() + 120000).toISOString() })), failure('clock_skew'))
  const [row] = await withTenant(tenant, (tx) => tx.select().from(sessions).where(eq(sessions.id, session.id)))
  const stale = attendance.encodeQr(attendance.currentQr(row!.tokenSecret, session.id, 7, Date.now() - 300000))
  await assert.rejects(attendance.signedScan(student, envelope(stale)), failure('token_stale'))
})

test('a teacher prefetches without opening a session and students sync locally minted QR', async () => {
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  assert.deepEqual(await withTenant(tenant, (tx) => tx.select().from(sessions)), [])
  const qr = attendance.encodeQr(attendance.currentQr(credential.secret, credential.sessionId, credential.windowSeconds))
  const result = await attendance.signedScan(student, envelope(qr))
  assert.equal(result.status, 'present')
  const held = await withTenant(tenant, (tx) => tx.select().from(sessions))
  assert.equal(held.length, 1)
  assert.equal(held[0]!.id, credential.sessionId)
})

test('preparation secrets and revoked credentials stay protected', async () => {
  await assert.rejects(attendance.prepareSession(student, { slotId, onDate: today }), failure('forbidden'))
  await assert.rejects(attendance.prepareSession({ ...teacher, id: student.id }, { slotId, onDate: today }), failure('not_your_class'))
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  const isolated = await withTenant(otherTenant, (tx) => tx.select().from(offlineCredentials))
  assert.deepEqual(isolated, [])
  await attendance.revokeCredential(teacher, { sessionId: credential.sessionId })
  const qr = attendance.encodeQr(attendance.currentQr(credential.secret, credential.sessionId, credential.windowSeconds))
  await assert.rejects(attendance.signedScan(student, envelope(qr)), failure('credential_revoked'))
})

test('enrollment proves possession, never overwrites keys, and revoked devices cannot sign', async () => {
  const again = await attendance.registerDeviceKey(student, enrollment())
  assert.equal(again.id, deviceId)
  assert.equal(again.status, 'active')
  await assert.rejects(attendance.registerDeviceKey(student, { ...enrollment(), proof: 'invalid' }), failure('invalid_key_proof'))
  const replacement = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  await assert.rejects(attendance.registerDeviceKey(student, enrollment(replacement.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), deviceHash, replacement.privateKey)), failure('key_already_bound'))
  const { qr } = await online()
  await attendance.revokeDevice(student, { deviceId })
  await assert.rejects(attendance.signedScan(student, envelope(qr)), failure('wrong_device'))
})

test('unsigned scans cannot bypass keyed device or institution policy', async () => {
  const { qr } = await online()
  const request = { qr, latitude: 20, longitude: 85, accuracyM: 12, deviceHash, deviceLockConfirmed: true }
  await assert.rejects(attendance.scan(student, request), failure('signed_scan_required'))
  await attendance.setOfflinePolicy(administrator, { requireSignedScans: false })
  await assert.rejects(attendance.scan(student, request), failure('signed_scan_required'))
})

test('revoking a teacher role invalidates prefetched credentials even if the offering is unchanged', async () => {
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  const qr = attendance.encodeQr(attendance.currentQr(credential.secret, credential.sessionId, credential.windowSeconds))
  await authDb.update(users).set({ role: 'student' }).where(eq(users.id, teacher.id))
  try {
    await assert.rejects(attendance.signedScan(student, envelope(qr)), failure('schedule_changed'))
    assert.deepEqual(await withTenant(tenant, (tx) => tx.select().from(sessions)), [])
  } finally {
    await authDb.update(users).set({ role: 'faculty' }).where(eq(users.id, teacher.id))
  }
})

test('a prepared class cannot also open online, and revocation never duplicates recorded attendance', async () => {
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  await assert.rejects(attendance.openSession(teacher, { slotId }), failure('offline_prepared'))
  const qr = attendance.encodeQr(attendance.currentQr(credential.secret, credential.sessionId, credential.windowSeconds))
  await attendance.signedScan(student, envelope(qr))
  await attendance.revokeCredential(teacher, { sessionId: credential.sessionId })
  await assert.rejects(attendance.openSession(teacher, { slotId }), failure('occurrence_recorded'))
})

test('database refuses rewriting an enrolled key', async () => {
  await assert.rejects(withTenant(tenant, (tx) => tx.update(devices).set({ publicKey: 'replacement' }).where(eq(devices.id, deviceId))), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === '23514')
})

test('a faculty peer cannot disclose the live QR secret or close another teacher session', async () => {
  const { session } = await online()
  const peer = { ...teacher, id: student.id }
  await assert.rejects(attendance.currentQrFor(peer, session.id), failure('not_your_class'))
  await assert.rejects(attendance.closeSession(peer, { sessionId: session.id }), failure('not_your_class'))
  await assert.rejects(attendance.roster(peer, session.id), failure('not_your_class'))
  await assert.rejects(attendance.override(peer, { sessionId: session.id, studentId: student.id, reason: 'another teacher override' }), failure('not_your_class'))
})

test('policy forms parse false checkboxes and integer text without enabling unchecked options', async () => {
  const updated = await attendance.setOfflinePolicy(administrator, { requireSignedScans: 'true', acceptLateSync: 'false', maxLateSyncHours: '12', clockSkewSeconds: '30' })
  assert.deepEqual(updated, { requireSignedScans: true, acceptLateSync: false, maxLateSyncHours: 12, clockSkewSeconds: 30 })
  assert.equal((await attendance.offlinePolicy(student)).acceptLateSync, false)
})

test('device review exposes key fingerprints without secrets and the policy page renders saved settings', async () => {
  const review = pages.find((page) => page.path === '/devices')!
  const data = await review.load(administrator, new Request('https://campus.test/m/attendance/devices'))
  assert.ok(JSON.stringify(data).includes('P-256 signing key'))
  assert.ok(!JSON.stringify(data).includes(publicKey))
  const policyPage = pages.find((page) => page.path === '/offline-policy')!
  const loaded = await policyPage.load(administrator, new Request('https://campus.test/m/attendance/offline-policy'))
  const sections = policyPage.sections(loaded)
  assert.ok(sections.some((section) => section.kind === 'form' && section.path === '/offline/policy'))
  await assert.rejects(attendance.institutionDevices(student), failure('forbidden'))
})

test('an accepted scan receipt survives device revocation while new scans stay blocked', async () => {
  const { qr } = await online()
  const request = envelope(qr)
  const receipt = await attendance.signedScan(student, request)
  await attendance.revokeDevice(student, { deviceId })
  assert.deepEqual(await attendance.signedScan(student, request), receipt)
  await assert.rejects(attendance.signedScan(student, envelope(qr)), failure('wrong_device'))
  await assert.rejects(attendance.signedScan(student, { ...request, signature: 'invalid' }), failure('signature_invalid'))
})

test('explicit teacher start records an all-absent class once with an audit receipt', async () => {
  assert.equal(typeof attendance.markSessionHeld, 'function')
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  assert.deepEqual(await withTenant(tenant, (tx) => tx.select().from(sessions)), [])
  const start = { sessionId: credential.sessionId, startedAt: new Date().toISOString() }
  const [first, retry] = await Promise.all([attendance.markSessionHeld(teacher, start), attendance.markSessionHeld(teacher, start)])
  assert.deepEqual(first, retry)
  const summary = await attendance.attendanceSummary(student, student.id)
  assert.equal(summary[0]!.held, 1)
  assert.equal(summary[0]!.absent, 1)
  const trail = await withTenant(tenant, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'attendance.session-held')))
  assert.equal(trail.length, 1)
  assert.equal(trail[0]!.detail!.startedAt, start.startedAt)
  await attendance.revokeCredential(teacher, { sessionId: credential.sessionId })
  assert.deepEqual(await attendance.markSessionHeld(teacher, start), first)
})

test('teacher activation racing a student scan creates a single held occurrence', async () => {
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  const qr = attendance.encodeQr(attendance.currentQr(credential.secret, credential.sessionId, credential.windowSeconds))
  await Promise.all([
    attendance.markSessionHeld(teacher, { sessionId: credential.sessionId, startedAt: new Date().toISOString() }),
    attendance.signedScan(student, envelope(qr)),
  ])
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(sessions))).length, 1)
  assert.equal((await attendance.attendanceSummary(student, student.id))[0]!.present, 1)
})

test('held-session declarations reject unauthorized teachers, future starts and revoked credentials', async () => {
  const credential = await attendance.prepareSession(teacher, { slotId, onDate: today })
  const start = { sessionId: credential.sessionId, startedAt: new Date().toISOString() }
  await assert.rejects(attendance.markSessionHeld(student, start), failure('forbidden'))
  await assert.rejects(attendance.markSessionHeld({ ...teacher, id: student.id }, start), failure('forbidden'))
  await assert.rejects(attendance.markSessionHeld({ ...teacher, institutionId: otherTenant }, start), failure('no_such_session'))
  await assert.rejects(attendance.markSessionHeld(teacher, { ...start, startedAt: new Date(Date.now() + 120000).toISOString() }), failure('clock_skew'))
  await assert.rejects(attendance.markSessionHeld(teacher, { ...start, startedAt: new Date(Date.now() - 25 * 3600000).toISOString() }), failure('sync_too_late'))
  await authDb.update(users).set({ role: 'student' }).where(eq(users.id, teacher.id))
  try {
    await assert.rejects(attendance.markSessionHeld(teacher, start), failure('forbidden'))
  } finally {
    await authDb.update(users).set({ role: 'faculty' }).where(eq(users.id, teacher.id))
  }
  await attendance.revokeCredential(teacher, { sessionId: credential.sessionId })
  await assert.rejects(attendance.markSessionHeld(teacher, start), failure('credential_revoked'))
  assert.deepEqual(await withTenant(tenant, (tx) => tx.select().from(sessions)), [])
})
