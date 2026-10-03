import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

/**
 * Student care: self-checks a student takes for themselves, and the
 * counselling they ask for.
 *
 * Confidential by construction. A result is the student's: nobody else reads
 * it unless the student shares it with a request for help, and then only the
 * counsellors. A case -- the request, its appointments, the counsellor's
 * notes -- is the counsellor's who took it. The office names the counsellors,
 * sets the helpline, and sees counts, never a person: there is no screen and
 * no endpoint that shows the office who asked for help or how anyone scored.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/** What a student sees at the top of every page: who to call, and where to go. */
export const settings = pgTable(
  'care_settings',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    /** A helpline for a crisis, as the institution writes it for its region. */
    crisisLine: text('crisis_line').notNull().default(''),
    /** The counselling centre: where it is and when it is open. */
    contact: text().notNull().default(''),
    /** The zone appointment times are read and shown in. */
    timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('care_settings_lengths', sql`length(crisis_line) <= 300 and length(contact) <= 500`),
    tenantPolicy('care_settings'),
  ],
)

/** The people students may be seen by. Any member of staff the office names. */
export const counsellors = pgTable(
  'care_counsellors',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** How students know them: "Counsellor, Student Care Centre". */
    title: text().notNull(),
    active: boolean().notNull().default(true),
    addedBy: text('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('care_counsellors_user').on(t.institutionId, t.userId),
    check('care_counsellors_title', sql`length(trim(title)) between 2 and 80`),
    tenantPolicy('care_counsellors'),
  ],
)

/**
 * A check of the institution's own. Fixed once written, because a score means
 * what the questions meant when it was taken; a new version is a new check,
 * and an old one is retired rather than deleted.
 */
export const instruments = pgTable(
  'care_instruments',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    about: text().notNull(),
    stem: text().notNull(),
    /** Where the questions come from, shown to every student who takes it. */
    source: text().notNull(),
    options: jsonb().notNull(),
    items: jsonb().notNull(),
    bands: jsonb().notNull(),
    maxScore: integer('max_score').notNull(),
    active: boolean().notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('care_instruments_code').on(t.institutionId, sql`upper(code)`),
    check('care_instruments_builtin', sql`upper(code) not in ('PHQ-9', 'GAD-7')`),
    check('care_instruments_shape', sql`jsonb_typeof(items) = 'array' and jsonb_typeof(bands) = 'array' and jsonb_typeof(options) = 'array' and max_score > 0`),
    check('care_instruments_source', sql`length(trim(source)) >= 10`),
    tenantPolicy('care_instruments'),
  ],
)

/**
 * One self-check, as the student answered it. Never edited; the student may
 * delete it, and nobody else may.
 */
export const results = pgTable(
  'care_results',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `PHQ-9`, `GAD-7`, or the institution's own check's code. */
    instrumentCode: text('instrument_code').notNull(),
    instrumentId: uuid('instrument_id').references(() => instruments.id, { onDelete: 'restrict' }),
    /** The answer chosen for each question, by its place; null where an optional one was left. */
    answers: smallint().array().notNull(),
    score: integer().notNull(),
    maxScore: integer('max_score').notNull(),
    band: text().notNull(),
    /** Its place among the check's bands, 0 the lowest. */
    bandRank: smallint('band_rank').notNull(),
    /** A safety question was answered above "not at all". */
    safety: boolean().notNull().default(false),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('care_results_student').on(t.studentId, t.takenAt),
    index('care_results_instrument').on(t.institutionId, t.instrumentCode, t.takenAt),
    check('care_results_score', sql`score between 0 and max_score and band_rank >= 0`),
    tenantPolicy('care_results'),
  ],
)

export const topicEnum = pgEnum('care_topic', [
  'studies',
  'mood',
  'anxiety',
  'relationships',
  'family',
  'health',
  'loss',
  'other',
  'not_said',
])
export const urgencyEnum = pgEnum('care_urgency', ['routine', 'soon', 'today'])
export const modeEnum = pgEnum('care_mode', ['in_person', 'phone', 'video'])
export const requestStatusEnum = pgEnum('care_request_status', ['waiting', 'accepted', 'closed', 'withdrawn'])
export const outcomeEnum = pgEnum('care_outcome', ['supported', 'referred', 'no_response'])
export const appointmentStatusEnum = pgEnum('care_appointment_status', ['booked', 'held', 'missed', 'cancelled'])

/**
 * A student asking to see a counsellor. Waits for one to take it; is closed
 * by them with an outcome, or withdrawn by the student. What the student
 * asked never changes.
 */
export const requests = pgTable(
  'care_requests',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topic: topicEnum().notNull().default('not_said'),
    urgency: urgencyEnum().notNull().default('routine'),
    mode: modeEnum().notNull().default('in_person'),
    /** When the student can come: free text, "after 4 pm on weekdays". */
    preferredTimes: text('preferred_times'),
    /** Whatever the student chose to say. Optional, and only counsellors read it. */
    message: text(),
    status: requestStatusEnum().notNull().default('waiting'),
    counsellorId: text('counsellor_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    outcome: outcomeEnum(),
    createdAt: createdAt(),
  },
  (t) => [
    index('care_requests_queue').on(t.institutionId, t.status, t.createdAt),
    index('care_requests_student').on(t.studentId),
    index('care_requests_counsellor').on(t.counsellorId, t.status),
    check('care_requests_message', sql`message is null or length(message) <= 2000`),
    check('care_requests_times', sql`preferred_times is null or length(preferred_times) <= 200`),
    check('care_requests_outcome', sql`(status = 'closed') = (outcome is not null)`),
    tenantPolicy('care_requests'),
  ],
)

/** A result the student chose to show the counsellors with a request. */
export const shared = pgTable(
  'care_shared_results',
  {
    institutionId: tenantId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    resultId: uuid('result_id')
      .notNull()
      .references(() => results.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.resultId] }), index('care_shared_results_result').on(t.resultId), tenantPolicy('care_shared_results')],
)

/**
 * A time a counsellor set aside for a student. A counsellor is never booked
 * twice at once; held or missed is recorded once it has begun.
 */
export const appointments = pgTable(
  'care_appointments',
  {
    id: pk(),
    institutionId: tenantId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    counsellorId: text('counsellor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    mode: modeEnum().notNull(),
    /** A room, a phone number to expect a call from, or a meeting link. */
    place: text().notNull(),
    /** What the student is told with it. */
    noteToStudent: text('note_to_student'),
    status: appointmentStatusEnum().notNull().default('booked'),
    cancelledBy: text('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('care_appointments_counsellor').on(t.counsellorId, t.startsAt),
    index('care_appointments_request').on(t.requestId),
    check('care_appointments_times', sql`ends_at > starts_at and ends_at - starts_at <= interval '4 hours'`),
    check('care_appointments_place', sql`length(trim(place)) between 2 and 300`),
    check('care_appointments_cancel', sql`(status = 'cancelled') = (cancel_reason is not null)`),
    tenantPolicy('care_appointments'),
  ],
)

/** What the counsellor writes about a case. Theirs alone; kept as written. */
export const notes = pgTable(
  'care_notes',
  {
    id: pk(),
    institutionId: tenantId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('care_notes_request').on(t.requestId, t.createdAt),
    check('care_notes_body', sql`length(trim(body)) between 2 and 5000`),
    tenantPolicy('care_notes'),
  ],
)

export type Request = typeof requests.$inferSelect
export type Appointment = typeof appointments.$inferSelect
export type Result = typeof results.$inferSelect
