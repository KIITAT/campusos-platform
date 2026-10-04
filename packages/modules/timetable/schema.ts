import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { courses, departments, offerings, programs, rooms, sections, terms } from '@campusos/module-academic/schema'

/**
 * What the timetable solver needs to know beyond the academic core, and what
 * it produced.
 *
 * The academic core already holds the classes (offerings: a course, a cohort,
 * a term, a teacher) and the live weekly slots. This module adds the week's
 * periods, what each teacher may teach and when they cannot, what each class
 * needs a week, what the office has pinned -- and draft timetables, kept until
 * one is applied to the live slots or discarded.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/** The institution's defaults: teachers' limits, the academic year, how long the solver may think. */
export const settings = pgTable(
  'timetable_settings',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    maxPerDay: smallint('max_per_day').notNull().default(6),
    maxPerWeek: smallint('max_per_week').notNull().default(24),
    maxConsecutive: smallint('max_consecutive').notNull().default(3),
    /** The month a cohort moves up a year: 7 for July. Decides a class's year of study. */
    yearStartsMonth: smallint('year_starts_month').notNull().default(7),
    timeLimitSeconds: smallint('time_limit_seconds').notNull().default(20),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('timetable_settings_limits', sql`max_per_day between 1 and 16 and max_per_week between 1 and 80 and max_consecutive between 1 and 16`),
    check('timetable_settings_month', sql`year_starts_month between 1 and 12`),
    check('timetable_settings_time', sql`time_limit_seconds between 1 and 600`),
    tenantPolicy('timetable_settings'),
  ],
)

/**
 * The teaching periods of the week. Rows with no term are the institution's
 * standing week; a term with periods of its own uses those instead. Breaks are
 * the gaps between periods: a block of several periods never spans one.
 */
export const periods = pgTable(
  'timetable_periods',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id').references(() => terms.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week').notNull(),
    index: smallint('idx').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    label: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('timetable_periods_identity').on(t.institutionId, t.termId, t.dayOfWeek, t.index).nullsNotDistinct(),
    check('timetable_periods_day', sql`day_of_week between 1 and 7`),
    check('timetable_periods_index', sql`idx between 1 and 30`),
    check('timetable_periods_times', sql`ends_at > starts_at`),
    tenantPolicy('timetable_periods'),
  ],
)

/** What kind of room each is -- a classroom, a lab, a hall -- and whether the solver may use it. */
export const roomKinds = pgTable(
  'timetable_rooms',
  {
    roomId: uuid('room_id')
      .primaryKey()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    institutionId: tenantId(),
    kind: text().notNull().default('classroom'),
    available: boolean().notNull().default(true),
  },
  () => [check('timetable_rooms_kind', sql`kind ~ '^[a-z0-9][a-z0-9 _:-]{0,39}$'`), tenantPolicy('timetable_rooms')],
)

/**
 * A cohort's size for planning, before its students are enrolled, and the
 * section it is part of: lab batch A1 is part of section A, so A's lectures
 * and A1's labs never overlap, while A1 and A2 may run side by side.
 */
export const sectionPlans = pgTable(
  'timetable_sections',
  {
    sectionId: uuid('section_id')
      .primaryKey()
      .references(() => sections.id, { onDelete: 'cascade' }),
    institutionId: tenantId(),
    expectedSize: smallint('expected_size'),
    parentSectionId: uuid('parent_section_id').references(() => sections.id, { onDelete: 'set null' }),
  },
  () => [
    check('timetable_sections_size', sql`expected_size is null or expected_size between 1 and 2000`),
    check('timetable_sections_parent', sql`parent_section_id is null or parent_section_id <> section_id`),
    tenantPolicy('timetable_sections'),
  ],
)

/** A teacher's own limits, where they differ from the institution's. */
export const teacherLimits = pgTable(
  'timetable_teachers',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: tenantId(),
    maxPerDay: smallint('max_per_day'),
    maxPerWeek: smallint('max_per_week'),
    maxConsecutive: smallint('max_consecutive'),
    note: text(),
  },
  () => [
    check(
      'timetable_teachers_limits',
      sql`(max_per_day is null or max_per_day between 1 and 16) and (max_per_week is null or max_per_week between 0 and 80) and (max_consecutive is null or max_consecutive between 1 and 16)`,
    ),
    tenantPolicy('timetable_teachers'),
  ],
)

/**
 * Who may teach what. A row names any of a course, a department, a programme
 * and a year of study; a class matches it when every one named matches. "Dr
 * Rao may teach Data Structures to second years", "Dr Sen may teach anything
 * in Mathematics", "Dr Das may teach first years of the B.Tech". The
 * preference -- 1, would rather not, to 5, asked for it -- is what the solver
 * weighs between teachers who may.
 */
export const eligibility = pgTable(
  'timetable_eligibility',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'cascade' }),
    yearOfStudy: smallint('year_of_study'),
    preference: smallint().notNull().default(3),
    createdAt: createdAt(),
  },
  (t) => [
    unique('timetable_eligibility_identity')
      .on(t.userId, t.courseId, t.departmentId, t.programId, t.yearOfStudy)
      .nullsNotDistinct(),
    index('timetable_eligibility_course').on(t.institutionId, t.courseId),
    check('timetable_eligibility_names_something', sql`course_id is not null or department_id is not null or program_id is not null or year_of_study is not null`),
    check('timetable_eligibility_year', sql`year_of_study is null or year_of_study between 1 and 10`),
    check('timetable_eligibility_preference', sql`preference between 1 and 5`),
    tenantPolicy('timetable_eligibility'),
  ],
)

/** A teacher, a room or a cohort not to be booked: a whole day, or one period of it. */
export const unavailable = pgTable(
  'timetable_unavailable',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week').notNull(),
    period: smallint(),
    reason: text(),
    createdAt: createdAt(),
  },
  () => [
    check('timetable_unavailable_one', sql`num_nonnulls(user_id, room_id, section_id) = 1`),
    check('timetable_unavailable_day', sql`day_of_week between 1 and 7`),
    check('timetable_unavailable_period', sql`period is null or period between 1 and 30`),
    tenantPolicy('timetable_unavailable'),
  ],
)

/**
 * What a class needs a week: four lecture periods, a two-period lab. One row
 * per kind, so a course with lectures and a lab has two; each kind is placed in
 * blocks of `block_length` periods.
 */
export const needs = pgTable(
  'timetable_needs',
  {
    id: pk(),
    institutionId: tenantId(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    kind: text().notNull().default('lecture'),
    periodsPerWeek: smallint('periods_per_week').notNull(),
    blockLength: smallint('block_length').notNull().default(1),
    roomKind: text('room_kind'),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('timetable_needs_identity').on(t.offeringId, t.kind),
    check('timetable_needs_kind', sql`kind ~ '^[a-z][a-z0-9_-]{0,23}$'`),
    check('timetable_needs_periods', sql`periods_per_week between 1 and 40 and block_length between 1 and 6 and periods_per_week % block_length = 0`),
    tenantPolicy('timetable_needs'),
  ],
)

/**
 * What the office has decided and the solver must keep: a class's teacher, a
 * block's time, a room -- or any of them together.
 */
export const pins = pgTable(
  'timetable_pins',
  {
    id: pk(),
    institutionId: tenantId(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    needKind: text('need_kind'),
    facultyUserId: text('faculty_user_id').references(() => users.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week'),
    period: smallint(),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    note: text(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  () => [
    check('timetable_pins_something', sql`faculty_user_id is not null or day_of_week is not null`),
    check('timetable_pins_time', sql`(day_of_week is null) = (period is null)`),
    check('timetable_pins_room', sql`room_id is null or day_of_week is not null`),
    check('timetable_pins_day', sql`day_of_week is null or day_of_week between 1 and 7`),
    tenantPolicy('timetable_pins'),
  ],
)

/** A timetable the solver produced for a term: a draft until applied or discarded. */
export const runs = pgTable(
  'timetable_runs',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    status: text().notNull().default('draft'),
    seed: integer().notNull(),
    options: jsonb().$type<Record<string, unknown>>().notNull(),
    /** offeringId -> the teacher given, or null. */
    teachers: jsonb().$type<Record<string, string | null>>().notNull(),
    cost: jsonb().$type<Record<string, number>>().notNull(),
    stats: jsonb().$type<Record<string, unknown>>().notNull(),
    issues: jsonb().$type<{ offeringId: string; code: string; message: string }[]>().notNull(),
    unplaced: jsonb().$type<{ needId: string; offeringId: string; count: number; reason: string }[]>().notNull(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedBy: text('applied_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('timetable_runs_term').on(t.institutionId, t.termId, t.createdAt),
    // The live timetable came from at most one run.
    uniqueIndex('timetable_runs_one_applied').on(t.termId).where(sql`status = 'applied'`),
    check('timetable_runs_status', sql`status in ('draft', 'applied', 'discarded', 'superseded')`),
    tenantPolicy('timetable_runs'),
  ],
)

/** One placed block of a draft timetable. */
export const runEntries = pgTable(
  'timetable_run_entries',
  {
    id: pk(),
    institutionId: tenantId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    needKind: text('need_kind').notNull(),
    facultyUserId: text('faculty_user_id').references(() => users.id, { onDelete: 'set null' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week').notNull(),
    period: smallint().notNull(),
    length: smallint().notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    fixed: boolean().notNull().default(false),
    locked: boolean().notNull().default(false),
  },
  (t) => [index('timetable_run_entries_run').on(t.runId, t.dayOfWeek, t.period), tenantPolicy('timetable_run_entries')],
)
