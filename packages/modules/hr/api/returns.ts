/**
 * Annual tax statement and the quarterly TDS working statement (P1-06c,
 * ACC-17). The statement is Part B of Form 16, or Form 130 under the Income-tax
 * Act 2025: the form's name and cut-over year live in TAX_FORM, one constant to
 * change. Part A (tax deposited) is issued from TRACES, not here.
 */
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import { db, institutions, withTenant } from '@campusos/db'
import { plainPaise } from '@campusos/money'
import { HrError, isHr, requireAdmin, tenantOf, type Actor } from './guards'
import { csvCell } from './files'
import { taxStatementPdf } from './payslip-pdf'
import type { PayslipLine } from './payroll'
import type { TaxRecord } from './tds'
import { payslips, remittances, staff, taxPreviousEmployment } from '../schema'

export const TAX_FORM = { cutOverTaxYear: 2026, before: 'Form 16 (Part B)', from: 'Form 130' } as const

/** The three months of a quarter of a tax year starting in April. Quarter 4 falls in the next calendar year. */
export function quarterMonths(taxYear: number, quarter: 1 | 2 | 3 | 4): string[] {
  const first = 4 + (quarter - 1) * 3
  return [0, 1, 2].map((i) => {
    const m = first + i
    return m > 12 ? `${taxYear + 1}-${String(m - 12).padStart(2, '0')}-01` : `${taxYear}-${String(m).padStart(2, '0')}-01`
  })
}

const badPeriod = () => new HrError(400, 'bad_period', 'tax year must be 2000 to 2100 and quarter 1 to 4')
const validYear = (y: number) => Number.isInteger(y) && y >= 2000 && y <= 2100

const incomeTax = (lines: unknown) => (lines as PayslipLine[]).find((l) => l.code === 'income_tax')?.appliedPaise ?? 0

/** A person's tax statement for a tax year: their own, or anybody's for the office. */
export async function taxStatementDocument(actor: Actor, staffId: string, taxYear: number): Promise<{ name: string; bytes: Uint8Array }> {
  const tenant = tenantOf(actor)
  if (!validYear(taxYear)) throw badPeriod()
  const found = await withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, staffId))
    if (!person || (!isHr(actor.role) && person.userId !== actor.id)) throw new HrError(404, 'no_such_staff', 'no such staff record')
    const slips = await tx
      .select()
      .from(payslips)
      .where(and(eq(payslips.staffId, staffId), gte(payslips.period, `${taxYear}-04-01`), lte(payslips.period, `${taxYear + 1}-03-01`)))
      .orderBy(asc(payslips.period))
    if (slips.length === 0) throw new HrError(404, 'no_such_statement', 'no payslips in that tax year')
    const [previous] = await tx
      .select()
      .from(taxPreviousEmployment)
      .where(and(eq(taxPreviousEmployment.staffId, staffId), eq(taxPreviousEmployment.taxYear, taxYear)))
    return { person, slips, previous }
  })
  const { person, slips, previous } = found
  const record = [...slips].reverse().map((s) => s.tax as TaxRecord | null).find((t) => t && t.taxYear === taxYear) ?? null
  const [inst] = await db.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, tenant))
  const months = slips.map((s) => ({ month: s.period.slice(0, 7), grossPaise: s.grossPaise, taxPaise: incomeTax(s.lines) }))
  const bytes = await taxStatementPdf({
    form: taxYear >= TAX_FORM.cutOverTaxYear ? TAX_FORM.from : TAX_FORM.before,
    taxYear,
    institutionName: inst?.name ?? 'Institution',
    name: person.name,
    employeeCode: person.employeeCode,
    pan: person.pan,
    months,
    grossPaise: months.reduce((t, m) => t + m.grossPaise, 0),
    taxPaise: months.reduce((t, m) => t + m.taxPaise, 0),
    record,
    previous: previous ? { incomePaise: previous.incomePaise, tdsPaise: previous.tdsPaise } : null,
  })
  return { name: `tax-statement-${person.employeeCode}-${taxYear}.pdf`, bytes }
}

/** The data the NSDL 24Q file needs, as a CSV the accountant can check by hand. */
export async function tdsQuarterFile(actor: Actor, taxYear: number, quarter: number): Promise<{ name: string; type: string; content: string }> {
  const tenant = requireAdmin(actor)
  if (!validYear(taxYear) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw badPeriod()
  const months = quarterMonths(taxYear, quarter as 1 | 2 | 3 | 4)
  const { slips, done } = await withTenant(tenant, async (tx) => ({
    slips: await tx
      .select({ slip: payslips, person: staff })
      .from(payslips)
      .innerJoin(staff, eq(staff.id, payslips.staffId))
      .where(inArray(payslips.period, months))
      .orderBy(asc(payslips.period), asc(staff.employeeCode)),
    done: await tx
      .select()
      .from(remittances)
      .where(and(eq(remittances.head, 'tds'), inArray(remittances.period, months), isNull(remittances.voidedAt)))
      .orderBy(asc(remittances.paidOn), asc(remittances.challanRef)),
  }))
  const out = ['Record,PAN,Name,Month,Gross,Tax deducted,BSR code,Challan serial,Deposited on,Amount deposited']
  let deducted = 0
  for (const { slip, person } of slips) {
    const tax = incomeTax(slip.lines)
    if (tax <= 0) continue
    deducted += tax
    out.push(['DEDUCTEE', person.pan ?? 'PANNOTAVBL', csvCell(person.name), slip.period.slice(0, 7), plainPaise(slip.grossPaise), plainPaise(tax), '', '', '', ''].join(','))
  }
  let deposited = 0
  for (const r of done) {
    deposited += r.amountPaise
    out.push(['CHALLAN', '', '', r.period.slice(0, 7), '', '', r.bsrCode ?? '', r.challanSerial ?? '', r.paidOn, plainPaise(r.amountPaise)].join(','))
  }
  out.push(['TOTAL', 'Deducted', '', '', '', plainPaise(deducted), '', '', '', ''].join(','))
  out.push(['TOTAL', 'Deposited', '', '', '', '', '', '', '', plainPaise(deposited)].join(','))
  out.push(['TOTAL', 'Difference', '', '', '', plainPaise(deducted - deposited), '', '', '', ''].join(','))
  return { name: `tds-24q-${taxYear}-Q${quarter}.csv`, type: 'text/csv; charset=utf-8', content: out.join('\n') }
}
