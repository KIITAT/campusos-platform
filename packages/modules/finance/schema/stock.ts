import { sql } from 'drizzle-orm'
import {
  bigserial,
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
import { createdAt, milli, paise, pk, tenantId } from './common'
import { accounts, entries } from './ledger'
import { funds } from './foundation'
import { taxTemplates } from './parties'

/**
 * Stock: what the institution keeps in its stores, where, and what it is worth.
 *
 * Every movement is a row in the stock ledger, written in the transaction that
 * submits the document behind it and never changed afterwards; what is on a
 * shelf is the sum of those rows, kept as a running balance per item and store
 * that the database checks on every insert. Value moves with quantity --
 * perpetual inventory -- so the stock account in the books and the stock
 * ledger cannot disagree.
 */

export const uoms = pgTable(
  'finance_uoms',
  {
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    /** Counted in whole units: a chair, a box. Off for kg, litre, metre. */
    whole: boolean().notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.institutionId, t.code] }), tenantPolicy('finance_uoms')],
)

export const itemGroups = pgTable(
  'finance_item_groups',
  {
    id: pk(),
    institutionId: tenantId(),
    name: text().notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => itemGroups.id, { onDelete: 'restrict' }),
    /** Defaults for items in the group; an item may name its own. */
    stockAccountId: uuid('stock_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    taxTemplateId: uuid('tax_template_id').references(() => taxTemplates.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('finance_item_groups_name').on(t.institutionId, t.name), tenantPolicy('finance_item_groups')],
)

/**
 * Anything bought, sold, kept or used: a reagent, a ream of paper, a projector,
 * an hour of consultancy.
 *
 * A stock item is counted and valued in the stores; a non-stock item (a
 * service, an annual subscription) is bought straight to expense. A fixed-asset
 * item becomes an asset when it is received.
 */
export const items = pgTable(
  'finance_items',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    groupId: uuid('group_id').references(() => itemGroups.id, { onDelete: 'restrict' }),
    uom: text().notNull(),
    isStock: boolean('is_stock').notNull().default(true),
    isAsset: boolean('is_asset').notNull().default(false),
    assetCategoryId: uuid('asset_category_id'),
    hsnSac: text('hsn_sac'),
    taxTemplateId: uuid('tax_template_id').references(() => taxTemplates.id, {
      onDelete: 'restrict',
    }),
    /** Expense on a purchase of a non-stock item; consumption for a stock one. */
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    hasBatch: boolean('has_batch').notNull().default(false),
    hasSerial: boolean('has_serial').notNull().default(false),
    /** Null follows the institution's setting. */
    valuation: text().$type<'moving_average' | 'fifo'>(),
    reorderLevelMilli: milli('reorder_level_milli'),
    reorderQtyMilli: milli('reorder_qty_milli'),
    standardRatePaise: paise('standard_rate_paise'),
    description: text(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_items_code').on(t.institutionId, t.code),
    index('finance_items_name').on(t.institutionId, t.name),
    check('finance_items_code_text', sql`length(trim(code)) > 0`),
    check('finance_items_asset', sql`not is_asset or (not is_stock and asset_category_id is not null)`),
    check('finance_items_tracking', sql`is_stock or not (has_batch or has_serial)`),
    check('finance_items_valuation', sql`valuation is null or valuation in ('moving_average', 'fifo')`),
    check(
      'finance_items_reorder',
      sql`(reorder_level_milli is null or reorder_level_milli >= 0) and (reorder_qty_milli is null or reorder_qty_milli > 0)`,
    ),
    tenantPolicy('finance_items'),
  ],
)

/** A store, a lab's cupboard, a department's shelf: anywhere stock is kept and counted. */
export const warehouses = pgTable(
  'finance_warehouses',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    isGroup: boolean('is_group').notNull().default(false),
    /** The stock account this store's value sits in; null uses stock in hand. */
    stockAccountId: uuid('stock_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    /** What a consumption from this store is charged to, when nothing else says. */
    costCenter: text('cost_center'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_warehouses_code').on(t.institutionId, t.code),
    tenantPolicy('finance_warehouses'),
  ],
)

export const batches = pgTable(
  'finance_batches',
  {
    id: pk(),
    institutionId: tenantId(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    batchNo: text('batch_no').notNull(),
    madeOn: date('made_on'),
    expiresOn: date('expires_on'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_batches_no').on(t.institutionId, t.itemId, t.batchNo),
    check('finance_batches_dates', sql`expires_on is null or made_on is null or expires_on >= made_on`),
    tenantPolicy('finance_batches'),
  ],
)

/**
 * One serial-numbered thing: a microscope, a laptop. Where it is and whether
 * it is still here are kept by the stock ledger's trigger, not by hand.
 */
export const serials = pgTable(
  'finance_serials',
  {
    id: pk(),
    institutionId: tenantId(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    serialNo: text('serial_no').notNull(),
    status: text().$type<'in_stock' | 'out'>().notNull().default('in_stock'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_serials_no').on(t.institutionId, t.itemId, t.serialNo),
    check('finance_serials_status', sql`status in ('in_stock', 'out')`),
    check('finance_serials_where', sql`(status = 'in_stock') = (warehouse_id is not null)`),
    tenantPolicy('finance_serials'),
  ],
)

/**
 * A movement the stores make on their own: stock received without an order
 * (a donation, opening stock), issued to a department, moved between stores,
 * or counted and set right.
 */
export const stockEntries = pgTable(
  'finance_stock_entries',
  {
    id: pk(),
    institutionId: tenantId(),
    number: text(),
    kind: text().$type<'receipt' | 'issue' | 'transfer' | 'reconciliation'>().notNull(),
    postingDate: date('posting_date').notNull(),
    memo: text(),
    /** Who the issue is for: charged to this cost centre. */
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    /** On an issue, the expense charged; on a receipt or count, where the other side goes. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    materialRequestId: uuid('material_request_id'),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_stock_entries_number').on(t.institutionId, t.number),
    check('finance_stock_entries_kind', sql`kind in ('receipt', 'issue', 'transfer', 'reconciliation')`),
    check('finance_stock_entries_numbered', sql`docstatus = 'draft' or number is not null`),
    tenantPolicy('finance_stock_entries'),
  ],
)

export const stockEntryLines = pgTable(
  'finance_stock_entry_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    stockEntryId: uuid('stock_entry_id')
      .notNull()
      .references(() => stockEntries.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    fromWarehouseId: uuid('from_warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    toWarehouseId: uuid('to_warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    /** On a reconciliation: the quantity counted, not the change. */
    qtyMilli: milli('qty_milli').notNull(),
    /** On a receipt or a count: the value of one unit. Issues are valued by the ledger. */
    ratePaise: paise('rate_paise'),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'restrict' }),
    serials: text().array(),
    /** What it came to when submitted. */
    amountPaise: paise('amount_paise'),
  },
  (t) => [
    index('finance_stock_entry_lines_entry').on(t.stockEntryId),
    check('finance_stock_entry_lines_qty', sql`qty_milli >= 0`),
    check('finance_stock_entry_lines_rate', sql`rate_paise is null or rate_paise >= 0`),
    tenantPolicy('finance_stock_entry_lines'),
  ],
)

/**
 * Every movement of stock, in the order it happened. Append-only.
 *
 * `qtyAfter` and `valueAfter` are the store's balance of that item after this
 * row; the insert trigger checks they follow from the previous row, moves the
 * bin, and refuses a row dated before the last one for that item and store --
 * stock is posted in time order, which is what keeps every running balance
 * true without re-valuing history.
 */
export const stockLedger = pgTable(
  'finance_stock_ledger',
  {
    id: pk(),
    institutionId: tenantId(),
    seq: bigserial({ mode: 'number' }).notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'restrict' }),
    postingDate: date('posting_date').notNull(),
    voucherType: text('voucher_type').notNull(),
    voucherId: uuid('voucher_id').notNull(),
    voucherLineId: uuid('voucher_line_id'),
    qtyChangeMilli: milli('qty_change_milli').notNull(),
    valueChangePaise: paise('value_change_paise').notNull(),
    qtyAfterMilli: milli('qty_after_milli').notNull(),
    valueAfterPaise: paise('value_after_paise').notNull(),
    serials: text().array(),
    createdAt: createdAt(),
  },
  (t) => [
    index('finance_stock_ledger_item').on(t.institutionId, t.itemId, t.warehouseId, t.seq),
    index('finance_stock_ledger_voucher').on(t.voucherType, t.voucherId),
    index('finance_stock_ledger_date').on(t.institutionId, t.postingDate),
    tenantPolicy('finance_stock_ledger'),
  ],
)

/** What is in each store, now. Written only by the stock ledger's trigger. */
export const stockBins = pgTable(
  'finance_stock_bins',
  {
    institutionId: tenantId(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    qtyMilli: milli('qty_milli').notNull().default(0),
    valuePaise: paise('value_paise').notNull().default(0),
    lastPostingDate: date('last_posting_date'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.warehouseId] }), tenantPolicy('finance_stock_bins')],
)

/** The same, per batch. */
export const batchBins = pgTable(
  'finance_batch_bins',
  {
    institutionId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    qtyMilli: milli('qty_milli').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.warehouseId] }),
    check('finance_batch_bins_qty', sql`qty_milli >= 0`),
    tenantPolicy('finance_batch_bins'),
  ],
)

/**
 * For first-in-first-out: what is left of each receipt, oldest first. An issue
 * consumes the oldest layers; a moving-average item never has any.
 */
export const stockLayers = pgTable(
  'finance_stock_layers',
  {
    id: pk(),
    institutionId: tenantId(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => stockLedger.id, { onDelete: 'restrict' }),
    postingDate: date('posting_date').notNull(),
    qtyLeftMilli: milli('qty_left_milli').notNull(),
    valueLeftPaise: paise('value_left_paise').notNull(),
  },
  (t) => [
    index('finance_stock_layers_open').on(t.institutionId, t.itemId, t.warehouseId, t.postingDate),
    check('finance_stock_layers_left', sql`qty_left_milli >= 0 and value_left_paise >= 0`),
    tenantPolicy('finance_stock_layers'),
  ],
)
