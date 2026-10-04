import * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'
export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
export const specs: RouteSpec[] = [
  { method: 'GET', path: '/cases', summary: 'List accessible cases', handler: actor => api.listCases(actor) },
  { method: 'GET', path: '/cases/detail', summary: 'Read an accessible case and messages', handler: (actor, request) => api.caseDetail(actor, new URL(request.url).searchParams.get('id') ?? '') },
  { method: 'POST', path: '/cases', summary: 'Submit case', body: api.caseSchema, handler: async (actor, request) => api.createCase(actor, await jsonBody(request)) },
  { method: 'POST', path: '/cases/assign', summary: 'Assign officer', body: api.assignmentSchema, handler: async (actor, request) => api.assignCase(actor, await jsonBody(request)) },
  { method: 'POST', path: '/cases/messages', summary: 'Discuss case', body: api.messageSchema, handler: async (actor, request) => api.postMessage(actor, await jsonBody(request)) },
  { method: 'POST', path: '/cases/resolve', summary: 'Resolve case', body: api.resolutionSchema, handler: async (actor, request) => api.resolveCase(actor, await jsonBody(request)) },
  { method: 'POST', path: '/cases/reopen', summary: 'Reopen case', body: api.reopenSchema, handler: async (actor, request) => api.reopenCase(actor, await jsonBody(request)) },
]
export const routes: PluginRoute[] = specs
