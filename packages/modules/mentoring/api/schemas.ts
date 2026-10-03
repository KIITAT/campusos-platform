import * as z from 'zod'

const uuid = z.uuid()
const bool = z.preprocess((v) => (v === 'true' || v === 'on' ? true : v === 'false' ? false : v), z.boolean())
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const idList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string().min(1)).min(1),
)
const moment = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, 'a date and time')

export const assignSchema = z
  .object({
    /** One student, several ticked, or a whole section. */
    studentIds: z.preprocess(blank, idList.optional()),
    sectionId: z.preprocess(blank, uuid.optional()),
    mentorId: z.string().min(1),
    coMentorId: z.preprocess(blank, z.string().min(1).optional()),
    reason: z.preprocess(blank, z.string().trim().max(300).optional()),
  })
  .refine((d) => d.studentIds?.length || d.sectionId, { message: 'choose students or a section', path: ['studentIds'] })
  .meta({ id: 'MentorAssign' })

export const endAssignmentSchema = z
  .object({ studentIds: idList, reason: z.string().trim().min(5).max(300) })
  .meta({ id: 'MentorAssignmentEnd' })

export const noteSchema = z
  .object({
    studentId: z.string().min(1),
    metOn: z.iso.date(),
    kind: z.enum(['meeting', 'call', 'progress', 'concern']),
    body: z.string().trim().min(3).max(4000),
    shared: bool.default(false),
  })
  .meta({ id: 'MentorNote' })

export const messageSchema = z
  .object({
    /** The thread: the student's own, when a student writes. */
    studentId: z.preprocess(blank, z.string().min(1).optional()),
    body: z.string().trim().min(1).max(4000),
  })
  .meta({ id: 'MentorMessage' })

export const leaveTypeSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    needsDocument: bool.default(false),
    maxDays: z.preprocess(blank, z.coerce.number().int().min(1).max(365).optional()),
  })
  .meta({ id: 'MentorLeaveType' })

export const retireLeaveTypeSchema = z.object({ leaveTypeId: uuid }).meta({ id: 'MentorLeaveTypeRetire' })

const upload = z.object({ name: z.string(), type: z.string(), size: z.number(), base64: z.string() })

export const applyLeaveSchema = z
  .object({
    leaveTypeId: uuid,
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    purpose: z.string().trim().min(5).max(500),
    placeOfVisit: z.string().trim().min(2).max(200),
    /** When they leave and return, as a datetime-local input sends it, in India time. */
    leavingAt: moment,
    arrivingAt: moment,
    contactPhone: z.string().trim().regex(/^[0-9+() -]{7,20}$/, 'a phone number'),
    document: z.preprocess(blank, upload.optional()),
  })
  .meta({ id: 'MentorLeaveApply' })

export const decideLeaveSchema = z
  .object({
    applicationId: uuid,
    decision: z.enum(['approve', 'reject']),
    note: z.preprocess(blank, z.string().trim().max(500).optional()),
  })
  .meta({ id: 'MentorLeaveDecide' })

export const cancelLeaveSchema = z
  .object({ applicationId: uuid, reason: z.preprocess(blank, z.string().trim().max(500).optional()) })
  .meta({ id: 'MentorLeaveCancel' })
