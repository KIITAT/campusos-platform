import { eq } from 'drizzle-orm'
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib'
import { pdfText, type PdfText } from '@campusos/module-framework/pdf'
import { institutions, withTenant } from '@campusos/db'
import { terms } from '@campusos/module-academic/schema'
import { termWithin } from './classes'
import { TimetableError, requireReader, requireTeacherOrOffice, type Actor, type Tx } from './core'
import { periodsFor } from './setup'
import { gridOf, index, lensOf, liveMeetings, runMeetings, runWithin, type Grid, type Lens, type Meeting } from './views'

/**
 * Timetables printed: one page per cohort, teacher or room, A4 landscape,
 * periods down the side and days across -- the sheet pinned outside a
 * classroom and handed to a teacher. Text in Noto Sans, so every name prints.
 */

const PAGE = { w: 841.89, h: 595.28 }
const M = 32
const ink = rgb(0.1, 0.1, 0.12)
const faint = rgb(0.45, 0.45, 0.5)
const rule = rgb(0.75, 0.75, 0.8)
const shade = rgb(0.94, 0.95, 0.97)

/** Words of a cell broken into lines that fit a width. */
function wrap(text: string, t: PdfText, size: number, width: number): string[] {
  const out: string[] = []
  for (const part of text.split(' / ')) {
    let line = ''
    for (const word of part.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (t.width(next, size) <= width) line = next
      else {
        if (line) out.push(line)
        line = word
      }
    }
    if (line) out.push(line)
  }
  return out
}

function drawGrid(page: PDFPage, grid: Grid, header: string, t: PdfText) {
  let y = PAGE.h - M
  t.draw(page, header, { x: M, y, size: 9, color: faint })
  y -= 20
  t.draw(page, grid.title, { x: M, y, size: 16, weight: 'bold', color: ink })
  y -= 14
  t.draw(page, grid.subtitle, { x: M, y, size: 9, color: faint })
  y -= 16

  const first = 72
  const cols = Math.max(1, grid.days.length)
  const colW = (PAGE.w - 2 * M - first) / cols
  const lineH = (size: number) => size + 2
  // Shrink the type until the week fits the page.
  let size = 8
  let heights: number[] = []
  for (; size >= 5; size -= 0.5) {
    heights = grid.rows.map((r) =>
      Math.max(2, ...grid.days.map((d) => wrap(r[`d${d.day}`] ?? '', t, size, colW - 6).length)) * lineH(size) + 6,
    )
    if (heights.reduce((a, b) => a + b, 0) + 18 <= y - M) break
  }

  // Header row.
  const top = y
  page.drawRectangle({ x: M, y: y - 16, width: PAGE.w - 2 * M, height: 16, color: shade })
  t.draw(page, 'Period', { x: M + 4, y: y - 11, size: 8, weight: 'bold', color: ink })
  grid.days.forEach((d, i) => t.draw(page, d.label, { x: M + first + i * colW + 4, y: y - 11, size: 8, weight: 'bold', color: ink }))
  y -= 16

  grid.rows.forEach((r, ri) => {
    const h = heights[ri]!
    page.drawLine({ start: { x: M, y }, end: { x: PAGE.w - M, y }, thickness: 0.5, color: rule })
    t.draw(page, r.period ? `P${r.period}` : '', { x: M + 4, y: y - 10, size: 8, weight: 'bold', color: ink })
    t.draw(page, r.time ?? '', { x: M + 4, y: y - 20, size: 7, color: faint })
    grid.days.forEach((d, i) => {
      const lines = wrap(r[`d${d.day}`] ?? '', t, size, colW - 6)
      lines.forEach((line, li) => {
        t.draw(page, line, { x: M + first + i * colW + 3, y: y - 4 - lineH(size) * (li + 1) + 2, size, weight: li === 0 ? 'bold' : 'regular', color: ink })
      })
    })
    y -= h
  })
  page.drawLine({ start: { x: M, y }, end: { x: PAGE.w - M, y }, thickness: 0.5, color: rule })
  // Column rules.
  for (let i = 0; i <= cols; i++) {
    const x = M + first + i * colW
    page.drawLine({ start: { x, y: top }, end: { x, y }, thickness: 0.5, color: rule })
  }
  page.drawLine({ start: { x: M, y: top }, end: { x: M, y }, thickness: 0.5, color: rule })
  if (grid.rows.length === 0) t.draw(page, 'Nothing timetabled.', { x: M, y: y - 20, size: 10, color: faint })
}

async function render(grids: Grid[], header: string) {
  const doc = await PDFDocument.create()
  doc.setTitle(grids.length === 1 ? grids[0]!.title : 'Timetables')
  doc.setCreator('CampusOS')
  const t = await pdfText(doc, JSON.stringify([grids, header]))
  for (const g of grids) drawGrid(doc.addPage([PAGE.w, PAGE.h]), g, header, t)
  if (grids.length === 0) {
    const page = doc.addPage([PAGE.w, PAGE.h])
    t.draw(page, 'Nothing to print.', { x: M, y: PAGE.h - M - 20, size: 12, color: faint })
  }
  return doc.save({ useObjectStreams: false })
}

type Which = { sectionId?: string; teacherId?: string; roomId?: string; all?: string }

async function grids(tx: Tx, meetings: Meeting[], termId: string, subtitle: string, q: Which): Promise<Grid[]> {
  const week = (await periodsFor(tx, termId)).rows
  const lens = lensOf(q)
  const names = index(meetings)
  if (lens) {
    const list = lens.by === 'section' ? names.sections : lens.by === 'teacher' ? names.teachers : names.rooms
    // Somebody with nothing timetabled gets an empty week, not an error.
    const title = list.find((x) => x.id === lens.id)?.name ?? 'Nothing timetabled'
    return [gridOf(lens.by === 'room' ? `Room ${title}` : title, subtitle, lens, meetings, week)]
  }
  const by = q.all === 'teachers' ? 'teacher' : q.all === 'rooms' ? 'room' : 'section'
  const list = by === 'section' ? names.sections : by === 'teacher' ? names.teachers : names.rooms
  return list.map((x) => {
    const l: Lens = { by, id: x.id }
    return gridOf(by === 'room' ? `Room ${x.name}` : x.name, subtitle, l, meetings, week)
  })
}

async function headerOf(tx: Tx, institutionId: string) {
  const [i] = await tx.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, institutionId))
  return i?.name ?? ''
}

const fileName = (q: Which, base: string) => `${base}-${q.all ?? (q.sectionId ? 'cohort' : q.teacherId ? 'teacher' : q.roomId ? 'room' : 'cohorts')}.pdf`

/** A draft printed, for checking on paper before it is applied. */
export async function runPdf(actor: Actor, q: Which & { runId: string }) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const run = await runWithin(tx, q.runId)
    const term = await termWithin(tx, run.termId)
    const meetings = await runMeetings(tx, run.id)
    const list = await grids(tx, meetings, run.termId, `${term.name} -- DRAFT of ${run.createdAt.toISOString().slice(0, 10)}, not yet applied`, q)
    return { bytes: await render(list, await headerOf(tx, tenant)), fileName: fileName(q, `timetable-draft-${term.code}`) }
  })
}

/** The live timetable printed: a cohort's, a teacher's, a room's, or every one of them. */
export async function livePdf(actor: Actor, q: Which & { termId?: string }) {
  const tenant = requireTeacherOrOffice(actor)
  if (actor.role === 'faculty') {
    q = { teacherId: actor.id, termId: q.termId }
  }
  return withTenant(tenant, async (tx) => {
    let termId = q.termId
    if (!termId) {
      const [t] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.isCurrent, true)).limit(1)
      if (!t) throw new TimetableError(404, 'no_current_term', 'no term is current: say which term')
      termId = t.id
    }
    const term = await termWithin(tx, termId)
    const meetings = await liveMeetings(tx, termId)
    const list = await grids(tx, meetings, termId, term.name, q)
    return { bytes: await render(list, await headerOf(tx, tenant)), fileName: fileName(q, `timetable-${term.code}`) }
  })
}

/** A teacher's own week, printed. */
export async function myPdf(actor: Actor) {
  return livePdf(actor, { teacherId: actor.id })
}
