import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { docStatusColumns, tenantPolicy, users } from '@campusos/db'
import { createdAt, currency, milli, paise, pk, rate, tenantId } from './common'
import { accounts, entries } from './ledger'
import { funds } from './foundation'
import { parties, taxTemplates, tdsSections } from './parties'

/**
 * The documents an accountant writes, as opposed to the entries they make.
 *
 * A journal entry is the fact in the books; a voucher, an invoice or a payment
 * is the document that caused it. Documents follow draft, submitted, cancelled
 * (decision 123): a draft is worked on freely and posts nothing, submitting it
 * numbers it and posts its entry in the same transaction, and cancelling it
 * posts the reversal. The entry is never edited; the document is never edited
 * once submitted. Each document's lines may change only while it is a draft --
 * the database checks that too.
 */

// --- journal vouchers --------------------------------------------------------

/** A free-hand entry, typed by an accountant: a journal, contra, opening balances. */
export const journals = pgTable(
  'finance_journals',
  {
    id: pk(),
    institutionId: tenantId(),
    number: text(),
    kind: text().$type<'journal' | 'contra' | 'opening' | 'adjustment'>().notNull().default('journal'),
    postingDate: date('posting_date').notNull(),
    memo: text().notNull(),
    reference: text(),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_journals_number').on(t.institutionId, t.number),
    index('finance_journals_date').on(t.institutionId, t.postingDate),
    check('finance_journals_kind', sql`kind in ('journal', 'contra', 'opening', 'adjustment')`),
    check('finance_journals_memo', sql`length(trim(memo)) > 0`),
    check('finance_journals_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_journals'),
  ],
)

export const journalLines = pgTable(
  'finance_journal_voucher_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journals.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'restrict' }),
    debitPaise: paise('debit_paise').notNull().default(0),
    creditPaise: paise('credit_paise').notNull().default(0),
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    currency: currency('currency'),
    amountFc: paise('amount_fc'),
    exchangeRate: rate('exchange_rate'),
    memo: text(),
  },
  (t) => [
    index('finance_journal_voucher_lines_journal').on(t.journalId),
    check(
      'finance_journal_voucher_lines_one_side',
      sql`debit_paise >= 0 and credit_paise >= 0 and (debit_paise = 0) <> (credit_paise = 0)`,
    ),
    tenantPolicy('finance_journal_voucher_lines'),
  ],
)

// --- invoices ------------------------------------------------------------------

/**
 * A sale or a purchase, and its return.
 *
 * A credit note is a sales invoice with `isReturn`, naming the invoice it
 * returns; a debit note is the same for a purchase. Amounts are kept in the
 * invoice's currency and in the base currency both: the party is owed the one,
 * the books carry the other.
 */
export const invoices = pgTable(
  'finance_invoices',
  {
    id: pk(),
    institutionId: tenantId(),
    kind: text().$type<'sales' | 'purchase'>().notNull(),
    isReturn: boolean('is_return').notNull().default(false),
    returnAgainst: uuid('return_against').references((): AnyPgColumn => invoices.id, {
      onDelete: 'restrict',
    }),
    number: text(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    postingDate: date('posting_date').notNull(),
    dueDate: date('due_date'),
    /** The supplier's own invoice number and date, on a purchase. */
    billNo: text('bill_no'),
    billDate: date('bill_date'),
    currency: currency('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    /** GST state code of the place of supply. */
    placeOfSupply: text('place_of_supply'),
    reverseCharge: boolean('reverse_charge').notNull().default(false),
    /** Whether this invoice moves stock itself, without a receipt or delivery note. */
    updateStock: boolean('update_stock').notNull().default(false),
    warehouseId: uuid('warehouse_id'),
    orderId: uuid('order_id'),
    netFc: paise('net_fc').notNull().default(0),
    taxFc: paise('tax_fc').notNull().default(0),
    roundingFc: paise('rounding_fc').notNull().default(0),
    totalFc: paise('total_fc').notNull().default(0),
    /** The same, in the base currency. */
    totalPaise: paise('total_paise').notNull().default(0),
    tdsSectionId: uuid('tds_section_id').references(() => tdsSections.id, { onDelete: 'restrict' }),
    tdsPaise: paise('tds_paise').notNull().default(0),
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    memo: text(),
    terms: text(),
    /** Raised by another module, which says what for. */
    sourceModule: text('source_module'),
    sourceRef: text('source_ref'),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_invoices_number').on(t.institutionId, t.kind, t.number),
    uniqueIndex('finance_invoices_bill')
      .on(t.institutionId, t.partyId, t.billNo)
      .where(sql`kind = 'purchase' and bill_no is not null and docstatus <> 'cancelled' and not is_return`),
    uniqueIndex('finance_invoices_source')
      .on(t.institutionId, t.sourceModule, t.sourceRef)
      .where(sql`source_ref is not null and docstatus <> 'cancelled'`),
    index('finance_invoices_party').on(t.institutionId, t.partyId),
    index('finance_invoices_date').on(t.institutionId, t.postingDate),
    check('finance_invoices_kind', sql`kind in ('sales', 'purchase')`),
    check('finance_invoices_return', sql`is_return = (return_against is not null)`),
    check('finance_invoices_numbered', sql`docstatus = 'draft' or number is not null`),
    check('finance_invoices_due', sql`due_date is null or due_date >= posting_date`),
    check('finance_invoices_rate', sql`exchange_rate > 0`),
    check('finance_invoices_pos', sql`place_of_supply is null or place_of_supply ~ '^[0-9]{2}$'`),
    check('finance_invoices_tds', sql`tds_paise >= 0`),
    tenantPolicy('finance_invoices'),
  ],
)

export const invoiceLines = pgTable(
  'finance_invoice_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id'),
    description: text().notNull(),
    hsnSac: text('hsn_sac'),
    qtyMilli: milli('qty_milli').notNull(),
    uom: text(),
    /** Price of one unit, in the invoice's currency's minor units. */
    rateFc: paise('rate_fc').notNull(),
    discountBp: integer('discount_bp').notNull().default(0),
    /** After discount, before tax. */
    amountFc: paise('amount_fc').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    taxTemplateId: uuid('tax_template_id').references(() => taxTemplates.id, {
      onDelete: 'restrict',
    }),
    /** Income on a sale; expense, stock-in-transit or an asset on a purchase. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id'),
    batchId: uuid('batch_id'),
    serials: text().array(),
    orderLineId: uuid('order_line_id'),
    /** The receipt or delivery note line this bills. */
    receiptLineId: uuid('receipt_line_id'),
    /** Input tax claimable on this line; off for blocked credits. */
    itcEligible: boolean('itc_eligible').notNull().default(true),
    /** The asset this purchase line made, or this sale line sold. */
    assetId: uuid('asset_id'),
  },
  (t) => [
    index('finance_invoice_lines_invoice').on(t.invoiceId),
    index('finance_invoice_lines_order').on(t.orderLineId),
    index('finance_invoice_lines_receipt').on(t.receiptLineId),
    check('finance_invoice_lines_qty', sql`qty_milli > 0`),
    check('finance_invoice_lines_rate', sql`rate_fc >= 0`),
    check('finance_invoice_lines_discount', sql`discount_bp between 0 and 10000`),
    check('finance_invoice_lines_description', sql`length(trim(description)) > 0`),
    tenantPolicy('finance_invoice_lines'),
  ],
)

/** The tax on an invoice, per component, as computed when it was last saved. */
export const invoiceTaxes = pgTable(
  'finance_invoice_taxes',
  {
    id: pk(),
    institutionId: tenantId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => taxTemplates.id, { onDelete: 'restrict' }),
    component: text().notNull(),
    rateBp: integer('rate_bp').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    taxableFc: paise('taxable_fc').notNull(),
    taxFc: paise('tax_fc').notNull(),
    taxPaise: paise('tax_paise').notNull(),
    /** Input tax that may not be claimed, and so is a cost. */
    ineligiblePaise: paise('ineligible_paise').notNull().default(0),
  },
  (t) => [index('finance_invoice_taxes_invoice').on(t.invoiceId), tenantPolicy('finance_invoice_taxes')],
)

// --- payments -------------------------------------------------------------------

/**
 * Money in, money out, or money moved between the institution's own accounts.
 *
 * A payment names what it settles; what it does not settle is an advance and
 * stays on the party's account until a later invoice takes it.
 */
export const payments = pgTable(
  'finance_payments',
  {
    id: pk(),
    institutionId: tenantId(),
    kind: text().$type<'receive' | 'pay' | 'transfer'>().notNull(),
    number: text(),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'restrict' }),
    /**
     * Whose account it moves. Money in usually settles a customer and money
     * out a supplier; a refund is the other way round -- paying a customer
     * back their credit, or receiving a supplier's.
     */
    side: text().$type<'receivable' | 'payable'>(),
    postingDate: date('posting_date').notNull(),
    /** The bank or cash account the money moved through; for a transfer, where it left. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** For a transfer, where it arrived. */
    toAccountId: uuid('to_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    currency: currency('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amountFc: paise('amount_fc').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    /** Tax the payer deducted at source: on a receipt, ours to claim; on a payment, ours to deposit. */
    tdsPaise: paise('tds_paise').notNull().default(0),
    tdsSectionId: uuid('tds_section_id').references(() => tdsSections.id, { onDelete: 'restrict' }),
    bankChargesPaise: paise('bank_charges_paise').notNull().default(0),
    mode: text().notNull().default('neft'),
    instrumentNo: text('instrument_no'),
    instrumentDate: date('instrument_date'),
    reference: text(),
    memo: text(),
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_payments_number').on(t.institutionId, t.number),
    index('finance_payments_party').on(t.institutionId, t.partyId),
    index('finance_payments_date').on(t.institutionId, t.postingDate),
    check('finance_payments_kind', sql`kind in ('receive', 'pay', 'transfer')`),
    check('finance_payments_party_kind', sql`(kind = 'transfer') = (party_id is null)`),
    check(
      'finance_payments_side',
      sql`(side is null) = (party_id is null) and (side is null or side in ('receivable', 'payable'))`,
    ),
    check(
      'finance_payments_transfer',
      sql`(kind = 'transfer') = (to_account_id is not null) and (to_account_id is null or to_account_id <> account_id)`,
    ),
    check('finance_payments_amount', sql`amount_fc > 0 and amount_paise > 0`),
    check('finance_payments_deductions', sql`tds_paise >= 0 and bank_charges_paise >= 0`),
    check('finance_payments_rate', sql`exchange_rate > 0`),
    check(
      'finance_payments_mode',
      sql`mode in ('cash', 'cheque', 'dd', 'neft', 'rtgs', 'imps', 'upi', 'card', 'wire', 'other')`,
    ),
    check('finance_payments_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_payments'),
  ],
)

/** Which invoices a payment settles, and how much of each. */
export const paymentAllocations = pgTable(
  'finance_payment_allocations',
  {
    id: pk(),
    institutionId: tenantId(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    /** In the invoice's currency. */
    amountFc: paise('amount_fc').notNull(),
  },
  (t) => [
    uniqueIndex('finance_payment_allocations_once').on(t.paymentId, t.invoiceId),
    check('finance_payment_allocations_amount', sql`amount_fc > 0`),
    tenantPolicy('finance_payment_allocations'),
  ],
)

/**
 * What each party owes, or is owed, invoice by invoice.
 *
 * Every submitted invoice, payment and party journal line writes rows here in
 * the transaction that posts it, and cancelling writes their negation; nothing
 * is updated or deleted. An invoice's outstanding is the sum of the rows
 * against it; a row against nothing is an advance. Aging, a party statement
 * and "what is still open on this bill" are all sums of this table.
 *
 * `amount` grows what the party owes us, or what we owe them, depending on
 * which side they are on; its sign is the same for customers and suppliers.
 */
export const partyLedger = pgTable(
  'finance_party_ledger',
  {
    id: pk(),
    institutionId: tenantId(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    side: text().$type<'receivable' | 'payable'>().notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    voucherType: text('voucher_type').notNull(),
    voucherId: uuid('voucher_id').notNull(),
    /** The invoice this row counts against; null for money on account. */
    againstId: uuid('against_id'),
    postingDate: date('posting_date').notNull(),
    dueDate: date('due_date'),
    currency: currency('currency').notNull(),
    amountFc: paise('amount_fc').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('finance_party_ledger_party').on(t.institutionId, t.partyId),
    index('finance_party_ledger_against').on(t.againstId),
    index('finance_party_ledger_voucher').on(t.voucherType, t.voucherId),
    check('finance_party_ledger_side', sql`side in ('receivable', 'payable')`),
    tenantPolicy('finance_party_ledger'),
  ],
)
