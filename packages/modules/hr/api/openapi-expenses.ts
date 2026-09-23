import * as z from 'zod'
import { manifest } from '../manifest'
import {
  decideAdvanceSchema,
  decideClaimSchema,
  payAdvanceSchema,
  repayAdvanceSchema,
  requestAdvanceSchema,
  settleClaimSchema,
  submitClaimSchema,
} from './schemas'

const base = manifest.apiBasePath
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
    ...(query ? { parameters: [{ name: query, in: 'query', required: true, schema: { type: 'string' } }] } : {}),
    responses: ok,
  },
})

export const expensesPaths = {
  [`${base}/claims`]: {
    ...get('Expense claims; staff see only their own'),
    ...post('Submit a claim', submitClaimSchema, 'Nothing claimed before it is spent. Lines are fixed once in.'),
  },
  [`${base}/claims/lines`]: get('The lines of a claim, claimed and sanctioned', 'claimId'),
  [`${base}/claims/decide`]: post(
    'Approve or reject a claim',
    decideClaimSchema,
    'Sanction per line, never beyond the claim. Approval posts the expense against the ' +
      "claimant's department and the amount owed to them. Nobody approves their own.",
  ),
  [`${base}/claims/settle`]: post(
    'Settle an approved claim',
    settleClaimSchema,
    'First against a named open advance, up to what is outstanding, then in money for the rest.',
  ),
  [`${base}/advances`]: {
    ...get('Advances with what has been recovered and what is outstanding'),
    ...post('Ask for an advance', requestAdvanceSchema),
  },
  [`${base}/advances/decide`]: post(
    'Approve or reject an advance',
    decideAdvanceSchema,
    'With a monthly recovery, payroll deducts it until the advance is back, never below zero pay.',
  ),
  [`${base}/advances/pay`]: post(
    'Hand an approved advance over',
    payAdvanceSchema,
    'Posts to advances to staff: an asset until it is accounted for.',
  ),
  [`${base}/advances/repay`]: post('Record an advance repaid in money', repayAdvanceSchema),
}
