import { PDFDocument, rgb, type PDFPage } from 'pdf-lib'
import { pdfText, type Weight } from '@campusos/module-framework/pdf'
import { plainPaise } from '@campusos/money'
import type { PayslipLine } from './payroll'
import type { PayslipStatutory } from './statutory'
import type { TaxRecord } from './tds'

export interface PayslipPdfData {
  institutionName: string
  period: string
  employeeCode: string
  name: string
  designation: string | null
  department: string | null
  joinedOn: string
  pan: string | null
  uan: string | null
  esiNumber: string | null
  bankAccount: string | null
  bankIfsc: string | null
  lines: PayslipLine[]
  grossPaise: number
  deductionsPaise: number
  netPaise: number
  unpaidLeaveDays: number
  lossOfPayPaise: number
  employer: PayslipStatutory['employer'] | null
  reissue: { on: string; originalGeneratedOn: string; reason: string } | null
}

const W = 595.28
const H = 841.89
const M = 40
const ROWS = 30

const ink = rgb(0.1, 0.1, 0.12)
const faint = rgb(0.45, 0.45, 0.5)
const rule = rgb(0.8, 0.8, 0.83)

/** 'XXXX' and the last four digits: the full number never goes on paper. */
const masked = (account: string) => `XXXX${account.slice(-4)}`

/**
 * A payslip, A4 portrait. Same toolchain as the fee receipt; amounts through
 * plainPaise so a document of record does not change shape with the locale.
 */
export async function payslipPdf(d: PayslipPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Payslip ${d.employeeCode} ${d.period.slice(0, 7)}`)
  doc.setProducer('CampusOS')
  const t = await pdfText(doc, JSON.stringify(d))

  let page: PDFPage = doc.addPage([W, H])
  let y = H - M
  const text = (s: string, x: number, size = 10, weight: Weight = 'regular', color = ink) =>
    t.draw(page, s, { x, y, size, weight, color })
  const right = (s: string, x: number, size = 10, weight: Weight = 'regular') => text(s, x - t.width(s, size, weight), size, weight)
  const line = () => page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: rule })
  const ym = d.period.slice(0, 7)

  const heading = () => {
    text(d.institutionName || 'Institution', M, 15, 'bold')
    y -= 18
    text('Payslip', M, 11, 'bold', faint)
    text(ym, M + 52, 11, 'regular', faint)
    y -= 24
    line()
    y -= 14
  }
  heading()

  const pair = (k: string, v: string | null, x: number) => {
    text(k, x, 8, 'regular', faint)
    text(v && v.length > 0 ? v : '-', x + 70, 9)
  }
  const person: [string, string | null, string, string | null][] = [
    ['Name', d.name, 'Employee code', d.employeeCode],
    ['Designation', d.designation, 'Department', d.department],
    ['PAN', d.pan, 'UAN', d.uan],
    ['ESI number', d.esiNumber, 'Joined on', d.joinedOn],
    ['Bank account', d.bankAccount ? masked(d.bankAccount) : null, 'IFSC', d.bankIfsc],
  ]
  for (const [k1, v1, k2, v2] of person) {
    pair(k1, v1, M)
    pair(k2, v2, W / 2 + 10)
    y -= 15
  }
  y -= 4
  line()
  y -= 14

  const earnings = d.lines.filter((l) => l.kind === 'earning')
  const deductions = d.lines.filter((l) => l.kind === 'deduction')
  const colR = W / 2 - 14
  const colR2 = W - M
  const mid = W / 2 + 10
  const total = Math.max(earnings.length, deductions.length, 1)
  for (let off = 0; off < total; off += ROWS) {
    if (off > 0) {
      page = doc.addPage([W, H])
      y = H - M
      heading()
    }
    text('Earnings', M, 9, 'bold')
    right('Amount', colR, 9, 'bold')
    text('Deductions', mid, 9, 'bold')
    right('Amount', colR2, 9, 'bold')
    y -= 15
    const rows = Math.min(ROWS, total - off)
    for (let i = 0; i < rows; i++) {
      const e = earnings[off + i]
      const x = deductions[off + i]
      if (e) {
        text(e.label, M, 9)
        right(plainPaise(e.appliedPaise), colR, 9)
      }
      if (x) {
        text(x.label, mid, 9)
        right(plainPaise(x.appliedPaise), colR2, 9)
      }
      y -= 14
    }
  }
  y -= 4
  line()
  y -= 14

  const total3 = (k: string, v: string, bold = false) => {
    text(k, M, 10, bold ? 'bold' : 'regular')
    right(v, M + 230, 10, bold ? 'bold' : 'regular')
    y -= 16
  }
  total3('Gross pay', plainPaise(d.grossPaise))
  total3('Total deductions', plainPaise(d.deductionsPaise))
  total3('Net pay', plainPaise(d.netPaise), true)
  if (d.unpaidLeaveDays > 0 || d.lossOfPayPaise > 0) {
    text(`Unpaid leave days: ${d.unpaidLeaveDays}`, M, 9, 'regular', faint)
    y -= 14
    text(`Loss of pay: ${plainPaise(d.lossOfPayPaise)}`, M, 9, 'regular', faint)
    y -= 14
  }

  if (d.employer) {
    y -= 8
    text('Employer contributions (not deducted from pay)', M, 10, 'bold')
    y -= 15
    const e = d.employer
    const rows: [string, number][] = [
      ['Pension scheme (EPS)', e.epsPaise],
      ['Provident fund (EPF)', e.epfPaise],
      ['Deposit-linked insurance (EDLI)', e.edliPaise],
      ['PF administration charge', e.pfAdminPaise],
      ['ESI', e.esiPaise],
    ]
    for (const [k, v] of rows) {
      text(k, M, 9)
      right(plainPaise(v), M + 230, 9)
      y -= 14
    }
  }

  y = Math.min(y, 120)
  y -= 10
  if (d.reissue) {
    text(`Reissued on ${d.reissue.on}. Replaces the payslip issued on ${d.reissue.originalGeneratedOn}. Reason: ${d.reissue.reason}`, M, 8, 'bold')
    y -= 14
  }
  text('Computer generated by CampusOS. No signature required.', M, 7, 'regular', faint)

  return doc.save()
}

export interface TaxStatementData {
  form: string
  taxYear: number
  institutionName: string
  name: string
  employeeCode: string
  pan: string | null
  months: { month: string; grossPaise: number; taxPaise: number }[]
  grossPaise: number
  taxPaise: number
  record: TaxRecord | null
  previous: { incomePaise: number; tdsPaise: number } | null
}

/** The annual tax statement: Part B of Form 16, or Form 130. A4, same toolchain as the payslip. */
export async function taxStatementPdf(d: TaxStatementData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${d.form} ${d.employeeCode} ${d.taxYear}`)
  doc.setProducer('CampusOS')
  const t = await pdfText(doc, JSON.stringify(d))
  let page: PDFPage = doc.addPage([W, H])
  let y = H - M
  const text = (s: string, x: number, size = 10, weight: Weight = 'regular', color = ink) => t.draw(page, s, { x, y, size, weight, color })
  const right = (s: string, x: number, size = 10, weight: Weight = 'regular') => text(s, x - t.width(s, size, weight), size, weight)
  const room = (need: number) => {
    if (y - need >= M + 30) return
    page = doc.addPage([W, H])
    y = H - M
  }

  text(d.institutionName || 'Institution', M, 15, 'bold')
  y -= 20
  text(d.form, M, 12, 'bold')
  y -= 15
  text(`Tax year ${d.taxYear}-${String((d.taxYear + 1) % 100).padStart(2, '0')}`, M, 9, 'regular', faint)
  y -= 22
  const pair = (k: string, v: string | null) => {
    text(k, M, 8, 'regular', faint)
    text(v && v.length > 0 ? v : '-', M + 90, 10)
    y -= 15
  }
  pair('Employee', d.name)
  pair('Employee code', d.employeeCode)
  pair('PAN', d.pan)
  y -= 8
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: rule })
  y -= 14

  text('Month', M, 9, 'bold')
  right('Gross pay', M + 260, 9, 'bold')
  right('Tax deducted', M + 400, 9, 'bold')
  y -= 15
  for (const m of d.months) {
    room(16)
    text(m.month, M, 9)
    right(plainPaise(m.grossPaise), M + 260, 9)
    right(plainPaise(m.taxPaise), M + 400, 9)
    y -= 14
  }
  room(40)
  text('Total', M, 10, 'bold')
  right(plainPaise(d.grossPaise), M + 260, 10, 'bold')
  right(plainPaise(d.taxPaise), M + 400, 10, 'bold')
  y -= 24

  if (d.record) {
    const r = d.record
    room(160)
    text('Tax computation (last payslip of the year)', M, 10, 'bold')
    y -= 15
    const row = (k: string, v: string) => {
      text(k, M, 9, 'regular', faint)
      text(v, M + 200, 9)
      y -= 14
    }
    row('Regime', r.regimeCode)
    row('Gross salary', plainPaise(r.grossPaise))
    row('HRA exemption', plainPaise(r.hraExemptPaise))
    row('Deductions', plainPaise(r.deductionsPaise))
    row('Taxable income', plainPaise(r.incomePaise))
    row('Annual tax', plainPaise(r.annualTaxPaise))
    row('One-off tax', plainPaise(r.oneOffTaxPaise))
    row('Tax deducted earlier', plainPaise(r.earlierTdsPaise))
    row('Tax deducted by previous employers', plainPaise(r.previousTdsPaise))
    y -= 8
  }
  if (d.previous) {
    room(50)
    text('Previous employment declared', M, 10, 'bold')
    y -= 15
    text('Income', M, 9, 'regular', faint)
    text(plainPaise(d.previous.incomePaise), M + 200, 9)
    y -= 14
    text('Tax deducted', M, 9, 'regular', faint)
    text(plainPaise(d.previous.tdsPaise), M + 200, 9)
    y -= 20
  }

  room(60)
  text('Part A (the TRACES certificate of tax deposited) is issued from TRACES and is not produced by CampusOS.', M, 8, 'regular', faint)
  y -= 12
  text('Figures are the institution’s records; not a filed return.', M, 8, 'regular', faint)
  y -= 12
  text('Computer generated by CampusOS. No signature required.', M, 7, 'regular', faint)
  return doc.save()
}
