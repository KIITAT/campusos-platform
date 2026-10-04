import * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'
export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
export const specs: RouteSpec[] = [
  { method: 'GET', path: '/enquiries', summary: 'List enquiries', handler: actor => api.listEnquiries(actor) },
  { method: 'GET', path: '/applications', summary: 'List applications', handler: actor => api.listApplications(actor) },
  { method: 'POST', path: '/enquiries', summary: 'Record an enquiry', body: api.enquirySchema, handler: async (actor, request) => api.addEnquiry(actor, await jsonBody(request)) },
  { method: 'POST', path: '/applications', summary: 'Submit an application', body: api.applySchema, handler: async (actor, request) => api.apply(actor, await jsonBody(request)) },
  { method: 'POST', path: '/applications/decision', summary: 'Offer, reject or withdraw', body: api.decisionSchema, handler: async (actor, request) => api.decide(actor, await jsonBody(request)) },
  { method: 'POST', path: '/applications/accept', summary: 'Accept and link academic student', body: api.acceptSchema, handler: async (actor, request) => api.acceptApplication(actor, await jsonBody(request)) },
]
export const routes: PluginRoute[] = specs
