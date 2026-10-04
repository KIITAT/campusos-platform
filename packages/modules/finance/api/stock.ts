import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import { cancelDocument, submitDocument, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import {
  accounts,
  batchBins,
  batches,
  lines as glLines,
  itemGroups,
  items,
  serials,
  stockBins,
  stockEntries,
  stockEntryLines,
  stockLayers,
  stockLedger,
  uoms,
  warehouses,
} from '../schema'
import {
  FinanceError,
  canOperate,
  named,
  requireCapability,
  requireConfigure,
  requireOperate,
  requireRead,
  tenantOf,
  type Actor,
  type Tx,
} from './core'
import { extend, formatQty, mulDiv, parseDecimal, parseQty } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'
import { nextNumber } from './setup'
import { localToday, settingsWithin } from './years'

/**
 * The stores: what is kept, where, and what it is worth.
 *
 * Every movement goes through `moveStock`, which values it and writes the
 * stock ledger; the database keeps the running balance (migration 0008). Two
 * ways of valuing an issue, per item or by the institution's setting:
 *
 *   moving average  an issue goes out at what the store's stock is worth per
 *                   unit right now -- value over quantity -- which a receipt at
 *                   a new price moves;
 *   first in, first out
 *                   an issue goes out at the price of the oldest receipt still
 *                   on the shelf, layer by layer.
 *
 * Value travels with quantity into the books (perpetual inventory): a receipt
 * debits the store's stock account, an issue credits it, in the same
 * transaction, so the stock ledger and the stock account cannot disagree.
 *
 * A cancellation takes back exactly what was posted, on the day it was posted.
 * Stock is posted in date order per item and store, so a cancellation after
 * that item has moved again in that store is refused -- the correction then is
 * a new document (a return, an issue, a count). Later issues are not re-valued
 * when an earlier receipt is cancelled; nothing in the stores is rewritten.
 */

const text = (min: number, max: number) => z.string().trim().min(min).max(max)
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))
const optionalId = z
  .uuid()
  .optional()
  .or(z.literal('').transform(() => undefined))

// --- who may move stock ------------------------------------------------------------

/**
 * The accounts office, or a storekeeper of every store a document touches. A
 * storekeeper named for no particular store keeps them all.
 */
async function requireStores(tx: Tx, actor: Actor, warehouseIds: (string | null | undefined)[]) {
  if (canOperate(actor.role)) return
  for (const w of new Set(warehouseIds.filter((x): x is string => !!x))) {
    await requireCapability(tx, actor, 'storekeeper', w)
  }
}

// --- units, groups, items, stores --------------------------------------------------

/** Seeded the first time an item is made; an institution adds its own. */
const DEFAULT_UOMS: { code: string; name: string; whole: boolean }[] = [
  { code: 'Nos', name: 'Numbers', whole: true },
  { code: 'Box', name: 'Box', whole: true },
  { code: 'Pkt', name: 'Packet', whole: true },
  { code: 'Set', name: 'Set', whole: true },
  { code: 'Ream', name: 'Ream', whole: true },
  { code: 'Kg', name: 'Kilogram', whole: false },
  { code: 'g', name: 'Gram', whole: false },
  { code: 'Ltr', name: 'Litre', whole: false },
  { code: 'ml', name: 'Millilitre', whole: false },
  { code: 'Mtr', name: 'Metre', whole: false },
  { code: 'Hr', name: 'Hour', whole: false },
]

async function ensureUoms(tx: Tx, institutionId: string) {
  await tx
    .insert(uoms)
    .values(DEFAULT_UOMS.map((u) => ({ institutionId, ...u })))
    .onConflictDoNothing()
}

/** The store everything goes to when nobody has said otherwise. */
export async function defaultWarehouse(tx: Tx, institutionId: string): Promise<string> {
  const [first] = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(isNull(warehouses.archivedAt), eq(warehouses.isGroup, false)))
    .orderBy(asc(warehouses.createdAt))
    .limit(1)
  if (first) return first.id
  const [row] = await tx
    .insert(warehouses)
    .values({ institutionId, code: 'MAIN', name: 'Main store' })
    .onConflictDoNothing()
    .returning({ id: warehouses.id })
  if (row) return row.id
  const [again] = await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'MAIN'))
  return again!.id
}

export const uomSchema = z
  .object({ code: text(1, 12), name: text(1, 60), whole: z.preprocess(ticked, z.boolean()).default(false) })
  .meta({ id: 'FinanceUom' })

export async function listUoms(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    await ensureUoms(tx, tenant)
    return tx.select().from(uoms).orderBy(asc(uoms.code))
  })
}

export async function createUom(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = uomSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(uoms)
      .values({ institutionId: tenant, ...data })
      .onConflictDoNothing()
      .returning({ code: uoms.code })
    if (!row) throw new FinanceError(409, 'uom_taken', 'that unit is already there')
    return { ...row, notice: `${data.name} added.` }
  })
}

export const itemGroupSchema = z
  .object({
    name: text(2, 120),
    parentId: optionalId,
    stockAccountId: optionalId,
    expenseAccountId: optionalId,
    incomeAccountId: optionalId,
    taxTemplateId: optionalId,
  })
  .meta({ id: 'FinanceItemGroup' })

export async function listItemGroups(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => tx.select().from(itemGroups).orderBy(asc(itemGroups.name)))
}

export async function createItemGroup(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = itemGroupSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(itemGroups)
        .values({ institutionId: tenant, ...data })
        .returning({ id: itemGroups.id })
      return { ...row!, notice: `${data.name} added.` }
    }),
  )
}

export const itemSchema = z
  .object({
    code: text(1, 40),
    name: text(2, 200),
    groupId: optionalId,
    uom: text(1, 12).default('Nos'),
    /** stock: counted in the stores; service: bought to expense; asset: becomes a fixed asset. */
    nature: z.enum(['stock', 'service', 'asset']).default('stock'),
    assetCategoryId: optionalId,
    hsnSac: optional(10),
    taxTemplateId: optionalId,
    expenseAccountId: optionalId,
    incomeAccountId: optionalId,
    hasBatch: z.preprocess(ticked, z.boolean()).default(false),
    hasSerial: z.preprocess(ticked, z.boolean()).default(false),
    valuation: z
      .enum(['moving_average', 'fifo', ''])
      .optional()
      .transform((v) => (v ? v : undefined)),
    reorderLevel: optional(20),
    reorderQty: optional(20),
    standardRate: optional(20),
    description: optional(1000),
  })
  .meta({ id: 'FinanceItem' })

export const updateItemSchema = itemSchema
  .omit({ code: true, nature: true, hasBatch: true, hasSerial: true, uom: true })
  .partial()
  .extend({ itemId: z.uuid() })
  .meta({ id: 'FinanceItemUpdate' })

function qtyOrNull(v: string | undefined, what: string): number | null | undefined {
  if (v === undefined) return undefined
  const q = parseQty(v)
  if (q === null || q < 0) throw new FinanceError(400, 'bad_qty', `${what} is not a quantity`)
  return q
}

function moneyOrNull(v: string | undefined, what: string): number | null | undefined {
  if (v === undefined) return undefined
  const p = parseDecimal(v, 2)
  if (p === null || p < 0) throw new FinanceError(400, 'bad_amount', `${what} is not an amount`)
  return p
}

export async function createItem(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = itemSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await ensureUoms(tx, tenant)
      const [row] = await tx
        .insert(items)
        .values({
          institutionId: tenant,
          code: data.code,
          name: data.name,
          groupId: data.groupId ?? null,
          uom: data.uom,
          isStock: data.nature === 'stock',
          isAsset: data.nature === 'asset',
          assetCategoryId: data.assetCategoryId ?? null,
          hsnSac: data.hsnSac ?? null,
          taxTemplateId: data.taxTemplateId ?? null,
          expenseAccountId: data.expenseAccountId ?? null,
          incomeAccountId: data.incomeAccountId ?? null,
          hasBatch: data.nature === 'stock' && data.hasBatch,
          hasSerial: data.nature === 'stock' && data.hasSerial,
          valuation: data.valuation ?? null,
          reorderLevelMilli: qtyOrNull(data.reorderLevel, 'the reorder level') ?? null,
          reorderQtyMilli: qtyOrNull(data.reorderQty, 'the reorder quantity') || null,
          standardRatePaise: moneyOrNull(data.standardRate, 'the standard rate') ?? null,
          description: data.description ?? null,
        })
        .returning({ id: items.id })
      return { ...row!, notice: `${data.name} added.`, next: `/m/finance/item?id=${row!.id}` }
    }),
  )
}

export async function updateItem(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = updateItemSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const set: Partial<typeof items.$inferInsert> = {}
      if (data.name !== undefined) set.name = data.name
      if (data.groupId !== undefined) set.groupId = data.groupId
      if (data.assetCategoryId !== undefined) set.assetCategoryId = data.assetCategoryId
      if (data.hsnSac !== undefined) set.hsnSac = data.hsnSac
      if (data.taxTemplateId !== undefined) set.taxTemplateId = data.taxTemplateId
      if (data.expenseAccountId !== undefined) set.expenseAccountId = data.expenseAccountId
      if (data.incomeAccountId !== undefined) set.incomeAccountId = data.incomeAccountId
      if (data.description !== undefined) set.description = data.description
      const level = qtyOrNull(data.reorderLevel, 'the reorder level')
      if (level !== undefined) set.reorderLevelMilli = level
      const reorder = qtyOrNull(data.reorderQty, 'the reorder quantity')
      if (reorder !== undefined) set.reorderQtyMilli = reorder || null
      const rate = moneyOrNull(data.standardRate, 'the standard rate')
      if (rate !== undefined) set.standardRatePaise = rate
      if (data.valuation !== undefined) {
        // Changing how an item is valued while it is on a shelf would leave
        // layers that disagree with the balance. Empty the shelves first.
        const [held] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(stockBins)
          .where(and(eq(stockBins.itemId, data.itemId), sql`${stockBins.qtyMilli} <> 0`))
        if (held!.n > 0) {
          throw new FinanceError(409, 'valuation_in_use', 'an item is revalued only while none of it is in stock')
        }
        set.valuation = data.valuation
      }
      const [row] = await tx.update(items).set(set).where(eq(items.id, data.itemId)).returning({ id: items.id })
      if (!row) throw new FinanceError(404, 'no_such_item', 'no such item')
      return { ...row, notice: 'Saved.' }
    }),
  )
}

export async function archiveItem(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ itemId: z.uuid(), archived: z.preprocess(ticked, z.boolean()).default(true) }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .update(items)
      .set({ archivedAt: data.archived ? new Date() : null })
      .where(eq(items.id, data.itemId))
    return { notice: data.archived ? 'Archived.' : 'Restored.' }
  })
}

/** Items with what the stores hold of each, in all stores together. */
export async function listItems(actor: Actor, input: { q?: string; groupId?: string; archived?: boolean } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(items)
      .where(
        and(
          input.archived ? undefined : isNull(items.archivedAt),
          input.groupId ? eq(items.groupId, input.groupId) : undefined,
          input.q ? sql`(${items.name} ilike ${`%${input.q}%`} or ${items.code} ilike ${`%${input.q}%`})` : undefined,
        ),
      )
      .orderBy(asc(items.name))
    const held = await tx
      .select({
        itemId: stockBins.itemId,
        qty: sql<number>`sum(${stockBins.qtyMilli})::bigint`,
        value: sql<number>`sum(${stockBins.valuePaise})::bigint`,
      })
      .from(stockBins)
      .groupBy(stockBins.itemId)
    const by = new Map(held.map((h) => [h.itemId, { qty: Number(h.qty), value: Number(h.value) }]))
    return rows.map((i) => ({
      ...i,
      qtyMilli: by.get(i.id)?.qty ?? 0,
      valuePaise: by.get(i.id)?.value ?? 0,
      nature: i.isStock ? 'stock' : i.isAsset ? 'asset' : 'service',
    }))
  })
}

export async function itemWithin(tx: Tx, itemId: string) {
  const [row] = await tx.select().from(items).where(eq(items.id, itemId))
  if (!row) throw new FinanceError(404, 'no_such_item', 'no such item')
  return row
}

export async function itemChoices(tx: Tx, only?: 'stock' | 'any') {
  const rows = await tx
    .select({ id: items.id, code: items.code, name: items.name, uom: items.uom })
    .from(items)
    .where(and(isNull(items.archivedAt), only === 'stock' ? eq(items.isStock, true) : undefined))
    .orderBy(asc(items.name))
  return rows.map((r) => ({ value: r.id, label: `${r.name} (${r.code}, ${r.uom})` }))
}

export const warehouseSchema = z
  .object({
    code: text(1, 40),
    name: text(2, 120),
    parentId: optionalId,
    isGroup: z.preprocess(ticked, z.boolean()).default(false),
    stockAccountId: optionalId,
    costCenter: optional(80),
  })
  .meta({ id: 'FinanceWarehouse' })

export async function listWarehouses(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(warehouses).orderBy(asc(warehouses.code))
    const held = await tx
      .select({
        warehouseId: stockBins.warehouseId,
        value: sql<number>`sum(${stockBins.valuePaise})::bigint`,
        lines: sql<number>`count(*) filter (where ${stockBins.qtyMilli} <> 0)::int`,
      })
      .from(stockBins)
      .groupBy(stockBins.warehouseId)
    const by = new Map(held.map((h) => [h.warehouseId, h]))
    return rows.map((w) => ({
      ...w,
      valuePaise: Number(by.get(w.id)?.value ?? 0),
      itemsHeld: by.get(w.id)?.lines ?? 0,
    }))
  })
}

export async function createWarehouse(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = warehouseSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(warehouses)
        .values({ institutionId: tenant, ...data })
        .returning({ id: warehouses.id })
      return { ...row!, notice: `${data.name} added.` }
    }),
  )
}

export async function archiveWarehouse(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = z.object({ warehouseId: z.uuid(), archived: z.preprocess(ticked, z.boolean()).default(true) }).parse(input)
  return withTenant(tenant, async (tx) => {
    if (data.archived) {
      const [held] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(stockBins)
        .where(and(eq(stockBins.warehouseId, data.warehouseId), sql`${stockBins.qtyMilli} <> 0`))
      if (held!.n > 0) throw new FinanceError(409, 'warehouse_in_use', 'move or issue what is in that store first')
    }
    await tx
      .update(warehouses)
      .set({ archivedAt: data.archived ? new Date() : null })
      .where(eq(warehouses.id, data.warehouseId))
    return { notice: data.archived ? 'Archived.' : 'Restored.' }
  })
}

export async function warehouseChoices(tx: Tx) {
  const rows = await tx
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .where(and(isNull(warehouses.archivedAt), eq(warehouses.isGroup, false)))
    .orderBy(asc(warehouses.code))
  return rows.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` }))
}

export const batchSchema = z
  .object({
    itemId: z.uuid(),
    batchNo: text(1, 60),
    madeOn: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
    expiresOn: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
  })
  .meta({ id: 'FinanceBatch' })

export async function createBatch(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = batchSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await requireStores(tx, actor, [null])
      const item = await itemWithin(tx, data.itemId)
      if (!item.hasBatch) throw new FinanceError(400, 'not_batched', 'that item is not kept by batch')
      const [row] = await tx
        .insert(batches)
        .values({ institutionId: tenant, ...data })
        .returning({ id: batches.id })
      return { ...row!, notice: `Batch ${data.batchNo} added.` }
    }),
  )
}

/** A batch by number, made if it is new: a receipt names batches as they arrive. */
export async function batchFor(
  tx: Tx,
  institutionId: string,
  itemId: string,
  batchNo: string,
  dates: { madeOn?: string | null; expiresOn?: string | null } = {},
): Promise<string> {
  const [found] = await tx
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.itemId, itemId), eq(batches.batchNo, batchNo)))
  if (found) return found.id
  const [row] = await tx
    .insert(batches)
    .values({ institutionId, itemId, batchNo, madeOn: dates.madeOn ?? null, expiresOn: dates.expiresOn ?? null })
    .returning({ id: batches.id })
  return row!.id
}

export async function listBatches(actor: Actor, input: { itemId?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: batches.id,
        itemId: batches.itemId,
        itemName: items.name,
        batchNo: batches.batchNo,
        madeOn: batches.madeOn,
        expiresOn: batches.expiresOn,
        qtyMilli: sql<number>`coalesce((select sum(b.qty_milli) from finance_batch_bins b where b.batch_id = "finance_batches"."id"), 0)::bigint`,
      })
      .from(batches)
      .innerJoin(items, eq(items.id, batches.itemId))
      .where(input.itemId ? eq(batches.itemId, input.itemId) : undefined)
      .orderBy(asc(batches.expiresOn), asc(batches.batchNo))
    return rows.map((r) => ({ ...r, qtyMilli: Number(r.qtyMilli) }))
  })
}

// --- the engine --------------------------------------------------------------------

export interface Movement {
  itemId: string
  warehouseId: string
  /** Signed: in is positive, out is negative. */
  qtyMilli: number
  /** In only: what one unit is worth, in base minor units. */
  ratePaise?: number | null
  /** In only: the whole value, when it is known exactly (an invoice line's amount). Wins over the rate. */
  valuePaise?: number | null
  /**
   * A change of value with no change of quantity: a count that finds the
   * stock worth something else. Moving-average items only.
   */
  revaluePaise?: number | null
  batchId?: string | null
  serials?: string[] | null
  voucherLineId?: string | null
}

export interface Moved extends Movement {
  ledgerId: string
  valueChangePaise: number
  stockAccountId: string
}

interface Voucher {
  voucherType: string
  voucherId: string
  postingDate: string
}

/** The stock account a store's value sits in. */
export async function stockAccountOf(tx: Tx, institutionId: string, warehouseId: string, itemId?: string) {
  const [w] = await tx
    .select({ accountId: warehouses.stockAccountId })
    .from(warehouses)
    .where(eq(warehouses.id, warehouseId))
  if (!w) throw new FinanceError(404, 'no_such_warehouse', 'no such store')
  if (w.accountId) return w.accountId
  if (itemId) {
    const [g] = await tx
      .select({ accountId: itemGroups.stockAccountId })
      .from(items)
      .innerJoin(itemGroups, eq(itemGroups.id, items.groupId))
      .where(eq(items.id, itemId))
    if (g?.accountId) return g.accountId
  }
  return accountFor(tx, institutionId, 'stock_in_hand')
}

/** Where consuming an item is charged when the document does not say. */
export async function expenseAccountOf(tx: Tx, institutionId: string, itemId: string) {
  const [row] = await tx
    .select({ own: items.expenseAccountId, group: itemGroups.expenseAccountId })
    .from(items)
    .leftJoin(itemGroups, eq(itemGroups.id, items.groupId))
    .where(eq(items.id, itemId))
  return row?.own ?? row?.group ?? accountFor(tx, institutionId, 'purchase_expense')
}

/** What a unit of an item in a store is worth now: value over quantity, or its standard rate. */
export async function valuationRate(tx: Tx, itemId: string, warehouseId: string): Promise<number> {
  const [bin] = await tx
    .select({ qty: stockBins.qtyMilli, value: stockBins.valuePaise })
    .from(stockBins)
    .where(and(eq(stockBins.itemId, itemId), eq(stockBins.warehouseId, warehouseId)))
  if (bin && bin.qty > 0) return mulDiv(bin.value, 1000, bin.qty)
  const [last] = await tx
    .select({ qty: stockLedger.qtyChangeMilli, value: stockLedger.valueChangePaise })
    .from(stockLedger)
    .where(and(eq(stockLedger.itemId, itemId), gt(stockLedger.qtyChangeMilli, 0)))
    .orderBy(desc(stockLedger.seq))
    .limit(1)
  if (last) return mulDiv(last.value, 1000, last.qty)
  const item = await itemWithin(tx, itemId)
  return item.standardRatePaise ?? 0
}

/**
 * Move stock: value each movement and write it to the stock ledger.
 *
 * Movements are applied in order, so two lines of the same item in one
 * document see each other. Returns each with the value it moved and the
 * stock account that value sits in, for the caller's journal entry.
 */
export async function moveStock(tx: Tx, institutionId: string, movements: Movement[], voucher: Voucher): Promise<Moved[]> {
  const settings = await settingsWithin(tx, institutionId)
  const out: Moved[] = []
  for (const m of movements) {
    if (m.qtyMilli === 0 && !m.revaluePaise) continue
    const item = await itemWithin(tx, m.itemId)
    const valuation = item.valuation ?? settings.stockValuation

    if (m.batchId && m.qtyMilli < 0 && settings.blockExpiredBatches) {
      const [b] = await tx.select({ expiresOn: batches.expiresOn }).from(batches).where(eq(batches.id, m.batchId))
      if (b?.expiresOn && b.expiresOn < voucher.postingDate) {
        throw new FinanceError(409, 'batch_expired', `that batch expired on ${b.expiresOn}`)
      }
    }
    if (m.revaluePaise && valuation === 'fifo') {
      throw new FinanceError(400, 'fifo_revalue', 'a first-in-first-out item is valued by its receipts, not revalued')
    }

    // The bin as it stands. The ledger's trigger locks it again and checks
    // our arithmetic against it, so a race is refused rather than believed.
    const [bin] = await tx
      .select({ qty: stockBins.qtyMilli, value: stockBins.valuePaise })
      .from(stockBins)
      .where(and(eq(stockBins.itemId, m.itemId), eq(stockBins.warehouseId, m.warehouseId)))
      .for('update')
    const qty = bin?.qty ?? 0
    const value = bin?.value ?? 0
    const qtyAfter = qty + m.qtyMilli

    let change: number
    const consumed: { id: string; qty: number; value: number }[] = []
    if (m.qtyMilli > 0) {
      change =
        m.valuePaise ??
        extend(m.qtyMilli, m.ratePaise ?? (await valuationRate(tx, m.itemId, m.warehouseId)))
    } else if (m.qtyMilli === 0) {
      change = m.revaluePaise ?? 0
    } else if (valuation === 'fifo') {
      let need = -m.qtyMilli
      change = 0
      // Oldest first: by day, and within a day by the order they were
      // received in, which is the ledger's sequence.
      const layers = (
        await tx
          .select({ layer: stockLayers })
          .from(stockLayers)
          .innerJoin(stockLedger, eq(stockLedger.id, stockLayers.ledgerId))
          .where(
            and(
              eq(stockLayers.itemId, m.itemId),
              eq(stockLayers.warehouseId, m.warehouseId),
              gt(stockLayers.qtyLeftMilli, 0),
            ),
          )
          .orderBy(asc(stockLayers.postingDate), asc(stockLedger.seq))
          .for('update', { of: stockLayers })
      ).map((r) => r.layer)
      let lastRate = 0
      for (const l of layers) {
        if (need === 0) break
        const take = Math.min(need, l.qtyLeftMilli)
        const worth = take === l.qtyLeftMilli ? l.valueLeftPaise : mulDiv(take, l.valueLeftPaise, l.qtyLeftMilli)
        consumed.push({ id: l.id, qty: take, value: worth })
        change -= worth
        need -= take
        lastRate = mulDiv(l.valueLeftPaise, 1000, l.qtyLeftMilli)
      }
      // Past the last layer only if negative stock is allowed; the trigger
      // refuses it otherwise. What is not there is valued at the last price.
      if (need > 0) change -= extend(need, lastRate || (item.standardRatePaise ?? 0))
    } else if (qty > 0) {
      change = -mulDiv(-m.qtyMilli, value, qty)
    } else {
      change = -extend(-m.qtyMilli, await valuationRate(tx, m.itemId, m.warehouseId))
    }
    // An empty shelf is worth nothing: the last unit out takes whatever value
    // rounding has left behind with it.
    if (qtyAfter === 0) change = -value

    const [row] = await tx
      .insert(stockLedger)
      .values({
        institutionId,
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        batchId: m.batchId ?? null,
        postingDate: voucher.postingDate,
        voucherType: voucher.voucherType,
        voucherId: voucher.voucherId,
        voucherLineId: m.voucherLineId ?? null,
        qtyChangeMilli: m.qtyMilli,
        valueChangePaise: change,
        qtyAfterMilli: qtyAfter,
        valueAfterPaise: value + change,
        serials: m.serials?.length ? m.serials : item.hasSerial ? (m.serials ?? []) : null,
      })
      .returning({ id: stockLedger.id })

    if (valuation === 'fifo') {
      if (m.qtyMilli > 0) {
        await tx.insert(stockLayers).values({
          institutionId,
          itemId: m.itemId,
          warehouseId: m.warehouseId,
          ledgerId: row!.id,
          postingDate: voucher.postingDate,
          qtyLeftMilli: m.qtyMilli,
          valueLeftPaise: change,
        })
      }
      for (const c of consumed) {
        await tx
          .update(stockLayers)
          .set({
            qtyLeftMilli: sql`${stockLayers.qtyLeftMilli} - ${c.qty}`,
            valueLeftPaise: sql`${stockLayers.valueLeftPaise} - ${c.value}`,
          })
          .where(eq(stockLayers.id, c.id))
      }
    }

    out.push({
      ...m,
      ledgerId: row!.id,
      valueChangePaise: change,
      stockAccountId: await stockAccountOf(tx, institutionId, m.warehouseId, m.itemId),
    })
  }
  return out
}

/**
 * Take back what a voucher moved, on the day it moved it, newest movement
 * first. A first-in-first-out receipt is taken back only while all of it is
 * still on the shelf; an issue put back becomes a layer of its own.
 *
 * Returns what each reversal moved. Where rounding on the way out means the
 * reversal does not mirror the original to the paisa, the difference is posted
 * between the stock account and stock adjustments, so the books and the
 * stores still agree.
 */
export async function reverseStock(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  voucherType: string,
  voucherId: string,
): Promise<Moved[]> {
  const rows = await tx
    .select()
    .from(stockLedger)
    .where(and(eq(stockLedger.voucherType, voucherType), eq(stockLedger.voucherId, voucherId)))
    .orderBy(desc(stockLedger.seq))
  if (rows.length === 0) return []
  const settings = await settingsWithin(tx, institutionId)
  const out: Moved[] = []
  const residual = new Map<string, number>()

  for (const r of rows) {
    const item = await itemWithin(tx, r.itemId)
    const valuation = item.valuation ?? settings.stockValuation
    const [bin] = await tx
      .select({ qty: stockBins.qtyMilli, value: stockBins.valuePaise })
      .from(stockBins)
      .where(and(eq(stockBins.itemId, r.itemId), eq(stockBins.warehouseId, r.warehouseId)))
      .for('update')
    let change = -r.valueChangePaise
    const qtyAfter = bin!.qty - r.qtyChangeMilli
    if (qtyAfter === 0) change = -bin!.value

    let layer: typeof stockLayers.$inferSelect | undefined
    if (valuation === 'fifo' && r.qtyChangeMilli > 0) {
      ;[layer] = await tx.select().from(stockLayers).where(eq(stockLayers.ledgerId, r.id)).for('update')
      if (layer && layer.qtyLeftMilli !== r.qtyChangeMilli) {
        throw new FinanceError(
          409,
          'stock_consumed',
          'some of what it brought in has been issued since; return the rest with a new document instead',
        )
      }
    }

    const [row] = await named(() =>
      tx
        .insert(stockLedger)
        .values({
          institutionId,
          itemId: r.itemId,
          warehouseId: r.warehouseId,
          batchId: r.batchId,
          postingDate: r.postingDate,
          voucherType: r.voucherType,
          voucherId: r.voucherId,
          voucherLineId: r.voucherLineId,
          qtyChangeMilli: -r.qtyChangeMilli,
          valueChangePaise: change,
          qtyAfterMilli: qtyAfter,
          valueAfterPaise: bin!.value + change,
          serials: r.serials,
        })
        .returning({ id: stockLedger.id }),
    )

    if (layer) await tx.delete(stockLayers).where(eq(stockLayers.id, layer.id))
    if (valuation === 'fifo' && r.qtyChangeMilli < 0) {
      await tx.insert(stockLayers).values({
        institutionId,
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        ledgerId: row!.id,
        postingDate: r.postingDate,
        qtyLeftMilli: -r.qtyChangeMilli,
        valueLeftPaise: change,
      })
    }

    const stockAccountId = await stockAccountOf(tx, institutionId, r.warehouseId, r.itemId)
    if (change !== -r.valueChangePaise) {
      residual.set(stockAccountId, (residual.get(stockAccountId) ?? 0) + change + r.valueChangePaise)
    }
    out.push({
      itemId: r.itemId,
      warehouseId: r.warehouseId,
      qtyMilli: -r.qtyChangeMilli,
      batchId: r.batchId,
      serials: r.serials,
      voucherLineId: r.voucherLineId,
      ledgerId: row!.id,
      valueChangePaise: change,
      stockAccountId,
    })
  }

  const adjustments = [...residual].filter(([, v]) => v !== 0)
  if (adjustments.length) {
    const adjust = await accountFor(tx, institutionId, 'stock_adjustment')
    const lines = adjustments.flatMap(([accountId, v]) => [
      { accountId, debitPaise: v > 0 ? v : 0, creditPaise: v < 0 ? -v : 0 },
      { accountId: adjust, debitPaise: v < 0 ? -v : 0, creditPaise: v > 0 ? v : 0 },
    ])
    await postWithin(tx, institutionId, actorId, {
      postingDate: rows[0]!.postingDate,
      memo: 'Rounding left by a cancelled stock movement',
      sourceModule: 'finance',
      sourceRef: `stock-residual:${voucherType}:${voucherId}`,
      lines,
    })
  }
  return out
}

/** Journal lines for movements: each stock account against the other side, netted. */
export function stockLines(
  moved: Moved[],
  other: (m: Moved) => { accountId: string; costCenter?: string | null; fundId?: string | null },
  memo?: string,
) {
  const sums = new Map<string, { accountId: string; costCenter: string | null; fundId: string | null; v: number }>()
  const add = (accountId: string, costCenter: string | null, fundId: string | null, v: number) => {
    const k = `${accountId}|${costCenter ?? ''}|${fundId ?? ''}`
    const s = sums.get(k) ?? { accountId, costCenter, fundId, v: 0 }
    s.v += v
    sums.set(k, s)
  }
  for (const m of moved) {
    add(m.stockAccountId, null, null, m.valueChangePaise)
    const o = other(m)
    add(o.accountId, o.costCenter ?? null, o.fundId ?? null, -m.valueChangePaise)
  }
  return [...sums.values()]
    .filter((s) => s.v !== 0)
    .map((s) => ({
      accountId: s.accountId,
      debitPaise: s.v > 0 ? s.v : 0,
      creditPaise: s.v < 0 ? -s.v : 0,
      costCenter: s.costCenter,
      fundId: s.fundId,
      memo: memo ?? null,
    }))
}

// --- stock entries -----------------------------------------------------------------

const lineSchema = z.object({
  itemId: optionalId,
  fromWarehouseId: optionalId,
  toWarehouseId: optionalId,
  qty: optional(20),
  rate: optional(20),
  batchNo: optional(60),
  expiresOn: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
  serials: optional(4000),
})

export const stockEntrySchema = z
  .object({
    kind: z.enum(['receipt', 'issue', 'transfer', 'reconciliation']),
    postingDate: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
    memo: optional(500),
    costCenter: optional(80),
    fundId: optionalId,
    /** On an issue the expense charged; on a receipt or count, the other side. */
    accountId: optionalId,
    materialRequestId: optionalId,
    lines: z.array(lineSchema).max(200).default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceStockEntry' })

/** "SN1, SN2\nSN3" -> ["SN1", "SN2", "SN3"]. */
export const serialList = (s: string | undefined | null): string[] =>
  s
    ? [
        ...new Set(
          s
            .split(/[\s,;]+/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ]
    : []

export async function createStockEntry(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = stockEntrySchema.parse(input)
  const lines = data.lines.filter((l) => l.itemId && l.qty)
  if (lines.length === 0) throw new FinanceError(400, 'no_lines', 'a stock entry needs at least one line')

  return withTenant(tenant, (tx) =>
    named(async () => {
      const today = await localToday(tx, tenant)
      const fallback = await defaultWarehouse(tx, tenant)
      const prepared = []
      for (const [i, l] of lines.entries()) {
        const item = await itemWithin(tx, l.itemId!)
        if (!item.isStock) throw new FinanceError(400, 'not_stock', `${item.name} is not kept in the stores`)
        const qty = parseQty(l.qty)
        if (qty === null || qty < 0 || (qty === 0 && data.kind !== 'reconciliation')) {
          throw new FinanceError(400, 'bad_qty', `line ${i + 1}: the quantity is not a quantity`)
        }
        const rate = l.rate ? parseDecimal(l.rate, 2) : null
        if (l.rate && (rate === null || rate < 0)) {
          throw new FinanceError(400, 'bad_amount', `line ${i + 1}: the rate is not an amount`)
        }
        const from = data.kind === 'issue' || data.kind === 'transfer' ? (l.fromWarehouseId ?? fallback) : null
        const to = data.kind !== 'issue' ? (l.toWarehouseId ?? fallback) : null
        if (data.kind === 'transfer' && from === to) {
          throw new FinanceError(400, 'same_store', `line ${i + 1}: a transfer goes from one store to another`)
        }
        if (data.kind === 'reconciliation' && item.hasSerial) {
          throw new FinanceError(400, 'serial_count', `${item.name} is kept by serial number; receive or issue it instead`)
        }
        let batchId: string | null = null
        if (item.hasBatch) {
          if (!l.batchNo) throw new FinanceError(400, 'batch_required', `${item.name} is kept by batch; say which`)
          batchId =
            data.kind === 'receipt'
              ? await batchFor(tx, tenant, item.id, l.batchNo, { expiresOn: l.expiresOn })
              : await batchFor(tx, tenant, item.id, l.batchNo)
        }
        const list = serialList(l.serials)
        if (item.hasSerial && list.length * 1000 !== qty) {
          throw new FinanceError(400, 'serials_required', `${item.name}: list one serial number for each unit`)
        }
        prepared.push({
          institutionId: tenant,
          seq: i + 1,
          itemId: item.id,
          fromWarehouseId: from,
          toWarehouseId: to,
          qtyMilli: qty,
          ratePaise: rate,
          batchId,
          serials: list.length ? list : null,
        })
      }
      await requireStores(
        tx,
        actor,
        prepared.flatMap((p) => [p.fromWarehouseId, p.toWarehouseId]),
      )

      const [entry] = await tx
        .insert(stockEntries)
        .values({
          institutionId: tenant,
          kind: data.kind,
          postingDate: data.postingDate ?? today,
          memo: data.memo ?? null,
          costCenter: data.costCenter ?? null,
          fundId: data.fundId ?? null,
          accountId: data.accountId ?? null,
          materialRequestId: data.materialRequestId ?? null,
          createdBy: actor.id,
        })
        .returning({ id: stockEntries.id })
      await tx.insert(stockEntryLines).values(prepared.map((p) => ({ ...p, stockEntryId: entry!.id })))
      if (data.submit) return submitStockWithin(tx, actor, entry!.id)
      return { id: entry!.id, notice: 'Saved as a draft.', next: `/m/finance/stock-entry?id=${entry!.id}` }
    }),
  )
}

export async function submitStockEntry(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const { stockEntryId } = z.object({ stockEntryId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitStockWithin(tx, actor, stockEntryId)))
}

async function submitStockWithin(tx: Tx, actor: Actor, id: string) {
  const tenant = tenantOf(actor)
  const [entry] = await tx.select().from(stockEntries).where(eq(stockEntries.id, id)).for('update')
  if (!entry) throw new FinanceError(404, 'no_such_stock_entry', 'no such stock entry')
  if (entry.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that stock entry is not a draft')
  const lines = await tx
    .select()
    .from(stockEntryLines)
    .where(eq(stockEntryLines.stockEntryId, id))
    .orderBy(asc(stockEntryLines.seq))
  await requireStores(
    tx,
    actor,
    lines.flatMap((l) => [l.fromWarehouseId, l.toWarehouseId]),
  )
  const number = await nextNumber(tx, tenant, 'stock_entry', entry.postingDate)
  const voucher = { voucherType: 'stock_entry', voucherId: id, postingDate: entry.postingDate }

  const movements: Movement[] = []
  /** The out halves of transfers, moved first so the in halves carry their value. */
  const movedEarly: Moved[] = []
  for (const l of lines) {
    if (entry.kind === 'receipt') {
      movements.push({
        itemId: l.itemId,
        warehouseId: l.toWarehouseId!,
        qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise,
        batchId: l.batchId,
        serials: l.serials,
        voucherLineId: l.id,
      })
    } else if (entry.kind === 'issue') {
      movements.push({
        itemId: l.itemId,
        warehouseId: l.fromWarehouseId!,
        qtyMilli: -l.qtyMilli,
        batchId: l.batchId,
        serials: l.serials,
        voucherLineId: l.id,
      })
    } else if (entry.kind === 'reconciliation') {
      // A count: the line says how much is there, the ledger says how much
      // should be; the difference moves, at the rate typed or the store's own.
      const [held] = l.batchId
        ? await tx
            .select({ qty: batchBins.qtyMilli })
            .from(batchBins)
            .where(and(eq(batchBins.batchId, l.batchId), eq(batchBins.warehouseId, l.toWarehouseId!)))
        : await tx
            .select({ qty: stockBins.qtyMilli })
            .from(stockBins)
            .where(and(eq(stockBins.itemId, l.itemId), eq(stockBins.warehouseId, l.toWarehouseId!)))
      const diff = l.qtyMilli - (held?.qty ?? 0)
      if (diff !== 0) {
        movements.push({
          itemId: l.itemId,
          warehouseId: l.toWarehouseId!,
          qtyMilli: diff,
          ratePaise: diff > 0 ? l.ratePaise : null,
          batchId: l.batchId,
          voucherLineId: l.id,
        })
      } else if (l.ratePaise !== null && !l.batchId) {
        const [bin] = await tx
          .select({ value: stockBins.valuePaise })
          .from(stockBins)
          .where(and(eq(stockBins.itemId, l.itemId), eq(stockBins.warehouseId, l.toWarehouseId!)))
        const revalue = extend(l.qtyMilli, l.ratePaise) - (bin?.value ?? 0)
        if (revalue !== 0 && l.qtyMilli > 0) {
          movements.push({
            itemId: l.itemId,
            warehouseId: l.toWarehouseId!,
            qtyMilli: 0,
            revaluePaise: revalue,
            voucherLineId: l.id,
          })
        }
      }
    } else {
      // A transfer: out of one store at its value, into the other at the same.
      const [outOf] = await moveStock(
        tx,
        tenant,
        [
          {
            itemId: l.itemId,
            warehouseId: l.fromWarehouseId!,
            qtyMilli: -l.qtyMilli,
            batchId: l.batchId,
            serials: l.serials,
            voucherLineId: l.id,
          },
        ],
        voucher,
      )
      movements.push({
        itemId: l.itemId,
        warehouseId: l.toWarehouseId!,
        qtyMilli: l.qtyMilli,
        valuePaise: -outOf!.valueChangePaise,
        batchId: l.batchId,
        serials: l.serials,
        voucherLineId: l.id,
      })
      movedEarly.push(outOf!)
    }
  }

  const moved = [...movedEarly, ...(await moveStock(tx, tenant, movements, voucher))]
  // What each line came to: the value that moved, counted once for a transfer.
  const amounts = new Map<string, number>()
  for (const m of moved) {
    if (entry.kind === 'transfer' && m.qtyMilli < 0) continue
    amounts.set(m.voucherLineId!, (amounts.get(m.voucherLineId!) ?? 0) + Math.abs(m.valueChangePaise))
  }
  for (const l of lines) {
    await tx
      .update(stockEntryLines)
      .set({ amountPaise: amounts.get(l.id) ?? 0 })
      .where(eq(stockEntryLines.id, l.id))
  }

  let entryId: string | null = null
  const issueCostCenter = entry.costCenter
  const otherSide = entry.accountId ?? (await accountFor(tx, tenant, 'stock_adjustment'))
  const glLines =
    entry.kind === 'issue'
      ? await (async () => {
          const expense = new Map<string, string>()
          for (const m of moved) {
            if (!expense.has(m.itemId)) {
              expense.set(m.itemId, entry.accountId ?? (await expenseAccountOf(tx, tenant, m.itemId)))
            }
          }
          const wCenters = new Map<string, string | null>()
          for (const m of moved) {
            if (!wCenters.has(m.warehouseId)) {
              const [w] = await tx
                .select({ c: warehouses.costCenter })
                .from(warehouses)
                .where(eq(warehouses.id, m.warehouseId))
              wCenters.set(m.warehouseId, w?.c ?? null)
            }
          }
          return stockLines(moved, (m) => ({
            accountId: expense.get(m.itemId)!,
            costCenter: issueCostCenter ?? wCenters.get(m.warehouseId) ?? null,
            fundId: entry.fundId,
          }))
        })()
      : stockLines(moved, () => ({ accountId: otherSide, fundId: entry.fundId }))

  if (glLines.length >= 2) {
    const posted = await postWithin(tx, tenant, actor.id, {
      postingDate: entry.postingDate,
      memo: `Stock ${entry.kind} ${number}${entry.memo ? `: ${entry.memo}` : ''}`.slice(0, 200),
      sourceModule: 'finance',
      sourceRef: `stock_entry:${id}`,
      lines: glLines,
    })
    entryId = posted.id
  }

  await tx.update(stockEntries).set({ number, entryId }).where(eq(stockEntries.id, id))
  await submitDocument(tx, stockEntries, id, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: 'finance' })
  return { id, number, notice: `${number} submitted.`, next: `/m/finance/stock-entry?id=${id}` }
}

export async function cancelStockEntry(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = z.object({ stockEntryId: z.uuid(), reason: text(5, 300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [entry] = await tx.select().from(stockEntries).where(eq(stockEntries.id, data.stockEntryId)).for('update')
      if (!entry) throw new FinanceError(404, 'no_such_stock_entry', 'no such stock entry')
      if (entry.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted entry is cancelled')
      const lines = await tx.select().from(stockEntryLines).where(eq(stockEntryLines.stockEntryId, entry.id))
      await requireStores(
        tx,
        actor,
        lines.flatMap((l) => [l.fromWarehouseId, l.toWarehouseId]),
      )
      await reverseStock(tx, tenant, actor.id, 'stock_entry', entry.id)
      if (entry.entryId) await reverseWithin(tx, tenant, actor.id, entry.entryId, data.reason)
      await cancelDocument(tx, stockEntries, entry.id, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email,
        moduleId: 'finance',
        reason: data.reason,
      })
      return { notice: `${entry.number} cancelled.` }
    }),
  )
}

export async function deleteStockEntry(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const { stockEntryId } = z.object({ stockEntryId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [entry] = await tx.select().from(stockEntries).where(eq(stockEntries.id, stockEntryId))
      if (!entry) throw new FinanceError(404, 'no_such_stock_entry', 'no such stock entry')
      if (entry.createdBy !== actor.id) requireOperate(actor)
      await tx.delete(stockEntries).where(eq(stockEntries.id, stockEntryId))
      return { notice: 'Draft deleted.', next: '/m/finance/stock-entries' }
    }),
  )
}

export async function listStockEntries(actor: Actor, input: { kind?: string; status?: string } = {}) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    await requireStores(tx, actor, [null])
    return tx
      .select()
      .from(stockEntries)
      .where(
        and(
          input.kind ? eq(stockEntries.kind, input.kind as 'receipt') : undefined,
          input.status ? eq(stockEntries.docstatus, input.status as 'draft') : undefined,
        ),
      )
      .orderBy(desc(stockEntries.postingDate), desc(stockEntries.createdAt))
      .limit(500)
  })
}

export async function stockEntryDetail(actor: Actor, stockEntryId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    await requireStores(tx, actor, [null])
    const [entry] = await tx.select().from(stockEntries).where(eq(stockEntries.id, stockEntryId))
    if (!entry) throw new FinanceError(404, 'no_such_stock_entry', 'no such stock entry')
    const lines = await tx
      .select({
        line: stockEntryLines,
        itemName: items.name,
        itemCode: items.code,
        uom: items.uom,
        batchNo: batches.batchNo,
      })
      .from(stockEntryLines)
      .innerJoin(items, eq(items.id, stockEntryLines.itemId))
      .leftJoin(batches, eq(batches.id, stockEntryLines.batchId))
      .where(eq(stockEntryLines.stockEntryId, stockEntryId))
      .orderBy(asc(stockEntryLines.seq))
    const names = new Map((await tx.select().from(warehouses)).map((w) => [w.id, w.name]))
    return {
      entry,
      lines: lines.map((l) => ({
        ...l.line,
        itemName: l.itemName,
        itemCode: l.itemCode,
        uom: l.uom,
        batchNo: l.batchNo,
        from: l.line.fromWarehouseId ? names.get(l.line.fromWarehouseId) : null,
        to: l.line.toWarehouseId ? names.get(l.line.toWarehouseId) : null,
        qty: formatQty(l.line.qtyMilli),
      })),
    }
  })
}

// --- reports -----------------------------------------------------------------------

/** What each store holds of each item, and what it is worth, on a day (today if none). */
export async function stockBalance(actor: Actor, input: { on?: string; warehouseId?: string; itemId?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const res = await tx.execute(sql`
      with last as (
        select distinct on (l.item_id, l.warehouse_id)
               l.item_id, l.warehouse_id, l.qty_after_milli, l.value_after_paise
          from finance_stock_ledger l
         where (${input.on ?? null}::date is null or l.posting_date <= ${input.on ?? null}::date)
         order by l.item_id, l.warehouse_id, l.posting_date desc, l.seq desc
      )
      select i.id as item_id, i.code, i.name, i.uom, w.id as warehouse_id, w.name as warehouse,
             last.qty_after_milli::bigint as qty, last.value_after_paise::bigint as value,
             i.reorder_level_milli::bigint as reorder_level
        from last
        join finance_items i on i.id = last.item_id
        join finance_warehouses w on w.id = last.warehouse_id
       where (last.qty_after_milli <> 0 or last.value_after_paise <> 0)
         and (${input.warehouseId ?? null}::uuid is null or w.id = ${input.warehouseId ?? null}::uuid)
         and (${input.itemId ?? null}::uuid is null or i.id = ${input.itemId ?? null}::uuid)
       order by i.name, w.name`)
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const qty = Number(r.qty)
      const value = Number(r.value)
      return {
        itemId: String(r.item_id),
        code: String(r.code),
        name: String(r.name),
        uom: String(r.uom),
        warehouseId: String(r.warehouse_id),
        warehouse: String(r.warehouse),
        qtyMilli: qty,
        valuePaise: value,
        ratePaise: qty > 0 ? mulDiv(value, 1000, qty) : 0,
      }
    })
  })
}

/** Every movement of an item, with the running balance after each. */
export async function stockLedgerReport(
  actor: Actor,
  input: { itemId?: string; warehouseId?: string; from?: string; to?: string } = {},
) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        row: stockLedger,
        itemName: items.name,
        uom: items.uom,
        warehouse: warehouses.name,
        batchNo: batches.batchNo,
      })
      .from(stockLedger)
      .innerJoin(items, eq(items.id, stockLedger.itemId))
      .innerJoin(warehouses, eq(warehouses.id, stockLedger.warehouseId))
      .leftJoin(batches, eq(batches.id, stockLedger.batchId))
      .where(
        and(
          input.itemId ? eq(stockLedger.itemId, input.itemId) : undefined,
          input.warehouseId ? eq(stockLedger.warehouseId, input.warehouseId) : undefined,
          input.from ? sql`${stockLedger.postingDate} >= ${input.from}` : undefined,
          input.to ? lte(stockLedger.postingDate, input.to) : undefined,
        ),
      )
      .orderBy(asc(stockLedger.postingDate), asc(stockLedger.seq))
      .limit(2000)
    return rows.map((r) => ({
      ...r.row,
      itemName: r.itemName,
      uom: r.uom,
      warehouse: r.warehouse,
      batchNo: r.batchNo,
    }))
  })
}

/** Items at or below their reorder level across all stores, with what to order. */
export async function reorderReport(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const res = await tx.execute(sql`
      select i.id, i.code, i.name, i.uom, i.reorder_level_milli::bigint as level, i.reorder_qty_milli::bigint as reorder,
             coalesce(sum(b.qty_milli), 0)::bigint as held,
             coalesce((select sum(ol.qty_milli - coalesce((
                                select sum(case when r.is_return then -rl.qty_milli else rl.qty_milli end)
                                  from finance_receipt_lines rl
                                  join finance_receipts r on r.id = rl.receipt_id
                                 where rl.order_line_id = ol.id and r.docstatus = 'submitted'), 0))
                         from finance_order_lines ol
                         join finance_orders o on o.id = ol.order_id
                        where ol.item_id = i.id and o.kind = 'purchase_order' and o.docstatus = 'submitted'
                          and not exists (select 1 from finance_order_closures c where c.order_id = o.id)), 0)::bigint as on_order
        from finance_items i
        left join finance_stock_bins b on b.item_id = i.id
       where i.is_stock and i.archived_at is null and i.reorder_level_milli is not null
       group by i.id
      having coalesce(sum(b.qty_milli), 0) <= i.reorder_level_milli
       order by i.name`)
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      itemId: String(r.id),
      code: String(r.code),
      name: String(r.name),
      uom: String(r.uom),
      levelMilli: Number(r.level),
      heldMilli: Number(r.held),
      onOrderMilli: Math.max(Number(r.on_order), 0),
      suggestMilli: Math.max(Number(r.reorder ?? 0) || Number(r.level) - Number(r.held), 0),
    }))
  })
}

/** Batches that have expired, or expire within `days`, with stock still on hand. */
export async function expiryReport(actor: Actor, input: { days?: number } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const today = await localToday(tx, tenant)
    const rows = await tx
      .select({
        batchNo: batches.batchNo,
        expiresOn: batches.expiresOn,
        itemName: items.name,
        uom: items.uom,
        warehouse: warehouses.name,
        qtyMilli: batchBins.qtyMilli,
      })
      .from(batchBins)
      .innerJoin(batches, eq(batches.id, batchBins.batchId))
      .innerJoin(items, eq(items.id, batches.itemId))
      .innerJoin(warehouses, eq(warehouses.id, batchBins.warehouseId))
      .where(
        and(
          gt(batchBins.qtyMilli, 0),
          sql`${batches.expiresOn} is not null and ${batches.expiresOn} <= ${today}::date + ${input.days ?? 60}::int`,
        ),
      )
      .orderBy(asc(batches.expiresOn))
    return rows.map((r) => ({ ...r, expired: !!r.expiresOn && r.expiresOn < today }))
  })
}

export async function serialRegister(actor: Actor, input: { itemId?: string; q?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) =>
    tx
      .select({
        serialNo: serials.serialNo,
        status: serials.status,
        itemName: items.name,
        warehouse: warehouses.name,
        assetId: serials.assetId,
      })
      .from(serials)
      .innerJoin(items, eq(items.id, serials.itemId))
      .leftJoin(warehouses, eq(warehouses.id, serials.warehouseId))
      .where(
        and(
          input.itemId ? eq(serials.itemId, input.itemId) : undefined,
          input.q ? sql`${serials.serialNo} ilike ${`%${input.q}%`}` : undefined,
        ),
      )
      .orderBy(asc(items.name), asc(serials.serialNo))
      .limit(2000),
  )
}

/**
 * Whether the stores and the books agree: the value the stock ledger holds
 * against each stock account, beside that account's balance. They differ only
 * if somebody has posted to a stock account by hand.
 */
export async function stockAgainstBooks(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const bins = await tx
      .select({ warehouseId: stockBins.warehouseId, itemId: stockBins.itemId, value: stockBins.valuePaise })
      .from(stockBins)
      .where(sql`${stockBins.valuePaise} <> 0`)
    const held = new Map<string, number>()
    for (const b of bins) {
      const acc = await stockAccountOf(tx, tenant, b.warehouseId, b.itemId)
      held.set(acc, (held.get(acc) ?? 0) + b.value)
    }
    const ids = [...held.keys()]
    const books = ids.length
      ? await tx
          .select({
            id: accounts.id,
            code: accounts.code,
            name: accounts.name,
            books: sql<number>`coalesce(sum(${glLines.debitPaise} - ${glLines.creditPaise}), 0)::bigint`,
          })
          .from(accounts)
          .leftJoin(glLines, eq(glLines.accountId, accounts.id))
          .where(inArray(accounts.id, ids))
          .groupBy(accounts.id)
          .orderBy(asc(accounts.code))
      : []
    return books.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      storesPaise: held.get(r.id) ?? 0,
      booksPaise: Number(r.books),
      differencePaise: Number(r.books) - (held.get(r.id) ?? 0),
    }))
  })
}

