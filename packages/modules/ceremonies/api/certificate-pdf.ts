import { PDFDocument, rgb } from 'pdf-lib'
import { pdfText, type Weight } from '@campusos/module-framework/pdf'
import type { Certificate } from '../schema'

/**
 * The degree certificate as a document to print.
 *
 * pdf-lib with Noto Sans, through @campusos/module-framework/pdf: a name in any
 * of nine Indian scripts prints as typed and reads back as typed (it carries
 * /ActualText), and a character no font has is refused at issue, never folded
 * to `?` on a document of record.
 *
 * Landscape A4. Nothing on it is decided here: the name, the programme, the
 * date and the serial are the record's, and the verification code is what
 * lets somebody holding the paper check it against that record.
 */

const A4 = { w: 841.89, h: 595.28 }

export async function certificatePdf(
  c: Pick<Certificate, 'serial' | 'verificationCode' | 'studentName' | 'programName' | 'conferredOn' | 'cgpa'>,
  institution: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Certificate ${c.serial}`)
  doc.setProducer('CampusOS')
  const page = doc.addPage([A4.w, A4.h])
  const t = await pdfText(doc, JSON.stringify([c, institution]))
  const ink = rgb(0.09, 0.09, 0.1)
  const faint = rgb(0.45, 0.45, 0.48)

  // A double rule round the edge.
  for (const inset of [24, 30]) {
    page.drawRectangle({
      x: inset,
      y: inset,
      width: A4.w - inset * 2,
      height: A4.h - inset * 2,
      borderColor: ink,
      borderWidth: inset === 24 ? 1.5 : 0.5,
    })
  }

  const centre = (s: string, y: number, size: number, weight: Weight = 'regular', color = ink) => {
    const w = t.width(s, size, weight)
    t.draw(page, s, { x: (A4.w - w) / 2, y, size, weight, color })
  }

  const date = new Date(`${c.conferredOn}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  centre(institution.toUpperCase(), 470, 26, 'bold')
  centre('This is to certify that', 400, 15, 'regular', faint)
  centre(c.studentName, 350, 34, 'bold')
  centre('having fulfilled the requirements of the programme, was admitted to the degree of', 305, 14, 'regular', faint)
  centre(c.programName, 262, 24)
  centre(`on ${date}`, 225, 14, 'regular', faint)
  if (c.cgpa !== null) centre(`Cumulative grade point average ${Number(c.cgpa).toFixed(2)}`, 196, 11, 'regular', faint)

  t.draw(page, `Serial ${c.serial}`, { x: 56, y: 60, size: 9, color: faint })
  const v = `Verification code ${c.verificationCode}`
  t.draw(page, v, { x: A4.w - 56 - t.width(v, 9), y: 60, size: 9, color: faint })

  return doc.save()
}
