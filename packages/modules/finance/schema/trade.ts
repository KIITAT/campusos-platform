import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { docStatusColumns, tenantPolicy, users } from '@campusos/db'
import { createdAt, currency, milli, paise, pk, rate, tenantId } from './common'
import { entries } from './ledger'
import { funds } from './foundation'
import { parties, taxTemplates } from './parties'
import { batches, items, warehouses } from './stock'
import { invoices } from './documents'

/**
 * Buying and selling: from a department asking for something to the supplier
 * being paid, and from a customer's order to the money arriving.
 *
 *   material request -> request for quotation -> supplier quotation
 *     -> purchase order -> goods receipt -> purchase invoice -> payment
 *   quotation -> sales order -> delivery note -> sales invoice -> receipt
 *
 * Every step is a document with draft, submitted, cancelled, and each names the
 * line of the step before it. What is still to order, to receive, to bill or
 * to deliver is a sum over those names, never a counter kept on the order.
 */

// --- asking --------------------------------------------------------------------

/** A department's indent: what it needs, how much, by when. */
export const materialRequests = pgTable(
  'finance_material_requests',
  {
    id: pk(),
    institutionId: tenantId(),
    number: text(),
    purpose: text().$type<'purchase' | 'issue'>().notNull().default('purchase'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    costCenter: text('cost_center'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    requiredBy: date('required_by'),
    reason: text(),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_material_requests_number').on(t.institutionId, t.number),
    check('finance_material_requests_purpose', sql`purpose in ('purchase', 'issue')`),
    check('finance_material_requests_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_material_requests'),
  ],
)

export const materialRequestLines = pgTable(
  'finance_material_request_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => materialRequests.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    qtyMilli: milli('qty_milli').notNull(),
    note: text(),
  },
  (t) => [
    index('finance_material_request_lines_request').on(t.requestId),
    check('finance_material_request_lines_qty', sql`qty_milli > 0`),
    tenantPolicy('finance_material_request_lines'),
  ],
)

/** Asking suppliers for prices. */
export const rfqs = pgTable(
  'finance_rfqs',
  {
    id: pk(),
    institutionId: tenantId(),
    number: text(),
    postingDate: date('posting_date').notNull(),
    respondBy: date('respond_by'),
    terms: text(),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_rfqs_number').on(t.institutionId, t.number),
    check('finance_rfqs_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_rfqs'),
  ],
)

export const rfqLines = pgTable(
  'finance_rfq_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    qtyMilli: milli('qty_milli').notNull(),
    requestLineId: uuid('request_line_id').references(() => materialRequestLines.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    index('finance_rfq_lines_rfq').on(t.rfqId),
    check('finance_rfq_lines_qty', sql`qty_milli > 0`),
    tenantPolicy('finance_rfq_lines'),
  ],
)

export const rfqSuppliers = pgTable(
  'finance_rfq_suppliers',
  {
    institutionId: tenantId(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.rfqId, t.partyId] }), tenantPolicy('finance_rfq_suppliers')],
)

/** What a supplier answered. */
export const supplierQuotations = pgTable(
  'finance_supplier_quotations',
  {
    id: pk(),
    institutionId: tenantId(),
    number: text(),
    rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    quotedOn: date('quoted_on').notNull(),
    validTill: date('valid_till'),
    currency: currency('currency').notNull(),
    terms: text(),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_supplier_quotations_number').on(t.institutionId, t.number),
    check('finance_supplier_quotations_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_supplier_quotations'),
  ],
)

export const supplierQuotationLines = pgTable(
  'finance_supplier_quotation_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    quotationId: uuid('quotation_id')
      .notNull()
      .references(() => supplierQuotations.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    qtyMilli: milli('qty_milli').notNull(),
    rateFc: paise('rate_fc').notNull(),
    taxTemplateId: uuid('tax_template_id').references(() => taxTemplates.id, {
      onDelete: 'restrict',
    }),
    leadDays: integer('lead_days'),
    rfqLineId: uuid('rfq_line_id').references(() => rfqLines.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('finance_supplier_quotation_lines_quotation').on(t.quotationId),
    check('finance_supplier_quotation_lines_qty', sql`qty_milli > 0 and rate_fc >= 0`),
    tenantPolicy('finance_supplier_quotation_lines'),
  ],
)

// --- orders ----------------------------------------------------------------------

/**
 * A purchase order, a sales order, or a quotation to a customer: one shape,
 * because they are the same promise from different ends.
 */
export const orders = pgTable(
  'finance_orders',
  {
    id: pk(),
    institutionId: tenantId(),
    kind: text().$type<'purchase_order' | 'sales_order' | 'quotation'>().notNull(),
    number: text(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    postingDate: date('posting_date').notNull(),
    deliverBy: date('deliver_by'),
    validTill: date('valid_till'),
    currency: currency('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    placeOfSupply: text('place_of_supply'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    netFc: paise('net_fc').notNull().default(0),
    taxFc: paise('tax_fc').notNull().default(0),
    totalFc: paise('total_fc').notNull().default(0),
    totalPaise: paise('total_paise').notNull().default(0),
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    /** The quotation a sales order came from, or the supplier quotation a purchase order did. */
    fromQuotationId: uuid('from_quotation_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'restrict',
    }),
    supplierQuotationId: uuid('supplier_quotation_id').references(() => supplierQuotations.id, {
      onDelete: 'restrict',
    }),
    terms: text(),
    memo: text(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_orders_number').on(t.institutionId, t.kind, t.number),
    index('finance_orders_party').on(t.institutionId, t.partyId),
    check('finance_orders_kind', sql`kind in ('purchase_order', 'sales_order', 'quotation')`),
    check('finance_orders_numbered', sql`docstatus = 'draft' or number is not null`),
    check('finance_orders_rate', sql`exchange_rate > 0`),
    tenantPolicy('finance_orders'),
  ],
)

export const orderLines = pgTable(
  'finance_order_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    description: text().notNull(),
    qtyMilli: milli('qty_milli').notNull(),
    rateFc: paise('rate_fc').notNull(),
    discountBp: integer('discount_bp').notNull().default(0),
    amountFc: paise('amount_fc').notNull(),
    taxTemplateId: uuid('tax_template_id').references(() => taxTemplates.id, {
      onDelete: 'restrict',
    }),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    costCenter: text('cost_center'),
    requestLineId: uuid('request_line_id').references(() => materialRequestLines.id, {
      onDelete: 'restrict',
    }),
    quotationLineId: uuid('quotation_line_id'),
    deliverBy: date('deliver_by'),
  },
  (t) => [
    index('finance_order_lines_order').on(t.orderId),
    index('finance_order_lines_request').on(t.requestLineId),
    check('finance_order_lines_qty', sql`qty_milli > 0 and rate_fc >= 0`),
    check('finance_order_lines_discount', sql`discount_bp between 0 and 10000`),
    tenantPolicy('finance_order_lines'),
  ],
)

/**
 * An order closed short: the rest will not come, or will not be sent. A
 * submitted order is not edited, so this is a row beside it, with a reason.
 */
export const orderClosures = pgTable(
  'finance_order_closures',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.id, { onDelete: 'restrict' }),
    institutionId: tenantId(),
    reason: text().notNull(),
    closedBy: text('closed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  () => [check('finance_order_closures_reason', sql`length(trim(reason)) >= 5`), tenantPolicy('finance_order_closures')],
)

// --- goods moving ---------------------------------------------------------------

/** Goods arriving from a supplier, or leaving for a customer; and their returns. */
export const receipts = pgTable(
  'finance_receipts',
  {
    id: pk(),
    institutionId: tenantId(),
    kind: text().$type<'purchase_receipt' | 'delivery_note'>().notNull(),
    isReturn: boolean('is_return').notNull().default(false),
    returnAgainst: uuid('return_against').references((): AnyPgColumn => receipts.id, {
      onDelete: 'restrict',
    }),
    number: text(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    postingDate: date('posting_date').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    /** The supplier's delivery challan, the transporter, the vehicle. */
    challanNo: text('challan_no'),
    transporter: text(),
    currency: currency('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    totalPaise: paise('total_paise').notNull().default(0),
    costCenter: text('cost_center'),
    memo: text(),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_receipts_number').on(t.institutionId, t.kind, t.number),
    check('finance_receipts_kind', sql`kind in ('purchase_receipt', 'delivery_note')`),
    check('finance_receipts_return', sql`is_return = (return_against is not null)`),
    check('finance_receipts_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_receipts'),
  ],
)

export const receiptLines = pgTable(
  'finance_receipt_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    orderLineId: uuid('order_line_id').references(() => orderLines.id, { onDelete: 'restrict' }),
    returnOfLineId: uuid('return_of_line_id').references((): AnyPgColumn => receiptLines.id, {
      onDelete: 'restrict',
    }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    /** Accepted into stock. */
    qtyMilli: milli('qty_milli').notNull(),
    /** Turned away at the door, for the record. */
    rejectedMilli: milli('rejected_milli').notNull().default(0),
    rateFc: paise('rate_fc').notNull(),
    amountPaise: paise('amount_paise').notNull().default(0),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'restrict' }),
    serials: text().array(),
  },
  (t) => [
    index('finance_receipt_lines_receipt').on(t.receiptId),
    index('finance_receipt_lines_order').on(t.orderLineId),
    check('finance_receipt_lines_qty', sql`qty_milli >= 0 and rejected_milli >= 0 and qty_milli + rejected_milli > 0`),
    check('finance_receipt_lines_rate', sql`rate_fc >= 0`),
    tenantPolicy('finance_receipt_lines'),
  ],
)

/**
 * An invoice raised again and again -- the canteen's monthly rent -- from a
 * submitted one used as the pattern.
 */
export const recurring = pgTable(
  'finance_recurring',
  {
    id: pk(),
    institutionId: tenantId(),
    templateInvoiceId: uuid('template_invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    every: text().$type<'month' | 'quarter' | 'year'>().notNull(),
    nextOn: date('next_on').notNull(),
    endsOn: date('ends_on'),
    /** Submit what is made, or leave it as a draft to check. */
    autoSubmit: boolean('auto_submit').notNull().default(false),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  () => [
    check('finance_recurring_every', sql`every in ('month', 'quarter', 'year')`),
    check('finance_recurring_ends', sql`ends_on is null or ends_on >= next_on`),
    tenantPolicy('finance_recurring'),
  ],
)

