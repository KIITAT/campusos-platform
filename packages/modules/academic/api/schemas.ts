import * as z from 'zod'
import {
  completionSourceEnum,
  prerequisiteKindEnum,
  programLevelEnum,
  requirementKindEnum,
  termKindEnum,
} from '../schema'

/**
 * The module owns its own contract. api-contracts imports these to build the
 * single OpenAPI document -- one direction only, so a module never depends on
 * the aggregate that describes it.
 */

const code = z
  .string()
  .min(1)
  .max(24)
  .trim()
  .toUpperCase()
  .meta({ example: 'CSE' })

const name = z.string().min(1).max(200).trim()
const uuid = z.uuid()

export const createDepartmentSchema = z
  .object({ code, name })
  .meta({ id: 'AcademicCreateDepartment' })

export const createProgramSchema = z
  .object({
    departmentId: uuid,
    code,
    name,
    level: z.enum(programLevelEnum.enumValues),
    durationTerms: z.coerce.number().int().min(1).max(24),
  })
  .meta({ id: 'AcademicCreateProgram' })

export const createCourseSchema = z
  .object({
    departmentId: uuid,
    code,
    title: name,
    credits: z.coerce.number().int().min(0).max(30),
  })
  .meta({ id: 'AcademicCreateCourse' })

/**
 * The dates registration and refunds are keyed to. Separate from the term's own
 * start and end because they are decided later, by a different committee, and
 * because a term with no window set is closed rather than open to everyone.
 */
const calendar = {
  registrationOpensOn: z.iso.date().nullish(),
  registrationClosesOn: z.iso.date().nullish(),
  addDropEndsOn: z.iso.date().nullish(),
  withdrawEndsOn: z.iso.date().nullish(),
}

const calendarIsOrdered = <T extends Record<string, unknown>>(t: T): boolean => {
  const c = t as {
    registrationOpensOn?: string | null
    registrationClosesOn?: string | null
    addDropEndsOn?: string | null
    withdrawEndsOn?: string | null
  }
  if (c.registrationOpensOn && c.registrationClosesOn) {
    if (c.registrationClosesOn < c.registrationOpensOn) return false
  }
  if (c.addDropEndsOn && c.withdrawEndsOn) {
    if (c.withdrawEndsOn < c.addDropEndsOn) return false
  }
  return true
}

export const createTermSchema = z
  .object({
    code,
    name,
    /** A summer term is not a short semester; it bills and drops differently. */
    kind: z.enum(termKindEnum.enumValues).default('regular'),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    ...calendar,
  })
  // Checked here as well as by the database CHECK, so the admin sees the
  // problem next to the field rather than as a constraint violation.
  .refine((t) => t.endsOn > t.startsOn, {
    message: 'the end date must be after the start date',
    path: ['endsOn'],
  })
  .refine(calendarIsOrdered, {
    message: 'the calendar runs backwards: check the registration and drop dates',
    path: ['addDropEndsOn'],
  })
  .meta({ id: 'AcademicCreateTerm' })

export const setTermCalendarSchema = z
  .object({ termId: uuid, ...calendar })
  .refine(calendarIsOrdered, {
    message: 'the calendar runs backwards: check the registration and drop dates',
    path: ['addDropEndsOn'],
  })
  .meta({ id: 'AcademicSetTermCalendar' })

export const createRoomSchema = z
  .object({
    code,
    building: z.string().max(120).trim().nullish(),
    capacity: z.coerce.number().int().min(1).max(10_000).nullish(),
  })
  .meta({ id: 'AcademicCreateRoom' })

export const createSectionSchema = z
  .object({
    programId: uuid,
    label: z.string().min(1).max(24).trim().toUpperCase(),
    admissionYear: z.coerce.number().int().min(1900).max(2200),
  })
  .meta({ id: 'AcademicCreateSection' })

export const addSectionMemberSchema = z
  .object({ sectionId: uuid, userId: z.string().min(1) })
  .meta({ id: 'AcademicAddSectionMember' })

export const createOfferingSchema = z
  .object({
    termId: uuid,
    courseId: uuid,
    sectionId: uuid,
    facultyUserId: z.string().min(1).nullish(),
  })
  .meta({ id: 'AcademicCreateOffering' })

export const createSlotSchema = z
  .object({
    offeringId: uuid,
    roomId: uuid,
    /** ISO-8601 weekday: 1 = Monday .. 7 = Sunday. */
    dayOfWeek: z.coerce.number().int().min(1).max(7),
    startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM'),
    endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM'),
  })
  .refine((s) => s.endsAt > s.startsAt, {
    message: 'the end time must be after the start time',
    path: ['endsAt'],
  })
  .meta({ id: 'AcademicCreateSlot' })

export const setCurrentTermSchema = z
  .object({ termId: uuid })
  .meta({ id: 'AcademicSetCurrentTerm' })

/** One row of the weekly timetable, already resolved for display. */
export const timetableEntrySchema = z
  .object({
    slotId: uuid,
    dayOfWeek: z.number().int().min(1).max(7),
    startsAt: z.string(),
    endsAt: z.string(),
    courseCode: z.string(),
    courseTitle: z.string(),
    sectionLabel: z.string(),
    programCode: z.string(),
    roomCode: z.string(),
    facultyName: z.string().nullable(),
  })
  .meta({ id: 'AcademicTimetableEntry' })

export const timetableSchema = z
  .object({
    termCode: z.string().nullable(),
    entries: z.array(timetableEntrySchema),
  })
  .meta({ id: 'AcademicTimetable' })

export type TimetableEntry = z.infer<typeof timetableEntrySchema>
export type Timetable = z.infer<typeof timetableSchema>

// --- curricula, chains and records -----------------------------------------

/**
 * Grade points arrive as a number and are stored as numeric, never as a float:
 * "2.5 or better" is compared and summed, and a tenth of a grade point lost to
 * binary rounding is a degree audit nobody can defend.
 */
const gradePoints = z.coerce
  .number()
  .min(0)
  .max(100)
  .transform((n) => n.toFixed(2))

export const createCurriculumSchema = z
  .object({
    programId: uuid,
    catalogYear: z.coerce.number().int().min(1900).max(2200),
    totalCredits: z.coerce.number().int().min(1).max(1000),
  })
  .meta({ id: 'AcademicCreateCurriculum' })

export const createRequirementSchema = z
  .object({
    curriculumId: uuid,
    code,
    title: name,
    kind: z.enum(requirementKindEnum.enumValues),
    minCredits: z.coerce.number().int().min(0).max(1000).optional(),
    minCourses: z.coerce.number().int().min(0).max(100).optional(),
    /** Empty for an `open` requirement, which takes anything that counts. */
    courseIds: z.array(uuid).default([]),
  })
  .refine((r) => (r.minCredits ?? 0) > 0 || (r.minCourses ?? 0) > 0, {
    message: 'a requirement has to ask for some credits or some courses',
    path: ['minCredits'],
  })
  .refine((r) => r.kind === 'open' || r.courseIds.length > 0, {
    message: 'name the courses that satisfy this, or make it an open requirement',
    path: ['courseIds'],
  })
  .meta({ id: 'AcademicCreateRequirement' })

export const addPrerequisiteSchema = z
  .object({
    courseId: uuid,
    requiresCourseId: uuid,
    kind: z.enum(prerequisiteKindEnum.enumValues).default('prerequisite'),
    /** Null means a pass is enough, which is the common case. */
    minGradePoints: gradePoints.nullish(),
  })
  .refine((p) => p.courseId !== p.requiresCourseId, {
    message: 'a course cannot require itself',
    path: ['requiresCourseId'],
  })
  .meta({ id: 'AcademicAddPrerequisite' })

export const addEquivalenceSchema = z
  .object({
    courseId: uuid,
    equivalentCourseId: uuid,
    note: z.string().max(500).trim().nullish(),
  })
  .refine((e) => e.courseId !== e.equivalentCourseId, {
    message: 'a course is already equivalent to itself',
    path: ['equivalentCourseId'],
  })
  .meta({ id: 'AcademicAddEquivalence' })

export const waivePrerequisiteSchema = z
  .object({
    studentId: z.string().min(1),
    courseId: uuid,
    /** Omitted waives every prerequisite of the course. */
    requiresCourseId: uuid.nullish(),
    reason: z.string().min(5).max(500).trim(),
  })
  .meta({ id: 'AcademicWaivePrerequisite' })

export const declareProgramSchema = z
  .object({
    studentId: z.string().min(1),
    programId: uuid,
    /** Which catalogue the student is held to. */
    curriculumId: uuid.nullish(),
    isPrimary: z.coerce.boolean().default(true),
    declaredOn: z.iso.date().optional(),
  })
  .meta({ id: 'AcademicDeclareProgram' })

export const endStudentProgramSchema = z
  .object({
    studentProgramId: uuid,
    status: z.enum(['completed', 'withdrawn', 'transferred_out']),
    endedOn: z.iso.date().optional(),
  })
  .meta({ id: 'AcademicEndStudentProgram' })

export const recordCompletionSchema = z
  .object({
    studentId: z.string().min(1),
    courseId: uuid,
    /** Null for transfer credit: it was not earned in one of our terms. */
    termId: uuid.nullish(),
    /** Defaults to the course's current credit value, then frozen on the row. */
    credits: z.coerce.number().int().min(0).max(30).optional(),
    gradePoints: gradePoints.nullish(),
    gradeLabel: z.string().max(12).trim().nullish(),
    passed: z.coerce.boolean().default(true),
    source: z.enum(completionSourceEnum.enumValues).default('internal'),
    note: z.string().max(500).trim().nullish(),
  })
  .meta({ id: 'AcademicRecordCompletion' })

/** Who is being asked about; omitted means the caller themselves. */
export const studentRefSchema = z
  .object({ studentId: z.string().min(1).optional() })
  .meta({ id: 'AcademicStudentRef' })

export const eligibilitySchema = z
  .object({ studentId: z.string().min(1), courseId: uuid })
  .meta({ id: 'AcademicEligibilityQuery' })

const unmetSchema = z.object({
  courseId: uuid,
  courseCode: z.string(),
  courseTitle: z.string(),
  minGradePoints: z.string().nullable(),
  reason: z.enum(['not_passed', 'no_grade_on_record', 'below_minimum']),
})

export const eligibilityResultSchema = z
  .object({
    courseId: uuid,
    courseCode: z.string(),
    /** False only for unmet prerequisites; corequisites never block. */
    eligible: z.boolean(),
    missing: z.array(unmetSchema),
    corequisites: z.array(unmetSchema),
  })
  .meta({ id: 'AcademicEligibility' })

export type Eligibility = z.infer<typeof eligibilityResultSchema>
