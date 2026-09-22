import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  numeric,
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

/**
 * Not every term is a semester. A summer term is shorter, carries a smaller
 * credit load and has its own fee structure and its own drop deadline, so the
 * kind has to be on the row rather than inferred from the dates.
 */
export const termKindEnum = pgEnum('academic_term_kind', [
  'regular',
  'summer',
  'winter',
])

export const terms = pgTable(
  'academic_terms',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    kind: termKindEnum().notNull().default('regular'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    /**
     * The calendar, which is what registration and refunds are keyed to. All
     * nullable: a term can be created before its dates are settled, and a
     * window that is not set is treated as closed rather than as wide open.
     */
    registrationOpensOn: date('registration_opens_on'),
    registrationClosesOn: date('registration_closes_on'),
    /** Last day a course can be added or dropped without a mark on the record. */
    addDropEndsOn: date('add_drop_ends_on'),
    /** Last day to withdraw at all; after it, the course is graded. */
    withdrawEndsOn: date('withdraw_ends_on'),
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
    check(
      'academic_terms_calendar',
      sql`(registration_closes_on is null or registration_opens_on is null
            or registration_closes_on >= registration_opens_on)
          and (add_drop_ends_on is null or add_drop_ends_on >= starts_on)
          and (withdraw_ends_on is null or add_drop_ends_on is null
            or withdraw_ends_on >= add_drop_ends_on)
          and (withdraw_ends_on is null or withdraw_ends_on <= ends_on)`,
    ),
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

// --- curricula -------------------------------------------------------------

/**
 * What a degree actually requires, as of a catalogue year.
 *
 * The catalogue year is the whole point: a programme's requirements change, and
 * a student is held to the ones in force when they declared, not to whatever
 * the registrar last edited. So requirements hang off a curriculum rather than
 * off the programme, and a student's declaration points at one.
 */
export const curricula = pgTable(
  'academic_curricula',
  {
    id: pk(),
    institutionId: tenantId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    /** The intake this applies to, e.g. 2024 for the 2024-25 catalogue. */
    catalogYear: smallint('catalog_year').notNull(),
    /** Total credits for the award; requirement minimums sit under it. */
    totalCredits: smallint('total_credits').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_curricula_identity').on(t.programId, t.catalogYear),
    check('academic_curricula_year', sql`catalog_year between 1900 and 2200`),
    check('academic_curricula_credits', sql`total_credits between 1 and 1000`),
    tenantPolicy('academic_curricula'),
  ],
)

export const requirementKindEnum = pgEnum('academic_requirement_kind', [
  /** Named courses, all of which must be passed. */
  'core',
  /** A pool: pass enough of these to make the credits. */
  'elective',
  /** Anything that counts, e.g. "12 credits of open electives". */
  'open',
])

/**
 * One bucket a degree audit checks. `minCredits` is what has to be earned into
 * it; `minCourses` is there because some rules are counted in courses ("two
 * laboratory courses") rather than in credits, and a rule that says both is a
 * real rule rather than a redundant one.
 */
export const requirements = pgTable(
  'academic_requirements',
  {
    id: pk(),
    institutionId: tenantId(),
    curriculumId: uuid('curriculum_id')
      .notNull()
      .references(() => curricula.id, { onDelete: 'cascade' }),
    code: text().notNull(),
    title: text().notNull(),
    kind: requirementKindEnum().notNull(),
    minCredits: smallint('min_credits').notNull().default(0),
    minCourses: smallint('min_courses').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_requirements_code').on(t.curriculumId, t.code),
    check(
      'academic_requirements_minimums',
      sql`min_credits >= 0 and min_courses >= 0 and (min_credits > 0 or min_courses > 0)`,
    ),
    tenantPolicy('academic_requirements'),
  ],
)

/**
 * Which courses can satisfy a requirement. An `open` requirement has no rows
 * here and takes anything that counts; a `core` requirement's rows are all
 * mandatory.
 */
export const requirementCourses = pgTable(
  'academic_requirement_courses',
  {
    institutionId: tenantId(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.requirementId, t.courseId] }),
    tenantPolicy('academic_requirement_courses'),
  ],
)

// --- prerequisites ---------------------------------------------------------

export const prerequisiteKindEnum = pgEnum('academic_prerequisite_kind', [
  /** Must be finished before this course starts. */
  'prerequisite',
  /** Must be finished before, or taken alongside. */
  'corequisite',
])

/**
 * One edge of the prerequisite graph. A course can require several, and the
 * chain is walked by whoever is checking -- the table stores single edges, so a
 * cycle is a database concern rather than an infinite loop in a page.
 *
 * `minGradePoints` is how a real calendar writes it: "MA101 with a C or
 * better". Null means a pass is enough.
 */
export const prerequisites = pgTable(
  'academic_prerequisites',
  {
    id: pk(),
    institutionId: tenantId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    requiresCourseId: uuid('requires_course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    kind: prerequisiteKindEnum().notNull().default('prerequisite'),
    minGradePoints: numeric('min_grade_points', { precision: 4, scale: 2 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_prerequisites_edge').on(t.courseId, t.requiresCourseId),
    check('academic_prerequisites_self', sql`course_id <> requires_course_id`),
    tenantPolicy('academic_prerequisites'),
  ],
)

/**
 * The exception, which every registrar has and no calendar survives without: a
 * named person let a named student into a course they were not eligible for, on
 * a date, for a reason. Deliberately a record rather than a flag -- the reason
 * is the point, and the degree audit reads these back.
 */
export const prerequisiteWaivers = pgTable(
  'academic_prerequisite_waivers',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    /** Null waives every prerequisite of the course; set, waives one edge. */
    requiresCourseId: uuid('requires_course_id').references(() => courses.id, {
      onDelete: 'cascade',
    }),
    reason: text().notNull(),
    approvedBy: text('approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('academic_prerequisite_waivers_once')
      .on(t.studentId, t.courseId, t.requiresCourseId)
      .where(sql`requires_course_id is not null`),
    uniqueIndex('academic_prerequisite_waivers_blanket')
      .on(t.studentId, t.courseId)
      .where(sql`requires_course_id is null`),
    check('academic_prerequisite_waivers_reason', sql`length(trim(reason)) >= 5`),
    tenantPolicy('academic_prerequisite_waivers'),
  ],
)

/**
 * Cross-listing and equivalence, which are the same question asked twice: CS210
 * and MA210 are one course taught once, and the MA101 a transfer student passed
 * elsewhere is this institution's MA101 as far as the chain is concerned.
 *
 * Stored as one directed row per claim and read in both directions, so the
 * registrar states it once.
 */
export const courseEquivalences = pgTable(
  'academic_course_equivalences',
  {
    institutionId: tenantId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    equivalentCourseId: uuid('equivalent_course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.courseId, t.equivalentCourseId] }),
    check(
      'academic_course_equivalences_self',
      sql`course_id <> equivalent_course_id`,
    ),
    tenantPolicy('academic_course_equivalences'),
  ],
)

// --- a student's programmes ------------------------------------------------

export const enrolmentStatusEnum = pgEnum('academic_enrolment_status', [
  'active',
  'completed',
  'withdrawn',
  'transferred_out',
])

/**
 * A declaration, not a column on the user. A student can read two degrees at
 * once, can change programme without losing the record of the first, and can
 * come back years later -- none of which a `program_id` on `users` survives.
 *
 * The curriculum is captured at declaration, which is what holds the student to
 * the requirements in force when they started.
 */
export const studentPrograms = pgTable(
  'academic_student_programs',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'restrict' }),
    curriculumId: uuid('curriculum_id').references(() => curricula.id, {
      onDelete: 'restrict',
    }),
    status: enrolmentStatusEnum().notNull().default('active'),
    /** Which one the transcript leads with when there are two. */
    isPrimary: boolean('is_primary').notNull().default(true),
    declaredOn: date('declared_on').notNull().defaultNow(),
    endedOn: date('ended_on'),
    createdAt: createdAt(),
  },
  (t) => [
    // One live declaration per programme: reading the same degree again after
    // withdrawing is fine, holding two of it at once is not.
    uniqueIndex('academic_student_programs_live')
      .on(t.studentId, t.programId)
      .where(sql`status = 'active'`),
    uniqueIndex('academic_student_programs_primary')
      .on(t.studentId)
      .where(sql`is_primary and status = 'active'`),
    check(
      'academic_student_programs_ended',
      sql`(status = 'active') = (ended_on is null)`,
    ),
    tenantPolicy('academic_student_programs'),
  ],
)

// --- what a student has actually done --------------------------------------

export const completionSourceEnum = pgEnum('academic_completion_source', [
  /** Earned here, posted by the examinations module when results are final. */
  'internal',
  /** Earned elsewhere and accepted, with the paperwork named in `note`. */
  'transfer',
])

/**
 * The single answer to "has this student passed that course", which the
 * prerequisite check, the degree audit and the transcript all ask.
 *
 * Credits live on the row rather than being read back off the course, because a
 * transferred course is credited at whatever was agreed, and because a course's
 * credit value can change without silently rewriting what past students earned.
 *
 * Grade points are nullable: a transfer credit often has no comparable grade,
 * and a pass with no points still satisfies a chain that asks for no minimum.
 */
export const courseCompletions = pgTable(
  'academic_course_completions',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    /** Null for a transfer: it was not earned in one of our terms. */
    termId: uuid('term_id').references(() => terms.id, { onDelete: 'restrict' }),
    credits: smallint().notNull(),
    gradePoints: numeric('grade_points', { precision: 4, scale: 2 }),
    gradeLabel: text('grade_label'),
    passed: boolean().notNull().default(true),
    /** Bumped by every audited correction, so a disputed grade shows its depth. */
    revision: smallint().notNull().default(0),
    source: completionSourceEnum().notNull().default('internal'),
    note: text(),
    recordedBy: text('recorded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    // A repeat is a second attempt in a second term, which is allowed; two rows
    // for the same course in the same term is a double post.
    uniqueIndex('academic_course_completions_attempt').on(
      t.studentId,
      t.courseId,
      t.termId,
    ),
    index('academic_course_completions_student').on(t.studentId),
    check('academic_course_completions_credits', sql`credits between 0 and 30`),
    tenantPolicy('academic_course_completions'),
  ],
)
