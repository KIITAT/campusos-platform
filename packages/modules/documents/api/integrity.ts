import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { genesis, rowHash, type ChainRow } from '@campusos/db'
import type { Tx } from './core'

export type IntegrityState = 'verified' | 'mismatch' | 'unsigned'

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** The same projection the chain verifier reads (audit-chain.ts), so the hash is rebuilt from exactly what it sealed. */
const AUDIT_COLUMNS = sql.raw(`
  a.id::text as id, to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_text,
  a.institution_id::text as institution_id, a.actor_id, a.module_id, a.action, a.entity, a.entity_id,
  a.actor_email, a.reason, a.detail::text as detail, a.salt`)

/**
 * Does a signature's evidence agree with the original and with the sealed
 * audit row that recorded it (D856)? Every field is compared with the signed
 * row, then the audit row's hash is rebuilt from its link and the link before
 * it. Any difference, a missing seal included, is a mismatch.
 */
export async function evidenceHolds(tx: Tx, institutionId: string, documentId: string, fileSha256: string): Promise<boolean> {
  const [sig] = (await tx.execute(sql`select s.id::text as id, s.request_id::text as "requestId", s.signer_id as "signerId", s.method, s.intent_version as "intentVersion", s.sha256,
      to_char(s.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "signedAt", r.status, r.signer_id as "requestSigner"
    from documents_signatures s join documents_sign_requests r on (r.institution_id, r.id) = (s.institution_id, s.request_id)
    where s.institution_id = ${institutionId} and s.document_id = ${documentId}`)).rows as Record<string, string>[]
  if (!sig) return false
  if (sig.sha256 !== fileSha256 || sig.status !== 'signed' || sig.requestSigner !== sig.signerId) return false
  const [link] = (await tx.execute(sql`select c.seq::text as seq, c.prev_hash, c.hash, ${AUDIT_COLUMNS}
    from audit_chain c join audit_log a on a.id = c.audit_id where c.audit_id = ${sig.id}::uuid and c.institution_id = ${institutionId}`)).rows as unknown as ChainRow[]
  if (!link || link.id !== sig.id || link.institution_id !== institutionId || link.actor_id !== sig.signerId) return false
  if (link.module_id !== 'documents' || link.action !== 'document.assented' || link.entity !== 'documents_files' || link.entity_id !== documentId) return false
  const expected = { requestId: sig.requestId, signerId: sig.signerId, signedAt: sig.signedAt, method: sig.method, intentVersion: sig.intentVersion, sha256: sig.sha256 }
  const { recipientDigest, ...recorded } = (link.detail ? JSON.parse(link.detail) : {}) as Record<string, unknown>
  // the confirming mailbox is sealed in the audit row only (the request row is cleared on signing)
  if (typeof recipientDigest !== 'string' || !/^[0-9a-f]{64}$/.test(recipientDigest) || JSON.stringify(Object.entries(recorded).sort()) !== JSON.stringify(Object.entries(expected).sort())) return false
  const seq = Number(link.seq)
  let before: Buffer
  if (seq === 1) before = genesis(institutionId)
  else {
    const [previous] = (await tx.execute(sql`select hash from audit_chain where institution_id = ${institutionId} and seq = ${seq - 1}`)).rows as { hash: Buffer }[]
    if (!previous) return false
    before = previous.hash
  }
  return link.prev_hash.equals(before) && rowHash(before, institutionId, link).equals(link.hash)
}

/** One document's state, from its stored bytes, never from its recorded hash alone. */
export async function integrityOf(tx: Tx, institutionId: string, documentId: string, actualSha256: string, storedSha256: string): Promise<IntegrityState> {
  if (actualSha256 !== storedSha256) return 'mismatch'
  const [{ signed } = { signed: false }] = (await tx.execute(sql`select (exists (select 1 from documents_signatures where institution_id = ${institutionId} and document_id = ${documentId})
    or exists (select 1 from documents_sign_requests where institution_id = ${institutionId} and document_id = ${documentId} and status = 'signed')) as signed`)).rows as { signed: boolean }[]
  if (!signed) return 'unsigned'
  return (await evidenceHolds(tx, institutionId, documentId, storedSha256)) ? 'verified' : 'mismatch'
}
