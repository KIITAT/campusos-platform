/**
 * Statutory and bank files (P1-06c): pure text from rows the caller already
 * ordered by employee code. The layouts are the planner's reading of the EPFO
 * ECR 2.0 and ESIC templates (plans/P1-06c.md D6 to D8); the first real upload
 * confirms them.
 */
import { plainPaise } from '@campusos/money'
import { HrError } from './guards'

export interface FileRow { employeeCode: string; name: string }
export interface EcrRow extends FileRow {
  uan: string | null; grossPaise: number; epfWagesPaise: number; epsWagesPaise: number; edliWagesPaise: number
  epfPaise: number; epsPaise: number; diffPaise: number; ncpDays: number
}
export interface EsiRow extends FileRow { esiNumber: string | null; days: number; wagesPaise: number; leftOn: string | null; monthEnd: string }
export interface BankRow extends FileRow { account: string | null; ifsc: string | null; netPaise: number }

const rupees = (p: number) => String(Math.round(p / 100))

/** A cell safe to open in a spreadsheet: formulas are defused, separators quoted. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[,"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** Upper case A-Z and single spaces only, as the ECR accepts. */
export function ecrName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z ]/g, '').replace(/ +/g, ' ').trim()
}

export function incompleteDetails(label: string, codes: string[]): HrError {
  const shown = codes.slice(0, 20).join(', ')
  const more = codes.length > 20 ? ` and ${codes.length - 20} more` : ''
  return new HrError(409, 'incomplete_details', `${label} missing for: ${shown}${more}`)
}

const refuseMissing = (label: string, rows: FileRow[], missing: (r: never) => boolean) => {
  const codes = rows.filter((r) => missing(r as never)).map((r) => r.employeeCode)
  if (codes.length > 0) throw incompleteDetails(label, codes)
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

export function ecrFile(rows: EcrRow[]): string {
  refuseMissing('UAN', rows, (r: EcrRow) => !r.uan)
  refuseMissing('Name usable in ECR', rows, (r: EcrRow) => ecrName(r.name) === '')
  return rows
    .map((r) =>
      [r.uan, ecrName(r.name), rupees(r.grossPaise), rupees(r.epfWagesPaise), rupees(r.epsWagesPaise), rupees(r.edliWagesPaise),
        rupees(r.epfPaise), rupees(r.epsPaise), rupees(r.diffPaise), String(r.ncpDays), '0'].join('#~#'),
    )
    .join('\n')
}

export function esiFile(rows: EsiRow[]): string {
  refuseMissing('ESI number', rows, (r: EsiRow) => !r.esiNumber)
  const header =
    'IP Number,IP Name,No of Days for which wages paid/payable during the month,Total Monthly Wages,Reason Code for Zero workings days(numeric only; provide 0 for all other reasons),Last Working Day'
  const lines = rows.map((r) => {
    const left = r.leftOn !== null && r.leftOn <= r.monthEnd
    const reason = r.days > 0 ? '0' : left ? '2' : '1'
    return [r.esiNumber!, csvCell(r.name), String(r.days), rupees(r.wagesPaise), reason, reason === '2' ? dmy(r.leftOn!) : ''].join(',')
  })
  return [header, ...lines].join('\n')
}

export function bankAdviceFile(rows: BankRow[], period: string): string {
  refuseMissing('Bank account or IFSC', rows, (r: BankRow) => !r.account || !r.ifsc)
  const header = 'Employee code,Beneficiary name,Account number,IFSC,Amount,Narration'
  const lines = rows.map((r) =>
    [csvCell(r.employeeCode), csvCell(r.name), r.account!, r.ifsc!, plainPaise(r.netPaise), `Salary ${period}`].join(','),
  )
  return [header, ...lines].join('\n')
}
