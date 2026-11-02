import type * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'

/**
 * Every operation of the module, as an HTTP route. Declared once: the routes are this list, and so is the
 * OpenAPI document (api/openapi.ts reads it), so the two cannot drift apart.
 */
export interface RouteSpec extends PluginRoute {
  summary: string
  /** The request body's schema, for the API document. */
  body?: z.ZodType
}

const query = (req: Request) => Object.fromEntries(new URL(req.url).searchParams)
const idParam = (req: Request) => new URL(req.url).searchParams.get('id') ?? ''

const post = (path: string, summary: string, run: (actor: api.Actor, input: unknown) => Promise<unknown>, body?: z.ZodType): RouteSpec => ({
  method: 'POST', path, summary, body, handler: async (actor, request) => run(actor, await jsonBody(request)),
})

export const specs: RouteSpec[] = [
  { method: 'GET', path: '/projects', summary: 'List the projects you can see', handler: (a, req) => api.listProjects(a, query(req), api.projectPage(req, '')) },
  { method: 'GET', path: '/projects/detail', summary: 'Read a project with its members, stages and milestones', handler: (a, req) => api.projectDetail(a, idParam(req)) },
  post('/projects', 'Create a project on a cost centre', api.createProject, api.projectSchema),
  post('/projects/update', "Change a project's details", api.updateProject, api.projectUpdateSchema),
  post('/projects/status', 'Close or reopen a project', api.setProjectStatus, api.statusSchema),
  post('/members', 'Add a member to a project', api.addMember, api.memberSchema),
  post('/members/remove', 'Remove a member from a project', api.removeMember, api.memberSchema),
  post('/stages', 'Add a stage to a project', api.addStage, api.stageSchema),
  post('/milestones', 'Add a milestone', api.addMilestone, api.milestoneSchema),
  post('/milestones/reached', 'Mark a milestone reached', api.reachMilestone, api.reachSchema),
  { method: 'GET', path: '/tasks', summary: "List a project's tasks", handler: (a, req) => api.listTasks(a, query(req), api.taskPage(req, '')) },
  post('/tasks', 'Add a task', api.createTask, api.taskSchema),
  post('/tasks/update', 'Change a task', api.updateTask, api.taskUpdateSchema),
  { method: 'GET', path: '/timesheets', summary: 'List time you can see', handler: (a, req) => api.listTimesheets(a, query(req), api.sheetPage(req, '')) },
  post('/timesheets', 'Log time against a task', api.logTime, api.logSchema),
  post('/timesheets/update', 'Change time not yet approved', api.updateTime, api.editSchema),
  post('/timesheets/delete', 'Delete time not yet approved', api.deleteTime, api.lineSchema),
  post('/timesheets/decide', 'Approve or reject time', api.decideTime, api.decideSchema),
  post('/timesheets/reopen', 'Reopen approved time that is neither billed nor costed', api.reopenTime, api.reopenSchema),
  { method: 'GET', path: '/cost-rates', summary: 'List hourly cost rates', handler: (a, req) => api.listCostRates(a, query(req), api.ratePage(req, '')) },
  post('/cost-rates', "Set a person's hourly cost from a day", api.setCostRate, api.costRateSchema),
  { method: 'GET', path: '/billings', summary: 'List billings', handler: (a, req) => api.listBillings(a, query(req), api.billingPage(req, '')) },
  post('/billings', "Bill a project's approved time, once per idempotency key", api.billProject, api.billingSchema),
  { method: 'GET', path: '/costings', summary: 'List costings', handler: (a, req) => api.listCostings(a, query(req), api.costingPage(req, '')) },
  post('/costings', 'Cost a project\'s approved time for a month, once per idempotency key', api.costProject, api.costingSchema),
  post('/costings/reverse', 'Reverse a costing', api.reverseCosting, api.reverseSchema),
  { method: 'GET', path: '/profitability', summary: 'Project income, expense and margin from the books', handler: (a, req) => api.profitability(a, query(req), api.profitPage(req, '')) },
]
export const routes: PluginRoute[] = specs
