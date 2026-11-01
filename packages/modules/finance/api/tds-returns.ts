import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import * as z from 'zod'
import { invoices, payments, tdsChallanLinks, tdsChallans, tdsSections } from '../schema'
import { FinanceError, named, requireConfigure, requireRead, type Actor, type Tx } from './core'
import { bpOf, monthEnd, parseDecimal } from './numbers'
import { bankAccountWithin } from './payments'
import { accountFor, postWithin, reverseWithin } from './operations'
import { localToday } from './years'

/**
 * TDS returns (P1-05b, ACC-31): the challans that deposit the tax deducted, and
 * the statements built from the deductions and the challans together.
 *
 * CampusOS files nothing. A challan is recorded after the bank has taken the
 * payment; it ties each month's deductions to that payment, so a certificate
 * statement can quote the challan of every deduction. No person column: the
 * audit log says who recorded or voided one.
 */

const MODULE = 'finance'

/** Form names are settling under the Income-tax Act 2025; one place to change them. */
export const TDS_FORMS = {
  cutOverYear: 2026,
  certificate: (fy: number) => (fy < 2026 ? 'Form 16A' : 'TDS certificate (Form 16A or its Income-tax Act 2025 equivalent)'),
  returns: { resident: '26Q', nonResident: '27Q' },
} as const

export type TdsForm = '26Q' | '27Q'

/** The only residency signal stored today is the GST category (a reading for the CA, plan D2). */
export const formOf = (party: { gstCategory: string }): TdsForm =>
  party.gstCategory === 'overseas' ? TDS_FORMS.returns.nonResident : TDS_FORMS.returns.resident

export interface Deduction {
  kind: 'invoice' | 'payment'
  id: string
  number: string | null
  partyId: string
  party: string
  pan: string | null
  form: TdsForm
  sectionId: string | null
  section: string | null
  postingDate: string
  paidPaise: number
  tdsPaise: number
  challanId: string | null
  bsrCode: string | null
  challanSerial: string | null
  depositedOn: string | null
}

/**
 * Every deduction dated in a period: a submitted purchase bill with tax deducted
 * (a debit note counts negative) or a submitted payment that deducted tax.
 */
export async function deductionsWithin(tx: Tx, input: { from: string; to: string; form?: TdsForm }): Promise<Deduction[]> {
  const res = await tx.execute(sql`
    select 'invoice' as kind, i.id, i.number, i.party_id, p.name as party, p.pan, p.gst_category,
           i.tds_section_id as section_id, s.code as section, i.posting_date::text as posting_date,
           (case when i.is_return then -1 else 1 end * (i.net_fc::numeric * i.exchange_rate::numeric))::bigint as paid_paise,
           (case when i.is_return then -i.tds_paise else i.tds_paise end)::bigint as tds_paise,
           l.challan_id, c.bsr_code, c.challan_serial, c.deposited_on::text as deposited_on
      from finance_invoices i
      join finance_parties p on p.id = i.party_id
      left join finance_tds_sections s on s.id = i.tds_section_id
      left join finance_tds_challan_links l on l.invoice_id = i.id
      left join finance_tds_challans c on c.id = l.challan_id
     where i.kind = 'purchase' and i.docstatus = 'submitted' and i.tds_paise <> 0
       and i.posting_date between ${input.from}::date and ${input.to}::date
    union all
    select 'payment', y.id, y.number, y.party_id, p.name, p.pan, p.gst_category,
           y.tds_section_id, s.code, y.posting_date::text,
           (y.amount_paise + y.tds_paise)::bigint, y.tds_paise::bigint,
           l.challan_id, c.bsr_code, c.challan_serial, c.deposited_on::text
      from finance_payments y
      join finance_parties p on p.id = y.party_id
      left join finance_tds_sections s on s.id = y.tds_section_id
      left join finance_tds_challan_links l on l.payment_id = y.id
      left join finance_tds_challans c on c.id = l.challan_id
     where y.kind = 'pay' and y.docstatus = 'submitted' and y.tds_paise > 0
       and y.posting_date between ${input.from}::date and ${input.to}::date
     order by posting_date, number`)
  type Row = {
    kind: 'invoice' | 'payment'; id: string; number: string | null; party_id: string; party: string; pan: string | null; gst_category: string
    section_id: string | null; section: string | null; posting_date: string; paid_paise: string; tds_paise: string
    challan_id: string | null; bsr_code: string | null; challan_serial: string | null; deposited_on: string | null
  }
  return (res.rows as unknown as Row[])
    .map((r) => ({
      kind: r.kind,
      id: r.id,
      number: r.number,
      partyId: r.party_id,
      party: r.party,
      pan: r.pan,
      form: formOf({ gstCategory: r.gst_category }),
      sectionId: r.section_id,
      section: r.section,
      postingDate: r.posting_date,
      paidPaise: Number(r.paid_paise),
      tdsPaise: Number(r.tds_paise),
      challanId: r.challan_id,
      bsrCode: r.bsr_code,
      challanSerial: r.challan_serial,
      depositedOn: r.deposited_on,
    }))
    .filter((d) => !input.form || d.form === input.form)
}

// --- recording a challan ----------------------------------------------------------

export const recordChallanSchema = z
  .object({
    form: z.enum(['26Q', '27Q']),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    depositedOn: z.iso.date(),
    bsrCode: z.string().trim().regex(/^[0-9]{7}$/, 'the BSR code is seven digits'),
    challanSerial: z.string().trim().regex(/^[0-9]{5}$/, 'the challan serial is five digits'),
    interest: z.string().trim().max(24).optional(),
    fee: z.string().trim().max(24).optional(),
    accountId: z.uuid(),
  })
  .meta({ id: 'FinanceTdsChallan' })

const rupees = (v: string | undefined, what: string) => {
  if (!v) return 0
  const n = parseDecimal(v, 2)
  if (n === null || n < 0) throw new FinanceError(400, 'bad_amount', `${what} is not an amount`)
  return n
}

/**
 * Deposit a month's tax: every deduction of the form dated in the month that is
 * not already in a challan. Posts Dr the sections' payable accounts, Dr interest
 * and fee, Cr the bank.
 */
export async function recordChallan(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = recordChallanSchema.parse(input)
  const interestPaise = rupees(data.interest, 'the interest')
  const feePaise = rupees(data.fee, 'the fee')
  const from = `${data.month}-01`

  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'finance:tds-challan:' + tenant}))`)
      if (data.depositedOn > (await localToday(tx, tenant))) {
        throw new FinanceError(409, 'future_date', 'a challan cannot be deposited on a day that has not come')
      }
      const bank = await bankAccountWithin(tx, data.accountId, 'the challan')
      const same = await tx.execute(sql`
        select 1 from finance_tds_challans
         where bsr_code = ${data.bsrCode} and deposited_on = ${data.depositedOn}::date and challan_serial = ${data.challanSerial} and voided_at is null`)
      if (same.rows.length > 0) throw new FinanceError(409, 'duplicate_challan', 'that challan is already recorded')

      const read = (await deductionsWithin(tx, { from, to: monthEnd(from), form: data.form })).filter((d) => !d.challanId && d.sectionId)
      // A cancellation that commits between that read and the links below would leave a link to a reversed deduction (review finding 3): lock the documents and keep those still submitted.
      const ids = (kind: 'invoice' | 'payment') => read.filter((d) => d.kind === kind).map((d) => d.id)
      const live = new Set<string>()
      if (ids('invoice').length) {
        const rows = await tx.select({ id: invoices.id }).from(invoices).where(and(inArray(invoices.id, ids('invoice')), eq(invoices.docstatus, 'submitted'))).for('update')
        rows.forEach((r) => live.add(r.id))
      }
      if (ids('payment').length) {
        const rows = await tx.select({ id: payments.id }).from(payments).where(and(inArray(payments.id, ids('payment')), eq(payments.docstatus, 'submitted'))).for('update')
        rows.forEach((r) => live.add(r.id))
      }
      const waiting = read.filter((d) => live.has(d.id))
      const total = waiting.reduce((n, d) => n + d.tdsPaise, 0)
      if (total <= 0) throw new FinanceError(409, 'nothing_due', 'no tax deducted in that month is waiting to be deposited')

      const [row] = await tx
        .insert(tdsChallans)
        .values({
          institutionId: tenant,
          form: data.form,
          month: from,
          depositedOn: data.depositedOn,
          bsrCode: data.bsrCode,
          challanSerial: data.challanSerial,
          tdsPaise: total,
          interestPaise,
          feePaise,
          accountId: bank.id,
        })
        .returning()
      await tx.insert(tdsChallanLinks).values(
        waiting.map((d) => ({
          institutionId: tenant,
          challanId: row!.id,
          invoiceId: d.kind === 'invoice' ? d.id : null,
          paymentId: d.kind === 'payment' ? d.id : null,
          tdsPaise: d.tdsPaise,
        })),
      )

      // Each section's share goes against its own payable account.
      const fallback = await accountFor(tx, tenant, 'tds_payable')
      const sections = await tx.select().from(tdsSections)
      const payableOf = new Map(sections.map((s) => [s.id, s.payableAccountId ?? fallback]))
      const byAccount = new Map<string, number>()
      for (const d of waiting) {
        const account = payableOf.get(d.sectionId!) ?? fallback
        byAccount.set(account, (byAccount.get(account) ?? 0) + d.tdsPaise)
      }
      const lines: { accountId?: string; purpose?: 'tds_interest'; debitPaise: number; creditPaise: number }[] = []
      for (const [accountId, sum] of byAccount) {
        if (sum > 0) lines.push({ accountId, debitPaise: sum, creditPaise: 0 })
        else if (sum < 0) lines.push({ accountId, debitPaise: 0, creditPaise: -sum })
      }
      if (interestPaise + feePaise > 0) lines.push({ purpose: 'tds_interest', debitPaise: interestPaise + feePaise, creditPaise: 0 })
      lines.push({ accountId: bank.id, debitPaise: 0, creditPaise: total + interestPaise + feePaise })
      const posted = await postWithin(tx, tenant, actor.id, {
        postingDate: data.depositedOn,
        memo: `TDS challan ${data.bsrCode}/${data.challanSerial} for ${data.month}`.slice(0, 200),
        sourceModule: MODULE,
        sourceRef: `tds-challan:${row!.id}`,
        lines,
      })
      const entryId = posted.id
      await tx.update(tdsChallans).set({ entryId }).where(eq(tdsChallans.id, row!.id))

      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'tds.challan_recorded',
        entity: 'finance_tds_challans',
        entityId: row!.id,
        reason: `${data.form} challan for ${data.month} recorded`,
        detail: { ...row, entryId, links: waiting.length },
      })
      return { ...row!, entryId, links: waiting.length, notice: `Challan recorded against ${waiting.length} deductions.` }
    }),
  )
}

export const voidChallanSchema = z
  .object({ challanId: z.uuid(), reason: z.string().trim().min(5, 'give a reason of at least five characters').max(300) })
  .meta({ id: 'FinanceTdsChallanVoid' })

/** Void a challan: reverse its entry and free its deductions to be deposited again. */
export async function voidChallan(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const parsed = voidChallanSchema.safeParse(input)
  if (!parsed.success) throw new FinanceError(400, 'void_reason', 'give a reason of 5 to 300 characters')
  const data = parsed.data
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [c] = await tx.select().from(tdsChallans).where(eq(tdsChallans.id, data.challanId)).for('update')
      if (!c) throw new FinanceError(404, 'no_such_challan', 'no such challan')
      if (c.voidedAt) throw new FinanceError(409, 'already_voided', 'that challan is already void')
      if (c.entryId) await reverseWithin(tx, tenant, actor.id, c.entryId, data.reason, await localToday(tx, tenant))
      const links = await tx.delete(tdsChallanLinks).where(eq(tdsChallanLinks.challanId, c.id)).returning()
      await tx.update(tdsChallans).set({ voidedAt: new Date(), voidReason: data.reason }).where(eq(tdsChallans.id, c.id))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'tds.challan_voided',
        entity: 'finance_tds_challans',
        entityId: c.id,
        reason: data.reason,
        detail: { links: links.map((l) => ({ invoiceId: l.invoiceId, paymentId: l.paymentId, tdsPaise: l.tdsPaise })) },
      })
      return { notice: 'Challan voided. Its deductions can be deposited again.' }
    }),
  )
}

export async function listChallans(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => tx.select().from(tdsChallans).orderBy(desc(tdsChallans.depositedOn), desc(tdsChallans.createdAt)))
}

/** Whether a bill or payment sits in a live challan: it then cannot be cancelled (plan D7). */
export async function inChallan(tx: Tx, which: { invoiceId: string } | { paymentId: string }): Promise<boolean> {
  const r = await tx.execute(
    'invoiceId' in which
      ? sql`select 1 from finance_tds_challan_links where invoice_id = ${which.invoiceId}`
      : sql`select 1 from finance_tds_challan_links where payment_id = ${which.paymentId}`,
  )
  return r.rows.length > 0
}

// --- the quarterly working statement --------------------------------------------------

const QUARTERS = [
  { from: (fy: number) => `${fy}-04-01`, to: (fy: number) => `${fy}-06-30` },
  { from: (fy: number) => `${fy}-07-01`, to: (fy: number) => `${fy}-09-30` },
  { from: (fy: number) => `${fy}-10-01`, to: (fy: number) => `${fy}-12-31` },
  { from: (fy: number) => `${fy + 1}-01-01`, to: (fy: number) => `${fy + 1}-03-31` },
] as const

const quarterSchema = z.object({
  fy: z.coerce.number().int().min(2000).max(2100),
  quarter: z.coerce.number().int().min(1).max(4),
  form: z.enum(['26Q', '27Q']).default('26Q'),
})

function quarterOf(input: unknown) {
  const parsed = quarterSchema.safeParse(input)
  if (!parsed.success) throw new FinanceError(400, 'bad_period', 'give a fiscal year from 2000 to 2100 and a quarter from 1 to 4')
  const { fy, quarter, form } = parsed.data
  const q = QUARTERS[quarter - 1]!
  return { fy, quarter, form, from: q.from(fy), to: q.to(fy) }
}

const rupeeText = (paise: number) => (paise / 100).toFixed(2)
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The quarter's deductions and challans as one CSV, the working an accountant
 * or the FVU file is prepared from: a DEDUCTEE row for each deduction, a CHALLAN
 * row for each live challan, and what was deducted against what was deposited.
 */
export async function tdsQuarterFile(actor: Actor, input: unknown) {
  const tenant = requireRead(actor)
  const q = quarterOf(input)
  return withTenant(tenant, async (tx) => {
    const deductions = await deductionsWithin(tx, { from: q.from, to: q.to, form: q.form })
    const challans = await tx
      .select()
      .from(tdsChallans)
      .where(sql`${tdsChallans.form} = ${q.form} and ${tdsChallans.month} between ${q.from}::date and ${q.to}::date and ${tdsChallans.voidedAt} is null`)
    const head = ['Record', 'Section', 'Deductee', 'PAN', 'Document', 'Date', 'Amount paid', 'TDS', 'BSR code', 'Challan serial', 'Deposited on']
    const lines: unknown[][] = [head]
    for (const d of deductions) {
      lines.push(['DEDUCTEE', d.section, d.party, d.pan ?? 'PANNOTAVBL', d.number, d.postingDate, rupeeText(d.paidPaise), rupeeText(d.tdsPaise), d.bsrCode, d.challanSerial, d.depositedOn])
    }
    for (const c of challans) {
      lines.push(['CHALLAN', '', '', '', '', c.month, rupeeText(c.tdsPaise + c.interestPaise + c.feePaise), rupeeText(c.tdsPaise), c.bsrCode, c.challanSerial, c.depositedOn])
    }
    const deducted = deductions.reduce((n, d) => n + d.tdsPaise, 0)
    const deposited = challans.reduce((n, c) => n + c.tdsPaise, 0)
    for (const [label, value] of [['Deducted', deducted], ['Deposited', deposited], ['Difference', deducted - deposited]] as const) {
      lines.push(['TOTAL', label, '', '', '', '', '', rupeeText(value), '', '', ''])
    }
    return {
      bytes: lines.map((l) => l.map(csvCell).join(',')).join('\n'),
      fileName: `tds-${q.form}-${q.fy}-Q${q.quarter}.csv`,
      type: 'text/csv; charset=utf-8',
    }
  })
}

// --- late-deposit interest ------------------------------------------------------------

/** Interest on tax deducted but deposited late: one and a half percent for each month or part month. */
export const TDS_LATE_DEPOSIT_BP = 150

/** The 7th of the month after the deduction; deductions dated in March are due on 30 April. */
export function dueDateOf(postingDate: string): string {
  const [y, m] = postingDate.split('-').map(Number) as [number, number]
  if (m === 3) return `${y}-04-30`
  return m === 12 ? `${y + 1}-01-07` : `${y}-${String(m + 1).padStart(2, '0')}-07`
}

/** Calendar months from the deduction's month to the payment's month, both counted. */
export function monthsLate(deductedOn: string, paidOn: string): number {
  const [dy, dm] = deductedOn.split('-').map(Number) as [number, number]
  const [py, pm] = paidOn.split('-').map(Number) as [number, number]
  return (py - dy) * 12 + (pm - dm) + 1
}

/** Late-deposit interest as of a day (default today): what each late deduction would cost or cost. */
export async function tdsInterest(actor: Actor, input: { on?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = input.on ?? (await localToday(tx, tenant))
    const rows = (await deductionsWithin(tx, { from: '2000-01-01', to: on }))
      .filter((d) => d.tdsPaise > 0)
      .map((d) => {
        const dueOn = dueDateOf(d.postingDate)
        const paidOn = d.depositedOn ?? on
        if (paidOn <= dueOn) return null
        const months = monthsLate(d.postingDate, paidOn)
        return {
          document: d.number,
          party: d.party,
          section: d.section,
          deductedOn: d.postingDate,
          dueOn,
          depositedOn: d.depositedOn,
          tdsPaise: d.tdsPaise,
          months,
          interestPaise: bpOf(d.tdsPaise, TDS_LATE_DEPOSIT_BP * months),
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    return { on, rows, totalPaise: rows.reduce((n, r) => n + r.interestPaise, 0) }
  })
}

/** The quarter's deductions as rows, for the returns page. */
export async function tdsDeductions(actor: Actor, input: unknown) {
  const tenant = requireRead(actor)
  const q = quarterOf(input)
  return withTenant(tenant, async (tx) => ({ ...q, rows: await deductionsWithin(tx, { from: q.from, to: q.to, form: q.form }) }))
}
