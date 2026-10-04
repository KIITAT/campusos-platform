import { eq } from 'drizzle-orm'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { db, institutions, withTenant } from '@campusos/db'
import { accounts, invoiceLines, invoices, invoiceTaxes, orderLines, orders, parties, payments, paymentAllocations } from '../schema'
import { FinanceError, requireRead, type Actor } from './core'
import { amountInWords, formatDecimal, formatQty } from './numbers'
import { minorUnitsOf } from './setup'
import { settingsWithin } from './years'

/**
 * Documents of record, printed: a tax invoice (or credit or debit note), a
 * receipt or payment voucher, and a purchase order. A4, standard fonts -- so
 * the rupee sign is written "Rs" -- and the amount in words, the way they are
 * filed and signed.
 */

const A4 = { w: 595.28, h: 841.89 }
const M = 42
const ink = rgb(0.1, 0.1, 0.12)
const faint = rgb(0.42, 0.42, 0.48)
const rule = rgb(0.78, 0.78, 0.82)
const safe = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/₹/g, 'Rs ')
    .replace(/[^\x20-\x7E]/g, '?')

/** Money in a currency's own units, grouped the Indian way for rupees. */
export function money(minor: number, currency = 'INR', minorUnits = 2): string {
  const neg = minor < 0
  const s = formatDecimal(Math.abs(minor), minorUnits, minorUnits)
  const [whole, frac] = s.split('.') as [string, string | undefined]
  const grouped =
    currency === 'INR'
      ? whole.length > 3
        ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`
        : whole
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`
}

class Sheet {
  page: PDFPage
  y = A4.h - M
  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.page = doc.addPage([A4.w, A4.h])
  }
  text(s: string, x: number, size = 9, f: PDFFont = this.font, color = ink) {
    this.page.drawText(safe(s), { x, y: this.y, size, font: f, color })
  }
  right(s: string, xRight: number, size = 9, f: PDFFont = this.font, color = ink) {
    const t = safe(s)
    this.page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: this.y, size, font: f, color })
  }
  fit(s: string, width: number, size = 9) {
    let out = safe(s)
    if (this.font.widthOfTextAtSize(out, size) <= width) return out
    while (out.length > 1 && this.font.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1)
    return `${out.trimEnd()}...`
  }
  wrap(s: string, x: number, width: number, size = 9, f: PDFFont = this.font, color = ink) {
    let cur = ''
    for (const word of safe(s).split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word
      if (f.widthOfTextAtSize(next, size) > width && cur) {
        this.text(cur, x, size, f, color)
        this.y -= size + 3
        cur = word
      } else cur = next
    }
    if (cur) {
      this.text(cur, x, size, f, color)
      this.y -= size + 3
    }
  }
  line(x1 = M, x2 = A4.w - M) {
    this.page.drawLine({ start: { x: x1, y: this.y + 3 }, end: { x: x2, y: this.y + 3 }, thickness: 0.5, color: rule })
  }
  /** A new page when the next block would not fit. */
  need(height: number) {
    if (this.y - height < M + 40) {
      this.page = this.doc.addPage([A4.w, A4.h])
      this.y = A4.h - M
    }
  }
}

async function start(title: string) {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setProducer('CampusOS')
  doc.setCreationDate(new Date())
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  return new Sheet(doc, font, bold)
}

interface Letterhead {
  name: string
  address: string | null
  gstin: string | null
  pan: string | null
  stateCode: string | null
}

async function letterheadOf(institutionId: string, s: Awaited<ReturnType<typeof settingsWithin>>): Promise<Letterhead> {
  // institutions has no tenant policy -- it is what tenants are resolved from.
  const [inst] = await db.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, institutionId))
  return { name: s.legalName ?? inst?.name ?? 'Institution', address: s.address, gstin: s.gstin, pan: s.pan, stateCode: s.stateCode }
}

function head(sh: Sheet, l: Letterhead, title: string) {
  sh.text(l.name, M, 15, sh.bold)
  sh.right(title, A4.w - M, 13, sh.bold)
  sh.y -= 15
  if (l.address) sh.wrap(l.address, M, 300, 8, sh.font, faint)
  const ids = [l.gstin && `GSTIN ${l.gstin}`, l.pan && `PAN ${l.pan}`, l.stateCode && `State code ${l.stateCode}`].filter(Boolean).join('   ')
  if (ids) {
    sh.text(ids, M, 8, sh.font, faint)
    sh.y -= 11
  }
  sh.y -= 4
  sh.line()
  sh.y -= 14
}

function signature(sh: Sheet, l: Letterhead) {
  sh.need(70)
  sh.y -= 30
  sh.right(`For ${l.name}`, A4.w - M, 9, sh.bold)
  sh.y -= 36
  sh.right('Authorised signatory', A4.w - M, 8, sh.font, faint)
  sh.y -= 20
  sh.text('This is a computer-generated document.', M, 7, sh.font, faint)
}

// --- invoices -----------------------------------------------------------------------

export async function invoicePdf(actor: Actor, invoiceId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const tenant = requireRead(actor)
  const data = await withTenant(tenant, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId))
    if (!inv) throw new FinanceError(404, 'no_such_invoice', 'no such invoice')
    if (inv.docstatus === 'draft') throw new FinanceError(409, 'draft', 'a draft is not printed; submit it first')
    const [party] = await tx.select().from(parties).where(eq(parties.id, inv.partyId))
    const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))
    const ts = await tx.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId))
    const [orig] = inv.returnAgainst ? await tx.select().from(invoices).where(eq(invoices.id, inv.returnAgainst)) : []
    const s = await settingsWithin(tx, tenant)
    return { inv, party: party!, ls: ls.sort((a, b) => a.seq - b.seq), ts, orig, s, minor: await minorUnitsOf(tx, tenant, inv.currency) }
  })
  const { inv, party, ls, ts, orig, s, minor } = data
  const lh = await letterheadOf(tenant, s)
  const title =
    inv.kind === 'sales'
      ? inv.isReturn
        ? 'CREDIT NOTE'
        : ts.length
          ? 'TAX INVOICE'
          : 'INVOICE'
      : inv.isReturn
        ? 'DEBIT NOTE'
        : 'PURCHASE BILL'
  const sh = await start(`${title} ${inv.number}`)
  const m = (v: number) => money(v, inv.currency, minor)
  head(sh, lh, title)

  // Who and when.
  const top = sh.y
  sh.text(inv.kind === 'sales' ? 'Bill to' : 'Supplier', M, 8, sh.bold, faint)
  sh.y -= 12
  sh.text(party.name, M, 10, sh.bold)
  sh.y -= 12
  if (party.address) sh.wrap(party.address, M, 260, 8)
  if (party.gstin) {
    sh.text(`GSTIN ${party.gstin}`, M, 8)
    sh.y -= 11
  }
  if (party.stateCode) {
    sh.text(`State code ${party.stateCode}`, M, 8)
    sh.y -= 11
  }
  const left = sh.y
  sh.y = top
  const facts: [string, string][] = [
    ['Number', inv.number ?? ''],
    ['Date', inv.postingDate],
    ...(inv.dueDate ? [['Due', inv.dueDate] as [string, string]] : []),
    ...(inv.billNo ? [['Supplier bill', `${inv.billNo}${inv.billDate ? ` of ${inv.billDate}` : ''}`] as [string, string]] : []),
    ...(orig ? [['Against', `${orig.number} of ${orig.postingDate}`] as [string, string]] : []),
    ...(inv.placeOfSupply ? [['Place of supply', inv.placeOfSupply] as [string, string]] : []),
    ['Reverse charge', inv.reverseCharge ? 'Yes' : 'No'],
    ...(inv.currency !== s.baseCurrency ? [['Currency', `${inv.currency} at ${inv.exchangeRate}`] as [string, string]] : []),
  ]
  for (const [k, v] of facts) {
    sh.text(k, 330, 8, sh.font, faint)
    sh.right(v, A4.w - M, 9)
    sh.y -= 12
  }
  sh.y = Math.min(left, sh.y) - 10

  // The lines.
  const cols = { n: M, desc: M + 18, hsn: 290, qty: 360, rate: 425, disc: 470, amt: A4.w - M }
  sh.text('#', cols.n, 7, sh.bold, faint)
  sh.text('Description', cols.desc, 7, sh.bold, faint)
  sh.text('HSN/SAC', cols.hsn, 7, sh.bold, faint)
  sh.right('Qty', cols.qty + 30, 7, sh.bold, faint)
  sh.right('Rate', cols.rate + 30, 7, sh.bold, faint)
  sh.right('Disc %', cols.disc + 30, 7, sh.bold, faint)
  sh.right('Taxable value', cols.amt, 7, sh.bold, faint)
  sh.y -= 5
  sh.line()
  sh.y -= 11
  for (const [i, l] of ls.entries()) {
    sh.need(14)
    sh.text(String(i + 1), cols.n, 8)
    sh.text(sh.fit(l.description, cols.hsn - cols.desc - 8, 8), cols.desc, 8)
    sh.text(l.hsnSac ?? '', cols.hsn, 8)
    sh.right(`${formatQty(l.qtyMilli)}${l.uom ? ` ${l.uom}` : ''}`, cols.qty + 30, 8)
    sh.right(m(l.rateFc), cols.rate + 30, 8)
    sh.right(l.discountBp ? formatDecimal(l.discountBp, 2) : '', cols.disc + 30, 8)
    sh.right(m(l.amountFc), cols.amt, 8)
    sh.y -= 13
  }
  sh.line()
  sh.y -= 12

  // Totals and the tax, component by component.
  const label = (k: string, v: string, bold = false) => {
    sh.need(13)
    sh.text(k, 330, 9, bold ? sh.bold : sh.font)
    sh.right(v, A4.w - M, 9, bold ? sh.bold : sh.font)
    sh.y -= 13
  }
  label('Taxable value', m(inv.netFc))
  const byComponent = new Map<string, number>()
  for (const t of ts) {
    const k = `${t.component.toUpperCase()} @ ${formatDecimal(t.rateBp, 2)}%`
    byComponent.set(k, (byComponent.get(k) ?? 0) + t.taxFc)
  }
  for (const [k, v] of byComponent) label(inv.reverseCharge ? `${k} (payable by recipient)` : k, m(v))
  if (inv.roundingFc) label('Rounding', m(inv.roundingFc))
  label('Total', `${inv.currency === 'INR' ? 'Rs ' : `${inv.currency} `}${m(inv.totalFc)}`, true)
  if (inv.tdsPaise) label('Less tax deducted at source', m(inv.tdsPaise))
  sh.y -= 4
  sh.wrap(`In words: ${amountInWords(inv.totalFc, inv.currency, minor)}`, M, A4.w - 2 * M, 9, sh.bold)
  if (inv.terms) {
    sh.y -= 6
    sh.text('Terms', M, 8, sh.bold, faint)
    sh.y -= 11
    sh.wrap(inv.terms, M, A4.w - 2 * M, 8)
  }
  if (inv.docstatus === 'cancelled') {
    sh.page.drawText('CANCELLED', { x: 150, y: 400, size: 64, font: sh.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.25 })
  }
  signature(sh, lh)
  return { bytes: await sh.doc.save(), fileName: `${(inv.number ?? 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf` }
}

// --- payment and receipt vouchers ------------------------------------------------------

export async function paymentPdf(actor: Actor, paymentId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const tenant = requireRead(actor)
  const data = await withTenant(tenant, async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId))
    if (!p) throw new FinanceError(404, 'no_such_payment', 'no such payment')
    if (p.docstatus === 'draft') throw new FinanceError(409, 'draft', 'a draft is not printed; submit it first')
    const [party] = p.partyId ? await tx.select().from(parties).where(eq(parties.id, p.partyId)) : []
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, p.accountId))
    const [to] = p.toAccountId ? await tx.select().from(accounts).where(eq(accounts.id, p.toAccountId)) : []
    const allocs = await tx
      .select({ number: invoices.number, postingDate: invoices.postingDate, amountFc: paymentAllocations.amountFc })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .where(eq(paymentAllocations.paymentId, paymentId))
    const s = await settingsWithin(tx, tenant)
    return { p, party, acct: acct!, to, allocs, s, minor: await minorUnitsOf(tx, tenant, p.currency) }
  })
  const { p, party, acct, to, allocs, s, minor } = data
  const lh = await letterheadOf(tenant, s)
  const title = p.kind === 'receive' ? 'RECEIPT' : p.kind === 'pay' ? 'PAYMENT VOUCHER' : 'CONTRA VOUCHER'
  const sh = await start(`${title} ${p.number}`)
  const m = (v: number) => money(v, p.currency, minor)
  head(sh, lh, title)
  const facts: [string, string][] = [
    ['Number', p.number ?? ''],
    ['Date', p.postingDate],
    [p.kind === 'receive' ? 'Received from' : p.kind === 'pay' ? 'Paid to' : 'From', party?.name ?? acct.name],
    ...(to ? [['To', to.name] as [string, string]] : []),
    [p.kind === 'receive' ? 'Into' : 'From account', `${acct.code} ${acct.name}`],
    ['Mode', p.mode.toUpperCase()],
    ...(p.instrumentNo ? [['Instrument', `${p.instrumentNo}${p.instrumentDate ? ` dated ${p.instrumentDate}` : ''}`] as [string, string]] : []),
    ...(p.reference ? [['Reference', p.reference] as [string, string]] : []),
  ]
  for (const [k, v] of facts) {
    sh.text(k, M, 9, sh.font, faint)
    sh.text(sh.fit(v, 380), M + 120, 10)
    sh.y -= 15
  }
  sh.y -= 6
  sh.line()
  sh.y -= 14
  sh.text('Amount', M, 10, sh.bold)
  sh.right(`${p.currency === 'INR' ? 'Rs ' : `${p.currency} `}${m(p.amountFc)}`, A4.w - M, 12, sh.bold)
  sh.y -= 16
  if (p.tdsPaise) {
    sh.text('Tax deducted at source', M, 9)
    sh.right(money(p.tdsPaise), A4.w - M, 9)
    sh.y -= 13
  }
  if (p.bankChargesPaise) {
    sh.text('Bank charges', M, 9)
    sh.right(money(p.bankChargesPaise), A4.w - M, 9)
    sh.y -= 13
  }
  sh.wrap(`In words: ${amountInWords(p.amountFc, p.currency, minor)}`, M, A4.w - 2 * M, 9, sh.bold)
  if (allocs.length) {
    sh.y -= 8
    sh.text('Against', M, 8, sh.bold, faint)
    sh.y -= 12
    for (const a of allocs) {
      sh.need(13)
      sh.text(`${a.number} of ${a.postingDate}`, M, 9)
      sh.right(m(a.amountFc), A4.w - M, 9)
      sh.y -= 13
    }
  }
  if (p.memo) {
    sh.y -= 6
    sh.wrap(p.memo, M, A4.w - 2 * M, 9, sh.font, faint)
  }
  if (p.docstatus === 'cancelled') {
    sh.page.drawText('CANCELLED', { x: 150, y: 400, size: 64, font: sh.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.25 })
  }
  signature(sh, lh)
  return { bytes: await sh.doc.save(), fileName: `${(p.number ?? 'voucher').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf` }
}

// --- purchase orders ------------------------------------------------------------------

export async function orderPdf(actor: Actor, orderId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const tenant = requireRead(actor)
  const data = await withTenant(tenant, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId))
    if (!o) throw new FinanceError(404, 'no_such_order', 'no such order')
    if (o.docstatus === 'draft') throw new FinanceError(409, 'draft', 'a draft is not printed; submit it first')
    const [party] = await tx.select().from(parties).where(eq(parties.id, o.partyId))
    const ls = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId))
    const s = await settingsWithin(tx, tenant)
    return { o, party: party!, ls: ls.sort((a, b) => a.seq - b.seq), s, minor: await minorUnitsOf(tx, tenant, o.currency) }
  })
  const { o, party, ls, s, minor } = data
  const lh = await letterheadOf(tenant, s)
  const title = o.kind === 'purchase_order' ? 'PURCHASE ORDER' : o.kind === 'sales_order' ? 'SALES ORDER' : 'QUOTATION'
  const sh = await start(`${title} ${o.number}`)
  const m = (v: number) => money(v, o.currency, minor)
  head(sh, lh, title)
  sh.text(o.kind === 'purchase_order' ? 'To' : 'For', M, 8, sh.bold, faint)
  sh.right(`No. ${o.number}   Date ${o.postingDate}`, A4.w - M, 9, sh.bold)
  sh.y -= 12
  sh.text(party.name, M, 10, sh.bold)
  sh.y -= 12
  if (party.address) sh.wrap(party.address, M, 300, 8)
  if (party.gstin) {
    sh.text(`GSTIN ${party.gstin}`, M, 8)
    sh.y -= 11
  }
  if (o.deliverBy) {
    sh.text(`Deliver by ${o.deliverBy}`, M, 9, sh.bold)
    sh.y -= 12
  }
  if (o.validTill) {
    sh.text(`Valid till ${o.validTill}`, M, 9, sh.bold)
    sh.y -= 12
  }
  sh.y -= 8
  sh.text('#', M, 7, sh.bold, faint)
  sh.text('Item', M + 18, 7, sh.bold, faint)
  sh.right('Qty', 390, 7, sh.bold, faint)
  sh.right('Rate', 455, 7, sh.bold, faint)
  sh.right('Amount', A4.w - M, 7, sh.bold, faint)
  sh.y -= 5
  sh.line()
  sh.y -= 11
  for (const [i, l] of ls.entries()) {
    sh.need(14)
    sh.text(String(i + 1), M, 8)
    sh.text(sh.fit(l.description, 300, 8), M + 18, 8)
    sh.right(formatQty(l.qtyMilli), 390, 8)
    sh.right(m(l.rateFc), 455, 8)
    sh.right(m(l.amountFc), A4.w - M, 8)
    sh.y -= 13
  }
  sh.line()
  sh.y -= 12
  for (const [k, v, b] of [
    ['Value', m(o.netFc), false],
    ['Tax', m(o.taxFc), false],
    ['Total', `${o.currency === 'INR' ? 'Rs ' : `${o.currency} `}${m(o.totalFc)}`, true],
  ] as [string, string, boolean][]) {
    sh.text(k, 330, 9, b ? sh.bold : sh.font)
    sh.right(v, A4.w - M, 9, b ? sh.bold : sh.font)
    sh.y -= 13
  }
  sh.wrap(`In words: ${amountInWords(o.totalFc, o.currency, minor)}`, M, A4.w - 2 * M, 9, sh.bold)
  if (o.terms) {
    sh.y -= 6
    sh.text('Terms', M, 8, sh.bold, faint)
    sh.y -= 11
    sh.wrap(o.terms, M, A4.w - 2 * M, 8)
  }
  signature(sh, lh)
  return { bytes: await sh.doc.save(), fileName: `${(o.number ?? 'order').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf` }
}
