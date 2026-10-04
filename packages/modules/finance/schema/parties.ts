import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantPolicy } from '@campusos/db'
import { createdAt, paise, pk, tenantId } from './common'
import { accounts } from './ledger'

/**
 * Somebody the institution buys from or sells to.
 *
 * One table for both, because the canteen contractor who rents the kitchen and
 * also supplies the hostel mess is one party with two balances, and two
 * records of them is how a payment lands against the wrong one. Students are
 * not parties: their account is the fee ledger, which already posts here.
 */
export const parties = pgTable(
  'finance_parties',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    isCustomer: boolean('is_customer').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),
    gstin: text(),
    pan: text(),
    /** GST state code, from the GSTIN where there is one. */
    stateCode: text('state_code'),
    /** registered, unregistered, composition, sez, overseas. */
    gstCategory: text('gst_category').notNull().default('unregistered'),
    address: text(),
    email: text(),
    phone: text(),
    /** Null means the base currency. */
    currency: text(),
    paymentTermsDays: integer('payment_terms_days').notNull().default(0),
    creditLimitPaise: paise('credit_limit_paise'),
    /** Overrides of the default receivable and payable accounts, rarely needed. */
    receivableAccountId: uuid('receivable_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    payableAccountId: uuid('payable_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** The TDS section a payment to this supplier usually falls under. */
    tdsSectionId: uuid('tds_section_id'),
    /** A micro or small enterprise: paid within 45 days, and reported when not. */
    msme: boolean().notNull().default(false),
    msmeNumber: text('msme_number'),
    bankName: text('bank_name'),
    bankAccount: text('bank_account'),
    ifsc: text(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_parties_code').on(t.institutionId, t.code),
    index('finance_parties_name').on(t.institutionId, t.name),
    check('finance_parties_role', sql`is_customer or is_supplier`),
    check('finance_parties_name_text', sql`length(trim(name)) > 0`),
    check(
      'finance_parties_gstin',
      sql`gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'`,
    ),
    check('finance_parties_pan', sql`pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`),
    check('finance_parties_state', sql`state_code is null or state_code ~ '^[0-9]{2}$'`),
    check(
      'finance_parties_gst_category',
      sql`gst_category in ('registered', 'unregistered', 'composition', 'sez', 'overseas')`,
    ),
    check('finance_parties_registered', sql`gst_category <> 'registered' or gstin is not null`),
    check('finance_parties_currency', sql`currency is null or currency ~ '^[A-Z]{3}$'`),
    check('finance_parties_terms', sql`payment_terms_days between 0 and 3650`),
    check('finance_parties_ifsc', sql`ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'`),
    tenantPolicy('finance_parties'),
  ],
)

/**
 * A tax, as the institution charges or pays it: "GST 18%", "GST exempt".
 *
 * Its components are what land in the books -- CGST and SGST inside the state,
 * IGST across it. Rates are the institution's to enter (decision 116); an
 * optional starter set can be loaded and then edited, and the screen says how
 * old it is.
 */
export const taxTemplates = pgTable(
  'finance_tax_templates',
  {
    id: pk(),
    institutionId: tenantId(),
    name: text().notNull(),
    kind: text().$type<'gst' | 'other'>().notNull().default('gst'),
    /** For a GST template: exempt, nil-rated and non-GST supplies are reported apart. */
    treatment: text()
      .$type<'taxable' | 'exempt' | 'nil_rated' | 'non_gst'>()
      .notNull()
      .default('taxable'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_tax_templates_name').on(t.institutionId, t.name),
    check('finance_tax_templates_kind', sql`kind in ('gst', 'other')`),
    check(
      'finance_tax_templates_treatment',
      sql`treatment in ('taxable', 'exempt', 'nil_rated', 'non_gst')`,
    ),
    tenantPolicy('finance_tax_templates'),
  ],
)

export const taxComponents = pgTable(
  'finance_tax_components',
  {
    id: pk(),
    institutionId: tenantId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => taxTemplates.id, { onDelete: 'cascade' }),
    /** cgst, sgst, utgst, igst, cess, other. */
    component: text().notNull(),
    /** Inside the state, across it, or either. */
    applies: text().$type<'intra' | 'inter' | 'always'>().notNull().default('always'),
    /** Hundredths of a percent: 900 is 9%. */
    rateBp: integer('rate_bp').notNull(),
    /** Where tax charged on a sale is owed. */
    outputAccountId: uuid('output_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Where tax paid on a purchase is claimed. */
    inputAccountId: uuid('input_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    index('finance_tax_components_template').on(t.templateId),
    check(
      'finance_tax_components_component',
      sql`component in ('cgst', 'sgst', 'utgst', 'igst', 'cess', 'other')`,
    ),
    check('finance_tax_components_applies', sql`applies in ('intra', 'inter', 'always')`),
    check('finance_tax_components_rate', sql`rate_bp between 0 and 10000`),
    tenantPolicy('finance_tax_components'),
  ],
)

/**
 * A kind of payment tax is deducted from at source, and how much.
 *
 * The rate when the payee has given a PAN, the higher rate when they have not,
 * and the thresholds below which nothing is deducted -- for one bill, and for
 * the year with that payee. All the institution's figures.
 */
export const tdsSections = pgTable(
  'finance_tds_sections',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    rateBp: integer('rate_bp').notNull(),
    rateNoPanBp: integer('rate_no_pan_bp').notNull(),
    thresholdSinglePaise: paise('threshold_single_paise').notNull().default(0),
    thresholdAnnualPaise: paise('threshold_annual_paise').notNull().default(0),
    payableAccountId: uuid('payable_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_tds_sections_code').on(t.institutionId, t.code),
    check('finance_tds_sections_rate', sql`rate_bp between 0 and 10000 and rate_no_pan_bp between 0 and 10000`),
    check(
      'finance_tds_sections_thresholds',
      sql`threshold_single_paise >= 0 and threshold_annual_paise >= 0`,
    ),
    tenantPolicy('finance_tds_sections'),
  ],
)
