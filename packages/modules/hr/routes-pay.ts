import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  assignStructure,
  createGratuityRule,
  createStructure,
  createTaxRegime,
  electRegime,
  setPreviousEmployment,
  setTaxDeclarations,
  getPayrollSettings,
  getStatutoryIdentity,
  gratuityQuote,
  liftWithholding,
  listGratuityRules,
  listGratuityValuations,
  listPtSlabs,
  listRuns,
  listStructures,
  listTaxRegimes,
  listWithheld,
  payGratuity,
  releasePayslip,
  listDues,
  listRemittances,
  payslipDocument,
  reissuePayslip,
  remit,
  taxStatementDocument,
  tdsQuarterFile,
  voidRemittance,
  statutoryFile,
  valueGratuity,
  type FileKind,
  setPayrollSettings,
  setPtSlabs,
  setStatutoryIdentity,
  withholdSalary,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

/** A file built from stored payslips, offered as a download. */
const fileRoute = (path: string, kind: FileKind): PluginRoute => ({
  method: 'GET',
  path,
  raw: true,
  handler: async (a, req) => {
    const f = await statutoryFile(a as Actor, kind, requiredParam(req, 'period'))
    return new Response(f.content, {
      headers: { 'content-type': f.type, 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' },
    })
  },
})

/** What feeds a payslip: structures, tax, gratuity, withholding, runs, the part-month basis. */
export const payRoutes: PluginRoute[] = [
  { method: 'GET', path: '/pay/structures', handler: (a) => listStructures(a as Actor) },
  post('/pay/structures', createStructure),
  post('/pay/structures/assign', assignStructure),
  { method: 'GET', path: '/pay/tax', handler: (a) => listTaxRegimes(a as Actor) },
  post('/pay/tax', createTaxRegime),
  post('/pay/tax/elect', electRegime),
  post('/payroll/tax/declarations', setTaxDeclarations),
  post('/payroll/tax/previous', setPreviousEmployment),
  { method: 'GET', path: '/pay/gratuity', handler: (a) => listGratuityRules(a as Actor) },
  post('/pay/gratuity', createGratuityRule),
  {
    method: 'GET',
    path: '/pay/gratuity/quote',
    handler: (a, req) =>
      gratuityQuote(a as Actor, requiredParam(req, 'staffId'), requiredParam(req, 'ruleId')),
  },
  post('/pay/gratuity/pay', payGratuity),
  { method: 'GET', path: '/pay/gratuity/valuations', handler: (a) => listGratuityValuations(a as Actor) },
  post('/pay/gratuity/valuations', valueGratuity),
  { method: 'GET', path: '/pay/withheld', handler: (a) => listWithheld(a as Actor) },
  post('/pay/withhold', withholdSalary),
  post('/pay/withhold/lift', liftWithholding),
  post('/pay/withheld/release', releasePayslip),
  {
    method: 'GET',
    path: '/payroll/payslip.pdf',
    raw: true,
    handler: async (a, req) => {
      const d = await payslipDocument(a as Actor, requiredParam(req, 'payslipId'))
      return new Response(d.bytes as unknown as BodyInit, {
        headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${d.name}"`, 'cache-control': 'no-store' },
      })
    },
  },
  { method: 'GET', path: '/payroll/dues', handler: (a, req) => listDues(a as Actor, requiredParam(req, 'period')) },
  { method: 'GET', path: '/payroll/remittances', handler: (a, req) => listRemittances(a as Actor, param(req, 'period') ?? undefined) },
  post('/payroll/remittances', remit),
  post('/payroll/reissue', reissuePayslip),
  post('/payroll/remittances/void', voidRemittance),
  {
    method: 'GET',
    path: '/payroll/tax-statement.pdf',
    raw: true,
    handler: async (a, req) => {
      const d = await taxStatementDocument(a as Actor, requiredParam(req, 'staffId'), Number(requiredParam(req, 'taxYear')))
      return new Response(d.bytes as unknown as BodyInit, {
        headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${d.name}"`, 'cache-control': 'no-store' },
      })
    },
  },
  {
    method: 'GET',
    path: '/payroll/tds-quarter',
    raw: true,
    handler: async (a, req) => {
      const f = await tdsQuarterFile(a as Actor, Number(requiredParam(req, 'taxYear')), Number(requiredParam(req, 'quarter')))
      return new Response(f.content, {
        headers: { 'content-type': f.type, 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' },
      })
    },
  },
  fileRoute('/payroll/ecr', 'ecr'),
  fileRoute('/payroll/esi', 'esi'),
  fileRoute('/payroll/bank-advice', 'bank-advice'),
  { method: 'GET', path: '/payroll/runs', handler: (a) => listRuns(a as Actor) },
  { method: 'GET', path: '/payroll/settings', handler: (a) => getPayrollSettings(a as Actor) },
  post('/payroll/settings', setPayrollSettings),
  { method: 'GET', path: '/staff/statutory', handler: (a, req) => getStatutoryIdentity(a as Actor, requiredParam(req, 'staffId')) },
  post('/staff/statutory', setStatutoryIdentity),
  { method: 'GET', path: '/payroll/pt-slabs', handler: (a) => listPtSlabs(a as Actor) },
  post('/payroll/pt-slabs', setPtSlabs),
]
