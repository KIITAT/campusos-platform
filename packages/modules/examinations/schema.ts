import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  integer,
  jsonb,
  index,
  primaryKey,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { courses, offerings, programs, rooms, terms } from '@campusos/module-academic/schema'

/**
 * Examinations and grading.
 *
 * The spec's warning shapes this whole module: grade disputes are the single
 * most common institutional support ticket, so the design goal is not "record
 * marks" but "be able to answer, months later, exactly who changed what and
 * why". Hence publish-locking enforced in the database and an audit row on
 * every revision, rather than either deferred to phase 10.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/** numeric, never float: marks and percentages are compared and summed. */
const marks = (name: string) => numeric(name, { precision: 6, scale: 2 })

export const examKindEnum = pgEnum('exam_kind', [
  'quiz',
  'assignment',
  'midterm',
  'practical',
  'final',
])

export const schemeKindEnum = pgEnum('grading_scheme_kind', [
  'percentage',
  'gpa',
  'custom',
])

// --- grading schemes -------------------------------------------------------

/**
 * Configurable per institution, as the spec requires. `percentage` needs no
 * bands; `gpa` and `custom` are the same machinery with a different label, and
 * are kept distinct only so the transcript can say which it is printing.
 */
export const schemes = pgTable(
  'exam_grading_schemes',
  {
    id: pk(),
    institutionId: tenantId(),
    name: text().notNull(),
    kind: schemeKindEnum().notNull(),
    /** Highest attainable points, for normalising a GPA onto its own scale. */
    maxPoints: numeric('max_points', { precision: 4, scale: 2 }),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('exam_schemes_name').on(t.institutionId, t.name),
    // One default per institution, so "which scheme applies" is never a guess.
    uniqueIndex('exam_schemes_one_default')
      .on(t.institutionId)
      .where(sql`is_default`),
    tenantPolicy('exam_grading_schemes'),
  ],
)

/**
 * A band maps a percentage floor onto a label and points. Stored as floors
 * only: the ceiling is the next band up, so two bands cannot leave a gap or
 * overlap the way an explicit min/max pair can.
 */
export const bands = pgTable(
  'exam_grade_bands',
  {
    id: pk(),
    institutionId: tenantId(),
    schemeId: uuid('scheme_id')
      .notNull()
      .references(() => schemes.id, { onDelete: 'cascade' }),
    minPercent: marks('min_percent').notNull(),
    label: text().notNull(),
    points: numeric({ precision: 4, scale: 2 }),
    /** Below this, the course is not credited towards a GPA. */
    isPass: boolean('is_pass').notNull().default(true),
  },
  (t) => [
    uniqueIndex('exam_bands_floor').on(t.schemeId, t.minPercent),
    check('exam_bands_percent', sql`min_percent between 0 and 100`),
    tenantPolicy('exam_grade_bands'),
  ],
)

/**
 * A programme that grades on its own scale.
 *
 * One university can run a ten-point scale for its engineering degrees, a
 * percentage with divisions for an affiliated diploma and a pass/fail scheme
 * for a certificate, at the same time. Holding one scheme per institution makes
 * the second programme somebody's spreadsheet, so a programme may name its own
 * and the institution's default is the fallback.
 */
export const schemePrograms = pgTable(
  'exam_scheme_programs',
  {
    institutionId: tenantId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    schemeId: uuid('scheme_id')
      .notNull()
      .references(() => schemes.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    // One per programme: two scales for one degree is not a policy, it is an
    // argument.
    primaryKey({ columns: [t.programId] }),
    tenantPolicy('exam_scheme_programs'),
  ],
)

// --- exams -----------------------------------------------------------------

export const exams = pgTable(
  'exams',
  {
    id: pk(),
    institutionId: tenantId(),
    /**
     * An offering, not a course: the same course taught to two cohorts sits
     * two different exams, and that is the join every later report wants.
     */
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    kind: examKindEnum().notNull(),
    maxMarks: marks('max_marks').notNull(),
    /** Contribution to the course total, as a percentage of it. */
    weightPercent: marks('weight_percent').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    /**
     * The lock. Once set, marks for this exam are immutable except through the
     * audited revision path, which the guard trigger enforces.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: text('published_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('exams_name').on(t.offeringId, t.name),
    index('exams_offering').on(t.offeringId),
    check('exams_max_marks', sql`max_marks > 0`),
    check('exams_weight', sql`weight_percent > 0 and weight_percent <= 100`),
    tenantPolicy('exams'),
  ],
)

// --- marks -----------------------------------------------------------------

export const examMarks = pgTable(
  'exam_marks',
  {
    id: pk(),
    institutionId: tenantId(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null is a genuine state: sat the exam, result pending. Absent is false. */
    obtained: marks('obtained'),
    /** Distinct from a zero: absent and scored-nothing are not the same. */
    absent: boolean().notNull().default(false),
    enteredBy: text('entered_by').references(() => users.id, { onDelete: 'set null' }),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped by every audited revision, so a disputed mark shows its history depth. */
    revision: smallint().notNull().default(0),
  },
  (t) => [
    uniqueIndex('exam_marks_once').on(t.examId, t.studentId),
    index('exam_marks_student').on(t.studentId),
    check('exam_marks_obtained', sql`obtained is null or obtained >= 0`),
    check(
      'exam_marks_absent_has_no_score',
      sql`not absent or obtained is null`,
    ),
    tenantPolicy('exam_marks'),
  ],
)

// --- the examination cycle: windows, enrolment, backlogs, papers ----------------

/** Bytes, kept in the row: a question paper is small and must not leave the database's guard. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const windowKindEnum = pgEnum('exam_window_kind', ['enrolment', 'backlog'])
export const backlogTypeEnum = pgEnum('exam_backlog_type', ['internal', 'university', 'both'])

/**
 * When students may enrol for a term's examinations, or book a backlog paper.
 * One of each per term. Outside it the database refuses the enrolment or the
 * booking, as KIIT's portal says "the activity window is closed".
 */
export const examWindows = pgTable(
  'exam_windows',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    kind: windowKindEnum().notNull(),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    /** Times are set and printed in it, the admit card's included. */
    timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
    /** Printed on the admit card. */
    instructions: text(),
    /** Backlog only: what re-sitting the internal assessment, and the university exam, costs per paper. */
    internalFeePaise: bigint('internal_fee_paise', { mode: 'number' }).notNull().default(0),
    examFeePaise: bigint('exam_fee_paise', { mode: 'number' }).notNull().default(0),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('exam_windows_once').on(t.termId, t.kind),
    check('exam_windows_span', sql`closes_at > opens_at`),
    check('exam_windows_fees', sql`internal_fee_paise >= 0 and exam_fee_paise >= 0`),
    tenantPolicy('exam_windows'),
  ],
)

/**
 * A student enrolled for a term's examinations, with the personal details
 * they confirmed as they did it -- kept as they were, because that is what
 * they agreed to and what the admit card was printed from.
 */
export const enrolments = pgTable(
  'exam_enrolments',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    confirmed: jsonb().$type<Record<string, string | null>>().notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('exam_enrolments_once').on(t.termId, t.studentId).where(sql`cancelled_at is null`),
    check('exam_enrolments_cancel', sql`(cancelled_at is null) = (cancel_reason is null)`),
    tenantPolicy('exam_enrolments'),
  ],
)

/** The papers an enrolment is for: the student's classes that term. */
export const enrolmentPapers = pgTable(
  'exam_enrolment_papers',
  {
    institutionId: tenantId(),
    enrolmentId: uuid('enrolment_id')
      .notNull()
      .references(() => enrolments.id, { onDelete: 'cascade' }),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.enrolmentId, t.offeringId] }), tenantPolicy('exam_enrolment_papers')],
)

/**
 * A failed paper booked to sit again: its internal assessment, its university
 * exam, or both, at the fee the window set when it was booked.
 */
export const backlogBookings = pgTable(
  'exam_backlog_bookings',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    bookingType: backlogTypeEnum('booking_type').notNull(),
    feePaise: bigint('fee_paise', { mode: 'number' }).notNull().default(0),
    bookedAt: timestamp('booked_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('exam_backlog_bookings_once')
      .on(t.termId, t.studentId, t.courseId)
      .where(sql`cancelled_at is null`),
    check('exam_backlog_bookings_cancel', sql`(cancelled_at is null) = (cancel_reason is null)`),
    check('exam_backlog_bookings_fee', sql`fee_paise >= 0`),
    tenantPolicy('exam_backlog_bookings'),
  ],
)

/**
 * A question paper, uploaded by the examiner and sealed: nobody downloads it
 * until shortly before the exam, and then only the examination cell, every
 * time on the record. A new upload supersedes the last while it is still
 * open to change.
 */
export const questionPapers = pgTable(
  'exam_question_papers',
  {
    id: pk(),
    institutionId: tenantId(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    version: smallint().notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text().notNull(),
    content: bytea().notNull(),
    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('exam_question_papers_version').on(t.examId, t.version),
    uniqueIndex('exam_question_papers_current').on(t.examId).where(sql`superseded_at is null`),
    check('exam_question_papers_size', sql`size_bytes > 0 and size_bytes = octet_length(content)`),
    tenantPolicy('exam_question_papers'),
  ],
)

/** The institution's rules for the cycle. One row; absent means the defaults. */
export const examSettings = pgTable(
  'exam_settings',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    /** How long before an exam its paper may be downloaded. */
    paperReleaseMinutes: integer('paper_release_minutes').notNull().default(60),
    /** A student's semester grade report waits for their required feedback, where the feedback module is on. */
    gradeReportNeedsFeedback: boolean('grade_report_needs_feedback').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('exam_settings_release', sql`paper_release_minutes between 5 and 1440`),
    tenantPolicy('exam_settings'),
  ],
)

export type ExamWindow = typeof examWindows.$inferSelect
