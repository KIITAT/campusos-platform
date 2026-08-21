import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { offerings, rooms, slots } from '@campusos/module-academic/schema'

/**
 * Attendance. dependsOn academic, so a session is always started against a
 * real timetable slot rather than a free-floating class.
 *
 * Nothing here is added to the academic module's tables. Geofences live in
 * this module's own table keyed by room, so disabling attendance leaves
 * academic clean and academic never learns that geofencing exists. Every later
 * module that wants to annotate an academic row should follow that.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const markMethodEnum = pgEnum('attendance_mark_method', [
  'scan',
  'manual_override',
])

export const deviceStatusEnum = pgEnum('attendance_device_status', [
  'active',
  'pending_approval',
  'revoked',
])

// --- per-institution settings ----------------------------------------------

/**
 * The two numbers the spec says are per-institution. Absent row means the
 * defaults in api/settings.ts, so an institution that never touches this is
 * not broken by its absence.
 */
export const settings = pgTable(
  'attendance_settings',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    /** Fallback when a room has no geofence of its own. */
    defaultRadiusM: integer('default_radius_m').notNull().default(100),
    /** Token rotation window. Short on purpose: a screenshot must go stale. */
    tokenWindowSeconds: smallint('token_window_seconds').notNull().default(7),
    /** Reject a fix whose own accuracy is worse than this; spoofers report huge radii. */
    maxAccuracyM: integer('max_accuracy_m').notNull().default(200),
  },
  () => [tenantPolicy('attendance_settings')],
)

// --- room geofences --------------------------------------------------------

export const roomGeofences = pgTable(
  'attendance_room_geofences',
  {
    institutionId: tenantId(),
    roomId: uuid('room_id')
      .primaryKey()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    latitude: doublePrecision().notNull(),
    longitude: doublePrecision().notNull(),
    /** Null means fall back to the institution default. */
    radiusM: integer('radius_m'),
    createdAt: createdAt(),
  },
  () => [
    check('attendance_geofence_lat', sql`latitude between -90 and 90`),
    check('attendance_geofence_lng', sql`longitude between -180 and 180`),
    check('attendance_geofence_radius', sql`radius_m is null or radius_m between 10 and 5000`),
    tenantPolicy('attendance_room_geofences'),
  ],
)

// --- device binding --------------------------------------------------------

/**
 * One device per student, which is the whole anti-proxy point. A lost or
 * replaced phone does not hard-block: the new device lands as
 * pending_approval and an admin releases it, because otherwise this generates
 * a support ticket every week.
 */
export const devices = pgTable(
  'attendance_devices',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Hash of a device identifier. The raw identifier is never stored. */
    deviceHash: text('device_hash').notNull(),
    label: text(),
    status: deviceStatusEnum().notNull().default('pending_approval'),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // At most one active device per student, enforced here rather than by
    // whichever code path last approved one.
    uniqueIndex('attendance_devices_one_active')
      .on(t.userId)
      .where(sql`status = 'active'`),
    uniqueIndex('attendance_devices_identity').on(t.userId, t.deviceHash),
    tenantPolicy('attendance_devices'),
  ],
)

// --- sessions --------------------------------------------------------------

/**
 * One attendance session per timetable slot occurrence. `tokenSecret` never
 * leaves the server: the rotating token is an HMAC over it, so nothing has to
 * be written per rotation and there is no expiry race.
 */
export const sessions = pgTable(
  'attendance_sessions',
  {
    id: pk(),
    institutionId: tenantId(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => slots.id, { onDelete: 'cascade' }),
    /** Denormalised from the slot so a later slot edit cannot re-point history. */
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'restrict' }),
    openedBy: text('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenSecret: text('token_secret').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    // One open session per slot at a time. Two live sessions for one class
    // would split the roster in half.
    uniqueIndex('attendance_sessions_one_open')
      .on(t.slotId)
      .where(sql`closed_at is null`),
    index('attendance_sessions_offering').on(t.offeringId),
    tenantPolicy('attendance_sessions'),
  ],
)

// --- records ---------------------------------------------------------------

/**
 * A student is present in a session at most once, and that is a unique index
 * rather than a check-then-insert. This is what actually makes the token safe
 * to reuse within its rotation window: fifty students share one token, and the
 * constraint -- not the token -- is what stops one student marking twice.
 */
export const records = pgTable(
  'attendance_records',
  {
    id: pk(),
    institutionId: tenantId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: markMethodEnum().notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),

    // Captured for review, not for re-validation. Rounded coordinates would
    // defeat the identical-coordinates anomaly check.
    latitude: doublePrecision(),
    longitude: doublePrecision(),
    accuracyM: doublePrecision('accuracy_m'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    /** Required for a manual override; feeds the phase 10 audit log. */
    overrideReason: text('override_reason'),
    markedBy: text('marked_by').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Flags, never blocks. The spec is explicit that anomalies are surfaced for
     * review rather than auto-rejected, because every signal here has a benign
     * explanation as well as a suspicious one.
     */
    anomalies: text().array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    uniqueIndex('attendance_records_once').on(t.sessionId, t.studentId),
    index('attendance_records_student').on(t.studentId),
    check(
      'attendance_records_override_reason',
      sql`method <> 'manual_override' or (override_reason is not null and length(trim(override_reason)) > 0)`,
    ),
    tenantPolicy('attendance_records'),
  ],
)
