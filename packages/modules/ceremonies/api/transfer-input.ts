import * as z from 'zod'

/**
 * What the office types for a school transfer certificate (P1-13d, decisions
 * 979 to 983): the CBSE Annexure I facts the platform cannot derive. The pupil,
 * the programme, the school name and the dates of the declaration come from the
 * records; nothing here is inferred from them.
 */

const uuid = z.uuid()
const day = z.iso.date()
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/
const blank = (v: unknown) => (v === '' || v === undefined ? null : v)

/** One line: spaces collapsed, no control characters, 1 to `max` characters. */
const line = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().replace(/ {2,}/g, ' ') : v), z.string().min(1).max(max).regex(NO_CONTROL, 'no control characters'))
const optionalLine = (max: number) => z.preprocess(blank, line(max).nullable()).default(null)
/** The school address may be typed over several lines; they print as one. */
const address = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().replace(/ {2,}/g, ' ') : v),
  z.string().min(1).max(240).regex(NO_CONTROL, 'no control characters'),
)

const subjects = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/ {2,}/g, ' ')) : v),
  z.array(z.string().min(1).max(80).regex(NO_CONTROL)).min(1).max(16),
)

const count = z.coerce.number().int().min(0).max(366)

/** The facts common to an original and a replacement. */
const facts = {
  schoolAddress: address,
  affiliationNo: line(16),
  schoolCode: line(16),
  bookNo: line(16),
  admissionNo: line(32),
  motherName: optionalLine(120),
  fatherOrGuardianName: line(120),
  birthInWords: line(90),
  nationality: line(48),
  reservationCategory: z.enum(['SC', 'ST', 'OBC', 'Neither', 'Not recorded']),
  firstAdmittedOn: day,
  firstClass: line(32),
  lastClassFigures: line(32),
  lastClassWords: line(60),
  lastExamResult: line(120),
  repeatCount: z.coerce.number().int().min(0).max(2),
  subjects,
  promotionEligible: z.enum(['yes', 'no', 'not_applicable']),
  promotionClassFigures: optionalLine(32),
  promotionClassWords: optionalLine(60),
  paidThroughMonth: z.preprocess(blank, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM').nullable()).default(null),
  feeConcession: optionalLine(120),
  workingDays: count,
  presentDays: count,
  activitiesUniformed: optionalLine(160),
  activitiesOther: optionalLine(160),
  conduct: line(80),
  appliedOn: day,
  leavingReason: line(160),
  remarks: optionalLine(160),
  checkedBy: line(120),
}

type Facts = { presentDays: number; workingDays: number; promotionEligible: string; promotionClassFigures: string | null; promotionClassWords: string | null }
const crossChecks = (d: Facts, ctx: z.RefinementCtx) => {
  if (d.presentDays > d.workingDays) ctx.addIssue({ code: 'custom', path: ['presentDays'], message: 'present days cannot exceed working days' })
  const both = d.promotionClassFigures !== null && d.promotionClassWords !== null
  const none = d.promotionClassFigures === null && d.promotionClassWords === null
  if (d.promotionEligible === 'yes' ? !both : !none) {
    ctx.addIssue({ code: 'custom', path: ['promotionClassFigures'], message: 'the class promoted to is given, in figures and words, only when promotion is yes' })
  }
}

export const transferIssueSchema = z
  .strictObject({ studentProgramId: uuid, ...facts })
  .superRefine(crossChecks)
  .meta({ id: 'TransferIssue' })

export const transferReissueSchema = z
  .strictObject({ certificateId: uuid, ...facts })
  .superRefine(crossChecks)
  .meta({ id: 'TransferReissue' })

export const transferRevokeSchema = z
  .strictObject({
    certificateId: uuid,
    reason: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(5).max(500)),
  })
  .meta({ id: 'TransferRevoke' })

export const transferListSchema = z.strictObject({
  serial: z.string().regex(/^TC-[0-9]{4}-[0-9]{6}$/).optional(),
  studentId: z.string().min(1).max(128).optional(),
})

export type TransferFacts = z.output<typeof transferIssueSchema>
