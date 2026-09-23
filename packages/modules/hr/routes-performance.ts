import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  appraisalView,
  createCycle,
  createKra,
  enrol,
  giveAppraisalFeedback,
  listAppraisals,
  listCycles,
  listGoals,
  listKras,
  myAppraisals,
  setCycleStatus,
  setGoal,
  submitReview,
  submitSelfReview,
  updateGoal,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

/** Performance: cycles, KRAs, appraisals, colleague feedback, goals. */
export const performanceRoutes: PluginRoute[] = [
  { method: 'GET', path: '/performance/cycles', handler: (a) => listCycles(a as Actor) },
  post('/performance/cycles', createCycle),
  post('/performance/cycles/status', setCycleStatus),
  { method: 'GET', path: '/performance/kras', handler: (a) => listKras(a as Actor) },
  post('/performance/kras', createKra),
  post('/performance/enrol', enrol),
  {
    method: 'GET',
    path: '/performance/appraisals',
    handler: (a, req) => listAppraisals(a as Actor, requiredParam(req, 'cycleId')),
  },
  {
    method: 'GET',
    path: '/performance/appraisal',
    handler: (a, req) => appraisalView(a as Actor, requiredParam(req, 'appraisalId')),
  },
  { method: 'GET', path: '/performance/mine', handler: (a) => myAppraisals(a as Actor) },
  post('/performance/self-review', submitSelfReview),
  post('/performance/review', submitReview),
  post('/performance/feedback', giveAppraisalFeedback),
  {
    method: 'GET',
    path: '/performance/goals',
    handler: (a, req) => listGoals(a as Actor, param(req, 'staffId')),
  },
  post('/performance/goals', setGoal),
  post('/performance/goals/update', updateGoal),
]
