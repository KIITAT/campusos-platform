import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { ADMIN, hasRole, type Role } from '@campusos/module-framework'
import { DocumentError, closed, expired, integrity, invalidCode, isUuid, logDocument, missing, openFirst, requireDocument, tenant, waitForCode, type Actor, type Tx } from './core'
import { actualHash, failIntegrity } from './files'
import { assentSchema, challengeSchema, closeSchema, requestSchema } from './schemas'

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const mailbox = (email: string) => sha(email.trim().toLowerCase())
const INTENT_VERSION = 'documents-assent-v1'
const METHOD = 'account_mailbox_v1'

interface Locked {
  email: string
  id: string
  documentId: string
  signerId: string
  status: 'pending' | 'signed' | 'declined' | 'cancelled'
  viewed: boolean
  lapsed: boolean
  fileSha256: string
  codeDigest: string | null
  recipientDigest: string | null
  codeLive: boolean
  issuedRecently: boolean
}

/**
 * The one lock order: the caller's membership row (shared), the file (shared),
 * then the request (exclusive), so an erasure, a download and two competing
 * signers always meet in the same sequence. Anyone but the named signer sees
 * a missing document. The deadline is read from the database clock here, at
 * every mutation, so no background job has to close a request.
 */
async function lockRequest(tx: Tx, actor: Actor, requestId: string, who: 'signer' | 'any' = 'signer'): Promise<Locked> {
  if (!isUuid(requestId)) throw missing()
  const [me] = (await tx.execute(sql`select email, role from users where id = ${actor.id} and institution_id = ${actor.institutionId} and erased_at is null for share`)).rows as { email: string; role: Role }[]
  if (!me || me.role === 'pending' || (who === 'any' && !hasRole(me.role, ADMIN))) throw missing()
  const [ref] = (await tx.execute(sql`select document_id::text as "documentId" from documents_sign_requests where id = ${requestId}`)).rows as { documentId: string }[]
  if (!ref) throw missing()
  await tx.execute(sql`select 1 from documents_files where id = ${ref.documentId} for share`)
  const [row] = (await tx.execute(sql`select r.id::text as id, r.document_id::text as "documentId", r.signer_id as "signerId", r.status, r.viewed_at is not null as viewed,
      (r.expires_at <= clock_timestamp()) as lapsed, d.sha256 as "fileSha256", r.code_digest as "codeDigest", r.recipient_digest as "recipientDigest",
      (r.code_expires_at is not null and r.code_expires_at > clock_timestamp()) as "codeLive",
      (r.code_issued_at is not null and r.code_issued_at > clock_timestamp() - interval '60 seconds') as "issuedRecently"
    from documents_sign_requests r join documents_files d on (d.institution_id, d.id) = (r.institution_id, r.document_id)
    where r.id = ${requestId} for update of r`)).rows as unknown as Omit<Locked, 'email'>[]
  if (!row || (who === 'signer' && row.signerId !== actor.id)) throw missing()
  return { ...row, email: me.email }
}

/** An administrator asks the named member to record assent to one stored PDF (D853). */
export async function requestAssent(actor: Actor, input: unknown): Promise<{ requestId: string; notice: string }> {
  const institutionId = tenant(actor, ADMIN)
  const data = requestSchema.parse(input)
  const result = await withTenant(institutionId, async tx => {
    const access = await requireDocument(tx, actor, data.documentId, true)
    if (access.subjectUserId === actor.id) throw new DocumentError(400, 'self_signing', 'Choose a signer other than the administrator who sends the request.')
    if (access.scope !== 'signer' || access.mediaType !== 'application/pdf') throw new DocumentError(400, 'not_signable', 'Only an offer, contract or agreement PDF can be sent for assent.')
    await tx.execute(sql`select 1 from users where id = ${actor.id} and erased_at is null for share`)
    const [subject] = (await tx.execute(sql`select 1 from users where id = ${access.subjectUserId} and institution_id = ${institutionId} and erased_at is null for share`)).rows
    if (!subject) throw new DocumentError(400, 'invalid_subject', 'Choose a current member of this institution.')
    await tx.execute(sql`select 1 from documents_files where id = ${access.id} for share`)
    if (await actualHash(tx, access.id) !== access.sha256) { await failIntegrity(tx, actor, access.id); return null }
    if (access.requestId) throw closed()
    let requestId: string
    try {
      // a savepoint, so the losing insert of two competing requests leaves the transaction usable
      requestId = await tx.transaction(async inner => {
        const [row] = (await inner.execute(sql`insert into documents_sign_requests (institution_id, document_id, signer_id, expires_at)
          values (${institutionId}, ${access.id}, ${access.subjectUserId}, now() + interval '168 hours') returning id::text as id`)).rows as { id: string }[]
        return row!.id
      })
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === '23505') throw closed()
      throw error
    }
    await logDocument(tx, actor, 'document.requested', access.id, data.reason, { requestId })
    return requestId
  })
  if (!result) throw integrity()
  return { requestId: result, notice: 'Signing requested.' }
}

/**
 * A fresh single-use code for the named signer, who must already have
 * downloaded the exact file (D854). Returns the plain code and the current
 * address for the mail boundary only; the database keeps digests.
 */
export async function issueAssentChallenge(actor: Actor, input: unknown): Promise<{ requestId: string; recipient: string; code: string }> {
  const institutionId = tenant(actor)
  const data = challengeSchema.parse(input)
  const code = randomBytes(24).toString('base64url')
  const out = await withTenant(institutionId, async tx => {
    const request = await lockRequest(tx, actor, data.requestId)
    if (request.status !== 'pending') throw closed()
    if (request.lapsed) throw expired()
    if (!request.viewed) throw openFirst()
    if (request.issuedRecently) throw waitForCode()
    if (await actualHash(tx, request.documentId) !== request.fileSha256) { await failIntegrity(tx, actor, request.documentId); return null }
    await tx.execute(sql`update documents_sign_requests set code_digest = ${sha(code)}, recipient_digest = ${mailbox(request.email)},
      code_issued_at = clock_timestamp(), code_expires_at = least(clock_timestamp() + interval '10 minutes', expires_at) where id = ${request.id}`)
    await logDocument(tx, actor, 'document.challenge_issued', request.documentId, 'Confirmation code issued to the signer', { requestId: request.id })
    return request.email.trim()
  })
  if (!out) throw integrity()
  return { requestId: data.requestId, recipient: out, code }
}

/** The mail did not go: invalidate only the code that is still current, so the signer can ask again. */
export async function markChallengeDeliveryFailed(actor: Actor, requestId: string, code: string): Promise<void> {
  const institutionId = tenant(actor)
  const data = challengeSchema.parse({ requestId })
  await withTenant(institutionId, async tx => {
    const request = await lockRequest(tx, actor, data.requestId)
    if (request.status !== 'pending' || request.codeDigest !== sha(code)) return
    await tx.execute(sql`update documents_sign_requests set code_digest = null, recipient_digest = null, code_expires_at = null, code_issued_at = null where id = ${request.id}`)
    await logDocument(tx, actor, 'document.challenge_delivery_failed', request.documentId, 'Confirmation code could not be delivered', { requestId: request.id })
  })
}

const sameDigest = (a: string, b: string) => /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

/**
 * Record assent: the code, the current mailbox, the deadline and the exact
 * original are all checked under the request lock. One audit row carries the
 * evidence fields and the signature row is only accepted beside it (D855).
 */
export async function recordAssent(actor: Actor, input: unknown): Promise<{ signatureId: string; notice: string }> {
  const institutionId = tenant(actor)
  const data = assentSchema.parse(input)
  const done = await withTenant(institutionId, async tx => {
    const request = await lockRequest(tx, actor, data.requestId)
    if (request.status === 'signed') {
      const [existing] = (await tx.execute(sql`select id::text as id from documents_signatures where institution_id = ${institutionId} and request_id = ${request.id}`)).rows as { id: string }[]
      return existing ? { signatureId: existing.id } : null
    }
    if (request.status !== 'pending') throw closed()
    if (request.lapsed) throw expired()
    if (!request.viewed) throw openFirst()
    if (!request.codeDigest || !request.recipientDigest || !request.codeLive
      || !sameDigest(request.codeDigest, sha(data.code)) || request.recipientDigest !== mailbox(request.email)) throw invalidCode()
    if (await actualHash(tx, request.documentId) !== request.fileSha256) { await failIntegrity(tx, actor, request.documentId); return null }
    const [clock] = (await tx.execute(sql`select to_char(date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as iso`)).rows as { iso: string }[]
    const signatureId = randomUUID()
    const detail = { requestId: request.id, signerId: actor.id, signedAt: clock!.iso, method: METHOD, intentVersion: INTENT_VERSION, sha256: request.fileSha256, recipientDigest: request.recipientDigest }
    const reason = 'Signer recorded electronic assent'
    await tx.execute(sql`select set_config('app.audit_reason', ${reason}, true)`)
    await tx.execute(sql`insert into audit_log (id, institution_id, actor_id, actor_email, module_id, action, entity, entity_id, reason, detail)
      values (${signatureId}, ${institutionId}, ${actor.id}, null, 'documents', 'document.assented', 'documents_files', ${request.documentId}, ${reason}, ${JSON.stringify(detail)}::jsonb)`)
    await tx.execute(sql`insert into documents_signatures (id, institution_id, document_id, request_id, signer_id, signed_at, method, intent_version, sha256)
      values (${signatureId}, ${institutionId}, ${request.documentId}, ${request.id}, ${actor.id}, ${clock!.iso}::timestamptz, ${METHOD}, ${INTENT_VERSION}, ${request.fileSha256})`)
    await tx.execute(sql`update documents_sign_requests set status = 'signed', decided_at = ${clock!.iso}::timestamptz,
      code_digest = null, recipient_digest = null, code_expires_at = null, code_issued_at = null where id = ${request.id}`)
    return { signatureId }
  })
  if (!done) throw integrity()
  return { signatureId: done.signatureId, notice: 'Assent recorded.' }
}

/** The named signer declines, or an administrator cancels, with a reason bound to the request (D853). */
export async function closeAssent(actor: Actor, input: unknown): Promise<{ notice: string }> {
  const institutionId = tenant(actor)
  const data = closeSchema.parse(input)
  const cancel = data.decision === 'cancel'
  if (cancel) tenant(actor, ADMIN)
  await withTenant(institutionId, async tx => {
    const request = await lockRequest(tx, actor, data.requestId, cancel ? 'any' : 'signer')
    if (request.status !== 'pending') throw closed()
    if (request.lapsed) throw expired()
    await tx.execute(sql`update documents_sign_requests set status = ${cancel ? 'cancelled' : 'declined'}, decided_at = date_trunc('milliseconds', clock_timestamp()),
      code_digest = null, recipient_digest = null, code_expires_at = null, code_issued_at = null where id = ${request.id}`)
    await logDocument(tx, actor, cancel ? 'document.cancelled' : 'document.declined', request.documentId, data.reason, { requestId: request.id })
  })
  return { notice: cancel ? 'Signing cancelled.' : 'Signing declined.' }
}
