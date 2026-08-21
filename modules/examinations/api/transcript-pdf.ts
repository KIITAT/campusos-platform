import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Transcript } from './schemas'

/**
 * Transcript PDF.
 *
 * pdf-lib rather than a headless browser: it is pure JavaScript with no
 * Chromium to install, so it runs in a serverless function and in CI without
 * either becoming a special case. The cost is laying out by hand, which for a
 * table of grades is a fair trade.
 *
 * Standard fonts only, so the output embeds no font data and stays small. That
 * limits us to WinAnsi, which is fine for the Latin course codes and names this
 * prints; a transcript needing Devanagari will need an embedded font, and that
 * is a deliberate later decision rather than an accident.
 */

const A4 = { w: 595.28, h: 841.89 }
const M = 48 // margin

/** WinAnsi cannot encode everything; refusing to draw is worse than folding. */
const safe = (s: string) => s.replace(/[^\x20-\x7E]/g, '?')

export async function transcriptPdf(t: Transcript): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Transcript — ${t.studentName ?? t.studentEmail ?? 'student'}`)
  doc.setProducer('CampusOS')
  doc.setCreationDate(new Date())

  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let page = doc.addPage([A4.w, A4.h])
  let y = A4.h - M

  const ink = rgb(0.1, 0.1, 0.12)
  const faint = rgb(0.45, 0.45, 0.5)
  const rule = rgb(0.8, 0.8, 0.83)

  const text = (
    s: string,
    x: number,
    size = 10,
    f = font,
    color = ink,
  ) => page.drawText(safe(s), { x, y, size, font: f, color })

  const line = () => {
    page.drawLine({
      start: { x: M, y: y + 4 },
      end: { x: A4.w - M, y: y + 4 },
      thickness: 0.5,
      color: rule,
    })
  }

  /** Starts a new page when the next block would not fit. */
  const need = (space: number) => {
    if (y - space < M + 40) {
      page = doc.addPage([A4.w, A4.h])
      y = A4.h - M
      return true
    }
    return false
  }

  // --- header
  text(t.institutionName || 'Institution', M, 16, bold)
  y -= 22
  text('Academic Transcript', M, 11, font, faint)
  y -= 28

  text(t.studentName ?? '—', M, 12, bold)
  y -= 15
  if (t.studentEmail) {
    text(t.studentEmail, M, 9, font, faint)
    y -= 12
  }
  if (t.programCode) {
    text(`Programme ${t.programCode}`, M, 9, font, faint)
    y -= 12
  }
  text(`Grading scheme: ${t.schemeName} (${t.schemeKind})`, M, 9, font, faint)
  y -= 22

  if (t.provisional) {
    // Said plainly and near the top, because a provisional transcript mistaken
    // for a final one is exactly the dispute this module is built to avoid.
    page.drawRectangle({
      x: M - 6,
      y: y - 6,
      width: A4.w - 2 * M + 12,
      height: 22,
      color: rgb(1, 0.96, 0.85),
    })
    text('PROVISIONAL — some results are not yet published', M, 10, bold, rgb(0.5, 0.33, 0))
    y -= 32
  }

  // --- columns
  const cols = { code: M, title: M + 78, credits: 380, pct: 432, grade: 490, pts: 540 }

  const header = () => {
    text('Course', cols.code, 8, bold, faint)
    text('Title', cols.title, 8, bold, faint)
    text('Cr', cols.credits, 8, bold, faint)
    text('%', cols.pct, 8, bold, faint)
    text('Grade', cols.grade, 8, bold, faint)
    text('Pts', cols.pts, 8, bold, faint)
    y -= 6
    line()
    y -= 12
  }

  for (const term of t.terms) {
    need(90)
    text(`${term.termCode} — ${term.termName}`, M, 11, bold)
    y -= 18
    header()

    for (const g of term.grades) {
      if (need(20)) header()
      text(g.courseCode, cols.code, 9)
      text(g.courseTitle.slice(0, 46), cols.title, 9)
      text(String(g.credits), cols.credits, 9)
      text(g.percent.toFixed(2), cols.pct, 9)
      text(g.label ?? '—', cols.grade, 9, g.passed ? font : bold)
      text(g.points === null ? '—' : g.points.toFixed(2), cols.pts, 9)
      if (!g.complete) {
        text('(incomplete)', cols.pts + 26, 7, font, faint)
      }
      y -= 14
    }

    y -= 2
    line()
    y -= 14
    text(
      `Credits ${term.credits}    ${t.schemeKind === 'percentage' ? '' : `GPA ${term.gpa === null ? '—' : term.gpa.toFixed(2)}`}`,
      cols.credits - 60,
      9,
      bold,
    )
    y -= 26
  }

  // --- footer totals
  need(70)
  line()
  y -= 18
  text('Cumulative', M, 11, bold)
  text(`Credits ${t.totalCredits}`, cols.credits - 60, 10, bold)
  if (t.schemeKind !== 'percentage') {
    text(
      `CGPA ${t.cumulativeGpa === null ? '—' : t.cumulativeGpa.toFixed(2)}`,
      cols.pct,
      10,
      bold,
    )
  }
  y -= 30

  text(
    `Generated ${new Date().toISOString().slice(0, 10)} by CampusOS. ` +
      'Grade changes after publication are recorded in the audit log.',
    M,
    7,
    font,
    faint,
  )

  return doc.save()
}
