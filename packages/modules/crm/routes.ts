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
  { method: 'GET', path: '/forecast', summary: 'Open pipeline by stage and by expected-close month, total and probability-weighted', handler: actor => api.forecast(actor) },
  { method: 'GET', path: '/report', summary: 'Team performance: open, won, lost, win rate and why deals were lost', handler: (actor, request) => api.report(actor, { from: query(request, 'from'), to: query(request, 'to') }) },
  { method: 'GET', path: '/leads/duplicates', summary: 'Open leads that share a lead\'s e-mail, phone or company', handler: (actor, request) => api.duplicates(actor, query(request, 'id') ?? '') },
  post('/stages', 'Add a pipeline stage', api.stageSchema, api.createStage),
  post('/stages/update', 'Rename, reorder or archive a stage', api.stageUpdateSchema, api.updateStage),
  post('/lost-reasons', 'Add a lost reason', api.reasonSchema, api.createLostReason),
  post('/lost-reasons/archive', 'Archive a lost reason', api.reasonArchiveSchema, api.archiveLostReason),
  post('/teams', 'Create a sales team', api.teamSchema, api.createTeam),
  post('/teams/members', 'Add a team member', api.memberSchema, api.addTeamMember),
  post('/teams/members/remove', 'Remove a team member', api.memberSchema, api.removeTeamMember),
  post('/notes', 'Add a note to a lead\'s history', api.noteSchema, api.addNote),
  post('/scripts', 'Plan the next activity after one kind finishes', api.scriptSchema, api.setScript),
  post('/scripts/delete', 'Remove a next-activity script', api.scriptDeleteSchema, api.deleteScript),
  post('/teams/auto-assign', 'Switch a team\'s round-robin assignment on or off', api.autoAssignSchema, api.setAutoAssign),
  post('/leads/capture', 'Record a lead from outside and give it to the next salesperson', api.captureSchema, api.captureLead),
  post('/leads/import', 'Import up to 500 leads', api.importSchema, api.importLeads),
  post('/leads/merge', 'Merge a duplicate lead into another', api.mergeSchema, api.mergeLeads),
  post('/leads', 'Record a lead or an opportunity', api.leadSchema, api.createLead),
  post('/leads/update', 'Change an open lead', api.updateSchema, api.updateLead),
  post('/leads/qualify', 'Qualify a lead as an opportunity', api.leadIdSchema, api.qualifyLead),
  post('/leads/stage', 'Move an opportunity to a stage', api.stageMoveSchema, api.moveStage),
  post('/leads/assign', 'Give a lead to another owner', api.assignSchema, api.assignLead),
  post('/leads/won', 'Mark an opportunity won', api.leadIdSchema, api.markWon),
  post('/leads/lost', 'Mark a lead lost, with a reason', api.lostSchema, api.markLost),
  post('/leads/reopen', 'Reopen a lost or unconverted won opportunity', api.leadIdSchema, api.reopenLead),
  post('/activities', 'Schedule a call, meeting or task', api.activitySchema, api.createActivity),
  post('/activities/done', 'Complete an activity', api.activityDoneSchema, api.completeActivity),
  post('/leads/convert', 'Convert a won opportunity to a customer and a draft quotation', api.convertSchema, api.convertOpportunity),
  post('/leads/erase', 'Erase a contact on request (DPDP)', api.eraseSchema, api.eraseLead),
]
export const routes: PluginRoute[] = specs
