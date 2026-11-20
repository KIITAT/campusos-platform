import { sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { ADMIN, MEMBERS, UploadError, canAccessStudent, hasRole, type PluginActor, type Role } from '@campusos/module-framework'

export type Actor = PluginActor
export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
export { ADMIN, MEMBERS }

export class DocumentError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string, message: string) { super(message) }
}
export const missing = () => new DocumentError(404, 'document_missing', 'Document unavailable.')
export const closed = () => new DocumentError(409, 'document_closed', 'This signing request is closed.')
export const expired = () => new DocumentError(409, 'document_expired', 'This signing request has expired.')
export const openFirst = () => new DocumentError(409, 'document_open_first', 'Download the document before recording assent.')
export const integrity = () => new DocumentError(409, 'document_integrity', 'Integrity check failed.')
export const invalidCode = () => new DocumentError(409, 'challenge_invalid', 'This confirmation code is invalid or expired.')
export const waitForCode = () => new DocumentError(409, 'challenge_wait', 'Wait before requesting a new code.')
export const mailUnavailable = () => new DocumentError(503, 'document_mail_unavailable', 'Document confirmation email is unavailable.')
export const badUpload = (error: unknown) => error instanceof UploadError ? new DocumentError(400, error.code, error.message) : error

/** The role gate every operation starts with; the record check comes after it. */
export function tenant(actor: Actor, roles: readonly Role[] = MEMBERS): string {
  if (!actor.institutionId) throw new DocumentError(400, 'no_institution', 'An institution is required.')
  if (!hasRole(actor.role, roles)) throw new DocumentError(403, 'forbidden', 'Your role cannot perform this operation.')
  return actor.institutionId
}

export interface DocumentAccess {
  id: string
  institutionId: string
  subjectUserId: string
  kind: 'record' | 'offer' | 'contract' | 'agreement'
  scope: 'office' | 'student_academic' | 'signer'
  title: string
  mediaType: string
  sha256: string
  createdAt: string
  retainUntil: string | null
  requestId: string | null
  /** The request's state, or `expired` for a pending one past its deadline; null with no request. */
  status: 'pending' | 'signed' | 'declined' | 'cancelled' | 'expired' | null
  expiresAt: string | null
}

const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)
/** Metadata only: no bytes ever leave the database through this projection. */
export const ACCESS_COLUMNS = sql`d.id::text as id, d.institution_id::text as "institutionId", d.subject_user_id as "subjectUserId", d.kind, d.scope, d.title,
  d.media_type as "mediaType", d.sha256, ${iso('d.created_at')} as "createdAt", ${iso('d.retain_until')} as "retainUntil",
  r.id::text as "requestId",
  case when r.id is null then null when r.status = 'pending' and r.expires_at <= clock_timestamp() then 'expired' else r.status end as status,
  ${iso('r.expires_at')} as "expiresAt"`

/**
 * One document, only if this actor may read it (D852). The role in the
 * session is a way in; the membership row and the record decide. Every
 * refusal is the same 404, so a document's existence is not disclosed.
 * `write` narrows to an administrator.
 */
export async function requireDocument(tx: Tx, actor: Actor, id: string, write = false): Promise<DocumentAccess> {
  if (!actor.institutionId || !/^[0-9a-f-]{36}$/i.test(id)) throw missing()
  const me = (await tx.execute(sql`select role from users where id = ${actor.id} and institution_id = ${actor.institutionId} and erased_at is null`)).rows[0] as { role: Role } | undefined
  if (!me || me.role === 'pending') throw missing()
  const row = (await tx.execute(sql`select ${ACCESS_COLUMNS} from documents_files d left join documents_sign_requests r on (r.institution_id, r.document_id) = (d.institution_id, d.id) where d.id = ${id}`)).rows[0] as unknown as DocumentAccess | undefined
  if (!row) throw missing()
  const admin = hasRole(me.role, ADMIN)
  if (write && !admin) throw missing()
  const allowed = admin
    || (row.scope === 'signer' && row.subjectUserId === actor.id && row.requestId !== null)
    || (row.scope === 'student_academic' && await canAccessStudent(tx, { ...actor, role: me.role }, row.subjectUserId, 'academic_record'))
  if (!allowed) throw missing()
  return row
}

/** Ids and a fixed reason only: no title, address, code or bytes (D859). */
export const logDocument = (tx: Tx, actor: Actor, action: string, documentId: string, reason: string, detail?: Record<string, unknown>) =>
  audit(tx, { institutionId: actor.institutionId!, actorId: actor.id, actorEmail: null, moduleId: 'documents', action, entity: 'documents_files', entityId: documentId, reason, detail })
