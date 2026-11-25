import * as z from 'zod'
import { jsonBody, param, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'

export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType; query?: { name: string; format?: string }[]; binary?: boolean }
const id = (request: Request, name = 'id') => param(request, name) ?? ''
const here = (documentId: string) => `/m/documents?documentId=${encodeURIComponent(documentId)}`
const notices = { verified: 'Verified', mismatch: 'Integrity check failed', unsigned: 'Verified' } as const

export const specs: RouteSpec[] = [
  { method: 'GET', path: '/files', summary: 'List documents the caller may open', query: [{ name: 'studentId' }], handler: (actor, request) => api.listDocuments(actor, api.readDocumentPage(request), param(request, 'studentId')) },
  { method: 'GET', path: '/file', summary: 'Download the exact stored file', query: [{ name: 'id', format: 'uuid' }], raw: true, binary: true, handler: async (actor, request) => api.downloadDocument(actor, id(request)) },
  { method: 'GET', path: '/receipt.pdf', summary: 'Download the assent record as a separate PDF', query: [{ name: 'id', format: 'uuid' }], raw: true, binary: true, handler: async (actor, request) => api.signingReceipt(actor, id(request)) },
  { method: 'POST', path: '/verify', summary: 'Verify a stored file, its evidence and optionally a copy by digest', body: api.verifySchema, handler: async (actor, request) => {
    const result = await api.verifyDocument(actor, await jsonBody(request))
    return { ...result, notice: result.integrity === 'mismatch' ? notices.mismatch : result.copyMatches === false ? 'Copy does not match' : notices.verified }
  } },
  { method: 'POST', path: '/upload', summary: 'File a document', body: api.uploadSchema, handler: async (actor, request) => {
    const result = await api.uploadDocument(actor, await jsonBody(request))
    return { ...result, next: here(result.documentId) }
  } },
  { method: 'POST', path: '/request', summary: 'Ask the named member to record assent', body: api.requestSchema, handler: async (actor, request) => api.requestAssent(actor, await jsonBody(request)) },
  { method: 'POST', path: '/sign', summary: 'Record assent with the mailbox code', body: api.assentSchema, handler: async (actor, request) => api.recordAssent(actor, await jsonBody(request)) },
  { method: 'POST', path: '/close', summary: 'Decline (the signer) or cancel (an administrator) a request', body: api.closeSchema, handler: async (actor, request) => api.closeAssent(actor, await jsonBody(request)) },
]
export const routes: PluginRoute[] = specs
