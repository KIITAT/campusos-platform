import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as operations from './api/operations'
import * as schemas from './api/schemas'
import type { Actor } from './api/core'
import type { ZodType } from 'zod'

interface RouteSpec extends PluginRoute { summary: string; body?: ZodType }
const post = (path: string, summary: string, body: ZodType, operation: (actor: Actor, input: unknown) => Promise<unknown>): RouteSpec => ({
  path, method: 'POST', summary, body, handler: async (actor, request) => operation(actor, await jsonBody(request)),
})
export const specs: RouteSpec[] = [
  { method: 'GET', path: '/workspace', summary: 'Placement workspace scoped to the reader', handler: (actor) => operations.workspace(actor) },
  { method: 'GET', path: '/statistics', summary: 'Institution placement statistics for appointed officers', handler: (actor) => operations.statistics(actor) },
  post('/officers', 'Appoint or revoke an institutional placement officer', schemas.officerSchema, operations.setOfficer),
  post('/companies', 'Add an employer', schemas.companySchema, operations.createCompany),
  post('/drives', 'Draft a recruitment drive with academic eligibility', schemas.driveSchema, operations.createDrive),
  post('/drives/state', 'Open or close a drive', schemas.driveStateSchema, operations.changeDrive),
  post('/apply', 'Apply as the signed-in eligible student', schemas.applicationSchema, operations.apply),
  post('/withdraw', 'Withdraw the signed-in student application', schemas.applicationIdSchema, operations.withdraw),
  post('/rounds', 'Add the next selection round', schemas.roundSchema, operations.createRound),
  post('/results', 'Record a selection result without overwriting prior decisions', schemas.resultSchema, operations.recordResult),
  post('/offers', 'Issue an offer after all selection rounds and live eligibility checks', schemas.offerSchema, operations.issueOffer),
  post('/offers/respond', 'Accept or decline the signed-in student offer', schemas.responseSchema, operations.respondOffer),
]
export const routes: PluginRoute[] = specs.map(({ method, path, handler }) => ({ method, path, handler }))
