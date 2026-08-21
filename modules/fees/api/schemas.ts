import * as z from 'zod'
import { paymentMethodEnum } from '../schema'
import { parseRupeesToPaise } from './money'

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
    payablePaise: z.number().int(),
    paidPaise: z.number().int(),
    unreconciledPaise: z.number().int(),
    outstandingPaise: z.number().int(),
    overpaidPaise: z.number().int(),
  })
  .meta({ id: 'FeeStudentLedger' })

export const duesRowSchema = z
  .object({
    studentId: z.string(),
    studentName: z.string().nullable(),
    studentEmail: z.string().nullable(),
    programCode: z.string(),
    payablePaise: z.number().int(),
    paidPaise: z.number().int(),
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
