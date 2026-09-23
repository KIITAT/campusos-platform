import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  claimLines,
  decideAdvance,
  decideClaim,
  listAdvances,
  listClaims,
  payAdvance,
  repayAdvance,
  requestAdvance,
  settleClaim,
  submitClaim,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

/** Expense claims and advances. */
export const expensesRoutes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/claims',
    handler: (a, req) => listClaims(a as Actor, param(req, 'staffId')),
  },
  post('/claims', submitClaim),
  {
    method: 'GET',
    path: '/claims/lines',
    handler: (a, req) => claimLines(a as Actor, requiredParam(req, 'claimId')),
  },
  post('/claims/decide', decideClaim),
  post('/claims/settle', settleClaim),
  {
    method: 'GET',
    path: '/advances',
    handler: (a, req) => listAdvances(a as Actor, param(req, 'staffId')),
  },
  post('/advances', requestAdvance),
  post('/advances/decide', decideAdvance),
  post('/advances/pay', payAdvance),
  post('/advances/repay', repayAdvance),
]
