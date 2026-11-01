import * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'

export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
export const specs: RouteSpec[] = [
  { method: 'GET', path: '/settings', summary: 'Stages, lost reasons and teams', handler: actor => api.settings(actor) },
  { method: 'POST', path: '/stages', summary: 'Add a pipeline stage', body: api.stageSchema, handler: async (actor, request) => api.createStage(actor, await jsonBody(request)) },
  { method: 'POST', path: '/stages/update', summary: 'Rename, reorder or archive a stage', body: api.stageUpdateSchema, handler: async (actor, request) => api.updateStage(actor, await jsonBody(request)) },
  { method: 'POST', path: '/lost-reasons', summary: 'Add a lost reason', body: api.reasonSchema, handler: async (actor, request) => api.createLostReason(actor, await jsonBody(request)) },
  { method: 'POST', path: '/lost-reasons/archive', summary: 'Archive a lost reason', body: api.reasonArchiveSchema, handler: async (actor, request) => api.archiveLostReason(actor, await jsonBody(request)) },
  { method: 'POST', path: '/teams', summary: 'Create a sales team', body: api.teamSchema, handler: async (actor, request) => api.createTeam(actor, await jsonBody(request)) },
  { method: 'POST', path: '/teams/members', summary: 'Add a team member', body: api.memberSchema, handler: async (actor, request) => api.addTeamMember(actor, await jsonBody(request)) },
  { method: 'POST', path: '/teams/members/remove', summary: 'Remove a team member', body: api.memberSchema, handler: async (actor, request) => api.removeTeamMember(actor, await jsonBody(request)) },
]
export const routes: PluginRoute[] = specs
