import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
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
import { offerings, rooms } from '@campusos/module-academic/schema'

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
