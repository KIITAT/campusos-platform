import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { ADMIN, assertCanAccessStudent, cursorColumn, finishPage, hasRole, keyset, orderKeys, readPage, readUpload, type KeyColumn, type Page, type PageRequest, type Role, type SortSpec } from '@campusos/module-framework'
import { ACCESS_COLUMNS, DocumentError, badUpload, integrity, logDocument, missing, requireDocument, tenant, type Actor, type DocumentAccess, type Tx } from './core'
import { digest, integrityOf, type IntegrityState } from './integrity'
import { uploadSchema, verifySchema } from './schemas'

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

const FILE_NAMES: Record<string, string> = { 'application/pdf': 'document.pdf', 'image/png': 'document.png', 'image/jpeg': 'document.jpg' }
export const attachment = (body: Buffer | Uint8Array, type: string, name: string) => new Response(body as BodyInit, { headers: {
  'content-type': type, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
} })

/** The stored hash recomputed by the database, without the bytes leaving it. */
export async function actualHash(tx: Tx, documentId: string): Promise<string> {
  const [row] = (await tx.execute(sql`select encode(sha256(body), 'hex') as actual from documents_files where id = ${documentId}`)).rows as { actual: string }[]
  return row!.actual
}

/** An original that fails its check is logged, and the caller answers after the log commits. */
export const failIntegrity = (tx: Tx, actor: Actor, documentId: string) =>
  logDocument(tx, actor, 'document.integrity_failed', documentId, 'Stored file or signing evidence differs from its record')

/**
 * The exact bytes, after authorization and the integrity check. The named
 * signer's first successful read of a pending request marks it viewed, which
 * is what unlocks the confirmation code (D853). Locks: file, then request.
 */
export async function downloadDocument(actor: Actor, id: string): Promise<Response> {
  const institutionId = tenant(actor)
  const found = await withTenant(institutionId, async tx => {
    const access = await requireDocument(tx, actor, id)
    const [file] = (await tx.execute(sql`select body from documents_files where id = ${access.id}`)).rows as { body: Buffer }[]
    if (await integrityOf(tx, institutionId, access.id, digest(file!.body), access.sha256) === 'mismatch') {
      await failIntegrity(tx, actor, access.id)
      return null
    }
    if (access.status === 'pending' && access.subjectUserId === actor.id) {
      await tx.execute(sql`select 1 from documents_files where id = ${access.id} for share`)
      await tx.execute(sql`update documents_sign_requests set viewed_at = date_trunc('milliseconds', clock_timestamp())
        where id = ${access.requestId} and status = 'pending' and viewed_at is null and expires_at > clock_timestamp()`)
    }
    await logDocument(tx, actor, 'document.read', access.id, 'Document read by an authorized member', { part: 'original' })
    return { body: file!.body, mediaType: access.mediaType }
  })
  if (!found) throw integrity()
  return attachment(found.body, found.mediaType, FILE_NAMES[found.mediaType] ?? 'document.pdf')
}

export interface Verification { integrity: IntegrityState; copyMatches: boolean | null }

/** Authenticated, on demand: the stored file and evidence, and optionally a reader's copy by digest (D856). */
export async function verifyDocument(actor: Actor, input: unknown): Promise<Verification> {
  const institutionId = tenant(actor)
  const data = verifySchema.parse(input)
  return withTenant(institutionId, async tx => {
    const access = await requireDocument(tx, actor, data.documentId)
    const state = await integrityOf(tx, institutionId, access.id, await actualHash(tx, access.id), access.sha256)
    if (state === 'mismatch') {
      await failIntegrity(tx, actor, access.id)
      return { integrity: state, copyMatches: null }
    }
    await logDocument(tx, actor, 'document.read', access.id, 'Document verified by an authorized member', { part: 'verification' })
    return { integrity: state, copyMatches: data.sha256 === undefined ? null : data.sha256 === access.sha256 }
  })
}

export type DocumentSummary = DocumentAccess & { integrity: IntegrityState }

const NEWEST: KeyColumn[] = [{ sql: sql`d.created_at`, type: 'timestamptz' }, { sql: sql`d.id`, type: 'uuid' }]
const SORTS: SortSpec = { newest: { dir: 'desc', keys: NEWEST } }
export const MAX_LIST = 20
/** The page a list request asks for; newest first, no free-text search. */
export const readDocumentPage = (request: Request, prefix = ''): PageRequest => readPage(request, prefix, SORTS, 'newest', MAX_LIST)

/**
 * The documents this actor may list. Scope is part of the query, so counts and
 * pages never include a row the reader could not open. Without a student: an
 * administrator sees all, anyone else the signable documents named for them
 * once requested and their own academic records. With a student: that
 * student's academic records, after the student relation allows it.
 */
export async function listDocuments(actor: Actor, page: PageRequest, studentId?: string): Promise<Page<DocumentSummary>> {
  const institutionId = tenant(actor)
  const request: PageRequest = { q: null, sort: 'newest', dir: 'desc', limit: Math.min(Math.max(page.limit, 1), MAX_LIST), after: page.after }
  return withTenant(institutionId, async tx => {
    const [me] = (await tx.execute(sql`select role from users where id = ${actor.id} and institution_id = ${institutionId} and erased_at is null`)).rows as { role: Role }[]
    if (!me || me.role === 'pending') throw missing()
    let scope
    if (studentId !== undefined) {
      try { await assertCanAccessStudent(tx, { ...actor, role: me.role, authzReportOnly: false }, studentId, 'academic_record') } catch { throw missing() }
      scope = sql`d.scope = 'student_academic' and d.subject_user_id = ${studentId}`
    } else if (hasRole(me.role, ADMIN)) scope = sql`true`
    else scope = sql`((d.scope = 'signer' and d.subject_user_id = ${actor.id} and r.id is not null) or (d.scope = 'student_academic' and d.subject_user_id = ${actor.id}))`
    const join = sql`from documents_files d left join documents_sign_requests r on (r.institution_id, r.document_id) = (d.institution_id, d.id)`
    const cut = keyset(NEWEST, request)
    const rows = (await tx.execute(sql`select ${ACCESS_COLUMNS}, encode(sha256(d.body), 'hex') as "actualSha256", ${cursorColumn(NEWEST)} as _cursor
      ${join} where ${scope} ${cut ? sql`and ${cut}` : sql``} order by ${sql.join(orderKeys(NEWEST, 'desc'), sql`, `)} limit ${request.limit + 1}`)).rows as unknown as (DocumentAccess & { actualSha256: string; _cursor: string[] })[]
    const [{ total } = { total: '0' }] = (await tx.execute(sql`select count(*)::text as total ${join} where ${scope}`)).rows as { total: string }[]
    const shown = finishPage(rows, request, Number(total))
    const out: DocumentSummary[] = []
    for (const row of shown.rows as (DocumentAccess & { actualSha256: string })[]) {
      const { actualSha256, ...summary } = row
      const state = await integrityOf(tx, institutionId, summary.id, actualSha256, summary.sha256)
      if (state === 'mismatch') await failIntegrity(tx, actor, summary.id)
      else await logDocument(tx, actor, 'document.read', summary.id, 'Document listed for an authorized member', { part: 'list' })
      out.push({ ...summary, integrity: state })
    }
    return { rows: out, total: shown.total, next: shown.next }
  })
}
