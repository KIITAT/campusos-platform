import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
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
    /** Overrides the institution's curfew for this block (P2-22a); null uses the policy. */
    curfewTime: time('curfew_time'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_blocks_code').on(t.institutionId, t.code),
    check('hostel_blocks_code_shape', sql`length(trim(code)) > 0`),
    check('hostel_blocks_curfew', sql`curfew_time is null or curfew_time between '17:00' and '23:59'`),
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
    /** What one bed costs a term, charged through fees. Null: not charged. */
    termFeePaise: bigint('term_fee_paise', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_rooms_number').on(t.blockId, t.number),
    index('hostel_rooms_block').on(t.blockId),
    check('hostel_rooms_capacity', sql`capacity between 1 and 20`),
    check('hostel_rooms_floor', sql`floor between -2 and 60`),
    check('hostel_rooms_term_fee', sql`term_fee_paise is null or term_fee_paise > 0`),
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

// --- presence and curfew (P2-22a) -------------------------------------------

/** One row per institution, created on first write; reads fall back to code defaults (D1320). */
export const policy = pgTable(
  'hostel_policy',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    curfewTime: time('curfew_time').notNull().default('21:30'),
    nudgeAfterMin: smallint('nudge_after_min').notNull().default(10),
    wardenAfterMin: smallint('warden_after_min').notNull().default(30),
    womensWardenAfterMin: smallint('womens_warden_after_min').notNull().default(15),
    guardianAfterMin: smallint('guardian_after_min').notNull().default(60),
    walkBackMin: smallint('walk_back_min').notNull().default(20),
    caseWindowHours: smallint('case_window_hours').notNull().default(6),
    latePassLatestTime: time('late_pass_latest_time').notNull().default('01:00'),
    notifyWardenOnLibraryEntry: boolean('notify_warden_on_library_entry').notNull().default(false),
    presenceRetentionDays: smallint('presence_retention_days').notNull().default(90),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      'hostel_policy_ladder',
      sql`nudge_after_min between 0 and 120 and womens_warden_after_min > nudge_after_min and warden_after_min > nudge_after_min and guardian_after_min > warden_after_min and guardian_after_min > womens_warden_after_min and guardian_after_min <= 360`,
    ),
    check('hostel_policy_curfew', sql`curfew_time between '17:00' and '23:59'`),
    check('hostel_policy_walk_back', sql`walk_back_min between 0 and 90`),
    check('hostel_policy_window', sql`case_window_hours between 1 and 12`),
    check('hostel_policy_retention', sql`presence_retention_days between 30 and 730`),
    check('hostel_policy_late_latest', sql`late_pass_latest_time <= '04:00'`),
    tenantPolicy('hostel_policy'),
  ],
)

/** Floor, block, chief and estate wardens are scope rows on the hostel_staff role (D1307, D1342). */
export const wardenScopes = pgTable(
  'hostel_warden_scopes',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    level: text().notNull(),
    blockId: uuid('block_id').references(() => blocks.id, { onDelete: 'cascade' }),
    floor: smallint(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_scopes_unique').on(
      t.userId,
      t.level,
      sql`coalesce(block_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(floor, -99)`,
    ),
    index('hostel_scopes_level_idx').on(t.institutionId, t.level),
    check('hostel_scopes_level', sql`level in ('floor', 'block', 'chief', 'estate')`),
    check(
      'hostel_scopes_shape',
      sql`(level = 'floor' and block_id is not null and floor is not null) or (level = 'block' and block_id is not null and floor is null) or (level in ('chief', 'estate') and block_id is null and floor is null)`,
    ),
    tenantPolicy('hostel_warden_scopes'),
  ],
)

/** An exam-period extension: curfew moves to `until_time` for a block (or all) on these dates (D1336). */
export const lateStayWindows = pgTable(
  'hostel_late_stay_windows',
  {
    id: pk(),
    institutionId: tenantId(),
    blockId: uuid('block_id').references(() => blocks.id, { onDelete: 'cascade' }),
    fromOn: date('from_on').notNull(),
    toOn: date('to_on').notNull(),
    untilTime: time('until_time').notNull(),
    reason: text().notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('hostel_windows_range').on(t.institutionId, t.fromOn, t.toOn),
    check('hostel_windows_dates', sql`to_on >= from_on and to_on - from_on <= 60`),
    check('hostel_windows_until', sql`until_time between '21:00' and '23:59'`),
    check('hostel_windows_reason', sql`length(trim(reason)) between 5 and 200`),
    tenantPolicy('hostel_late_stay_windows'),
  ],
)

/** A resident's late-stay pass for one night; nothing is auto-approved (D1337). */
export const latePasses = pgTable(
  'hostel_late_passes',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    night: date().notNull(),
    untilAt: timestamp('until_at', { withTimezone: true }).notNull(),
    reason: text().notNull(),
    status: text().notNull().default('requested'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hostel_late_passes_open')
      .on(t.studentId, t.night)
      .where(sql`status in ('requested', 'approved')`),
    index('hostel_late_passes_night').on(t.institutionId, t.night),
    check('hostel_passes_status', sql`status in ('requested', 'approved', 'refused', 'cancelled', 'lapsed')`),
    check('hostel_passes_reason', sql`length(trim(reason)) between 5 and 200`),
    tenantPolicy('hostel_late_passes'),
  ],
)

/** One case per resident per night once the nudge is due; the ladder is stamped on it (D1326, D1328). */
export const curfewCases = pgTable(
  'hostel_curfew_cases',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockId: uuid('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    night: date().notNull(),
    curfewAt: timestamp('curfew_at', { withTimezone: true }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    nudgeAt: timestamp('nudge_at', { withTimezone: true }),
    wardenAt: timestamp('warden_at', { withTimezone: true }),
    guardianAt: timestamp('guardian_at', { withTimezone: true }),
    heldKind: text('held_kind'),
    heldUntil: timestamp('held_until', { withTimezone: true }),
    ladderFrom: timestamp('ladder_from', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text(),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    note: text(),
  },
  (t) => [
    uniqueIndex('hostel_cases_once').on(t.studentId, t.night),
    index('hostel_cases_open')
      .on(t.institutionId)
      .where(sql`resolved_at is null`),
    index('hostel_cases_block_night').on(t.blockId, t.night),
    check(
      'hostel_cases_resolution',
      sql`resolution is null or resolution in ('checked_in', 'leave', 'warden_verified', 'warden_closed', 'lapsed')`,
    ),
    check('hostel_cases_held', sql`held_kind is null or held_kind in ('late_pass', 'library', 'class')`),
    check('hostel_cases_resolved_together', sql`(resolved_at is null) = (resolution is null)`),
    check('hostel_cases_note', sql`note is null or length(note) between 5 and 300`),
    tenantPolicy('hostel_curfew_cases'),
  ],
)

/** The timeline: what the hostel was told and what it did. Unique per source event, so a repeat is harmless (D1334). */
export const presenceLog = pgTable(
  'hostel_presence_log',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    at: timestamp({ withTimezone: true }).notNull(),
    kind: text().notNull(),
    source: text().notNull(),
    sourceRef: text('source_ref'),
    detail: jsonb().notNull().default({}),
  },
  (t) => [
    uniqueIndex('hostel_log_source_once')
      .on(t.institutionId, t.source, t.sourceRef, t.kind)
      .where(sql`source_ref is not null`),
    index('hostel_log_student').on(t.studentId, t.at.desc()),
    check(
      'hostel_log_kind',
      sql`kind in ('library_entered', 'library_exited', 'library_unconfirmed', 'case_opened', 'student_nudged', 'warden_alerted', 'guardian_alerted', 'case_resolved', 'late_pass_decided', 'case_held', 'manual_mark_replaced')`,
    ),
    tenantPolicy('hostel_presence_log'),
  ],
)

/** How far this institution's consumer has read each source's outbox. */
export const eventCursors = pgTable(
  'hostel_event_cursors',
  {
    institutionId: tenantId(),
    source: text().notNull(),
    lastId: bigint('last_id', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.institutionId, t.source] }), tenantPolicy('hostel_event_cursors')],
)

export type Block = typeof blocks.$inferSelect
export type Room = typeof rooms.$inferSelect
export type Allocation = typeof allocations.$inferSelect
export type CheckIn = typeof checkIns.$inferSelect
export type Leave = typeof leaves.$inferSelect
export type Visitor = typeof visitors.$inferSelect
