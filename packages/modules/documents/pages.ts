import type { PluginPage, PluginSection } from '@campusos/module-framework'
import { ADMIN, MEMBERS, documentDetail, listDocuments, readDocumentPage, type DocumentSummary } from './api'
import { choice, field, form, hidden, screen, table } from './ui'

const API = '/api/v1/modules/documents'
const INTEGRITY = { verified: 'Verified', mismatch: 'Integrity check failed', unsigned: 'Not signed' } as const
const label = (value: string | null) => (value ?? 'not requested').replaceAll('_', ' ')

function detail(row: DocumentSummary, actorId: string, office: boolean): PluginSection[] {
  const figures: PluginSection = { kind: 'figures', title: row.title, figures: [
    { label: 'Integrity', value: INTEGRITY[row.integrity], tone: row.integrity === 'mismatch' ? 'due' : 'clear' },
    { label: 'Kind', value: label(row.kind) }, { label: 'Signing request', value: label(row.status) },
    { label: 'Retained until', value: row.retainUntil?.slice(0, 10) ?? 'Not set' },
  ] }
  if (row.integrity === 'mismatch') {
    return [figures, { kind: 'note', tone: 'danger', text: 'Integrity check failed. The file and its evidence are withheld, and the failure has been recorded.' }]
  }
  const signer = row.subjectUserId === actorId
  const pending = row.status === 'pending' && row.requestId !== null
  const out: PluginSection[] = [figures, { kind: 'shortcuts', items: [
    { label: 'Download document', href: `${API}/file?id=${row.id}`, description: 'The exact stored file' },
    ...(row.status === 'signed' ? [{ label: 'Download assent record', href: `${API}/receipt.pdf?id=${row.id}`, description: 'A separate evidence PDF' }] : []),
  ] }]
  out.push(form('Verify integrity', '/verify', [hidden('documentId', row.id), field('sha256', 'SHA-256 of your copy', 'text', true, '64 lowercase hex characters; leave empty to check the stored file only')], MEMBERS))
  if (office && row.scope === 'signer' && row.requestId === null) {
    out.push(form('Request assent', '/request', [hidden('documentId', row.id), field('reason', 'Reason for sending this document', 'textarea'),
      field('approvedInternalUse', 'This document is approved for internal electronic assent', 'checkbox')], ADMIN))
  }
  if (pending && signer) {
    out.push({ kind: 'note', text: 'Download the document first, ask for a confirmation code, then enter the code from your mailbox to record your assent. This records electronic assent; it is not a certified digital signature.' })
    out.push(form('Email me a confirmation code', '/assent-challenge', [hidden('requestId', row.requestId!), hidden('documentId', row.id)], MEMBERS))
    out.push(form('Record assent', '/sign', [hidden('requestId', row.requestId!), field('code', 'Confirmation code'), field('consent', 'I agree to this document and want to record my assent.', 'checkbox')], MEMBERS))
    out.push(form('Decline', '/close', [hidden('requestId', row.requestId!), hidden('decision', 'decline'), field('reason', 'Why are you declining?', 'textarea')], MEMBERS))
  }
  if (pending && office) {
    out.push(form('Cancel request', '/close', [hidden('requestId', row.requestId!), hidden('decision', 'cancel'), field('reason', 'Why is this request being cancelled?', 'textarea')], ADMIN))
  }
  return out
}

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Documents', menu: 'Documents', roles: [...MEMBERS],
    load: async (actor, request) => {
      const params = new URL(request.url).searchParams
      const documentId = params.get('documentId')
      const page = await listDocuments(actor, readDocumentPage(request, 'files'), params.get('studentId') ?? undefined).catch(() => ({ rows: [] as DocumentSummary[], total: 0, next: null }))
      const selected = documentId ? await documentDetail(actor, documentId).catch(() => null) : null
      return {
        files: page.rows.map(row => ({ ...row, state: label(row.status), check: INTEGRITY[row.integrity] })),
        filesPage: { total: page.total, next: page.next },
        selected, asked: documentId !== null, actorId: actor.id, office: ADMIN.includes(actor.role),
      }
    },
    sections: data => [
      { kind: 'note', text: 'Files are stored unchanged and checked on every read. Electronic assent here is internal evidence; documents that need a recognised or statutory signature go through the institution\'s approved process.' },
      ...(data.selected ? detail(data.selected as DocumentSummary, data.actorId as string, data.office as boolean)
        : data.asked ? [{ kind: 'note' as const, tone: 'warn' as const, text: 'Document unavailable.' }] : []),
      table('Documents', 'files', [
        { key: 'title', label: 'Title', href: '/m/documents?documentId={id}' }, { key: 'kind', label: 'Kind' }, { key: 'state', label: 'Signing request', kind: 'status' },
        { key: 'check', label: 'Integrity', kind: 'status' }, { key: 'createdAt', label: 'Filed', kind: 'when' },
      ], { data: 'filesPage', sorts: [] }),
      ...(data.office ? [form('Upload document', '/upload', [
        field('title', 'Title'), { name: 'kind', label: 'Kind', kind: 'select' as const, options: choice(['record', 'offer', 'contract', 'agreement']) },
        { name: 'scope', label: 'Who may open it', kind: 'select' as const, options: choice(['office', 'student_academic', 'signer']) },
        field('subjectUserId', 'Person (user ID)', 'text', false, 'The member the file is about or for; for a signable document, the signer'),
        { name: 'file', label: 'File', kind: 'file' as const, accept: 'application/pdf,image/png,image/jpeg', hint: 'PDF only for offers, contracts and agreements. At most 5 MB.' },
        field('retainUntil', 'Keep until (signable documents)', 'date', true), { name: 'retentionBasis', label: 'Basis for keeping it', kind: 'select' as const, optional: true, options: choice(['specified_purpose', 'legal_obligation']) },
        field('authorityRef', 'Policy or legal reference', 'text', true),
      ], ADMIN)] : []),
    ],
  }),
]
