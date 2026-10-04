import * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'
export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
export const specs: RouteSpec[] = [
  { method: 'GET', path: '/profiles', summary: 'List permitted alumni profiles', handler: actor => api.listProfiles(actor) },
  { method: 'GET', path: '/events', summary: 'List events', handler: actor => api.listEvents(actor) },
  { method: 'GET', path: '/registrations', summary: 'List permitted registrations', handler: actor => api.listRegistrations(actor) },
  { method: 'POST', path: '/profiles', summary: 'Maintain graduate profile', body: api.profileSchema, handler: async (actor, request) => api.saveProfile(actor, await jsonBody(request)) },
  { method: 'POST', path: '/profiles/consent', summary: 'Change own publication consent', body: api.consentSchema, handler: async (actor, request) => api.setConsent(actor, await jsonBody(request)) },
  { method: 'POST', path: '/events', summary: 'Draft event', body: api.eventSchema, handler: async (actor, request) => api.createEvent(actor, await jsonBody(request)) },
  { method: 'POST', path: '/events/transition', summary: 'Open, close or cancel event', body: api.transitionSchema, handler: async (actor, request) => api.transitionEvent(actor, await jsonBody(request)) },
  { method: 'POST', path: '/registrations', summary: 'Register for event', body: api.registrationSchema, handler: async (actor, request) => api.register(actor, await jsonBody(request)) },
  { method: 'POST', path: '/registrations/cancel', summary: 'Cancel registration', body: api.cancelSchema, handler: async (actor, request) => api.cancelRegistration(actor, await jsonBody(request)) },
]
export const routes: PluginRoute[] = specs
