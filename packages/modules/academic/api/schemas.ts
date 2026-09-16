import * as z from 'zod'
import { programLevelEnum } from '../schema'

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

export const createTermSchema = z
  .object({
    code,
    name,
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  })
  // Checked here as well as by the database CHECK, so the admin sees the
  // problem next to the field rather than as a constraint violation.
  .refine((t) => t.endsOn > t.startsOn, {
    message: 'the end date must be after the start date',
    path: ['endsOn'],
  })
  .meta({ id: 'AcademicCreateTerm' })

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
