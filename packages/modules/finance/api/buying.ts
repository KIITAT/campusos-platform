import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { cancelDocument, submitDocument, users, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import {
  items,
  materialRequestLines,
  materialRequests,
  orderLines,
  orders,
  parties,
  rfqLines,
  rfqs,
  rfqSuppliers,
  stockEntries,
  stockEntryLines,
  supplierQuotationLines,
  supplierQuotations,
} from '../schema'
import {
  FinanceError,
  canOperate,
  hasCapability,
  named,
  requireOperate,
  requireRead,
  requireStaff,
  tenantOf,
  type Actor,
  type Tx,
} from './core'
import { formatDecimal, formatQty, parseDecimal, parseQty } from './numbers'
import { approvalsFor, assertApproved, minorUnitsOf, nextNumber } from './setup'
import { createStockEntry } from './stock'
import { saveOrderWithin } from './trade'
import { localToday, settingsWithin } from './years'

/**
 * Asking for things and finding who will supply them.
 *
 * Anybody who works here may ask the stores for something (a material
 * request): to be issued from stock, or to be bought. The stores issue it, or
 * the purchase office asks suppliers for prices (a request for quotation),
 * records what each quoted, compares them side by side, and orders from the
 * one it chooses. Every step names the one before, so a purchase order can be
 * traced back to who asked for it and why.
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

async function requirePurchaser(tx: Tx, actor: Actor) {
  if (!(await hasCapability(tx, actor, 'purchaser'))) throw new FinanceError(403, 'forbidden', 'that is for the purchase office')
}

// --- material requests ----------------------------------------------------------------

export const materialRequestSchema = z
  .object({
    requestId: optionalId,
    purpose: z.enum(['purchase', 'issue']).default('issue'),
    costCenter: optional(80),
    warehouseId: optionalId,
    requiredBy: optionalDate,
    reason: optional(1000),
    lines: z
      .array(z.object({ itemId: optionalId, qty: optional(20), note: optional(200) }))
      .max(100)
      .default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceMaterialRequest' })

export async function saveMaterialRequest(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const data = materialRequestSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const typed = data.lines.filter((l) => l.itemId && l.qty)
      if (typed.length === 0) throw new FinanceError(400, 'no_lines', 'ask for at least one thing')
      const rows = typed.map((l, i) => {
        const qty = parseQty(l.qty)
        if (qty === null || qty <= 0) throw new FinanceError(400, 'bad_qty', `line ${i + 1}: the quantity is not a quantity`)
        return { institutionId: tenant, seq: i + 1, itemId: l.itemId!, qtyMilli: qty, note: l.note ?? null }
      })
      const header = {
        purpose: data.purpose,
        costCenter: data.costCenter ?? null,
        warehouseId: data.warehouseId ?? null,
        requiredBy: data.requiredBy ?? null,
        reason: data.reason ?? null,
      }
      let id = data.requestId
      if (id) {
        const [row] = await tx.select().from(materialRequests).where(eq(materialRequests.id, id)).for('update')
        if (!row || row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
        if (row.requestedBy !== actor.id && !canOperate(actor.role)) throw new FinanceError(403, 'forbidden', 'that request is somebody else’s')
        await tx.update(materialRequests).set(header).where(eq(materialRequests.id, id))
        await tx.delete(materialRequestLines).where(eq(materialRequestLines.requestId, id))
      } else {
        const [row] = await tx
          .insert(materialRequests)
          .values({ ...header, institutionId: tenant, requestedBy: actor.id })
          .returning({ id: materialRequests.id })
        id = row!.id
      }
      await tx.insert(materialRequestLines).values(rows.map((r) => ({ ...r, requestId: id! })))
      if (data.submit) return submitRequestWithin(tx, actor, id!)
      return { id, notice: 'Saved as a draft.', next: `/m/finance/material-request?id=${id}` }
    }),
  )
}

export function approvalViewOfRequest(r: typeof materialRequests.$inferSelect, ls: (typeof materialRequestLines.$inferSelect)[]) {
  return { purpose: r.purpose, costCenter: r.costCenter, lines: ls.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli })) }
}

/** What a request is worth at the items' standard rates: what an approval rule weighs it by. */
async function requestValue(tx: Tx, requestId: string) {
  const [row] = await tx
    .select({ v: sql<number>`coalesce(sum(${materialRequestLines.qtyMilli} * coalesce(${items.standardRatePaise}, 0) / 1000), 0)::bigint` })
    .from(materialRequestLines)
    .innerJoin(items, eq(items.id, materialRequestLines.itemId))
    .where(eq(materialRequestLines.requestId, requestId))
  return Number(row?.v ?? 0)
}

async function submitRequestWithin(tx: Tx, actor: Actor, requestId: string) {
  const tenant = tenantOf(actor)
  const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, requestId)).for('update')
  if (!r) throw new FinanceError(404, 'no_such_request', 'no such request')
  if (r.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that request is not a draft')
  if (r.requestedBy !== actor.id && !canOperate(actor.role)) throw new FinanceError(403, 'forbidden', 'that request is somebody else’s')
  const ls = await tx.select().from(materialRequestLines).where(eq(materialRequestLines.requestId, requestId))
  await assertApproved(tx, 'material_request', requestId, approvalViewOfRequest(r, ls), await requestValue(tx, requestId))
  const number = await nextNumber(tx, tenant, 'material_request', await localToday(tx, tenant))
  await tx.update(materialRequests).set({ number }).where(eq(materialRequests.id, requestId))
  await submitDocument(tx, materialRequests, requestId, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE })
  return { id: requestId, number, notice: `${number} sent to the stores.`, next: `/m/finance/material-request?id=${requestId}` }
}

export async function submitMaterialRequest(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const { requestId } = z.object({ requestId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitRequestWithin(tx, actor, requestId)))
}

export async function cancelMaterialRequest(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const data = z.object({ requestId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, data.requestId))
      if (!r) throw new FinanceError(404, 'no_such_request', 'no such request')
      if (r.requestedBy !== actor.id && !canOperate(actor.role)) throw new FinanceError(403, 'forbidden', 'that request is somebody else’s')
      await cancelDocument(tx, materialRequests, r.id, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE, reason: data.reason })
      return { notice: `${r.number} withdrawn.` }
    }),
  )
}

/** Each line of a request with how much has been issued against it and how much ordered. */
async function requestProgress(tx: Tx, requestId: string) {
  const ls = await tx
    .select({ l: materialRequestLines, itemName: items.name, uom: items.uom, isStock: items.isStock })
    .from(materialRequestLines)
    .innerJoin(items, eq(items.id, materialRequestLines.itemId))
    .where(eq(materialRequestLines.requestId, requestId))
    .orderBy(asc(materialRequestLines.seq))
  const ordered = await tx
    .select({ requestLineId: orderLines.requestLineId, qty: sql<number>`sum(${orderLines.qtyMilli})::bigint` })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(inArray(orderLines.requestLineId, ls.map((x) => x.l.id).concat(['00000000-0000-0000-0000-000000000000'])), eq(orders.docstatus, 'submitted')))
    .groupBy(orderLines.requestLineId)
  // Issues against the request, by item: a stock entry names the request, not each line.
  const issued = await tx
    .select({ itemId: stockEntryLines.itemId, qty: sql<number>`sum(${stockEntryLines.qtyMilli})::bigint` })
    .from(stockEntryLines)
    .innerJoin(stockEntries, eq(stockEntries.id, stockEntryLines.stockEntryId))
    .where(and(eq(stockEntries.materialRequestId, requestId), eq(stockEntries.docstatus, 'submitted'), eq(stockEntries.kind, 'issue')))
    .groupBy(stockEntryLines.itemId)
  return ls.map((x) => ({
    ...x.l,
    itemName: x.itemName,
    uom: x.uom,
    isStock: x.isStock,
    orderedMilli: Number(ordered.find((o) => o.requestLineId === x.l.id)?.qty ?? 0),
    issuedMilli: Number(issued.find((o) => o.itemId === x.l.itemId)?.qty ?? 0),
  }))
}

export async function listMaterialRequests(actor: Actor, input: { mine?: boolean; status?: string } = {}) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const seesAll = await hasCapability(tx, actor, 'storekeeper') || (await hasCapability(tx, actor, 'purchaser'))
    const rows = await tx
      .select({ r: materialRequests, by: users.name })
      .from(materialRequests)
      .leftJoin(users, eq(users.id, materialRequests.requestedBy))
      .where(
        and(
          input.mine || !seesAll ? eq(materialRequests.requestedBy, actor.id) : undefined,
          input.status ? eq(materialRequests.docstatus, input.status as 'draft') : undefined,
        ),
      )
      .orderBy(desc(materialRequests.createdAt))
      .limit(500)
    const out = []
    for (const x of rows) {
      let status: string = x.r.docstatus
      if (x.r.docstatus === 'submitted') {
        const p = await requestProgress(tx, x.r.id)
        const done = p.every((l) => (x.r.purpose === 'issue' ? l.issuedMilli : l.orderedMilli) >= l.qtyMilli)
        const some = p.some((l) => l.issuedMilli > 0 || l.orderedMilli > 0)
        status = done ? (x.r.purpose === 'issue' ? 'issued' : 'ordered') : some ? 'partly_done' : 'pending'
      }
      out.push({ ...x.r, requestedByName: x.by, status })
    }
    return out
  })
}

export async function materialRequestDetail(actor: Actor, requestId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, requestId))
    if (!r) throw new FinanceError(404, 'no_such_request', 'no such request')
    const seesAll = await hasCapability(tx, actor, 'storekeeper') || (await hasCapability(tx, actor, 'purchaser'))
    if (!seesAll && r.requestedBy !== actor.id) throw new FinanceError(404, 'no_such_request', 'no such request')
    return {
      request: r,
      lines: await requestProgress(tx, requestId),
      approvals: await approvalsFor(tx, 'material_request', requestId),
      issues: await tx.select().from(stockEntries).where(eq(stockEntries.materialRequestId, requestId)),
    }
  })
}

/** What is left of an issue request, as a draft issue from the stores. */
export async function issueFromRequest(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = z.object({ requestId: z.uuid(), warehouseId: optionalId }).parse(input)
  const { lines, request } = await withTenant(tenant, async (tx) => {
    const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, data.requestId))
    if (!r || r.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted request is issued')
    return { request: r, lines: (await requestProgress(tx, r.id)).filter((l) => l.isStock && l.qtyMilli > l.issuedMilli) }
  })
  if (lines.length === 0) throw new FinanceError(409, 'nothing_left', 'everything asked for has been issued')
  return createStockEntry(actor, {
    kind: 'issue',
    costCenter: request.costCenter ?? undefined,
    materialRequestId: request.id,
    memo: `Against ${request.number}`,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      qty: formatQty(l.qtyMilli - l.issuedMilli),
      fromWarehouseId: data.warehouseId ?? request.warehouseId ?? undefined,
    })),
  })
}

/** What is left of a purchase request, as a draft purchase order to a supplier. */
export async function orderFromRequest(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ requestId: z.uuid(), partyId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, data.requestId))
      if (!r || r.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted request is ordered')
      const left = (await requestProgress(tx, r.id)).filter((l) => l.qtyMilli > l.orderedMilli)
      if (left.length === 0) throw new FinanceError(409, 'nothing_left', 'everything asked for has been ordered')
      const id = await saveOrderWithin(tx, actor, {
        kind: 'purchase_order',
        partyId: data.partyId,
        costCenter: r.costCenter ?? undefined,
        warehouseId: r.warehouseId ?? undefined,
        deliverBy: r.requiredBy ?? undefined,
        memo: `Against ${r.number}`,
        lines: left.map((l) => ({ itemId: l.itemId, qty: formatQty(l.qtyMilli - l.orderedMilli), rate: '0', requestLineId: l.id })),
      })
      return { id, notice: 'Purchase order drafted; enter the prices.', next: `/m/finance/order?id=${id}` }
    }),
  )
}

// --- requests for quotation -----------------------------------------------------------

export const rfqSchema = z
  .object({
    rfqId: optionalId,
    postingDate: optionalDate,
    respondBy: optionalDate,
    terms: optional(4000),
    requestId: optionalId,
    supplierIds: z.array(z.uuid()).max(50).default([]),
    lines: z
      .array(z.object({ itemId: optionalId, qty: optional(20), requestLineId: optionalId }))
      .max(100)
      .default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceRfq' })

export async function saveRfq(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = rfqSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await requirePurchaser(tx, actor)
      let lines = data.lines.filter((l) => l.itemId && l.qty)
      if (lines.length === 0 && data.requestId) {
        lines = (await requestProgress(tx, data.requestId))
          .filter((l) => l.qtyMilli > l.orderedMilli)
          .map((l) => ({ itemId: l.itemId, qty: formatQty(l.qtyMilli - l.orderedMilli), requestLineId: l.id }))
      }
      if (lines.length === 0) throw new FinanceError(400, 'no_lines', 'ask for a price on at least one item')
      if (data.supplierIds.length === 0) throw new FinanceError(400, 'no_suppliers', 'name the suppliers asked')
      const header = { postingDate: data.postingDate ?? (await localToday(tx, tenant)), respondBy: data.respondBy ?? null, terms: data.terms ?? null }
      let id = data.rfqId
      if (id) {
        const [row] = await tx.select().from(rfqs).where(eq(rfqs.id, id))
        if (!row || row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
        await tx.update(rfqs).set(header).where(eq(rfqs.id, id))
        await tx.delete(rfqLines).where(eq(rfqLines.rfqId, id))
        await tx.delete(rfqSuppliers).where(eq(rfqSuppliers.rfqId, id))
      } else {
        const [row] = await tx.insert(rfqs).values({ ...header, institutionId: tenant }).returning({ id: rfqs.id })
        id = row!.id
      }
      await tx.insert(rfqLines).values(
        lines.map((l, i) => {
          const qty = parseQty(l.qty)
          if (qty === null || qty <= 0) throw new FinanceError(400, 'bad_qty', `line ${i + 1}: the quantity is not a quantity`)
          return { institutionId: tenant, rfqId: id!, seq: i + 1, itemId: l.itemId!, qtyMilli: qty, requestLineId: l.requestLineId ?? null }
        }),
      )
      await tx.insert(rfqSuppliers).values([...new Set(data.supplierIds)].map((partyId) => ({ institutionId: tenant, rfqId: id!, partyId })))
      if (data.submit) {
        const number = await nextNumber(tx, tenant, 'rfq', header.postingDate)
        await tx.update(rfqs).set({ number }).where(eq(rfqs.id, id!))
        await submitDocument(tx, rfqs, id!, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE })
        return { id, number, notice: `${number} ready to send.`, next: `/m/finance/rfq?id=${id}` }
      }
      return { id, notice: 'Saved as a draft.', next: `/m/finance/rfq?id=${id}` }
    }),
  )
}

export async function listRfqs(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => tx.select().from(rfqs).orderBy(desc(rfqs.postingDate)).limit(500))
}

export const supplierQuotationSchema = z
  .object({
    quotationId: optionalId,
    rfqId: optionalId,
    partyId: z.uuid(),
    quotedOn: optionalDate,
    validTill: optionalDate,
    currency: optional(3).transform((v) => v?.toUpperCase()),
    terms: optional(4000),
    lines: z
      .array(
        z.object({
          itemId: optionalId,
          qty: optional(20),
          rate: optional(24),
          taxTemplateId: optionalId,
          leadDays: optional(5),
          rfqLineId: optionalId,
        }),
      )
      .max(100)
      .default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceSupplierQuotation' })

/** What a supplier quoted, typed in from their letter or e-mail. */
export async function saveSupplierQuotation(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = supplierQuotationSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await requirePurchaser(tx, actor)
      const settings = await settingsWithin(tx, tenant)
      const currency = data.currency ?? settings.baseCurrency
      const minor = await minorUnitsOf(tx, tenant, currency)
      const typed = data.lines.filter((l) => l.itemId && l.rate)
      if (typed.length === 0) throw new FinanceError(400, 'no_lines', 'a quotation prices at least one item')
      const rows = typed.map((l, i) => {
        const qty = parseQty(l.qty ?? '1')
        const rate = parseDecimal(l.rate, minor)
        if (qty === null || qty <= 0 || rate === null || rate < 0) throw new FinanceError(400, 'bad_amount', `line ${i + 1}: check the quantity and rate`)
        return {
          institutionId: tenant,
          seq: i + 1,
          itemId: l.itemId!,
          qtyMilli: qty,
          rateFc: rate,
          taxTemplateId: l.taxTemplateId ?? null,
          leadDays: l.leadDays ? Number(l.leadDays) : null,
          rfqLineId: l.rfqLineId ?? null,
        }
      })
      const header = {
        rfqId: data.rfqId ?? null,
        partyId: data.partyId,
        quotedOn: data.quotedOn ?? (await localToday(tx, tenant)),
        validTill: data.validTill ?? null,
        currency,
        terms: data.terms ?? null,
      }
      let id = data.quotationId
      if (id) {
        await tx.update(supplierQuotations).set(header).where(eq(supplierQuotations.id, id))
        await tx.delete(supplierQuotationLines).where(eq(supplierQuotationLines.quotationId, id))
      } else {
        const [row] = await tx.insert(supplierQuotations).values({ ...header, institutionId: tenant }).returning({ id: supplierQuotations.id })
        id = row!.id
      }
      await tx.insert(supplierQuotationLines).values(rows.map((r) => ({ ...r, quotationId: id! })))
      if (data.submit) {
        const number = await nextNumber(tx, tenant, 'supplier_quotation', header.quotedOn)
        await tx.update(supplierQuotations).set({ number }).where(eq(supplierQuotations.id, id!))
        await submitDocument(tx, supplierQuotations, id!, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE })
        return { id, number, notice: `${number} recorded.`, next: data.rfqId ? `/m/finance/rfq?id=${data.rfqId}` : '/m/finance/supplier-quotations' }
      }
      return { id, notice: 'Saved as a draft.' }
    }),
  )
}

/**
 * The quotations for an RFQ side by side, item by item: each supplier's rate,
 * lead time and validity, with the lowest marked. A comparison, not a
 * decision -- the purchase office orders from whom it chooses, and the
 * order says which quotation it took.
 */
export async function compareQuotations(actor: Actor, rfqId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [rfq] = await tx.select().from(rfqs).where(eq(rfqs.id, rfqId))
    if (!rfq) throw new FinanceError(404, 'no_such_rfq', 'no such request for quotation')
    const asked = await tx
      .select({ l: rfqLines, itemName: items.name, uom: items.uom })
      .from(rfqLines)
      .innerJoin(items, eq(items.id, rfqLines.itemId))
      .where(eq(rfqLines.rfqId, rfqId))
      .orderBy(asc(rfqLines.seq))
    const suppliers = await tx
      .select({ partyId: rfqSuppliers.partyId, name: parties.name })
      .from(rfqSuppliers)
      .innerJoin(parties, eq(parties.id, rfqSuppliers.partyId))
      .where(eq(rfqSuppliers.rfqId, rfqId))
    const quotes = await tx
      .select({ q: supplierQuotations, l: supplierQuotationLines })
      .from(supplierQuotations)
      .innerJoin(supplierQuotationLines, eq(supplierQuotationLines.quotationId, supplierQuotations.id))
      .where(and(eq(supplierQuotations.rfqId, rfqId), eq(supplierQuotations.docstatus, 'submitted')))
    const today = await localToday(tx, tenant)
    const items_ = asked.map((a) => {
      const offers = quotes
        .filter((x) => x.l.itemId === a.l.itemId)
        .map((x) => ({
          quotationId: x.q.id,
          number: x.q.number,
          partyId: x.q.partyId,
          supplier: suppliers.find((s) => s.partyId === x.q.partyId)?.name ?? '',
          currency: x.q.currency,
          rateFc: x.l.rateFc,
          rate: formatDecimal(x.l.rateFc, 2),
          leadDays: x.l.leadDays,
          validTill: x.q.validTill,
          expired: !!x.q.validTill && x.q.validTill < today,
        }))
        .sort((p, q) => p.rateFc - q.rateFc)
      const lowest = offers.find((o) => !o.expired)
      return { itemId: a.l.itemId, itemName: a.itemName, uom: a.uom, qtyMilli: a.l.qtyMilli, offers: offers.map((o) => ({ ...o, lowest: o === lowest })) }
    })
    return { rfq, suppliers, items: items_, answered: new Set(quotes.map((q) => q.q.partyId)).size }
  })
}

export async function listSupplierQuotations(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) =>
    tx
      .select({ q: supplierQuotations, partyName: parties.name })
      .from(supplierQuotations)
      .innerJoin(parties, eq(parties.id, supplierQuotations.partyId))
      .orderBy(desc(supplierQuotations.quotedOn))
      .limit(500)
      .then((rows) => rows.map((r) => ({ ...r.q, partyName: r.partyName }))),
  )
}

/**
 * Money committed but not yet spent: submitted purchase orders not yet billed,
 * by cost centre. What a budget holder needs beside the budget itself.
 */
export async function commitments(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const res = await tx.execute(sql`
      select coalesce(ol.cost_center, o.cost_center, '(none)') as cost_center,
             sum((ol.qty_milli - coalesce(b.billed, 0)) * ol.amount_fc / ol.qty_milli * o.exchange_rate)::bigint as open_paise,
             count(distinct o.id)::int as orders
        from finance_order_lines ol
        join finance_orders o on o.id = ol.order_id
        left join lateral (
          select sum(case when i.is_return then -il.qty_milli else il.qty_milli end) as billed
            from finance_invoice_lines il join finance_invoices i on i.id = il.invoice_id
           where il.order_line_id = ol.id and i.docstatus = 'submitted') b on true
       where o.kind = 'purchase_order' and o.docstatus = 'submitted'
         and not exists (select 1 from finance_order_closures c where c.order_id = o.id)
         and ol.qty_milli > coalesce(b.billed, 0)
       group by 1 order by 1`)
    return (res.rows as { cost_center: string; open_paise: number; orders: number }[]).map((r) => ({
      costCenter: r.cost_center,
      openPaise: Number(r.open_paise),
      orders: r.orders,
    }))
  })
}
