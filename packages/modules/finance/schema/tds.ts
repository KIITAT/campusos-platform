import { sql } from 'drizzle-orm'
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantPolicy } from '@campusos/db'
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
