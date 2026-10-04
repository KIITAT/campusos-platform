import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, auditLog, users, withTenant } from '@campusos/db'
import { ticked } from '@campusos/module-framework'
import { courses, offerings, sectionMembers, slots } from '@campusos/module-academic/schema'
import { devices, offlineCredentials, records, roomGeofences, sessions, settings } from '../schema'
import { AttendanceError, type Actor } from './operations'
import { decodeQr, distanceM, enrollmentMessage, newSessionSecret, verifyDeviceSignature, verifyToken } from './token'

const base64url = z.string().min(1).max(12000).regex(/^[A-Za-z0-9_-]+$/)
export const signedScanSchema = z.object({ payload: base64url, signature: base64url.max(200) }).strict().meta({ id: 'AttendanceSignedScan' })
export const signedPayloadSchema = z.object({
  version: z.literal(1),
  institutionId: z.uuid(),
  studentId: z.string().min(1).max(200),
  deviceId: z.uuid(),
  qr: z.string().min(3).max(200),
  capturedAt: z.iso.datetime(),
  nonce: z.uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000),
}).strict()
export const registerKeySchema = z.object({
  deviceHash: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+$/),
  label: z.string().max(80).optional(),
  publicKey: z.string().min(40).max(500).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  proof: base64url.max(200),
}).strict().meta({ id: 'AttendanceRegisterKey' })
export const offlinePolicySchema = z.object({
  requireSignedScans: z.preprocess(ticked, z.boolean()).default(true),
  acceptLateSync: z.preprocess(ticked, z.boolean()).default(true),
  maxLateSyncHours: z.coerce.number().int().min(1).max(168).default(24),
  clockSkewSeconds: z.coerce.number().int().min(0).max(300).default(60),
}).strict().meta({ id: 'AttendanceOfflinePolicy' })
export const prepareSessionSchema = z.object({ slotId: z.uuid(), onDate: z.iso.date() }).strict().meta({ id: 'AttendancePrepareSession' })
export const heldSessionSchema = z.object({ sessionId: z.uuid(), startedAt: z.iso.datetime() }).strict().meta({ id: 'AttendanceSessionHeld' })
export const revokeCredentialSchema = z.object({ sessionId: z.uuid() }).strict().meta({ id: 'AttendanceRevokeCredential' })
export const revokeDeviceSchema = z.object({ deviceId: z.uuid() }).strict().meta({ id: 'AttendanceRevokeDevice' })

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
const admin = (actor: Actor) => actor.role === 'institution_admin' || actor.role === 'super_admin'
const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new AttendanceError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
function refuse(code: string, message: string): never {
  throw new AttendanceError(409, code, message)
}

async function policyFor(tx: Tx, tenant: string) {
  const [row] = await tx.select().from(settings).where(eq(settings.institutionId, tenant))
  return {
    ...offlinePolicySchema.parse(row ? {
      requireSignedScans: row.requireSignedScans,
      acceptLateSync: row.acceptLateSync,
      maxLateSyncHours: row.maxLateSyncHours,
      clockSkewSeconds: row.clockSkewSeconds,
    } : {}),
    tokenWindowSeconds: row?.tokenWindowSeconds ?? 7,
    maxAccuracyM: row?.maxAccuracyM ?? 200,
    defaultRadiusM: row?.defaultRadiusM ?? 100,
    timeZone: row?.timeZone ?? 'Asia/Kolkata',
  }
}

export async function offlinePolicy(actor: Actor) {
  return withTenant(tenantOf(actor), (tx) => policyFor(tx, tenantOf(actor)))
}

export async function setOfflinePolicy(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!admin(actor)) throw new AttendanceError(403, 'forbidden', 'only administrators set attendance policy')
  const data = offlinePolicySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.insert(settings).values({ institutionId: tenant, ...data }).onConflictDoUpdate({ target: settings.institutionId, set: data })
    await audit(tx, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: 'attendance', action: 'attendance.offline-policy', entity: 'attendance_settings', entityId: tenant, reason: 'Changed signed attendance and offline sync policy', detail: data })
    return data
  })
}

export async function registerDeviceKey(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new AttendanceError(403, 'forbidden', 'only students register signing keys')
  const data = registerKeySchema.parse(input)
  if (!verifyDeviceSignature(data.publicKey, Buffer.from(enrollmentMessage(tenant, actor.id, data.deviceHash, data.publicKey)), data.proof)) {
    refuse('invalid_key_proof', 'the device must prove possession of its P-256 signing key')
  }
  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, actor.id), eq(users.role, 'student')))
    if (!person) throw new AttendanceError(403, 'forbidden', 'no student account in this institution')
    await tx.insert(devices).values({ institutionId: tenant, userId: actor.id, deviceHash: data.deviceHash, label: data.label, publicKey: data.publicKey }).onConflictDoNothing()
    const [device] = await tx.select().from(devices).where(and(eq(devices.userId, actor.id), eq(devices.deviceHash, data.deviceHash)))
    if (!device || device.publicKey !== data.publicKey) refuse('key_already_bound', 'register a new device identifier to replace an existing key; approval is required')
    return { id: device.id, status: device.status }
  })
}

export async function myDevices(actor: Actor) {
  return withTenant(tenantOf(actor), (tx) => tx.select({ id: devices.id, deviceHash: devices.deviceHash, label: devices.label, status: devices.status, signed: sql<boolean>`${devices.publicKey} is not null` }).from(devices).where(eq(devices.userId, actor.id)))
}

export async function institutionDevices(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!admin(actor)) throw new AttendanceError(403, 'forbidden', 'only administrators review institution devices')
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select({ id: devices.id, label: devices.label, status: devices.status, publicKey: devices.publicKey, name: users.name, email: users.email, createdAt: devices.createdAt }).from(devices).innerJoin(users, eq(users.id, devices.userId)).orderBy(devices.createdAt)
    return rows.map((row) => ({ id: row.id, label: row.label, status: row.status, who: row.name ?? row.email, createdAt: row.createdAt.toISOString(), signing: row.publicKey ? 'P-256 signing key' : 'Legacy unsigned device', fingerprint: row.publicKey ? createHash('sha256').update(Buffer.from(row.publicKey, 'base64')).digest('hex') : null }))
  })
}

export async function revokeDevice(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const { deviceId } = revokeDeviceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [device] = await tx.select().from(devices).where(eq(devices.id, deviceId)).for('update')
    if (!device) throw new AttendanceError(404, 'no_such_device', 'no such device')
    if (!admin(actor) && device.userId !== actor.id) throw new AttendanceError(403, 'forbidden', 'not your device')
    await tx.update(devices).set({ status: 'revoked' }).where(eq(devices.id, deviceId))
    return { id: deviceId, status: 'revoked' as const }
  })
}

async function occurrence(tx: Tx, slotId: string, onDate: string, timeZone: string) {
  const result = await tx.execute(sql`
    select academic_slots.offering_id, academic_slots.room_id, o.faculty_user_id,
           ((${onDate}::date + academic_slots.starts_at) at time zone ${timeZone}) as starts_at,
           ((${onDate}::date + academic_slots.ends_at) at time zone ${timeZone}) as ends_at,
           (${onDate}::date between t.starts_on and t.ends_on and extract(isodow from ${onDate}::date) = academic_slots.day_of_week) as scheduled,
           exists(select 1 from academic_class_changes c where c.slot_id = academic_slots.id and c.withdrawn_at is null and (c.on_date = ${onDate}::date or c.moved_on = ${onDate}::date)) as changed
      from academic_slots
      join academic_offerings o on o.id = academic_slots.offering_id
      join academic_terms t on t.id = o.term_id
     where academic_slots.id = ${slotId}
     for share of academic_slots, o, t`)
  const row = result.rows[0] as { offering_id: string; room_id: string; faculty_user_id: string | null; starts_at: string; ends_at: string; scheduled: boolean; changed: boolean } | undefined
  return row ? { ...row, starts_at: new Date(row.starts_at), ends_at: new Date(row.ends_at) } : undefined
}

export async function prepareSession(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!admin(actor) && actor.role !== 'faculty' && actor.role !== 'hod') throw new AttendanceError(403, 'forbidden', 'only teachers prepare sessions')
  const data = prepareSessionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${data.slotId}, 0))`)
    const policy = await policyFor(tx, tenant)
    const meeting = await occurrence(tx, data.slotId, data.onDate, policy.timeZone)
    if (!meeting) throw new AttendanceError(404, 'no_such_slot', 'no such timetable slot')
    if (!admin(actor) && meeting.faculty_user_id !== actor.id) throw new AttendanceError(403, 'not_your_class', 'that is not your class')
    if (!meeting.scheduled || meeting.changed) refuse('schedule_changed', 'prepare an unchanged scheduled occurrence; use the online flow for class changes')
    const now = Date.now()
    if (meeting.ends_at.getTime() <= now || meeting.starts_at.getTime() > now + 7 * 86400000) refuse('preparation_window', 'prepare a class within the next seven days')
    const held = await tx.execute(sql`select id from attendance_sessions where slot_id = ${data.slotId} and (opened_at at time zone ${policy.timeZone})::date = ${data.onDate}::date limit 1`)
    const [existing] = await tx.select().from(offlineCredentials).where(and(eq(offlineCredentials.slotId, data.slotId), eq(offlineCredentials.onDate, data.onDate)))
    if (existing) {
      if (existing.revokedAt) refuse('credential_revoked', 'this occurrence credential was revoked; use an online session')
      if (existing.teacherId !== actor.id && !admin(actor)) throw new AttendanceError(403, 'not_your_class', 'this credential belongs to another teacher')
      return credentialView(existing)
    }
    if (held.rows.length) refuse('already_open', 'a session already exists for this occurrence')
    const [created] = await tx.insert(offlineCredentials).values({
      id: randomUUID(), institutionId: tenant, slotId: data.slotId, offeringId: meeting.offering_id,
      teacherId: actor.id, onDate: data.onDate, startsAt: meeting.starts_at, endsAt: meeting.ends_at,
      roomId: meeting.room_id, tokenSecret: newSessionSecret(), windowSeconds: policy.tokenWindowSeconds,
    }).returning()
    return credentialView(created!)
  })
}

function credentialView(credential: typeof offlineCredentials.$inferSelect) {
  return { sessionId: credential.id, slotId: credential.slotId, onDate: credential.onDate, secret: credential.tokenSecret, startsAt: credential.startsAt.toISOString(), endsAt: credential.endsAt.toISOString(), windowSeconds: credential.windowSeconds }
}

export async function revokeCredential(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const { sessionId } = revokeCredentialSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [credential] = await tx.select().from(offlineCredentials).where(eq(offlineCredentials.id, sessionId)).for('update')
    if (!credential) throw new AttendanceError(404, 'no_such_session', 'no such offline credential')
    if (!admin(actor) && credential.teacherId !== actor.id) throw new AttendanceError(403, 'forbidden', 'not your session')
    await tx.update(offlineCredentials).set({ revokedAt: new Date() }).where(eq(offlineCredentials.id, sessionId))
    return { sessionId, revoked: true }
  })
}

async function validatePreparedOccurrence(tx: Tx, credential: typeof offlineCredentials.$inferSelect, timeZone: string) {
  if (credential.revokedAt) refuse('credential_revoked', 'this session credential was revoked')
  const meeting = await occurrence(tx, credential.slotId, credential.onDate, timeZone)
  const [teacher] = await tx.select({ role: users.role }).from(users).where(eq(users.id, credential.teacherId)).for('share')
  if (!meeting || !meeting.scheduled || meeting.changed || meeting.offering_id !== credential.offeringId || meeting.room_id !== credential.roomId || meeting.starts_at.getTime() !== credential.startsAt.getTime() || meeting.ends_at.getTime() !== credential.endsAt.getTime() || !teacher || !['faculty', 'hod', 'institution_admin', 'super_admin'].includes(teacher.role) || (!['institution_admin', 'super_admin'].includes(teacher.role) && meeting.faculty_user_id !== credential.teacherId)) refuse('schedule_changed', 'the prepared class changed; ask the teacher to record attendance')
}

export async function markSessionHeld(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!admin(actor) && actor.role !== 'faculty' && actor.role !== 'hod') throw new AttendanceError(403, 'forbidden', 'only teachers mark classes held')
  const data = heldSessionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [credential] = await tx.select().from(offlineCredentials).where(eq(offlineCredentials.id, data.sessionId)).for('share')
    if (!credential) throw new AttendanceError(404, 'no_such_session', 'no such prepared session')
    if (!admin(actor) && credential.teacherId !== actor.id) throw new AttendanceError(403, 'forbidden', 'not your prepared session')
    const [person] = await tx.select({ role: users.role }).from(users).where(eq(users.id, actor.id)).for('share')
    if (!person || !['faculty', 'hod', 'institution_admin', 'super_admin'].includes(person.role) || (credential.teacherId !== actor.id && !['institution_admin', 'super_admin'].includes(person.role))) throw new AttendanceError(403, 'forbidden', 'no current permission to mark this class held')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance-held:${data.sessionId}`}, 0))`)
    const [receipt] = await tx.select({ detail: auditLog.detail }).from(auditLog).where(and(eq(auditLog.entity, 'attendance_sessions'), eq(auditLog.entityId, data.sessionId), eq(auditLog.action, 'attendance.session-held'))).limit(1)
    if (receipt) {
      const saved = receipt.detail as { sessionId: string; startedAt: string; openedAt: string; closedAt: string }
      return { sessionId: saved.sessionId, startedAt: saved.startedAt, openedAt: saved.openedAt, closedAt: saved.closedAt }
    }
    const policy = await policyFor(tx, tenant)
    const startedAt = new Date(data.startedAt)
    const now = Date.now()
    const skewMs = policy.clockSkewSeconds * 1000
    if (startedAt.getTime() > now + skewMs) refuse('clock_skew', 'the device clock is ahead; correct its time')
    const age = now - startedAt.getTime()
    if (age > policy.maxLateSyncHours * 3600000 || (!policy.acceptLateSync && age > Math.max(skewMs, credential.windowSeconds * 2000))) refuse('sync_too_late', 'the class start is outside the institution sync window')
    if (startedAt.getTime() < credential.startsAt.getTime() - skewMs || startedAt.getTime() >= credential.endsAt.getTime() + skewMs) refuse('outside_session_window', 'the class was started outside its scheduled occurrence')
    await validatePreparedOccurrence(tx, credential, policy.timeZone)
    await tx.insert(sessions).values({ id: credential.id, institutionId: tenant, slotId: credential.slotId, offeringId: credential.offeringId, openedBy: credential.teacherId, tokenSecret: credential.tokenSecret, tokenWindowSeconds: credential.windowSeconds, openedAt: credential.startsAt, closedAt: credential.endsAt }).onConflictDoNothing({ target: sessions.id })
    const result = { sessionId: credential.id, startedAt: startedAt.toISOString(), openedAt: credential.startsAt.toISOString(), closedAt: credential.endsAt.toISOString() }
    await audit(tx, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: 'attendance', action: 'attendance.session-held', entity: 'attendance_sessions', entityId: credential.id, reason: 'Teacher confirmed the prepared class was started', detail: { ...result, lateSync: age > Math.max(skewMs, credential.windowSeconds * 2000) } })
    return result
  })
}

export async function signedScan(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new AttendanceError(403, 'forbidden', 'only students scan')
  const envelope = signedScanSchema.parse(input)
  const bytes = Buffer.from(envelope.payload, 'base64url')
  if (bytes.toString('base64url') !== envelope.payload) refuse('invalid_payload', 'noncanonical payload encoding')
  let decodedPayload: unknown
  try { decodedPayload = JSON.parse(bytes.toString('utf8')) } catch { refuse('invalid_payload', 'invalid signed payload') }
  const data = signedPayloadSchema.parse(decodedPayload)
  if (data.institutionId !== tenant || data.studentId !== actor.id) refuse('wrong_identity', 'the scan belongs to another account or institution')
  const decoded = decodeQr(data.qr)
  if (!decoded || !z.uuid().safeParse(decoded.sessionId).success) refuse('malformed_qr', 'that is not a CampusOS attendance code')
  const payloadHash = createHash('sha256').update(bytes).digest('hex')
  return withTenant(tenant, async (tx) => {
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, data.deviceId), eq(devices.userId, actor.id))).for('share')
    if (!device || !device.publicKey) refuse('no_registered_device', 'register a signing key first')
    if (!verifyDeviceSignature(device.publicKey, bytes, envelope.signature)) refuse('signature_invalid', 'the scan signature is invalid')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:${actor.id}:${data.nonce}`}, 0))`)
    const [previous] = await tx.select().from(records).where(and(eq(records.studentId, actor.id), eq(records.scanNonce, data.nonce)))
    if (previous) {
      if (previous.payloadHash !== payloadHash) refuse('nonce_reused', 'this scan identifier was already used for another payload')
      const [course] = await tx.select({ code: courses.code }).from(sessions).innerJoin(offerings, eq(offerings.id, sessions.offeringId)).innerJoin(courses, eq(courses.id, offerings.courseId)).where(eq(sessions.id, previous.sessionId))
      return { status: 'present' as const, courseCode: course!.code, markedAt: previous.markedAt.toISOString(), capturedAt: previous.capturedAt!.toISOString(), anomalies: previous.anomalies }
    }
    if (device.status !== 'active') refuse(device.status === 'pending_approval' ? 'device_pending_approval' : 'wrong_device', 'the signing device is not active')
    const policy = await policyFor(tx, tenant)
    const now = Date.now()
    const capturedAt = new Date(data.capturedAt)
    const capturedMs = capturedAt.getTime()
    const skewMs = policy.clockSkewSeconds * 1000
    if (capturedMs > now + skewMs) refuse('clock_skew', 'the device clock is ahead; correct its time')
    const age = now - capturedMs
    const late = age > Math.max(skewMs, policy.tokenWindowSeconds * 2000)
    if (age > policy.maxLateSyncHours * 3600000 || (late && !policy.acceptLateSync)) refuse('sync_too_late', 'this scan is outside the institution sync window')
    const [credential] = await tx.select().from(offlineCredentials).where(eq(offlineCredentials.id, decoded.sessionId)).for('share')
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, decoded.sessionId)).for('share')
    if (!credential && !session) refuse('no_such_session', 'that session does not exist')
    if (credential?.revokedAt) refuse('credential_revoked', 'this session credential was revoked')
    const starts = credential?.startsAt ?? session!.openedAt
    const ends = credential?.endsAt ?? session!.closedAt
    if (capturedMs < starts.getTime() - skewMs || (ends && capturedMs > ends.getTime() + skewMs)) refuse('outside_session_window', 'the scan was captured outside this class session')
    const windowSeconds = credential?.windowSeconds ?? session!.tokenWindowSeconds
    const qrMs = decoded.window * windowSeconds * 1000
    if (Math.abs(capturedMs - qrMs) > skewMs + windowSeconds * 2000 || qrMs < starts.getTime() - windowSeconds * 1000 || (ends && qrMs > ends.getTime())) refuse('token_stale', 'the QR does not match the capture window')
    if (verifyToken(credential?.tokenSecret ?? session!.tokenSecret, decoded.sessionId, windowSeconds, decoded, qrMs) !== 'ok') refuse('token_invalid', 'the QR signature is invalid')
    if (credential) {
      await validatePreparedOccurrence(tx, credential, policy.timeZone)
    }
    const offeringId = credential?.offeringId ?? session!.offeringId
    const slotId = credential?.slotId ?? session!.slotId
    const [offering] = await tx.select({ sectionId: offerings.sectionId, courseCode: courses.code, roomId: slots.roomId }).from(offerings).innerJoin(courses, eq(courses.id, offerings.courseId)).innerJoin(slots, eq(slots.offeringId, offerings.id)).where(and(eq(offerings.id, offeringId), eq(slots.id, slotId)))
    if (!offering) refuse('no_such_session', 'the class no longer exists')
    const [member] = await tx.select({ id: sectionMembers.userId }).from(sectionMembers).where(and(eq(sectionMembers.sectionId, offering.sectionId), eq(sectionMembers.userId, actor.id)))
    if (!member) refuse('not_enrolled', 'you are not enrolled in this class')
    if (data.accuracyM > policy.maxAccuracyM) refuse('location_too_vague', 'your location is too imprecise')
    const [fence] = await tx.select().from(roomGeofences).where(eq(roomGeofences.roomId, offering.roomId))
    const anomalies: string[] = late ? ['late_sync'] : []
    if (fence && distanceM(fence, data) - data.accuracyM > (fence.radiusM ?? policy.defaultRadiusM)) refuse('outside_geofence', 'you appear to be outside the classroom')
    if (!fence) anomalies.push('room_has_no_geofence')
    if (data.accuracyM < 3) anomalies.push('implausible_accuracy')
    if (credential && !session) {
      await tx.insert(sessions).values({ id: credential.id, institutionId: tenant, slotId, offeringId, openedBy: credential.teacherId, tokenSecret: credential.tokenSecret, tokenWindowSeconds: credential.windowSeconds, openedAt: credential.startsAt, closedAt: credential.endsAt }).onConflictDoNothing()
    }
    const [twin] = await tx.select({ id: records.id }).from(records).where(and(eq(records.sessionId, decoded.sessionId), sql`round(${records.latitude}::numeric, 5) = round(${data.latitude}::numeric, 5)`, sql`round(${records.longitude}::numeric, 5) = round(${data.longitude}::numeric, 5)`)).limit(1)
    if (twin) anomalies.push('identical_coordinates')
    const [record] = await tx.insert(records).values({ institutionId: tenant, sessionId: decoded.sessionId, studentId: actor.id, method: 'scan', capturedAt, scanNonce: data.nonce, payloadHash, latitude: data.latitude, longitude: data.longitude, accuracyM: data.accuracyM, deviceId: device.id, anomalies }).onConflictDoNothing().returning()
    if (!record) refuse('already_marked', 'you are already marked present for this class')
    return { status: 'present' as const, courseCode: offering.courseCode, markedAt: record.markedAt.toISOString(), capturedAt: capturedAt.toISOString(), anomalies }
  })
}
