import * as z from 'zod'

const uuid = z.uuid()
const paise = z.int().min(0).max(Number.MAX_SAFE_INTEGER)

export const accountTypes = ['asset', 'liability', 'equity', 'income', 'expense'] as const

export const accountPurposes = [
  'cash',
  'bank',
  'fees_receivable',
  'fee_income',
  'fee_waiver',
  'salaries_expense',
  'employer_cost',
  'salaries_payable',
  'withholdings_payable',
] as const

export type AccountPurpose = (typeof accountPurposes)[number]

export const createAccountSchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(2).max(120),
    type: z.enum(accountTypes),
    purpose: z.enum(accountPurposes).nullish(),
  })
  .meta({ id: 'FinanceCreateAccount' })

export const archiveAccountSchema = z
  .object({ accountId: uuid, archived: z.boolean() })
  .meta({ id: 'FinanceArchiveAccount' })

/**
 * A line names its account either by the institution's own code or by the
 * purpose a posting module asks for. Exactly one, because accepting both invites
 * a caller to supply two that disagree and a reader to guess which wins.
 */
export const journalLineSchema = z
  .object({
    accountCode: z.string().trim().min(1).max(20).optional(),
    purpose: z.enum(accountPurposes).optional(),
    debitPaise: paise.default(0),
    creditPaise: paise.default(0),
    costCenter: z.string().trim().max(80).nullish(),
    memo: z.string().trim().max(200).nullish(),
  })
  .refine((l) => !!l.accountCode !== !!l.purpose, {
    message: 'name the account by code or by purpose, not both and not neither',
  })
  .refine((l) => (l.debitPaise > 0) !== (l.creditPaise > 0), {
    message: 'a line is a debit or a credit, and not zero',
  })
  .meta({ id: 'FinanceJournalLine' })

export const postEntrySchema = z
  .object({
    occurredAt: z.coerce.date().optional(),
    memo: z.string().trim().min(1).max(200),
    /** Which module is posting. Callers inside the platform pass their own id. */
    sourceModule: z.string().trim().min(1).max(40).default('manual'),
    /**
     * That module's reference for the thing being posted. Unique within the
     * module, per institution: it is what makes a retry idempotent rather than
     * a second helping of revenue.
     */
    sourceRef: z.string().trim().min(1).max(120),
    lines: z.array(journalLineSchema).min(2).max(200),
  })
  .meta({ id: 'FinancePostEntry' })

export const reverseEntrySchema = z
  .object({
    entryId: uuid,
    reason: z.string().trim().min(5).max(200),
  })
  .meta({ id: 'FinanceReverseEntry' })

export const trialBalanceSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .meta({ id: 'FinanceTrialBalanceQuery' })

export const trialBalanceRowSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    type: z.enum(accountTypes),
    debitPaise: z.int(),
    creditPaise: z.int(),
    /** Positive on the account's normal side, so a reader never has to convert. */
    balancePaise: z.int(),
  })
  .meta({ id: 'FinanceTrialBalanceRow' })
