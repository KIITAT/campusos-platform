import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addApplicantSchema,
  closeOpeningSchema,
  decideRequisitionSchema,
  giveFeedbackSchema,
  hireSchema,
  makeOfferSchema,
  moveApplicantSchema,
  openPositionSchema,
  raiseRequisitionSchema,
  respondToOfferSchema,
  scheduleInterviewSchema,
  withdrawOfferSchema,
} from './schemas'

const base = `${manifest.apiBasePath}/recruitment`
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
  '409': { description: 'Refused at this step', content: json(err) },
}
const post = (summary: string, schema: z.ZodType, description?: string) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['hr'],
    requestBody: { content: json(schema) },
    responses: ok,
  },
})
const get = (summary: string, query?: string) => ({
  get: {
    summary,
    tags: ['hr'],
    ...(query
      ? { parameters: [{ name: query, in: 'query', required: true, schema: { type: 'string' } }] }
      : {}),
    responses: ok,
  },
})

export const recruitmentPaths = {
  [`${base}/requisitions`]: {
    ...get('Requisitions, with how many have been hired against each'),
    ...post(
      'Ask for a post',
      raiseRequisitionSchema,
      'The HR desk or a head of department. Nothing is advertised until an administrator ' +
        'other than whoever raised it approves.',
    ),
  },
  [`${base}/requisitions/decide`]: post('Approve or reject a requisition', decideRequisitionSchema),
  [`${base}/openings`]: {
    ...get('Openings, each with its pipeline counts'),
    ...post('Advertise an approved requisition', openPositionSchema, 'One live advert per requisition.'),
  },
  [`${base}/openings/close`]: post('Close an opening', closeOpeningSchema),
  [`${base}/applicants`]: {
    ...get('Applicants for an opening', 'openingId'),
    ...post('Record an application', addApplicantSchema, 'One per address per opening, whatever its case.'),
  },
  [`${base}/applicants/move`]: post(
    'Shortlist, reject or withdraw an applicant',
    moveApplicantSchema,
    'Interviewing, offered and hired are reached only by scheduling, offering and hiring.',
  ),
  [`${base}/applicants/file`]: get(
    'One applicant: every round, every signed piece of feedback, every offer',
    'applicantId',
  ),
  [`${base}/interviews`]: post(
    'Schedule the next round',
    scheduleInterviewSchema,
    'The panel must be people at this institution; only they may give feedback on it.',
  ),
  [`${base}/interviews/feedback`]: post(
    'Give feedback on a round you sat on',
    giveFeedbackSchema,
    'Once per panel member, never edited. The round completes when the whole panel has spoken.',
  ),
  [`${base}/interviews/mine`]: get('Rounds you sit on, and whether you still owe feedback'),
  [`${base}/offers`]: post(
    'Make an offer',
    makeOfferSchema,
    'Only to somebody a panel has given feedback on. Terms default from the requisition.',
  ),
  [`${base}/offers/respond`]: post('Record the candidate’s answer', respondToOfferSchema),
  [`${base}/offers/withdraw`]: post('Withdraw an offer, with an audited reason', withdrawOfferSchema),
  [`${base}/hire`]: post(
    'Turn an accepted offer into a staff record',
    hireSchema,
    'In one transaction: the record, the link back to the offer, the requisition filled when ' +
      'every position is, and optionally the onboarding started. Pay is set separately.',
  ),
}
