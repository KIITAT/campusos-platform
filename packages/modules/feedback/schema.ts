import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { docStatusColumns, institutions, tenantPolicy, users } from '@campusos/db'
import { offerings, terms } from '@campusos/module-academic/schema'

/**
 * Feedback: questionnaires the institution writes, opened to students for a
 * term in windows, and answered anonymously.
 *
 * Two kinds of window. A *teaching* window is answered once for every class a
 * student sits -- the subject and its teacher -- which is how both the
 * pre-mid-semester and the end-semester teaching feedback work. A *general*
 * window is answered once per student: facilities, the curriculum, the
 * hostel.
 *
 * Anonymity is structural. That a student has given feedback is one table,
 * with their name on it; what they said is another, with no name, no time and
 * no link to the first. A teacher reads averages and comments for a class only
 * once the window has closed and enough students have answered that nobody
 * can be picked out.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const audienceEnum = pgEnum('feedback_audience', ['teaching', 'general'])
export const questionKindEnum = pgEnum('feedback_question_kind', ['scale', 'choice', 'text'])

/**
 * A questionnaire. On the shared lifecycle: written as a draft, published --
 * frozen, because answers already given were to these exact questions -- and
 * retired with a reason.
 */
export const forms = pgTable(
  'feedback_forms',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    name: text().notNull(),
    audience: audienceEnum().notNull(),
    description: text(),
    /** Every scale question on the form runs 1..scalePoints. */
    scalePoints: smallint('scale_points').notNull().default(5),
    scaleLow: text('scale_low').notNull().default('Strongly disagree'),
    scaleHigh: text('scale_high').notNull().default('Strongly agree'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    unique('feedback_forms_name').on(t.institutionId, t.name),
    check('feedback_forms_name_len', sql`length(trim(name)) > 0`),
    check('feedback_forms_scale', sql`scale_points between 3 and 10`),
    tenantPolicy('feedback_forms'),
  ],
)

/** One question, in order. Changed only while its form is a draft. */
export const questions = pgTable(
  'feedback_questions',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    position: smallint().notNull(),
    /** A heading the question sits under: "The teacher", "The course". */
    section: text(),
    prompt: text().notNull(),
    kind: questionKindEnum().notNull(),
    /** For a choice question, the options in order. */
    options: text().array().notNull().default(sql`'{}'::text[]`),
    required: boolean().notNull().default(true),
  },
  (t) => [
    index('feedback_questions_form').on(t.formId, t.position),
    check('feedback_questions_prompt', sql`length(trim(prompt)) > 0`),
    check(
      'feedback_questions_options',
      sql`(kind = 'choice' and cardinality(options) between 2 and 12) or (kind <> 'choice' and cardinality(options) = 0)`,
    ),
    tenantPolicy('feedback_questions'),
  ],
)

/**
 * A form opened to students for one term, between two moments. Published is
 * frozen; withdrawn (cancelled, with a reason) stops it being owed, and what
 * was already said is kept.
 */
export const windows = pgTable(
  'feedback_windows',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'restrict' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    timeZone: text('time_zone').notNull(),
    /**
     * Counts towards "has this student finished their feedback for the term",
     * which other modules may ask before, say, a grade report.
     */
    required: boolean().notNull().default(true),
    /** Fewer answers than this for a class and its results are not shown. */
    minResponses: smallint('min_responses').notNull().default(5),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    index('feedback_windows_term').on(t.termId),
    check('feedback_windows_title', sql`length(trim(title)) > 0`),
    check('feedback_windows_span', sql`closes_at > opens_at`),
    check('feedback_windows_min', sql`min_responses between 1 and 50`),
    tenantPolicy('feedback_windows'),
  ],
)

/**
 * That a student gave feedback: for a teaching window, for one class; for a
 * general window, once. Their name is here and nowhere near what they said.
 */
export const submissions = pgTable(
  'feedback_submissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    windowId: uuid('window_id')
      .notNull()
      .references(() => windows.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    offeringId: uuid('offering_id').references(() => offerings.id, { onDelete: 'restrict' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('feedback_submissions_once').on(t.windowId, t.studentId, t.offeringId).nullsNotDistinct(),
    index('feedback_submissions_student').on(t.studentId),
    tenantPolicy('feedback_submissions'),
  ],
)

/**
 * What was said, for a window and (teaching) a class. No student, no time:
 * the id is random and the row carries nothing that leads back to a person.
 */
export const responses = pgTable(
  'feedback_responses',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    windowId: uuid('window_id')
      .notNull()
      .references(() => windows.id, { onDelete: 'restrict' }),
    offeringId: uuid('offering_id').references(() => offerings.id, { onDelete: 'restrict' }),
  },
  (t) => [index('feedback_responses_window').on(t.windowId, t.offeringId), tenantPolicy('feedback_responses')],
)

/** One answer: a point on the scale, a choice, or a comment. */
export const answers = pgTable(
  'feedback_answers',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    responseId: uuid('response_id')
      .notNull()
      .references(() => responses.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    score: smallint(),
    choice: text(),
    comment: text(),
  },
  (t) => [
    unique('feedback_answers_once').on(t.responseId, t.questionId),
    index('feedback_answers_question').on(t.questionId),
    check(
      'feedback_answers_one',
      sql`num_nonnulls(score, choice, comment) = 1`,
    ),
    check('feedback_answers_comment', sql`comment is null or length(comment) between 1 and 2000`),
    tenantPolicy('feedback_answers'),
  ],
)

export type Form = typeof forms.$inferSelect
export type Question = typeof questions.$inferSelect
export type Window = typeof windows.$inferSelect
