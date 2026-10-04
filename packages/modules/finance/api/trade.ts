import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { amendDocument, cancelDocument, submitDocument, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import {
  invoiceLines,
  invoices,
  items,
  orderClosures,
  orderLines,
  orders,
  parties,
  receiptLines,
  receipts,
  recurring,
  stockLedger,
  supplierQuotationLines,
  supplierQuotations,
} from '../schema'
import { FinanceError, named, requireOperate, requireRead, without, type Actor, type Tx } from './core'
import { saveDraftWithin, submitWithin, type DraftLine } from './invoices'
import { addMonths, bpOf, extend, formatDecimal, formatQty, mulDiv, parseDecimal, parseQty, toBase } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'
import { partyWithin } from './parties'
import { approvalsFor, assertApproved, minorUnitsOf, nextNumber, rateOn } from './setup'
import { batchFor, defaultWarehouse, moveStock, reverseStock, serialList, stockLines, type Movement } from './stock'
import { computeTaxes, isIntraState, templatesWithin } from './tax'
import { localToday, settingsWithin } from './years'

/**
 * Orders and the goods that move against them.
 *
 *   quotation      what was offered a customer; becomes a sales order when taken
 *   sales order    what a customer ordered; delivered by delivery notes, billed by invoices
 *   purchase order what was ordered from a supplier, approved by whoever the
 *                  institution's rules say; received by goods receipts, billed
 *                  by purchase invoices
 *
 * A goods receipt puts stock in the store at the order's price and owes the
 * supplier for it before their bill arrives (goods received, not billed); the
 * bill then clears that, and any difference in price is a stock adjustment. A
 * delivery note takes stock out at what it is worth and charges it to cost of
 * goods. The database refuses receiving or billing more than was ordered.
 */

const MODULE = 'finance'
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
const optionalDate = z.iso
  .date()
  .optional()
  .or(z.literal('').transform(() => undefined))

export type OrderKind = 'purchase_order' | 'sales_order' | 'quotation'
const sideOf = (kind: OrderKind) => (kind === 'purchase_order' ? 'purchase' : 'sales')

// --- orders -------------------------------------------------------------------------

export const orderSchema = z
  .object({
    orderId: optionalId,
    kind: z.enum(['purchase_order', 'sales_order', 'quotation']),
    partyId: z.uuid(),
    postingDate: optionalDate,
    deliverBy: optionalDate,
    validTill: optionalDate,
    currency: optional(3).transform((v) => v?.toUpperCase()),
    exchangeRate: optional(24),
    placeOfSupply: optional(2),
    warehouseId: optionalId,
    costCenter: optional(80),
    fundId: optionalId,
    terms: optional(4000),
    memo: optional(500),
    lines: z
      .array(
        z.object({
          itemId: optionalId,
          description: optional(500),
          qty: optional(20),
          rate: optional(24),
          discount: optional(8),
          taxTemplateId: optionalId,
          warehouseId: optionalId,
          costCenter: optional(80),
          deliverBy: optionalDate,
          requestLineId: optionalId,
          quotationLineId: optionalId,
        }),
      )
      .max(300)
      .default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceOrder' })

type OrderInput = z.infer<typeof orderSchema>

async function computeOrder(tx: Tx, institutionId: string, data: OrderInput) {
  const settings = await settingsWithin(tx, institutionId)
  const party = await partyWithin(tx, data.partyId)
  const side = sideOf(data.kind)
  if (side === 'purchase' && !party.isSupplier) throw new FinanceError(400, 'not_supplier', `${party.name} is not a supplier`)
  if (side === 'sales' && !party.isCustomer) throw new FinanceError(400, 'not_customer', `${party.name} is not a customer`)
  const postingDate = data.postingDate ?? (await localToday(tx, institutionId))
  const currency = data.currency ?? party.currency ?? settings.baseCurrency
  const foreign = currency !== settings.baseCurrency
  const exchangeRate = foreign ? (data.exchangeRate ?? (await rateOn(tx, institutionId, currency, postingDate))) : '1'
  const fcMinor = await minorUnitsOf(tx, institutionId, currency)
  const baseMinor = await minorUnitsOf(tx, institutionId, settings.baseCurrency)

  const typed = data.lines.filter((l) => l.itemId || l.description)
  if (typed.length === 0) throw new FinanceError(400, 'no_lines', 'an order needs at least one line')
  const itemRows = await tx
    .select()
    .from(items)
    .where(inArray(items.id, [...new Set(typed.map((l) => l.itemId).filter((x): x is string => !!x))].concat(['00000000-0000-0000-0000-000000000000'])))
  const itemBy = new Map(itemRows.map((i) => [i.id, i]))
  const lines = typed.map((l, i) => {
    const at = `line ${i + 1}`
    const item = l.itemId ? itemBy.get(l.itemId) : undefined
    if (l.itemId && !item) throw new FinanceError(400, 'no_such_item', `${at}: no such item`)
    if (!item) throw new FinanceError(400, 'item_required', `${at}: an order line names an item`)
    const qty = parseQty(l.qty ?? '1')
    if (qty === null || qty <= 0) throw new FinanceError(400, 'bad_qty', `${at}: the quantity is not a quantity`)
    const rate = parseDecimal(l.rate ?? '0', fcMinor)
    if (rate === null || rate < 0) throw new FinanceError(400, 'bad_amount', `${at}: the rate is not an amount`)
    const discount = l.discount ? parseDecimal(l.discount, 2) : 0
    if (discount === null || discount < 0 || discount > 10_000) throw new FinanceError(400, 'bad_discount', `${at}: the discount is a percentage up to 100`)
    const gross = extend(qty, rate)
    return {
      seq: i + 1,
      itemId: item.id,
      description: l.description ?? item.name,
      qtyMilli: qty,
      rateFc: rate,
      discountBp: discount,
      amountFc: gross - bpOf(gross, discount),
      taxTemplateId: l.taxTemplateId ?? item.taxTemplateId ?? null,
      warehouseId: item.isStock ? (l.warehouseId ?? data.warehouseId ?? null) : null,
      costCenter: l.costCenter ?? data.costCenter ?? null,
      requestLineId: l.requestLineId ?? null,
      quotationLineId: l.quotationLineId ?? null,
      deliverBy: l.deliverBy ?? data.deliverBy ?? null,
    }
  })
  const overseas = party.gstCategory === 'overseas' || party.gstCategory === 'sez'
  const placeOfSupply = data.placeOfSupply ?? (side === 'sales' ? (party.stateCode ?? settings.stateCode) : settings.stateCode)
  const intra = side === 'sales' ? isIntraState(settings.stateCode, placeOfSupply, overseas) : isIntraState(party.stateCode, placeOfSupply, overseas)
  const templates = await templatesWithin(tx, [...new Set(lines.map((l) => l.taxTemplateId).filter((x): x is string => !!x))])
  const taxFc = computeTaxes(
    lines.map((l) => ({ amount: l.amountFc, templateId: l.taxTemplateId })),
    templates,
    intra,
    side,
  ).reduce((n, t) => n + t.tax, 0)
  const netFc = lines.reduce((n, l) => n + l.amountFc, 0)
  const totalFc = netFc + taxFc
  return {
    header: {
      kind: data.kind,
      partyId: party.id,
      postingDate,
      deliverBy: data.deliverBy ?? null,
      validTill: data.validTill ?? null,
      currency,
      exchangeRate,
      placeOfSupply: placeOfSupply ?? null,
      warehouseId: data.warehouseId ?? null,
      netFc,
      taxFc,
      totalFc,
      totalPaise: foreign ? toBase(totalFc, exchangeRate, fcMinor, baseMinor) : totalFc,
      costCenter: data.costCenter ?? null,
      fundId: data.fundId ?? null,
      terms: data.terms ?? null,
      memo: data.memo ?? null,
    },
    lines,
  }
}

export async function saveOrderWithin(
  tx: Tx,
  actor: Actor,
  input: z.input<typeof orderSchema>,
  extra: { fromQuotationId?: string | null; supplierQuotationId?: string | null } = {},
) {
  const tenant = actor.institutionId!
  const data = orderSchema.parse(input)
  const c = await computeOrder(tx, tenant, data)
  let id = data.orderId
  if (id) {
    const [row] = await tx.select().from(orders).where(eq(orders.id, id)).for('update')
    if (!row) throw new FinanceError(404, 'no_such_order', 'no such order')
    if (row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
    await tx.update(orders).set(c.header).where(eq(orders.id, id))
    await tx.delete(orderLines).where(eq(orderLines.orderId, id))
  } else {
    const [row] = await tx
      .insert(orders)
      .values({ ...c.header, ...extra, institutionId: tenant, createdBy: actor.id })
      .returning({ id: orders.id })
    id = row!.id
  }
  await tx.insert(orderLines).values(c.lines.map((l) => ({ ...l, institutionId: tenant, orderId: id! })))
  return id!
}

export async function saveOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = orderSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const id = await saveOrderWithin(tx, actor, data)
      if (data.submit) return submitOrderWithin(tx, actor, id)
      return { id, notice: 'Saved as a draft.', next: `/m/finance/order?id=${id}` }
    }),
  )
}

export function approvalViewOfOrder(o: typeof orders.$inferSelect, ls: (typeof orderLines.$inferSelect)[]) {
  return {
    partyId: o.partyId,
    currency: o.currency,
    totalFc: o.totalFc,
    lines: ls.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli, rateFc: l.rateFc, discountBp: l.discountBp })),
  }
}

async function submitOrderWithin(tx: Tx, actor: Actor, orderId: string) {
  const tenant = actor.institutionId!
  const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update')
  if (!o) throw new FinanceError(404, 'no_such_order', 'no such order')
  if (o.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that order is not a draft')
  const ls = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.seq))
  if (o.kind === 'purchase_order') await assertApproved(tx, 'purchase_order', orderId, approvalViewOfOrder(o, ls), o.totalPaise)
  const number = await nextNumber(tx, tenant, o.kind, o.postingDate)
  await tx.update(orders).set({ number }).where(eq(orders.id, orderId))
  await submitDocument(tx, orders, orderId, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE })
  return { id: orderId, number, notice: `${number} submitted.`, next: `/m/finance/order?id=${orderId}` }
}

export async function submitOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { orderId } = z.object({ orderId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitOrderWithin(tx, actor, orderId)))
}

/** What each line of an order has had done to it: received or delivered, and billed. */
export async function orderProgress(tx: Tx, orderId: string) {
  const ls = await tx
    .select({ line: orderLines, isStock: items.isStock, uom: items.uom })
    .from(orderLines)
    .innerJoin(items, eq(items.id, orderLines.itemId))
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.seq))
  const ids = ls.map((l) => l.line.id).concat(['00000000-0000-0000-0000-000000000000'])
  const moved = await tx
    .select({
      orderLineId: receiptLines.orderLineId,
      qty: sql<number>`sum(case when ${receipts.isReturn} then -${receiptLines.qtyMilli} else ${receiptLines.qtyMilli} end)::bigint`,
    })
    .from(receiptLines)
    .innerJoin(receipts, eq(receipts.id, receiptLines.receiptId))
    .where(and(inArray(receiptLines.orderLineId, ids), eq(receipts.docstatus, 'submitted')))
    .groupBy(receiptLines.orderLineId)
  const billed = await tx
    .select({
      orderLineId: invoiceLines.orderLineId,
      qty: sql<number>`sum(case when ${invoices.isReturn} then -${invoiceLines.qtyMilli} else ${invoiceLines.qtyMilli} end)::bigint`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(inArray(invoiceLines.orderLineId, ids), eq(invoices.docstatus, 'submitted')))
    .groupBy(invoiceLines.orderLineId)
  const ordered = await tx
    .select({
      quotationLineId: orderLines.quotationLineId,
      qty: sql<number>`sum(${orderLines.qtyMilli})::bigint`,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(inArray(orderLines.quotationLineId, ids), eq(orders.docstatus, 'submitted')))
    .groupBy(orderLines.quotationLineId)
  const of = (rows: { qty: number }[], pick: (r: never) => string | null, id: string) =>
    Number((rows as never[]).find((r) => pick(r) === id)?.['qty' as never] ?? 0)
  return ls.map((l) => ({
    ...l.line,
    isStock: l.isStock,
    uom: l.uom,
    movedMilli: of(moved, (r: { orderLineId: string | null }) => r.orderLineId, l.line.id),
    billedMilli: of(billed, (r: { orderLineId: string | null }) => r.orderLineId, l.line.id),
    orderedMilli: of(ordered, (r: { quotationLineId: string | null }) => r.quotationLineId, l.line.id),
  }))
}

export type OrderStatus =
  | 'draft'
  | 'cancelled'
  | 'closed'
  | 'completed'
  | 'to_receive_and_bill'
  | 'to_receive'
  | 'to_deliver_and_bill'
  | 'to_deliver'
  | 'to_bill'
  | 'open'
  | 'ordered'
  | 'expired'

export function orderStatusOf(
  o: { kind: string; docstatus: string; validTill: string | null },
  progress: Awaited<ReturnType<typeof orderProgress>>,
  closed: boolean,
  today: string,
): OrderStatus {
  if (o.docstatus === 'draft') return 'draft'
  if (o.docstatus === 'cancelled') return 'cancelled'
  if (o.kind === 'quotation') {
    if (progress.length && progress.every((l) => l.orderedMilli >= l.qtyMilli)) return 'ordered'
    if (closed || (o.validTill && o.validTill < today)) return 'expired'
    return 'open'
  }
  if (closed) return 'closed'
  const toMove = progress.some((l) => l.isStock && l.movedMilli < l.qtyMilli)
  const toBill = progress.some((l) => l.billedMilli < l.qtyMilli)
  const purchase = o.kind === 'purchase_order'
  if (toMove && toBill) return purchase ? 'to_receive_and_bill' : 'to_deliver_and_bill'
  if (toMove) return purchase ? 'to_receive' : 'to_deliver'
  if (toBill) return 'to_bill'
  return 'completed'
}

export async function cancelOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ orderId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, data.orderId)).for('update')
      if (!o) throw new FinanceError(404, 'no_such_order', 'no such order')
      const progress = await orderProgress(tx, o.id)
      if (progress.some((l) => l.movedMilli > 0 || l.billedMilli > 0 || l.orderedMilli > 0)) {
        throw new FinanceError(409, 'order_in_use', 'something has been received, delivered, billed or ordered against it; close it short instead')
      }
      await cancelDocument(tx, orders, o.id, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email,
        moduleId: MODULE,
        reason: data.reason,
      })
      return { notice: `${o.number} cancelled.` }
    }),
  )
}

/** Close an order short: what has not come will not come. */
export async function closeOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ orderId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, data.orderId))
      if (!o || o.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted order is closed')
      await tx
        .insert(orderClosures)
        .values({ orderId: o.id, institutionId: tenant, reason: data.reason, closedBy: actor.id })
        .onConflictDoNothing()
      return { notice: `${o.number} closed.` }
    }),
  )
}

export async function amendOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { orderId } = z.object({ orderId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const copy = await amendDocument(
        tx,
        orders,
        orderId,
        { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE },
        { number: null, created_by: actor.id },
      )
      const newId = String(copy.id)
      const ls = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId))
      await tx.insert(orderLines).values(ls.map((l) => ({ ...without(l, 'id'), orderId: newId })))
      return { id: newId, notice: 'Amended into a new draft.', next: `/m/finance/order?id=${newId}` }
    }),
  )
}

export async function deleteOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { orderId } = z.object({ orderId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, orderId))
      await tx.delete(orders).where(eq(orders.id, orderId))
      return { notice: 'Draft deleted.', next: `/m/finance/orders?kind=${o?.kind ?? 'purchase_order'}` }
    }),
  )
}

export async function listOrders(actor: Actor, input: { kind: OrderKind; status?: string; partyId?: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const today = await localToday(tx, tenant)
    const rows = await tx
      .select({ o: orders, partyName: parties.name, closed: sql<boolean>`exists (select 1 from finance_order_closures c where c.order_id = "finance_orders"."id")` })
      .from(orders)
      .innerJoin(parties, eq(parties.id, orders.partyId))
      .where(and(eq(orders.kind, input.kind), input.partyId ? eq(orders.partyId, input.partyId) : undefined))
      .orderBy(desc(orders.postingDate), desc(orders.createdAt))
      .limit(500)
    const out = []
    for (const r of rows) {
      const status = orderStatusOf(r.o, r.o.docstatus === 'submitted' ? await orderProgress(tx, r.o.id) : [], r.closed, today)
      if (input.status && status !== input.status) continue
      out.push({ ...r.o, partyName: r.partyName, status })
    }
    return out
  })
}

export async function orderDetail(actor: Actor, orderId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId))
    if (!o) throw new FinanceError(404, 'no_such_order', 'no such order')
    const party = await partyWithin(tx, o.partyId)
    const progress = await orderProgress(tx, orderId)
    const [closure] = await tx.select().from(orderClosures).where(eq(orderClosures.orderId, orderId))
    const today = await localToday(tx, tenant)
    const moves = await tx
      .select({ id: receipts.id, number: receipts.number, postingDate: receipts.postingDate, docstatus: receipts.docstatus, isReturn: receipts.isReturn })
      .from(receipts)
      .where(eq(receipts.orderId, orderId))
    const bills = await tx
      .select({ id: invoices.id, number: invoices.number, postingDate: invoices.postingDate, docstatus: invoices.docstatus, totalFc: invoices.totalFc })
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
    return {
      order: o,
      party,
      lines: progress,
      closure: closure ?? null,
      status: orderStatusOf(o, progress, !!closure, today),
      receipts: moves,
      invoices: bills,
      approvals: o.kind === 'purchase_order' ? await approvalsFor(tx, 'purchase_order', orderId) : [],
    }
  })
}

/** A quotation the customer has taken, as a draft sales order for what is left of it. */
export async function orderFromQuotation(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { quotationId } = z.object({ quotationId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [q] = await tx.select().from(orders).where(and(eq(orders.id, quotationId), eq(orders.kind, 'quotation')))
      if (!q || q.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted quotation becomes an order')
      const progress = (await orderProgress(tx, q.id)).filter((l) => l.qtyMilli > l.orderedMilli)
      if (progress.length === 0) throw new FinanceError(409, 'nothing_left', 'all of it has been ordered')
      const minor = await minorUnitsOf(tx, tenant, q.currency)
      const id = await saveOrderWithin(
        tx,
        actor,
        {
          kind: 'sales_order',
          partyId: q.partyId,
          currency: q.currency,
          exchangeRate: q.exchangeRate,
          placeOfSupply: q.placeOfSupply ?? undefined,
          warehouseId: q.warehouseId ?? undefined,
          costCenter: q.costCenter ?? undefined,
          terms: q.terms ?? undefined,
          submit: false,
          lines: progress.map((l) => ({
            itemId: l.itemId,
            description: l.description,
            qty: formatQty(l.qtyMilli - l.orderedMilli),
            rate: formatDecimal(l.rateFc, minor),
            discount: formatDecimal(l.discountBp, 2),
            taxTemplateId: l.taxTemplateId ?? undefined,
            warehouseId: l.warehouseId ?? undefined,
            costCenter: l.costCenter ?? undefined,
            quotationLineId: l.id,
            deliverBy: undefined,
            requestLineId: undefined,
          })),
        },
        { fromQuotationId: q.id },
      )
      return { id, notice: 'Sales order drafted from the quotation.', next: `/m/finance/order?id=${id}` }
    }),
  )
}

/** The quotation chosen from a supplier, as a draft purchase order. */
export async function orderFromSupplierQuotation(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ supplierQuotationId: z.uuid(), lineIds: z.array(z.uuid()).optional() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [sq] = await tx.select().from(supplierQuotations).where(eq(supplierQuotations.id, data.supplierQuotationId))
      if (!sq || sq.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted quotation is ordered from')
      const ls = (await tx.select().from(supplierQuotationLines).where(eq(supplierQuotationLines.quotationId, sq.id))).filter(
        (l) => !data.lineIds || data.lineIds.includes(l.id),
      )
      const minor = await minorUnitsOf(tx, tenant, sq.currency)
      const id = await saveOrderWithin(
        tx,
        actor,
        {
          kind: 'purchase_order',
          partyId: sq.partyId,
          currency: sq.currency,
          terms: sq.terms ?? undefined,
          submit: false,
          lines: ls.map((l) => ({
            itemId: l.itemId,
            qty: formatQty(l.qtyMilli),
            rate: formatDecimal(l.rateFc, minor),
            taxTemplateId: l.taxTemplateId ?? undefined,
            description: undefined,
            discount: undefined,
            warehouseId: undefined,
            costCenter: undefined,
            deliverBy: undefined,
            requestLineId: undefined,
            quotationLineId: undefined,
          })),
        },
        { supplierQuotationId: sq.id },
      )
      return { id, notice: 'Purchase order drafted from the quotation.', next: `/m/finance/order?id=${id}` }
    }),
  )
}

// --- goods receipts and delivery notes -----------------------------------------------

export const receiptSchema = z
  .object({
    receiptId: optionalId,
    kind: z.enum(['purchase_receipt', 'delivery_note']),
    partyId: z.uuid(),
    orderId: optionalId,
    postingDate: optionalDate,
    challanNo: optional(60),
    transporter: optional(120),
    costCenter: optional(80),
    memo: optional(500),
    currency: optional(3).transform((v) => v?.toUpperCase()),
    exchangeRate: optional(24),
    lines: z
      .array(
        z.object({
          itemId: optionalId,
          orderLineId: optionalId,
          warehouseId: optionalId,
          qty: optional(20),
          rejected: optional(20),
          rate: optional(24),
          batchNo: optional(60),
          expiresOn: optionalDate,
          serials: optional(4000),
        }),
      )
      .max(300)
      .default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceReceipt' })

export async function saveReceipt(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = receiptSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const id = await saveReceiptWithin(tx, actor, data)
      if (data.submit) return submitReceiptWithin(tx, actor, id)
      return { id, notice: 'Saved as a draft.', next: `/m/finance/receipt?id=${id}` }
    }),
  )
}

async function saveReceiptWithin(tx: Tx, actor: Actor, input: z.input<typeof receiptSchema>, isReturn?: { against: string }) {
  const tenant = actor.institutionId!
  const data = receiptSchema.parse(input)
  const settings = await settingsWithin(tx, tenant)
  const party = await partyWithin(tx, data.partyId)
  const postingDate = data.postingDate ?? (await localToday(tx, tenant))
  const [order] = data.orderId ? await tx.select().from(orders).where(eq(orders.id, data.orderId)) : []
  if (data.orderId && (!order || order.docstatus !== 'submitted' || order.partyId !== party.id)) {
    throw new FinanceError(400, 'bad_order', 'that order is not a submitted order of this party')
  }
  const currency = order?.currency ?? data.currency ?? party.currency ?? settings.baseCurrency
  const exchangeRate =
    order?.exchangeRate ?? (currency === settings.baseCurrency ? '1' : (data.exchangeRate ?? (await rateOn(tx, tenant, currency, postingDate))))
  const fcMinor = await minorUnitsOf(tx, tenant, currency)
  const orderLineRows = order ? await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id)) : []
  const fallback = await defaultWarehouse(tx, tenant)

  const typed = data.lines.filter((l) => l.itemId && (l.qty || l.rejected))
  if (typed.length === 0) throw new FinanceError(400, 'no_lines', 'a receipt needs at least one line')
  const rows = []
  for (const [i, l] of typed.entries()) {
    const at = `line ${i + 1}`
    const [item] = await tx.select().from(items).where(eq(items.id, l.itemId!))
    if (!item?.isStock) throw new FinanceError(400, 'not_stock', `${at}: only stock items are received into or delivered from a store`)
    const ol = l.orderLineId ? orderLineRows.find((x) => x.id === l.orderLineId) : undefined
    if (l.orderLineId && !ol) throw new FinanceError(400, 'bad_order_line', `${at}: that line is not on the order`)
    const qty = parseQty(l.qty ?? '0')
    const rejected = parseQty(l.rejected ?? '0')
    if (qty === null || rejected === null || qty < 0 || rejected < 0 || qty + rejected === 0) {
      throw new FinanceError(400, 'bad_qty', `${at}: the quantity is not a quantity`)
    }
    // At the order's price, net of its discount, unless typed.
    const rate = l.rate ? parseDecimal(l.rate, fcMinor) : ol ? mulDiv(ol.amountFc, 1000, ol.qtyMilli) : (item.standardRatePaise ?? 0)
    if (rate === null || rate < 0) throw new FinanceError(400, 'bad_amount', `${at}: the rate is not an amount`)
    const serials = serialList(l.serials)
    if (item.hasSerial && serials.length * 1000 !== qty) throw new FinanceError(400, 'serials_required', `${at}: list one serial number for each unit`)
    let batchId: string | null = null
    if (item.hasBatch) {
      if (!l.batchNo) throw new FinanceError(400, 'batch_required', `${at}: ${item.name} is kept by batch; say which`)
      batchId = await batchFor(tx, tenant, item.id, l.batchNo, { expiresOn: l.expiresOn })
    }
    rows.push({
      institutionId: tenant,
      seq: i + 1,
      itemId: item.id,
      orderLineId: ol?.id ?? null,
      warehouseId: l.warehouseId ?? ol?.warehouseId ?? order?.warehouseId ?? fallback,
      qtyMilli: qty,
      rejectedMilli: rejected,
      rateFc: rate,
      batchId,
      serials: serials.length ? serials : null,
    })
  }
  const header = {
    kind: data.kind,
    isReturn: !!isReturn,
    returnAgainst: isReturn?.against ?? null,
    partyId: party.id,
    postingDate,
    orderId: order?.id ?? null,
    challanNo: data.challanNo ?? null,
    transporter: data.transporter ?? null,
    currency,
    exchangeRate,
    costCenter: data.costCenter ?? order?.costCenter ?? null,
    memo: data.memo ?? null,
  }
  let id = data.receiptId
  if (id) {
    const [row] = await tx.select().from(receipts).where(eq(receipts.id, id)).for('update')
    if (!row || row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
    await tx.update(receipts).set(header).where(eq(receipts.id, id))
    await tx.delete(receiptLines).where(eq(receiptLines.receiptId, id))
  } else {
    const [row] = await tx.insert(receipts).values({ ...header, institutionId: tenant, createdBy: actor.id }).returning({ id: receipts.id })
    id = row!.id
  }
  await tx.insert(receiptLines).values(rows.map((r) => ({ ...r, receiptId: id! })))
  return id!
}

export async function submitReceipt(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { receiptId } = z.object({ receiptId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitReceiptWithin(tx, actor, receiptId)))
}

async function submitReceiptWithin(tx: Tx, actor: Actor, receiptId: string) {
  const tenant = actor.institutionId!
  const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for('update')
  if (!r) throw new FinanceError(404, 'no_such_receipt', 'no such receipt')
  if (r.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that receipt is not a draft')
  const ls = await tx.select().from(receiptLines).where(eq(receiptLines.receiptId, receiptId)).orderBy(asc(receiptLines.seq))
  const settings = await settingsWithin(tx, tenant)
  const fcMinor = await minorUnitsOf(tx, tenant, r.currency)
  const baseMinor = await minorUnitsOf(tx, tenant, settings.baseCurrency)
  const base = (fc: number) => (r.currency === settings.baseCurrency ? fc : toBase(fc, r.exchangeRate, fcMinor, baseMinor))
  const purchase = r.kind === 'purchase_receipt'
  const series = purchase ? (r.isReturn ? 'purchase_receipt_return' : 'purchase_receipt') : r.isReturn ? 'delivery_note_return' : 'delivery_note'
  const number = await nextNumber(tx, tenant, series, r.postingDate)
  const voucher = { voucherType: r.kind, voucherId: receiptId, postingDate: r.postingDate }
  const inward = purchase !== r.isReturn

  const movements: Movement[] = []
  for (const l of ls) {
    if (l.qtyMilli === 0) continue
    let valuePaise: number | null = null
    if (purchase && !r.isReturn) valuePaise = base(extend(l.qtyMilli, l.rateFc))
    if (!purchase && r.isReturn && l.returnOfLineId) {
      // Back into the store at what it left at.
      const [orig] = await tx
        .select({ q: stockLedger.qtyChangeMilli, v: stockLedger.valueChangePaise })
        .from(stockLedger)
        .where(eq(stockLedger.voucherLineId, l.returnOfLineId))
        .limit(1)
      if (orig && orig.q !== 0) valuePaise = mulDiv(orig.v, l.qtyMilli, orig.q)
    }
    movements.push({
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      qtyMilli: inward ? l.qtyMilli : -l.qtyMilli,
      valuePaise: inward ? valuePaise : null,
      batchId: l.batchId,
      serials: l.serials,
      voucherLineId: l.id,
    })
  }
  const moved = await moveStock(tx, tenant, movements, voucher)
  for (const m of moved) {
    await tx.update(receiptLines).set({ amountPaise: Math.abs(m.valueChangePaise) }).where(eq(receiptLines.id, m.voucherLineId!))
  }

  let entryId: string | null = null
  if (moved.length) {
    const lines = []
    if (purchase) {
      // Goods in: owed to the supplier until their bill arrives. A return
      // takes the stock out at what the store says; the receipt's own price
      // comes off goods-received-not-billed, and any difference is an adjustment.
      const srnb = await accountFor(tx, tenant, 'stock_received_not_billed')
      if (!r.isReturn) lines.push(...stockLines(moved, () => ({ accountId: srnb, costCenter: r.costCenter })))
      else {
        const adjust = await accountFor(tx, tenant, 'stock_adjustment')
        for (const m of moved) {
          const l = ls.find((x) => x.id === m.voucherLineId)!
          const atReceipt = base(extend(l.qtyMilli, l.rateFc))
          lines.push({ accountId: m.stockAccountId, debitPaise: 0, creditPaise: -m.valueChangePaise })
          lines.push({ accountId: srnb, debitPaise: atReceipt, creditPaise: 0, costCenter: r.costCenter })
          const diff = -m.valueChangePaise - atReceipt
          if (diff) lines.push({ accountId: adjust, debitPaise: Math.max(diff, 0), creditPaise: Math.max(-diff, 0) })
        }
      }
    } else {
      const cogs = await accountFor(tx, tenant, 'cost_of_goods')
      lines.push(...stockLines(moved, () => ({ accountId: cogs, costCenter: r.costCenter })))
    }
    const net = lines.filter((l) => l.debitPaise || l.creditPaise)
    if (net.length >= 2) {
      const party = await partyWithin(tx, r.partyId)
      const posted = await postWithin(tx, tenant, actor.id, {
        postingDate: r.postingDate,
        memo: `${number} ${party.name}`.slice(0, 200),
        sourceModule: MODULE,
        sourceRef: `${r.kind}:${receiptId}`,
        lines: net,
      })
      entryId = posted.id
    }
  }
  await tx.update(receipts).set({ number, entryId, totalPaise: moved.reduce((n, m) => n + Math.abs(m.valueChangePaise), 0) }).where(eq(receipts.id, receiptId))
  await submitDocument(tx, receipts, receiptId, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE })
  return { id: receiptId, number, notice: `${number} submitted.`, next: `/m/finance/receipt?id=${receiptId}` }
}

export async function cancelReceipt(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ receiptId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [r] = await tx.select().from(receipts).where(eq(receipts.id, data.receiptId)).for('update')
      if (!r) throw new FinanceError(404, 'no_such_receipt', 'no such receipt')
      if (r.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted receipt is cancelled')
      const lineIds = (await tx.select({ id: receiptLines.id }).from(receiptLines).where(eq(receiptLines.receiptId, r.id))).map((x) => x.id)
      const [billed] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(and(inArray(invoiceLines.receiptLineId, lineIds.concat(['00000000-0000-0000-0000-000000000000'])), eq(invoices.docstatus, 'submitted')))
      if (billed!.n > 0) throw new FinanceError(409, 'receipt_billed', 'it has been billed; cancel the invoice first')
      const [returned] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(receipts)
        .where(and(eq(receipts.returnAgainst, r.id), eq(receipts.docstatus, 'submitted')))
      if (returned!.n > 0) throw new FinanceError(409, 'receipt_returned', 'a return stands against it; cancel that first')
      await reverseStock(tx, tenant, actor.id, r.kind, r.id)
      if (r.entryId) await reverseWithin(tx, tenant, actor.id, r.entryId, data.reason)
      await cancelDocument(tx, receipts, r.id, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email,
        moduleId: MODULE,
        reason: data.reason,
      })
      return { notice: `${r.number} cancelled.` }
    }),
  )
}

export async function deleteReceipt(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { receiptId } = z.object({ receiptId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx.delete(receipts).where(eq(receipts.id, receiptId))
      return { notice: 'Draft deleted.', next: '/m/finance/receipts' }
    }),
  )
}

/** Goods sent back to the supplier, or brought back by a customer, against a submitted receipt or note. */
export async function returnReceipt(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z
    .object({
      receiptId: z.uuid(),
      postingDate: optionalDate,
      lines: z.array(z.object({ lineId: optionalId, qty: optional(20) })).default([]),
      submit: z.preprocess(ticked, z.boolean()).default(false),
    })
    .parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [r] = await tx.select().from(receipts).where(eq(receipts.id, data.receiptId))
      if (!r || r.docstatus !== 'submitted' || r.isReturn) throw new FinanceError(409, 'not_returnable', 'only a submitted receipt is returned against')
      const ls = await tx.select().from(receiptLines).where(eq(receiptLines.receiptId, r.id)).orderBy(asc(receiptLines.seq))
      const back = await tx
        .select({ of: receiptLines.returnOfLineId, qty: sql<number>`sum(${receiptLines.qtyMilli})::bigint` })
        .from(receiptLines)
        .innerJoin(receipts, eq(receipts.id, receiptLines.receiptId))
        .where(and(eq(receipts.returnAgainst, r.id), sql`${receipts.docstatus} <> 'cancelled'`))
        .groupBy(receiptLines.returnOfLineId)
      const wanted = new Map(data.lines.filter((l) => l.lineId && l.qty).map((l) => [l.lineId!, parseQty(l.qty)]))
      const lines = []
      for (const l of ls) {
        const left = l.qtyMilli - Number(back.find((b) => b.of === l.id)?.qty ?? 0)
        const qty = data.lines.length ? (wanted.get(l.id) ?? 0) : left
        if (qty === null || qty < 0 || qty > left) throw new FinanceError(409, 'over_return', 'that is more than is left to return')
        if (qty === 0) continue
        lines.push({ l, qty })
      }
      if (lines.length === 0) throw new FinanceError(409, 'nothing_to_return', 'nothing is left to return on it')
      const minor = await minorUnitsOf(tx, tenant, r.currency)
      const id = await saveReceiptWithin(
        tx,
        actor,
        {
          kind: r.kind,
          partyId: r.partyId,
          orderId: r.orderId ?? undefined,
          postingDate: data.postingDate,
          currency: r.currency,
          exchangeRate: r.exchangeRate,
          memo: `Return against ${r.number}`,
          submit: false,
          lines: lines.map(({ l, qty }) => ({
            itemId: l.itemId,
            orderLineId: l.orderLineId ?? undefined,
            warehouseId: l.warehouseId,
            qty: formatQty(qty),
            rate: formatDecimal(l.rateFc, minor),
            serials: l.serials ? l.serials.slice(0, qty / 1000).join(',') : undefined,
            batchNo: undefined,
            rejected: undefined,
            expiresOn: undefined,
          })),
        },
        { against: r.id },
      )
      // The return's lines say which line they return, and keep its batch.
      const made = await tx.select().from(receiptLines).where(eq(receiptLines.receiptId, id)).orderBy(asc(receiptLines.seq))
      for (const [i, m] of made.entries()) {
        await tx.update(receiptLines).set({ returnOfLineId: lines[i]!.l.id, batchId: lines[i]!.l.batchId }).where(eq(receiptLines.id, m.id))
      }
      if (data.submit) return submitReceiptWithin(tx, actor, id)
      return { id, notice: 'Return saved as a draft.', next: `/m/finance/receipt?id=${id}` }
    }),
  )
}

/** Everything still to come on an order, as a draft receipt or delivery note. */
export async function receiptFromOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ orderId: z.uuid(), postingDate: optionalDate, submit: z.preprocess(ticked, z.boolean()).default(false) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, data.orderId))
      if (!o || o.docstatus !== 'submitted' || o.kind === 'quotation') throw new FinanceError(409, 'not_submitted', 'only a submitted order is received or delivered')
      const pending = (await orderProgress(tx, o.id)).filter((l) => l.isStock && l.qtyMilli > l.movedMilli)
      if (pending.length === 0) throw new FinanceError(409, 'nothing_left', 'everything on it has been received or delivered')
      const id = await saveReceiptWithin(tx, actor, {
        kind: o.kind === 'purchase_order' ? 'purchase_receipt' : 'delivery_note',
        partyId: o.partyId,
        orderId: o.id,
        postingDate: data.postingDate,
        submit: false,
        lines: pending.map((l) => ({
          itemId: l.itemId,
          orderLineId: l.id,
          warehouseId: l.warehouseId ?? undefined,
          qty: formatQty(l.qtyMilli - l.movedMilli),
          rate: undefined,
          rejected: undefined,
          batchNo: undefined,
          expiresOn: undefined,
          serials: undefined,
        })),
      })
      return { id, notice: 'Drafted from the order; check the quantities, batches and serial numbers.', next: `/m/finance/receipt?id=${id}` }
    }),
  )
}

export async function listReceipts(actor: Actor, input: { kind?: 'purchase_receipt' | 'delivery_note'; partyId?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ r: receipts, partyName: parties.name })
      .from(receipts)
      .innerJoin(parties, eq(parties.id, receipts.partyId))
      .where(and(input.kind ? eq(receipts.kind, input.kind) : undefined, input.partyId ? eq(receipts.partyId, input.partyId) : undefined))
      .orderBy(desc(receipts.postingDate), desc(receipts.createdAt))
      .limit(500)
    return rows.map((x) => ({ ...x.r, partyName: x.partyName }))
  })
}

export async function receiptDetail(actor: Actor, receiptId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId))
    if (!r) throw new FinanceError(404, 'no_such_receipt', 'no such receipt')
    const ls = await tx
      .select({ l: receiptLines, itemName: items.name, uom: items.uom })
      .from(receiptLines)
      .innerJoin(items, eq(items.id, receiptLines.itemId))
      .where(eq(receiptLines.receiptId, receiptId))
      .orderBy(asc(receiptLines.seq))
    const billed = await tx
      .select({ receiptLineId: invoiceLines.receiptLineId, qty: sql<number>`sum(case when ${invoices.isReturn} then -${invoiceLines.qtyMilli} else ${invoiceLines.qtyMilli} end)::bigint` })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(inArray(invoiceLines.receiptLineId, ls.map((x) => x.l.id).concat(['00000000-0000-0000-0000-000000000000'])), eq(invoices.docstatus, 'submitted')))
      .groupBy(invoiceLines.receiptLineId)
    return {
      receipt: r,
      party: await partyWithin(tx, r.partyId),
      lines: ls.map((x) => ({ ...x.l, itemName: x.itemName, uom: x.uom, billedMilli: Number(billed.find((b) => b.receiptLineId === x.l.id)?.qty ?? 0) })),
    }
  })
}

// --- billing what was ordered or received --------------------------------------------

/**
 * A draft invoice for what a receipt or delivery note brought that has not
 * been billed yet: at the order's prices and taxes, line by line, so the bill
 * clears exactly what the receipt left owing.
 */
export async function invoiceFromReceipt(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ receiptId: z.uuid(), postingDate: optionalDate, billNo: optional(40), submit: z.preprocess(ticked, z.boolean()).default(false) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [r] = await tx.select().from(receipts).where(eq(receipts.id, data.receiptId))
      if (!r || r.docstatus !== 'submitted' || r.isReturn) throw new FinanceError(409, 'not_submitted', 'only a submitted receipt is billed')
      const detail = await tx.select().from(receiptLines).where(eq(receiptLines.receiptId, r.id)).orderBy(asc(receiptLines.seq))
      const billed = await tx
        .select({ receiptLineId: invoiceLines.receiptLineId, qty: sql<number>`sum(case when ${invoices.isReturn} then -${invoiceLines.qtyMilli} else ${invoiceLines.qtyMilli} end)::bigint` })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(and(inArray(invoiceLines.receiptLineId, detail.map((l) => l.id)), eq(invoices.docstatus, 'submitted')))
        .groupBy(invoiceLines.receiptLineId)
      const orderLineRows = r.orderId ? await tx.select().from(orderLines).where(eq(orderLines.orderId, r.orderId)) : []
      const lines: DraftLine[] = []
      for (const l of detail) {
        const left = l.qtyMilli - Number(billed.find((b) => b.receiptLineId === l.id)?.qty ?? 0)
        if (left <= 0) continue
        const ol = orderLineRows.find((o) => o.id === l.orderLineId)
        lines.push({
          itemId: l.itemId,
          description: ol?.description ?? null,
          qtyMilli: left,
          rateFc: ol?.rateFc ?? l.rateFc,
          discountBp: ol?.discountBp ?? 0,
          taxTemplateId: ol?.taxTemplateId ?? null,
          costCenter: ol?.costCenter ?? r.costCenter,
          orderLineId: l.orderLineId,
          receiptLineId: l.id,
        })
      }
      if (lines.length === 0) throw new FinanceError(409, 'nothing_left', 'all of it has been billed')
      const id = await saveDraftWithin(tx, tenant, actor.id, {
        kind: r.kind === 'purchase_receipt' ? 'purchase' : 'sales',
        partyId: r.partyId,
        postingDate: data.postingDate ?? null,
        billNo: data.billNo ?? null,
        currency: r.currency,
        exchangeRate: r.exchangeRate,
        orderId: r.orderId,
        costCenter: r.costCenter,
        lines,
      })
      if (data.submit) return submitWithin(tx, actor, id)
      return { id, notice: 'Invoice drafted from the receipt.', next: `/m/finance/invoice?id=${id}` }
    }),
  )
}

/**
 * A draft invoice for what is left to bill on an order: its services, and its
 * goods too when the invoice itself moves the stock.
 */
export async function invoiceFromOrder(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z
    .object({ orderId: z.uuid(), postingDate: optionalDate, updateStock: z.preprocess(ticked, z.boolean()).default(false), submit: z.preprocess(ticked, z.boolean()).default(false) })
    .parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, data.orderId))
      if (!o || o.docstatus !== 'submitted' || o.kind === 'quotation') throw new FinanceError(409, 'not_submitted', 'only a submitted order is billed')
      const progress = await orderProgress(tx, o.id)
      const lines: DraftLine[] = progress
        .filter((l) => (!l.isStock || data.updateStock) && l.qtyMilli - l.billedMilli - (l.isStock ? l.movedMilli : 0) > 0)
        .map((l) => ({
          itemId: l.itemId,
          description: l.description,
          qtyMilli: l.qtyMilli - l.billedMilli - (l.isStock ? l.movedMilli : 0),
          rateFc: l.rateFc,
          discountBp: l.discountBp,
          taxTemplateId: l.taxTemplateId,
          costCenter: l.costCenter,
          warehouseId: l.warehouseId,
          orderLineId: l.id,
        }))
      if (lines.length === 0) {
        throw new FinanceError(409, 'nothing_left', 'nothing is left to bill on it directly; bill its goods from their receipts or delivery notes')
      }
      const id = await saveDraftWithin(tx, tenant, actor.id, {
        kind: o.kind === 'purchase_order' ? 'purchase' : 'sales',
        partyId: o.partyId,
        postingDate: data.postingDate ?? null,
        currency: o.currency,
        exchangeRate: o.exchangeRate,
        placeOfSupply: o.placeOfSupply,
        updateStock: data.updateStock,
        warehouseId: o.warehouseId,
        orderId: o.id,
        costCenter: o.costCenter,
        fundId: o.fundId,
        terms: o.terms,
        lines,
      })
      if (data.submit) return submitWithin(tx, actor, id)
      return { id, notice: 'Invoice drafted from the order.', next: `/m/finance/invoice?id=${id}` }
    }),
  )
}

// --- recurring invoices --------------------------------------------------------------

export const recurringSchema = z
  .object({
    invoiceId: z.uuid(),
    every: z.enum(['month', 'quarter', 'year']),
    nextOn: z.iso.date(),
    endsOn: optionalDate,
    autoSubmit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceRecurring' })

export async function makeRecurring(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = recurringSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, data.invoiceId))
      if (!inv || inv.docstatus !== 'submitted' || inv.isReturn) throw new FinanceError(409, 'not_submitted', 'a submitted invoice is the pattern')
      if (inv.updateStock) throw new FinanceError(400, 'recurring_stock', 'an invoice that moves stock is not repeated by itself')
      const [row] = await tx
        .insert(recurring)
        .values({ institutionId: tenant, templateInvoiceId: inv.id, every: data.every, nextOn: data.nextOn, endsOn: data.endsOn ?? null, autoSubmit: data.autoSubmit })
        .returning({ id: recurring.id })
      return { ...row!, notice: `It will be raised every ${data.every} from ${data.nextOn}.` }
    }),
  )
}

export async function stopRecurring(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { recurringId } = z.object({ recurringId: z.uuid() }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.update(recurring).set({ stoppedAt: new Date() }).where(eq(recurring.id, recurringId))
    return { notice: 'Stopped.' }
  })
}

export async function listRecurring(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({ r: recurring, number: invoices.number, partyName: parties.name, totalFc: invoices.totalFc, kind: invoices.kind })
      .from(recurring)
      .innerJoin(invoices, eq(invoices.id, recurring.templateInvoiceId))
      .innerJoin(parties, eq(parties.id, invoices.partyId))
      .orderBy(asc(recurring.nextOn))
      .then((rows) => rows.map((x) => ({ ...x.r, number: x.number, partyName: x.partyName, totalFc: x.totalFc, kind: x.kind }))),
  )
}

/**
 * Raise every recurring invoice that has fallen due, as of a day: each a copy
 * of its pattern dated when it was due, submitted if it was set to be. A
 * scheduled job calls this daily; the button does the same.
 */
export async function runRecurringWithin(tx: Tx, actor: Actor, on: string) {
  const tenant = actor.institutionId!
  const due = await tx
    .select()
    .from(recurring)
    .where(and(isNull(recurring.stoppedAt), lte(recurring.nextOn, on)))
    .for('update', { skipLocked: true })
  let raised = 0
  for (const r of due) {
    let next = r.nextOn
    while (next <= on && (!r.endsOn || next <= r.endsOn)) {
      const [pattern] = await tx.select().from(invoices).where(eq(invoices.id, r.templateInvoiceId))
      const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, r.templateInvoiceId)).orderBy(asc(invoiceLines.seq))
      const id = await saveDraftWithin(tx, tenant, actor.id, {
        kind: pattern!.kind,
        partyId: pattern!.partyId,
        postingDate: next,
        currency: pattern!.currency,
        placeOfSupply: pattern!.placeOfSupply,
        tdsSectionId: pattern!.tdsSectionId,
        costCenter: pattern!.costCenter,
        fundId: pattern!.fundId,
        memo: pattern!.memo,
        terms: pattern!.terms,
        sourceModule: 'finance-recurring',
        sourceRef: `${r.id}:${next}`,
        lines: ls.map((l) => ({
          itemId: l.itemId,
          description: l.description,
          qtyMilli: l.qtyMilli,
          rateFc: l.rateFc,
          discountBp: l.discountBp,
          taxTemplateId: l.taxTemplateId,
          accountId: l.accountId,
          costCenter: l.costCenter,
          fundId: l.fundId,
          itcEligible: l.itcEligible,
        })),
      })
      if (r.autoSubmit) await submitWithin(tx, actor, id)
      raised++
      next = addMonths(next, r.every === 'month' ? 1 : r.every === 'quarter' ? 3 : 12)
    }
    const finished = r.endsOn && next > r.endsOn
    await tx
      .update(recurring)
      .set({ nextOn: finished ? r.endsOn! : next, ...(finished ? { stoppedAt: new Date() } : {}) })
      .where(eq(recurring.id, r.id))
  }
  return raised
}

export async function runRecurring(actor: Actor, input: unknown = {}) {
  const tenant = requireOperate(actor)
  const data = z.object({ on: optionalDate }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const on = data.on ?? (await localToday(tx, tenant))
      const raised = await runRecurringWithin(tx, actor, on)
      return { raised, notice: raised ? `${raised} invoice(s) raised.` : 'Nothing was due.' }
    }),
  )
}
