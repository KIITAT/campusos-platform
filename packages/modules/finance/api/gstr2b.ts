import { between, eq, inArray, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { readUpload } from '@campusos/module-framework'
import * as z from 'zod'
import { gstr2bLines, gstr2bReturns } from '../schema'
import { FinanceError, named, requireRead, type Actor } from './core'
import { purchaseTaxByInvoice } from './gst'
import { fiscalYearOf, settingsWithin } from './years'

/**
 * GSTR-2B against the purchase bills (P1-05a, ACC-03).
 *
 * The portal's GSTR-2B JSON is reference data it regenerates, so importing a
 * month again replaces it. Only B2B invoices and credit or debit notes are
 * kept; every other section is counted and shown. CampusOS files nothing: the
 * matching is a list for the accountant to chase before claiming credit.
 */

const MODULE = 'finance'
const MAX_BYTES = 8 * 1024 * 1024
/** Two figures this close (one rupee), component by component, are the same figure. */
export const MATCH_TOLERANCE_PAISE = 100
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/

/**
 * How a document number is compared: suppliers print `INV/001`, ledgers hold `inv-1`,
 * so punctuation and case are ignored and the zeros that pad a run of digits are dropped.
 * (Plan D13 said leading zeros only, which cannot turn INV001 into INV1; see plan §12.)
 */
export function docKey(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .replace(/^0+/, '')
    .replace(/([A-Z])0+(?=[0-9])/g, '$1')
}

export const import2bSchema = z.object({ file: z.unknown() }).meta({ id: 'FinanceGstr2bImport' })

const bad = () => new FinanceError(400, 'bad_2b_file', 'that is not a GSTR-2B JSON file')
const paiseOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0)
const isoOf = (v: unknown): string => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(v ?? ''))
  if (!m) throw bad()
  return `${m[3]}-${m[2]}-${m[1]}`
}
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : [])

type Amounts = { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }
const NONE: Amounts = { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 }

function sumItems(items: unknown): Amounts {
  const out = { ...NONE }
  for (const it of list(items)) {
    out.taxablePaise += paiseOf(it.txval)
    out.igstPaise += paiseOf(it.igst)
    out.cgstPaise += paiseOf(it.cgst)
    out.sgstPaise += paiseOf(it.sgst)
    out.cessPaise += paiseOf(it.cess)
  }
  return out
}

type NewLine = Omit<typeof gstr2bLines.$inferInsert, 'institutionId' | 'returnId'>

function parse2b(bytes: Uint8Array): { gstin: string; period: string; lines: NewLine[]; skipped: Record<string, number> } {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw bad()
  }
  const data = rec(rec(json).data)
  const docdata = rec(data.docdata)
  const gstin = typeof data.gstin === 'string' ? data.gstin : ''
  const prd = /^(0[1-9]|1[0-2])(\d{4})$/.exec(String(data.rtnprd ?? ''))
  if (!gstin || !prd || Object.keys(docdata).length === 0) throw bad()

  const lines: NewLine[] = []
  const supplier = (s: Record<string, unknown>) => {
    const raw = String(s.ctin ?? '')
    return { supplierGstin: GSTIN.test(raw) ? raw : null, supplierGstinRaw: raw, supplierName: typeof s.trdnm === 'string' ? s.trdnm : null }
  }
  const common = (d: Record<string, unknown>) => ({
    docDate: isoOf(d.dt),
    valuePaise: paiseOf(d.val),
    itcAvailable: d.itcavl === 'Y',
    reverseCharge: d.rev === 'Y',
  })
  for (const s of list(docdata.b2b)) {
    for (const d of list(s.inv)) {
      const number = String(d.inum ?? '')
      lines.push({ ...supplier(s), docType: 'invoice', docNumber: number, docKey: docKey(number), ...common(d), ...sumItems(d.items) })
    }
  }
  for (const s of list(docdata.cdnr)) {
    for (const d of list(s.nt)) {
      const number = String(d.ntnum ?? '')
      lines.push({ ...supplier(s), docType: d.typ === 'D' ? 'debit' : 'credit', docNumber: number, docKey: docKey(number), ...common(d), ...sumItems(d.items) })
    }
  }
  const skipped: Record<string, number> = {}
  for (const [key, value] of Object.entries(docdata)) {
    if (key === 'b2b' || key === 'cdnr') continue
    const count = Array.isArray(value) ? value.length : 0
    if (count > 0) skipped[key] = count
  }
  return { gstin, period: `${prd[2]}-${prd[1]}`, lines, skipped }
}

/** Import (or replace) one month's GSTR-2B. */
export async function import2b(actor: Actor, input: unknown) {
  const tenant = requireRead(actor)
  const data = import2bSchema.parse(input)
  const file = readUpload(data.file, { what: 'the GSTR-2B file', maxBytes: MAX_BYTES })
  const parsed = parse2b(file.bytes)

  return withTenant(tenant, (tx) =>
    named(async () => {
      const s = await settingsWithin(tx, tenant)
      if (s.gstin !== parsed.gstin) {
        throw new FinanceError(409, 'wrong_gstin', `that 2B is for GSTIN ${parsed.gstin}, not this institution's`)
      }
      const old = await tx.delete(gstr2bReturns).where(eq(gstr2bReturns.period, parsed.period)).returning({ id: gstr2bReturns.id })
      const [ret] = await tx
        .insert(gstr2bReturns)
        .values({
          institutionId: tenant,
          period: parsed.period,
          gstin: parsed.gstin,
          fileName: file.name,
          documents: parsed.lines.length,
          skipped: parsed.skipped,
        })
        .returning()
      for (let i = 0; i < parsed.lines.length; i += 500) {
        await tx.insert(gstr2bLines).values(parsed.lines.slice(i, i + 500).map((l) => ({ ...l, institutionId: tenant, returnId: ret!.id })))
      }
      const replaced = old.length > 0
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'gst.2b_imported',
        entity: 'finance_gstr2b_returns',
        entityId: ret!.id,
        reason: `GSTR-2B for ${parsed.period} imported`,
        detail: { period: parsed.period, documents: parsed.lines.length, skipped: parsed.skipped, replaced },
      })
      return { ...ret!, replaced, notice: `Imported ${parsed.lines.length} documents for ${parsed.period}.` }
    }),
  )
}

export async function list2bReturns(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        period: gstr2bReturns.period,
        gstin: gstr2bReturns.gstin,
        fileName: gstr2bReturns.fileName,
        documents: gstr2bReturns.documents,
        skipped: gstr2bReturns.skipped,
        importedAt: gstr2bReturns.importedAt,
      })
      .from(gstr2bReturns)
      .orderBy(sql`${gstr2bReturns.period} desc`),
  )
}

export const match2bSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })

type Status = 'differs' | 'not_in_books' | 'not_in_2b' | 'matched'
const ORDER: Status[] = ['differs', 'not_in_books', 'not_in_2b', 'matched']

export interface MatchRow {
  status: Status
  supplierGstin: string | null
  supplier: string | null
  docType: 'invoice' | 'credit' | 'debit'
  docNumber: string
  docDate: string
  invoiceId: string | null
  invoiceNumber: string | null
  bookedOn: string | null
  books: Amounts | null
  gstr2b: Amounts | null
  itcAvailable: boolean | null
  reverseCharge: boolean | null
}

const close = (a: Amounts, b: Amounts) =>
  (Object.keys(NONE) as (keyof Amounts)[]).every((k) => Math.abs(a[k] - b[k]) <= MATCH_TOLERANCE_PAISE)

/**
 * The month's 2B against the purchase bills. A bill booked earlier in the same
 * fiscal year still matches a later month's 2B, so the books side spans the year.
 */
export async function match2b(actor: Actor, input: unknown) {
  const tenant = requireRead(actor)
  const { period } = match2bSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [ret] = await tx.select().from(gstr2bReturns).where(eq(gstr2bReturns.period, period))
    if (!ret) throw new FinanceError(404, 'no_2b', 'no 2B imported for that month')
    const year = await fiscalYearOf(tx, tenant, `${period}-01`)
    const first = year.startsOn.slice(0, 7)
    const last = year.endsOn.slice(0, 7)
    const yearReturns = await tx.select({ id: gstr2bReturns.id }).from(gstr2bReturns).where(between(gstr2bReturns.period, first, last))
    const yearLines = await tx
      .select()
      .from(gstr2bLines)
      .where(inArray(gstr2bLines.returnId, yearReturns.map((r) => r.id)))
    const lines = yearLines.filter((l) => l.returnId === ret.id)

    // The books: purchase bills of registered suppliers, one entry per bill.
    const bills = await purchaseTaxByInvoice(tx, year.startsOn, year.endsOn)
    const keyOf = (gstin: string | null, type: string, number: string) => `${gstin}|${type}|${docKey(number)}`
    const byKey = new Map<string, typeof bills>()
    for (const bl of bills) {
      if (!bl.gstin || !docKey(bl.billNo ?? '')) continue
      const k = keyOf(bl.gstin, bl.isReturn ? 'credit' : 'invoice', bl.billNo!)
      byKey.set(k, [...(byKey.get(k) ?? []), bl])
    }
    for (const group of byKey.values()) group.sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.number.localeCompare(b.number))

    const rows: MatchRow[] = []
    const matchedBills = new Set<string>()
    for (const l of lines) {
      const amounts: Amounts = { taxablePaise: l.taxablePaise, igstPaise: l.igstPaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, cessPaise: l.cessPaise }
      const candidate = l.supplierGstin && l.docType !== 'debit' && l.docKey ? byKey.get(keyOf(l.supplierGstin, l.docType, l.docNumber))?.find((x) => !matchedBills.has(x.invoiceId)) : undefined
      if (candidate) matchedBills.add(candidate.invoiceId)
      rows.push({
        status: candidate ? (close(candidate.amounts, amounts) ? 'matched' : 'differs') : 'not_in_books',
        supplierGstin: l.supplierGstin ?? l.supplierGstinRaw,
        supplier: candidate?.party ?? l.supplierName,
        docType: l.docType,
        docNumber: l.docNumber,
        docDate: l.docDate,
        invoiceId: candidate?.invoiceId ?? null,
        invoiceNumber: candidate?.number ?? null,
        bookedOn: candidate?.postingDate ?? null,
        books: candidate?.amounts ?? null,
        gstr2b: amounts,
        itcAvailable: l.itcAvailable,
        reverseCharge: l.reverseCharge,
      })
    }

    // Bills booked in the month that no 2B of the year accounts for (or a repeat of a number already matched).
    const inYear = new Set(yearLines.filter((l) => l.supplierGstin && l.docType !== 'debit').map((l) => keyOf(l.supplierGstin, l.docType, l.docNumber)))
    for (const bl of bills) {
      if (!bl.gstin || matchedBills.has(bl.invoiceId) || !bl.postingDate.startsWith(period)) continue
      const k = keyOf(bl.gstin, bl.isReturn ? 'credit' : 'invoice', bl.billNo ?? '')
      const repeat = (byKey.get(k)?.[0]?.invoiceId ?? bl.invoiceId) !== bl.invoiceId
      if (inYear.has(k) && !repeat) continue
      rows.push({
        status: 'not_in_2b',
        supplierGstin: bl.gstin,
        supplier: bl.party,
        docType: bl.isReturn ? 'credit' : 'invoice',
        docNumber: bl.billNo ?? '',
        docDate: bl.billDate ?? bl.postingDate,
        invoiceId: bl.invoiceId,
        invoiceNumber: bl.number,
        bookedOn: bl.postingDate,
        books: bl.amounts,
        gstr2b: null,
        itcAvailable: null,
        reverseCharge: null,
      })
    }

    rows.sort(
      (a, b) =>
        ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
        (a.supplierGstin ?? '').localeCompare(b.supplierGstin ?? '') ||
        a.docNumber.localeCompare(b.docNumber),
    )
    const count = (s: Status) => rows.filter((r) => r.status === s).length
    return { period, rows, summary: { matched: count('matched'), differs: count('differs'), notInBooks: count('not_in_books'), notIn2b: count('not_in_2b') } }
  })
}
