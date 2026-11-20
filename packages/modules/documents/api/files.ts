import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { ADMIN, readUpload } from '@campusos/module-framework'
import { DocumentError, badUpload, logDocument, tenant, type Actor } from './core'
import { uploadSchema } from './schemas'

const MAX_BYTES = 5 * 1024 * 1024
const SIGNABLE_TYPES = ['application/pdf']
const RECORD_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
const refused = (code: string, message: string) => new DocumentError(400, code, message)

/** An administrator files one immutable document for one current member (D851). */
export async function uploadDocument(actor: Actor, input: unknown): Promise<{ documentId: string; notice: string }> {
  const institutionId = tenant(actor, ADMIN)
  const data = uploadSchema.parse(input)
  const signable = data.scope === 'signer'
  let file
  try { file = readUpload(data.file, { maxBytes: MAX_BYTES, types: signable ? SIGNABLE_TYPES : RECORD_TYPES, what: 'the document' }) } catch (error) { throw badUpload(error) }
  if (signable !== (data.retainUntil !== undefined && data.retentionBasis !== undefined && data.authorityRef !== undefined)) {
    throw refused('retention_required', signable
      ? 'A document for signature needs a retention end date, its basis and an authority reference.'
      : 'Retention fields apply only to documents for signature.')
  }
  return withTenant(institutionId, async tx => {
    const [subject] = (await tx.execute(sql`select role from users where id = ${data.subjectUserId} and institution_id = ${institutionId} and erased_at is null`)).rows as { role: string }[]
    if (!subject || subject.role === 'pending' || (data.scope === 'student_academic' && subject.role !== 'student')) {
      throw refused('invalid_subject', data.scope === 'student_academic' ? 'Choose a current student of this institution.' : 'Choose a current member of this institution.')
    }
    if (signable) {
      const [bounds] = (await tx.execute(sql`select (${data.retainUntil}::timestamptz >= now() + interval '8 days' and ${data.retainUntil}::timestamptz <= now() + interval '10 years') as ok`)).rows as { ok: boolean }[]
      if (!bounds!.ok) throw refused('retention_range', 'The retention end date must be between 8 days and 10 years from today.')
    }
    const [row] = (await tx.execute(sql`insert into documents_files (institution_id, subject_user_id, kind, scope, title, media_type, body, sha256, retention_basis, authority_ref, retain_until)
      values (${institutionId}, ${data.subjectUserId}, ${data.kind}, ${data.scope}, ${data.title}, ${file.type}, ${file.bytes}, ${file.sha256},
        ${signable ? data.retentionBasis : null}, ${signable ? data.authorityRef : null}, ${signable ? data.retainUntil : null}::timestamptz)
      returning id::text as id`)).rows as { id: string }[]
    await logDocument(tx, actor, 'document.uploaded', row!.id, 'Document filed by an administrator', { kind: data.kind, scope: data.scope, sha256: file.sha256, size: file.size })
    return { documentId: row!.id, notice: 'Document stored.' }
  })
}
