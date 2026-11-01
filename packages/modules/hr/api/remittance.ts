/**
 * Remittance of statutory payables (P1-06c, ACC-24): money actually paid to
 * the PF office, ESIC, a state for professional tax, or the tax department,
 * recorded against the payable each payslip credited.
 *
 * Interest and late fees are not computed: they are journal entries in
 * finance. A mistake is voided with a reason and entered again, never edited.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { isPosted, postWithin, reverseWithin } from '@campusos/module-finance/api'
import { HrError, MODULE, requireAdmin, type Actor, type Tx } from './guards'
import { lockPayrollPeriod } from './operations'
import { monthOf } from './documents'
import type { PayslipLine } from './payroll'
import { STATUTORY, type PayslipStatutory } from './statutory'
import { remitSchema, voidRemittanceSchema } from './schemas'
import { payslips, remittances } from '../schema'

export type Head = 'pf' | 'esi' | 'pt' | 'tds'
export type RemittanceRow = typeof remittances.$inferSelect

export interface Due {
  head: Head
  period: string
  state: string | null
  dueEmployeePaise: number
  dueEmployerPaise: number
  adminTopUpPaise: number
  duePaise: number
  remittedPaise: number
  balancePaise: number
}

const PAYABLE: Record<Head, string> = { pf: 'pf_payable', esi: 'esi_payable', pt: 'pt_payable', tds: 'salary_tds_payable' }

const monthEnd = (period: string) =>
  new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10)

/** Today's date in India: a challan cannot be dated tomorrow there. */
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

/** What each head owes for a month, from the month's current payslips, less what was remitted. */
export async function duesFor(tx: Tx, period: string): Promise<Due[]> {
  const slips = await tx.select().from(payslips).where(eq(payslips.period, period))
  const done = await tx.select().from(remittances).where(and(eq(remittances.period, period), isNull(remittances.voidedAt)))
  const line = (s: (typeof slips)[number], code: string) =>
    (s.lines as PayslipLine[]).find((l) => l.code === code)?.appliedPaise ?? 0
  const st = (s: (typeof slips)[number]) => s.statutory as PayslipStatutory | null

  const sum = (f: (s: (typeof slips)[number]) => number) => slips.reduce((t, s) => t + f(s), 0)
  const out: Omit<Due, 'balancePaise' | 'remittedPaise'>[] = []

  const pfEmployee = sum((s) => line(s, 'pf_employee'))
  const pfEmployer = sum((s) => {
    const e = st(s)?.employer
    return e ? e.epsPaise + e.epfPaise + e.edliPaise + e.pfAdminPaise : 0
  })
  const hasMember = slips.some((s) => (st(s)?.pfWagesPaise ?? 0) > 0)
  const adminSum = sum((s) => st(s)?.employer.pfAdminPaise ?? 0)
  const topUp = hasMember ? Math.max(0, STATUTORY.pfAdminMinPaise - adminSum) : 0
  if (pfEmployee + pfEmployer + topUp > 0) {
    out.push({ head: 'pf', period, state: null, dueEmployeePaise: pfEmployee, dueEmployerPaise: pfEmployer, adminTopUpPaise: topUp, duePaise: pfEmployee + pfEmployer + topUp })
  }

  const esiEmployee = sum((s) => line(s, 'esi_employee'))
  const esiEmployer = sum((s) => st(s)?.employer.esiPaise ?? 0)
  if (esiEmployee + esiEmployer > 0) {
    out.push({ head: 'esi', period, state: null, dueEmployeePaise: esiEmployee, dueEmployerPaise: esiEmployer, adminTopUpPaise: 0, duePaise: esiEmployee + esiEmployer })
  }

  const ptByState = new Map<string, number>()
  for (const s of slips) {
    const state = st(s)?.ptState
    const pt = line(s, 'professional_tax')
    if (state && pt > 0) ptByState.set(state, (ptByState.get(state) ?? 0) + pt)
  }
  for (const [state, pt] of [...ptByState].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ head: 'pt', period, state, dueEmployeePaise: pt, dueEmployerPaise: 0, adminTopUpPaise: 0, duePaise: pt })
  }

  const tds = sum((s) => line(s, 'income_tax'))
  if (tds > 0) out.push({ head: 'tds', period, state: null, dueEmployeePaise: tds, dueEmployerPaise: 0, adminTopUpPaise: 0, duePaise: tds })

  return out.map((d) => {
    const remittedPaise = done.filter((r) => r.head === d.head && (r.state ?? null) === d.state).reduce((t, r) => t + r.amountPaise, 0)
    return { ...d, remittedPaise, balancePaise: d.duePaise - remittedPaise }
  })
}

export async function listDues(actor: Actor, rawPeriod: string): Promise<Due[]> {
  const tenant = requireAdmin(actor)
  const period = monthOf(rawPeriod)
  return withTenant(tenant, (tx) => duesFor(tx, period))
}

export async function listRemittances(actor: Actor, rawPeriod?: string): Promise<RemittanceRow[]> {
  const tenant = requireAdmin(actor)
  const period = rawPeriod ? monthOf(rawPeriod) : undefined
  return withTenant(tenant, (tx) =>
    tx.select().from(remittances).where(period ? eq(remittances.period, period) : undefined).orderBy(desc(remittances.createdAt)).limit(500),
  )
}

export async function remit(actor: Actor, input: unknown): Promise<RemittanceRow> {
  const tenant = requireAdmin(actor)
  const d = remitSchema.parse(input)
  if ((d.head === 'pt') !== (d.state !== null)) {
    throw new HrError(400, 'state_rule', 'professional tax is remitted per state, and no other head has one')
  }
  if (d.head === 'tds' && (!d.bsrCode || !d.challanSerial)) {
    throw new HrError(400, 'challan_required', 'a TDS challan needs its BSR code and challan serial')
  }

  return withTenant(tenant, async (tx) => {
    await lockPayrollPeriod(tx, tenant, d.period)
    const due = (await duesFor(tx, d.period)).find((x) => x.head === d.head && x.state === d.state)
    if (!due || due.balancePaise <= 0) throw new HrError(409, 'nothing_due', 'nothing is left to remit for this head and month')
    if (d.amount > due.balancePaise) {
      throw new HrError(409, 'over_remitted', `only ${due.balancePaise} paise is left to remit for this head and month`)
    }
    if (d.paidOn > todayIst()) throw new HrError(409, 'future_date', 'a payment cannot be dated in the future')
    const [same] = await tx
      .select({ id: remittances.id })
      .from(remittances)
      .where(and(eq(remittances.head, d.head), eq(remittances.challanRef, d.challanRef), isNull(remittances.voidedAt)))
    if (same) throw new HrError(409, 'duplicate_challan', 'this challan reference is already recorded')

    // The EPF administration floor is posted once, at the first PF remittance of the month (NEW-50).
    if (d.head === 'pf' && due.adminTopUpPaise > 0) {
      const ref = `pf-admin-minimum:${d.period}`
      if (!(await isPosted(tx, MODULE, ref))) {
        await postWithin(tx, tenant, actor.id, {
          postingDate: monthEnd(d.period),
          memo: `${d.period.slice(0, 7)} EPF administration charge, minimum`,
          sourceModule: MODULE,
          sourceRef: ref,
          lines: [
            { purpose: 'employer_cost', debitPaise: due.adminTopUpPaise },
            { purpose: 'pf_payable', creditPaise: due.adminTopUpPaise },
          ],
        })
      }
    }

    const [row] = await tx
      .insert(remittances)
      .values({
        institutionId: tenant,
        head: d.head,
        period: d.period,
        state: d.state,
        amountPaise: d.amount,
        paidOn: d.paidOn,
        paidFrom: d.paidFrom,
        challanRef: d.challanRef,
        bsrCode: d.bsrCode,
        challanSerial: d.challanSerial,
        note: d.note,
        remittedBy: actor.id,
      })
      .returning()
    await postWithin(tx, tenant, actor.id, {
      postingDate: d.paidOn,
      memo: `${d.period.slice(0, 7)} ${d.head.toUpperCase()}${d.state ? ` ${d.state}` : ''} remitted, challan ${d.challanRef}`,
      sourceModule: MODULE,
      sourceRef: `remittance:${row!.id}`,
      lines: [
        { purpose: PAYABLE[d.head], debitPaise: d.amount },
        { purpose: d.paidFrom, creditPaise: d.amount },
      ],
    })
    return row!
  })
}

export async function voidRemittance(actor: Actor, input: unknown): Promise<RemittanceRow> {
  const tenant = requireAdmin(actor)
  const d = voidRemittanceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [found] = await tx.select().from(remittances).where(eq(remittances.id, d.remittanceId))
    if (!found) throw new HrError(404, 'no_such_remittance', 'no such remittance')
    await lockPayrollPeriod(tx, tenant, found.period)
    const [row] = await tx.select().from(remittances).where(eq(remittances.id, d.remittanceId))
    if (row!.voidedAt) throw new HrError(409, 'already_void', 'this remittance is already void')
    const entry = await isPosted(tx, MODULE, `remittance:${row!.id}`)
    if (entry) await reverseWithin(tx, tenant, actor.id, entry, d.reason)
    const [done] = await tx
      .update(remittances)
      .set({ voidedAt: new Date(), voidedBy: actor.id, voidReason: d.reason })
      .where(eq(remittances.id, row!.id))
      .returning()
    return done!
  })
}
