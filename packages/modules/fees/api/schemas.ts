import * as z from 'zod'
import { awardBasisEnum, paymentMethodEnum, scholarshipKindEnum } from '../schema'
import { parseRupeesToPaise } from '@campusos/money'

const uuid = z.uuid()
const label = z.string().min(1).max(120).trim()

/**
 * Rupees in, paise out, at the edge and only here. Everything downstream deals
 * in integers, so a float can never reach the ledger.
 */
const rupees = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const paise = parseRupeesToPaise(v)
  if (paise === null) {
    ctx.addIssue({ code: 'custom', message: 'not a valid rupee amount' })
    return z.NEVER
  }
  return paise
})

const positiveRupees = rupees.refine((p) => p > 0, 'must be more than zero')

export const createFeeItemSchema = z
  .object({
    programId: uuid,
    termId: uuid,
    label,
    amount: positiveRupees,
    /**
     * Whether dropping a course reduces this line. Tuition does; a one-off
     * registration or examination fee does not.
     */
    proratable: z.coerce.boolean().default(false),
    dueOn: z.iso.date().nullish(),
  })
  .meta({ id: 'FeeItemCreate' })

/** The reason is required at every layer: schema, column, and audit row. */
export const grantWaiverSchema = z
  .object({
    studentId: z.string().min(1),
    feeItemId: uuid,
    amount: positiveRupees,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'FeeWaiverGrant' })

export const revokeWaiverSchema = z
  .object({
    waiverId: uuid,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'FeeWaiverRevoke' })

export const recordPaymentSchema = z
  .object({
    studentId: z.string().min(1),
    termId: uuid,
    amount: positiveRupees,
    method: z.enum(paymentMethodEnum.enumValues),
    reference: z.string().max(120).trim().nullish(),
    receivedAt: z.iso.datetime().nullish(),
    notes: z.string().max(500).trim().nullish(),
  })
  .meta({ id: 'FeePaymentRecord' })

/**
 * Issuing is deliberately per term, not per student: a clerk issuing one
 * invoice at a time is how half a cohort ends up uninvoiced. `studentId`
 * narrows it for the late admission who joined after the run.
 */
export const issueInvoicesSchema = z
  .object({
    termId: uuid,
    studentId: z.string().min(1).nullish(),
  })
  .meta({ id: 'FeeInvoiceIssue' })

/**
 * A refund is always against the payment the money came in on. The method
 * defaults to the way it arrived, because returning cash by cheque is a
 * decision somebody has to make on purpose.
 */
export const refundPaymentSchema = z
  .object({
    paymentId: uuid,
    amount: positiveRupees,
    reason: z.string().trim().min(5).max(500),
    method: z.enum(paymentMethodEnum.enumValues).nullish(),
    reference: z.string().max(120).trim().nullish(),
  })
  .meta({ id: 'FeeRefund' })

export const reconcilePaymentSchema = z
  .object({
    paymentId: uuid,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'FeePaymentReconcile' })

// --- reads -----------------------------------------------------------------

export const ledgerLineSchema = z
  .object({
    feeItemId: uuid,
    label: z.string(),
    chargedPaise: z.number().int(),
    waivedPaise: z.number().int(),
    waiverId: uuid.nullable(),
    waiverReason: z.string().nullable(),
  })
  .meta({ id: 'FeeLedgerLine' })

export const paymentSchema = z
  .object({
    id: uuid,
    receiptNo: z.string(),
    amountPaise: z.number().int(),
    method: z.enum(paymentMethodEnum.enumValues),
    reference: z.string().nullable(),
    receivedAt: z.string(),
    reconciledAt: z.string().nullable(),
  })
  .meta({ id: 'FeePayment' })

export const studentLedgerSchema = z
  .object({
    studentId: z.string(),
    studentName: z.string().nullable(),
    studentEmail: z.string().nullable(),
    termCode: z.string(),
    termName: z.string(),
    lines: z.array(ledgerLineSchema),
    payments: z.array(paymentSchema),
    chargedPaise: z.number().int(),
    waivedPaise: z.number().int(),
    /** Scholarships funded and credit for dropped courses, both already posted. */
    creditedPaise: z.number().int(),
    payablePaise: z.number().int(),
    paidPaise: z.number().int(),
    refundedPaise: z.number().int(),
    unreconciledPaise: z.number().int(),
    outstandingPaise: z.number().int(),
    overpaidPaise: z.number().int(),
    /** Null until the term's charges have been issued to this student. */
    invoicedAt: z.string().nullable(),
  })
  .meta({ id: 'FeeStudentLedger' })

export const duesRowSchema = z
  .object({
    studentId: z.string(),
    studentName: z.string().nullable(),
    studentEmail: z.string().nullable(),
    programCode: z.string(),
    creditedPaise: z.number().int(),
    payablePaise: z.number().int(),
    paidPaise: z.number().int(),
    refundedPaise: z.number().int(),
    unreconciledPaise: z.number().int(),
    outstandingPaise: z.number().int(),
  })
  .meta({ id: 'FeeDuesRow' })

export const duesReportSchema = z
  .object({
    termCode: z.string(),
    rows: z.array(duesRowSchema),
    totalOutstandingPaise: z.number().int(),
    defaulterCount: z.number().int(),
  })
  .meta({ id: 'FeeDuesReport' })

export type StudentLedger = z.infer<typeof studentLedgerSchema>
export type DuesReport = z.infer<typeof duesReportSchema>

// --- student financials ----------------------------------------------------

export const createScholarshipSchema = z
  .object({
    code: z.string().min(1).max(24).trim().toUpperCase(),
    name: z.string().min(1).max(200).trim(),
    kind: z.enum(scholarshipKindEnum.enumValues),
    basis: z.enum(awardBasisEnum.enumValues),
    /** For a fixed award, in rupees. */
    amountPaise: positiveRupees.optional(),
    /** For a proportional award: basis points of the term's charges. */
    percentBps: z.coerce.number().int().min(1).max(10_000).optional(),
    minCredits: z.coerce.number().int().min(0).max(60).default(0),
    minCgpa: z.coerce.number().min(0).max(100).optional(),
  })
  .refine((s) => (s.basis === 'fixed') === (s.amountPaise !== undefined), {
    message: 'a fixed award needs an amount, and a proportional one does not take it',
    path: ['amountPaise'],
  })
  .refine((s) => (s.basis === 'proportional') === (s.percentBps !== undefined), {
    message: 'a proportional award needs a share, and a fixed one does not take it',
    path: ['percentBps'],
  })
  .meta({ id: 'FeesCreateScholarship' })

export const assessAidSchema = z
  .object({ studentId: z.string().min(1), termId: z.uuid() })
  .meta({ id: 'FeesAssessAid' })

export const awardScholarshipSchema = z
  .object({
    scholarshipId: z.uuid(),
    studentId: z.string().min(1),
    termId: z.uuid(),
    reason: z.string().max(500).trim().optional(),
  })
  .meta({ id: 'FeesAwardScholarship' })

export const revokeAwardSchema = z
  .object({
    awardId: z.uuid(),
    /** On the record, beside the reversal in the books. */
    reason: z.string().min(5).max(500).trim(),
  })
  .meta({ id: 'FeesRevokeAward' })

export const setRefundRulesSchema = z
  .object({
    termId: z.uuid(),
    /**
     * Replaced as a set: a bracket only means anything beside the others, and
     * editing them one at a time leaves a moment when the policy says something
     * nobody decided. An empty list is a term that refunds nothing.
     */
    brackets: z
      .array(
        z.object({
          throughOn: z.iso.date(),
          refundBps: z.coerce.number().int().min(0).max(10_000),
        }),
      )
      .max(12),
  })
  .meta({ id: 'FeesSetRefundRules' })

export const prorateDropsSchema = z
  .object({
    termId: z.uuid(),
    /** Omitted sweeps the whole term, which is how a bursar runs it. */
    studentId: z.string().min(1).optional(),
  })
  .meta({ id: 'FeesProrateDrops' })

const aidOfferSchema = z.object({
  scholarshipId: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(scholarshipKindEnum.enumValues),
  amountPaise: z.number().int(),
  eligible: z.boolean(),
  /**
   * Why not, in the institution's own terms. `credit_load_unknown` is a
   * genuine third answer, distinct from failing the rule: it means nobody can
   * tell, and awarding on it anyway would be a number nobody could defend.
   */
  reasons: z.array(z.string()),
})

export const aidAssessmentSchema = z
  .object({
    studentId: z.string(),
    studentName: z.string().nullable(),
    termId: z.uuid(),
    credits: z.number().int().nullable(),
    cgpa: z.number().nullable(),
    chargedPaise: z.number().int(),
    offers: z.array(aidOfferSchema),
  })
  .meta({ id: 'FeesAidAssessment' })

export type AidAssessment = z.infer<typeof aidAssessmentSchema>
