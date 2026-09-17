import * as z from 'zod'

const uuid = z.uuid()

export const openSessionSchema = z
  .object({ slotId: uuid })
  .meta({ id: 'AttendanceOpenSession' })

export const closeSessionSchema = z
  .object({ sessionId: uuid })
  .meta({ id: 'AttendanceCloseSession' })

/**
 * What the Flutter client posts. `accuracyM` is required, not optional: a
 * client that omits it would otherwise skip the spoofing check that rejects
 * implausibly precise or implausibly vague fixes.
 */
export const scanSchema = z
  .object({
    qr: z.string().min(3).max(200),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000),
    deviceHash: z.string().min(16).max(200),
    /**
     * The client asserts that the person holding the phone passed its screen
     * lock -- biometric or PIN -- immediately before this scan.
     *
     * Defaulted rather than required so an older build gets the closed-set
     * rejection with something readable in it instead of a schema error. The
     * assertion is a client claim and nothing here can prove it; what it buys
     * is that handing an unlocked phone to a friend is no longer enough, the
     * friend has to hold the owner's finger to the sensor. That is a different
     * and much less casual act, which is the whole of the defence.
     */
    deviceLockConfirmed: z.boolean().default(false),
  })
  .meta({ id: 'AttendanceScan' })

export const scanResultSchema = z
  .object({
    status: z.literal('present'),
    courseCode: z.string(),
    markedAt: z.iso.datetime(),
  })
  .meta({ id: 'AttendanceScanResult' })

/**
 * Every rejection the scan endpoint can return, as a closed set, so the mobile
 * client can say something true rather than "something went wrong". The spec is
 * explicit that a failed scan gets an honest immediate error and no offline
 * retry queue -- the short window is the point, and a queue would undo it.
 */
export const scanRejectionSchema = z
  .object({
    error: z.enum([
      'malformed_qr',
      'no_such_session',
      'session_closed',
      'token_stale',
      'token_invalid',
      'not_enrolled',
      'outside_geofence',
      'location_too_vague',
      'no_registered_device',
      'device_pending_approval',
      'wrong_device',
      'device_not_confirmed',
      'already_marked',
    ]),
    message: z.string(),
    /** Present on outside_geofence so the app can say how far off it was. */
    distanceM: z.number().optional(),
  })
  .meta({ id: 'AttendanceScanRejection' })

export const registerDeviceSchema = z
  .object({
    deviceHash: z.string().min(16).max(200),
    label: z.string().max(80).nullish(),
  })
  .meta({ id: 'AttendanceRegisterDevice' })

export const approveDeviceSchema = z
  .object({ deviceId: uuid })
  .meta({ id: 'AttendanceApproveDevice' })

export const overrideSchema = z
  .object({
    sessionId: uuid,
    studentId: z.string().min(1),
    // Required and non-trivial. The database enforces this too; both exist so
    // the faculty member sees it next to the field.
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'AttendanceOverride' })

export const setGeofenceSchema = z
  .object({
    roomId: uuid,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusM: z.coerce.number().int().min(10).max(5000).nullish(),
  })
  .meta({ id: 'AttendanceSetGeofence' })

export const rosterEntrySchema = z
  .object({
    studentId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    status: z.enum(['present', 'absent']),
    method: z.enum(['scan', 'manual_override']).nullable(),
    markedAt: z.string().nullable(),
    overrideReason: z.string().nullable(),
    anomalies: z.array(z.string()),
  })
  .meta({ id: 'AttendanceRosterEntry' })

export const rosterSchema = z
  .object({
    sessionId: uuid,
    courseCode: z.string(),
    sectionLabel: z.string(),
    roomCode: z.string(),
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    present: z.number().int(),
    total: z.number().int(),
    entries: z.array(rosterEntrySchema),
  })
  .meta({ id: 'AttendanceRoster' })

export const qrSchema = z
  .object({
    sessionId: uuid,
    qr: z.string(),
    expiresInMs: z.number().int(),
    windowSeconds: z.number().int(),
  })
  .meta({ id: 'AttendanceQr' })

export type Roster = z.infer<typeof rosterSchema>
export type RosterEntry = z.infer<typeof rosterEntrySchema>
export type ScanRejectionCode = z.infer<typeof scanRejectionSchema>['error']
