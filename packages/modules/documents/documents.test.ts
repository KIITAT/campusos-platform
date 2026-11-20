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
