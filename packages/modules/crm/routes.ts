import * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'

export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
const post = (path: string, summary: string, body: z.ZodType, run: (actor: api.Actor, input: unknown) => Promise<unknown>): RouteSpec =>
  ({ method: 'POST', path, summary, body, handler: async (actor, request) => run(actor, await jsonBody(request)) })
const query = (request: Request, name: string) => new URL(request.url).searchParams.get(name) ?? undefined
const one = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined => allowed.find(a => a === value)

export const specs: RouteSpec[] = [
  { method: 'GET', path: '/settings', summary: 'Stages, lost reasons and teams', handler: actor => api.settings(actor) },
  { method: 'GET', path: '/pipeline', summary: 'The pipeline, one page at a time', handler: (actor, request) =>
    api.listLeads(actor, api.pipelinePage(request, ''), { kind: one(query(request, 'kind'), ['lead', 'opportunity']), status: one(query(request, 'status'), ['open', 'won', 'lost']) }) },
  { method: 'GET', path: '/leads/detail', summary: 'Read a lead with its activities', handler: (actor, request) => api.leadDetail(actor, query(request, 'id') ?? '') },
  post('/stages', 'Add a pipeline stage', api.stageSchema, api.createStage),
  post('/stages/update', 'Rename, reorder or archive a stage', api.stageUpdateSchema, api.updateStage),
  post('/lost-reasons', 'Add a lost reason', api.reasonSchema, api.createLostReason),
  post('/lost-reasons/archive', 'Archive a lost reason', api.reasonArchiveSchema, api.archiveLostReason),
  post('/teams', 'Create a sales team', api.teamSchema, api.createTeam),
  post('/teams/members', 'Add a team member', api.memberSchema, api.addTeamMember),
  post('/teams/members/remove', 'Remove a team member', api.memberSchema, api.removeTeamMember),
  post('/leads', 'Record a lead or an opportunity', api.leadSchema, api.createLead),
  post('/leads/update', 'Change an open lead', api.updateSchema, api.updateLead),
  post('/leads/qualify', 'Qualify a lead as an opportunity', api.leadIdSchema, api.qualifyLead),
  post('/leads/stage', 'Move an opportunity to a stage', api.stageMoveSchema, api.moveStage),
  post('/leads/assign', 'Give a lead to another owner', api.assignSchema, api.assignLead),
  post('/leads/won', 'Mark an opportunity won', api.leadIdSchema, api.markWon),
  post('/leads/lost', 'Mark a lead lost, with a reason', api.lostSchema, api.markLost),
  post('/leads/reopen', 'Reopen a lost or unconverted won opportunity', api.leadIdSchema, api.reopenLead),
]
export const routes: PluginRoute[] = specs
