import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
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
    /**
     * Whether dropping a course reduces this line. Tuition does; a one-off
     * registration or examination fee does not, and defaulting to false is the
     * safe direction -- refunding nothing is an argument, refunding wrongly is
     * an audit finding.
     */
    proratable: boolean().notNull().default(false),
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

// --- what the institution pays for a student -------------------------------

export const scholarshipKindEnum = pgEnum('fee_scholarship_kind', [
  'merit',
  'need',
  'staff',
  'sport',
  'other',
])

export const awardBasisEnum = pgEnum('fee_award_basis', [
  /** A fixed sum per term. */
  'fixed',
  /** A share of what the student was charged that term. */
  'proportional',
])

/**
 * A scholarship the institution itself funds and defines.
 *
 * Deliberately data rather than code. Every institution's rules are its own,
 * they change between intakes, and a rule compiled into the product is a rule
 * nobody can correct without a release. What the product supplies is the shape:
 * who qualifies, how much, and whether the amount is fixed or a share of the
 * bill.
 *
 * Government and state schemes are not modelled here. Their eligibility is
 * statutory, changes by notification, and getting it subtly wrong produces a
 * number that looks right and is not -- which is worse than not offering it. An
 * institution that administers one records the outcome as an ordinary award
 * with the scheme named on it.
 */
export const scholarships = pgTable(
  'fee_scholarships',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    kind: scholarshipKindEnum().notNull(),
    basis: awardBasisEnum().notNull(),
    /** For a fixed award. Null when the award is proportional. */
    amountPaise: paise('amount_paise'),
    /** For a proportional award: basis points of the term's charges. */
    percentBps: integer('percent_bps'),
    /** Minimum registered credits that term. Zero asks nothing. */
    minCredits: smallint('min_credits').notNull().default(0),
    /** Minimum cumulative average. Null asks nothing. */
    minCgpa: numeric('min_cgpa', { precision: 4, scale: 2 }),
    /** Awards may still be revoked; this only stops new ones. */
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_scholarships_code').on(t.institutionId, t.code),
    check(
      'fee_scholarships_amount',
      sql`(basis = 'fixed' and amount_paise > 0 and percent_bps is null)
          or (basis = 'proportional' and percent_bps between 1 and 10000 and amount_paise is null)`,
    ),
    check('fee_scholarships_credits', sql`min_credits between 0 and 60`),
    tenantPolicy('fee_scholarships'),
  ],
)

export const awardStatusEnum = pgEnum('fee_award_status', ['awarded', 'revoked'])

/**
 * One student, one scholarship, one term.
 *
 * The amount is settled and frozen when the award is made rather than computed
 * on read: a proportional award is a share of what the student was charged that
 * term, and re-deriving it after a supplementary charge would silently change
 * an award somebody was told about in writing.
 *
 * Revoking sets the status and posts the reversal; it never deletes. A student
 * who lost a scholarship and a student who never had one are different facts.
 */
export const scholarshipAwards = pgTable(
  'fee_scholarship_awards',
  {
    id: pk(),
    institutionId: tenantId(),
    scholarshipId: uuid('scholarship_id')
      .notNull()
      .references(() => scholarships.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    amountPaise: paise('amount_paise').notNull(),
    status: awardStatusEnum().notNull().default('awarded'),
    /** What was true when it was granted, kept so the decision can be explained. */
    creditsAtAward: smallint('credits_at_award'),
    cgpaAtAward: numeric('cgpa_at_award', { precision: 4, scale: 2 }),
    reason: text(),
    awardedBy: text('awarded_by').references(() => users.id, { onDelete: 'set null' }),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_scholarship_awards_once').on(t.scholarshipId, t.studentId, t.termId),
    index('fee_scholarship_awards_student').on(t.studentId, t.termId),
    check('fee_scholarship_awards_amount', sql`amount_paise > 0`),
    check(
      'fee_scholarship_awards_revoked',
      sql`(status = 'revoked') = (revoked_reason is not null)`,
    ),
    tenantPolicy('fee_scholarship_awards'),
  ],
)

// --- what comes back when a course is dropped ------------------------------

/**
 * How much of a charge survives a drop, by the date the drop counts from.
 *
 * One row per bracket: "through the 14th, none of it is kept". The last bracket
 * a drop date falls within decides it, and a drop after every bracket keeps the
 * whole charge -- which is the default a term with no rules at all gets, and the
 * safe direction to be wrong in, because refunding nothing is an argument and
 * refunding wrongly is an audit finding.
 */
export const refundRules = pgTable(
  'fee_refund_rules',
  {
    id: pk(),
    institutionId: tenantId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    /** Drops effective on or before this date fall in this bracket. */
    throughOn: date('through_on').notNull(),
    /** Basis points of the proratable charge returned. 10000 is all of it. */
    refundBps: integer('refund_bps').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_refund_rules_bracket').on(t.termId, t.throughOn),
    check('fee_refund_rules_bps', sql`refund_bps between 0 and 10000`),
    tenantPolicy('fee_refund_rules'),
  ],
)

/**
 * The credit a dropped course earned, once, per offering.
 *
 * Unique on the offering so that running the proration again after a second
 * drop credits the new one and not the old one -- the bursar's run is a sweep
 * over a term, and a sweep that double-credits is worse than one nobody runs.
 *
 * Posted as a debit against fee income rather than into the waiver account: the
 * institution is not forgiving a charge, it is not earning revenue for teaching
 * it did not do.
 */
export const dropCredits = pgTable(
  'fee_drop_credits',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    /** The registration this came from, in the enrollment module. */
    offeringId: uuid('offering_id').notNull(),
    creditsDropped: smallint('credits_dropped').notNull(),
    /** The day the drop counted from, which chose the bracket. */
    effectiveOn: date('effective_on').notNull(),
    refundBps: integer('refund_bps').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fee_drop_credits_once').on(t.studentId, t.offeringId),
    index('fee_drop_credits_term').on(t.termId, t.studentId),
    check('fee_drop_credits_amount', sql`amount_paise > 0`),
    tenantPolicy('fee_drop_credits'),
  ],
)
