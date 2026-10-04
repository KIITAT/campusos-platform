import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { requireRead, type Actor, type Tx } from './core'
import { settingsWithin } from './years'

/**
 * The tax returns' figures, read from the invoices: what GSTR-1 reports of
 * outward supplies, what GSTR-3B summarises, the HSN summary, and the tax
 * deducted at source by section and payee.
 *
 * CampusOS files nothing. These are the tables the GST portal's offline tool
 * and a tax practitioner work from, in the portal's own groupings, to be
 * checked and filed by the institution. The rules they follow are those of
 * the returns as they stood when this was written (see INDIA_PRESET_AS_OF);
 * the institution is responsible for checking them against the current ones.
 */

/** Large unregistered inter-state invoices are reported one by one (B2CL) above this value. */
export const B2CL_THRESHOLD_PAISE = 10_000_000

interface InvoiceTaxRow {
  invoice_id: string
  number: string
  posting_date: string
  kind: 'sales' | 'purchase'
  is_return: boolean
  return_number: string | null
  return_date: string | null
  party: string
  gstin: string | null
  gst_category: string
  state_code: string | null
  place_of_supply: string | null
  reverse_charge: boolean
  total_paise: number
  treatment: string | null
  rate_bp: number
  taxable_paise: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  ineligible: number
}

/**
 * Each submitted invoice, split by tax rate: its taxable value and the tax of
 * each component at that rate, in the base currency. Lines with no tax
 * template, or an exempt, nil-rated or non-GST one, appear at rate 0 with
 * their treatment.
 */
async function taxRows(tx: Tx, kind: 'sales' | 'purchase', from: string, to: string): Promise<InvoiceTaxRow[]> {
  const res = await tx.execute(sql`
    with lines as (
      select l.invoice_id, l.tax_template_id, sum(l.amount_paise) as taxable
        from finance_invoice_lines l
        join finance_invoices i on i.id = l.invoice_id
       where i.kind = ${kind} and i.docstatus = 'submitted' and i.posting_date between ${from}::date and ${to}::date
       group by l.invoice_id, l.tax_template_id
    ),
    taxes as (
      select x.invoice_id, x.template_id,
             sum(x.rate_bp) as rate_bp,
             sum(x.tax_paise) filter (where x.component = 'igst') as igst,
             sum(x.tax_paise) filter (where x.component = 'cgst') as cgst,
             sum(x.tax_paise) filter (where x.component in ('sgst', 'utgst')) as sgst,
             sum(x.tax_paise) filter (where x.component = 'cess') as cess,
             sum(x.ineligible_paise) as ineligible
        from finance_invoice_taxes x
       group by x.invoice_id, x.template_id
    )
    select i.id as invoice_id, i.number, i.posting_date::text as posting_date, i.kind, i.is_return,
           o.number as return_number, o.posting_date::text as return_date,
           p.name as party, p.gstin, p.gst_category, p.state_code, i.place_of_supply, i.reverse_charge, i.total_paise,
           t.treatment,
           coalesce(x.rate_bp - coalesce((select c.rate_bp from finance_tax_components c where c.template_id = l.tax_template_id and c.component = 'cess' limit 1), 0), 0)::int as rate_bp,
           l.taxable::bigint as taxable_paise,
           coalesce(x.igst, 0)::bigint as igst, coalesce(x.cgst, 0)::bigint as cgst, coalesce(x.sgst, 0)::bigint as sgst,
           coalesce(x.cess, 0)::bigint as cess, coalesce(x.ineligible, 0)::bigint as ineligible
      from lines l
      join finance_invoices i on i.id = l.invoice_id
      join finance_parties p on p.id = i.party_id
      left join finance_invoices o on o.id = i.return_against
      left join finance_tax_templates t on t.id = l.tax_template_id
      left join taxes x on x.invoice_id = l.invoice_id and x.template_id = l.tax_template_id
     order by i.posting_date, i.number`)
  return (res.rows as unknown as InvoiceTaxRow[]).map((r) => ({
    ...r,
    total_paise: Number(r.total_paise),
    taxable_paise: Number(r.taxable_paise),
    igst: Number(r.igst),
    cgst: Number(r.cgst),
    sgst: Number(r.sgst),
    cess: Number(r.cess),
    ineligible: Number(r.ineligible),
  }))
}

const sign = (r: InvoiceTaxRow) => (r.is_return ? -1 : 1)
const ratePct = (bp: number) => bp / 100

interface Bucket {
  taxablePaise: number
  igstPaise: number
  cgstPaise: number
  sgstPaise: number
  cessPaise: number
}
const empty = (): Bucket => ({ taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 })
const add = (b: Bucket, r: InvoiceTaxRow, s = sign(r)) => {
  b.taxablePaise += s * r.taxable_paise
  b.igstPaise += s * r.igst
  b.cgstPaise += s * r.cgst
  b.sgstPaise += s * r.sgst
  b.cessPaise += s * r.cess
  return b
}

const exemptish = (r: InvoiceTaxRow) => r.treatment === 'exempt' || r.treatment === 'nil_rated' || r.treatment === 'non_gst'

/** GSTR-1: outward supplies for a period, in the return's tables. */
export async function gstr1(actor: Actor, input: { from: string; to: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const settings = await settingsWithin(tx, tenant)
    const rows = await taxRows(tx, 'sales', input.from, input.to)
    const registered = (r: InvoiceTaxRow) => !!r.gstin && r.gst_category !== 'overseas'
    const interState = (r: InvoiceTaxRow) => r.igst !== 0 || (r.place_of_supply !== null && r.place_of_supply !== settings.stateCode)

    const b2b = rows.filter((r) => !r.is_return && registered(r) && !exemptish(r) && r.gst_category !== 'sez')
    const sez = rows.filter((r) => !r.is_return && r.gst_category === 'sez' && !exemptish(r))
    const exports = rows.filter((r) => !r.is_return && r.gst_category === 'overseas' && !exemptish(r))
    const unreg = rows.filter((r) => !r.is_return && !registered(r) && r.gst_category !== 'overseas' && r.gst_category !== 'sez' && !exemptish(r))
    const b2cl = unreg.filter((r) => interState(r) && r.total_paise > B2CL_THRESHOLD_PAISE)
    const b2cs = unreg.filter((r) => !b2cl.includes(r))
    const cdnr = rows.filter((r) => r.is_return && registered(r) && !exemptish(r))
    const cdnur = rows.filter((r) => r.is_return && !registered(r) && !exemptish(r))

    // B2CS is reported in aggregate: by place of supply and rate.
    const b2csAgg = new Map<string, Bucket & { placeOfSupply: string; ratePercent: number }>()
    for (const r of b2cs) {
      const k = `${r.place_of_supply ?? settings.stateCode}|${r.rate_bp}`
      const b = b2csAgg.get(k) ?? { ...empty(), placeOfSupply: r.place_of_supply ?? settings.stateCode ?? '', ratePercent: ratePct(r.rate_bp) }
      b2csAgg.set(k, add(b, r) as typeof b)
    }
    // Credit notes to unregistered buyers that are small and inside the state reduce B2CS too.
    for (const r of cdnur.filter((x) => !interState(x))) {
      const k = `${r.place_of_supply ?? settings.stateCode}|${r.rate_bp}`
      const b = b2csAgg.get(k) ?? { ...empty(), placeOfSupply: r.place_of_supply ?? settings.stateCode ?? '', ratePercent: ratePct(r.rate_bp) }
      b2csAgg.set(k, add(b, r) as typeof b)
    }

    const nil = { nilRatedPaise: 0, exemptPaise: 0, nonGstPaise: 0 }
    for (const r of rows.filter(exemptish)) {
      const v = sign(r) * r.taxable_paise
      if (r.treatment === 'nil_rated') nil.nilRatedPaise += v
      else if (r.treatment === 'exempt') nil.exemptPaise += v
      else nil.nonGstPaise += v
    }

    const line = (r: InvoiceTaxRow) => ({
      invoiceId: r.invoice_id,
      number: r.number,
      date: r.posting_date,
      party: r.party,
      gstin: r.gstin,
      placeOfSupply: r.place_of_supply,
      reverseCharge: r.reverse_charge,
      invoiceValuePaise: r.total_paise,
      ratePercent: ratePct(r.rate_bp),
      taxablePaise: r.taxable_paise,
      igstPaise: r.igst,
      cgstPaise: r.cgst,
      sgstPaise: r.sgst,
      cessPaise: r.cess,
      originalNumber: r.return_number,
      originalDate: r.return_date,
    })

    const docs = await tx.execute(sql`
      select case when is_return then 'Credit note' else 'Invoice for outward supply' end as nature,
             min(number) as first, max(number) as last, count(*)::int as total,
             count(*) filter (where docstatus = 'cancelled')::int as cancelled
        from finance_invoices
       where kind = 'sales' and docstatus <> 'draft' and posting_date between ${input.from}::date and ${input.to}::date
       group by is_return`)

    return {
      from: input.from,
      to: input.to,
      gstin: settings.gstin,
      b2b: b2b.map(line),
      sez: sez.map(line),
      b2cl: b2cl.map(line),
      b2cs: [...b2csAgg.values()],
      exports: exports.map(line),
      cdnr: cdnr.map(line),
      cdnur: cdnur.filter((r) => interState(r)).map(line),
      nil,
      hsn: await hsnSummary(tx, 'sales', input.from, input.to),
      documents: docs.rows as { nature: string; first: string; last: string; total: number; cancelled: number }[],
    }
  })
}

/** GSTR-3B: the month's summary -- tax on what went out, tax owed under reverse charge, and input tax claimed. */
export async function gstr3b(actor: Actor, input: { from: string; to: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const sales = await taxRows(tx, 'sales', input.from, input.to)
    const purchases = await taxRows(tx, 'purchase', input.from, input.to)

    const outward = empty()
    const zeroRated = empty()
    const nilExempt = empty()
    const nonGst = empty()
    for (const r of sales) {
      if (r.treatment === 'non_gst') add(nonGst, r)
      else if (exemptish(r)) add(nilExempt, r)
      else if (r.gst_category === 'overseas' || r.gst_category === 'sez') add(zeroRated, r)
      else add(outward, r)
    }
    const inwardRcm = empty()
    const itcRcm = empty()
    const itcOther = empty()
    const itcIneligible = empty()
    const inwardExempt = { interStatePaise: 0, intraStatePaise: 0 }
    for (const r of purchases) {
      const s = sign(r)
      if (exemptish(r)) {
        if (r.igst !== 0 || (r.state_code && r.place_of_supply && r.state_code !== r.place_of_supply)) inwardExempt.interStatePaise += s * r.taxable_paise
        else inwardExempt.intraStatePaise += s * r.taxable_paise
        continue
      }
      if (r.reverse_charge) add(inwardRcm, r)
      // The part of the tax that may be claimed, component by component.
      const claimShare = r.igst + r.cgst + r.sgst + r.cess === 0 ? 0 : 1 - r.ineligible / (r.igst + r.cgst + r.sgst + r.cess)
      const claimable = {
        ...r,
        igst: Math.round(r.igst * claimShare),
        cgst: Math.round(r.cgst * claimShare),
        sgst: Math.round(r.sgst * claimShare),
        cess: Math.round(r.cess * claimShare),
      }
      add(r.reverse_charge ? itcRcm : itcOther, claimable)
      if (r.ineligible) {
        add(itcIneligible, {
          ...r,
          taxable_paise: 0,
          igst: r.igst - claimable.igst,
          cgst: r.cgst - claimable.cgst,
          sgst: r.sgst - claimable.sgst,
          cess: r.cess - claimable.cess,
        })
      }
    }
    const net = {
      igstPaise: itcRcm.igstPaise + itcOther.igstPaise,
      cgstPaise: itcRcm.cgstPaise + itcOther.cgstPaise,
      sgstPaise: itcRcm.sgstPaise + itcOther.sgstPaise,
      cessPaise: itcRcm.cessPaise + itcOther.cessPaise,
    }
    const payable = {
      igstPaise: outward.igstPaise + zeroRated.igstPaise + inwardRcm.igstPaise - net.igstPaise,
      cgstPaise: outward.cgstPaise + inwardRcm.cgstPaise - net.cgstPaise,
      sgstPaise: outward.sgstPaise + inwardRcm.sgstPaise - net.sgstPaise,
      cessPaise: outward.cessPaise + inwardRcm.cessPaise - net.cessPaise,
    }
    return {
      from: input.from,
      to: input.to,
      '3.1': { outward, zeroRated, inwardRcm, nilExempt, nonGst },
      '4': { itcRcm, itcOther, itcIneligible, net },
      '5': inwardExempt,
      payable,
    }
  })
}

/** HSN or SAC summary: quantity, value and tax by code and rate. */
export async function hsnSummary(tx: Tx, kind: 'sales' | 'purchase', from: string, to: string) {
  const res = await tx.execute(sql`
    with per_line as (
      select l.hsn_sac, l.uom, l.qty_milli, l.amount_paise, l.invoice_id, l.tax_template_id,
             case when i.is_return then -1 else 1 end as s
        from finance_invoice_lines l join finance_invoices i on i.id = l.invoice_id
       where i.kind = ${kind} and i.docstatus = 'submitted' and i.posting_date between ${from}::date and ${to}::date
    ),
    template_totals as (
      select invoice_id, tax_template_id, sum(amount_paise) as total from per_line group by 1, 2
    ),
    line_tax as (
      -- Each line's share of its invoice's tax at its template, by its amount.
      select p.hsn_sac, p.s, x.component, x.tax_paise::numeric * p.amount_paise / nullif(t.total, 0) as tax
        from per_line p
        join template_totals t on t.invoice_id = p.invoice_id and t.tax_template_id = p.tax_template_id
        join finance_invoice_taxes x on x.invoice_id = p.invoice_id and x.template_id = p.tax_template_id
    ),
    base as (
      select coalesce(hsn_sac, '(none)') as hsn, min(coalesce(uom, '')) as uom,
             sum(s * qty_milli) as qty, sum(s * amount_paise) as taxable
        from per_line group by 1
    ),
    taxes as (
      select coalesce(hsn_sac, '(none)') as hsn,
             sum(s * tax) filter (where component = 'igst') as igst,
             sum(s * tax) filter (where component = 'cgst') as cgst,
             sum(s * tax) filter (where component in ('sgst', 'utgst')) as sgst,
             sum(s * tax) filter (where component = 'cess') as cess
        from line_tax group by 1
    )
    select b.hsn, b.uom, b.qty::bigint as qty, b.taxable::bigint as taxable,
           round(coalesce(t.igst, 0))::bigint as igst, round(coalesce(t.cgst, 0))::bigint as cgst,
           round(coalesce(t.sgst, 0))::bigint as sgst, round(coalesce(t.cess, 0))::bigint as cess
      from base b left join taxes t on t.hsn = b.hsn
     order by b.hsn`)
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    hsnSac: String(r.hsn),
    uom: String(r.uom),
    qtyMilli: Number(r.qty),
    taxablePaise: Number(r.taxable),
    igstPaise: Number(r.igst),
    cgstPaise: Number(r.cgst),
    sgstPaise: Number(r.sgst),
    cessPaise: Number(r.cess),
  }))
}

export async function hsnReport(actor: Actor, input: { kind: 'sales' | 'purchase'; from: string; to: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => hsnSummary(tx, input.kind, input.from, input.to))
}

/** The sales or purchase register: every invoice with its tax broken out. */
export async function register(actor: Actor, input: { kind: 'sales' | 'purchase'; from: string; to: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await taxRows(tx, input.kind, input.from, input.to)
    const by = new Map<string, ReturnType<typeof emptyRegister>>()
    for (const r of rows) {
      const e = by.get(r.invoice_id) ?? emptyRegister(r)
      e.taxablePaise += r.taxable_paise
      e.igstPaise += r.igst
      e.cgstPaise += r.cgst
      e.sgstPaise += r.sgst
      e.cessPaise += r.cess
      by.set(r.invoice_id, e)
    }
    return [...by.values()]
  })
}

function emptyRegister(r: InvoiceTaxRow) {
  return {
    invoiceId: r.invoice_id,
    number: r.number,
    date: r.posting_date,
    isReturn: r.is_return,
    party: r.party,
    gstin: r.gstin,
    placeOfSupply: r.place_of_supply,
    reverseCharge: r.reverse_charge,
    totalPaise: r.total_paise,
    taxablePaise: 0,
    igstPaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    cessPaise: 0,
  }
}

/**
 * Tax deducted at source in a period, by section and payee: on suppliers'
 * bills when they were booked, and on payments where it was deducted then.
 * What a quarterly TDS return is prepared from.
 */
export async function tdsReport(actor: Actor, input: { from: string; to: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const res = await tx.execute(sql`
      select s.code as section, s.name as section_name, p.name as party, p.pan,
             sum(case when i.is_return then -1 else 1 end * (i.net_fc::numeric * i.exchange_rate))::bigint as paid,
             sum(case when i.is_return then -i.tds_paise else i.tds_paise end)::bigint as tds,
             count(*)::int as bills
        from finance_invoices i
        join finance_parties p on p.id = i.party_id
        join finance_tds_sections s on s.id = i.tds_section_id
       where i.kind = 'purchase' and i.docstatus = 'submitted' and i.posting_date between ${input.from}::date and ${input.to}::date
       group by s.code, s.name, p.name, p.pan
      union all
      select coalesce(s.code, '(unspecified)'), coalesce(s.name, ''), p.name, p.pan,
             sum(y.amount_paise + y.tds_paise)::bigint, sum(y.tds_paise)::bigint, count(*)::int
        from finance_payments y
        join finance_parties p on p.id = y.party_id
        left join finance_tds_sections s on s.id = y.tds_section_id
       where y.kind = 'pay' and y.tds_paise > 0 and y.docstatus = 'submitted' and y.posting_date between ${input.from}::date and ${input.to}::date
       group by s.code, s.name, p.name, p.pan
       order by 1, 3`)
    const rows = (res.rows as Record<string, unknown>[]).map((r) => ({
      section: String(r.section),
      sectionName: String(r.section_name),
      party: String(r.party),
      pan: (r.pan as string | null) ?? null,
      paidPaise: Number(r.paid),
      tdsPaise: Number(r.tds),
      documents: Number(r.bills),
    }))
    const received = await tx.execute(sql`
      select p.name as party, sum(y.tds_paise)::bigint as tds, count(*)::int as receipts
        from finance_payments y join finance_parties p on p.id = y.party_id
       where y.kind = 'receive' and y.tds_paise > 0 and y.docstatus = 'submitted' and y.posting_date between ${input.from}::date and ${input.to}::date
       group by p.name order by p.name`)
    return {
      from: input.from,
      to: input.to,
      deducted: rows,
      deductedPaise: rows.reduce((n, r) => n + r.tdsPaise, 0),
      deductedByOthers: (received.rows as { party: string; tds: number; receipts: number }[]).map((r) => ({ party: r.party, tdsPaise: Number(r.tds), receipts: r.receipts })),
      rowsWithoutPan: rows.filter((r) => !r.pan).length,
    }
  })
}

/** A report's rows as CSV, for the portal's offline tool or a spreadsheet. Money in rupees. */
export function toCsv(rows: Record<string, unknown>[], minorUnits = 2): string {
  if (rows.length === 0) return ''
  const keys = Object.keys(rows[0]!).filter((k) => typeof rows[0]![k] !== 'object' || rows[0]![k] === null)
  const cell = (k: string, v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = k.endsWith('Paise') && typeof v === 'number' ? (v / 10 ** minorUnits).toFixed(minorUnits) : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = keys.map((k) => k.replace(/Paise$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()))
  return [head.join(','), ...rows.map((r) => keys.map((k) => cell(k, r[k])).join(','))].join('\n')
}
