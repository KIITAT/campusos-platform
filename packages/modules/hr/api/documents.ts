/**
 * Files built on demand from stored payslips (P1-06c): nothing is kept, a
 * payslip is immutable so the same month always gives the same file.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { db, institutions, withTenant } from '@campusos/db'
import { HrError, isHr, requireAdmin, tenantOf, type Actor } from './guards'
import { payslipPdf } from './payslip-pdf'
import { bankAdviceFile, ecrFile, esiFile, type BankRow, type EcrRow, type EsiRow } from './files'
import type { PayslipLine } from './payroll'
import type { PayslipStatutory } from './statutory'
import { STATUTORY } from './statutory'
import { payslipReissues, payslips, staff } from '../schema'

export type FileKind = 'ecr' | 'esi' | 'bank-advice'

/** `YYYY-MM` or `YYYY-MM-01` to `YYYY-MM-01`. */
export function monthOf(raw: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])(-01)?$/.test(raw)) throw new HrError(400, 'bad_period', 'month must be YYYY-MM')
  return `${raw.slice(0, 7)}-01`
}

const daysIn = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()
const monthEnd = (period: string) => `${period.slice(0, 7)}-${String(daysIn(period)).padStart(2, '0')}`

const LABEL: Record<FileKind, string> = { ecr: 'ECR', esi: 'ESI', 'bank-advice': 'bank advice' }

export async function statutoryFile(actor: Actor, kind: FileKind, rawPeriod: string): Promise<{ name: string; type: string; content: string }> {
  const tenant = requireAdmin(actor)
  const period = monthOf(rawPeriod)
  const rows = await withTenant(tenant, (tx) =>
    tx
      .select({ slip: payslips, person: staff })
      .from(payslips)
      .innerJoin(staff, eq(staff.id, payslips.staffId))
      .where(and(eq(payslips.period, period)))
      .orderBy(asc(staff.employeeCode)),
  )
  const ym = period.slice(0, 7)
  const statOf = (s: typeof payslips.$inferSelect) => s.statutory as PayslipStatutory | null

  if (kind === 'ecr') {
    const list: EcrRow[] = rows
      .filter((r) => (statOf(r.slip)?.pfWagesPaise ?? 0) > 0)
      .map(({ slip, person }) => {
        const st = statOf(slip)!
        const pf = (slip.lines as PayslipLine[]).find((l) => l.code === 'pf_employee')
        return {
          employeeCode: person.employeeCode,
          name: person.name,
          uan: person.uan,
          grossPaise: slip.grossPaise,
          epfWagesPaise: st.epfWagesPaise ?? Math.min(st.pfWagesPaise, STATUTORY.pfCeilingPaise),
          epsWagesPaise: st.epsWagesPaise,
          edliWagesPaise: st.edliWagesPaise,
          epfPaise: pf?.appliedPaise ?? 0,
          epsPaise: st.employer.epsPaise,
          diffPaise: st.employer.epfPaise,
          ncpDays: st.ncpDays,
        }
      })
    if (list.length === 0) throw new HrError(409, 'nothing_to_file', `no ${LABEL[kind]} rows for this month`)
    return { name: `ecr-${ym}.txt`, type: 'text/plain; charset=utf-8', content: ecrFile(list) }
  }

  if (kind === 'esi') {
    const end = monthEnd(period)
    const list: EsiRow[] = rows
      .filter((r) => statOf(r.slip)?.esiCovered === true)
      .map(({ slip, person }) => {
        const st = statOf(slip)!
        return {
          employeeCode: person.employeeCode,
          name: person.name,
          esiNumber: person.esiNumber,
          days: daysIn(period) - st.ncpDays,
          wagesPaise: st.esiWagesPaise,
          leftOn: person.leftOn,
          monthEnd: end,
        }
      })
    if (list.length === 0) throw new HrError(409, 'nothing_to_file', `no ${LABEL[kind]} rows for this month`)
    return { name: `esi-${ym}.csv`, type: 'text/csv; charset=utf-8', content: esiFile(list) }
  }

  const list: BankRow[] = rows
    .filter((r) => !r.slip.withheld && r.slip.netPaise > 0)
    .map(({ slip, person }) => ({
      employeeCode: person.employeeCode,
      name: person.name,
      account: person.bankAccount,
      ifsc: person.bankIfsc,
      netPaise: slip.netPaise,
    }))
  if (list.length === 0) throw new HrError(409, 'nothing_to_file', `no ${LABEL[kind]} rows for this month`)
  return { name: `salary-advice-${ym}.csv`, type: 'text/csv; charset=utf-8', content: bankAdviceFile(list, ym) }
}

/** A payslip as a PDF: the person's own, or anyone's for the office. Anything else is 404, never 403. */
export async function payslipDocument(actor: Actor, payslipId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const tenant = tenantOf(actor)
  const found = await withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select({ slip: payslips, person: staff })
      .from(payslips)
      .innerJoin(staff, eq(staff.id, payslips.staffId))
      .where(eq(payslips.id, payslipId))
    if (!row || (!isHr(actor.role) && row.person.userId !== actor.id)) return null
    const [again] = await tx
      .select()
      .from(payslipReissues)
      .where(and(eq(payslipReissues.staffId, row.slip.staffId), eq(payslipReissues.period, row.slip.period)))
      .orderBy(desc(payslipReissues.reissuedAt))
      .limit(1)
    return { ...row, again }
  })
  if (!found) throw new HrError(404, 'no_such_payslip', 'no such payslip')
  const { slip, person, again } = found
  // institutions carries no RLS policy, so this reads without a tenant transaction.
  const [inst] = await db.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, tenant))
  const generatedAt = (again?.snapshot as { generatedAt?: string } | undefined)?.generatedAt
  const bytes = await payslipPdf({
    institutionName: inst?.name ?? 'Institution',
    period: slip.period,
    employeeCode: person.employeeCode,
    name: person.name,
    designation: person.designation,
    department: person.department,
    joinedOn: person.joinedOn,
    pan: person.pan,
    uan: person.uan,
    esiNumber: person.esiNumber,
    bankAccount: person.bankAccount,
    bankIfsc: person.bankIfsc,
    lines: slip.lines as PayslipLine[],
    grossPaise: slip.grossPaise,
    deductionsPaise: slip.deductionsPaise,
    netPaise: slip.netPaise,
    unpaidLeaveDays: slip.unpaidLeaveDays,
    lossOfPayPaise: slip.lossOfPayPaise,
    employer: (slip.statutory as PayslipStatutory | null)?.employer ?? null,
    reissue: again
      ? { on: again.reissuedAt.toISOString().slice(0, 10), originalGeneratedOn: (generatedAt ?? '').slice(0, 10), reason: again.reason }
      : null,
  })
  return { name: `payslip-${person.employeeCode}-${slip.period.slice(0, 7)}.pdf`, bytes }
}
