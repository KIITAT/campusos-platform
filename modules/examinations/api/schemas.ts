import * as z from 'zod'
import { examKindEnum, schemeKindEnum } from '../schema'

const uuid = z.uuid()
const name = z.string().min(1).max(200).trim()

/** Two decimals, because that is what the numeric columns hold. */
const marks = z.coerce.number().min(0).max(10_000).multipleOf(0.01)

export const createExamSchema = z
  .object({
    offeringId: uuid,
    name,
    kind: z.enum(examKindEnum.enumValues),
    maxMarks: marks.refine((n) => n > 0, 'must be greater than zero'),
    weightPercent: z.coerce.number().min(0.01).max(100),
    scheduledAt: z.iso.datetime().nullish(),
    roomId: uuid.nullish(),
  })
  .meta({ id: 'ExamCreate' })

/**
 * One student's mark. `absent` and a null score are different states and the
 * schema keeps them so: absent means sat out a weighted component, null means
 * marked later.
 */
export const markEntrySchema = z
  .object({
    studentId: z.string().min(1),
    obtained: marks.nullish(),
    absent: z.boolean().default(false),
  })
  .refine((m) => !(m.absent && m.obtained !== null && m.obtained !== undefined), {
    message: 'an absent student cannot also have a score',
    path: ['obtained'],
  })
  .meta({ id: 'ExamMarkEntry' })

export const enterMarksSchema = z
  .object({ examId: uuid, marks: z.array(markEntrySchema).min(1).max(1000) })
  .meta({ id: 'ExamEnterMarks' })

export const publishExamSchema = z
  .object({ examId: uuid })
  .meta({ id: 'ExamPublish' })

/**
 * The only way to change a published mark. The reason is mandatory here, in the
 * audit row, and in the database trigger -- three places, because this is the
 * one path an institution will be asked to justify in a dispute.
 */
export const reviseMarkSchema = z
  .object({
    examId: uuid,
    studentId: z.string().min(1),
    obtained: marks.nullish(),
    absent: z.boolean().default(false),
    reason: z.string().trim().min(10).max(500),
  })
  .meta({ id: 'ExamReviseMark' })

export const unpublishExamSchema = z
  .object({
    examId: uuid,
    reason: z.string().trim().min(10).max(500),
  })
  .meta({ id: 'ExamUnpublish' })

// --- grading schemes -------------------------------------------------------

export const bandSchema = z
  .object({
    minPercent: z.coerce.number().min(0).max(100),
    label: z.string().min(1).max(8).trim(),
    points: z.coerce.number().min(0).max(100).nullish(),
    isPass: z.boolean().default(true),
  })
  .meta({ id: 'ExamGradeBand' })

export const createSchemeSchema = z
  .object({
    name,
    kind: z.enum(schemeKindEnum.enumValues),
    maxPoints: z.coerce.number().min(1).max(100).nullish(),
    isDefault: z.boolean().default(false),
    bands: z.array(bandSchema).max(30).default([]),
  })
  .refine((s) => s.kind === 'percentage' || s.bands.length > 0, {
    message: 'a gpa or custom scheme needs at least one band',
    path: ['bands'],
  })
  .refine(
    (s) => new Set(s.bands.map((b) => b.minPercent)).size === s.bands.length,
    { message: 'two bands cannot share a floor', path: ['bands'] },
  )
  .meta({ id: 'ExamCreateScheme' })

// --- reads -----------------------------------------------------------------

export const gradeSchema = z
  .object({
    courseCode: z.string(),
    courseTitle: z.string(),
    credits: z.number(),
    percent: z.number(),
    complete: z.boolean(),
    label: z.string().nullable(),
    points: z.number().nullable(),
    passed: z.boolean(),
  })
  .meta({ id: 'ExamGrade' })

export const transcriptSchema = z
  .object({
    studentName: z.string().nullable(),
    studentEmail: z.string().nullable(),
    institutionName: z.string(),
    programCode: z.string().nullable(),
    schemeName: z.string(),
    schemeKind: z.enum(schemeKindEnum.enumValues),
    terms: z.array(
      z.object({
        termCode: z.string(),
        termName: z.string(),
        grades: z.array(gradeSchema),
        gpa: z.number().nullable(),
        credits: z.number(),
      }),
    ),
    cumulativeGpa: z.number().nullable(),
    totalCredits: z.number(),
    /** True when any course still has unmarked weight. Printed on the PDF. */
    provisional: z.boolean(),
  })
  .meta({ id: 'ExamTranscript' })

export type Transcript = z.infer<typeof transcriptSchema>
export type Grade = z.infer<typeof gradeSchema>
