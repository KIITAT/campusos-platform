import * as z from 'zod'

const uuid = z.uuid()
const reason = z.string().trim().min(5).max(500)
const bool = z.preprocess((v) => (v === 'true' || v === 'on' ? true : v === 'false' ? false : v), z.boolean())

/** An ISO instant with its offset, or a wall-clock time read in the window's zone. */
const moment = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, 'a date and time')

export const setSettingsSchema = z
  .object({
    paperReleaseMinutes: z.coerce.number().int().min(5).max(1440).default(60),
    gradeReportNeedsFeedback: bool.default(false),
  })
  .meta({ id: 'ExamCycleSettings' })

export const setWindowSchema = z
  .object({
    termId: uuid,
    kind: z.enum(['enrolment', 'backlog']),
    opensAt: moment,
    closesAt: moment,
    timeZone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
    /** Printed on the admit card. */
    instructions: z.string().trim().max(2000).optional(),
    /** Backlog: rupees per paper for the internal assessment, and for the university exam. */
    internalFee: z.string().trim().max(20).optional(),
    examFee: z.string().trim().max(20).optional(),
  })
  .meta({ id: 'ExamWindowSet' })

export const enrolSchema = z
  .object({
    termId: uuid,
    /** "I have checked my name, numbers, phone and address." */
    confirm: bool.default(false),
  })
  .meta({ id: 'ExamEnrol' })

export const cancelEnrolmentSchema = z.object({ enrolmentId: uuid, reason }).meta({ id: 'ExamEnrolmentCancel' })

export const bookBacklogSchema = z
  .object({
    termId: uuid,
    courseId: uuid,
    bookingType: z.enum(['internal', 'university', 'both']),
  })
  .meta({ id: 'ExamBacklogBook' })

export const cancelBacklogSchema = z.object({ bookingId: uuid, reason }).meta({ id: 'ExamBacklogCancel' })

const upload = z.object({ name: z.string(), type: z.string(), size: z.number(), base64: z.string() })

export const uploadPaperSchema = z
  .object({
    examId: uuid,
    /** A PDF, as `{ name, type, size, base64 }`; a form's file input arrives as exactly this. */
    paper: upload,
  })
  .meta({ id: 'ExamPaperUpload' })
