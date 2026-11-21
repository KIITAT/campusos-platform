import { sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { withTenant } from '@campusos/db'
import { pdfText } from '@campusos/module-framework/pdf'
import { DocumentError, integrity, logDocument, requireDocument, tenant, type Actor } from './core'
import { actualHash, attachment, failIntegrity } from './files'
import { integrityOf } from './integrity'

/** Fixed wording (D855): what the record is, and what it is not. */
export const RECEIPT_TEXT = [
  'The account holder named below recorded electronic assent to the stored document.',
  'Assent was confirmed in a signed-in session with a one-time code sent to the mailbox of the account.',
  'This is internal evidence of assent. It is not a certified or statutory digital signature.',
  'The original file is stored unchanged; its SHA-256 digest is shown below.',
]

/** A separate evidence PDF; the signed original is never redrawn or watermarked. */
export async function signingReceipt(actor: Actor, id: string): Promise<Response> {
  const institutionId = tenant(actor)
  const found = await withTenant(institutionId, async tx => {
    const access = await requireDocument(tx, actor, id)
    if (access.status !== 'signed') throw new DocumentError(404, 'document_missing', 'Document unavailable.')
    if (await integrityOf(tx, institutionId, access.id, await actualHash(tx, access.id), access.sha256) !== 'verified') {
      await failIntegrity(tx, actor, access.id)
      return null
    }
    const [row] = (await tx.execute(sql`select s.id::text as "signatureId", s.request_id::text as "requestId", s.signer_id as "signerId", s.method, s.intent_version as "intentVersion", s.sha256,
        to_char(s.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "signedAt"
      from documents_signatures s where s.document_id = ${access.id}`)).rows as Record<string, string>[]
    await logDocument(tx, actor, 'document.read', access.id, 'Signing record read by an authorized member', { part: 'receipt' })
    return row!
  })
  if (!found) throw integrity()
  const lines: [string, string][] = [['Document ID', id], ['Request ID', found.requestId!], ['Signer ID', found.signerId!], ['Method', found.method!],
    ['Intent version', found.intentVersion!], ['Signed at (UTC)', found.signedAt!], ['SHA-256', found.sha256!]]
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const text = await pdfText(doc, JSON.stringify([RECEIPT_TEXT, lines, 'Electronic assent record']))
  let y = 780
  text.draw(page, 'Electronic assent record', { x: 50, y, size: 20, weight: 'bold' })
  y -= 40
  for (const line of RECEIPT_TEXT) { text.draw(page, line, { x: 50, y, size: 10 }); y -= 16 }
  y -= 12
  for (const [label, value] of lines) {
    text.draw(page, label, { x: 50, y, size: 10, weight: 'bold' })
    text.draw(page, value, { x: 170, y, size: label === 'SHA-256' ? 8 : 10 })
    y -= 18
  }
  return attachment(Buffer.from(await doc.save()), 'application/pdf', 'document-assent.pdf')
}
