import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  assignStructure,
  createGratuityRule,
  createStructure,
  createTaxRegime,
  electRegime,
  gratuityQuote,
  liftWithholding,
  listGratuityRules,
  listRuns,
  listStructures,
  listTaxRegimes,
  listWithheld,
  payGratuity,
  releasePayslip,
  withholdSalary,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

/** What feeds a payslip: structures, tax, gratuity, withholding, runs. */
export const payRoutes: PluginRoute[] = [
  { method: 'GET', path: '/pay/structures', handler: (a) => listStructures(a as Actor) },
  post('/pay/structures', createStructure),
  post('/pay/structures/assign', assignStructure),
  { method: 'GET', path: '/pay/tax', handler: (a) => listTaxRegimes(a as Actor) },
  post('/pay/tax', createTaxRegime),
  post('/pay/tax/elect', electRegime),
  { method: 'GET', path: '/pay/gratuity', handler: (a) => listGratuityRules(a as Actor) },
  post('/pay/gratuity', createGratuityRule),
  {
    method: 'GET',
    path: '/pay/gratuity/quote',
    handler: (a, req) =>
      gratuityQuote(a as Actor, requiredParam(req, 'staffId'), requiredParam(req, 'ruleId')),
  },
  post('/pay/gratuity/pay', payGratuity),
  { method: 'GET', path: '/pay/withheld', handler: (a) => listWithheld(a as Actor) },
  post('/pay/withhold', withholdSalary),
  post('/pay/withhold/lift', liftWithholding),
  post('/pay/withheld/release', releasePayslip),
  { method: 'GET', path: '/payroll/runs', handler: (a) => listRuns(a as Actor) },
]
