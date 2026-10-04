import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { accountSubtypes } from '../schema/ledger'

const uuid = z.uuid()
const paise = z.int().min(0).max(Number.MAX_SAFE_INTEGER)

export const accountTypes = ['asset', 'liability', 'equity', 'income', 'expense'] as const

export const accountPurposes = [
  'cash',
  'bank',
  'fees_receivable',
  'fee_income',
  'fee_waiver',
  'fine_income',
  'scholarship_expense',
  'salaries_expense',
  'employer_cost',
  'salaries_payable',
  'withholdings_payable',
  'employee_advances',
  'staff_expenses',
  'expense_claims_payable',
  'accounts_receivable',
  'accounts_payable',
  'stock_in_hand',
  'stock_received_not_billed',
  'stock_adjustment',
  'cost_of_goods',
  'fixed_assets',
  'accumulated_depreciation',
  'depreciation_expense',
  'capital_wip',
  'asset_disposal',
  'round_off',
  'exchange_gain_loss',
  'retained_surplus',
  'opening_balance',
  'tds_payable',
  'tds_receivable',
  'gst_input',
  'gst_output',
  'sales_income',
  'purchase_expense',
  'bank_charges',
  'other_income',
] as const

export type AccountPurpose = (typeof accountPurposes)[number]

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))

export const createAccountSchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(2).max(120),
    type: z.enum(accountTypes),
    purpose: z.enum(accountPurposes).nullish(),
    /** The group it sits under, by code. */
    parentCode: optionalText(20),
    isGroup: z.preprocess(ticked, z.boolean()).default(false),
    subtype: z.enum(accountSubtypes).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    cashFlow: z.enum(['operating', 'investing', 'financing']).optional(),
    description: optionalText(500),
  })
  .meta({ id: 'FinanceCreateAccount' })

export const updateAccountSchema = z
  .object({
    accountId: uuid,
    name: z.string().trim().min(2).max(120).optional(),
    parentCode: optionalText(20),
    subtype: z.enum(accountSubtypes).optional(),
    purpose: z.enum(accountPurposes).nullish(),
    cashFlow: z.enum(['operating', 'investing', 'financing']).optional(),
    description: optionalText(500),
  })
  .meta({ id: 'FinanceUpdateAccount' })

export const archiveAccountSchema = z
  .object({ accountId: uuid, archived: z.preprocess(ticked, z.boolean()) })
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
    /** By id, for the books' own documents, which already hold it. */
    accountId: uuid.optional(),
    debitPaise: paise.default(0),
    creditPaise: paise.default(0),
    costCenter: z.string().trim().max(80).nullish(),
    memo: z.string().trim().max(200).nullish(),
    partyId: uuid.nullish(),
    fundId: uuid.nullish(),
    /** A line in a foreign currency: which, how much of it, and at what rate. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish(),
    amountFc: z.int().min(0).nullish(),
    exchangeRate: z.string().regex(/^\d+(\.\d{1,10})?$/).nullish(),
  })
  .refine((l) => [l.accountCode, l.purpose, l.accountId].filter(Boolean).length === 1, {
    message: 'name the account by code, by purpose or by id -- exactly one',
  })
  .refine((l) => (l.debitPaise > 0) !== (l.creditPaise > 0), {
    message: 'a line is a debit or a credit, and not zero',
  })
  .meta({ id: 'FinanceJournalLine' })

export const postEntrySchema = z
  .object({
    occurredAt: z.coerce.date().optional(),
    /**
     * The day it counts on. A document posts on its own posting date; left
     * out, the database reads occurredAt in the institution's zone.
     */
    postingDate: z.iso.date().optional(),
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

// --- the close and the budget ----------------------------------------------

const year = z.coerce.number().int().min(1900).max(2200)
/** A fiscal year, by the calendar year it starts in: 2026 is 2026-27 for an April year. */
const month = z.coerce.number().int().min(1).max(12)

export const periodsQuerySchema = z
  .object({ year: year.optional() })
  .meta({ id: 'FinancePeriodsQuery' })

export const closePeriodSchema = z
  .object({ year, month, reason: z.string().max(500).trim().optional() })
  .meta({ id: 'FinanceClosePeriod' })

export const reopenPeriodSchema = z
  .object({
    year,
    month,
    /**
     * Mandatory, and it stays on the row. A period reopened silently is worse
     * than one never closed, because the close is what everybody downstream
     * relied on.
     */
    reason: z.string().min(5).max(500).trim(),
  })
  .meta({ id: 'FinanceReopenPeriod' })

export const setBudgetSchema = z
  .object({
    year,
    /** Matched against the cost centre on a journal line. */
    costCenter: z.string().min(1).max(120).trim(),
    accountCode: z.string().min(1).max(24).trim(),
    /** As typed on the form, in rupees. */
    amount: z.string().trim().min(1).max(30).optional(),
    /** Or exactly, in paise, from the API. */
    amountPaise: z.coerce.number().int().min(0).optional(),
    /**
     * Off by default. A budget that blocks a journal entry stops the books
     * matching what actually happened, which is the one thing a ledger must
     * never do -- an institution that wants the block asks for it per line,
     * knowing payroll then fails rather than overspends.
     */
    hardLimit: z.preprocess(ticked, z.boolean()).default(false),
    note: z.string().max(500).trim().optional(),
  })
  .meta({ id: 'FinanceSetBudget' })

export const budgetReportQuerySchema = z
  .object({ year, costCenter: z.string().min(1).max(120).trim().optional() })
  .meta({ id: 'FinanceBudgetReportQuery' })

export const budgetReportSchema = z
  .object({
    year: z.number().int(),
    rows: z.array(
      z.object({
        costCenter: z.string(),
        accountCode: z.string(),
        accountName: z.string(),
        budgetPaise: z.number().int(),
        /** Debits less credits: a credit to an expense account is spending undone. */
        actualPaise: z.number().int(),
        remainingPaise: z.number().int(),
        hardLimit: z.boolean(),
        overspent: z.boolean(),
      }),
    ),
    budgetedPaise: z.number().int(),
    spentPaise: z.number().int(),
    overspentCount: z.number().int(),
  })
  .meta({ id: 'FinanceBudgetReport' })

export type BudgetReport = z.infer<typeof budgetReportSchema>
