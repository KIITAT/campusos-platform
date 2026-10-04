import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { createdAt, paise, pk, rate, tenantId } from './common'
import { entries } from './ledger'

/**
 * What the books need to know about the institution keeping them.
 *
 * One row per institution, and a missing row means the defaults: an Indian
 * college keeping rupees from April to March. Everything here is the
 * institution's to say, because it differs between them -- which is the point
 * of one product serving many.
 */
export const settings = pgTable(
  'finance_settings',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    baseCurrency: text('base_currency').notNull().default('INR'),
    /** 4 for April-March. A fiscal year is named for the calendar year it starts in. */
    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(4),
    /** The zone a moment is read in to say which day -- and so which month and year -- it fell on. */
    timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
    legalName: text('legal_name'),
    address: text(),
    /** GST registration, when the institution has one: what decides intra- or inter-state supply. */
    gstin: text(),
    /** The two-digit GST state code the institution supplies from. */
    stateCode: text('state_code'),
    pan: text(),
    tan: text(),
    /** Invoice totals rounded to a whole currency unit, the difference posted apart. */
    roundInvoices: boolean('round_invoices').notNull().default(true),
    stockValuation: text('stock_valuation')
      .$type<'moving_average' | 'fifo'>()
      .notNull()
      .default('moving_average'),
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
    /** How far past the ordered quantity a receipt may go, in hundredths of a percent. */
    overReceiptBp: integer('over_receipt_bp').notNull().default(0),
    /** Refuse issuing a batch past its expiry. */
    blockExpiredBatches: boolean('block_expired_batches').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('finance_settings_currency', sql`base_currency ~ '^[A-Z]{3}$'`),
    check('finance_settings_fy_month', sql`fiscal_year_start_month between 1 and 12`),
    check(
      'finance_settings_gstin',
      sql`gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'`,
    ),
    check('finance_settings_state', sql`state_code is null or state_code ~ '^[0-9]{2}$'`),
    check('finance_settings_pan', sql`pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`),
    check('finance_settings_over_receipt', sql`over_receipt_bp between 0 and 10000`),
    tenantPolicy('finance_settings'),
  ],
)

/**
 * A fiscal year, and whether it has been closed.
 *
 * Created the first time anything is dated inside it, from the institution's
 * start month, so nobody has to remember to open next year in March. Two years
 * never overlap -- the database refuses it. Closing one posts the year's
 * surplus or deficit to retained surplus and shuts every month in it.
 */
export const fiscalYears = pgTable(
  'finance_fiscal_years',
  {
    id: pk(),
    institutionId: tenantId(),
    /** "2026-27". */
    label: text().notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text().$type<'open' | 'closed'>().notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by').references(() => users.id, { onDelete: 'set null' }),
    /** The entry that carried income and expense to retained surplus. */
    closingEntryId: uuid('closing_entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    reopenedReason: text('reopened_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_fiscal_years_label').on(t.institutionId, t.label),
    check('finance_fiscal_years_order', sql`ends_on > starts_on and ends_on - starts_on < 550`),
    check('finance_fiscal_years_status', sql`status in ('open', 'closed')`),
    check('finance_fiscal_years_closed', sql`(status = 'closed') = (closed_at is not null)`),
    tenantPolicy('finance_fiscal_years'),
  ],
)

/**
 * The departments, blocks and activities that spend. A journal line names one
 * by code; this is the list those codes come from, in a tree, so a report can
 * roll the chemistry lab up into the science faculty.
 */
export const costCenters = pgTable(
  'finance_cost_centers',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => costCenters.id, {
      onDelete: 'restrict',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_cost_centers_code').on(t.institutionId, t.code),
    check('finance_cost_centers_code_text', sql`length(trim(code)) > 0`),
    tenantPolicy('finance_cost_centers'),
  ],
)

/**
 * A fund: money given for a purpose and accounted for apart.
 *
 * A UGC grant, a research project's sanction, an endowment whose income funds
 * a prize. A line tagged with a fund is that fund's; the fund statement and
 * the utilisation certificate are sums over those lines, never figures kept
 * beside them.
 */
export const funds = pgTable(
  'finance_funds',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    kind: text().$type<'unrestricted' | 'restricted' | 'endowment' | 'grant'>().notNull(),
    grantor: text(),
    sanctionRef: text('sanction_ref'),
    sanctionedPaise: paise('sanctioned_paise'),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    note: text(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_funds_code').on(t.institutionId, t.code),
    check('finance_funds_kind', sql`kind in ('unrestricted', 'restricted', 'endowment', 'grant')`),
    check('finance_funds_dates', sql`ends_on is null or starts_on is null or ends_on >= starts_on`),
    check('finance_funds_sanction', sql`sanctioned_paise is null or sanctioned_paise >= 0`),
    tenantPolicy('finance_funds'),
  ],
)

/** A currency the institution deals in besides its own. */
export const currencies = pgTable(
  'finance_currencies',
  {
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    symbol: text(),
    /** Digits after the point: 2 for most, 0 for yen, 3 for dinar. */
    minorUnits: smallint('minor_units').notNull().default(2),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.institutionId, t.code] }),
    check('finance_currencies_code', sql`code ~ '^[A-Z]{3}$'`),
    check('finance_currencies_minor', sql`minor_units between 0 and 4`),
    tenantPolicy('finance_currencies'),
  ],
)

/**
 * What one unit of a currency was worth in the base currency on a day.
 *
 * Typed in by the accounts office or imported from a file it chose: CampusOS
 * fetches nothing from anywhere, so a rate is always somebody's figure, and the
 * books say whose.
 */
export const exchangeRates = pgTable(
  'finance_exchange_rates',
  {
    id: pk(),
    institutionId: tenantId(),
    currency: text().notNull(),
    on: date('on').notNull(),
    rate: rate('rate').notNull(),
    source: text(),
    enteredBy: text('entered_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_exchange_rates_day').on(t.institutionId, t.currency, t.on),
    check('finance_exchange_rates_positive', sql`rate > 0`),
    tenantPolicy('finance_exchange_rates'),
  ],
)

/**
 * How documents are numbered: a prefix per kind of document, and a counter per
 * fiscal year.
 *
 * A number is given when a document is submitted, never to a draft -- a tax
 * invoice series must have no gaps, and drafts are deleted. The counter row is
 * locked while the number is taken, the way receipts already are (decision 31).
 */
export const series = pgTable(
  'finance_series',
  {
    institutionId: tenantId(),
    docType: text('doc_type').notNull(),
    /** `{FY}` becomes the fiscal year's label: `SINV/{FY}/` gives SINV/2026-27/0001. */
    prefix: text().notNull(),
    padding: smallint().notNull().default(4),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.institutionId, t.docType] }),
    check('finance_series_padding', sql`padding between 1 and 10`),
    check('finance_series_prefix', sql`length(prefix) between 1 and 40`),
    tenantPolicy('finance_series'),
  ],
)

export const seriesCounters = pgTable(
  'finance_series_counters',
  {
    institutionId: tenantId(),
    docType: text('doc_type').notNull(),
    /** The fiscal year's label. */
    scope: text().notNull(),
    lastValue: integer('last_value').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.institutionId, t.docType, t.scope] }),
    check('finance_series_counters_positive', sql`last_value >= 0`),
    tenantPolicy('finance_series_counters'),
  ],
)

/**
 * Above what amount a kind of document needs somebody's approval before it is
 * submitted, and whose.
 */
export const approvalRules = pgTable(
  'finance_approval_rules',
  {
    id: pk(),
    institutionId: tenantId(),
    docType: text('doc_type').notNull(),
    minAmountPaise: paise('min_amount_paise').notNull(),
    /** A role, or the capability `approver` named on the staff list. */
    approver: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_approval_rules_step').on(t.institutionId, t.docType, t.minAmountPaise),
    check('finance_approval_rules_amount', sql`min_amount_paise >= 0`),
    tenantPolicy('finance_approval_rules'),
  ],
)

/**
 * An approval, or a refusal, of a draft as it stood.
 *
 * The fingerprint is a hash of what was approved. A draft changed afterwards
 * no longer matches it, so the approval lapses by itself -- nobody approves a
 * purchase order for one thing and finds another submitted under their name.
 * Kept forever; never edited.
 */
export const approvals = pgTable(
  'finance_approvals',
  {
    id: pk(),
    institutionId: tenantId(),
    docType: text('doc_type').notNull(),
    docId: uuid('doc_id').notNull(),
    fingerprint: text().notNull(),
    decision: text().$type<'approved' | 'rejected'>().notNull(),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('finance_approvals_doc').on(t.docType, t.docId),
    check('finance_approvals_decision', sql`decision in ('approved', 'rejected')`),
    check(
      'finance_approvals_reason',
      sql`decision = 'approved' or length(trim(coalesce(note, ''))) >= 3`,
    ),
    tenantPolicy('finance_approvals'),
  ],
)

/**
 * Members of staff the books give a job to: who keeps a store, who buys, who
 * approves. A role says what somebody is; this says what the accounts office
 * has trusted them with, the way placement names its officers.
 */
export const staff = pgTable(
  'finance_staff',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capability: text().$type<'storekeeper' | 'purchaser' | 'approver'>().notNull(),
    /** A storekeeper's store; null for every store. */
    warehouseId: uuid('warehouse_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_staff_once').on(t.institutionId, t.userId, t.capability),
    check('finance_staff_capability', sql`capability in ('storekeeper', 'purchaser', 'approver')`),
    tenantPolicy('finance_staff'),
  ],
)

