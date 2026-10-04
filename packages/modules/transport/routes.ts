import * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'
export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
export const specs: RouteSpec[] = [
  { method: 'GET', path: '/vehicles', summary: 'List vehicles', handler: actor => api.listVehicles(actor) },
  { method: 'GET', path: '/routes', summary: 'List routes', handler: actor => api.listRoutes(actor) },
  { method: 'GET', path: '/stops', summary: 'List stops', handler: actor => api.listStops(actor) },
  { method: 'GET', path: '/assignments', summary: 'List permitted assignments', handler: actor => api.listAssignments(actor) },
  { method: 'POST', path: '/vehicles', summary: 'Register vehicle', body: api.vehicleSchema, handler: async (actor, request) => api.addVehicle(actor, await jsonBody(request)) },
  { method: 'POST', path: '/routes', summary: 'Add route', body: api.routeSchema, handler: async (actor, request) => api.addRoute(actor, await jsonBody(request)) },
  { method: 'POST', path: '/stops', summary: 'Add stop', body: api.stopSchema, handler: async (actor, request) => api.addStop(actor, await jsonBody(request)) },
  { method: 'POST', path: '/assignments', summary: 'Allocate student seat', body: api.assignSchema, handler: async (actor, request) => api.assign(actor, await jsonBody(request)) },
  { method: 'POST', path: '/assignments/release', summary: 'Release student seat', body: api.releaseSchema, handler: async (actor, request) => api.release(actor, await jsonBody(request)) },
]
export const routes: PluginRoute[] = specs
