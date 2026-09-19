import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { programs, terms } from '@campusos/module-academic/schema'

/**
 * Fees and finance.
 *
 * Every amount is an integer number of paise. Not numeric, not float: numeric
 * is exact in Postgres but arrives in JavaScript as a string that the next line
 * of code turns into a double, which is exactly how the examinations module
 * nearly shipped a grade boundary off by one. Integer minor units remove the
 * question rather than answering it carefully.
 *
 * bigint at mode 'number' is safe to 2^53 paise, about ninety trillion rupees,
 * which is comfortably past any institution's ledger.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

const paise = (name: string) => bigint(name, { mode: 'number' })

export const paymentMethodEnum = pgEnum('fee_payment_method', [
  'cash',
  'cheque',
  'bank_transfer',
  'upi',
  'card',
  'other',
])

// --- what is charged -------------------------------------------------------

/**
 * One chargeable line, per programme and term. There is no separate "fee
 * structure" wrapper: the structure for BTech-CSE in term 1 simply *is* the set
 * of rows matching that pair, and a wrapper would add a join and a second
 * source of truth about which structure is live.
 */
export const feeItems = pgTable(
  'fee_items',
  {
    id: pk(),
    institutionId: tenantId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    amountPaise: paise('amount_paise').notNull(),
    dueOn: timestamp('due_on', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_items_identity').on(t.programId, t.termId, t.label),
    index('fee_items_term').on(t.termId),
    check('fee_items_amount', sql`amount_paise > 0`),
    tenantPolicy('fee_items'),
  ],
)

// --- what is forgiven ------------------------------------------------------

/**
 * A scholarship or waiver against one charged line for one student. One row per
 * student and item, so a change is an audited revision of the same row rather
 * than a second waiver quietly stacking on the first.
 *
 * The reason is mandatory in the column, in the schema, and in the audit row.
 */
export const feeWaivers = pgTable(
  'fee_waivers',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feeItemId: uuid('fee_item_id')
      .notNull()
      .references(() => feeItems.id, { onDelete: 'cascade' }),
    amountPaise: paise('amount_paise').notNull(),
    reason: text().notNull(),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * How much of this waiver the books have already been told about, and how
     * many times they have been told. A waiver granted before the invoice is
     * issued rides along in the invoice entry; one granted or revised after it
     * posts the difference. Keeping the posted figure on the row is what makes
     * that difference arithmetic rather than a guess, and the counter is what
     * gives each posting a source reference of its own.
     */
    postedPaise: paise('posted_paise').notNull().default(0),
    postings: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_waivers_once').on(t.studentId, t.feeItemId),
    index('fee_waivers_student').on(t.studentId),
    check('fee_waivers_amount', sql`amount_paise > 0`),
    check('fee_waivers_reason', sql`length(trim(reason)) >= 5`),
    tenantPolicy('fee_waivers'),
  ],
)

// --- what is paid ----------------------------------------------------------

/**
 * A payment against a term, not against a line: students pay a lump sum and
 * the institution allocates it. Allocating per line would invent a decision
 * nobody made at the counter.
 *
 * Recording and reconciling are separate acts. A recorded payment is a claim
 * that money arrived; a reconciled one has been matched against the bank. The
 * dues report counts both but shows them apart, because an unreconciled cheque
 * is not the same asset as cleared funds.
 */
export const feePayments = pgTable(
  'fee_payments',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    amountPaise: paise('amount_paise').notNull(),
    method: paymentMethodEnum().notNull(),
    /** Cheque number, UTR, UPI reference. Free text because reality is. */
    reference: text(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    /** Human-readable receipt number, unique per institution. */
    receiptNo: text('receipt_no').notNull(),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    reconciledBy: text('reconciled_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_payments_receipt').on(t.institutionId, t.receiptNo),
    index('fee_payments_student').on(t.studentId),
    index('fee_payments_term').on(t.termId),
    check('fee_payments_amount', sql`amount_paise > 0`),
    tenantPolicy('fee_payments'),
  ],
)

/**
 * Per-institution receipt numbering. A sequence rather than counting rows,
 * because two clerks taking money at once must not be handed the same number.
 */
export const receiptCounters = pgTable(
  'fee_receipt_counters',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    prefix: text().notNull().default('R'),
    next: bigint({ mode: 'number' }).notNull().default(1),
  },
  () => [tenantPolicy('fee_receipt_counters')],
)

// --- what is issued --------------------------------------------------------

/**
 * The moment a term's charges become money owed.
 *
 * Until an invoice is issued, a charge is a price list: the student's cohort
 * matches a fee item, so a screen can add it up. Nothing is receivable and
 * nothing belongs in the books. Issuing is the act that turns the list into a
 * debt, and gives it a date the ledger can post against.
 *
 * One row per student and term. `chargedPaise` is what was issued, not what is
 * currently in the price list -- a fee item added afterwards is a supplementary
 * issue, which bumps `version`, updates the snapshot, and posts only the
 * difference.
 */
export const feeInvoices = pgTable(
  'fee_invoices',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    /** Gross charges issued so far, before any waiver. */
    chargedPaise: paise('charged_paise').notNull(),
    /** Incremented by a supplementary issue, so each posting has its own ref. */
    version: integer().notNull().default(1),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    issuedBy: text('issued_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_invoices_once').on(t.studentId, t.termId),
    index('fee_invoices_term').on(t.termId),
    check('fee_invoices_amount', sql`charged_paise > 0`),
    tenantPolicy('fee_invoices'),
  ],
)

// --- what goes back --------------------------------------------------------

/**
 * Money returned to a student, against the payment it came in on.
 *
 * Against the payment rather than against the term, because the refund has to
 * leave by a route the institution can defend: a cash payment refunded by
 * cheque is a different conversation with the auditor, and the payment row is
 * where the method and the reference already live.
 *
 * Never a delete of the payment. The payment happened; so did the refund.
 */
export const feeRefunds = pgTable(
  'fee_refunds',
  {
    id: pk(),
    institutionId: tenantId(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => feePayments.id, { onDelete: 'cascade' }),
    amountPaise: paise('amount_paise').notNull(),
    method: paymentMethodEnum().notNull(),
    reference: text(),
    reason: text().notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }).notNull().defaultNow(),
    refundedBy: text('refunded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('fee_refunds_payment').on(t.paymentId),
    check('fee_refunds_amount', sql`amount_paise > 0`),
    check('fee_refunds_reason', sql`length(trim(reason)) >= 5`),
    tenantPolicy('fee_refunds'),
  ],
)
