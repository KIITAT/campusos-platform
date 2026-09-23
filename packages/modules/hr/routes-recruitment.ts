import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addApplicant,
  applicantFile,
  closeOpening,
  decideRequisition,
  giveFeedback,
  hire,
  listApplicants,
  listOpenings,
  listRequisitions,
  makeOffer,
  moveApplicant,
  myInterviews,
  openPosition,
  raiseRequisition,
  respondToOffer,
  scheduleInterview,
  withdrawOffer,
  type Actor,
} from './api'

const post = (
  path: string,
  fn: (a: Actor, body: unknown) => Promise<unknown>,
): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

/** Recruitment: requisition, opening, applicant, interview, offer, hire. */
export const recruitmentRoutes: PluginRoute[] = [
  { method: 'GET', path: '/recruitment/requisitions', handler: (a) => listRequisitions(a as Actor) },
  post('/recruitment/requisitions', raiseRequisition),
  post('/recruitment/requisitions/decide', decideRequisition),
  { method: 'GET', path: '/recruitment/openings', handler: (a) => listOpenings(a as Actor) },
  post('/recruitment/openings', openPosition),
  post('/recruitment/openings/close', closeOpening),
  {
    method: 'GET',
    path: '/recruitment/applicants',
    handler: (a, req) => listApplicants(a as Actor, requiredParam(req, 'openingId')),
  },
  post('/recruitment/applicants', addApplicant),
  post('/recruitment/applicants/move', moveApplicant),
  {
    method: 'GET',
    path: '/recruitment/applicants/file',
    handler: (a, req) => applicantFile(a as Actor, requiredParam(req, 'applicantId')),
  },
  post('/recruitment/interviews', scheduleInterview),
  post('/recruitment/interviews/feedback', giveFeedback),
  { method: 'GET', path: '/recruitment/interviews/mine', handler: (a) => myInterviews(a as Actor) },
  post('/recruitment/offers', makeOffer),
  post('/recruitment/offers/respond', respondToOffer),
  post('/recruitment/offers/withdraw', withdrawOffer),
  post('/recruitment/hire', hire),
]
