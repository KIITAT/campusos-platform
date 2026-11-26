import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

/**
 * Library.
 *
 * Two levels, deliberately: a title is the work, a copy is the physical object
 * on the shelf. A loan is against a copy, never a title -- "who has the third
 * copy of Sipser" is the question a librarian actually asks, and a single table
 * with a `copies: integer` column cannot answer it.
 *
 * Fines are integer paise, from @campusos/money, for the same reason fees are.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

const paise = (name: string) => bigint(name, { mode: 'number' })

export const copyStatusEnum = pgEnum('library_copy_status', [
  'available',
  'on_loan',
  'lost',
  'withdrawn',
])

// --- catalogue -------------------------------------------------------------

/**
 * A work. ISBN is optional because a college library holds plenty that predates
 * it, and unique only when present -- a partial unique index, so the fiftieth
 * untitled bound thesis does not collide with the forty-ninth.
 */
export const titles = pgTable(
  'library_titles',
  {
    id: pk(),
    institutionId: tenantId(),
    isbn: text(),
    title: text().notNull(),
    author: text().notNull(),
    titleKey: text('title_key').generatedAlwaysAs(sql`lower(title)`),
    authorKey: text('author_key').generatedAlwaysAs(sql`lower(author)`),
    publisher: text(),
    year: smallint(),
    category: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('library_titles_isbn')
      .on(t.institutionId, t.isbn)
      .where(sql`isbn is not null`),
    index('library_titles_search').on(t.institutionId, t.title),
    // Record search (P1-09c, 0004): a title or author found ignoring case, one tenant at a time.
    index('library_titles_title_key').on(t.institutionId, t.titleKey),
    index('library_titles_author_key').on(t.institutionId, t.authorKey),
    check('library_titles_title', sql`length(trim(title)) > 0`),
    check(
      'library_titles_year',
      sql`year is null or (year between 1400 and 2200)`,
    ),
    tenantPolicy('library_titles'),
  ],
)

/**
 * A physical object. The accession number is what is stamped inside the cover
 * and what the desk scans, so it is unique per institution and the barcode the
 * issue workflow keys on.
 *
 * `status` is denormalised from the loan history on purpose: the desk asks "is
 * this on the shelf" thousands of times a day and should not compute it from an
 * open-ended loan table each time. A trigger keeps it honest.
 */
export const copies = pgTable(
  'library_copies',
  {
    id: pk(),
    institutionId: tenantId(),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    accessionNo: text('accession_no').notNull(),
    status: copyStatusEnum().notNull().default('available'),
    shelf: text(),
    /** What it would cost to replace. Caps the fine; see the rules module. */
    replacementPaise: paise('replacement_paise'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('library_copies_accession').on(t.institutionId, t.accessionNo),
    index('library_copies_title').on(t.titleId),
    index('library_copies_status').on(t.institutionId, t.status),
    check('library_copies_accession_shape', sql`length(trim(accession_no)) > 0`),
    check(
      'library_copies_replacement',
      sql`replacement_paise is null or replacement_paise > 0`,
    ),
    tenantPolicy('library_copies'),
  ],
)

// --- circulation -----------------------------------------------------------

/**
 * A loan. Open while `returned_at` is null, and a copy can have at most one
 * open loan -- a partial unique index, so a second issue of the same physical
 * book is refused by Postgres rather than by whichever code path checked first.
 *
 * The fine is stored on return rather than computed on read: it is what the
 * borrower was actually told to pay, and the rules may change next term.
 */
export const loans = pgTable(
  'library_loans',
  {
    id: pk(),
    institutionId: tenantId(),
    copyId: uuid('copy_id')
      .notNull()
      .references(() => copies.id, { onDelete: 'cascade' }),
    borrowerId: text('borrower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'no action' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueOn: timestamp('due_on', { withTimezone: true }).notNull(),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    /** Renewals so far. Capped by settings, so a book cannot be held forever. */
    renewals: smallint().notNull().default(0),
    finePaise: paise('fine_paise').notNull().default(0),
    fineWaivedPaise: paise('fine_waived_paise').notNull().default(0),
    fineWaiverReason: text('fine_waiver_reason'),
    finePaidAt: timestamp('fine_paid_at', { withTimezone: true }),
    /** How the fine was settled: cash, upi, bank_transfer or fee_account (ACC-27). */
    fineSettledBy: text('fine_settled_by'),
    issuedBy: text('issued_by').references(() => users.id, { onDelete: 'set null' }),
    returnedBy: text('returned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('library_loans_one_open')
      .on(t.copyId)
      .where(sql`returned_at is null`),
    index('library_loans_borrower').on(t.borrowerId, t.returnedAt),
    index('library_loans_due').on(t.institutionId, t.dueOn),
    check('library_loans_dates', sql`due_on > issued_at`),
    check(
      'library_loans_returned_after_issue',
      sql`returned_at is null or returned_at >= issued_at`,
    ),
    check('library_loans_fine', sql`fine_paise >= 0 and fine_waived_paise >= 0`),
    check(
      'library_loans_waiver_within_fine',
      sql`fine_waived_paise <= fine_paise`,
    ),
    check('library_loans_renewals', sql`renewals >= 0`),
    check(
      'library_loans_settled_by',
      sql`fine_settled_by is null or fine_settled_by in ('cash', 'upi', 'bank_transfer', 'fee_account')`,
    ),
    check('library_loans_settled_by_paid', sql`fine_settled_by is null or fine_paid_at is not null`),
    tenantPolicy('library_loans'),
  ],
)

/**
 * One row per institution. Defaults are the ones a small college would pick,
 * so the module works the moment it is enabled and the librarian tunes it later
 * rather than being blocked by a settings form on day one.
 */
export const settings = pgTable(
  'library_settings',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    loanDays: smallint('loan_days').notNull().default(14),
    /** Days after the due date before a fine starts accruing. */
    graceDays: smallint('grace_days').notNull().default(0),
    finePerDayPaise: paise('fine_per_day_paise').notNull().default(100),
    maxConcurrentLoans: smallint('max_concurrent_loans').notNull().default(3),
    maxRenewals: smallint('max_renewals').notNull().default(1),
    /** Absolute ceiling on one loan's fine. Null means the copy's value caps it. */
    maxFinePaise: paise('max_fine_paise'),
    /** Owing more than this blocks further borrowing. Zero means never block. */
    blockAtOutstandingPaise: paise('block_at_outstanding_paise').notNull().default(0),
    /** Door hours (local time): the door scan is refused outside them (P2-22a, D1331, D1332). */
    opensAt: time('opens_at').notNull().default('09:00'),
    closesAt: time('closes_at').notNull().default('20:00'),
    closingReminderMin: smallint('closing_reminder_min').notNull().default(15),
    autoCloseAfterMin: smallint('auto_close_after_min').notNull().default(30),
    presenceRetentionDays: smallint('presence_retention_days').notNull().default(90),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('library_settings_loan_days', sql`loan_days between 1 and 365`),
    check('library_settings_grace', sql`grace_days between 0 and 90`),
    check('library_settings_fine', sql`fine_per_day_paise >= 0`),
    check('library_settings_max_fine', sql`max_fine_paise is null or max_fine_paise > 0`),
    check('library_settings_limits', sql`max_concurrent_loans between 1 and 50`),
    check('library_settings_renewals', sql`max_renewals between 0 and 20`),
    check('library_settings_block', sql`block_at_outstanding_paise >= 0`),
    check('library_settings_hours', sql`closes_at > opens_at`),
    check('library_settings_reminder', sql`closing_reminder_min between 5 and 120`),
    check('library_settings_auto_close', sql`auto_close_after_min between 0 and 240`),
    check('library_settings_presence_retention', sql`presence_retention_days between 30 and 730`),
    tenantPolicy('library_settings'),
  ],
)

/**
 * Who is inside the library (P2-22a). One open session per student, by a partial
 * unique index; the hostel reads the open ones at query time and the events
 * below as history.
 */
export const sessions = pgTable(
  'library_sessions',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    entryMethod: text('entry_method').notNull(),
    exitMethod: text('exit_method'),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    exitRecordedBy: text('exit_recorded_by').references(() => users.id, { onDelete: 'set null' }),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    unconfirmedReportedAt: timestamp('unconfirmed_reported_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('library_sessions_one_open')
      .on(t.studentId)
      .where(sql`exited_at is null`),
    index('library_sessions_open')
      .on(t.institutionId)
      .where(sql`exited_at is null`),
    index('library_sessions_student').on(t.studentId, t.enteredAt.desc()),
    check('library_sessions_entry_method', sql`entry_method in ('door_qr', 'desk')`),
    check('library_sessions_exit_method', sql`exit_method in ('door_qr', 'desk', 'auto_close')`),
    check('library_sessions_closed_together', sql`(exited_at is null) = (exit_method is null)`),
    check('library_sessions_order', sql`exited_at is null or exited_at >= entered_at`),
    tenantPolicy('library_sessions'),
  ],
)

/** The outbox the hostel polls by cursor (D1334): the id is an identity, so it orders by commit. */
export const events = pgTable(
  'library_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    institutionId: tenantId(),
    kind: text().notNull(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    at: timestamp({ withTimezone: true }).notNull(),
    method: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('library_events_feed').on(t.institutionId, t.id),
    check('library_events_kind', sql`kind in ('session_started', 'session_ended', 'session_unconfirmed')`),
    tenantPolicy('library_events'),
  ],
)

export type Title = typeof titles.$inferSelect
export type Copy = typeof copies.$inferSelect
export type Loan = typeof loans.$inferSelect
export type LibrarySettings = typeof settings.$inferSelect
