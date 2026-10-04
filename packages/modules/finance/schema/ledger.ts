import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { tenantPolicy, users } from '@campusos/db'
import { createdAt, currency, paise, pk, rate, tenantId } from './common'

/**
 * The books.
 *
 * Fees and HR both needed somewhere to post, and neither could own it: a ledger
 * that lives inside fees is a ledger payroll cannot reach, and one that lives in
 * the core is accounting an institution carries whether or not it bought any.
 * So it is a module like the others, and the two that post declare it in
 * `dependsOn` -- the same machinery attendance uses to require academic.
 *
 * Amounts are integer paise, for the reason the fees module gives at length:
 * numeric arrives in JavaScript as a string that the next line turns into a
 * double. A ledger that disagrees with itself in the fourth decimal is not a
 * ledger.
 *
 * Entries are append-only. There is no correcting a posted entry, because that
 * is the property that makes a ledger evidence rather than a cache; a mistake
 * is fixed by posting its reverse, which is what an accountant would do on
 * paper and what an auditor expects to find.
 */

export const accountTypeEnum = pgEnum('finance_account_type', [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
])

/**
 * What a module means when it asks for an account, as opposed to what this
 * institution happens to have called it.
 *
 * Fees does not know that tuition income is account 4000 here and 3100 next
 * door; it asks for `fee_income`. A purpose is at most one account per
 * institution, so the mapping is a column rather than a second table with its
 * own screen and its own way of being half-filled.
 */
export const accountPurposeEnum = pgEnum('finance_account_purpose', [
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
  // The books of a business, not only of a fee office (migration 0005).
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
])

/**
 * What kind of account this is, finer than its type: what a report groups it
 * under, what a screen offers it for, and which way it moves cash.
 */
export const accountSubtypes = [
  'cash',
  'bank',
  'receivable',
  'payable',
  'stock',
  'stock_received_not_billed',
  'fixed_asset',
  'accumulated_depreciation',
  'capital_wip',
  'tax',
  'advance',
  'investment',
  'current_asset',
  'current_liability',
  'loan',
  'provision',
  'capital_fund',
  'restricted_fund',
  'retained_surplus',
  'temporary',
  'income',
  'expense',
  'cost_of_goods',
  'depreciation',
  'stock_adjustment',
  'round_off',
  'exchange_gain_loss',
] as const
export type AccountSubtype = (typeof accountSubtypes)[number]

// --- the chart -------------------------------------------------------------

export const accounts = pgTable(
  'finance_accounts',
  {
    id: pk(),
    institutionId: tenantId(),
    /** The institution's own numbering. Text, because 1000-A is a real code. */
    code: text().notNull(),
    name: text().notNull(),
    type: accountTypeEnum().notNull(),
    /** What the posting modules ask for. Null for an account only humans use. */
    purpose: accountPurposeEnum(),
    /** Closed, not deleted: an account with history can never be removed. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    /**
     * The group this sits under. A group carries no postings of its own; its
     * balance is its children's. Same type as its parent, all the way up.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id, { onDelete: 'restrict' }),
    isGroup: boolean('is_group').notNull().default(false),
    subtype: text().$type<AccountSubtype>(),
    /** Kept in a foreign currency: every line on it says how much of that currency. */
    currency: currency('currency'),
    /** Which part of a cash flow statement a movement against this account is. */
    cashFlow: text('cash_flow').$type<'operating' | 'investing' | 'financing'>(),
    description: text(),
  },
  (t) => [
    uniqueIndex('finance_accounts_code').on(t.institutionId, t.code),
    index('finance_accounts_parent').on(t.parentId),
    uniqueIndex('finance_accounts_purpose')
      .on(t.institutionId, t.purpose)
      .where(sql`purpose is not null`),
    check('finance_accounts_code_present', sql`length(trim(code)) > 0`),
    tenantPolicy('finance_accounts'),
  ],
)

// --- the journal -----------------------------------------------------------

/**
 * One event, in the books. `sourceModule` and `sourceRef` are what make posting
 * idempotent: a payment posts under `payment:<id>` and a retry after a dropped
 * connection collides with the unique index instead of doubling the revenue.
 */
export const entries = pgTable(
  'finance_journal_entries',
  {
    id: pk(),
    institutionId: tenantId(),
    /** When it happened, which is not when it was typed in. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The day it counts on, in the institution's own zone. Set by the database
     * from occurredAt when a poster does not say; what periods, fiscal years
     * and every dated report read.
     */
    postingDate: date('posting_date'),
    memo: text().notNull(),
    /** Which module posted it. 'manual' for something a human typed. */
    sourceModule: text('source_module').notNull(),
    /** That module's own reference, unique within it. */
    sourceRef: text('source_ref').notNull(),
    /** Set on the entry that reverses another. The correction trail. */
    reversalOf: uuid('reversal_of'),
    postedBy: text('posted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    // tx_id (xid8, default pg_current_xact_id()) exists in the database only:
    // the lines trigger compares it, and nothing here ever reads it.
  },
  (t) => [
    uniqueIndex('finance_entries_source').on(t.institutionId, t.sourceModule, t.sourceRef),
    index('finance_entries_occurred').on(t.institutionId, t.occurredAt),
    check('finance_entries_memo', sql`length(trim(memo)) > 0`),
    tenantPolicy('finance_journal_entries'),
  ],
)

/**
 * One side of one entry.
 *
 * A line is a debit or a credit, never both and never neither -- storing a
 * signed amount instead would make "which way does positive go" a question
 * every reader has to re-answer, and readers get it wrong.
 *
 * That the two sides of an entry agree is checked at commit by a deferred
 * constraint trigger, not here: no row-level check can see its siblings, and
 * the lines are necessarily inserted one at a time.
 */
export const lines = pgTable(
  'finance_journal_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    debitPaise: paise('debit_paise').notNull().default(0),
    creditPaise: paise('credit_paise').notNull().default(0),
    /** A department, a hostel block, a grant. Free text: institutions differ. */
    costCenter: text('cost_center'),
    memo: text(),
    /** Whose balance this line moves, on a receivable or payable account. */
    partyId: uuid('party_id'),
    /** The fund it belongs to, for books kept by fund. */
    fundId: uuid('fund_id'),
    /** A line in a foreign currency: how much of it, and at what rate. */
    currency: currency('currency'),
    amountFc: paise('amount_fc'),
    exchangeRate: rate('exchange_rate'),
  },
  (t) => [
    index('finance_lines_entry').on(t.entryId),
    index('finance_lines_account').on(t.accountId),
    index('finance_lines_party').on(t.partyId),
    index('finance_lines_fund').on(t.fundId),
    check(
      'finance_lines_fc',
      sql`(currency is null) = (amount_fc is null) and (currency is null) = (exchange_rate is null)`,
    ),
    check(
      'finance_lines_one_side',
      sql`debit_paise >= 0 and credit_paise >= 0 and (debit_paise = 0) <> (credit_paise = 0)`,
    ),
    tenantPolicy('finance_journal_lines'),
  ],
)

// --- the close -------------------------------------------------------------

export const periodStatusEnum = pgEnum('finance_period_status', ['open', 'closed'])

/**
 * An accounting month, and whether it is still open.
 *
 * A month with no row here is open: a ledger that refused to post until
 * somebody had pre-created every month would be a ledger nobody could start
 * using. Closing is the deliberate act -- the month has been reconciled, the
 * numbers have been reported, and nothing may land in it afterwards.
 *
 * The rule is kept by a trigger on the journal rather than by the operation
 * that posts, because every module in the product posts, and a closed month
 * that only some code paths respect is not closed.
 */
export const periods = pgTable(
  'finance_periods',
  {
    id: pk(),
    institutionId: tenantId(),
    year: smallint().notNull(),
    /** 1-12. An accounting month, whatever month the financial year starts in. */
    month: smallint().notNull(),
    status: periodStatusEnum().notNull().default('open'),
    closedBy: text('closed_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Why it was opened again, which is the interesting half of the trail. */
    reopenedReason: text('reopened_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_periods_month').on(t.institutionId, t.year, t.month),
    check('finance_periods_year', sql`year between 1900 and 2200`),
    check('finance_periods_month', sql`month between 1 and 12`),
    check('finance_periods_closed', sql`(status = 'closed') = (closed_at is not null)`),
    tenantPolicy('finance_periods'),
  ],
)

// --- budgets ---------------------------------------------------------------

/**
 * What a cost centre was given for the year, on one account.
 *
 * Per year rather than per month because that is how a department is funded and
 * how it argues about the number. Actual spend is summed from the journal on
 * the same pair, so the comparison needs no second set of figures to keep in
 * step.
 *
 * `hardLimit` is off by default and deliberately so. A budget that blocks a
 * journal entry stops the books matching what actually happened, which is the
 * one thing a ledger must never do; an institution that wants the block can ask
 * for it per line, knowing that payroll then fails rather than overspends.
 */
export const budgets = pgTable(
  'finance_budgets',
  {
    id: pk(),
    institutionId: tenantId(),
    year: smallint().notNull(),
    /** Matched against the cost centre on a journal line. */
    costCenter: text('cost_center').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    amountPaise: paise('amount_paise').notNull(),
    hardLimit: boolean('hard_limit').notNull().default(false),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_budgets_line').on(t.institutionId, t.year, t.costCenter, t.accountId),
    check('finance_budgets_year', sql`year between 1900 and 2200`),
    check('finance_budgets_amount', sql`amount_paise >= 0`),
    tenantPolicy('finance_budgets'),
  ],
)
