import * as z from 'zod'
import { parseRupeesToPaise } from '@campusos/money'
import { copyStatusEnum } from '../schema'

const uuid = z.uuid()

/** Rupees in, paise out, at the edge and only here. */
const rupees = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const paise = parseRupeesToPaise(v)
  if (paise === null) {
    ctx.addIssue({ code: 'custom', message: 'not a valid rupee amount' })
    return z.NEVER
  }
  return paise
})

/**
 * ISBN-10 or ISBN-13, hyphens and spaces stripped. Not check-digit validated:
 * a librarian copying from a cover is far more likely to hit a genuine legacy
 * or misprinted number than to typo one, and refusing a real book because its
 * printed ISBN fails a checksum is worse than storing what is on the cover.
 */
const isbn = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => /^(\d{9}[\dXx]|\d{13})$/.test(s), 'not an ISBN-10 or ISBN-13')

export const createTitleSchema = z
  .object({
    isbn: isbn.nullish(),
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().min(1).max(200),
    publisher: z.string().trim().max(200).nullish(),
    year: z.coerce.number().int().min(1400).max(2200).nullish(),
    category: z.string().trim().max(80).nullish(),
  })
  .meta({ id: 'LibraryTitleCreate' })

export const addCopiesSchema = z
  .object({
    titleId: uuid,
    /** One accession number per copy. The desk types what is stamped inside. */
    accessionNos: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
    shelf: z.string().trim().max(40).nullish(),
    replacement: rupees.nullish(),
  })
  .meta({ id: 'LibraryCopiesAdd' })

export const setCopyStatusSchema = z
  .object({
    copyId: uuid,
    status: z.enum(copyStatusEnum.enumValues),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'LibraryCopyStatusSet' })

export const issueSchema = z
  .object({
    /** Either works: the desk scans a barcode, the catalogue links by id. */
    copyId: uuid.optional(),
    accessionNo: z.string().trim().min(1).max(40).optional(),
    borrowerId: z.string().min(1),
  })
  .refine((v) => Boolean(v.copyId ?? v.accessionNo), 'a copy or an accession number is required')
  .meta({ id: 'LibraryIssue' })

export const returnSchema = z
  .object({
    copyId: uuid.optional(),
    accessionNo: z.string().trim().min(1).max(40).optional(),
    /** The copy came back damaged beyond use, or did not come back at all. */
    markLost: z.boolean().nullish(),
  })
  .refine((v) => Boolean(v.copyId ?? v.accessionNo), 'a copy or an accession number is required')
  .meta({ id: 'LibraryReturn' })

export const renewSchema = z.object({ loanId: uuid }).meta({ id: 'LibraryRenew' })

export const waiveFineSchema = z
  .object({
    loanId: uuid,
    amount: rupees,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'LibraryFineWaive' })

export const settleFineSchema = z
  .object({ loanId: uuid })
  .meta({ id: 'LibraryFineSettle' })

export const librarySettingsSchema = z
  .object({
    loanDays: z.coerce.number().int().min(1).max(365),
    graceDays: z.coerce.number().int().min(0).max(90),
    finePerDay: rupees,
    maxConcurrentLoans: z.coerce.number().int().min(1).max(50),
    maxRenewals: z.coerce.number().int().min(0).max(20),
    maxFine: rupees.nullish(),
    blockAtOutstanding: rupees,
  })
  .meta({ id: 'LibrarySettings' })

// --- reads -----------------------------------------------------------------

export const catalogueRowSchema = z
  .object({
    titleId: uuid,
    isbn: z.string().nullable(),
    title: z.string(),
    author: z.string(),
    publisher: z.string().nullable(),
    year: z.number().int().nullable(),
    category: z.string().nullable(),
    copies: z.number().int(),
    available: z.number().int(),
  })
  .meta({ id: 'LibraryCatalogueRow' })

export const loanRowSchema = z
  .object({
    id: uuid,
    copyId: uuid,
    accessionNo: z.string(),
    title: z.string(),
    author: z.string(),
    borrowerId: z.string(),
    borrowerName: z.string().nullable(),
    borrowerEmail: z.string().nullable(),
    issuedAt: z.string(),
    dueOn: z.string(),
    returnedAt: z.string().nullable(),
    renewals: z.number().int(),
    /** Accrued so far for an open loan; what was charged for a closed one. */
    finePaise: z.number().int(),
    fineWaivedPaise: z.number().int(),
    finePaidAt: z.string().nullable(),
    daysOverdue: z.number().int(),
  })
  .meta({ id: 'LibraryLoan' })

export const borrowerStatusSchema = z
  .object({
    borrowerId: z.string(),
    borrowerName: z.string().nullable(),
    open: z.array(loanRowSchema),
    history: z.array(loanRowSchema),
    openCount: z.number().int(),
    maxConcurrentLoans: z.number().int(),
    outstandingFinePaise: z.number().int(),
    /** Null when they may borrow; otherwise the rule that says they may not. */
    blockedBy: z.string().nullable(),
  })
  .meta({ id: 'LibraryBorrowerStatus' })

export const overdueReportSchema = z
  .object({
    rows: z.array(loanRowSchema),
    totalAccruedPaise: z.number().int(),
  })
  .meta({ id: 'LibraryOverdueReport' })

export type CatalogueRow = z.infer<typeof catalogueRowSchema>
export type LoanRow = z.infer<typeof loanRowSchema>
export type BorrowerStatus = z.infer<typeof borrowerStatusSchema>
export type OverdueReport = z.infer<typeof overdueReportSchema>
