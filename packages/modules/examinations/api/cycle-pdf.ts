import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { AdmitCard, GradeReport } from './cycle'

/**
 * The admit card and the semester grade report, laid out by hand with pdf-lib
 * like the transcript: no browser to install, standard fonts only.
 */

const A4 = { w: 595.28, h: 841.89 }
const M = 48
const ink = rgb(0.1, 0.1, 0.12)
const faint = rgb(0.45, 0.45, 0.5)
const rule = rgb(0.8, 0.8, 0.83)

/** WinAnsi cannot encode everything; folding beats refusing to draw. */
const safe = (s: string) => s.replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '?')

class Sheet {
  page: PDFPage
  y = A4.h - M
  constructor(
    private doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.page = doc.addPage([A4.w, A4.h])
  }
  text(s: string, x: number, size = 10, f = this.font, color = ink) {
    this.page.drawText(safe(s), { x, y: this.y, size, font: f, color })
  }
  line() {
    this.page.drawLine({ start: { x: M, y: this.y + 4 }, end: { x: A4.w - M, y: this.y + 4 }, thickness: 0.5, color: rule })
  }
  down(n: number) {
    this.y -= n
    if (this.y < M + 40) {
      this.page = this.doc.addPage([A4.w, A4.h])
      this.y = A4.h - M
    }
  }
  /** Wrap a paragraph to the page width. */
  para(s: string, size = 9, color = faint) {
    const width = A4.w - 2 * M
    let lineText = ''
    for (const word of safe(s).split(/\s+/)) {
      const next = lineText ? `${lineText} ${word}` : word
      if (this.font.widthOfTextAtSize(next, size) > width) {
        this.text(lineText, M, size, this.font, color)
        this.down(size + 4)
        lineText = word
      } else lineText = next
    }
    if (lineText) {
      this.text(lineText, M, size, this.font, color)
      this.down(size + 4)
    }
  }
}

async function start(title: string) {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setProducer('CampusOS')
  doc.setCreationDate(new Date())
  const s = new Sheet(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold))
  return { doc, s }
}

export async function admitCardPdf(a: AdmitCard): Promise<Uint8Array> {
  const { doc, s } = await start(`Admit card ${a.ticketNo}`)
  s.text(a.institution || 'Institution', M, 16, s.bold)
  s.down(18)
  s.text(`Admit card - ${a.term.name} (${a.term.code})`, M, 11, s.font, faint)
  s.down(26)

  // A box for the photograph and the signatures, which the hall checks against the student.
  const box = { x: A4.w - M - 100, y: s.y - 110, w: 100, h: 120 }
  s.page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: rule, borderWidth: 1 })
  s.page.drawText('Affix photograph', { x: box.x + 12, y: box.y + box.h / 2, size: 8, font: s.font, color: faint })

  const row = (k: string, v: string | null | undefined) => {
    s.text(k, M, 9, s.font, faint)
    s.text(v ?? '-', M + 110, 10, k === 'Hall ticket' ? s.bold : s.font)
    s.down(16)
  }
  row('Hall ticket', a.ticketNo)
  row('Name', a.student.name)
  row('Roll number', a.student.rollNo)
  row('Registration number', a.student.registrationNo)
  row('Programme', a.student.programme)
  row('Enrolled', `${a.enrolledOn} (${a.timeZone})`)
  s.down(30)

  const cols = { code: M, title: M + 70, exam: M + 270, when: M + 350, room: M + 450 }
  s.text('Paper', cols.code, 8, s.bold, faint)
  s.text('Title', cols.title, 8, s.bold, faint)
  s.text('Exam', cols.exam, 8, s.bold, faint)
  s.text('Date and time', cols.when, 8, s.bold, faint)
  s.text('Room', cols.room, 8, s.bold, faint)
  s.down(6)
  s.line()
  s.down(12)
  for (const p of a.papers) {
    s.text(p.code, cols.code, 9)
    s.text(p.title.slice(0, 38), cols.title, 9)
    s.text((p.exam ?? 'Final').slice(0, 14), cols.exam, 9)
    s.text(p.when ?? 'to be announced', cols.when, 9, p.when ? s.font : s.font, p.when ? ink : faint)
    s.text(p.room ?? '-', cols.room, 9)
    s.down(15)
  }
  s.down(10)
  s.line()
  s.down(16)
  if (a.instructions) {
    s.text('Instructions', M, 10, s.bold)
    s.down(14)
    for (const para of a.instructions.split(/\r?\n/).filter(Boolean)) s.para(para)
    s.down(8)
  }
  s.para('Bring this card and your identity card to every paper. A paper without a date is announced on the notice board and here when it is set.')
  s.down(40)
  s.text('Signature of the student', M, 8, s.font, faint)
  s.text('Controller of examinations', A4.w - M - 120, 8, s.font, faint)
  return doc.save()
}

export async function gradeReportPdf(g: GradeReport): Promise<Uint8Array> {
  const { doc, s } = await start(`Grade report ${g.term.code} ${g.student.name}`)
  s.text(g.institution || 'Institution', M, 16, s.bold)
  s.down(18)
  s.text(`Semester grade report - ${g.term.name} (${g.term.code})`, M, 11, s.font, faint)
  s.down(26)
  s.text(g.student.name, M, 12, s.bold)
  s.down(15)
  const who = [
    g.student.rollNo ? `Roll ${g.student.rollNo}` : null,
    g.student.registrationNo ? `Registration ${g.student.registrationNo}` : null,
    g.student.programme,
  ].filter(Boolean)
  s.text(who.join('   '), M, 9, s.font, faint)
  s.down(26)

  const cols = { code: M, title: M + 78, credits: 390, grade: 450, pts: 510 }
  s.text('Course', cols.code, 8, s.bold, faint)
  s.text('Title', cols.title, 8, s.bold, faint)
  s.text('Credits', cols.credits, 8, s.bold, faint)
  s.text('Grade', cols.grade, 8, s.bold, faint)
  s.text('Points', cols.pts, 8, s.bold, faint)
  s.down(6)
  s.line()
  s.down(12)
  for (const c of g.courses) {
    s.text(c.code, cols.code, 9)
    s.text(c.title.slice(0, 50), cols.title, 9)
    s.text(String(c.credits), cols.credits, 9)
    s.text(c.grade ?? '-', cols.grade, 9, c.passed ? s.font : s.bold)
    s.text(c.points === null ? '-' : c.points.toFixed(2), cols.pts, 9)
    s.down(15)
  }
  s.down(6)
  s.line()
  s.down(16)
  const fig = (k: string, v: string, x: number) => {
    s.text(k, x, 8, s.font, faint)
    s.page.drawText(safe(v), { x, y: s.y - 14, size: 13, font: s.bold, color: ink })
  }
  fig('SGPA', g.sgpa === null ? '-' : g.sgpa.toFixed(2), M)
  fig('CGPA', g.cgpa === null ? '-' : g.cgpa.toFixed(2), M + 110)
  fig('Credits this term', String(g.creditsEarned), M + 220)
  fig('Credits in all', String(g.creditsEarnedTotal), M + 340)
  s.down(46)
  s.para(
    'From the official record: finalised courses only. A course in bold was not passed. The cumulative average counts every finalised term up to and including this one.',
  )
  return doc.save()
}
