import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { amendDocument, cancelDocument, submitDocument, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import {
  assetCategories,
  assets,
  invoiceLines,
  invoices,
  invoiceTaxes,
  itemGroups,
  items,
  lines as glLines,
  parties,
  partyLedger,
  receiptLines,
  stockLedger,
  tdsSections,
} from '../schema'
import {
  FinanceError,
  canConfigure,
  named,
  requireOperate,
  requireRead,
  without,
  type Actor,
  type Tx,
} from './core'
import { addDays, bpOf, divRound, extend, formatQty, mulDiv, parseDecimal, parseQty, toBase } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'
import { partyWithin, unapplyAdvances } from './parties'
import { assertApproved, approvalsFor, minorUnitsOf, nextNumber, rateOn } from './setup'
import {
  batchFor,
  defaultWarehouse,
  moveStock,
  reverseStock,
  serialList,
  stockLines,
  valuationRate,
  type Movement,
  type Moved,
} from './stock'
import { computeTaxes, isIntraState, tdsFor, templatesWithin } from './tax'
import { fiscalYearOf, localToday, settingsWithin } from './years'

/**
 * Sales and purchase invoices, and the credit and debit notes that return
 * them.
 *
 * A draft is worked out as it is saved -- line amounts, the taxes, rounding,
 * the tax deducted at source -- and worked out again as it is submitted, so
 * what is posted is what the rules say on the day, not what they said when the
 * draft was typed. Submitting is one act: a number from the series, the journal
 * entry, the party ledger, any stock that moves, and any fixed assets bought.
 *
 * What each posts (a credit or debit note posts the mirror image):
 *
 *   sales      Dr the customer's receivable      the invoice total
 *              Cr income, line by line           each line's amount
 *              Cr output tax, by component       the tax
 *              Dr cost of goods, Cr stock        what the stock was worth, if it left the store
 *
 *   purchase   Dr expense, stock, a fixed asset,
 *                 or goods-received-not-billed   each line's cost (with any tax that cannot be claimed)
 *              Dr input tax                      the tax that can be claimed
 *              Cr the supplier's payable         the total, less tax deducted at source
 *              Cr TDS payable                    the tax deducted
 *
 * Under reverse charge the supplier bills no tax; the institution owes it
 * itself (Cr output tax) and claims it back where it may (Dr input tax).
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

export type InvoiceKind = 'sales' | 'purchase'

export const voucherTypeOf = (kind: InvoiceKind) => (kind === 'sales' ? 'sales_invoice' : 'purchase_invoice')

const seriesOf = (kind: InvoiceKind, isReturn: boolean) =>
  kind === 'sales' ? (isReturn ? 'sales_return' : 'sales_invoice') : isReturn ? 'purchase_return' : 'purchase_invoice'

// --- the input ---------------------------------------------------------------------

const lineInput = z.object({
  itemId: optionalId,
  description: optional(500),
  qty: optional(20),
  rate: optional(24),
  /** A percentage: "10" or "12.5". */
  discount: optional(8),
  taxTemplateId: optionalId,
  accountId: optionalId,
  costCenter: optional(80),
  warehouseId: optionalId,
  batchNo: optional(60),
  expiresOn: optionalDate,
  serials: optional(4000),
  /** Carried through an edit of a draft raised from an order or a receipt. */
  orderLineId: optionalId,
  receiptLineId: optionalId,
  /** Off for input tax that may not be claimed (blocked credit). */
  itcEligible: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === true || v === 'true' || v === 'on')),
})

export const invoiceSchema = z
  .object({
    invoiceId: optionalId,
    kind: z.enum(['sales', 'purchase']),
    partyId: z.uuid(),
    postingDate: optionalDate,
    dueDate: optionalDate,
    billNo: optional(40),
    billDate: optionalDate,
    currency: optional(3).transform((v) => v?.toUpperCase()),
    exchangeRate: optional(24),
    placeOfSupply: optional(2),
    reverseCharge: z.preprocess(ticked, z.boolean()).default(false),
    updateStock: z.preprocess(ticked, z.boolean()).default(false),
    warehouseId: optionalId,
    tdsSectionId: optionalId,
    costCenter: optional(80),
    fundId: optionalId,
    memo: optional(500),
    terms: optional(4000),
    lines: z.array(lineInput).max(300).default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceInvoice' })

/** A line as the engine sees it: numbers, not text. */
export interface DraftLine {
  itemId?: string | null
  description?: string | null
  qtyMilli: number
  rateFc: number
  discountBp?: number
  taxTemplateId?: string | null
  accountId?: string | null
  costCenter?: string | null
  fundId?: string | null
  warehouseId?: string | null
  batchId?: string | null
  serials?: string[] | null
  orderLineId?: string | null
  receiptLineId?: string | null
  itcEligible?: boolean
}

export interface DraftInvoice {
  kind: InvoiceKind
  isReturn?: boolean
  returnAgainst?: string | null
  partyId: string
  postingDate?: string | null
  dueDate?: string | null
  billNo?: string | null
  billDate?: string | null
  currency?: string | null
  exchangeRate?: string | null
  placeOfSupply?: string | null
  reverseCharge?: boolean
  updateStock?: boolean
  warehouseId?: string | null
  orderId?: string | null
  tdsSectionId?: string | null
  costCenter?: string | null
  fundId?: string | null
  memo?: string | null
  terms?: string | null
  sourceModule?: string | null
  sourceRef?: string | null
  lines: DraftLine[]
}

/** The form's text, as a draft: quantities, rates and percentages parsed exactly. */
async function draftFromInput(tx: Tx, institutionId: string, data: z.infer<typeof invoiceSchema>): Promise<DraftInvoice> {
  const typed = data.lines.filter((l) => l.itemId || l.description || l.qty || l.rate)
  if (typed.length === 0) throw new FinanceError(400, 'no_lines', 'an invoice needs at least one line')
  // A rate is typed in the invoice's currency, to as many places as it has.
  const party = await partyWithin(tx, data.partyId)
  const currency = data.currency ?? party.currency ?? (await settingsWithin(tx, institutionId)).baseCurrency
  const minor = await minorUnitsOf(tx, institutionId, currency)
  const lines: DraftLine[] = []
  for (const [i, l] of typed.entries()) {
    const at = `line ${i + 1}`
    const qty = parseQty(l.qty ?? '1')
    if (qty === null || qty <= 0) throw new FinanceError(400, 'bad_qty', `${at}: the quantity is not a quantity`)
    const rate = parseDecimal(l.rate ?? '', minor)
    if (rate === null || rate < 0) throw new FinanceError(400, 'bad_amount', `${at}: the rate is not an amount`)
    const discount = l.discount ? parseDecimal(l.discount, 2) : 0
    if (discount === null || discount < 0 || discount > 10_000) {
      throw new FinanceError(400, 'bad_discount', `${at}: the discount is a percentage up to 100`)
    }
    let batchId: string | null = null
    if (l.batchNo && l.itemId) {
      batchId = await batchFor(tx, institutionId, l.itemId, l.batchNo, { expiresOn: l.expiresOn })
    }
    const serials = serialList(l.serials)
    lines.push({
      itemId: l.itemId ?? null,
      description: l.description ?? null,
      qtyMilli: qty,
      rateFc: rate,
      discountBp: discount,
      taxTemplateId: l.taxTemplateId ?? null,
      accountId: l.accountId ?? null,
      costCenter: l.costCenter ?? null,
      warehouseId: l.warehouseId ?? null,
      batchId,
      serials: serials.length ? serials : null,
      orderLineId: l.orderLineId ?? null,
      receiptLineId: l.receiptLineId ?? null,
      itcEligible: l.itcEligible ?? true,
    })
  }
  return {
    kind: data.kind,
    partyId: data.partyId,
    postingDate: data.postingDate ?? null,
    dueDate: data.dueDate ?? null,
    billNo: data.billNo ?? null,
    billDate: data.billDate ?? null,
    currency: data.currency ?? null,
    exchangeRate: data.exchangeRate ?? null,
    placeOfSupply: data.placeOfSupply ?? null,
    reverseCharge: data.reverseCharge,
    updateStock: data.updateStock,
    warehouseId: data.warehouseId ?? null,
    tdsSectionId: data.tdsSectionId ?? null,
    costCenter: data.costCenter ?? null,
    fundId: data.fundId ?? null,
    memo: data.memo ?? null,
    terms: data.terms ?? null,
    lines,
  }
}

// --- working it out ----------------------------------------------------------------

interface Computed {
  header: Omit<typeof invoices.$inferInsert, 'institutionId'>
  lines: Omit<typeof invoiceLines.$inferInsert, 'institutionId' | 'invoiceId'>[]
  taxes: Omit<typeof invoiceTaxes.$inferInsert, 'institutionId' | 'invoiceId'>[]
}

/**
 * Everything an invoice comes to, from what was typed: each line's amount in
 * the invoice's currency and in the base one, the account it goes to, the
 * taxes by component, rounding, the total, and the tax to deduct.
 */
export async function computeInvoice(
  tx: Tx,
  institutionId: string,
  draft: DraftInvoice,
  invoiceId?: string,
): Promise<Computed> {
  const settings = await settingsWithin(tx, institutionId)
  const party = await partyWithin(tx, draft.partyId)
  if (draft.kind === 'sales' && !party.isCustomer) throw new FinanceError(400, 'not_customer', `${party.name} is not a customer`)
  if (draft.kind === 'purchase' && !party.isSupplier) throw new FinanceError(400, 'not_supplier', `${party.name} is not a supplier`)
  if (party.archivedAt) throw new FinanceError(409, 'party_archived', `${party.name} is archived`)

  const postingDate = draft.postingDate ?? (await localToday(tx, institutionId))
  const currency = draft.currency ?? party.currency ?? settings.baseCurrency
  const foreign = currency !== settings.baseCurrency
  const exchangeRate = foreign ? (draft.exchangeRate ?? (await rateOn(tx, institutionId, currency, postingDate))) : '1'
  const fcMinor = await minorUnitsOf(tx, institutionId, currency)
  const baseMinor = await minorUnitsOf(tx, institutionId, settings.baseCurrency)
  const base = (fc: number) => (foreign ? toBase(fc, exchangeRate, fcMinor, baseMinor) : fc)

  const overseas = party.gstCategory === 'overseas' || party.gstCategory === 'sez'
  const placeOfSupply =
    draft.placeOfSupply ?? (draft.kind === 'sales' ? (party.stateCode ?? settings.stateCode) : settings.stateCode)
  const intra =
    draft.kind === 'sales'
      ? isIntraState(settings.stateCode, placeOfSupply, overseas)
      : isIntraState(party.stateCode, placeOfSupply, overseas)
  const reverseCharge = draft.kind === 'purchase' && !!draft.reverseCharge
  const updateStock = !!draft.updateStock
  const warehouseId = updateStock ? (draft.warehouseId ?? (await defaultWarehouse(tx, institutionId))) : null

  // Each line: its item's defaults, its amount, and where it goes in the books.
  const itemIds = [...new Set(draft.lines.map((l) => l.itemId).filter((x): x is string => !!x))]
  const itemRows = itemIds.length
    ? await tx
        .select({ item: items, group: itemGroups })
        .from(items)
        .leftJoin(itemGroups, eq(itemGroups.id, items.groupId))
        .where(inArray(items.id, itemIds))
    : []
  const itemBy = new Map(itemRows.map((r) => [r.item.id, r]))
  const categoryIds = [...new Set(itemRows.map((r) => r.item.assetCategoryId).filter((x): x is string => !!x))]
  const categories = categoryIds.length
    ? new Map(
        (await tx.select().from(assetCategories).where(inArray(assetCategories.id, categoryIds))).map((c) => [c.id, c]),
      )
    : new Map<string, typeof assetCategories.$inferSelect>()

  const outLines: Computed['lines'] = []
  for (const [i, l] of draft.lines.entries()) {
    const at = `line ${i + 1}`
    const found = l.itemId ? itemBy.get(l.itemId) : undefined
    if (l.itemId && !found) throw new FinanceError(400, 'no_such_item', `${at}: no such item`)
    const item = found?.item
    const group = found?.group
    if (item?.archivedAt) throw new FinanceError(409, 'item_archived', `${at}: ${item.name} is archived`)
    const description = l.description ?? item?.name
    if (!description) throw new FinanceError(400, 'no_description', `${at}: say what it is`)

    const gross = extend(l.qtyMilli, l.rateFc)
    const amountFc = gross - bpOf(gross, l.discountBp ?? 0)
    const isStockLine = !!item?.isStock && !l.receiptLineId
    if (item?.isStock && !updateStock && !l.receiptLineId) {
      throw new FinanceError(
        400,
        'stock_needs_store',
        draft.kind === 'sales'
          ? `${at}: ${item.name} is kept in the stores; tick "update stock" or bill it against a delivery note`
          : `${at}: ${item.name} is kept in the stores; tick "update stock" or bill it against a goods receipt`,
      )
    }
    if (item?.hasSerial && isStockLine && updateStock && (l.serials?.length ?? 0) * 1000 !== l.qtyMilli) {
      throw new FinanceError(400, 'serials_required', `${at}: list one serial number for each ${item.name}`)
    }
    if (item?.hasBatch && isStockLine && updateStock && !l.batchId) {
      throw new FinanceError(400, 'batch_required', `${at}: ${item.name} is kept by batch; say which`)
    }

    let accountId = l.accountId ?? null
    if (!accountId) {
      if (draft.kind === 'sales') {
        accountId = item?.incomeAccountId ?? group?.incomeAccountId ?? (await accountFor(tx, institutionId, 'sales_income'))
      } else if (item?.isAsset) {
        const cat = categories.get(item.assetCategoryId!)
        if (!cat) throw new FinanceError(400, 'no_asset_category', `${at}: ${item.name} names no asset category`)
        accountId = cat.assetAccountId
      } else if (!item?.isStock) {
        accountId =
          item?.expenseAccountId ?? group?.expenseAccountId ?? (await accountFor(tx, institutionId, 'purchase_expense'))
      }
    }

    outLines.push({
      seq: i + 1,
      itemId: item?.id ?? null,
      description,
      hsnSac: item?.hsnSac ?? null,
      qtyMilli: l.qtyMilli,
      uom: item?.uom ?? null,
      rateFc: l.rateFc,
      discountBp: l.discountBp ?? 0,
      amountFc,
      amountPaise: base(amountFc),
      taxTemplateId: l.taxTemplateId ?? item?.taxTemplateId ?? group?.taxTemplateId ?? null,
      accountId,
      costCenter: l.costCenter ?? draft.costCenter ?? null,
      fundId: l.fundId ?? draft.fundId ?? null,
      warehouseId: isStockLine && updateStock ? (l.warehouseId ?? warehouseId) : null,
      batchId: l.batchId ?? null,
      serials: l.serials?.length ? l.serials : null,
      orderLineId: l.orderLineId ?? null,
      receiptLineId: l.receiptLineId ?? null,
      itcEligible: l.itcEligible ?? true,
    })
  }

  // Taxes, once per component on the sum of each template's lines.
  const templateIds = [...new Set(outLines.map((l) => l.taxTemplateId).filter((x): x is string => !!x))]
  const templates = await templatesWithin(tx, templateIds)
  const rows = computeTaxes(
    outLines.map((l) => ({ amount: l.amountFc, templateId: l.taxTemplateId ?? null, itcEligible: l.itcEligible ?? true })),
    templates,
    intra,
    draft.kind,
  )
  const fallbackTax = rows.some((r) => !r.accountId)
    ? await accountFor(tx, institutionId, draft.kind === 'sales' ? 'gst_output' : 'gst_input')
    : null
  const taxes: Computed['taxes'] = rows
    .filter((r) => r.tax !== 0)
    .map((r) => ({
      templateId: r.templateId,
      component: r.component,
      rateBp: r.rateBp,
      accountId: r.accountId ?? fallbackTax,
      taxableFc: r.taxable,
      taxFc: r.tax,
      taxPaise: base(r.tax),
      ineligiblePaise: r.ineligible ? Math.min(base(r.ineligible), base(r.tax)) : 0,
    }))

  const netFc = outLines.reduce((n, l) => n + l.amountFc, 0)
  const taxFc = taxes.reduce((n, t) => n + t.taxFc, 0)
  const billedFc = reverseCharge ? 0 : taxFc
  // Rounded to the whole unit when the institution rounds its invoices: one
  // rupee, the way a bill is printed and paid.
  const unit = 10 ** fcMinor
  const roundingFc =
    settings.roundInvoices && fcMinor > 0
      ? Number(divRound(BigInt(netFc + billedFc), BigInt(unit))) * unit - (netFc + billedFc)
      : 0
  const totalFc = netFc + billedFc + roundingFc
  const netPaise = outLines.reduce((n, l) => n + l.amountPaise, 0)
  const taxPaise = taxes.reduce((n, t) => n + t.taxPaise, 0)
  const totalPaise = netPaise + (reverseCharge ? 0 : taxPaise) + base(roundingFc)

  // Tax deducted at source: on a supplier's bill in the base currency, by its
  // section's thresholds; on a debit note, the share of what the bill deducted.
  let tdsSectionId: string | null = null
  let tdsPaise = 0
  if (draft.kind === 'purchase') {
    tdsSectionId = draft.tdsSectionId ?? party.tdsSectionId ?? null
    if (tdsSectionId && foreign) {
      throw new FinanceError(400, 'tds_foreign', 'tax is deducted at source on bills in the base currency only')
    }
    if (tdsSectionId && draft.isReturn && draft.returnAgainst) {
      const [orig] = await tx.select().from(invoices).where(eq(invoices.id, draft.returnAgainst))
      const origNet = orig ? toBase(orig.netFc, orig.exchangeRate, fcMinor, baseMinor) : 0
      tdsPaise = orig && origNet > 0 ? Math.min(mulDiv(orig.tdsPaise, netPaise, origNet), orig.tdsPaise) : 0
    } else if (tdsSectionId) {
      const fy = await fiscalYearOf(tx, institutionId, postingDate)
      tdsPaise = await tdsFor(tx, {
        sectionId: tdsSectionId,
        partyId: party.id,
        hasPan: !!party.pan,
        amountPaise: netPaise,
        fyStart: fy.startsOn,
        fyEnd: fy.endsOn,
        excludeInvoiceId: invoiceId,
      })
    }
    if (tdsPaise > totalPaise) tdsPaise = totalPaise
  }

  const dueDate =
    draft.dueDate ?? (party.paymentTermsDays && !draft.isReturn ? addDays(postingDate, party.paymentTermsDays) : null)
  if (dueDate && dueDate < postingDate) throw new FinanceError(400, 'bad_due_date', 'the due date is before the invoice')

  return {
    header: {
      kind: draft.kind,
      isReturn: !!draft.isReturn,
      returnAgainst: draft.returnAgainst ?? null,
      partyId: party.id,
      postingDate,
      dueDate,
      billNo: draft.kind === 'purchase' ? (draft.billNo ?? null) : null,
      billDate: draft.kind === 'purchase' ? (draft.billDate ?? null) : null,
      currency,
      exchangeRate,
      placeOfSupply: placeOfSupply ?? null,
      reverseCharge,
      updateStock,
      warehouseId,
      orderId: draft.orderId ?? null,
      netFc,
      taxFc,
      roundingFc,
      totalFc,
      totalPaise,
      tdsSectionId,
      tdsPaise,
      costCenter: draft.costCenter ?? null,
      fundId: draft.fundId ?? null,
      memo: draft.memo ?? null,
      terms: draft.terms ?? null,
      sourceModule: draft.sourceModule ?? null,
      sourceRef: draft.sourceRef ?? null,
    },
    lines: outLines,
    taxes,
  }
}

async function writeComputed(tx: Tx, institutionId: string, invoiceId: string, c: Computed) {
  await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))
  await tx.delete(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId))
  if (c.lines.length) await tx.insert(invoiceLines).values(c.lines.map((l) => ({ ...l, institutionId, invoiceId })))
  if (c.taxes.length) await tx.insert(invoiceTaxes).values(c.taxes.map((t) => ({ ...t, institutionId, invoiceId })))
}

/**
 * Save a draft, inside a transaction somebody else opened: how an order, a
 * goods receipt or another module raises an invoice.
 */
export async function saveDraftWithin(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  draft: DraftInvoice,
  invoiceId?: string,
): Promise<string> {
  if (invoiceId) {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update')
    if (!row) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
    if (row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
    if (row.kind !== draft.kind) throw new FinanceError(400, 'kind_fixed', 'a draft keeps its kind')
    draft = { ...draft, isReturn: row.isReturn, returnAgainst: row.returnAgainst, orderId: draft.orderId ?? row.orderId }
    const c = await computeInvoice(tx, institutionId, draft, invoiceId)
    await tx.update(invoices).set(c.header).where(eq(invoices.id, invoiceId))
    await writeComputed(tx, institutionId, invoiceId, c)
    return invoiceId
  }
  const c = await computeInvoice(tx, institutionId, draft)
  const [row] = await tx
    .insert(invoices)
    .values({ ...c.header, institutionId, createdBy: actorId })
    .returning({ id: invoices.id })
  await writeComputed(tx, institutionId, row!.id, c)
  return row!.id
}

export async function saveInvoice(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = invoiceSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const draft = await draftFromInput(tx, tenant, data)
      const id = await saveDraftWithin(tx, tenant, actor.id, draft, data.invoiceId)
      if (data.submit) return submitWithin(tx, actor, id)
      return { id, notice: 'Saved as a draft.', next: `/m/finance/invoice?id=${id}` }
    }),
  )
}

export async function deleteInvoice(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { invoiceId } = z.object({ invoiceId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId))
      if (!row) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
      await tx.delete(invoices).where(eq(invoices.id, invoiceId))
      return { notice: 'Draft deleted.', next: `/m/finance/invoices?kind=${row.kind}` }
    }),
  )
}

// --- submitting --------------------------------------------------------------------

/** What an approver signs off: the substance of the bill, not its ids. */
export function approvalViewOfInvoice(
  inv: typeof invoices.$inferSelect,
  ls: (typeof invoiceLines.$inferSelect)[],
) {
  return {
    partyId: inv.partyId,
    currency: inv.currency,
    totalFc: inv.totalFc,
    billNo: inv.billNo,
    lines: ls.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      qtyMilli: l.qtyMilli,
      rateFc: l.rateFc,
      discountBp: l.discountBp,
      taxTemplateId: l.taxTemplateId,
      accountId: l.accountId,
    })),
  }
}

/** What is still owed on an invoice, in its own currency. */
export async function outstandingOf(tx: Tx, invoiceId: string): Promise<{ fc: number; paise: number }> {
  const [row] = await tx
    .select({
      fc: sql<number>`coalesce(sum(${partyLedger.amountFc}), 0)::bigint`,
      paise: sql<number>`coalesce(sum(${partyLedger.amountPaise}), 0)::bigint`,
    })
    .from(partyLedger)
    .where(eq(partyLedger.againstId, invoiceId))
  return { fc: Number(row?.fc ?? 0), paise: Number(row?.paise ?? 0) }
}

/** The receivable or payable account a party's balance sits in. */
export async function partyAccountOf(tx: Tx, institutionId: string, partyId: string, side: 'receivable' | 'payable') {
  const party = await partyWithin(tx, partyId)
  if (side === 'receivable') return party.receivableAccountId ?? accountFor(tx, institutionId, 'accounts_receivable')
  return party.payableAccountId ?? accountFor(tx, institutionId, 'accounts_payable')
}

export async function submitInvoice(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z
    .object({ invoiceId: z.uuid(), overrideCreditLimit: z.preprocess(ticked, z.boolean()).default(false) })
    .parse(input)
  return withTenant(tenant, (tx) => named(() => submitWithin(tx, actor, data.invoiceId, data.overrideCreditLimit)))
}

type GlLine = {
  accountId: string
  debitPaise: number
  creditPaise: number
  costCenter?: string | null
  fundId?: string | null
  partyId?: string | null
  currency?: string | null
  amountFc?: number | null
  exchangeRate?: string | null
  memo?: string | null
}

/** A signed amount as a journal line: positive is a debit. */
function signed(accountId: string, v: number, extra: Omit<GlLine, 'accountId' | 'debitPaise' | 'creditPaise'> = {}): GlLine {
  return { accountId, debitPaise: v > 0 ? v : 0, creditPaise: v < 0 ? -v : 0, ...extra }
}

export async function submitWithin(tx: Tx, actor: Actor, invoiceId: string, overrideCreditLimit = false) {
  const tenant = actor.institutionId!
  const [draftRow] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update')
  if (!draftRow) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
  if (draftRow.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that invoice is not a draft')

  // Worked out again, as of now: a rate, a threshold or a template may have
  // changed since the draft was saved.
  const stored = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.seq))
  const c = await computeInvoice(
    tx,
    tenant,
    {
      ...draftRow,
      lines: stored.map((l) => ({
        itemId: l.itemId,
        description: l.description,
        qtyMilli: l.qtyMilli,
        rateFc: l.rateFc,
        discountBp: l.discountBp,
        taxTemplateId: l.taxTemplateId,
        accountId: l.accountId,
        costCenter: l.costCenter,
        fundId: l.fundId,
        warehouseId: l.warehouseId,
        batchId: l.batchId,
        serials: l.serials,
        orderLineId: l.orderLineId,
        receiptLineId: l.receiptLineId,
        itcEligible: l.itcEligible,
      })),
    },
    invoiceId,
  )
  await tx.update(invoices).set(c.header).where(eq(invoices.id, invoiceId))
  await writeComputed(tx, tenant, invoiceId, c)
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId))
  const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.seq))
  const txs = await tx.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId))
  const party = await partyWithin(tx, inv!.partyId)
  const voucherType = voucherTypeOf(inv!.kind)
  const sign = inv!.isReturn ? -1 : 1

  if (inv!.kind === 'purchase' && !inv!.isReturn) {
    await assertApproved(tx, 'purchase_invoice', invoiceId, approvalViewOfInvoice(inv!, ls), inv!.totalPaise)
  }

  // A customer over their credit limit is refused unless an administrator says otherwise.
  if (inv!.kind === 'sales' && !inv!.isReturn && party.creditLimitPaise !== null) {
    const [owed] = await tx
      .select({ v: sql<number>`coalesce(sum(${partyLedger.amountPaise}), 0)::bigint` })
      .from(partyLedger)
      .where(and(eq(partyLedger.partyId, party.id), eq(partyLedger.side, 'receivable')))
    const after = Number(owed?.v ?? 0) + inv!.totalPaise
    if (after > party.creditLimitPaise && !(overrideCreditLimit && canConfigure(actor.role))) {
      throw new FinanceError(409, 'credit_limit', `${party.name} would owe more than their credit limit`, {
        limitPaise: party.creditLimitPaise,
        wouldOwePaise: after,
      })
    }
  }

  const number = await nextNumber(tx, tenant, seriesOf(inv!.kind, inv!.isReturn), inv!.postingDate)
  const fc = inv!.currency !== (await settingsWithin(tx, tenant)).baseCurrency
  const partyFc = fc ? { currency: inv!.currency, exchangeRate: inv!.exchangeRate } : {}
  const gl: GlLine[] = []
  const memoOf = `${number} ${party.name}`.slice(0, 200)

  // Stock that moves with the invoice.
  let moved: Moved[]
  const stockMoves: Movement[] = []
  for (const l of ls) {
    if (!l.warehouseId || !l.itemId) continue
    if (inv!.kind === 'sales') {
      let ratePaise: number | null = null
      if (inv!.isReturn && inv!.returnAgainst) {
        // Back into the store at what it left at.
        const [orig] = await tx
          .select({ q: stockLedger.qtyChangeMilli, v: stockLedger.valueChangePaise })
          .from(stockLedger)
          .where(
            and(
              eq(stockLedger.voucherType, voucherType),
              eq(stockLedger.voucherId, inv!.returnAgainst),
              eq(stockLedger.itemId, l.itemId),
            ),
          )
          .limit(1)
        ratePaise = orig && orig.q !== 0 ? mulDiv(orig.v, 1000, orig.q) : await valuationRate(tx, l.itemId, l.warehouseId)
      }
      stockMoves.push({
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        qtyMilli: -sign * l.qtyMilli,
        ratePaise,
        batchId: l.batchId,
        serials: l.serials,
        voucherLineId: l.id,
      })
    } else {
      stockMoves.push({
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        qtyMilli: sign * l.qtyMilli,
        // Value is filled in below, once the ineligible tax is shared out.
        batchId: l.batchId,
        serials: l.serials,
        voucherLineId: l.id,
      })
    }
  }

  if (inv!.kind === 'sales') {
    const receivable = await partyAccountOf(tx, tenant, party.id, 'receivable')
    gl.push(signed(receivable, sign * inv!.totalPaise, { partyId: party.id, amountFc: fc ? inv!.totalFc : null, ...partyFc }))
    for (const l of ls) {
      gl.push(signed(l.accountId!, -sign * l.amountPaise, { costCenter: l.costCenter, fundId: l.fundId }))
    }
    for (const t of txs) gl.push(signed(t.accountId!, -sign * t.taxPaise))
    const roundingPaise = inv!.totalPaise - ls.reduce((n, l) => n + l.amountPaise, 0) - txs.reduce((n, t) => n + t.taxPaise, 0)
    if (roundingPaise) gl.push(signed(await accountFor(tx, tenant, 'round_off'), -sign * roundingPaise))

    if (stockMoves.length) {
      moved = await moveStock(tx, tenant, stockMoves, { voucherType, voucherId: invoiceId, postingDate: inv!.postingDate })
      const cogs = await accountFor(tx, tenant, 'cost_of_goods')
      const byLine = new Map(ls.map((l) => [l.id, l]))
      gl.push(
        ...stockLines(moved, (m) => ({
          accountId: cogs,
          costCenter: byLine.get(m.voucherLineId!)?.costCenter ?? inv!.costCenter,
          fundId: byLine.get(m.voucherLineId!)?.fundId ?? inv!.fundId,
        })),
      )
    }
  } else {
    // Tax that may not be claimed is a cost of the lines it was charged on,
    // shared out by amount among them -- the last takes what rounding leaves.
    const share = new Map<string, number>()
    for (const t of txs) {
      if (!t.ineligiblePaise) continue
      const on = ls.filter((l) => l.taxTemplateId === t.templateId && !l.itcEligible)
      const total = on.reduce((n, l) => n + l.amountPaise, 0)
      let left = t.ineligiblePaise
      on.forEach((l, i) => {
        const part = i === on.length - 1 ? left : total ? mulDiv(t.ineligiblePaise, l.amountPaise, total) : 0
        left -= part
        share.set(l.id, (share.get(l.id) ?? 0) + part)
      })
    }
    const costOf = (l: (typeof ls)[number]) => l.amountPaise + (share.get(l.id) ?? 0)

    const payable = await partyAccountOf(tx, tenant, party.id, 'payable')
    gl.push(
      signed(payable, -sign * (inv!.totalPaise - inv!.tdsPaise), {
        partyId: party.id,
        amountFc: fc ? inv!.totalFc : null,
        ...partyFc,
      }),
    )
    if (inv!.tdsPaise) {
      const [section] = inv!.tdsSectionId
        ? await tx.select().from(tdsSections).where(eq(tdsSections.id, inv!.tdsSectionId))
        : []
      const tdsAccount = section?.payableAccountId ?? (await accountFor(tx, tenant, 'tds_payable'))
      gl.push(signed(tdsAccount, -sign * inv!.tdsPaise, { partyId: party.id }))
    }

    // Lines bought against a goods receipt clear what the receipt put in
    // goods-received-not-billed, at the receipt's value; a different price on
    // the bill is a stock adjustment.
    const receiptIds = ls.map((l) => l.receiptLineId).filter((x): x is string => !!x)
    const received = receiptIds.length
      ? new Map(
          (await tx.select().from(receiptLines).where(inArray(receiptLines.id, receiptIds))).map((r) => [r.id, r]),
        )
      : new Map<string, typeof receiptLines.$inferSelect>()
    const srnb = receiptIds.length ? await accountFor(tx, tenant, 'stock_received_not_billed') : null
    const adjust = await accountFor(tx, tenant, 'stock_adjustment')

    for (const l of ls) {
      const cost = costOf(l)
      const dims = { costCenter: l.costCenter, fundId: l.fundId }
      if (l.receiptLineId) {
        const r = received.get(l.receiptLineId)!
        const cleared = r.qtyMilli > 0 ? mulDiv(r.amountPaise, l.qtyMilli, r.qtyMilli) : 0
        gl.push(signed(srnb!, sign * cleared, dims))
        if (cost !== cleared) gl.push(signed(adjust, sign * (cost - cleared), dims))
      } else if (l.warehouseId) {
        const m = stockMoves.find((s) => s.voucherLineId === l.id)!
        if (!inv!.isReturn) m.valuePaise = cost
      } else {
        gl.push(signed(l.accountId!, sign * cost, dims))
      }
    }
    for (const t of txs) {
      const claimable = t.taxPaise - t.ineligiblePaise
      if (claimable) gl.push(signed(t.accountId!, sign * claimable))
    }
    if (inv!.reverseCharge) {
      // The institution owes the tax itself.
      const templates = await templatesWithin(tx, [...new Set(txs.map((t) => t.templateId).filter((x): x is string => !!x))])
      const output = await accountFor(tx, tenant, 'gst_output')
      for (const t of txs) {
        const comp = t.templateId
          ? templates.get(t.templateId)?.components.find((x) => x.component === t.component)
          : undefined
        gl.push(signed(comp?.outputAccountId ?? output, -sign * t.taxPaise))
      }
    }
    const billedTax = inv!.reverseCharge ? 0 : txs.reduce((n, t) => n + t.taxPaise, 0)
    const roundingPaise = inv!.totalPaise - ls.reduce((n, l) => n + l.amountPaise, 0) - billedTax
    if (roundingPaise) gl.push(signed(await accountFor(tx, tenant, 'round_off'), sign * roundingPaise))

    if (stockMoves.length) {
      moved = await moveStock(tx, tenant, stockMoves, { voucherType, voucherId: invoiceId, postingDate: inv!.postingDate })
      for (const m of moved) {
        const l = ls.find((x) => x.id === m.voucherLineId)!
        gl.push(signed(m.stockAccountId, m.valueChangePaise, { costCenter: l.costCenter, fundId: l.fundId }))
        // A debit note takes stock out at what the store says it is worth;
        // the bill's price for it may differ.
        if (inv!.isReturn && -m.valueChangePaise !== costOf(l)) {
          gl.push(signed(adjust, m.valueChangePaise + costOf(l), { costCenter: l.costCenter, fundId: l.fundId }))
        }
      }
    }
  }

  const posted = await postWithin(tx, tenant, actor.id, {
    postingDate: inv!.postingDate,
    memo: memoOf,
    sourceModule: MODULE,
    sourceRef: `${voucherType}:${invoiceId}`,
    lines: mergeLines(gl),
  })

  // The party ledger: what is owed on this invoice, or what a return takes
  // off the invoice it returns -- up to what is still open on it; the rest
  // stands to the party's credit.
  const side = inv!.kind === 'sales' ? 'receivable' : 'payable'
  const partyAccount = await partyAccountOf(tx, tenant, party.id, side)
  const owedFc = inv!.totalFc - inv!.tdsPaise
  const owedPaise = inv!.totalPaise - inv!.tdsPaise
  const row = (againstId: string | null, amountFc: number, amountPaise: number) => ({
    institutionId: tenant,
    partyId: party.id,
    side: side as 'receivable' | 'payable',
    accountId: partyAccount,
    voucherType,
    voucherId: invoiceId,
    againstId,
    postingDate: inv!.postingDate,
    dueDate: inv!.dueDate,
    currency: inv!.currency,
    amountFc,
    amountPaise,
  })
  if (!inv!.isReturn) {
    await tx.insert(partyLedger).values(row(invoiceId, owedFc, owedPaise))
  } else {
    const open = inv!.returnAgainst ? await outstandingOf(tx, inv!.returnAgainst) : { fc: 0, paise: 0 }
    const applied = Math.max(Math.min(owedFc, open.fc), 0)
    const appliedPaise = applied === owedFc ? owedPaise : mulDiv(owedPaise, applied, owedFc)
    if (applied > 0) await tx.insert(partyLedger).values(row(inv!.returnAgainst!, -applied, -appliedPaise))
    if (owedFc - applied > 0) await tx.insert(partyLedger).values(row(null, -(owedFc - applied), -(owedPaise - appliedPaise)))
  }

  // Fixed assets bought: a draft asset for each unit (or for the line, when
  // it is not counted in whole units), to be capitalised when it is in use.
  if (inv!.kind === 'purchase' && !inv!.isReturn) {
    const assetItems = ls.filter((l) => l.itemId && !l.warehouseId && !l.receiptLineId)
    for (const l of assetItems) {
      const [item] = await tx.select().from(items).where(eq(items.id, l.itemId!))
      if (!item?.isAsset) continue
      const cost = l.amountPaise + (await ineligibleShareFor(txs, ls, l))
      const units = l.qtyMilli % 1000 === 0 && l.qtyMilli <= 100_000 ? l.qtyMilli / 1000 : 1
      let left = cost
      const serialsOf = l.serials ?? []
      for (let u = 0; u < units; u++) {
        const gross = u === units - 1 ? left : Math.floor(cost / units)
        left -= gross
        if (gross <= 0) continue
        await tx.insert(assets).values({
          institutionId: tenant,
          name: units > 1 ? `${item.name} (${u + 1} of ${units})` : item.name,
          categoryId: item.assetCategoryId!,
          itemId: item.id,
          invoiceLineId: l.id,
          supplierId: party.id,
          costCenter: l.costCenter,
          fundId: l.fundId,
          purchasedOn: inv!.postingDate,
          inUseOn: inv!.postingDate,
          grossPaise: gross,
          note: serialsOf[u] ? `Serial ${serialsOf[u]}` : null,
          createdBy: actor.id,
        })
      }
    }
  }

  await tx.update(invoices).set({ number, entryId: posted.id }).where(eq(invoices.id, invoiceId))
  await submitDocument(tx, invoices, invoiceId, {
    institutionId: tenant,
    actorId: actor.id,
    actorEmail: actor.email,
    moduleId: MODULE,
  })
  return {
    id: invoiceId,
    number,
    notice: `${number} submitted.`,
    next: `/m/finance/invoice?id=${invoiceId}`,
  }
}

async function ineligibleShareFor(
  txs: (typeof invoiceTaxes.$inferSelect)[],
  ls: (typeof invoiceLines.$inferSelect)[],
  line: (typeof invoiceLines.$inferSelect),
): Promise<number> {
  if (line.itcEligible) return 0
  let share = 0
  for (const t of txs) {
    if (!t.ineligiblePaise || t.templateId !== line.taxTemplateId) continue
    const on = ls.filter((l) => l.taxTemplateId === t.templateId && !l.itcEligible)
    const total = on.reduce((n, l) => n + l.amountPaise, 0)
    let left = t.ineligiblePaise
    for (const [i, l] of on.entries()) {
      const part = i === on.length - 1 ? left : total ? mulDiv(t.ineligiblePaise, l.amountPaise, total) : 0
      left -= part
      if (l.id === line.id) share += part
    }
  }
  return share
}

/**
 * Lines on the same account with the same dimensions, netted into one: an
 * invoice of forty lines to one income account posts one credit, not forty.
 * A line that names a party or a currency stays as it is.
 */
export function mergeLines(gl: GlLine[]): GlLine[] {
  const out: GlLine[] = []
  const by = new Map<string, GlLine & { net: number }>()
  for (const l of gl) {
    if (l.partyId || l.currency) {
      if (l.debitPaise || l.creditPaise) out.push(l)
      continue
    }
    const k = `${l.accountId}|${l.costCenter ?? ''}|${l.fundId ?? ''}`
    const s = by.get(k) ?? { ...l, net: 0 }
    s.net += l.debitPaise - l.creditPaise
    by.set(k, s)
  }
  for (const s of by.values()) {
    if (s.net === 0) continue
    out.push({
      accountId: s.accountId,
      debitPaise: s.net > 0 ? s.net : 0,
      creditPaise: s.net < 0 ? -s.net : 0,
      costCenter: s.costCenter ?? null,
      fundId: s.fundId ?? null,
      memo: s.memo ?? null,
    })
  }
  return out
}

// --- cancelling, amending, returning -----------------------------------------------

export async function cancelInvoice(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ invoiceId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, data.invoiceId)).for('update')
      if (!inv) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
      if (inv.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted invoice is cancelled')
      const voucherType = voucherTypeOf(inv.kind)

      const [settled] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(partyLedger)
        .where(and(eq(partyLedger.againstId, inv.id), ne(partyLedger.voucherId, inv.id)))
      if (settled!.n > 0) {
        throw new FinanceError(
          409,
          'invoice_settled',
          'payments, returns or advances stand against it; cancel or take those back first',
        )
      }
      const [returned] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(and(eq(invoices.returnAgainst, inv.id), eq(invoices.docstatus, 'submitted')))
      if (returned!.n > 0) throw new FinanceError(409, 'invoice_returned', 'a return stands against it; cancel that first')

      // Assets it bought: drafts go with it; one already in the books stays,
      // and so does the invoice until that asset is cancelled.
      const lineIds = (await tx.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))).map(
        (r) => r.id,
      )
      if (lineIds.length) {
        const bought = await tx.select().from(assets).where(inArray(assets.invoiceLineId, lineIds))
        if (bought.some((a) => a.docstatus === 'submitted')) {
          throw new FinanceError(409, 'assets_capitalised', 'an asset it bought is in the books; cancel or dispose of it first')
        }
        const drafts = bought.filter((a) => a.docstatus === 'draft').map((a) => a.id)
        if (drafts.length) await tx.delete(assets).where(inArray(assets.id, drafts))
      }

      // A credit or debit note whose credit was set against other invoices
      // takes it back first; those invoices are open again.
      if (inv.isReturn) await unapplyAdvances(tx, tenant, actor.id, inv.id)
      await reverseStock(tx, tenant, actor.id, voucherType, inv.id)
      if (inv.entryId) await reverseWithin(tx, tenant, actor.id, inv.entryId, data.reason)
      const own = await tx
        .select()
        .from(partyLedger)
        .where(and(eq(partyLedger.voucherType, voucherType), eq(partyLedger.voucherId, inv.id)))
      if (own.length) {
        await tx.insert(partyLedger).values(
          own.map((r) => ({ ...without(r, 'id', 'createdAt'), amountFc: -r.amountFc, amountPaise: -r.amountPaise })),
        )
      }
      await cancelDocument(tx, invoices, inv.id, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email,
        moduleId: MODULE,
        reason: data.reason,
      })
      return { notice: `${inv.number} cancelled.` }
    }),
  )
}

/** A cancelled invoice, copied into a new draft that says which it replaces. */
export async function amendInvoice(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { invoiceId } = z.object({ invoiceId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const copy = await amendDocument(
        tx,
        invoices,
        invoiceId,
        { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE },
        { number: null, entry_id: null, created_by: actor.id },
      )
      const newId = String(copy.id)
      const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))
      if (ls.length) {
        await tx.insert(invoiceLines).values(ls.map((l) => ({ ...without(l, 'id'), invoiceId: newId })))
      }
      const ts = await tx.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId))
      if (ts.length) {
        await tx.insert(invoiceTaxes).values(ts.map((t) => ({ ...without(t, 'id'), invoiceId: newId })))
      }
      return { id: newId, notice: 'Amended into a new draft.', next: `/m/finance/invoice?id=${newId}` }
    }),
  )
}

export const returnSchema = z
  .object({
    invoiceId: z.uuid(),
    postingDate: optionalDate,
    /** Per line of the original, how much comes back; left blank, all of it. */
    lines: z
      .array(z.object({ lineId: optionalId, qty: optional(20) }))
      .max(300)
      .default([]),
    memo: optional(500),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceInvoiceReturn' })

/**
 * A credit note (a sales return) or a debit note (a purchase return) against
 * a submitted invoice, for some or all of what it billed, at its prices and
 * taxes.
 */
export async function makeReturn(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = returnSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, data.invoiceId))
      if (!inv) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
      if (inv.docstatus !== 'submitted' || inv.isReturn) {
        throw new FinanceError(409, 'not_returnable', 'only a submitted invoice is returned against')
      }
      const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.seq))
      // What earlier returns have already taken back, line by line.
      const back = await tx
        .select({ itemId: invoiceLines.itemId, description: invoiceLines.description, qty: invoiceLines.qtyMilli })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(and(eq(invoices.returnAgainst, inv.id), ne(invoices.docstatus, 'cancelled')))
      const taken = (l: (typeof ls)[number]) =>
        back.filter((b) => b.itemId === l.itemId && b.description === l.description).reduce((n, b) => n + b.qty, 0)

      const wanted = new Map(
        data.lines.filter((l) => l.lineId && l.qty).map((l) => [l.lineId!, parseQty(l.qty)]),
      )
      const lines: DraftLine[] = []
      for (const l of ls) {
        const left = l.qtyMilli - taken(l)
        const qty = data.lines.length ? (wanted.get(l.id) ?? 0) : left
        if (qty === null || qty < 0) throw new FinanceError(400, 'bad_qty', 'a quantity is not a quantity')
        if (qty === 0) continue
        if (qty > left) {
          throw new FinanceError(409, 'over_return', `only ${formatQty(left)} of ${l.description} is left to return`)
        }
        lines.push({
          itemId: l.itemId,
          description: l.description,
          qtyMilli: qty,
          rateFc: l.rateFc,
          discountBp: l.discountBp,
          taxTemplateId: l.taxTemplateId,
          accountId: l.accountId,
          costCenter: l.costCenter,
          fundId: l.fundId,
          warehouseId: l.warehouseId,
          batchId: l.batchId,
          serials: l.serials ? l.serials.slice(0, qty / 1000) : null,
          orderLineId: l.orderLineId,
          receiptLineId: l.receiptLineId,
          itcEligible: l.itcEligible,
        })
      }
      if (lines.length === 0) throw new FinanceError(409, 'nothing_to_return', 'nothing is left to return on it')

      const id = await saveDraftWithin(tx, tenant, actor.id, {
        kind: inv.kind,
        isReturn: true,
        returnAgainst: inv.id,
        partyId: inv.partyId,
        postingDate: data.postingDate ?? null,
        currency: inv.currency,
        exchangeRate: inv.exchangeRate,
        placeOfSupply: inv.placeOfSupply,
        reverseCharge: inv.reverseCharge,
        updateStock: inv.updateStock,
        warehouseId: inv.warehouseId,
        tdsSectionId: inv.tdsSectionId,
        costCenter: inv.costCenter,
        fundId: inv.fundId,
        memo: data.memo ?? `Return against ${inv.number}`,
        lines,
      })
      if (data.submit) return submitWithin(tx, actor, id)
      return { id, notice: 'Return saved as a draft.', next: `/m/finance/invoice?id=${id}` }
    }),
  )
}

// --- reading -----------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'cancelled' | 'return' | 'paid' | 'partly_paid' | 'unpaid' | 'overdue'

export function statusOf(
  inv: { docstatus: string; isReturn: boolean; dueDate: string | null; totalFc: number; tdsPaise: number },
  outstandingFc: number,
  today: string,
): InvoiceStatus {
  if (inv.docstatus === 'draft') return 'draft'
  if (inv.docstatus === 'cancelled') return 'cancelled'
  if (inv.isReturn) return 'return'
  if (outstandingFc <= 0) return 'paid'
  if (inv.dueDate && inv.dueDate < today) return 'overdue'
  return outstandingFc < inv.totalFc - inv.tdsPaise ? 'partly_paid' : 'unpaid'
}

export async function listInvoices(
  actor: Actor,
  input: { kind?: InvoiceKind; status?: string; partyId?: string; q?: string; from?: string; to?: string } = {},
) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const today = await localToday(tx, tenant)
    const rows = await tx
      .select({
        inv: invoices,
        partyName: parties.name,
        outstandingFc: sql<number>`coalesce((select sum(p.amount_fc) from finance_party_ledger p where p.against_id = "finance_invoices"."id"), 0)::bigint`,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.partyId))
      .where(
        and(
          input.kind ? eq(invoices.kind, input.kind) : undefined,
          input.partyId ? eq(invoices.partyId, input.partyId) : undefined,
          input.from ? sql`${invoices.postingDate} >= ${input.from}` : undefined,
          input.to ? sql`${invoices.postingDate} <= ${input.to}` : undefined,
          input.q
            ? sql`(${invoices.number} ilike ${`%${input.q}%`} or ${parties.name} ilike ${`%${input.q}%`} or ${invoices.billNo} ilike ${`%${input.q}%`})`
            : undefined,
          input.status === 'draft' || input.status === 'cancelled' ? eq(invoices.docstatus, input.status) : undefined,
        ),
      )
      .orderBy(desc(invoices.postingDate), desc(invoices.createdAt))
      .limit(1000)
    const out = rows.map((r) => ({
      ...r.inv,
      partyName: r.partyName,
      outstandingFc: Number(r.outstandingFc),
      status: statusOf(r.inv, Number(r.outstandingFc), today),
    }))
    return input.status && !['draft', 'cancelled'].includes(input.status)
      ? out.filter((r) => r.status === input.status || (input.status === 'open' && ['unpaid', 'partly_paid', 'overdue'].includes(r.status)))
      : out
  })
}

export async function invoiceDetail(actor: Actor, invoiceId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId))
    if (!inv) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
    const party = await partyWithin(tx, inv.partyId)
    const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.seq))
    const ts = await tx.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId))
    const outstanding = await outstandingOf(tx, invoiceId)
    const settlements = await tx
      .select()
      .from(partyLedger)
      .where(and(eq(partyLedger.againstId, invoiceId), ne(partyLedger.voucherId, invoiceId)))
      .orderBy(asc(partyLedger.postingDate))
    const returns = await tx
      .select({ id: invoices.id, number: invoices.number, totalFc: invoices.totalFc, docstatus: invoices.docstatus })
      .from(invoices)
      .where(eq(invoices.returnAgainst, invoiceId))
    const posting = inv.entryId
      ? await tx.select().from(glLines).where(eq(glLines.entryId, inv.entryId))
      : []
    const bought = ls.length
      ? await tx
          .select({ id: assets.id, name: assets.name, number: assets.number, docstatus: assets.docstatus })
          .from(assets)
          .where(and(isNotNull(assets.invoiceLineId), inArray(assets.invoiceLineId, ls.map((l) => l.id))))
      : []
    const today = await localToday(tx, tenant)
    return {
      invoice: inv,
      party,
      lines: ls,
      taxes: ts,
      outstanding,
      status: statusOf(inv, outstanding.fc, today),
      settlements,
      returns,
      posting,
      assets: bought,
      approvals: await approvalsFor(tx, 'purchase_invoice', invoiceId),
    }
  })
}
