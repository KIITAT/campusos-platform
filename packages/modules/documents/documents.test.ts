import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import type { PluginActor, Role } from '@campusos/module-framework'

interface Workflow {
  uploadDocument(actor: PluginActor, input: unknown): Promise<{ documentId: string }>
  requestAssent(actor: PluginActor, input: unknown): Promise<{ requestId: string }>
  issueAssentChallenge(actor: PluginActor, input: unknown): Promise<{ code: string }>
  recordAssent(actor: PluginActor, input: unknown): Promise<{ signatureId: string }>
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
  const detail = { requestId, signerId: campus.signer.id, signedAt: row!.at, method: 'account_mailbox_v1', intentVersion: 'documents-assent-v1', sha256: file.sha256 }
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
