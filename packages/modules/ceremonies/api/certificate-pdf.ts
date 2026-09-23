import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Certificate } from '../schema'

/**
 * The degree certificate as a document to print.
 *
 * pdf-lib and the standard fonts, as the transcript does: no browser, no font
 * data, and WinAnsi only -- a name outside Latin script is folded rather than
 * refused, and embedding a font for Devanagari is a deliberate later decision.
 *
 * Landscape A4. Nothing on it is decided here: the name, the programme, the
 * date and the serial are the record's, and the verification code is what
 * lets somebody holding the paper check it against that record.
 */

const A4 = { w: 841.89, h: 595.28 }
const safe = (s: string) => s.replace(/[^\x20-\x7E]/g, '?')

export async function certificatePdf(
  c: Pick<Certificate, 'serial' | 'verificationCode' | 'studentName' | 'programName' | 'conferredOn' | 'cgpa'>,
  institution: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Certificate ${c.serial}`)
  doc.setProducer('CampusOS')
  const page = doc.addPage([A4.w, A4.h])
  const serif = await doc.embedFont(StandardFonts.TimesRoman)
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const sans = await doc.embedFont(StandardFonts.Helvetica)
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

  const centre = (s: string, y: number, size: number, font = serif, color = ink) => {
    const t = safe(s)
    const w = font.widthOfTextAtSize(t, size)
    page.drawText(t, { x: (A4.w - w) / 2, y, size, font, color })
  }

  const date = new Date(`${c.conferredOn}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  centre(institution.toUpperCase(), 470, 26, serifBold)
  centre('This is to certify that', 400, 15, serifItalic, faint)
  centre(c.studentName, 350, 34, serifBold)
  centre('having fulfilled the requirements of the programme, was admitted to the degree of', 305, 14, serifItalic, faint)
  centre(c.programName, 262, 24, serif)
  centre(`on ${date}`, 225, 14, serif, faint)
  if (c.cgpa !== null) centre(`Cumulative grade point average ${Number(c.cgpa).toFixed(2)}`, 196, 11, sans, faint)

  page.drawText(safe(`Serial ${c.serial}`), { x: 56, y: 60, size: 9, font: sans, color: faint })
  const v = safe(`Verification code ${c.verificationCode}`)
  page.drawText(v, { x: A4.w - 56 - sans.widthOfTextAtSize(v, 9), y: 60, size: 9, font: sans, color: faint })

  return doc.save()
}
