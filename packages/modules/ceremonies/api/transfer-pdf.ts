import { sql } from 'drizzle-orm'
import * as z from 'zod'
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib'
import { withTenant } from '@campusos/db'
import { pdfText } from '@campusos/module-framework/pdf'
import type { TransferSnapshot } from '../transfer-schema'
import { CeremonyError, type Actor } from './operations'
import { formatSerial } from './transfer'

/**
 * The CBSE school transfer certificate as a document to print (P1-13d, decision 979).
 *
 * Portrait A4, Noto Sans through @campusos/module-framework/pdf. Only the saved
 * snapshot is drawn: a later change to the pupil's name or programme, or to the
 * dues, changes nothing here. Hand-signature lines and room for the seal are
 * left blank; no signature image is embedded.
 */

export const PAGE = { w: 595.28, h: 841.89, margin: 40, title: 17, text: 10, pitch: 15, signature: 95, labelWidth: 200 }

const dmy = (iso: string) => iso.split('-').reverse().join('/')
const my = (m: string) => m.split('-').reverse().join('/')
const NA = 'Not applicable'
const str = (v: unknown) => (typeof v === 'string' && v ? v : NA)

/** Label and value, in the order of Annexure I. */
export function fieldsOf(s: TransferSnapshot): [string, string][] {
  const repeat = ['No', 'Once', 'Twice'][Number(s.repeatCount)] ?? NA
  const promoted = s.promotionEligible === 'yes' ? `Yes, to class ${str(s.promotionClassFigures)} (${str(s.promotionClassWords)})` : s.promotionEligible === 'no' ? 'No' : NA
  return [
    ['1. Name of the pupil', s.pupilName],
    ["2. Mother's name", str(s.motherName)],
    ["3. Father's / Guardian's name", str(s.fatherOrGuardianName)],
    ['4. Nationality', str(s.nationality)],
    ['5. Category (SC / ST / OBC / Neither)', str(s.reservationCategory)],
    ['6. Date of first admission in the school, with class', `${dmy(String(s.firstAdmittedOn))}, ${str(s.firstClass)}`],
    ['7. Date of birth (in christian era), in figures and words', `${dmy(s.birthOn)} (${str(s.birthInWords)})`],
    ['8. Class in which the pupil last studied, in figures and words', `${str(s.lastClassFigures)} (${str(s.lastClassWords)}), ${s.lastProgramName}`],
    ['9. School / Board annual examination last taken, with result', str(s.lastExamResult)],
    ['10. Whether failed, if so once / twice in the same class', repeat],
    ['11. Subjects studied', Array.isArray(s.subjects) ? s.subjects.join(', ') : NA],
    ['12. Whether qualified for promotion to the higher class', promoted],
    ['13. Month up to which the pupil has paid school dues', typeof s.paidThroughMonth === 'string' && s.paidThroughMonth ? my(s.paidThroughMonth) : NA],
    ['14. Any fee concession availed of, with nature', str(s.feeConcession)],
    ['15. Total number of working days', String(s.workingDays)],
    ['16. Total number of working days present', String(s.presentDays)],
    ['17. Whether NCC Cadet / Boy Scout / Girl Guide, with details', str(s.activitiesUniformed)],
    ['18. Games played or extra-curricular activities, with achievements', str(s.activitiesOther)],
    ['19. General conduct', str(s.conduct)],
    ['20. Date of application for the certificate', dmy(String(s.appliedOn))],
    ['21. Date of leaving the school', dmy(s.endedOn)],
    ['22. Date of issue of the certificate', dmy(s.issuedOn)],
    ['23. Reason for leaving the school', str(s.leavingReason)],
    ['24. Any other remarks', str(s.remarks)],
  ]
}

/**
 * Break `text` into lines no wider than `width`, at spaces; a token wider than a
 * line is cut between grapheme clusters, never inside one.
 */
export function wrapLines(measure: (s: string) => number, text: string, width: number): string[] {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const lines: string[] = []
  let cur = ''
  const push = () => {
    if (cur) lines.push(cur)
    cur = ''
  }
  for (const word of text.split(' ')) {
    const joined = cur ? `${cur} ${word}` : word
    if (measure(joined) <= width) {
      cur = joined
      continue
    }
    push()
    if (measure(word) <= width) {
      cur = word
      continue
    }
    for (const { segment } of seg.segment(word)) {
      if (cur && measure(cur + segment) > width) push()
      cur += segment
    }
  }
  push()
  return lines.length ? lines : ['']
}

export async function transferCertificatePdf(s: TransferSnapshot, serial: string, bookNo: string, admissionNo: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Transfer certificate ${serial}`)
  doc.setProducer('CampusOS')
  const fields = fieldsOf(s)
  const header = {
    school: s.schoolName,
    affiliation: 'Affiliated to the Central Board of Secondary Education',
    address: str(s.schoolAddress),
    codes: `Affiliation No. ${str(s.affiliationNo)}   School Code ${str(s.schoolCode)}`,
    title: 'TRANSFER CERTIFICATE',
    refs: `Book No. ${bookNo}   Serial No. ${serial}   Admission No. ${admissionNo}`,
    replaces: s.replacesSerial ? `Replacement for ${String(s.replacesSerial)}` : null,
  }
  const tail = ['Class Teacher', `Checked by: ${str(s.checkedBy)}`, 'Principal / Vice-Principal', 'School seal']
  const t = await pdfText(doc, JSON.stringify([header, fields, tail, serial]))
  const ink = rgb(0.09, 0.09, 0.1)
  const faint = rgb(0.45, 0.45, 0.48)
  const { w, h, margin, text: size, pitch } = PAGE
  const inner = w - margin * 2
  const valueX = margin + PAGE.labelWidth + 10
  const valueWidth = w - margin - valueX
  const centre = (page: PDFPage, s: string, y: number, sz: number, weight: 'regular' | 'bold' = 'regular') =>
    t.draw(page, s, { x: (w - Math.min(t.width(s, sz, weight), inner)) / 2, y, size: sz, weight, color: ink })

  let page = doc.addPage([w, h])
  let y = h - margin
  const top = (first: boolean) => {
    if (first) {
      centre(page, header.school, y - PAGE.title, PAGE.title, 'bold')
      y -= PAGE.title + 8
      for (const [text, sz] of [[header.affiliation, size], [header.address, size], [header.codes, size]] as [string, number][]) {
        for (const line of wrapLines((x) => t.width(x, sz), text, inner)) {
          centre(page, line, y - sz, sz)
          y -= pitch
        }
      }
      y -= 6
      centre(page, header.title, y - 13, 13, 'bold')
      y -= 24
      centre(page, header.refs, y - size, size)
      y -= pitch
      if (header.replaces) {
        centre(page, header.replaces, y - size, size)
        y -= pitch
      }
      y -= 8
    } else {
      centre(page, `${header.school}: Transfer certificate ${serial} (continued)`, y - size, size, 'bold')
      y -= pitch * 2
    }
  }
  top(true)
  const room = (lines: number, reserve = 0) => y - lines * pitch >= margin + reserve
  for (const [label, value] of fields) {
    const left = wrapLines((x) => t.width(x, size, 'bold'), label, PAGE.labelWidth)
    const right = wrapLines((x) => t.width(x, size), value, valueWidth)
    const n = Math.max(left.length, right.length)
    for (let i = 0; i < n; i++) {
      if (!room(1)) {
        page = doc.addPage([w, h])
        y = h - margin
        top(false)
      }
      if (left[i]) t.draw(page, left[i]!, { x: margin, y: y - size, size, weight: 'bold', color: ink })
      if (right[i]) t.draw(page, right[i]!, { x: valueX, y: y - size, size, color: ink })
      y -= pitch
    }
  }
  // Signatures and the seal: a continuation page when they will not fit under the last field.
  if (!room(0, PAGE.signature)) {
    page = doc.addPage([w, h])
    y = h - margin
    top(false)
  }
  const base = margin + 30
  const col = inner / 3
  tail.slice(0, 3).forEach((label, i) => {
    const x = margin + col * i
    page.drawLine({ start: { x, y: base + 22 }, end: { x: x + col - 20, y: base + 22 }, thickness: 0.5, color: ink })
    for (const [k, line] of wrapLines((v) => t.width(v, size), label, col - 20).entries()) t.draw(page, line, { x, y: base + 8 - k * 12, size, color: faint })
  })
  page.drawRectangle({ x: w - margin - 80, y: base + 36, width: 80, height: 44, borderColor: faint, borderWidth: 0.5, borderDashArray: [3, 3] })
  t.draw(page, tail[3]!, { x: w - margin - 80 + (80 - t.width(tail[3]!, 8)) / 2, y: base + 55, size: 8, color: faint })
  return doc.save()
}

/** A standing certificate's printable form, read from the saved snapshot only. */
export async function transferCertificateDocument(actor: Actor, certificateId: string): Promise<{ bytes: Uint8Array; serial: string }> {
  if (!actor.institutionId) throw new CeremonyError(400, 'no_institution', 'no institution for this session')
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') throw new CeremonyError(403, 'forbidden', 'not permitted')
  const tenant = actor.institutionId
  if (!z.uuid().safeParse(certificateId).success) throw new CeremonyError(404, 'no_such_transfer_certificate', 'No such transfer certificate.')
  const row = await withTenant(tenant, async (tx) => {
    const r = await tx.execute(sql`
      select c.issue_year, c.serial_no, c.docstatus, p.snapshot
        from ceremony_transfer_certificates c
        left join ceremony_transfer_payloads p on p.certificate_id = c.id and p.institution_id = c.institution_id
       where c.id = ${certificateId}::uuid and c.institution_id = ${tenant}::uuid`)
    return r.rows[0] as { issue_year: number; serial_no: number; docstatus: string; snapshot: TransferSnapshot | null } | undefined
  })
  if (!row) throw new CeremonyError(404, 'no_such_transfer_certificate', 'No such transfer certificate.')
  if (row.docstatus !== 'submitted' || !row.snapshot) {
    throw new CeremonyError(409, 'transfer_pdf_unavailable', 'This transfer certificate is unavailable for printing.')
  }
  const serial = formatSerial(row.issue_year, row.serial_no)
  const s = row.snapshot
  return { bytes: await transferCertificatePdf(s, serial, str(s.bookNo), str(s.admissionNo)), serial }
}
