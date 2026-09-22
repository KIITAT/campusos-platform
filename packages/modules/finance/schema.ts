import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

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

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

const paise = (name: string) => bigint(name, { mode: 'number' })

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
])

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
  },
  (t) => [
    uniqueIndex('finance_accounts_code').on(t.institutionId, t.code),
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
    memo: text().notNull(),
    /** Which module posted it. 'manual' for something a human typed. */
    sourceModule: text('source_module').notNull(),
    /** That module's own reference, unique within it. */
    sourceRef: text('source_ref').notNull(),
    /** Set on the entry that reverses another. The correction trail. */
    reversalOf: uuid('reversal_of'),
    postedBy: text('posted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
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
  },
  (t) => [
    index('finance_lines_entry').on(t.entryId),
    index('finance_lines_account').on(t.accountId),
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
