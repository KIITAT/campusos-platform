import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { docStatusColumns, institutions, tenantPolicy, users } from '@campusos/db'
import { courses, offerings } from '@campusos/module-academic/schema'
import type { Choice } from './api/scoring'

/**
 * Quizzes: a question bank per course, quizzes set from it for one offering,
 * and attempts the machine scores.
 *
 * Deliberately not grades. A quiz is practice and feedback; a grade is the
 * Examinations module's, published and locked. Nothing here writes a mark or
 * a completion, and nothing in Examinations reads a quiz.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const points = (name: string) => numeric(name, { precision: 6, scale: 2 })

export const questionKindEnum = pgEnum('quiz_question_kind', ['single', 'multiple', 'true_false', 'short', 'numeric'])

/**
 * A question in a course's bank. Never edited: a quiz already taken was scored
 * against this exact key, and changing it would change what those students
 * earned without anybody saying so. A correction is a revision -- a new
 * question naming the one it replaces, which is retired.
 */
export const questions = pgTable(
  'quiz_questions',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    kind: questionKindEnum().notNull(),
    prompt: text().notNull(),
    /** For single, multiple and true/false: `[{ id, label, correct }]`. */
    choices: jsonb().$type<Choice[]>().notNull().default(sql`'[]'::jsonb`),
    /** For short answers: any of these, compared ignoring case and spacing. */
    acceptedAnswers: text('accepted_answers').array().notNull().default(sql`'{}'::text[]`),
    numericAnswer: numeric('numeric_answer'),
    tolerance: numeric().notNull().default('0'),
    /** Multiple choice only: a share of the marks for a partly right answer. */
    partialCredit: boolean('partial_credit').notNull().default(false),
    points: points('points').notNull().default('1'),
    topic: text(),
    /** Shown with the answer, when the quiz shows answers. */
    explanation: text(),
    revisionOf: uuid('revision_of').references((): AnyPgColumn => questions.id, { onDelete: 'restrict' }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('quiz_questions_course').on(t.courseId, t.retiredAt),
    // One revision per question: two corrections of the same original would
    // leave the bank with two live versions and nobody sure which is right.
    uniqueIndex('quiz_questions_revision').on(t.revisionOf),
    check('quiz_questions_prompt', sql`length(trim(prompt)) > 0`),
    check('quiz_questions_points', sql`points > 0 and points <= 100`),
    check('quiz_questions_tolerance', sql`tolerance >= 0`),
    check('quiz_questions_partial', sql`not partial_credit or kind = 'multiple'`),
    tenantPolicy('quiz_questions'),
  ],
)

export const keepEnum = pgEnum('quiz_keep', ['best', 'latest'])
export const revealEnum = pgEnum('quiz_reveal', ['after_submit', 'after_close', 'never'])

/**
 * A quiz for one offering: its window, time limit, attempts, and how it
 * scores. On the shared lifecycle: a draft is set and changed freely;
 * submitted is published, and frozen -- the students taking it are owed the
 * quiz they started; cancelled is withdrawn, with a reason, and a correction
 * is a revision into a new draft.
 */
export const quizzes = pgTable(
  'quiz_quizzes',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    instructions: text(),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    /** The zone the times were set in, and are shown in. */
    timeZone: text('time_zone').notNull(),
    /** Minutes from starting. Absent means until the quiz closes. */
    timeLimitMinutes: integer('time_limit_minutes'),
    attemptsAllowed: smallint('attempts_allowed').notNull().default(1),
    /** Which attempt counts, when more than one is allowed. */
    keep: keepEnum().notNull().default('best'),
    /** Taken from the question's marks for a wrong objective answer. */
    penaltyPercent: numeric('penalty_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    reveal: revealEnum().notNull().default('after_close'),
    /** Each attempt gets the questions in its own order. */
    shuffle: boolean().notNull().default(false),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    index('quiz_quizzes_offering').on(t.offeringId),
    check('quiz_quizzes_title', sql`length(trim(title)) > 0`),
    check('quiz_quizzes_window', sql`closes_at > opens_at`),
    check('quiz_quizzes_limit', sql`time_limit_minutes is null or time_limit_minutes between 1 and 600`),
    check('quiz_quizzes_attempts', sql`attempts_allowed between 1 and 10`),
    check('quiz_quizzes_penalty', sql`penalty_percent between 0 and 100`),
    tenantPolicy('quiz_quizzes'),
  ],
)

/** A question on a quiz, in order, with the marks this quiz gives it. */
export const items = pgTable(
  'quiz_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    position: smallint().notNull(),
    points: points('points').notNull(),
  },
  (t) => [
    uniqueIndex('quiz_items_once').on(t.quizId, t.questionId),
    index('quiz_items_question').on(t.questionId),
    check('quiz_items_points', sql`points > 0 and points <= 100`),
    tenantPolicy('quiz_items'),
  ],
)

/**
 * More time for one student: an accommodation, or a make-up after an illness.
 * A published quiz is frozen, so this is how its window moves for somebody --
 * on the record, with a reason, for that student alone.
 */
export const extensions = pgTable(
  'quiz_extensions',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** A later close, for this student. */
    closesAt: timestamp('closes_at', { withTimezone: true }),
    /** Added to the time limit, for this student. */
    extraMinutes: integer('extra_minutes').notNull().default(0),
    reason: text().notNull(),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('quiz_extensions_once').on(t.quizId, t.studentId),
    check('quiz_extensions_reason', sql`length(trim(reason)) >= 5`),
    check('quiz_extensions_minutes', sql`extra_minutes between 0 and 600`),
    check('quiz_extensions_something', sql`closes_at is not null or extra_minutes > 0`),
    tenantPolicy('quiz_extensions'),
  ],
)

/**
 * One sitting. The database fills in its number, when it started and its
 * deadline -- the earlier of the time limit and the close -- so neither a
 * client nor a bug in this module decides how long a student gets.
 */
export const attempts = pgTable(
  'quiz_attempts',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    number: smallint().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    deadline: timestamp({ withTimezone: true }).notNull(),
    /** The items in the order this attempt shows them. */
    itemOrder: uuid('item_order').array().notNull().default(sql`'{}'::uuid[]`),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Submitted by the clock rather than by the student. */
    autoSubmitted: boolean('auto_submitted').notNull().default(false),
    /** The sum of what each response earned, floored at zero. Kept by the database. */
    score: numeric({ precision: 8, scale: 2 }),
    maxScore: numeric('max_score', { precision: 8, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('quiz_attempts_number').on(t.quizId, t.studentId, t.number),
    // One sitting at a time.
    uniqueIndex('quiz_attempts_open')
      .on(t.quizId, t.studentId)
      .where(sql`submitted_at is null`),
    index('quiz_attempts_student').on(t.studentId),
    check('quiz_attempts_scored', sql`(submitted_at is null) = (score is null)`),
    tenantPolicy('quiz_attempts'),
  ],
)

/**
 * An answer. Saved as often as the student likes until the deadline, then
 * frozen; the machine's mark is written once the attempt is submitted, and a
 * teacher may change the mark -- never the answer -- with a reason.
 */
export const responses = pgTable(
  'quiz_responses',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** A choice id, a list of them, text, or a number, as the student gave it. */
    answer: jsonb().$type<unknown>(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
    correct: boolean(),
    awarded: points('awarded'),
    overriddenBy: text('overridden_by').references(() => users.id, { onDelete: 'set null' }),
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    overrideReason: text('override_reason'),
  },
  (t) => [
    uniqueIndex('quiz_responses_once').on(t.attemptId, t.itemId),
    index('quiz_responses_item').on(t.itemId),
    check('quiz_responses_override', sql`(overridden_at is null) = (override_reason is null)`),
    tenantPolicy('quiz_responses'),
  ],
)

export type Question = typeof questions.$inferSelect
export type Quiz = typeof quizzes.$inferSelect
export type Item = typeof items.$inferSelect
export type Attempt = typeof attempts.$inferSelect
export type Response = typeof responses.$inferSelect
