import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { plainPaise } from '@campusos/money'
import type { DemandLetterView } from './transfers'

/**
 * A demand letter: on the institution's letterhead, numbered and dated,
 * addressed to the bank or body that asked for it, with the term's fees, what
 * was taken off, and what is due, in figures and words. Standard fonts, so the
 * rupee sign is written "Rs".
 */

const A4 = { w: 595.28, h: 841.89 }
const M = 56
const ink = rgb(0.1, 0.1, 0.12)
const faint = rgb(0.45, 0.45, 0.5)
const rule = rgb(0.8, 0.8, 0.83)
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '?')
const rs = (p: number) => `Rs ${plainPaise(p)}`

export async function demandLetterPdf(v: DemandLetterView): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Demand letter ${v.number}`)
  doc.setProducer('CampusOS')
  doc.setCreationDate(new Date())
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page: PDFPage = doc.addPage([A4.w, A4.h])
  let y = A4.h - M

  const text = (s: string, x: number, size = 10, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color })
  const right = (s: string, xRight: number, size = 10, f: PDFFont = font) =>
    page.drawText(safe(s), { x: xRight - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color: ink })
  const line = () => page.drawLine({ start: { x: M, y: y + 4 }, end: { x: A4.w - M, y: y + 4 }, thickness: 0.5, color: rule })
  const para = (s: string, size = 10, color = ink) => {
    const width = A4.w - 2 * M
    let cur = ''
    for (const word of safe(s).split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > width) {
        text(cur, M, size, font, color)
        y -= size + 5
        cur = word
      } else cur = next
    }
    if (cur) {
      text(cur, M, size, font, color)
      y -= size + 5
    }
  }

  const c = v.content
  text(v.institution || 'Institution', M, 16, bold)
  y -= 16
  text('Accounts Office', M, 9, font, faint)
  y -= 6
  line()
  y -= 18
  text(`No. ${v.number}`, M, 10, bold)
  right(`Date: ${v.issuedAt.toISOString().slice(0, 10)}`, A4.w - M)
  y -= 26
  text('To', M)
  y -= 14
  for (const part of v.addressee.split(/,\s*/)) {
    text(part, M)
    y -= 14
  }
  y -= 10
  text(`Subject: Fees payable for ${c.term.name} (${c.term.code}) - ${v.purpose}`, M, 10, bold)
  y -= 22
  para(v.opening)
  y -= 6

  const who: [string, string | null][] = [
    ['Name', c.student.name],
    ['Roll number', c.student.rollNo],
    ['Registration number', c.student.registrationNo],
    ['Programme', c.student.programme],
    ['Term', `${c.term.name}, ${c.term.startsOn} to ${c.term.endsOn}`],
  ]
  for (const [k, val] of who) {
    text(k, M, 9, font, faint)
    text(val ?? '-', M + 130, 10)
    y -= 15
  }
  y -= 10

  text('Particulars', M, 8, bold, faint)
  right('Amount', A4.w - M, 8, bold)
  y -= 6
  line()
  y -= 12
  for (const l of c.lines) {
    text(l.label.slice(0, 70), M, 10)
    right(rs(l.amountPaise), A4.w - M)
    y -= 15
  }
  for (const dd of c.deductions) {
    text(`Less: ${dd.label}`.slice(0, 70), M, 10, font, faint)
    right(`- ${rs(dd.amountPaise)}`, A4.w - M)
    y -= 15
  }
  y -= 2
  line()
  y -= 14
  const total = (k: string, p: number, strong = false) => {
    text(k, M, 10, strong ? bold : font)
    right(rs(p), A4.w - M, 10, strong ? bold : font)
    y -= 15
  }
  total('Payable for the term', c.payablePaise, true)
  if (c.paidPaise > 0) total('Already paid', c.paidPaise)
  total('Balance due', c.balancePaise, true)
  y -= 4
  para(`In words: ${v.payableWords}.`, 9, faint)
  y -= 8

  if (c.account) {
    text('Pay to', M, 10, bold)
    y -= 15
    const acct: [string, string][] = [
      ['Account name', c.account.accountName],
      ['Bank and branch', `${c.account.bankName}, ${c.account.branch}`],
      ['Account number', c.account.accountNumber],
      ['IFSC', c.account.ifsc],
    ]
    for (const [k, val] of acct) {
      text(k, M, 9, font, faint)
      text(val, M + 130, 10)
      y -= 15
    }
    y -= 8
  }
  para(v.closing, 9, faint)
  y -= 40
  text(v.signatory.name, A4.w - M - 180, 10, bold)
  y -= 14
  text(v.signatory.title, A4.w - M - 180, 9, font, faint)
  y -= 14
  text(v.institution, A4.w - M - 180, 9, font, faint)

  return doc.save()
}
