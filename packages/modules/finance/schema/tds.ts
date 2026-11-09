import { sql } from 'drizzle-orm'
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy } from '@campusos/db'
import { createdAt, paise, pk, tenantId } from './common'
import { invoices, payments } from './documents'
import { accounts, entries } from './ledger'

/**
 * TDS deposited with the government (P1-05b, ACC-31). A challan deposits the
 * tax deducted in one month under one return form (26Q for residents, 27Q for
 * non-residents); its links name each bill or payment it covers, so a
 * certificate statement can quote the challan of every deduction. No person
 * column: the audit log says who recorded or voided it.
 */
export const tdsChallans = pgTable(
  'finance_tds_challans',
  {
    id: pk(),
    institutionId: tenantId(),
    form: text().$type<'26Q' | '27Q'>().notNull(),
    /** The first day of the month whose deductions this deposits. */
    month: date().notNull(),
    depositedOn: date('deposited_on').notNull(),
    bsrCode: text('bsr_code').notNull(),
    challanSerial: text('challan_serial').notNull(),
    tdsPaise: paise('tds_paise').notNull(),
    interestPaise: paise('interest_paise').notNull().default(0),
    feePaise: paise('fee_paise').notNull().default(0),
    /** The bank or cash account it was paid from. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_tds_challans_live')
      .on(t.institutionId, t.bsrCode, t.depositedOn, t.challanSerial)
      .where(sql`voided_at is null`),
    check('finance_tds_challans_form', sql`form in ('26Q', '27Q')`),
    check('finance_tds_challans_month', sql`extract(day from month) = 1`),
    check('finance_tds_challans_bsr', sql`bsr_code ~ '^[0-9]{7}$'`),
    check('finance_tds_challans_serial', sql`challan_serial ~ '^[0-9]{5}$'`),
    check('finance_tds_challans_amounts', sql`tds_paise > 0 and interest_paise >= 0 and fee_paise >= 0`),
    check('finance_tds_challans_void', sql`(voided_at is null) = (void_reason is null)`),
    tenantPolicy('finance_tds_challans'),
  ],
)

/** One deduction (a bill's or a payment's) inside a challan, with its signed tax. */
export const tdsChallanLinks = pgTable(
  'finance_tds_challan_links',
  {
    id: pk(),
    institutionId: tenantId(),
    challanId: uuid('challan_id')
      .notNull()
      .references(() => tdsChallans.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
    tdsPaise: paise('tds_paise').notNull(),
  },
  (t) => [
    uniqueIndex('finance_tds_challan_links_invoice').on(t.invoiceId).where(sql`invoice_id is not null`),
    uniqueIndex('finance_tds_challan_links_payment').on(t.paymentId).where(sql`payment_id is not null`),
    index('finance_tds_challan_links_challan').on(t.challanId),
    check('finance_tds_challan_links_one', sql`(invoice_id is null) <> (payment_id is null)`),
    check('finance_tds_challan_links_amount', sql`tds_paise <> 0`),
    tenantPolicy('finance_tds_challan_links'),
  ],
)

/**
 * Who files the institution's TDS statements (P1-05d, ACC-31): the batch header
 * of a Form 140 or 144 file. State codes are the return's (Annexure 1), not GST's.
 */
export const tdsDeductor = pgTable(
  'finance_tds_deductor',
  {
    institutionId: uuid('institution_id')
      .primaryKey()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    deductorType: text('deductor_type').notNull(),
    address1: text().notNull(),
    address2: text(),
    address3: text(),
    address4: text(),
    address5: text(),
    country: text().notNull().default('INDIA'),
    stateCode: text('state_code').notNull(),
    pincode: text().notNull(),
    email: text().notNull(),
    phoneCountry: text('phone_country').notNull().default('91'),
    phone: text().notNull(),
    responsibleName: text('responsible_name').notNull(),
    responsibleDesignation: text('responsible_designation').notNull(),
    responsiblePan: text('responsible_pan').notNull(),
    responsibleAddress1: text('responsible_address1').notNull(),
    responsibleAddress2: text('responsible_address2'),
    responsibleAddress3: text('responsible_address3'),
    responsibleAddress4: text('responsible_address4'),
    responsibleAddress5: text('responsible_address5'),
    responsibleCountry: text('responsible_country').notNull().default('INDIA'),
    responsibleStateCode: text('responsible_state_code').notNull(),
    responsiblePincode: text('responsible_pincode').notNull(),
    responsibleEmail: text('responsible_email').notNull(),
    responsiblePhoneCountry: text('responsible_phone_country').notNull().default('91'),
    responsiblePhone: text('responsible_phone').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('finance_tds_deductor_type', sql`deductor_type in ('A','S','D','E','G','H','L','N','K','M','P','T','J','B','Q','F')`),
    check('finance_tds_deductor_states', sql`state_code ~ '^[0-9]{2}$' and responsible_state_code ~ '^[0-9]{2}$'`),
    check('finance_tds_deductor_pins', sql`pincode ~ '^[1-9][0-9]{5}$' and responsible_pincode ~ '^[1-9][0-9]{5}$'`),
    check(
      'finance_tds_deductor_phones',
      sql`phone ~ '^[0-9]{6,10}$' and responsible_phone ~ '^[0-9]{6,10}$' and phone_country ~ '^[0-9]{1,5}$' and responsible_phone_country ~ '^[0-9]{1,5}$'`,
    ),
    check('finance_tds_deductor_pan', sql`responsible_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`),
    tenantPolicy('finance_tds_deductor'),
  ],
)
