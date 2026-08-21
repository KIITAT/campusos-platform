import { and, eq, isNull, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  courses,
  offerings,
  rooms,
  sectionMembers,
  sections,
  slots,
} from '@campusos/module-academic/schema'
import {
  devices,
  records,
  roomGeofences,
  sessions,
  settings,
} from '../schema'
import {
  approveDeviceSchema,
  closeSessionSchema,
  openSessionSchema,
  overrideSchema,
  registerDeviceSchema,
  scanSchema,
  setGeofenceSchema,
  type Roster,
  type ScanRejectionCode,
} from './schemas'
import {
  currentQr,
  decodeQr,
  distanceM,
  encodeQr,
  newSessionSecret,
  verifyToken,
} from './token'

export interface Actor {
  id: string
  role: Role
  institutionId: string | null
}

export class AttendanceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** A scan rejection is a 409 with a closed-set code the mobile client switches on. */
class ScanRejected extends AttendanceError {
  constructor(code: ScanRejectionCode, message: string, detail?: Record<string, unknown>) {
    super(409, code, message, detail)
  }
}

const DEFAULTS = { defaultRadiusM: 100, tokenWindowSeconds: 7, maxAccuracyM: 200 }

function tenantOf(actor: Actor): string {
  if (!actor.institutionId) {
    throw new AttendanceError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

const canRunSessions = (r: Role) =>
  r === 'faculty' || r === 'hod' || r === 'institution_admin' || r === 'super_admin'

const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/** Absent settings row means the defaults, so an untouched institution works. */
async function settingsFor(tx: Tx, institutionId: string) {
  const [row] = await tx.select().from(settings).where(eq(settings.institutionId, institutionId))
  return row ?? { institutionId, ...DEFAULTS }
}

// --- sessions --------------------------------------------------------------

export async function openSession(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canRunSessions(actor.role)) {
    throw new AttendanceError(403, 'forbidden', 'not permitted')
  }
  const { slotId } = openSessionSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [slot] = await tx
      .select({ offeringId: slots.offeringId, facultyUserId: offerings.facultyUserId })
      .from(slots)
      .innerJoin(offerings, eq(offerings.id, slots.offeringId))
      .where(eq(slots.id, slotId))
    if (!slot) throw new AttendanceError(404, 'no_such_slot', 'no such timetable slot')

    // A lecturer may only open their own class. An admin may open any, because
    // someone has to when the lecturer's laptop dies mid-lecture.
    if (actor.role === 'faculty' && slot.facultyUserId !== actor.id) {
      throw new AttendanceError(403, 'not_your_class', 'that is not your class')
    }

    try {
      const [row] = await tx
        .insert(sessions)
        .values({
          institutionId: tenant,
          slotId,
          offeringId: slot.offeringId,
          openedBy: actor.id,
          tokenSecret: newSessionSecret(),
        })
        .returning({ id: sessions.id, openedAt: sessions.openedAt })
      return row!
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new AttendanceError(409, 'already_open', 'a session is already open for this slot')
      }
      throw e
    }
  })
}

export async function closeSession(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canRunSessions(actor.role)) {
    throw new AttendanceError(403, 'forbidden', 'not permitted')
  }
  const { sessionId } = closeSessionSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [row] = await tx
      .update(sessions)
      .set({ closedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)))
      .returning({ id: sessions.id })
    if (!row) throw new AttendanceError(404, 'no_open_session', 'no open session with that id')
  })
}

/**
 * The current QR for a session. The faculty view polls this; every call
 * recomputes rather than reading a stored token, so there is no rotation write
 * and no expiry race.
 */
export async function currentQrFor(actor: Actor, sessionId: string) {
  const tenant = tenantOf(actor)
  if (!canRunSessions(actor.role)) {
    throw new AttendanceError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx) => {
    const s = await settingsFor(tx, tenant)
    const [row] = await tx
      .select({ secret: sessions.tokenSecret, closedAt: sessions.closedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
    if (!row) throw new AttendanceError(404, 'no_such_session', 'no such session')
    if (row.closedAt) throw new AttendanceError(409, 'session_closed', 'session is closed')

    const qr = currentQr(row.secret, sessionId, s.tokenWindowSeconds)
    return {
      sessionId,
      qr: encodeQr(qr),
      expiresInMs: qr.expiresInMs,
      windowSeconds: s.tokenWindowSeconds,
    }
  })
}

// --- devices ---------------------------------------------------------------

/**
 * A student registers a device. The first one still needs approval: silently
 * trusting whichever handset appeared first would make the binding decorative.
 */
export async function registerDevice(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') {
    throw new AttendanceError(403, 'forbidden', 'only students register a device')
  }
  const data = registerDeviceSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(devices)
      .values({
        institutionId: tenant,
        userId: actor.id,
        deviceHash: data.deviceHash,
        label: data.label ?? null,
      })
      .onConflictDoNothing({ target: [devices.userId, devices.deviceHash] })
      .returning({ id: devices.id, status: devices.status })

    if (row) return row
    // Already known: report its current state rather than creating a duplicate.
    const [existing] = await tx
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(and(eq(devices.userId, actor.id), eq(devices.deviceHash, data.deviceHash)))
    return existing!
  })
}

/**
 * Admin releases a replacement device. Revokes whatever was active first, in
 * the same transaction, because the partial unique index permits only one.
 */
export async function approveDevice(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new AttendanceError(403, 'forbidden', 'not permitted')
  const { deviceId } = approveDeviceSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [target] = await tx
      .select({ userId: devices.userId })
      .from(devices)
      .where(eq(devices.id, deviceId))
    if (!target) throw new AttendanceError(404, 'no_such_device', 'no such device')

    await tx
      .update(devices)
      .set({ status: 'revoked' })
      .where(and(eq(devices.userId, target.userId), eq(devices.status, 'active')))

    await tx
      .update(devices)
      .set({ status: 'active', approvedBy: actor.id, approvedAt: new Date() })
      .where(eq(devices.id, deviceId))
  })
}

export async function listPendingDevices(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new AttendanceError(403, 'forbidden', 'not permitted')

  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: devices.id,
        label: devices.label,
        createdAt: devices.createdAt,
        studentName: users.name,
        studentEmail: users.email,
      })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.status, 'pending_approval'))
      .orderBy(devices.createdAt),
  )
}

// --- geofences -------------------------------------------------------------

export async function setGeofence(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new AttendanceError(403, 'forbidden', 'not permitted')
  const data = setGeofenceSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [room] = await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, data.roomId))
    if (!room) throw new AttendanceError(404, 'no_such_room', 'no such room')

    await tx
      .insert(roomGeofences)
      .values({
        institutionId: tenant,
        roomId: data.roomId,
        latitude: data.latitude,
        longitude: data.longitude,
        radiusM: data.radiusM ?? null,
      })
      .onConflictDoUpdate({
        target: roomGeofences.roomId,
        set: {
          latitude: data.latitude,
          longitude: data.longitude,
          radiusM: data.radiusM ?? null,
        },
      })
  })
}

// --- the scan --------------------------------------------------------------

/**
 * The validation pipeline, in the spec's order, rejecting on first failure:
 * token, then enrolment, then geofence, then device.
 *
 * Order matters for what it reveals as much as for cost. A stale token is
 * answered before we say anything about enrolment, so the endpoint cannot be
 * used to enumerate who is in a section.
 */
export async function scan(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') {
    throw new AttendanceError(403, 'forbidden', 'only students scan')
  }
  const data = scanSchema.parse(input)

  const decoded = decodeQr(data.qr)
  if (!decoded) throw new ScanRejected('malformed_qr', 'that is not a CampusOS attendance code')

  return withTenant(tenant, async (tx) => {
    const s = await settingsFor(tx, tenant)

    // 1. the session and the token
    const [session] = await tx
      .select({
        id: sessions.id,
        secret: sessions.tokenSecret,
        closedAt: sessions.closedAt,
        offeringId: sessions.offeringId,
        sectionId: offerings.sectionId,
        courseCode: courses.code,
        roomId: slots.roomId,
      })
      .from(sessions)
      .innerJoin(offerings, eq(offerings.id, sessions.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(slots, eq(slots.id, sessions.slotId))
      .where(eq(sessions.id, decoded.sessionId))

    if (!session) throw new ScanRejected('no_such_session', 'that session does not exist')
    if (session.closedAt) {
      throw new ScanRejected('session_closed', 'attendance for that class has closed')
    }

    const verdict = verifyToken(session.secret, session.id, s.tokenWindowSeconds, decoded)
    if (verdict === 'stale') {
      throw new ScanRejected('token_stale', 'that code has expired -- scan the new one')
    }
    if (verdict === 'invalid') {
      throw new ScanRejected('token_invalid', 'that code is not valid for this class')
    }

    // 2. enrolment
    const [enrolled] = await tx
      .select({ userId: sectionMembers.userId })
      .from(sectionMembers)
      .where(
        and(
          eq(sectionMembers.sectionId, session.sectionId),
          eq(sectionMembers.userId, actor.id),
        ),
      )
    if (!enrolled) throw new ScanRejected('not_enrolled', 'you are not enrolled in this class')

    // 3. location
    if (data.accuracyM > s.maxAccuracyM) {
      throw new ScanRejected(
        'location_too_vague',
        `your location is only accurate to ${Math.round(data.accuracyM)}m -- move somewhere with a clearer signal`,
      )
    }

    const [fence] = await tx
      .select()
      .from(roomGeofences)
      .where(eq(roomGeofences.roomId, session.roomId))

    const anomalies: string[] = []
    if (fence) {
      const away = distanceM(fence, data)
      const radius = fence.radiusM ?? s.defaultRadiusM
      // The reported accuracy is allowed as slack: rejecting a student standing
      // in the room because their phone is unsure would be the common case.
      if (away - data.accuracyM > radius) {
        throw new ScanRejected(
          'outside_geofence',
          'you appear to be outside the classroom',
          { distanceM: Math.round(away) },
        )
      }
    } else {
      // Flagged, not blocked: an unmapped room is an admin omission, and
      // refusing the whole class for it would be worse than recording the gap.
      anomalies.push('room_has_no_geofence')
    }

    // A phone claiming sub-3m accuracy indoors is usually a mock-location app.
    if (data.accuracyM < 3) anomalies.push('implausible_accuracy')

    // 4. device binding
    const [device] = await tx
      .select({ id: devices.id, hash: devices.deviceHash })
      .from(devices)
      .where(and(eq(devices.userId, actor.id), eq(devices.status, 'active')))

    if (!device) {
      const [pending] = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, actor.id), eq(devices.status, 'pending_approval')))
      throw new ScanRejected(
        pending ? 'device_pending_approval' : 'no_registered_device',
        pending
          ? 'your device is waiting for an administrator to approve it'
          : 'register this device with your institution first',
      )
    }
    if (device.hash !== data.deviceHash) {
      throw new ScanRejected(
        'wrong_device',
        'this is not your registered device -- ask an administrator to move your registration',
      )
    }

    // Many students at one exact coordinate within a session is the classic
    // shared-GPS-spoof signature. Flagged for review, never auto-blocked.
    const [twin] = await tx
      .select({ id: records.id })
      .from(records)
      .where(
        and(
          eq(records.sessionId, session.id),
          sql`round(${records.latitude}::numeric, 5) = round(${data.latitude}::numeric, 5)`,
          sql`round(${records.longitude}::numeric, 5) = round(${data.longitude}::numeric, 5)`,
        ),
      )
      .limit(1)
    if (twin) anomalies.push('identical_coordinates')

    // 5. mark. The unique index is what makes a shared token safe: fifty
    // students use the same one, and this is what stops any of them twice.
    try {
      const [row] = await tx
        .insert(records)
        .values({
          institutionId: tenant,
          sessionId: session.id,
          studentId: actor.id,
          method: 'scan',
          latitude: data.latitude,
          longitude: data.longitude,
          accuracyM: data.accuracyM,
          deviceId: device.id,
          anomalies,
        })
        .returning({ markedAt: records.markedAt })
      return {
        status: 'present' as const,
        courseCode: session.courseCode,
        markedAt: row!.markedAt.toISOString(),
      }
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new ScanRejected('already_marked', 'you are already marked present for this class')
      }
      throw e
    }
  })
}

// --- manual override -------------------------------------------------------

/**
 * Illness, a dead phone, an accessibility need. The reason is mandatory in the
 * schema as well as here, and every override is distinguishable from a scan
 * forever, which is what makes the phase 10 audit trail possible.
 */
export async function override(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canRunSessions(actor.role)) {
    throw new AttendanceError(403, 'forbidden', 'not permitted')
  }
  const data = overrideSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id, sectionId: offerings.sectionId })
      .from(sessions)
      .innerJoin(offerings, eq(offerings.id, sessions.offeringId))
      .where(eq(sessions.id, data.sessionId))
    if (!session) throw new AttendanceError(404, 'no_such_session', 'no such session')

    const [enrolled] = await tx
      .select({ userId: sectionMembers.userId })
      .from(sectionMembers)
      .where(
        and(
          eq(sectionMembers.sectionId, session.sectionId),
          eq(sectionMembers.userId, data.studentId),
        ),
      )
    if (!enrolled) {
      throw new AttendanceError(404, 'not_enrolled', 'that student is not in this class')
    }

    await tx
      .insert(records)
      .values({
        institutionId: tenant,
        sessionId: session.id,
        studentId: data.studentId,
        method: 'manual_override',
        overrideReason: data.reason,
        markedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: [records.sessionId, records.studentId],
        set: {
          method: 'manual_override',
          overrideReason: data.reason,
          markedBy: actor.id,
          markedAt: new Date(),
        },
      })
  })
}

// --- reads -----------------------------------------------------------------

/** The full cohort with who is marked, for the faculty view and the reports. */
export async function roster(actor: Actor, sessionId: string): Promise<Roster> {
  const tenant = tenantOf(actor)
  if (!canRunSessions(actor.role)) {
    throw new AttendanceError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx) => {
    const [head] = await tx
      .select({
        sessionId: sessions.id,
        openedAt: sessions.openedAt,
        closedAt: sessions.closedAt,
        sectionId: offerings.sectionId,
        courseCode: courses.code,
        sectionLabel: sections.label,
        roomCode: rooms.code,
      })
      .from(sessions)
      .innerJoin(offerings, eq(offerings.id, sessions.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(slots, eq(slots.id, sessions.slotId))
      .innerJoin(rooms, eq(rooms.id, slots.roomId))
      .where(eq(sessions.id, sessionId))
    if (!head) throw new AttendanceError(404, 'no_such_session', 'no such session')

    const rows = await tx
      .select({
        studentId: sectionMembers.userId,
        name: users.name,
        email: users.email,
        method: records.method,
        markedAt: records.markedAt,
        overrideReason: records.overrideReason,
        anomalies: records.anomalies,
      })
      .from(sectionMembers)
      .innerJoin(users, eq(users.id, sectionMembers.userId))
      .leftJoin(
        records,
        and(eq(records.studentId, sectionMembers.userId), eq(records.sessionId, sessionId)),
      )
      .where(eq(sectionMembers.sectionId, head.sectionId))
      .orderBy(users.email)

    const entries = rows.map((r) => ({
      studentId: r.studentId,
      name: r.name,
      email: r.email,
      status: (r.method ? 'present' : 'absent') as 'present' | 'absent',
      method: r.method,
      markedAt: r.markedAt?.toISOString() ?? null,
      overrideReason: r.overrideReason,
      anomalies: r.anomalies ?? [],
    }))

    return {
      sessionId: head.sessionId,
      courseCode: head.courseCode,
      sectionLabel: head.sectionLabel,
      roomCode: head.roomCode,
      openedAt: head.openedAt.toISOString(),
      closedAt: head.closedAt?.toISOString() ?? null,
      present: entries.filter((e) => e.status === 'present').length,
      total: entries.length,
      entries,
    }
  })
}

/** Open sessions the caller may act on, for the faculty landing view. */
export async function openSessions(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!canRunSessions(actor.role)) {
    throw new AttendanceError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, (tx) =>
    tx
      .select({
        sessionId: sessions.id,
        slotId: sessions.slotId,
        openedAt: sessions.openedAt,
        courseCode: courses.code,
        sectionLabel: sections.label,
        roomCode: rooms.code,
      })
      .from(sessions)
      .innerJoin(offerings, eq(offerings.id, sessions.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(slots, eq(slots.id, sessions.slotId))
      .innerJoin(rooms, eq(rooms.id, slots.roomId))
      .where(isNull(sessions.closedAt))
      .orderBy(sessions.openedAt),
  )
}

/** A student's own history. Read-only, own rows only. */
export async function myAttendance(actor: Actor) {
  const tenant = tenantOf(actor)

  return withTenant(tenant, (tx) =>
    tx
      .select({
        sessionId: records.sessionId,
        courseCode: courses.code,
        markedAt: records.markedAt,
        method: records.method,
      })
      .from(records)
      .innerJoin(sessions, eq(sessions.id, records.sessionId))
      .innerJoin(offerings, eq(offerings.id, sessions.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .where(eq(records.studentId, actor.id))
      .orderBy(records.markedAt),
  )
}
