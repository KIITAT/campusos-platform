import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { accounts, invoices, taxComponents, taxTemplates, tdsSections } from '../schema'
import { FinanceError, named, requireConfigure, requireRead, type Actor, type Tx } from './core'
import { accountFor, ensureDefaultChart } from './operations'
import { bpOf, parseDecimal } from './numbers'

/**
 * Taxes: GST on what is bought and sold, and tax deducted at source on what
 * is paid.
 *
 * The rates are the institution's (decision 116). What CampusOS supplies is
 * the arithmetic and the books: which components apply inside the state and
 * which across it, what is claimable, what is owed under reverse charge, and
 * when a payment to a supplier crosses the threshold that makes TDS due. An
 * optional starter set for India can be loaded and then edited; the screen
 * says when it was written and that it is the institution's to check.
 */

export type Component = 'cgst' | 'sgst' | 'utgst' | 'igst' | 'cess' | 'other'

export interface TemplateRule {
  id: string
  name: string
  kind: 'gst' | 'other'
  treatment: 'taxable' | 'exempt' | 'nil_rated' | 'non_gst'
  components: {
    component: Component
    applies: 'intra' | 'inter' | 'always'
    rateBp: number
    outputAccountId: string | null
    inputAccountId: string | null
  }[]
}

export interface TaxableLine {
  /** Net of discount, in the document's currency. */
  amount: number
  templateId: string | null
  /** Input tax on this line may be claimed. Off for blocked credits. */
  itcEligible?: boolean
}

export interface TaxRow {
  templateId: string
  component: Component
  rateBp: number
  accountId: string | null
  taxable: number
  tax: number
  /** The part of `tax` that may not be claimed, and is therefore a cost. */
  ineligible: number
}

/**
 * The tax on a document, by template and component.
 *
 * Taxable values are summed per template first and the tax worked out once
 * on the sum, rounded half away from zero: one rounding per component per
 * invoice, as an invoice is printed and as GST returns add it up, rather than a
 * paisa lost or gained on every line. Inside the state the intra components
 * apply (CGST and SGST), across it the inter ones (IGST).
 */
export function computeTaxes(
  lines: TaxableLine[],
  templates: Map<string, TemplateRule>,
  intraState: boolean,
  kind: 'sales' | 'purchase',
): TaxRow[] {
  const sums = new Map<string, { eligible: number; ineligible: number }>()
  for (const l of lines) {
    if (!l.templateId) continue
    if (!templates.has(l.templateId)) throw new FinanceError(400, 'no_such_tax', 'a line names a tax that does not exist')
    const s = sums.get(l.templateId) ?? { eligible: 0, ineligible: 0 }
    if (kind === 'purchase' && l.itcEligible === false) s.ineligible += l.amount
    else s.eligible += l.amount
    sums.set(l.templateId, s)
  }

  const rows: TaxRow[] = []
  for (const [templateId, sum] of sums) {
    const t = templates.get(templateId)!
    if (t.treatment !== 'taxable') continue
    for (const c of t.components) {
      if (c.applies === 'intra' && !intraState) continue
      if (c.applies === 'inter' && intraState) continue
      const taxable = sum.eligible + sum.ineligible
      const tax = bpOf(taxable, c.rateBp)
      const ineligible = sum.ineligible ? bpOf(sum.ineligible, c.rateBp) : 0
      rows.push({
        templateId,
        component: c.component,
        rateBp: c.rateBp,
        accountId: kind === 'sales' ? c.outputAccountId : c.inputAccountId,
        taxable,
        tax,
        ineligible: Math.min(ineligible, tax),
      })
    }
  }
  return rows
}

/** Whether a supply is inside the state, from the two state codes. Unknown is treated as inside. */
export const isIntraState = (ourState: string | null, theirState: string | null, overseas = false) =>
  !overseas && (!ourState || !theirState || ourState === theirState)

export async function templatesWithin(tx: Tx, ids?: string[]): Promise<Map<string, TemplateRule>> {
  const ts = await tx
    .select()
    .from(taxTemplates)
    .where(ids ? (ids.length ? inArray(taxTemplates.id, ids) : sql`false`) : undefined)
  const cs = ts.length
    ? await tx.select().from(taxComponents).where(inArray(taxComponents.templateId, ts.map((t) => t.id)))
    : []
  return new Map(
    ts.map((t) => [
      t.id,
      {
        id: t.id,
        name: t.name,
        kind: t.kind,
        treatment: t.treatment,
        components: cs
          .filter((c) => c.templateId === t.id)
          .map((c) => ({
            component: c.component as Component,
            applies: c.applies,
            rateBp: c.rateBp,
            outputAccountId: c.outputAccountId,
            inputAccountId: c.inputAccountId,
          })),
      },
    ]),
  )
}

// --- templates ------------------------------------------------------------------------

const componentSchema = z.object({
  component: z.enum(['cgst', 'sgst', 'utgst', 'igst', 'cess', 'other']),
  applies: z.enum(['intra', 'inter', 'always']).default('always'),
  ratePercent: z.string().trim().min(1),
  outputAccountCode: z.string().trim().optional(),
  inputAccountCode: z.string().trim().optional(),
})

export const taxTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(['gst', 'other']).default('gst'),
    treatment: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst']).default('taxable'),
    components: z.array(componentSchema).max(8).default([]),
  })
  .meta({ id: 'FinanceTaxTemplate' })

async function accountIdOf(tx: Tx, code: string | undefined, fallback: 'gst_input' | 'gst_output', tenant: string) {
  if (!code) return accountFor(tx, tenant, fallback)
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code))
  if (!row) throw new FinanceError(404, 'no_such_account', `no account with code ${code}`)
  return row.id
}

export async function createTaxTemplate(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = taxTemplateSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [t] = await tx
        .insert(taxTemplates)
        .values({ institutionId: tenant, name: data.name, kind: data.kind, treatment: data.treatment })
        .returning({ id: taxTemplates.id })
      for (const c of data.components) {
        const bp = parseDecimal(c.ratePercent, 2)
        if (bp === null || bp < 0 || bp > 10000) throw new FinanceError(400, 'bad_rate', 'a rate is a percentage up to 100')
        await tx.insert(taxComponents).values({
          institutionId: tenant,
          templateId: t!.id,
          component: c.component,
          applies: c.applies,
          rateBp: bp,
          outputAccountId: await accountIdOf(tx, c.outputAccountCode, 'gst_output', tenant),
          inputAccountId: await accountIdOf(tx, c.inputAccountCode, 'gst_input', tenant),
        })
      }
      return { ...t!, notice: `${data.name} added.` }
    }),
  )
}

export async function archiveTaxTemplate(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = z.object({ id: z.uuid(), archived: z.preprocess(ticked, z.boolean()).default(true) }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .update(taxTemplates)
      .set({ archivedAt: data.archived ? new Date() : null })
      .where(eq(taxTemplates.id, data.id))
    return { notice: data.archived ? 'Archived.' : 'Restored.' }
  })
}

export async function listTaxes(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const templates = [...(await templatesWithin(tx)).values()].sort((a, b) => a.name.localeCompare(b.name))
    const archived = await tx
      .select({ id: taxTemplates.id, archivedAt: taxTemplates.archivedAt })
      .from(taxTemplates)
    const sections = await tx.select().from(tdsSections).orderBy(asc(tdsSections.code))
    const accts = await tx.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts)
    const nameOf = (id: string | null) => {
      const a = accts.find((x) => x.id === id)
      return a ? `${a.code} ${a.name}` : ''
    }
    return {
      templates: templates.map((t) => ({
        ...t,
        archived: !!archived.find((a) => a.id === t.id)?.archivedAt,
        rate: t.components
          .filter((c) => c.applies !== 'inter')
          .reduce((n, c) => n + c.rateBp, 0),
        summary: t.components
          .map((c) => `${c.component.toUpperCase()} ${c.rateBp / 100}%${c.applies === 'always' ? '' : ` (${c.applies})`}`)
          .join(', '),
        components: t.components.map((c) => ({
          ...c,
          output: nameOf(c.outputAccountId),
          input: nameOf(c.inputAccountId),
        })),
      })),
      sections: sections.map((s) => ({ ...s, payable: nameOf(s.payableAccountId) })),
    }
  })
}

/** Tax templates as choices for a line, with the rate in the label. */
export async function taxChoices(tx: Tx) {
  const rows = await tx
    .select({ id: taxTemplates.id, name: taxTemplates.name })
    .from(taxTemplates)
    .where(isNull(taxTemplates.archivedAt))
    .orderBy(asc(taxTemplates.name))
  return rows.map((r) => ({ value: r.id, label: r.name }))
}

// --- TDS ---------------------------------------------------------------------------------

export const tdsSectionSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(2).max(160),
    ratePercent: z.string().trim().min(1),
    rateNoPanPercent: z.string().trim().min(1),
    thresholdSingle: z.string().trim().default('0'),
    thresholdAnnual: z.string().trim().default('0'),
    payableAccountCode: z.string().trim().optional(),
  })
  .meta({ id: 'FinanceTdsSection' })

export async function createTdsSection(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = tdsSectionSchema.parse(input)
  const rate = parseDecimal(data.ratePercent, 2)
  const noPan = parseDecimal(data.rateNoPanPercent, 2)
  const single = parseDecimal(data.thresholdSingle || '0', 2)
  const annual = parseDecimal(data.thresholdAnnual || '0', 2)
  if ([rate, noPan, single, annual].some((v) => v === null || v < 0)) {
    throw new FinanceError(400, 'bad_number', 'rates and thresholds are numbers')
  }
  return withTenant(tenant, (tx) =>
    named(async () => {
      let payable: string
      if (data.payableAccountCode) {
        const [a] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, data.payableAccountCode))
        if (!a) throw new FinanceError(404, 'no_such_account', `no account ${data.payableAccountCode}`)
        payable = a.id
      } else payable = await accountFor(tx, tenant, 'tds_payable')
      const [row] = await tx
        .insert(tdsSections)
        .values({
          institutionId: tenant,
          code: data.code,
          name: data.name,
          rateBp: rate!,
          rateNoPanBp: noPan!,
          thresholdSinglePaise: single!,
          thresholdAnnualPaise: annual!,
          payableAccountId: payable,
        })
        .returning({ id: tdsSections.id })
      return { ...row!, notice: `${data.code} added.` }
    }),
  )
}

/**
 * How much tax to deduct from a supplier's bill.
 *
 * Nothing until the payee crosses a threshold: this bill alone above the
 * single-bill limit, or the year's bills to them, this one included, above the
 * annual one. Once the annual limit is crossed, the whole year's bills are
 * subject -- so the bill that crosses it deducts on what was let through
 * before as well, less anything already deducted. Without a PAN, the higher
 * rate.
 */
export async function tdsFor(
  tx: Tx,
  input: {
    sectionId: string
    partyId: string
    hasPan: boolean
    /** This bill's taxable value, before GST. */
    amountPaise: number
    fyStart: string
    fyEnd: string
    excludeInvoiceId?: string
  },
): Promise<number> {
  const [section] = await tx.select().from(tdsSections).where(eq(tdsSections.id, input.sectionId))
  if (!section) throw new FinanceError(404, 'no_such_tds_section', 'no such TDS section')
  const rate = input.hasPan ? section.rateBp : section.rateNoPanBp

  const [prior] = await tx
    .select({
      net: sql<number>`coalesce(sum(case when ${invoices.isReturn} then -1 else 1 end * (${invoices.netFc}::numeric * ${invoices.exchangeRate}))::bigint, 0)`,
      deducted: sql<number>`coalesce(sum(case when ${invoices.isReturn} then -${invoices.tdsPaise} else ${invoices.tdsPaise} end), 0)::bigint`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.partyId, input.partyId),
        eq(invoices.kind, 'purchase'),
        eq(invoices.docstatus, 'submitted'),
        eq(invoices.tdsSectionId, input.sectionId),
        sql`${invoices.postingDate} between ${input.fyStart} and ${input.fyEnd}`,
        input.excludeInvoiceId ? sql`${invoices.id} <> ${input.excludeInvoiceId}` : undefined,
      ),
    )
  const before = Number(prior?.net ?? 0)
  const already = Number(prior?.deducted ?? 0)
  const yearTotal = before + input.amountPaise

  const overSingle = section.thresholdSinglePaise > 0 && input.amountPaise > section.thresholdSinglePaise
  const overAnnual = section.thresholdAnnualPaise > 0 && yearTotal > section.thresholdAnnualPaise
  const noThresholds = section.thresholdSinglePaise === 0 && section.thresholdAnnualPaise === 0

  if (noThresholds || overSingle && !overAnnual) return bpOf(input.amountPaise, rate)
  if (overAnnual) return Math.max(bpOf(yearTotal, rate) - already, 0)
  return 0
}

// --- the India starter set ------------------------------------------------------------

/**
 * When the starter set below was written, and what it is. Shown on the screen
 * beside the button, so nobody mistakes it for something kept up to date.
 */
export const INDIA_PRESET_AS_OF = '2026-10-04'

const GST_SLABS = [
  { name: 'GST 5%', rate: 500 },
  { name: 'GST 18%', rate: 1800 },
  { name: 'GST 40%', rate: 4000 },
] as const

/**
 * Nature-of-payment TDS sections, named by what is paid for, with the pre-2026
 * section numbers in brackets because that is what most staff still know them
 * by. Under the Income-tax Act, 2025 (in force from 1 April 2026) these are
 * consolidated in one section with a table; the institution checks each rate
 * and threshold before relying on it.
 */
const TDS_STARTERS = [
  { code: 'CONTRACT-IND', name: 'Contractors: individual or HUF (was 194C)', rate: 100, noPan: 2000, single: 3_000_000, annual: 10_000_000 },
  { code: 'CONTRACT', name: 'Contractors: others (was 194C)', rate: 200, noPan: 2000, single: 3_000_000, annual: 10_000_000 },
  { code: 'PROF', name: 'Professional fees (was 194J)', rate: 1000, noPan: 2000, single: 0, annual: 5_000_000 },
  { code: 'TECH', name: 'Fees for technical services (was 194J)', rate: 200, noPan: 2000, single: 0, annual: 5_000_000 },
  { code: 'RENT-LB', name: 'Rent: land and buildings (was 194-I)', rate: 1000, noPan: 2000, single: 5_000_000, annual: 0 },
  { code: 'RENT-PM', name: 'Rent: plant and machinery (was 194-I)', rate: 200, noPan: 2000, single: 5_000_000, annual: 0 },
  { code: 'COMM', name: 'Commission or brokerage (was 194H)', rate: 200, noPan: 2000, single: 0, annual: 2_000_000 },
] as const

/**
 * Load the starter set: GST accounts for each component on both sides, the
 * current slabs inside and across the state, exempt and nil-rated and non-GST
 * templates, and TDS sections. Idempotent -- anything of the same name is left
 * as the institution has it. Every figure is then the institution's to edit.
 */
export async function loadIndiaPreset(actor: Actor) {
  const tenant = requireConfigure(actor)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await ensureDefaultChart(tx, tenant)
      const group = async (code: string) =>
        (await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)))[0]?.id ?? null
      const current = await group('11')
      const liabilities = await group('21')

      const account = async (code: string, name: string, type: 'asset' | 'liability', parentId: string | null) => {
        const [have] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code))
        if (have) return have.id
        const [made] = await tx
          .insert(accounts)
          .values({ institutionId: tenant, code, name, type, subtype: 'tax', parentId })
          .returning({ id: accounts.id })
        return made!.id
      }

      const input = {
        cgst: await account('1401', 'CGST input credit', 'asset', current),
        sgst: await account('1402', 'SGST input credit', 'asset', current),
        igst: await account('1403', 'IGST input credit', 'asset', current),
        cess: await account('1404', 'Cess input credit', 'asset', current),
      }
      const output = {
        cgst: await account('2401', 'CGST payable', 'liability', liabilities),
        sgst: await account('2402', 'SGST payable', 'liability', liabilities),
        igst: await account('2403', 'IGST payable', 'liability', liabilities),
        cess: await account('2404', 'Cess payable', 'liability', liabilities),
      }

      const existing = new Set((await tx.select({ name: taxTemplates.name }).from(taxTemplates)).map((t) => t.name))
      let made = 0
      for (const slab of GST_SLABS) {
        if (existing.has(slab.name)) continue
        const [t] = await tx
          .insert(taxTemplates)
          .values({ institutionId: tenant, name: slab.name, kind: 'gst', treatment: 'taxable' })
          .returning({ id: taxTemplates.id })
        const half = slab.rate / 2
        await tx.insert(taxComponents).values([
          { institutionId: tenant, templateId: t!.id, component: 'cgst', applies: 'intra', rateBp: half, outputAccountId: output.cgst, inputAccountId: input.cgst },
          { institutionId: tenant, templateId: t!.id, component: 'sgst', applies: 'intra', rateBp: half, outputAccountId: output.sgst, inputAccountId: input.sgst },
          { institutionId: tenant, templateId: t!.id, component: 'igst', applies: 'inter', rateBp: slab.rate, outputAccountId: output.igst, inputAccountId: input.igst },
        ])
        made++
      }
      for (const [name, treatment] of [
        ['GST exempt', 'exempt'],
        ['GST nil-rated', 'nil_rated'],
        ['Non-GST supply', 'non_gst'],
      ] as const) {
        if (existing.has(name)) continue
        await tx.insert(taxTemplates).values({ institutionId: tenant, name, kind: 'gst', treatment })
        made++
      }

      const payable = await accountFor(tx, tenant, 'tds_payable')
      const codes = new Set((await tx.select({ code: tdsSections.code }).from(tdsSections)).map((s) => s.code))
      for (const s of TDS_STARTERS) {
        if (codes.has(s.code)) continue
        await tx.insert(tdsSections).values({
          institutionId: tenant,
          code: s.code,
          name: s.name,
          rateBp: s.rate,
          rateNoPanBp: s.noPan,
          thresholdSinglePaise: s.single,
          thresholdAnnualPaise: s.annual,
          payableAccountId: payable,
        })
        made++
      }

      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'finance',
        action: 'tax.preset_loaded',
        entity: 'finance_tax_templates',
        entityId: tenant,
        reason: `India starter set as of ${INDIA_PRESET_AS_OF}`,
      })
      return {
        notice: made
          ? `Loaded ${made} taxes and sections, as understood on ${INDIA_PRESET_AS_OF}. Check every rate and threshold against the law in force before relying on them.`
          : 'Everything in the starter set is already here.',
      }
    }),
  )
}
