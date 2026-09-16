import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

/**
 * Hostel.
 *
 * Residence, not academics: a student belongs to a room, and the roll call at
 * night is a different question from whether they attended a lecture. Nothing
 * here joins to an offering, which is why this module depends on academic only
 * for the roster it draws students from.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/**
 * Indian hostels are almost always single-sex, and allocating a student to the
 * wrong block is the mistake with the worst consequences in this module. `any`
 * exists for institutions that do not work that way rather than as a default.
 */
export const blockKindEnum = pgEnum('hostel_block_kind', ['mens', 'womens', 'any'])

export const checkInStatusEnum = pgEnum('hostel_check_in_status', [
  'present',
  'absent',
  'on_leave',
])

/** How a check-in was recorded. Scan only exists when Attendance is enabled. */
export const checkInMethodEnum = pgEnum('hostel_check_in_method', ['scan', 'manual'])

// --- inventory -------------------------------------------------------------

export const blocks = pgTable(
  'hostel_blocks',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    kind: blockKindEnum().notNull().default('any'),
    wardenUserId: text('warden_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_blocks_code').on(t.institutionId, t.code),
    check('hostel_blocks_code_shape', sql`length(trim(code)) > 0`),
    tenantPolicy('hostel_blocks'),
  ],
)

export const rooms = pgTable(
  'hostel_rooms',
  {
    id: pk(),
    institutionId: tenantId(),
    blockId: uuid('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    number: text().notNull(),
    floor: smallint().notNull().default(0),
    capacity: smallint().notNull().default(2),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_rooms_number').on(t.blockId, t.number),
    index('hostel_rooms_block').on(t.blockId),
    check('hostel_rooms_capacity', sql`capacity between 1 and 20`),
    check('hostel_rooms_floor', sql`floor between -2 and 60`),
    tenantPolicy('hostel_rooms'),
  ],
)

// --- residence -------------------------------------------------------------

/**
 * A student in a room for a stretch of time. Open while `vacated_on` is null,
 * and a student has at most one open allocation -- a partial unique index, so
 * being in two rooms at once is refused by Postgres rather than by whichever
 * code path checked first.
 *
 * History is kept rather than overwritten: "who was in 204 last March" is a
 * question hostels are asked, usually by somebody official.
 */
export const allocations = pgTable(
  'hostel_allocations',
  {
    id: pk(),
    institutionId: tenantId(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    allocatedOn: date('allocated_on').notNull(),
    vacatedOn: date('vacated_on'),
    allocatedBy: text('allocated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_allocations_one_open')
      .on(t.studentId)
      .where(sql`vacated_on is null`),
    index('hostel_allocations_room').on(t.roomId, t.vacatedOn),
    check(
      'hostel_allocations_dates',
      sql`vacated_on is null or vacated_on >= allocated_on`,
    ),
    tenantPolicy('hostel_allocations'),
  ],
)

// --- roll call -------------------------------------------------------------

/**
 * One row per resident per night. The unique index is the whole anti-replay
 * story: a second scan cannot produce a second row, exactly as in Attendance.
 */
export const checkIns = pgTable(
  'hostel_check_ins',
  {
    id: pk(),
    institutionId: tenantId(),
    blockId: uuid('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    onNight: date('on_night').notNull(),
    status: checkInStatusEnum().notNull().default('present'),
    method: checkInMethodEnum().notNull(),
    note: text(),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hostel_check_ins_once').on(t.studentId, t.onNight),
    index('hostel_check_ins_night').on(t.blockId, t.onNight),
    tenantPolicy('hostel_check_ins'),
  ],
)

/**
 * Leave granted in advance, so the roll call knows an empty bed is expected
 * rather than missing. Overlapping leave for one student is refused by an
 * exclusion constraint in the migration -- drizzle-kit has no builder for it.
 */
export const leaves = pgTable(
  'hostel_leaves',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromOn: date('from_on').notNull(),
    toOn: date('to_on').notNull(),
    reason: text().notNull(),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('hostel_leaves_student').on(t.studentId, t.fromOn),
    check('hostel_leaves_dates', sql`to_on >= from_on`),
    check('hostel_leaves_reason', sql`length(trim(reason)) >= 5`),
    tenantPolicy('hostel_leaves'),
  ],
)

// --- visitors --------------------------------------------------------------

/**
 * The gate register. Deliberately a log rather than an approval workflow: what
 * a hostel needs at 21:40 is a record of who came, who they came for, and
 * whether they have left yet.
 */
export const visitors = pgTable(
  'hostel_visitors',
  {
    id: pk(),
    institutionId: tenantId(),
    blockId: uuid('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    studentId: text('student_id').references(() => users.id, { onDelete: 'set null' }),
    name: text().notNull(),
    phone: text(),
    relation: text(),
    purpose: text(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('hostel_visitors_open').on(t.blockId, t.exitedAt),
    index('hostel_visitors_student').on(t.studentId),
    check('hostel_visitors_name', sql`length(trim(name)) > 0`),
    check('hostel_visitors_times', sql`exited_at is null or exited_at >= entered_at`),
    tenantPolicy('hostel_visitors'),
  ],
)

export type Block = typeof blocks.$inferSelect
export type Room = typeof rooms.$inferSelect
export type Allocation = typeof allocations.$inferSelect
export type CheckIn = typeof checkIns.$inferSelect
export type Leave = typeof leaves.$inferSelect
export type Visitor = typeof visitors.$inferSelect
