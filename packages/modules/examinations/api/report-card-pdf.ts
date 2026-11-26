import { PDFDocument, rgb, type PDFPage } from 'pdf-lib'
import { pdfText, type PdfText, type Weight } from '@campusos/module-framework/pdf'
import type { IssuedReportCard } from './report-card'

/**
 * A school term report on A4 portrait, laid out by hand with pdf-lib like the
 * other documents: text in Noto Sans through `pdfText`, so an Indic name prints.
 * It carries the pupil's name, class, section, term and roll number and nothing
 * more about the pupil, and blank lines to sign.
 */

const A4 = { w: 595.28, h: 841.89 }
const M = 42
const FOOT = 28
const ink = rgb(0.1, 0.1, 0.12)
const faint = rgb(0.45, 0.45, 0.5)
const rule = rgb(0.8, 0.8, 0.83)
const WIDTH = A4.w - 2 * M

/** Split a word that is wider than the line into pieces by grapheme, so no script overflows. */
function pieces(t: PdfText, word: string, size: number, width: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)) {
    if (cur && t.width(cur + segment, size) > width) {
      out.push(cur)
      cur = segment
    } else cur += segment
  }
  return cur ? [...out, cur] : out
}

function wrap(t: PdfText, text: string, size: number, width: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word
    if (t.width(next, size) <= width) cur = next
    else {
      if (cur) lines.push(cur)
      const parts = t.width(word, size) > width ? pieces(t, word, size, width) : [word]
      lines.push(...parts.slice(0, -1))
      cur = parts.at(-1) ?? ''
    }
  }
  return cur ? [...lines, cur] : lines
}

/** The register line printed on an issued card (decision 1192). */
const attendanceLine = (a: IssuedReportCard['attendance']) =>
  a.state === 'unavailable' ? 'Daily attendance: Unavailable' : a.held > 0 ? `Daily attendance: ${a.present} present out of ${a.held} recorded days` : 'Daily attendance: No register entries'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** The calendar date in India (UTC+5:30, no daylight saving) of an instant. */
const istDate = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000)
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`
}

export async function reportCardPdf(r: IssuedReportCard): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle('School term report')
  doc.setProducer('CampusOS')
  // The time the school issued it, not the time it was printed again.
  const issued = new Date(r.issuedAt)
  doc.setCreationDate(issued)
  doc.setModificationDate(issued)
  const t = await pdfText(doc, JSON.stringify(r))
  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0
  const draw = (s: string, x: number, size: number, weight: Weight = 'regular', color = ink) => t.draw(page, s, { x, y, size, weight, color })

  const startPage = () => {
    page = doc.addPage([A4.w, A4.h])
    pages.push(page)
    y = A4.h - M
    if (pages.length > 1) {
      draw(`${r.institution || 'Institution'}  ·  School term report  ·  ${r.name}`, M, 8, 'regular', faint)
      y -= 20
    }
  }
  /** Room for `h` more points above the footer, or a new page. */
  const need = (h: number) => {
    if (y - h < M + FOOT) startPage()
  }
  const para = (s: string, o: { size?: number; weight?: Weight; color?: typeof ink; x?: number; keep?: number } = {}) => {
    const size = o.size ?? 10
    const x = o.x ?? M
    const lines = wrap(t, s, size, WIDTH - (x - M))
    need(lines.length * (size + 4) + (o.keep ?? 0))
    for (const l of lines) {
      draw(l, x, size, o.weight, o.color)
      y -= size + 4
    }
  }
  const gap = (n: number) => {
    y -= n
  }
  const hr = () => {
    need(8)
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: A4.w - M, y: y + 4 }, thickness: 0.5, color: rule })
    gap(6)
  }

  startPage()
  para(r.institution || 'Institution', { size: 16, weight: 'bold' })
  para('School term report', { size: 13, weight: 'bold' })
  gap(4)
  para(`${r.term.name} (${r.term.code})`, { color: faint })
  para(`Class ${r.classNumber} · Section ${r.sectionLabel}`)
  para(r.name, { size: 12, weight: 'bold' })
  para([r.rollNo ? `Roll number ${r.rollNo}` : null, r.templateName].filter(Boolean).join('   '), { color: faint })
  para(`Issue version ${r.version}  ·  Issued on ${istDate(issued)}`, { color: faint })
  para(attendanceLine(r.attendance), { color: faint })
  gap(6)
  hr()

  const grade = (v: string | null) => v ?? 'Pending'
  para('Scholastic', { weight: 'bold', size: 11, keep: 14 })
  if (r.mode === 'marks') {
    for (const s of r.subjects) {
      gap(4)
      // The heading never sits alone at the foot of a page: it keeps one line with it.
      para(`${s.courseCode}  ${s.title}`, { weight: 'bold', keep: 14 })
      if (s.notAssessed) {
        para('Not assessed', { x: M + 12 })
        continue
      }
      for (const c of s.components) para(`${c.label}: ${c.absent ? 'Absent' : c.value === null ? 'Pending' : c.value.toFixed(2)} / ${c.max}`, { x: M + 12 })
      para(`Total: ${s.total === null ? 'Pending' : `${s.total.toFixed(2)} / 100`}`, { x: M + 12, weight: 'bold' })
      para(`Grade: ${grade(s.grade)}`, { x: M + 12, weight: 'bold' })
    }
  } else {
    for (const a of r.areas.filter((x) => x.group === 'scholastic')) para(`${a.label}: ${grade(a.grade)}`, { x: M + 12 })
  }

  const co = r.areas.filter((a) => a.group === 'co_scholastic')
  if (co.length) {
    gap(8)
    para('Co-scholastic', { weight: 'bold', size: 11, keep: 14 })
    for (const a of co) para(`${a.label}: ${grade(a.grade)}`, { x: M + 12 })
  }
  if (r.remark) {
    gap(8)
    para('Class teacher’s remark', { weight: 'bold', size: 11, keep: 14 })
    para(r.remark, { x: M + 12 })
  }
  if (r.legend.length) {
    gap(8)
    para('Grades by marks', { weight: 'bold', size: 11, keep: 14 })
    para(r.legend.map((b) => `${b.grade} from ${b.floor}`).join('   '), { x: M + 12, color: faint })
  }

  // Blank lines to sign, together on one page.
  gap(30)
  need(40)
  page.drawLine({ start: { x: M, y }, end: { x: M + 160, y }, thickness: 0.5, color: ink })
  page.drawLine({ start: { x: A4.w - M - 160, y }, end: { x: A4.w - M, y }, thickness: 0.5, color: ink })
  y -= 12
  draw('Class teacher', M, 9, 'regular', faint)
  draw('Principal', A4.w - M - 160, 9, 'regular', faint)

  pages.forEach((p, i) => {
    page = p
    y = M - 4
    draw(`${i + 1} / ${pages.length}`, A4.w - M - 30, 8, 'regular', faint)
  })
  return doc.save()
}
