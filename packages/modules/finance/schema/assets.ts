import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { docStatusColumns, tenantPolicy, users } from '@campusos/db'
import { createdAt, paise, pk, tenantId } from './common'
import { accounts, entries } from './ledger'
import { funds } from './foundation'
import { parties } from './parties'
import { items, serials, warehouses } from './stock'

/**
 * Fixed assets: what the institution owns and uses for more than a year, and
 * how its cost is spread over the years it is used.
 *
 * A category says which accounts an asset's cost, its accumulated depreciation
 * and the yearly charge live in, and how it depreciates: straight line, written
 * down value, or not at all (land). The rates are the institution's -- its
 * accounting policy, which its auditor agrees -- and nothing is seeded.
 */
export const assetCategories = pgTable(
  'finance_asset_categories',
  {
    id: pk(),
    institutionId: tenantId(),
    name: text().notNull(),
    assetAccountId: uuid('asset_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    accumulatedAccountId: uuid('accumulated_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    depreciationAccountId: uuid('depreciation_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    method: text().$type<'slm' | 'wdv' | 'none'>().notNull(),
    /** Straight line: the life in months. */
    lifeMonths: integer('life_months'),
    /** Written down value: the yearly rate, in hundredths of a percent. */
    rateBp: integer('rate_bp'),
    /** What is left at the end, as a share of cost. */
    residualBp: integer('residual_bp').notNull().default(0),
    frequency: text().$type<'month' | 'year'>().notNull().default('month'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_asset_categories_name').on(t.institutionId, t.name),
    check('finance_asset_categories_method', sql`method in ('slm', 'wdv', 'none')`),
    check(
      'finance_asset_categories_basis',
      sql`(method <> 'slm' or (life_months between 1 and 1200)) and (method <> 'wdv' or (rate_bp between 1 and 10000))`,
    ),
    check('finance_asset_categories_residual', sql`residual_bp between 0 and 10000`),
    check('finance_asset_categories_frequency', sql`frequency in ('month', 'year')`),
    tenantPolicy('finance_asset_categories'),
  ],
)

/**
 * One asset. Submitting it capitalises it -- for an asset brought into the
 * books from before, that posts its cost and what it had already depreciated;
 * for one bought here, the purchase invoice already posted the cost -- and
 * writes its depreciation schedule.
 */
export const assets = pgTable(
  'finance_assets',
  {
    id: pk(),
    institutionId: tenantId(),
    number: text(),
    name: text().notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => assetCategories.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'restrict' }),
    serialId: uuid('serial_id').references(() => serials.id, { onDelete: 'restrict' }),
    /** The purchase invoice line it was bought on, when it was bought here. */
    invoiceLineId: uuid('invoice_line_id'),
    supplierId: uuid('supplier_id').references(() => parties.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    custodianId: text('custodian_id').references(() => users.id, { onDelete: 'set null' }),
    costCenter: text('cost_center'),
    fundId: uuid('fund_id').references(() => funds.id, { onDelete: 'restrict' }),
    purchasedOn: date('purchased_on').notNull(),
    /** When it was ready to use: depreciation runs from here. */
    inUseOn: date('in_use_on').notNull(),
    grossPaise: paise('gross_paise').notNull(),
    /** Depreciation already charged before these books, for an asset brought in. */
    openingAccumulatedPaise: paise('opening_accumulated_paise').notNull().default(0),
    /** Brought in from earlier books rather than bought through them. */
    existing: text().$type<'no' | 'yes'>().notNull().default('no'),
    warrantyTill: date('warranty_till'),
    insuredTill: date('insured_till'),
    tagCode: text('tag_code'),
    note: text(),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('finance_assets_number').on(t.institutionId, t.number),
    uniqueIndex('finance_assets_tag')
      .on(t.institutionId, t.tagCode)
      .where(sql`tag_code is not null`),
    index('finance_assets_category').on(t.institutionId, t.categoryId),
    check('finance_assets_numbered', sql`docstatus = 'draft' or number is not null`),
    check('finance_assets_gross', sql`gross_paise > 0`),
    check(
      'finance_assets_opening',
      sql`opening_accumulated_paise >= 0 and opening_accumulated_paise <= gross_paise`,
    ),
    check('finance_assets_dates', sql`in_use_on >= purchased_on`),
    check('finance_assets_existing', sql`existing in ('no', 'yes')`),
    tenantPolicy('finance_assets'),
  ],
)

/**
 * The asset's depreciation, period by period, as worked out when it was
 * capitalised. A row is posted once and then never changes; rows not yet
 * posted are dropped when the asset is disposed of.
 */
export const depreciationSchedule = pgTable(
  'finance_depreciation_schedule',
  {
    id: pk(),
    institutionId: tenantId(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    periodEnd: date('period_end').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    accumulatedAfterPaise: paise('accumulated_after_paise').notNull(),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('finance_depreciation_schedule_period').on(t.assetId, t.periodEnd),
    index('finance_depreciation_schedule_due').on(t.institutionId, t.periodEnd),
    check('finance_depreciation_schedule_amount', sql`amount_paise >= 0`),
    tenantPolicy('finance_depreciation_schedule'),
  ],
)

/**
 * What happened to an asset after it was bought: moved, handed to somebody,
 * repaired, checked on the shelf, written down, sold or scrapped. Kept, never
 * edited.
 */
export const assetEvents = pgTable(
  'finance_asset_events',
  {
    id: pk(),
    institutionId: tenantId(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    kind: text()
      .$type<'transfer' | 'maintenance' | 'verification' | 'impairment' | 'sold' | 'scrapped'>()
      .notNull(),
    on: date('on').notNull(),
    toLocationId: uuid('to_location_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    toCustodianId: text('to_custodian_id').references(() => users.id, { onDelete: 'set null' }),
    toCostCenter: text('to_cost_center'),
    costPaise: paise('cost_paise'),
    /** On a sale, what it fetched; on an impairment, how much it was written down. */
    amountPaise: paise('amount_paise'),
    vendorId: uuid('vendor_id').references(() => parties.id, { onDelete: 'restrict' }),
    /** On a verification: found where it should be, found elsewhere, or not found. */
    finding: text(),
    nextDueOn: date('next_due_on'),
    note: text(),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'restrict' }),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('finance_asset_events_asset').on(t.assetId),
    check(
      'finance_asset_events_kind',
      sql`kind in ('transfer', 'maintenance', 'verification', 'impairment', 'sold', 'scrapped')`,
    ),
    check(
      'finance_asset_events_finding',
      sql`kind <> 'verification' or finding in ('found', 'elsewhere', 'missing')`,
    ),
    check('finance_asset_events_amounts', sql`(cost_paise is null or cost_paise >= 0) and (amount_paise is null or amount_paise >= 0)`),
    tenantPolicy('finance_asset_events'),
  ],
)
