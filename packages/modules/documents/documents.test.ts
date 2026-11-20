import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { sql } from 'drizzle-orm'
import type { PluginActor, Role } from '@campusos/module-framework'

interface Workflow {
  uploadDocument(actor: PluginActor, input: unknown): Promise<{ documentId: string; notice: string }>
  requestAssent(actor: PluginActor, input: unknown): Promise<{ requestId: string; notice: string }>
  issueAssentChallenge(actor: PluginActor, input: unknown): Promise<{ requestId: string; recipient: string; code: string }>
  markChallengeDeliveryFailed(actor: PluginActor, requestId: string, code: string): Promise<void>
  closeAssent(actor: PluginActor, input: unknown): Promise<{ notice: string }>
  recordAssent(actor: PluginActor, input: unknown): Promise<{ signatureId: string; notice: string }>
  downloadDocument(actor: PluginActor, id: string): Promise<Response>
  signingReceipt(actor: PluginActor, id: string): Promise<Response>
  verifyDocument(actor: PluginActor, input: unknown): Promise<{ integrity: string; copyMatches: boolean | null }>
}

async function workflow(): Promise<Workflow> {
  const entry = new URL('./api/index.ts', import.meta.url).href
  try {
    return await import(entry) as Workflow
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && (error as { url?: string }).url === entry) {
      assert.fail('The Documents store and signing API is missing')
    }
    throw error
  }
}

const tenants: string[] = []
after(async () => {
  if (tenants.length === 0) return
  const { authDb, institutions } = await import('@campusos/db')
  const { inArray } = await import('drizzle-orm')
  await authDb.delete(institutions).where(inArray(institutions.id, tenants))
})

async function college() {
  const { authDb, institutions, users } = await import('@campusos/db')
  const slug = `documents-test-${randomUUID()}`
  const [institution] = await authDb.insert(institutions).values({ name: 'Test college', slug }).returning()
  const id = institution!.id
  tenants.push(id)
  const roles: Role[] = ['institution_admin', 'student', 'faculty', 'student', 'parent']
  const people = await authDb.insert(users).values(roles.map((role, index) => ({ institutionId: id, role, email: `${index}@${slug}.test` }))).returning()
  const actor = (index: number): PluginActor => ({ ...people[index]!, institutionId: id })
  return { id, admin: actor(0), signer: actor(1), faculty: actor(2), other: actor(3), parent: actor(4) }
}

async function pdf() {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  doc.addPage()
  const bytes = Buffer.from(await doc.save())
  const file = { name: 'offer.pdf', type: 'application/pdf', size: bytes.length, base64: bytes.toString('base64') }
  return { bytes, file, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function offer(api: Workflow, { admin, signer }: Awaited<ReturnType<typeof college>>) {
  const original = await pdf()
  const { documentId } = await api.uploadDocument(admin, {
    title: 'Ordinary offer', kind: 'offer', scope: 'signer', subjectUserId: signer.id, file: original.file,
    retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
    retentionBasis: 'specified_purpose', authorityRef: 'Offer records policy',
  })
  const { requestId } = await api.requestAssent(admin, { documentId, reason: 'Send the offer for acceptance', approvedInternalUse: true })
  return { documentId, requestId, ...original }
}

test('offered PDF and assent evidence verify by exact bytes', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer } = campus
  const { documentId, requestId, bytes, sha256 } = await offer(api, campus)
  await assert.rejects(() => api.issueAssentChallenge(signer, { requestId }), { code: 'document_open_first' })
  const file = await api.downloadDocument(signer, documentId)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
  await assert.rejects(() => api.recordAssent(signer, { requestId, code: 'x'.repeat(32), consent: true }), { code: 'challenge_invalid' })
  assert.equal((await api.verifyDocument(signer, { documentId })).integrity, 'unsigned')
  const { code } = await api.issueAssentChallenge(signer, { requestId })
  const assent = await api.recordAssent(signer, { requestId, code, consent: true })
  assert.ok(assent.signatureId)
  assert.deepEqual(await api.recordAssent(signer, { requestId, code, consent: true }), assent)
  assert.deepEqual(await api.verifyDocument(signer, { documentId, sha256 }), { integrity: 'verified', copyMatches: true })
  assert.deepEqual(await api.verifyDocument(signer, { documentId, sha256: '0'.repeat(64) }), { integrity: 'verified', copyMatches: false })
  assert.deepEqual(Buffer.from(await (await api.downloadDocument(signer, documentId)).arrayBuffer()), bytes)
  assert.equal((await api.signingReceipt(signer, documentId)).headers.get('content-type'), 'application/pdf')
})

test('unauthorized reader receives no document or metadata', async () => {
  const api = await workflow()
  const { admin, signer, faculty, other } = await college()
  const foreign = await college()
  const { file } = await pdf()
  const { documentId } = await api.uploadDocument(admin, {
    title: 'Academic record', kind: 'record', scope: 'student_academic', subjectUserId: signer.id, file,
  })
  for (const denied of [faculty, other, foreign.admin, { ...faculty, authzReportOnly: true }]) {
    await assert.rejects(() => api.verifyDocument(denied, { documentId }), { code: 'document_missing' })
    await assert.rejects(() => api.downloadDocument(denied, documentId), { code: 'document_missing' })
  }
})

test('changed bytes fail verification', async () => {
  const api = await workflow()
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const campus = await college()
  const { documentId, bytes } = await offer(api, campus)
  const changed = Buffer.concat([bytes, Buffer.from('\nChanged')])
  const replace = (body: Buffer) => authDb.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`)
    await tx.execute(sql`update documents_files set body = ${body} where id = ${documentId}`)
  })
  await replace(changed)
  try {
    assert.deepEqual(await api.verifyDocument(campus.signer, { documentId }), { integrity: 'mismatch', copyMatches: null })
    await assert.rejects(() => api.downloadDocument(campus.signer, documentId), { code: 'document_integrity' })
  } finally {
    await replace(bytes)
  }
})

// Schema, tenant isolation, erasure and retention (Step 2).
async function denied(run: () => Promise<unknown>, pattern: RegExp) {
  try { await run() } catch (error) {
    const text = String((error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message)
    assert.match(text, pattern)
    return
  }
  assert.fail('expected the database to refuse')
}
type Campus = Awaited<ReturnType<typeof college>>
interface Fixture { documentId: string; requestId: string; signatureId: string; bytes: Buffer }

async function seedFile(campus: Campus, over: { scope?: string; kind?: string; subject?: string; ageDays?: number; retainUntilDays?: number } = {}) {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const id = randomUUID()
  const bytes = Buffer.from(`%PDF-1.4 ${id}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const scope = over.scope ?? 'office'
  const kind = over.kind ?? (scope === 'signer' ? 'offer' : 'record')
  const signer = scope === 'signer'
  const age = over.ageDays ?? 0
  const retain = signer ? sql`now() - make_interval(days => ${age}) + make_interval(days => ${over.retainUntilDays ?? 30})` : sql`null`
  await authDb.execute(sql`insert into documents_files (id, institution_id, subject_user_id, kind, scope, title, media_type, body, sha256, created_at, retention_basis, authority_ref, retain_until)
    values (${id}, ${campus.id}, ${over.subject ?? campus.signer.id}, ${kind}, ${scope}, 'Title', 'application/pdf', ${bytes}, ${sha256}, now() - make_interval(days => ${age}),
    ${signer ? 'specified_purpose' : null}, ${signer ? 'Offer records policy' : null}, ${retain})`)
  return { id, bytes, sha256 }
}

async function seedSigned(campus: Campus, over: { ageDays?: number; retainUntilDays?: number } = {}): Promise<Fixture> {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const file = await seedFile(campus, { scope: 'signer', ...over })
  const requestId = randomUUID()
  const signatureId = randomUUID()
  await authDb.execute(sql`insert into documents_sign_requests (id, institution_id, document_id, signer_id, created_at, expires_at)
    select ${requestId}, ${campus.id}, ${file.id}, ${campus.signer.id}, created_at, created_at + interval '7 days' from documents_files where id = ${file.id}`)
  await authDb.execute(sql`update documents_sign_requests set viewed_at = created_at + interval '1 hour', code_digest = repeat('a', 64), recipient_digest = repeat('b', 64),
    code_issued_at = created_at + interval '1 hour', code_expires_at = created_at + interval '70 minutes' where id = ${requestId}`)
  const [row] = (await authDb.execute(sql`select to_char(date_trunc('milliseconds', created_at + interval '65 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from documents_files where id = ${file.id}`)).rows as { at: string }[]
  const detail = { requestId, signerId: campus.signer.id, signedAt: row!.at, method: 'account_mailbox_v1', intentVersion: 'documents-assent-v1', sha256: file.sha256, recipientDigest: 'b'.repeat(64) }
  await authDb.execute(sql`insert into audit_log (id, institution_id, actor_id, module_id, action, entity, entity_id, reason, detail)
    values (${signatureId}, ${campus.id}, ${campus.signer.id}, 'documents', 'document.assented', 'documents_files', ${file.id}, 'Signer recorded assent', ${JSON.stringify(detail)}::jsonb)`)
  await authDb.execute(sql`insert into documents_signatures (id, institution_id, document_id, request_id, signer_id, signed_at, method, intent_version, sha256)
    values (${signatureId}, ${campus.id}, ${file.id}, ${requestId}, ${campus.signer.id}, ${row!.at}, 'account_mailbox_v1', 'documents-assent-v1', ${file.sha256})`)
  await authDb.execute(sql`update documents_sign_requests set status = 'signed', decided_at = ${row!.at}, code_digest = null, recipient_digest = null, code_expires_at = null, code_issued_at = null where id = ${requestId}`)
  return { documentId: file.id, requestId, signatureId, bytes: file.bytes }
}

async function pendingRequest(campus: Campus, documentId: string, signerId: string, expired = false) {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const id = randomUUID()
  await authDb.execute(sql`insert into documents_sign_requests (id, institution_id, document_id, signer_id, expires_at) values (${id}, ${campus.id}, ${documentId}, ${signerId}, now() + interval '1 day')`)
  await authDb.execute(expired
    ? sql`update documents_sign_requests set viewed_at = now(), code_digest = repeat('a', 64), recipient_digest = repeat('b', 64), code_issued_at = now() - interval '20 minutes', code_expires_at = now() - interval '10 minutes' where id = ${id}`
    : sql`update documents_sign_requests set viewed_at = now(), code_digest = repeat('a', 64), recipient_digest = repeat('b', 64), code_issued_at = now(), code_expires_at = now() + interval '5 minutes' where id = ${id}`)
  return id
}

test('schema: tenants cannot read or write the documents of another', async () => {
  const { withTenant } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const a = await college()
  const b = await college()
  const file = await seedFile(a)
  const rows = await withTenant(b.id, tx => tx.execute(sql`select id from documents_files where id = ${file.id}`))
  assert.equal(rows.rows.length, 0)
  const own = await withTenant(a.id, tx => tx.execute(sql`select id from documents_files where id = ${file.id}`))
  assert.equal(own.rows.length, 1)
  await denied(() => withTenant(b.id, tx => tx.execute(sql`insert into documents_files (institution_id, subject_user_id, kind, scope, title, media_type, body, sha256)
    values (${a.id}, ${a.signer.id}, 'record', 'office', 'x', 'application/pdf', ${file.bytes}, ${file.sha256})`)), /row-level security|invalid document subject/)
  const signerFile = await seedFile(a, { scope: 'signer' })
  await denied(() => withTenant(b.id, tx => tx.execute(sql`insert into documents_sign_requests (institution_id, document_id, signer_id, expires_at)
    values (${b.id}, ${signerFile.id}, ${a.signer.id}, now() + interval '1 day')`)), /foreign key|violates|invalid signing request/)
})

test('schema: file and request rules are enforced by the database', async () => {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const campus = await college()
  const digest = createHash('sha256').update('a').digest('hex')
  const bad = (scope: string, kind: string, extra: ReturnType<typeof sql>) => authDb.execute(sql`insert into documents_files (institution_id, subject_user_id, kind, scope, title, media_type, body, sha256, retention_basis, authority_ref, retain_until)
    values (${campus.id}, ${campus.signer.id}, ${kind}, ${scope}, 'x', 'application/pdf', ${Buffer.from('a')}, ${digest}, ${extra})`)
  await denied(() => bad('signer', 'record', sql`null, null, null`), /check/i)
  await denied(() => bad('office', 'offer', sql`null, null, null`), /check/i)
  await denied(() => bad('signer', 'offer', sql`'specified_purpose', 'Policy 1', now() + interval '2 days'`), /check/i)
  await denied(() => bad('signer', 'offer', sql`'specified_purpose', 'Policy 1', now() + interval '11 years'`), /check/i)
  await denied(() => authDb.execute(sql`insert into documents_files (institution_id, subject_user_id, kind, scope, title, media_type, body, sha256)
    values (${campus.id}, ${campus.signer.id}, 'record', 'office', 'x', 'application/pdf', ${Buffer.from('a')}, ${'0'.repeat(64)})`), /invalid document subject or hash/)
  await denied(() => authDb.execute(sql`insert into documents_files (institution_id, subject_user_id, kind, scope, title, media_type, body, sha256)
    values (${campus.id}, ${campus.faculty.id}, 'record', 'student_academic', 'x', 'application/pdf', ${Buffer.from('a')}, ${digest})`), /invalid document subject or hash/)
  const unsigned = await seedFile(campus, { scope: 'signer' })
  await denied(() => authDb.execute(sql`update documents_files set title = 'changed' where id = ${unsigned.id}`), /immutable/)
  await denied(() => authDb.execute(sql`delete from documents_files where id = ${unsigned.id}`), /immutable/)
  await pendingRequest(campus, unsigned.id, campus.signer.id)
  await denied(() => pendingRequest(campus, unsigned.id, campus.signer.id), /duplicate|unique/)
  const second = await seedFile(campus, { scope: 'signer' })
  await denied(() => pendingRequest(campus, second.id, campus.other.id), /invalid signing request/)
})

test('schema: signed evidence is append-only and needs a matching audit row', async () => {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const campus = await college()
  const signed = await seedSigned(campus)
  await denied(() => authDb.execute(sql`update documents_signatures set sha256 = repeat('1', 64) where id = ${signed.signatureId}`), /append-only/)
  await denied(() => authDb.execute(sql`delete from documents_signatures where id = ${signed.signatureId}`), /append-only/)
  await denied(() => authDb.execute(sql`delete from documents_files where id = ${signed.documentId}`), /immutable/)
  await denied(() => authDb.execute(sql`update documents_sign_requests set status = 'declined', decided_at = now() where id = ${signed.requestId}`), /invalid signing transition/)
  const second = await seedFile(campus, { scope: 'signer' })
  const request = await pendingRequest(campus, second.id, campus.signer.id)
  await denied(() => authDb.execute(sql`insert into documents_signatures (id, institution_id, document_id, request_id, signer_id, signed_at, method, intent_version, sha256)
    values (${randomUUID()}, ${campus.id}, ${second.id}, ${request}, ${campus.signer.id}, now(), 'account_mailbox_v1', 'documents-assent-v1', ${second.sha256})`), /append-only/)
  await denied(() => authDb.execute(sql`update documents_sign_requests set status = 'signed', decided_at = now() where id = ${request}`), /invalid signing transition/)
})

test('schema: deleting an institution still removes its documents', async () => {
  const { authDb, institutions } = await import('@campusos/db')
  const { sql, eq } = await import('drizzle-orm')
  const campus = await college()
  const signed = await seedSigned(campus)
  await authDb.delete(institutions).where(eq(institutions.id, campus.id))
  tenants.splice(tenants.indexOf(campus.id), 1)
  const left = await authDb.execute(sql`select (select count(*) from documents_files where id = ${signed.documentId}) as f, (select count(*) from documents_signatures where document_id = ${signed.documentId}) as s`)
  assert.deepEqual(left.rows[0], { f: '0', s: '0' })
})

test('erasure: an unsigned subject file and its challenge go, signed evidence stays, export is minimal', async () => {
  const { authDb, eraseSubject, exportSubject } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const campus = await college()
  const unsigned = await seedFile(campus, { scope: 'signer', subject: campus.other.id })
  await pendingRequest(campus, unsigned.id, campus.other.id)
  const signed = await seedSigned(campus)
  const by = { actorId: campus.admin.id, reason: 'Erasure request DPDP-1' }
  const before = await exportSubject(campus.id, campus.signer.id)
  const filesRow = before.records['documents_files.subject_user_id']![0] as Record<string, unknown>
  assert.deepEqual(Object.keys(filesRow).sort(), ['created_at', 'id', 'kind', 'media_type', 'retain_until', 'retention_basis', 'scope'])
  assert.deepEqual(Object.keys(before.records['documents_signatures.signer_id']![0] as object).sort(), ['document_id', 'id', 'intent_version', 'method', 'sha256', 'signed_at'])
  assert.equal(before.records['documents_sign_requests.signer_id'], undefined)
  await eraseSubject(campus.id, campus.other.id, by)
  assert.equal((await authDb.execute(sql`select 1 from documents_files where id = ${unsigned.id}`)).rows.length, 0)
  assert.equal((await authDb.execute(sql`select 1 from documents_sign_requests where document_id = ${unsigned.id}`)).rows.length, 0)
  await eraseSubject(campus.id, campus.signer.id, by)
  assert.equal((await authDb.execute(sql`select 1 from documents_files where id = ${signed.documentId}`)).rows.length, 1)
  assert.equal((await authDb.execute(sql`select 1 from documents_signatures where id = ${signed.signatureId}`)).rows.length, 1)
})

test('purge: expired unsigned and signed files are removed, current ones are kept', async () => {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const campus = await college()
  const old = await seedFile(campus, { ageDays: 100 })
  const fresh = await seedFile(campus)
  const expiredSigned = await seedSigned(campus, { ageDays: 20, retainUntilDays: 15 })
  const heldSigned = await seedSigned(campus)
  const pending = await seedFile(campus, { scope: 'signer' })
  const request = await pendingRequest(campus, pending.id, campus.signer.id, true)
  const result = (await authDb.execute(sql`select public.campusos_purge_expired(${campus.id}::uuid) as r`)).rows[0] as { r: Record<string, number> }
  assert.equal(result.r.documents_files, 2)
  assert.equal(result.r.documents_challenges, 1)
  const left = new Set((await authDb.execute(sql`select id from documents_files where institution_id = ${campus.id}`)).rows.map(row => (row as { id: string }).id))
  assert.deepEqual([old.id, fresh.id, expiredSigned.documentId, heldSigned.documentId, pending.id].map(id => left.has(id)), [false, true, false, true, true])
  const [req] = (await authDb.execute(sql`select code_digest from documents_sign_requests where id = ${request}`)).rows as { code_digest: string | null }[]
  assert.equal(req!.code_digest, null)
})

// Upload and audited authorization (Step 3).
const relationViews: string[] = []
after(async () => {
  if (relationViews.length === 0) return
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  for (const view of relationViews) await authDb.execute(sql.raw(`drop view if exists student_relations.${view}`))
})

async function teaches(viewerId: string, studentId: string) {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const view = `zz_documents_${randomUUID().replaceAll('-', '')}`
  relationViews.push(view)
  await authDb.execute(sql.raw(`create view student_relations.${view} with (security_invoker = true) as
    select '${viewerId}'::text as viewer_id, '${studentId}'::text as student_id, 'test'::text as relation, array['academic_record']::text[] as purposes`))
  await authDb.execute(sql.raw(`grant select on student_relations.${view} to campusos_app`))
}

async function readable(actor: PluginActor, documentId: string, write = false) {
  const { withTenant } = await import('@campusos/db')
  const core = await import('./api/index')
  return withTenant(actor.institutionId!, tx => core.requireDocument(tx, actor, documentId, write))
}

const status = (code: string, status: number) => (error: unknown) => (error as { code?: string }).code === code && (error as { status?: number }).status === status

test('authorization: academic records follow the student relation, never the role alone', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer: student, faculty, other, parent } = campus
  const { file } = await pdf()
  const { documentId } = await api.uploadDocument(admin, { title: 'Marksheet', kind: 'record', scope: 'student_academic', subjectUserId: student.id, file })
  await assert.rejects(() => readable(faculty, documentId), status('document_missing', 404))
  await teaches(faculty.id, student.id)
  const row = await readable(faculty, documentId)
  assert.equal(row.id, documentId)
  assert.equal(row.scope, 'student_academic')
  assert.equal(row.requestId, null)
  assert.equal((await readable(student, documentId)).id, documentId)
  assert.equal((await readable(admin, documentId)).id, documentId)
  assert.equal((await readable({ ...parent, viewerOf: [student.id] }, documentId)).id, documentId)
  for (const denied of [other, parent, { ...parent, viewerOf: [other.id] }]) {
    await assert.rejects(() => readable(denied, documentId), status('document_missing', 404))
  }
  await assert.rejects(() => readable(faculty, documentId, true), status('document_missing', 404))
  await assert.rejects(() => readable({ ...admin, id: 'no-such-user' }, documentId), status('document_missing', 404))
  await assert.rejects(() => readable(admin, 'not-a-uuid'), status('document_missing', 404))
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  await authDb.execute(sql`update users set erased_at = now() where id = ${faculty.id}`)
  await assert.rejects(() => readable(faculty, documentId), status('document_missing', 404))
})

test('authorization: office files are for administrators and a signable file shows only to its signer after a request', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer, faculty, other } = campus
  const { file } = await pdf()
  const office = await api.uploadDocument(admin, { title: 'Circular', kind: 'record', scope: 'office', subjectUserId: faculty.id, file })
  for (const denied of [signer, faculty, other]) await assert.rejects(() => readable(denied, office.documentId), status('document_missing', 404))
  assert.equal((await readable(admin, office.documentId)).title, 'Circular')
  const signable = await api.uploadDocument(admin, { title: 'Offer', kind: 'offer', scope: 'signer', subjectUserId: signer.id, file, retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'specified_purpose', authorityRef: 'Offer records policy' })
  const documentId = signable.documentId
  await assert.rejects(() => readable(signer, documentId), status('document_missing', 404))
  assert.equal((await readable(admin, documentId)).status, null)
  await pendingRequest(campus, documentId, signer.id)
  const row = await readable(signer, documentId)
  assert.equal(row.status, 'pending')
  assert.ok(row.expiresAt)
  for (const denied of [faculty, other, { ...signer, institutionId: (await college()).id }]) await assert.rejects(() => readable(denied, documentId), status('document_missing', 404))
})

test('upload: only administrators file documents, and every file is checked and audited', async () => {
  const api = await workflow()
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const campus = await college()
  const foreign = await college()
  const { admin, signer, faculty } = campus
  const good = await pdf()
  const base = { title: '  Policy  ', kind: 'record', scope: 'office', subjectUserId: faculty.id, file: good.file }
  await assert.rejects(() => api.uploadDocument(faculty, base), status('forbidden', 403))
  await assert.rejects(() => api.uploadDocument(signer, base), status('forbidden', 403))
  await assert.rejects(() => api.uploadDocument(admin, { ...base, subjectUserId: foreign.signer.id }), status('invalid_subject', 400))
  await assert.rejects(() => api.uploadDocument(admin, { ...base, scope: 'student_academic', subjectUserId: faculty.id }), status('invalid_subject', 400))
  const fake = { ...good.file, base64: Buffer.from('MZ not a pdf at all').toString('base64') }
  await assert.rejects(() => api.uploadDocument(admin, { ...base, file: fake }), status('wrong_type', 400))
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)])
  await assert.rejects(() => api.uploadDocument(admin, { ...base, file: { ...good.file, size: big.length, base64: big.toString('base64') } }), status('too_large', 400))
  const png = { name: 'a.png', type: 'image/png', size: 8, base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }
  await assert.rejects(() => api.uploadDocument(admin, { ...base, kind: 'offer', scope: 'signer', subjectUserId: signer.id, file: png, retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'specified_purpose', authorityRef: 'Policy 1' }), status('wrong_type', 400))
  const signable = { ...base, kind: 'offer', scope: 'signer', subjectUserId: signer.id }
  await assert.rejects(() => api.uploadDocument(admin, signable), status('retention_required', 400))
  await assert.rejects(() => api.uploadDocument(admin, { ...signable, retainUntil: new Date(Date.now() + 2 * 86400_000).toISOString(), retentionBasis: 'legal_obligation', authorityRef: 'Policy 1' }), status('retention_range', 400))
  await assert.rejects(() => api.uploadDocument(admin, { ...base, retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'legal_obligation', authorityRef: 'Policy 1' }), status('retention_required', 400))
  await assert.rejects(() => api.uploadDocument(admin, { ...base, kind: 'contract' }), /Offers, contracts and agreements/)
  const stored = await api.uploadDocument(admin, base)
  assert.equal(stored.notice, 'Document stored.')
  const [row] = (await authDb.execute(sql`select title, encode(body, 'hex') as hex, sha256, media_type from documents_files where id = ${stored.documentId}`)).rows as { title: string; hex: string; sha256: string; media_type: string }[]
  assert.deepEqual([row!.title, row!.hex, row!.sha256, row!.media_type], ['Policy', good.bytes.toString('hex'), good.sha256, 'application/pdf'])
  const audits = (await authDb.execute(sql`select actor_id, actor_email, detail::text as detail from audit_log where entity_id = ${stored.documentId} and action = 'document.uploaded'`)).rows as { actor_id: string; actor_email: string | null; detail: string }[]
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.actor_id, admin.id)
  assert.equal(audits[0]!.actor_email, null)
  assert.ok(!audits[0]!.detail.includes('Policy'))
})

// Integrity and evidence reads (Step 4).
async function tamper(statement: ReturnType<typeof import('drizzle-orm').sql>) {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  await authDb.transaction(async tx => {
    await tx.execute(sql`set local session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function auditCount(documentId: string, action: string) {
  const { authDb } = await import('@campusos/db')
  const { sql } = await import('drizzle-orm')
  const [row] = (await authDb.execute(sql`select count(*)::int as n from audit_log where entity_id = ${documentId} and action = ${action}`)).rows as { n: number }[]
  return row!.n
}

const everything = async (campus: Campus, who: PluginActor) => {
  const core = await import('./api/index')
  return core.listDocuments(who, { q: null, sort: 'newest', dir: 'desc', limit: 20, after: null })
}

test('reads: a list shows only what the reader may open, newest first, with each integrity state', async () => {
  const campus = await college()
  const other = await college()
  const { admin, signer, faculty } = campus
  const signed = await seedSigned(campus)
  const unsignedFile = await seedFile(campus, { scope: 'signer' })
  await pendingRequest(campus, unsignedFile.id, signer.id)
  const hidden = await seedFile(campus, { scope: 'signer', subject: signer.id })
  const office = await seedFile(campus, { subject: faculty.id })
  const academic = await seedFile(campus, { scope: 'student_academic', subject: signer.id })
  const asAdmin = await everything(campus, admin)
  assert.equal(asAdmin.total, 5)
  assert.deepEqual(asAdmin.rows.map(row => row.id), [academic.id, office.id, hidden.id, unsignedFile.id, signed.documentId])
  const states = Object.fromEntries(asAdmin.rows.map(row => [row.id, row.integrity]))
  assert.equal(states[signed.documentId], 'verified')
  assert.equal(states[unsignedFile.id], 'unsigned')
  const mine = await everything(campus, signer)
  assert.deepEqual(mine.rows.map(row => row.id).sort(), [academic.id, unsignedFile.id, signed.documentId].sort())
  assert.equal(mine.total, 3)
  assert.equal((await everything(campus, faculty)).total, 0)
  assert.equal((await everything(other, other.admin)).total, 0)
  const core = await import('./api/index')
  const first = await core.listDocuments(admin, { q: null, sort: 'newest', dir: 'desc', limit: 2, after: null })
  assert.equal(first.rows.length, 2)
  assert.ok(first.next)
  const readPage = (cursor: string) => core.readDocumentPage(new Request(`http://localhost/files?after=${cursor}&n=2`))
  const second = await core.listDocuments(admin, readPage(first.next!))
  assert.equal(second.rows.length, 2)
  assert.deepEqual(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 4)
  await assert.rejects(() => core.listDocuments(faculty, { q: null, sort: 'newest', dir: 'desc', limit: 20, after: null }, signer.id), status('document_missing', 404))
  await teaches(faculty.id, signer.id)
  const forStudent = await core.listDocuments(faculty, { q: null, sort: 'newest', dir: 'desc', limit: 20, after: null }, signer.id)
  assert.deepEqual(forStudent.rows.map(row => row.id), [academic.id])
})

test('reads: the exact bytes come back once, audited, and a changed file is refused with no bytes', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer, faculty } = campus
  const signed = await seedSigned(campus)
  const response = await api.downloadDocument(signer, signed.documentId)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-disposition')!, /attachment; filename="document\.pdf"/)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), signed.bytes)
  assert.equal(await auditCount(signed.documentId, 'document.read'), 1)
  await assert.rejects(() => api.downloadDocument(faculty, signed.documentId), status('document_missing', 404))
  assert.equal(await auditCount(signed.documentId, 'document.read'), 1)
  await tamper(sql`update documents_files set body = ${Buffer.from('%PDF-1.4 changed')} where id = ${signed.documentId}`)
  await assert.rejects(() => api.downloadDocument(admin, signed.documentId), status('document_integrity', 409))
  assert.equal(await auditCount(signed.documentId, 'document.integrity_failed'), 1)
  assert.equal(await auditCount(signed.documentId, 'document.read'), 1)
  assert.deepEqual(await api.verifyDocument(admin, { documentId: signed.documentId }), { integrity: 'mismatch', copyMatches: null })
  await assert.rejects(() => api.signingReceipt(signer, signed.documentId), status('document_integrity', 409))
})

test('reads: verification names a different copy, and missing or altered evidence fails', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer } = campus
  const signed = await seedSigned(campus)
  const sha = createHash('sha256').update(signed.bytes).digest('hex')
  assert.deepEqual(await api.verifyDocument(signer, { documentId: signed.documentId, sha256: sha }), { integrity: 'verified', copyMatches: true })
  assert.deepEqual(await api.verifyDocument(signer, { documentId: signed.documentId, sha256: '1'.repeat(64) }), { integrity: 'verified', copyMatches: false })
  assert.deepEqual(await api.verifyDocument(signer, { documentId: signed.documentId }), { integrity: 'verified', copyMatches: null })
  await assert.rejects(() => api.verifyDocument(signer, { documentId: signed.documentId, sha256: 'ABC' }), /64 lowercase hex/)
  assert.equal(await auditCount(signed.documentId, 'document.read'), 3)
  await tamper(sql`update audit_log set reason = 'Altered after the fact' where id = ${signed.signatureId}`)
  assert.equal((await api.verifyDocument(signer, { documentId: signed.documentId })).integrity, 'mismatch')
  const second = await seedSigned(campus)
  await tamper(sql`delete from audit_chain where audit_id = ${second.signatureId}`)
  assert.equal((await api.verifyDocument(signer, { documentId: second.documentId })).integrity, 'mismatch')
  const third = await seedSigned(campus)
  await tamper(sql`update audit_log set detail = jsonb_set(detail, '{sha256}', to_jsonb(repeat('2', 64))) where id = ${third.signatureId}`)
  assert.equal((await api.verifyDocument(signer, { documentId: third.documentId })).integrity, 'mismatch')
  assert.equal(await auditCount(second.documentId, 'document.integrity_failed'), 1)
})

test('reads: the evidence PDF states the record and never carries the original', async () => {
  const api = await workflow()
  const { printedText } = await import('@campusos/module-framework/pdf')
  const campus = await college()
  const { signer, faculty } = campus
  const signed = await seedSigned(campus)
  const receipt = await api.signingReceipt(signer, signed.documentId)
  assert.equal(receipt.headers.get('content-type'), 'application/pdf')
  assert.match(receipt.headers.get('content-disposition')!, /document-assent\.pdf/)
  const bytes = Buffer.from(await receipt.arrayBuffer())
  assert.ok(!bytes.includes(signed.bytes))
  const printed = (await printedText(bytes)).join('\n')
  const sha = createHash('sha256').update(signed.bytes).digest('hex')
  for (const expected of ['Electronic assent record', signed.documentId, signed.requestId, signer.id, 'account_mailbox_v1', 'documents-assent-v1', sha, 'not a certified or statutory digital signature']) assert.ok(printed.includes(expected), expected)
  await assert.rejects(() => api.signingReceipt(faculty, signed.documentId), status('document_missing', 404))
  const unsigned = await seedFile(campus, { scope: 'signer' })
  await pendingRequest(campus, unsigned.id, signer.id)
  await assert.rejects(() => api.signingReceipt(signer, unsigned.id), status('document_missing', 404))
})

// Sign request lifecycle (Step 5).
async function ready(api: Workflow, campus: Campus) {
  const sent = await offer(api, campus)
  await api.downloadDocument(campus.signer, sent.documentId)
  return sent
}

/** Hold a request's row lock in another transaction until `release` runs, so two callers queue behind it. */
async function holdingRequest<T>(requestId: string, during: () => Promise<T>): Promise<T> {
  const { authDb } = await import('@campusos/db')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let locked!: () => void
  const held = new Promise<void>(resolve => { locked = resolve })
  const holder = authDb.transaction(async tx => {
    await tx.execute(sql`select 1 from documents_sign_requests where id = ${requestId} for update`)
    locked()
    await gate
  })
  await held
  const pending = during()
  await new Promise(resolve => setTimeout(resolve, 400))
  release()
  await holder
  return pending
}

const never = (value: unknown, name: string) => assert.ok(!JSON.stringify(value).includes(name), `${name} leaked`)

test('signing: only the named signer asks for a code, and only after downloading the exact file', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer, faculty, other } = campus
  const { documentId, requestId } = await offer(api, campus)
  await assert.rejects(() => api.issueAssentChallenge(admin, { requestId }), status('document_missing', 404))
  await assert.rejects(() => api.issueAssentChallenge(other, { requestId }), status('document_missing', 404))
  await assert.rejects(() => api.issueAssentChallenge(signer, { requestId }), status('document_open_first', 409))
  await api.downloadDocument(admin, documentId)
  await assert.rejects(() => api.issueAssentChallenge(signer, { requestId }), status('document_open_first', 409))
  await api.downloadDocument(faculty, documentId).catch(() => null)
  await api.downloadDocument(signer, documentId)
  const first = await api.issueAssentChallenge(signer, { requestId })
  assert.equal(first.code.length, 32)
  assert.equal(first.recipient, signer.email)
  await assert.rejects(() => api.issueAssentChallenge(signer, { requestId }), status('challenge_wait', 409))
  const [row] = (await (await import('@campusos/db')).authDb.execute(sql`select code_digest, recipient_digest, code_expires_at - code_issued_at as ttl from documents_sign_requests where id = ${requestId}`)).rows as { code_digest: string; recipient_digest: string; ttl: unknown }[]
  assert.match(row!.code_digest, /^[0-9a-f]{64}$/)
  assert.notEqual(row!.code_digest, first.code)
  const { authDb } = await import('@campusos/db')
  const audits = (await authDb.execute(sql`select detail::text as d, reason from audit_log where entity_id = ${documentId}`)).rows
  never(audits, first.code)
  never(audits, signer.email!)
})

test('signing: a code works once, for its own request, signer, mailbox and time', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer } = campus
  const { authDb } = await import('@campusos/db')
  const one = await ready(api, campus)
  const twin = await ready(api, { ...campus })
  const { code: oneCode } = await api.issueAssentChallenge(signer, { requestId: one.requestId })
  await assert.rejects(() => api.recordAssent(signer, { requestId: twin.requestId, code: oneCode, consent: true }), status('challenge_invalid', 409))
  await assert.rejects(() => api.recordAssent(signer, { requestId: one.requestId, code: oneCode, consent: false }), /Tick the box/)
  await assert.rejects(() => api.recordAssent(signer, { requestId: one.requestId, code: oneCode.toUpperCase(), consent: true }), status('challenge_invalid', 409))
  // a resend replaces the digest: the old code stops working
  await authDb.execute(sql`update documents_sign_requests set code_issued_at = code_issued_at - interval '2 minutes' where id = ${one.requestId}`)
  const { code: resent } = await api.issueAssentChallenge(signer, { requestId: one.requestId })
  assert.notEqual(resent, oneCode)
  await assert.rejects(() => api.recordAssent(signer, { requestId: one.requestId, code: oneCode, consent: true }), status('challenge_invalid', 409))
  // expired
  await tamper(sql`update documents_sign_requests set code_expires_at = clock_timestamp() - interval '1 second' where id = ${one.requestId}`)
  await assert.rejects(() => api.recordAssent(signer, { requestId: one.requestId, code: resent, consent: true }), status('challenge_invalid', 409))
  await authDb.execute(sql`update documents_sign_requests set code_issued_at = code_issued_at - interval '2 minutes' where id = ${one.requestId}`)
  const { code: again } = await api.issueAssentChallenge(signer, { requestId: one.requestId })
  // the mailbox changed after the code was sent
  await authDb.execute(sql`update users set email = ${`changed-${randomUUID()}@example.test`} where id = ${signer.id}`)
  await assert.rejects(() => api.recordAssent(signer, { requestId: one.requestId, code: again, consent: true }), status('challenge_invalid', 409))
  await authDb.execute(sql`update users set email = ${signer.email!} where id = ${signer.id}`)
  const done = await api.recordAssent(signer, { requestId: one.requestId, code: again, consent: true })
  assert.equal(done.notice, 'Assent recorded.')
  // the used code is gone, and a later erasure takes the access with it
  const [after] = (await authDb.execute(sql`select status, code_digest, recipient_digest, code_expires_at, code_issued_at from documents_sign_requests where id = ${one.requestId}`)).rows as Record<string, unknown>[]
  assert.deepEqual(after, { status: 'signed', code_digest: null, recipient_digest: null, code_expires_at: null, code_issued_at: null })
  const lateCode = await api.issueAssentChallenge(signer, { requestId: twin.requestId })
  await authDb.execute(sql`update users set erased_at = now() where id = ${signer.id}`)
  await assert.rejects(() => api.recordAssent(signer, { requestId: twin.requestId, code: lateCode.code, consent: true }), status('document_missing', 404))
})

test('signing: a failed delivery clears only the code that was sent', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer, other } = campus
  const { authDb } = await import('@campusos/db')
  const { requestId, documentId } = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(signer, { requestId })
  await api.markChallengeDeliveryFailed(signer, requestId, 'not-the-code')
  const [kept] = (await authDb.execute(sql`select code_digest from documents_sign_requests where id = ${requestId}`)).rows as { code_digest: string | null }[]
  assert.ok(kept!.code_digest)
  await assert.rejects(() => api.markChallengeDeliveryFailed(other, requestId, code), status('document_missing', 404))
  await api.markChallengeDeliveryFailed(signer, requestId, code)
  await assert.rejects(() => api.recordAssent(signer, { requestId, code, consent: true }), status('challenge_invalid', 409))
  assert.equal(await auditCount(documentId, 'document.challenge_delivery_failed'), 1)
  const next = await api.issueAssentChallenge(signer, { requestId })
  await api.markChallengeDeliveryFailed(signer, requestId, code)
  assert.equal((await api.recordAssent(signer, { requestId, code: next.code, consent: true })).notice, 'Assent recorded.')
  assert.equal(await auditCount(documentId, 'document.challenge_delivery_failed'), 1)
})

test('signing: two callers at once produce one signature and one audit event', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer } = campus
  const { requestId, documentId } = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(signer, { requestId })
  const both = await holdingRequest(requestId, () => Promise.all([
    api.recordAssent(signer, { requestId, code, consent: true }),
    api.recordAssent(signer, { requestId, code, consent: true }),
  ]))
  assert.equal(both[0]!.signatureId, both[1]!.signatureId)
  assert.equal(await auditCount(documentId, 'document.assented'), 1)
  const { authDb } = await import('@campusos/db')
  const [count] = (await authDb.execute(sql`select count(*)::int as n from documents_signatures where document_id = ${documentId}`)).rows as { n: number }[]
  assert.equal(count!.n, 1)
})

test('signing: a decline racing a signature leaves exactly one terminal state', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer } = campus
  const { authDb } = await import('@campusos/db')
  const { requestId, documentId } = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(signer, { requestId })
  const results = await holdingRequest(requestId, () => Promise.allSettled([
    api.recordAssent(signer, { requestId, code, consent: true }),
    api.closeAssent(signer, { requestId, decision: 'decline', reason: 'I do not accept these terms' }),
  ]))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(failure.reason.code, 'document_closed')
  const [row] = (await authDb.execute(sql`select r.status, (select count(*) from documents_signatures s where s.request_id = r.id)::int as signatures from documents_sign_requests r where r.id = ${requestId}`)).rows as { status: string; signatures: number }[]
  assert.equal(row!.signatures, row!.status === 'signed' ? 1 : 0)
  assert.ok(['signed', 'declined'].includes(row!.status))
  assert.equal(await auditCount(documentId, 'document.assented') + await auditCount(documentId, 'document.declined'), 1)
})

test('signing: an expired request records nothing', async () => {
  const api = await workflow()
  const campus = await college()
  const { signer } = campus
  const { authDb } = await import('@campusos/db')
  const { requestId, documentId } = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(signer, { requestId })
  await tamper(sql`update documents_sign_requests set expires_at = created_at + interval '1 millisecond', code_expires_at = created_at + interval '1 millisecond' where id = ${requestId}`)
  await assert.rejects(() => api.recordAssent(signer, { requestId, code, consent: true }), status('document_expired', 409))
  await assert.rejects(() => api.issueAssentChallenge(signer, { requestId }), status('document_expired', 409))
  await assert.rejects(() => api.closeAssent(signer, { requestId, decision: 'decline', reason: 'Too late to answer now' }), status('document_expired', 409))
  assert.equal((await readable(signer, documentId)).status, 'expired')
  const [count] = (await authDb.execute(sql`select count(*)::int as n from documents_signatures where document_id = ${documentId}`)).rows as { n: number }[]
  assert.equal(count!.n, 0)
})

test('signing: requests are one per file, closed for good once decided, and only an administrator cancels', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer, faculty } = campus
  const sent = await offer(api, campus)
  const second = await api.uploadDocument(admin, { title: 'Contract', kind: 'contract', scope: 'signer', subjectUserId: signer.id, file: (await pdf()).file,
    retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'legal_obligation', authorityRef: 'Contracts register' })
  const raced = await Promise.allSettled([
    api.requestAssent(admin, { documentId: second.documentId, reason: 'Send the contract for acceptance', approvedInternalUse: true }),
    api.requestAssent(admin, { documentId: second.documentId, reason: 'Send the contract for acceptance', approvedInternalUse: true }),
  ])
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((raced.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'document_closed')
  await assert.rejects(() => api.requestAssent(admin, { documentId: sent.documentId, reason: 'Send the offer again please', approvedInternalUse: true }), status('document_closed', 409))
  await assert.rejects(() => api.requestAssent(admin, { documentId: sent.documentId, reason: 'short', approvedInternalUse: true }), /10/)
  await assert.rejects(() => api.requestAssent(admin, { documentId: sent.documentId, reason: 'Send the offer again please', approvedInternalUse: false }), /approved for internal/)
  await assert.rejects(() => api.requestAssent(faculty, { documentId: sent.documentId, reason: 'Send the offer again please', approvedInternalUse: true }), status('forbidden', 403))
  const office = await api.uploadDocument(admin, { title: 'Circular', kind: 'record', scope: 'office', subjectUserId: faculty.id, file: (await pdf()).file })
  await assert.rejects(() => api.requestAssent(admin, { documentId: office.documentId, reason: 'Send the circular for acceptance', approvedInternalUse: true }), status('not_signable', 400))
  await assert.rejects(() => api.closeAssent(signer, { requestId: sent.requestId, decision: 'cancel', reason: 'Signer cannot cancel this' }), status('forbidden', 403))
  await assert.rejects(() => api.closeAssent(faculty, { requestId: sent.requestId, decision: 'decline', reason: 'Not the named signer here' }), status('document_missing', 404))
  assert.deepEqual(await api.closeAssent(admin, { requestId: sent.requestId, decision: 'cancel', reason: 'Offer withdrawn by the office' }), { notice: 'Signing cancelled.' })
  await assert.rejects(() => api.closeAssent(signer, { requestId: sent.requestId, decision: 'decline', reason: 'Declining after the cancel' }), status('document_closed', 409))
  await assert.rejects(() => api.issueAssentChallenge(signer, { requestId: sent.requestId }), status('document_closed', 409))
  await assert.rejects(() => api.requestAssent(admin, { documentId: sent.documentId, reason: 'Reopen the cancelled request', approvedInternalUse: true }), status('document_closed', 409))
  assert.equal((await readable(signer, sent.documentId)).status, 'cancelled')
  const declined = await ready(api, campus)
  assert.deepEqual(await api.closeAssent(signer, { requestId: declined.requestId, decision: 'decline', reason: 'I do not accept these terms' }), { notice: 'Signing declined.' })
  assert.equal(await auditCount(declined.documentId, 'document.declined'), 1)
  assert.equal(await auditCount(sent.documentId, 'document.cancelled'), 1)
  assert.equal(await auditCount(sent.documentId, 'document.requested'), 1)
})

test('signing: a changed original cannot be requested, confirmed or signed', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer } = campus
  const sent = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(signer, { requestId: sent.requestId })
  await tamper(sql`update documents_files set body = ${Buffer.from('%PDF-1.4 swapped')} where id = ${sent.documentId}`)
  await assert.rejects(() => api.recordAssent(signer, { requestId: sent.requestId, code, consent: true }), status('document_integrity', 409))
  assert.equal(await auditCount(sent.documentId, 'document.integrity_failed'), 1)
  const fresh = await college()
  const upload = await api.uploadDocument(fresh.admin, { title: 'Offer', kind: 'offer', scope: 'signer', subjectUserId: fresh.signer.id, file: (await pdf()).file,
    retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'specified_purpose', authorityRef: 'Offer records policy' })
  await tamper(sql`update documents_files set body = ${Buffer.from('%PDF-1.4 swapped')} where id = ${upload.documentId}`)
  await assert.rejects(() => api.requestAssent(fresh.admin, { documentId: upload.documentId, reason: 'Send the offer for acceptance', approvedInternalUse: true }), status('document_integrity', 409))
  void admin
})

test('plugin: the signed export carries a read-only mail hook beside its routes', async () => {
  const exported = await import('./plugin')
  const core = await import('./api/index')
  assert.equal(exported.default, exported.plugin)
  assert.equal(exported.plugin.manifest.id, 'documents')
  assert.ok(Object.isFrozen(exported.plugin) && Object.isFrozen(exported.plugin.assentMailer))
  assert.equal(exported.plugin.assentMailer.issue, core.issueAssentChallenge)
  assert.equal(exported.plugin.assentMailer.deliveryFailed, core.markChallengeDeliveryFailed)
  assert.throws(() => { (exported.plugin.assentMailer as { issue: unknown }).issue = () => undefined }, TypeError)
})

// Plugin routes and page (Step 7).
async function plugin() {
  return (await import('./plugin')).plugin
}

async function route(method: string, path: string, actor: PluginActor, request: Request) {
  const found = (await plugin()).routes.find(candidate => candidate.method === method && candidate.path === path)
  assert.ok(found, `${method} ${path}`)
  return found.handler(actor, request)
}

const url = (path: string, query = '') => `http://localhost/api/v1/modules/documents${path}${query}`
const json = (path: string, body: unknown) => new Request(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function sectionsOf(page: Awaited<ReturnType<typeof plugin>>['pages'], data: Record<string, unknown>) {
  const sections = page![0]!.sections(data)
  const titles = sections.flatMap(section => ('title' in section && section.title) ? [section.title] : [])
  const labels = sections.flatMap(section => section.kind === 'shortcuts' ? section.items.map(item => item.label) : [])
  return { sections, titles, labels, all: [...titles, ...labels] }
}

test('routes: eight mounted paths with the planned roles, and raw files stay raw', async () => {
  const exported = await plugin()
  const { ADMIN, MEMBERS } = await import('@campusos/module-framework')
  const table = Object.fromEntries(exported.routes.map(candidate => [`${candidate.method} ${candidate.path}`, candidate.roles]))
  assert.deepEqual(table, {
    'GET /files': MEMBERS, 'GET /file': MEMBERS, 'GET /receipt.pdf': MEMBERS, 'POST /verify': MEMBERS,
    'POST /upload': ADMIN, 'POST /request': ADMIN, 'POST /sign': MEMBERS, 'POST /close': MEMBERS,
  })
  assert.deepEqual(exported.routes.filter(candidate => candidate.raw).map(candidate => candidate.path).sort(), ['/file', '/receipt.pdf'])
  assert.deepEqual(Object.keys(exported.openapiPaths).sort(), ['/file', '/files', '/receipt.pdf', '/request', '/sign', '/upload', '/verify', '/close'].map(path => `/api/v1/modules/documents${path}`).sort())
  assert.equal(exported.manifest.routeRoles, true)
})

test('routes: an administrator uploads and requests, the signer downloads and signs, over the mounted handlers', async () => {
  const campus = await college()
  const { admin, signer, faculty } = campus
  const { file, bytes, sha256 } = await pdf()
  const uploaded = await route('POST', '/upload', admin, json('/upload', { title: 'Offer', kind: 'offer', scope: 'signer', subjectUserId: signer.id, file,
    retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'specified_purpose', authorityRef: 'Offer records policy' })) as { documentId: string; notice: string; next: string }
  assert.equal(uploaded.notice, 'Document stored.')
  assert.equal(uploaded.next, `/m/documents?documentId=${uploaded.documentId}`)
  const requested = await route('POST', '/request', admin, json('/request', { documentId: uploaded.documentId, reason: 'Send the offer for acceptance', approvedInternalUse: true })) as { requestId: string }
  const raw = await route('GET', '/file', signer, new Request(url('/file', `?id=${uploaded.documentId}`))) as Response
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes)
  const { issueAssentChallenge } = await import('./api/index')
  const { code } = await issueAssentChallenge(signer, { requestId: requested.requestId })
  const signed = await route('POST', '/sign', signer, json('/sign', { requestId: requested.requestId, code, consent: true })) as { notice: string }
  assert.equal(signed.notice, 'Assent recorded.')
  const verified = await route('POST', '/verify', signer, json('/verify', { documentId: uploaded.documentId, sha256 })) as Record<string, unknown>
  assert.deepEqual(verified, { integrity: 'verified', copyMatches: true, notice: 'Verified' })
  const other = await route('POST', '/verify', signer, json('/verify', { documentId: uploaded.documentId, sha256: '0'.repeat(64) })) as Record<string, unknown>
  assert.equal(other.notice, 'Copy does not match')
  const receipt = await route('GET', '/receipt.pdf', signer, new Request(url('/receipt.pdf', `?id=${uploaded.documentId}`))) as Response
  assert.equal(receipt.headers.get('content-type'), 'application/pdf')
  const listed = await route('GET', '/files', signer, new Request(url('/files'))) as { rows: { id: string; integrity: string }[]; total: number }
  assert.deepEqual(listed.rows.map(row => [row.id, row.integrity]), [[uploaded.documentId, 'verified']])
  await assert.rejects(() => route('GET', '/file', faculty, new Request(url('/file', `?id=${uploaded.documentId}`))), status('document_missing', 404))
  const declined = await route('POST', '/close', admin, json('/close', { requestId: requested.requestId, decision: 'cancel', reason: 'Too late to cancel now' })).catch(error => error)
  assert.equal((declined as { code?: string }).code, 'document_closed')
})

test('pages: each reader sees only the actions that are theirs', async () => {
  const api = await workflow()
  const campus = await college()
  const { admin, signer, faculty } = campus
  const exported = await plugin()
  const page = exported.pages![0]!
  const view = async (actor: PluginActor, documentId?: string) => {
    const data = await page.load(actor, new Request(`http://localhost/m/documents${documentId ? `?documentId=${documentId}` : ''}`))
    return { data, ...sectionsOf(exported.pages, data) }
  }
  assert.ok((await view(admin)).all.includes('Upload document'))
  assert.ok(!(await view(signer)).all.includes('Upload document'))
  const office = await api.uploadDocument(admin, { title: 'Circular', kind: 'record', scope: 'office', subjectUserId: faculty.id, file: (await pdf()).file })
  const unavailable = await view(faculty, office.documentId)
  assert.ok(unavailable.sections.some(section => section.kind === 'note' && section.text === 'Document unavailable.'))
  assert.ok(!unavailable.all.includes('Download document'))
  const sent = await offer(api, campus)
  const forAdmin = await view(admin, sent.documentId)
  for (const expected of ['Download document', 'Verify integrity', 'Cancel request']) assert.ok(forAdmin.all.includes(expected), expected)
  assert.ok(!forAdmin.all.includes('Record assent') && !forAdmin.all.includes('Request assent'))
  const forSigner = await view(signer, sent.documentId)
  for (const expected of ['Download document', 'Verify integrity', 'Email me a confirmation code', 'Record assent', 'Decline']) assert.ok(forSigner.all.includes(expected), expected)
  assert.ok(!forSigner.all.includes('Cancel request') && !forSigner.all.includes('Download assent record'))
  const challenge = forSigner.sections.find(section => section.kind === 'form' && section.title === 'Email me a confirmation code')
  assert.equal(challenge?.kind === 'form' && challenge.path, '/assent-challenge')
  assert.deepEqual(challenge?.kind === 'form' && challenge.fields.map(entry => entry.name), ['requestId', 'documentId'])
  const fresh = await api.uploadDocument(admin, { title: 'Contract', kind: 'contract', scope: 'signer', subjectUserId: signer.id, file: (await pdf()).file,
    retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'legal_obligation', authorityRef: 'Contracts register' })
  assert.ok((await view(admin, fresh.documentId)).all.includes('Request assent'))
  await api.downloadDocument(signer, sent.documentId)
  const { code } = await api.issueAssentChallenge(signer, { requestId: sent.requestId })
  await api.recordAssent(signer, { requestId: sent.requestId, code, consent: true })
  const done = await view(signer, sent.documentId)
  assert.ok(done.all.includes('Download assent record'))
  assert.ok(!done.all.includes('Record assent') && !done.all.includes('Decline'))
  await tamper(sql`update documents_files set body = ${Buffer.from('%PDF-1.4 swapped')} where id = ${sent.documentId}`)
  const broken = await view(admin, sent.documentId)
  assert.ok(!broken.all.includes('Download document') && !broken.all.includes('Download assent record'))
  assert.ok(broken.sections.some(section => section.kind === 'note' && section.tone === 'danger'))
  const list = (broken.data.files as { id: string; check: string }[]).find(row => row.id === sent.documentId)
  assert.equal(list?.check, 'Integrity check failed')
})

// Review fixes (P2-19 FIX).
test('fix: a malformed id is the same 404 as a missing document, never a database error', async () => {
  const api = await workflow()
  const { admin } = await college()
  for (const bad of ['-'.repeat(36), 'z'.repeat(36), randomUUID().replace(/.$/, 'g')]) {
    await assert.rejects(() => readable(admin, bad), status('document_missing', 404))
    await assert.rejects(() => api.downloadDocument(admin, bad), status('document_missing', 404))
    await assert.rejects(() => api.signingReceipt(admin, bad), status('document_missing', 404))
  }
})

test('fix: a retention date Postgres would refuse is a 400, not a 500', async () => {
  const api = await workflow()
  const { admin, signer } = await college()
  const { file } = await pdf()
  const input = { title: 'Offer', kind: 'offer', scope: 'signer', subjectUserId: signer.id, file, retentionBasis: 'specified_purpose', authorityRef: 'Offer records policy' }
  for (const retainUntil of ['1', '12', '2030', '2026-02-30', 'next year']) {
    await assert.rejects(() => api.uploadDocument(admin, { ...input, retainUntil }), /valid retention end date/, retainUntil)
  }
})

test('fix: the sealed audit row binds the mailbox that confirmed the code', async () => {
  const api = await workflow()
  const campus = await college()
  const { authDb } = await import('@campusos/db')
  const sent = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(campus.signer, { requestId: sent.requestId })
  const { signatureId } = await api.recordAssent(campus.signer, { requestId: sent.requestId, code, consent: true })
  const [row] = (await authDb.execute(sql`select detail->>'recipientDigest' as digest from audit_log where id = ${signatureId}`)).rows as { digest: string }[]
  assert.equal(row!.digest, createHash('sha256').update(campus.signer.email!.trim().toLowerCase(), 'utf8').digest('hex'))
})

test('fix: a member demoted to pending cannot ask for a code, sign or decline', async () => {
  const api = await workflow()
  const campus = await college()
  const { authDb } = await import('@campusos/db')
  const sent = await ready(api, campus)
  const { code } = await api.issueAssentChallenge(campus.signer, { requestId: sent.requestId })
  await authDb.execute(sql`update users set role = 'pending' where id = ${campus.signer.id}`)
  await assert.rejects(() => api.recordAssent(campus.signer, { requestId: sent.requestId, code, consent: true }), status('document_missing', 404))
  await assert.rejects(() => api.issueAssentChallenge(campus.signer, { requestId: sent.requestId }), status('document_missing', 404))
  await assert.rejects(() => api.closeAssent(campus.signer, { requestId: sent.requestId, decision: 'decline', reason: 'Declining while pending' }), status('document_missing', 404))
})

test('fix: an administrator cannot request assent from themselves', async () => {
  const api = await workflow()
  const { admin } = await college()
  const { file } = await pdf()
  const own = await api.uploadDocument(admin, { title: 'Own offer', kind: 'offer', scope: 'signer', subjectUserId: admin.id, file,
    retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(), retentionBasis: 'specified_purpose', authorityRef: 'Offer records policy' })
  await assert.rejects(() => api.requestAssent(admin, { documentId: own.documentId, reason: 'Sign my own offer please', approvedInternalUse: true }), status('self_signing', 400))
})
