import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
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
 * Academic core. Every later module (attendance, examinations, fees) hangs off
 * the student-section-course relationships defined here, so the shape of those
 * relationships is the expensive thing to get wrong -- individual leaf columns
 * are a cheap migration later.
 *
 * Table names are namespaced `academic_*` so modules cannot collide.
 * Every table carries institution_id and gets the shared tenant policy.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const programLevelEnum = pgEnum('academic_program_level', [
  'certificate',
  'diploma',
  'undergraduate',
  'postgraduate',
  'doctoral',
])

// --- departments -----------------------------------------------------------

export const departments = pgTable(
  'academic_departments',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    // The HOD role's scope. Nullable: a department can exist before it has a
    // head, and set null rather than cascade so losing a user does not delete
    // the department.
    hodUserId: text('hod_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_departments_code').on(t.institutionId, t.code),
    tenantPolicy('academic_departments'),
  ],
)

// --- programs --------------------------------------------------------------

export const programs = pgTable(
  'academic_programs',
  {
    id: pk(),
    institutionId: tenantId(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    code: text().notNull(),
    name: text().notNull(),
    level: programLevelEnum().notNull(),
    /** Terms to completion, e.g. 8 for a four-year semesterised degree. */
    durationTerms: smallint('duration_terms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_programs_code').on(t.institutionId, t.code),
    check('academic_programs_duration', sql`duration_terms between 1 and 24`),
    tenantPolicy('academic_programs'),
  ],
)

// --- terms -----------------------------------------------------------------

export const terms = pgTable(
  'academic_terms',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_terms_code').on(t.institutionId, t.code),
    // At most one current term per institution, enforced by the database
    // rather than by whichever code path last set the flag.
    uniqueIndex('academic_terms_one_current')
      .on(t.institutionId)
      .where(sql`is_current`),
    check('academic_terms_dates', sql`ends_on > starts_on`),
    tenantPolicy('academic_terms'),
  ],
)

// --- courses ---------------------------------------------------------------

export const courses = pgTable(
  'academic_courses',
  {
    id: pk(),
    institutionId: tenantId(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    code: text().notNull(),
    title: text().notNull(),
    credits: smallint().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_courses_code').on(t.institutionId, t.code),
    check('academic_courses_credits', sql`credits between 0 and 30`),
    tenantPolicy('academic_courses'),
  ],
)

// --- rooms -----------------------------------------------------------------

/**
 * Physical rooms, because a timetable slot needs somewhere to be. Phase 2 adds
 * the per-room geofence columns where they are actually used; adding two
 * columns nothing references yet would be speculation.
 */
export const rooms = pgTable(
  'academic_rooms',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    building: text(),
    capacity: smallint(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_rooms_code').on(t.institutionId, t.code),
    tenantPolicy('academic_rooms'),
  ],
)

// --- sections --------------------------------------------------------------

/**
 * A cohort, not a course offering: "CSE 2024 batch, section A". It persists
 * across terms for the whole duration of the programme, which is why it carries
 * an admission year rather than a term.
 */
export const sections = pgTable(
  'academic_sections',
  {
    id: pk(),
    institutionId: tenantId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'restrict' }),
    label: text().notNull(),
    admissionYear: smallint('admission_year').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_sections_identity').on(
      t.institutionId,
      t.programId,
      t.admissionYear,
      t.label,
    ),
    check('academic_sections_year', sql`admission_year between 1900 and 2200`),
    tenantPolicy('academic_sections'),
  ],
)

/**
 * Student to section, many-to-many on purpose. A student has one core cohort,
 * but electives put them in additional sections -- modelling this as a column
 * on users would make electives a schema change later, which is exactly the
 * kind of thing that then touches five other modules.
 *
 * This is the table attendance checks to answer "is this student enrolled in
 * this section", so it is on the hot path from phase 2 onward.
 */
export const sectionMembers = pgTable(
  'academic_section_members',
  {
    institutionId: tenantId(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sectionId, t.userId] }),
    tenantPolicy('academic_section_members'),
  ],
)

// --- offerings -------------------------------------------------------------

/**
 * One course taught to one section in one term by one faculty member. This is
 * the join every later module actually wants: an attendance session, an exam,
 * and a marks sheet all belong to an offering, not to a bare course.
 */
export const offerings = pgTable(
  'academic_offerings',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'restrict' }),
    // Nullable so a timetable can be drafted before staffing is settled.
    facultyUserId: text('faculty_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_offerings_identity').on(t.termId, t.courseId, t.sectionId),
    tenantPolicy('academic_offerings'),
  ],
)

// --- timetable slots -------------------------------------------------------

/**
 * A recurring weekly slot. Phase 2 starts an attendance session against one of
 * these, which is why the room lives here rather than on the offering.
 *
 * Room and faculty double-booking are prevented by GiST exclusion constraints
 * added in the migration that follows this schema -- drizzle-kit has no
 * EXCLUDE builder, and an app-level check would be a race.
 */
export const slots = pgTable(
  'academic_slots',
  {
    id: pk(),
    institutionId: tenantId(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    /** ISO-8601 weekday: 1 = Monday .. 7 = Sunday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    createdAt: createdAt(),
  },
  () => [
    check('academic_slots_day', sql`day_of_week between 1 and 7`),
    check('academic_slots_times', sql`ends_at > starts_at`),
    tenantPolicy('academic_slots'),
  ],
)
